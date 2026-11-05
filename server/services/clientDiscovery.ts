import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { automationQueue, emailDispatches, clientDiscoveryRequests as requests, clientDiscoveryMeetings as meetings, contacts, conversations, googleCalendarConnections, incidents, suppressionList, workspaceSettings, workflowEvents } from "../../drizzle/schema";
import { createId, hashContactValue, recordAudit, requireDb } from "../db";
import { isValidTimezone } from "../../shared/dateTime";
import { commonAvailability, normalizeAvailabilityWindows, type Window } from "./availability";
import { createInterviewIcs } from "./calendar";
import { hasClientCommunicationPermission } from "./communicationPermission";
import { withWorkspaceTransaction } from "./database";
import { googleFreeBusyWithBuffers } from "./googleCalendar";
import { recordedOwnerBusy } from "./recordedCalendarBusy";
import { clientReplyCase } from "./replyTriage";
import { appendWorkflowEvent, cancelUnusedEmailDispatch, workflowHash } from "./workflowStore";
const fail=(message:string,code:"CONFLICT"|"PRECONDITION_FAILED"|"BAD_REQUEST"="PRECONDITION_FAILED")=>new TRPCError({code,message});
const tokenHash=(token:string)=>createHash("sha256").update(token).digest("hex");
const safe=(row:typeof requests.$inferSelect)=>{const{tokenHash,requestHash,requestKeyHash,responseHash,sourceFingerprint,...r}=row;return {...r,status:["pending","responded"].includes(r.status)&&new Date(r.expiresAt)<=new Date()?"expired":r.status};};
async function owned(tx:any,ownerId:number,id:string):Promise<typeof requests.$inferSelect>{const r=(await tx.select().from(requests).where(and(eq(requests.ownerId,ownerId),eq(requests.id,id))).limit(1))[0];if(!r)throw new TRPCError({code:"NOT_FOUND",message:"Client discovery request was not found."});return {...r};}
function windows(values:Window[],now=new Date()){
 const normalized=normalizeAvailabilityWindows(values);
 if(normalized.length>20||normalized.some(w=>w.start<now.getTime()+15*60000||w.end>now.getTime()+31*86400000)||normalized.at(-1)!.end-normalized[0].start>31*86400000)throw fail("Choose future availability within 31 days and at least 15 minutes from now.","BAD_REQUEST");
 return normalized.map(w=>({start:new Date(w.start).toISOString(),end:new Date(w.end).toISOString()}));
}
async function currentSource(tx:any,ownerId:number,conversationId:string){
 const d=await clientReplyCase(tx,ownerId,conversationId),c=(await tx.select().from(conversations).where(and(eq(conversations.ownerId,ownerId),eq(conversations.id,conversationId))).limit(1))[0];
 const action=d.action as {action?:string;revision:number}|null;
 if(d.blocked||!d.message||action?.action!=="arrange_discovery"||!c?.contactId||!await hasClientCommunicationPermission(tx,ownerId,c.contactId))throw fail("A current permitted client reply and reviewed discovery next action are required.");
 const contact=(await tx.select().from(contacts).where(and(eq(contacts.ownerId,ownerId),eq(contacts.id,c.contactId))).limit(1))[0];
 if(!contact?.email)throw fail("Client contact email is unavailable.");
 const blocked=(await tx.select().from(suppressionList).where(and(eq(suppressionList.ownerId,ownerId),eq(suppressionList.channel,"email"),eq(suppressionList.valueHash,hashContactValue(contact.email)),eq(suppressionList.active,true))).limit(1))[0];if(blocked)throw fail("Client contact is suppressed.");
 return {fingerprint:workflowHash([conversationId,c.contactId,contact.email.trim().toLowerCase(),d.message.id,d.replyRevision,action.revision,workflowHash(d.message.body)]),contactId:c.contactId,replyRevision:d.replyRevision,actionRevision:action.revision,companyName:d.companyName};
}
async function currentRequest(tx:any,ownerId:number,id:string){
 const r=await owned(tx,ownerId,id);if(!["pending","responded"].includes(r.status)||new Date(r.expiresAt)<=new Date())throw fail("Discovery request is closed or expired.");
 const source=await currentSource(tx,ownerId,r.conversationId);if(source.fingerprint!==r.sourceFingerprint||source.contactId!==r.contactId)throw fail("Client reply, next action or recipient changed. Create a fresh discovery request.","CONFLICT");return r;
}
export async function createDiscoveryRequest(ownerId:number,actorId:number,input:{conversationId:string;replyRevision:number;actionRevision:number;requestKey:string;ownerWindows:Window[];timezone:string;durationMinutes:number;bufferMinutes:number;expiresHours:number;autoSelect:boolean}){
 const normalized=normalizeAvailabilityWindows(input.ownerWindows).map(w=>({start:new Date(w.start).toISOString(),end:new Date(w.end).toISOString()}));
 if(!isValidTimezone(input.timezone))throw fail("Select a valid timezone.","BAD_REQUEST");
 commonAvailability({candidate:input.ownerWindows,interviewer:input.ownerWindows,durationMinutes:input.durationMinutes,bufferMinutes:input.bufferMinutes});
 const requestKeyHash=workflowHash(input.requestKey),requestHash=workflowHash({...input,requestKey:undefined,ownerWindows:normalized});
 return withWorkspaceTransaction(ownerId,async tx=>{
  const prior=(await tx.select().from(requests).where(and(eq(requests.ownerId,ownerId),eq(requests.requestKeyHash,requestKeyHash))).limit(1))[0];
  if(prior){if(prior.requestHash!==requestHash)throw fail("This request key already belongs to different discovery details.","CONFLICT");return {request:safe(prior),token:null,alreadyExists:true};}
  windows(input.ownerWindows);
  const source=await currentSource(tx,ownerId,input.conversationId);if(source.replyRevision!==input.replyRevision||source.actionRevision!==input.actionRevision)throw fail("Client reply or next action changed. Reload before creating discovery.","CONFLICT");
  const active=await tx.select().from(requests).where(and(eq(requests.ownerId,ownerId),eq(requests.conversationId,input.conversationId),inArray(requests.status,["pending","responded","booked"])));
  for(const r of active){
   const meeting=r.status==="booked"?(await tx.select().from(meetings).where(and(eq(meetings.ownerId,ownerId),eq(meetings.requestId,r.id))).limit(1))[0]:null;
   const reserved=meeting&&meeting.status==="tentative"&&new Date(meeting.scheduledAt).getTime()+(meeting.durationMinutes+meeting.bufferMinutes)*60000>Date.now();
   if(reserved||(r.status!=="booked"&&new Date(r.expiresAt)>new Date()))throw fail("This conversation already has an active discovery request. Cancel it before replacing it.","CONFLICT");
  }
  const id=createId("dcr_"),token=randomBytes(32).toString("base64url");
  await tx.insert(requests).values({id,ownerId,conversationId:input.conversationId,contactId:source.contactId,sourceFingerprint:source.fingerprint,requestKeyHash,requestHash,tokenHash:tokenHash(token),status:"pending",revision:1,ownerWindows:normalized,timezone:input.timezone,durationMinutes:input.durationMinutes,bufferMinutes:input.bufferMinutes,autoSelect:input.autoSelect,expiresAt:new Date(Date.now()+input.expiresHours*3600000)});
  await recordAudit({ownerId,actorType:"user",actorId:String(actorId),action:"discovery.request_created",resourceType:"client_discovery",resourceId:id,metadata:{conversationId:input.conversationId,autoSelect:input.autoSelect}},tx);
  return {request:safe(await owned(tx,ownerId,id)),token,alreadyExists:false};
 });
}
export async function getDiscoveryRequest(ownerId:number,id:string){return withWorkspaceTransaction(ownerId,async tx=>safe(await owned(tx,ownerId,id)));}
export async function listDiscoveryRequests(ownerId:number,conversationId:string){
 return withWorkspaceTransaction(ownerId,async tx=>{await clientReplyCase(tx,ownerId,conversationId);const rows=await tx.select().from(requests).where(and(eq(requests.ownerId,ownerId),eq(requests.conversationId,conversationId))).orderBy(desc(requests.createdAt)).limit(50);
  return Promise.all(rows.map(async(r:any)=>{const meeting=(await tx.select().from(meetings).where(and(eq(meetings.ownerId,ownerId),eq(meetings.requestId,r.id))).limit(1))[0]??null;let stale=false;if(["pending","responded"].includes(r.status))try{await currentRequest(tx,ownerId,r.id);}catch{stale=true;}return {...safe(r),stale,meeting:meeting?{id:meeting.id,scheduledAt:meeting.scheduledAt,durationMinutes:meeting.durationMinutes,status:meeting.status,revision:meeting.revision}:null};}));});
}
const denied=()=>new TRPCError({code:"UNAUTHORIZED",message:"Discovery link is unavailable, expired or revoked."});
async function authenticate(tx:any,id:string,token:string){
 const r=(await tx.select().from(requests).where(eq(requests.id,id)).limit(1))[0];
 if(!r||!r.tokenHash||r.tokenHash.length!==64||!timingSafeEqual(Buffer.from(r.tokenHash,"hex"),Buffer.from(tokenHash(token),"hex")))throw denied();
 try{return await currentRequest(tx,r.ownerId,id);}catch{throw denied();}
}
type PublicDiscoveryState={status:string;revision:number;timezone:string;ownerWindows:Array<{start:string;end:string}>;durationMinutes:number;expiresAt?:Date;alreadySubmitted?:boolean};
export async function publicDiscovery(input:{id:string;token:string;expectedRevision?:number;timezone?:string;windows?:Window[]}):Promise<PublicDiscoveryState>{
 const initial=(await(await requireDb()).select({ownerId:requests.ownerId}).from(requests).where(eq(requests.id,input.id)).limit(1))[0];if(!initial)throw denied();
 return withWorkspaceTransaction(initial.ownerId,async tx=>{
  const r=await authenticate(tx,input.id,input.token);
  if(input.windows){
   if(!input.timezone||!isValidTimezone(input.timezone))throw fail("Select a valid timezone.","BAD_REQUEST");
   const normalized=windows(input.windows),responseHash=workflowHash([normalized,input.timezone]);
   const earliest=new Date(r.ownerWindows[0].start).getTime(),latest=new Date(r.ownerWindows.at(-1)!.end).getTime();
   if(normalized.some(w=>new Date(w.start).getTime()<earliest||new Date(w.end).getTime()>latest))throw fail("Client availability must fit within the requested scheduling horizon.","BAD_REQUEST");
   if(r.status==="responded"&&r.responseHash===responseHash&&(input.expectedRevision===r.revision||input.expectedRevision===r.revision-1))return {status:r.status,revision:r.revision,alreadySubmitted:true,ownerWindows:r.ownerWindows,timezone:r.timezone,durationMinutes:r.durationMinutes};
   if(r.status!=="pending"||input.expectedRevision!==r.revision)throw fail("Availability has already changed. Ask the recruiter for a new request.","CONFLICT");
   await tx.update(requests).set({status:"responded",clientWindows:normalized,clientTimezone:input.timezone,responseHash,revision:r.revision+1}).where(and(eq(requests.ownerId,r.ownerId),eq(requests.id,r.id)));
   if(r.autoSelect)await tx.insert(automationQueue).values({id:createId("que_"),ownerId:r.ownerId,jobType:"discovery_select",payload:{requestId:r.id,revision:r.revision+1},priority:25,idempotencyKey:`discovery_select:${r.id}:${r.revision+1}`,status:"queued",scheduledAt:new Date(),attempts:0,maxAttempts:3});
   await recordAudit({ownerId:r.ownerId,actorType:"provider",actorId:"discovery_capability",action:"discovery.availability_submitted",resourceType:"client_discovery",resourceId:r.id,metadata:{revision:r.revision+1,identityVerified:false}},tx);
   return {status:"responded",revision:r.revision+1,alreadySubmitted:false,ownerWindows:r.ownerWindows,timezone:r.timezone,durationMinutes:r.durationMinutes};
  }
  return {status:r.status,revision:r.revision,ownerWindows:r.ownerWindows,timezone:r.timezone,durationMinutes:r.durationMinutes,expiresAt:r.expiresAt};
 });
}
const asWindows=(rows:Array<{start:string;end:string}>)=>rows.map(w=>({start:new Date(w.start),end:new Date(w.end)}));
const fingerprint=(r:typeof requests.$inferSelect,connectionRevision:number,calendarId:string)=>workflowHash([r.id,r.revision,r.sourceFingerprint,r.ownerWindows,r.clientWindows,r.durationMinutes,r.bufferMinutes,connectionRevision,calendarId]);
export async function proposeDiscovery(ownerId:number,id:string){
 const snapshot=()=>withWorkspaceTransaction(ownerId,async tx=>{const r=await currentRequest(tx,ownerId,id);if(r.status!=="responded"||!r.clientWindows?.length)throw fail("Client availability is required before proposing discovery.");return {...r};});
 const r=await snapshot(),all=[...asWindows(r.ownerWindows),...asWindows(r.clientWindows!)],pad=r.bufferMinutes*60000;
 const start=new Date(Math.min(...all.map(w=>w.start.getTime()))-pad),end=new Date(Math.max(...all.map(w=>w.end.getTime()))+pad);
 const busy=await googleFreeBusyWithBuffers(ownerId,start,end);
 return withWorkspaceTransaction(ownerId,async tx=>{const latest=await currentRequest(tx,ownerId,id);if(latest.revision!==r.revision||latest.sourceFingerprint!==r.sourceFingerprint)throw fail("Discovery availability changed during the calendar check.","CONFLICT");
  const internal=await recordedOwnerBusy(tx,ownerId,start,end),result=commonAvailability({candidate:asWindows(latest.clientWindows!),interviewer:asWindows(latest.ownerWindows),busy:[...busy.busy,...internal],durationMinutes:r.durationMinutes,bufferMinutes:r.bufferMinutes,now:new Date(Date.now()+15*60000)});
  return {...result,fingerprint:fingerprint(latest,busy.connectionRevision,busy.calendarId),connectionRevision:busy.connectionRevision,calendarId:busy.calendarId,googleCheckedAt:busy.checkedAt};
 });
}
export async function bookDiscovery(ownerId:number,actorId:number|string,input:{requestId:string;scheduledAt:Date;fingerprint:string},automatic=false){
 const bookingHash=workflowHash([input.requestId,input.scheduledAt.toISOString(),input.fingerprint]);
 const prior=()=>withWorkspaceTransaction(ownerId,async tx=>{await owned(tx,ownerId,input.requestId);const m=(await tx.select().from(meetings).where(and(eq(meetings.ownerId,ownerId),eq(meetings.requestId,input.requestId))).limit(1))[0];if(!m)return null;if(m.bookingHash!==bookingHash)throw fail("This request already booked different meeting details.","CONFLICT");return {id:m.id as string,status:m.status as string,alreadyExists:true,participantAcceptance:false};});
 const replay=await prior();if(replay)return replay;
 const proposal=await proposeDiscovery(ownerId,input.requestId);if(proposal.fingerprint!==input.fingerprint||!proposal.slots.some(w=>w.start.getTime()===input.scheduledAt.getTime()))throw fail("Calendar or availability changed. Review fresh proposals.","CONFLICT");
 return withWorkspaceTransaction(ownerId,async tx=>{
  const existing=(await tx.select().from(meetings).where(and(eq(meetings.ownerId,ownerId),eq(meetings.requestId,input.requestId))).limit(1))[0];if(existing){if(existing.bookingHash!==bookingHash)throw fail("This request already booked different meeting details.","CONFLICT");return {id:existing.id as string,status:existing.status as string,alreadyExists:true,participantAcceptance:false};}
  const r=await currentRequest(tx,ownerId,input.requestId),workspace=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0];
  if(automatic&&(!workspace.backgroundEnabled||workspace.emergencyStop))return {status:"deferred",nextActionAt:new Date(Date.now()+60000)};
  if(automatic&&!r.autoSelect)throw fail("Automatic selection is not authorized for this request.");
  const connection=(await tx.select().from(googleCalendarConnections).where(eq(googleCalendarConnections.ownerId,ownerId)).limit(1))[0];
  if(connection?.status!=="active"||connection.revision!==proposal.connectionRevision||connection.calendarId!==proposal.calendarId||Date.now()-new Date(proposal.googleCheckedAt).getTime()>30000||fingerprint(r,connection.revision,connection.calendarId)!==input.fingerprint)throw fail("Calendar connection or request changed before booking.","CONFLICT");
  const start=new Date(input.scheduledAt.getTime()-r.bufferMinutes*60000),end=new Date(input.scheduledAt.getTime()+(r.durationMinutes+r.bufferMinutes)*60000);
  if((await recordedOwnerBusy(tx,ownerId,start,end)).length)throw fail("This time now conflicts with another recorded meeting or hold.","CONFLICT");
  const id=createId("dcm_");await tx.insert(meetings).values({id,ownerId,requestId:r.id,bookingHash,scheduledAt:input.scheduledAt,durationMinutes:r.durationMinutes,bufferMinutes:r.bufferMinutes,timezone:r.clientTimezone||r.timezone,status:"tentative",revision:1});
  await tx.update(requests).set({status:"booked",revision:r.revision+1,tokenHash:""}).where(and(eq(requests.ownerId,ownerId),eq(requests.id,r.id)));
  await appendWorkflowEvent(tx,ownerId,"discovery.booked",r.id,1,{meetingId:id,automatic,participantAcceptance:false,googleConnectionRevision:connection.revision});
  await recordAudit({ownerId,actorType:automatic?"cron":"user",actorId:String(actorId),action:"discovery.booked",resourceType:"client_discovery",resourceId:r.id,metadata:{meetingId:id,participantAcceptance:false}},tx);
  return {id,status:"tentative",alreadyExists:false,participantAcceptance:false};
 });
}
export async function cancelDiscovery(ownerId:number,actorId:number,input:{requestId:string;expectedRevision:number}){
 return withWorkspaceTransaction(ownerId,async tx=>{const r=await owned(tx,ownerId,input.requestId);if(r.status==="cancelled")return {alreadyCancelled:true};if(r.revision!==input.expectedRevision)throw fail("Discovery changed. Reload before cancelling.","CONFLICT");
  await tx.update(requests).set({status:"cancelled",tokenHash:"",revision:r.revision+1}).where(and(eq(requests.ownerId,ownerId),eq(requests.id,r.id)));
  const prepared=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,"discovery.email_requested"),eq(workflowEvents.aggregateId,r.id)));
  for(const e of prepared){const dispatch=(await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId,ownerId),eq(emailDispatches.approvalId,String(e.metadata?.approvalId)))).limit(1))[0];if(dispatch)await cancelUnusedEmailDispatch(tx,ownerId,dispatch,"Client discovery request cancelled.");}
  const m=(await tx.select().from(meetings).where(and(eq(meetings.ownerId,ownerId),eq(meetings.requestId,r.id))).limit(1))[0];if(m)await tx.update(meetings).set({status:"cancelled",revision:m.revision+1}).where(and(eq(meetings.ownerId,ownerId),eq(meetings.id,m.id)));
  await tx.update(automationQueue).set({status:"cancelled",lockToken:null,lockedAt:null}).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.idempotencyKey,`discovery_select:${r.id}:${r.revision}`),inArray(automationQueue.status,["queued","retryable_failed"])));
  await tx.update(incidents).set({status:"resolved",resolvedAt:new Date(),containmentNotes:"Owner cancelled this discovery request."}).where(and(eq(incidents.ownerId,ownerId),eq(incidents.incidentType,"client_discovery_no_slots"),eq(incidents.affectedResourceId,r.id),inArray(incidents.status,["detected","triaged","contained","investigated"])));
  await recordAudit({ownerId,actorType:"user",actorId:String(actorId),action:"discovery.cancelled",resourceType:"client_discovery",resourceId:r.id},tx);return {alreadyCancelled:false};
 });
}
export async function executeDiscoverySelection(ownerId:number,payload:any){
 const state=await withWorkspaceTransaction(ownerId,async tx=>({request:await owned(tx,ownerId,String(payload?.requestId??"")),workspace:(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0]}));
 if(!state.workspace.backgroundEnabled||state.workspace.emergencyStop)return {status:"deferred",nextActionAt:new Date(Date.now()+60000)};
 const r=state.request;
 if(!r.autoSelect||r.status!=="responded"||r.revision!==payload?.revision)return {status:"stale"};
 const proposed=await proposeDiscovery(ownerId,r.id);
 if(!proposed.slots.length)return withWorkspaceTransaction(ownerId,async tx=>{const latest=await currentRequest(tx,ownerId,r.id);if(latest.revision!==r.revision)throw fail("Discovery changed during automatic selection.","CONFLICT");const settings=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0];if(!settings.backgroundEnabled||settings.emergencyStop)return {status:"deferred",nextActionAt:new Date(Date.now()+60000)};const key=workflowHash(["discovery.no_slots",r.id,1,""]);const prior=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventKey,key))).limit(1))[0];if(!prior){await tx.insert(incidents).values({id:createId("inc_"),ownerId,incidentType:"client_discovery_no_slots",severity:"medium",status:"detected",affectedResourceType:"client_discovery",affectedResourceId:r.id,summary:"Client discovery has no shared free slot. Review windows and create a new request."});await appendWorkflowEvent(tx,ownerId,"discovery.no_slots",r.id,1,{});}return {status:"owner_review"};});
 return bookDiscovery(ownerId,"managed_discovery",{requestId:r.id,scheduledAt:proposed.slots[0].start,fingerprint:proposed.fingerprint},true);
}
export async function discoveryIcs(ownerId:number,meetingId:string){
 return withWorkspaceTransaction(ownerId,async tx=>{const m=(await tx.select().from(meetings).where(and(eq(meetings.ownerId,ownerId),eq(meetings.id,meetingId))).limit(1))[0];if(!m)throw new TRPCError({code:"NOT_FOUND"});return {ics:createInterviewIcs({uid:`discovery-${m.id}@freelancehr.overseasjob.in`,sequence:m.revision,start:new Date(m.scheduledAt),end:new Date(new Date(m.scheduledAt).getTime()+m.durationMinutes*60000),summary:"Client hiring discovery",description:"Tentative discovery reservation. Availability submission is not verified attendance or commercial acceptance.",status:m.status==="cancelled"?"CANCELLED":"TENTATIVE"})};});
}

/** Adapter for the shared private-link outbox; no second sender or token store. */
export async function pendingDiscoveryForMail(tx:any,ownerId:number,id:string,now=new Date()){
 const r=await currentRequest(tx,ownerId,id);
 if(r.status!=="pending"||new Date(r.expiresAt)<=now)throw fail("Discovery request is expired, cancelled, submitted or booked.");
 return {...r,groupId:r.id,participant:"client",mailPurpose:"client_discovery" as const};
}
export async function discoveryMailRecipient(tx:any,ownerId:number,row:{id:string;conversationId:string;contactId:string},conversationId:string,now=new Date()){
 const current=await pendingDiscoveryForMail(tx,ownerId,row.id,now);
 if(current.conversationId!==conversationId||current.contactId!==row.contactId)throw fail("Discovery email must use the request's current client conversation.");
 const c=(await tx.select().from(conversations).where(and(eq(conversations.ownerId,ownerId),eq(conversations.id,conversationId))).limit(1))[0];
 if(c?.channel!=="email"||["closed","archived","opted_out"].includes(c.status))throw fail("An active client email conversation is required.");
 const contact=(await tx.select().from(contacts).where(and(eq(contacts.ownerId,ownerId),eq(contacts.id,current.contactId))).limit(1))[0];
 if(!contact?.email||!await hasClientCommunicationPermission(tx,ownerId,current.contactId,now)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email))throw fail("Current client email and communication permission are required.");
 return contact.email.trim().toLowerCase() as string;
}
