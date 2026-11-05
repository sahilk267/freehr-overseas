import {assertRecoveryCurrent,matchesRecovery} from './interviewRecovery';
import {appendWorkflowEvent} from "./workflowStore";
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {and,desc,eq,inArray} from 'drizzle-orm';
import {TRPCError} from '@trpc/server';
import {availabilityInvites as invites,interviews,jobs,workflowEvents,googleCalendarConnections} from '../../drizzle/schema';
import {createId,recordAudit,requireDb} from '../db';
import {withWorkspaceTransaction} from './database';
import {assertRecordedSlotFree,scheduleInterviewInTransaction,rescheduleInterviewInTransaction,requireSchedulableCandidate} from './interviewScheduling';
import {isValidTimezone} from '../../shared/dateTime';
import {commonAvailability,type Window} from './availability';
import {googleFreeBusy} from './googleCalendar';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const denied=()=>new TRPCError({code:'UNAUTHORIZED',message:'Availability link is invalid, expired or revoked.'});
const safe=(row:typeof invites.$inferSelect)=>{const{tokenHash,requestHash,...value}=row;return {...value,status:!['revoked','booked'].includes(row.status)&&new Date(row.expiresAt).getTime()<=Date.now()?'expired':row.status};};
export async function listAvailabilityInvites(ownerId:number){
 const db=await requireDb(),rows=await db.select().from(invites).where(eq(invites.ownerId,ownerId)).orderBy(desc(invites.createdAt),desc(invites.id)).limit(100);
 const ids=rows.map(r=>r.groupId),events=ids.length?await db.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),inArray(workflowEvents.eventType,['availability.booked','interview.recovery_requested','interview.recovery_replaced']),inArray(workflowEvents.aggregateId,ids))):[];
 const targetIds=events.filter(e=>e.eventType==='interview.recovery_requested').map(e=>String(e.metadata?.interviewId)),targets=targetIds.length?await db.select().from(interviews).where(and(eq(interviews.ownerId,ownerId),inArray(interviews.id,targetIds))):[];
 return rows.map(row=>{const recovery=events.find(e=>e.aggregateId===row.groupId&&e.eventType==='interview.recovery_requested'),value=safe(row),target=recovery?targets.find(i=>i.id===recovery.metadata?.interviewId):undefined;
 return {...value,...(recovery?{recoveryInterviewId:String(recovery.metadata?.interviewId),...(!['revoked','booked','expired'].includes(value.status)&&!matchesRecovery(target,row.candidateId,row.jobId,recovery.metadata?.scheduleFingerprint)?{status:'stale'}:{})}:{}),replacedByGroupId:events.find(e=>e.aggregateId===row.groupId&&e.eventType==='interview.recovery_replaced')?.metadata?.groupId as string|undefined,bookedInterviewId:events.find(e=>e.aggregateId===row.groupId&&e.eventType==='availability.booked')?.metadata?.interviewId as string|undefined};});
}
export async function createAvailabilityInvites(ownerId:number,actorId:number,input:{candidateId:string;jobId:string;requestKey:string;expiresHours:number}){
 return withWorkspaceTransaction(ownerId,tx=>createAvailabilityInvitesInTransaction(tx,ownerId,String(actorId),input));
}
export async function createAvailabilityInvitesInTransaction(tx:any,ownerId:number,actorId:string,input:{candidateId:string;jobId:string;requestKey:string;expiresHours:number},actorType:'user'|'provider'='user'){
 if(!Number.isInteger(input.expiresHours)||input.expiresHours<1||input.expiresHours>168)throw new TRPCError({code:'BAD_REQUEST',message:'Link lifetime must be 1–168 hours.'});
 const groupId='avl_'+digest([ownerId,input.requestKey]).slice(0,32),requestHash=digest([input.candidateId,input.jobId,input.expiresHours]);
  const old=await tx.select().from(invites).where(and(eq(invites.ownerId,ownerId),eq(invites.groupId,groupId)));
  if(old.length){if(old.some((r:any)=>r.requestHash!==requestHash))throw new TRPCError({code:'CONFLICT',message:'Request identity already has different availability details.'});return {groupId,links:[],alreadyExists:true};}
  await requireSchedulableCandidate(tx,ownerId,input.candidateId);
  if(!(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,input.jobId))).limit(1))[0])throw new TRPCError({code:'NOT_FOUND',message:'Owned job is required.'});
  const links:Array<{id:string;participant:string;fragment:string}>=[];
  for(const participant of ['candidate','interviewer']){const id=createId('avi_'),token=randomBytes(32).toString('base64url');await tx.insert(invites).values({id,ownerId,groupId,candidateId:input.candidateId,jobId:input.jobId,requestHash,participant,tokenHash:digest(token),status:'pending',revision:1,expiresAt:new Date(Date.now()+input.expiresHours*3600000),submissionCount:0});links.push({id,participant,fragment:`${id}.${token}`});}
  await recordAudit({ownerId,actorType,actorId,action:'availability.links_created',resourceType:'availability',resourceId:groupId},tx);return {groupId,links,alreadyExists:false};
}
async function authenticate(tx:any,id:string,token:string){
 const row=(await tx.select().from(invites).where(eq(invites.id,id)).limit(1))[0] as typeof invites.$inferSelect;
 if(!row||!/^[A-Za-z0-9_-]{43}$/.test(token)||!/^[a-f0-9]{64}$/.test(row.tokenHash)||token.length!==43||!['pending','submitted'].includes(row.status)||new Date(row.expiresAt).getTime()<=Date.now()||!timingSafeEqual(Buffer.from(row.tokenHash,'hex'),Buffer.from(digest(token),'hex')))throw denied();
 await requireSchedulableCandidate(tx,row.ownerId,row.candidateId);await assertRecoveryCurrent(tx,row.ownerId,row.groupId,row.candidateId,row.jobId);return {...row};
}
export async function publicAvailability(input:{id:string;token:string;expectedRevision?:number;windows?:Window[];timezone?:string}){
 const found=await authenticate(await requireDb(),input.id,input.token);
 return withWorkspaceTransaction(found.ownerId,async tx=>{
  const row=await authenticate(tx,input.id,input.token);
  if(input.windows){
   const normalized=input.windows.map(w=>{const start=new Date(w.start),end=new Date(w.end);if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime()))throw new TRPCError({code:'BAD_REQUEST',message:'Invalid availability dates.'});return {start:start.toISOString(),end:end.toISOString()};});
   if(row.status==='submitted' && input.expectedRevision===row.revision-1 && input.timezone===row.timezone && digest(normalized.map(w=>[w.start,w.end]))===digest((row.windows??[]).map(w=>[w.start,w.end])))return {participant:row.participant,status:row.status,revision:row.revision,expiresAt:row.expiresAt};
   if(row.revision!==input.expectedRevision)throw new TRPCError({code:'CONFLICT',message:'This availability response changed. Reload before submitting.'});
   if(row.submissionCount>=5)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Correction limit reached. Ask the recruiter for a new request.'});
   if(!isValidTimezone(input.timezone||'')||!input.windows.length||input.windows.length>20||input.windows.some(w=>new Date(w.start).getTime()<=Date.now()||new Date(w.end).getTime()>Date.now()+90*86400000))throw new TRPCError({code:'BAD_REQUEST',message:'Choose future windows within 90 days and a valid timezone.'});
   commonAvailability({candidate:input.windows,interviewer:input.windows,durationMinutes:15,bufferMinutes:0});
   const windows=input.windows.map(w=>({start:new Date(w.start).toISOString(),end:new Date(w.end).toISOString()}));
   await tx.update(invites).set({windows,timezone:input.timezone,revision:row.revision+1,status:'submitted',submissionCount:row.submissionCount+1}).where(eq(invites.id,row.id));
   await recordAudit({ownerId:row.ownerId,actorType:'provider',action:'availability.submitted',resourceType:'availability_invite',resourceId:row.id,metadata:{participant:row.participant,revision:row.revision+1,identityVerified:false}},tx);
   return {participant:row.participant,status:'submitted',revision:row.revision+1,expiresAt:row.expiresAt};
  }
  return {participant:row.participant,status:row.status,revision:row.revision,expiresAt:row.expiresAt};
 });
}
export async function revokeAvailability(ownerId:number,actorId:number,groupId:string){return withWorkspaceTransaction(ownerId,async tx=>{const rows=await tx.select().from(invites).where(and(eq(invites.ownerId,ownerId),eq(invites.groupId,groupId)));if(!rows.length)throw new TRPCError({code:'NOT_FOUND'});if(rows.every((r:any)=>r.status==='revoked'))return {revoked:true};for(const row of rows)await tx.update(invites).set({status:'revoked',revision:row.revision+1}).where(eq(invites.id,row.id));await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'availability.revoked',resourceType:'availability',resourceId:groupId},tx);return {revoked:true};});}
export async function proposeCollectedAvailability(ownerId:number,groupId:string,durationMinutes:number,bufferMinutes:number){
 const get=async()=>withWorkspaceTransaction(ownerId,async tx=>{const rows=await tx.select().from(invites).where(and(eq(invites.ownerId,ownerId),eq(invites.groupId,groupId)));if(rows.length!==2||rows.some((r:any)=>r.status!=='submitted'||new Date(r.expiresAt).getTime()<=Date.now()))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Both valid participant responses are required.'});await requireSchedulableCandidate(tx,ownerId,rows[0].candidateId);const recovery=await assertRecoveryCurrent(tx,ownerId,groupId,rows[0].candidateId,rows[0].jobId);return rows.map((r:any)=>({...r,declinedStart:recovery?.scheduledAt?.getTime(),windows:structuredClone(r.windows)}));});
 const rows=await get(),candidate=rows.find((r:any)=>r.participant==='candidate')!,interviewer=rows.find((r:any)=>r.participant==='interviewer')!;
 const windows=(r:any)=>r.windows.map((w:any)=>({start:new Date(w.start),end:new Date(w.end)})) as Window[];
 const input={candidate:windows(candidate),interviewer:windows(interviewer),durationMinutes,bufferMinutes},initial=commonAvailability(input);
 initial.slots=initial.slots.filter(s=>s.start.getTime()!==rows[0].declinedStart);
 const responsesFingerprint=digest([ownerId,groupId,durationMinutes,bufferMinutes,rows.map((r:any)=>[r.id,r.revision]).sort()]);
 if(!initial.slots.length)return {...initial,responsesFingerprint,googleChecked:false,googleConnectionRevision:undefined,googleCheckedAt:undefined};
 const all=[...input.candidate,...input.interviewer],pad=bufferMinutes*60000,busy=await googleFreeBusy(ownerId,new Date(Math.min(...all.map(w=>w.start.getTime()))-pad),new Date(Math.max(...all.map(w=>w.end.getTime()))+pad));
 const latest=await get();if(digest(latest.map((r:any)=>[r.id,r.revision]).sort())!==digest(rows.map((r:any)=>[r.id,r.revision]).sort()))throw new TRPCError({code:'CONFLICT',message:'Participant availability changed during the check. Retry.'});
 const checked=commonAvailability({...input,busy:busy.busy});checked.slots=checked.slots.filter(s=>s.start.getTime()!==rows[0].declinedStart);
 return {...checked,responsesFingerprint:digest([responsesFingerprint,busy.connectionRevision,busy.calendarId]),googleChecked:true,googleConnectionRevision:busy.connectionRevision,googleCheckedAt:busy.checkedAt};
}


type BookingInput={groupId:string;scheduledAt:Date;durationMinutes:number;bufferMinutes:number;responsesFingerprint:string;meetingUrl?:string};
async function priorBooking(tx:any,ownerId:number,input:BookingInput){
 const prior=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,input.groupId),eq(workflowEvents.eventType,'availability.booked'))).limit(1))[0];
 if(!prior)return null;
 if(prior.metadata?.requestHash!==bookingHash(input))throw new TRPCError({code:'CONFLICT',message:'This availability request already booked an interview with different details. Review the saved interview.'});
 return {id:String(prior.metadata.interviewId),alreadyExists:true,participantAcceptance:false};
}
const bookingHash=(input:BookingInput)=>digest([input.groupId,new Date(input.scheduledAt).toISOString(),input.durationMinutes,input.bufferMinutes,input.responsesFingerprint,input.meetingUrl??null]);
export async function bookCollectedAvailability(ownerId:number,actorId:number,input:BookingInput){
 const prior=await withWorkspaceTransaction(ownerId,tx=>priorBooking(tx,ownerId,input));if(prior)return prior;
 const proposed=await proposeCollectedAvailability(ownerId,input.groupId,input.durationMinutes,input.bufferMinutes);
 if(proposed.responsesFingerprint!==input.responsesFingerprint||!proposed.googleChecked||!proposed.slots.some(s=>s.start.getTime()===input.scheduledAt.getTime()))throw new TRPCError({code:'CONFLICT',message:'Availability or Google busy time changed. Review new proposals before booking.'});
 return withWorkspaceTransaction(ownerId,async tx=>{
  const replay=await priorBooking(tx,ownerId,input);if(replay)return replay;
  const rows=await tx.select().from(invites).where(and(eq(invites.ownerId,ownerId),eq(invites.groupId,input.groupId)));
  if(rows.length!==2||rows.some((r:any)=>r.status!=='submitted'||new Date(r.expiresAt).getTime()<=Date.now()))throw new TRPCError({code:'CONFLICT',message:'Participant responses changed or expired during booking.'});
  await requireSchedulableCandidate(tx,ownerId,rows[0].candidateId);
  const recovery=await assertRecoveryCurrent(tx,ownerId,input.groupId,rows[0].candidateId,rows[0].jobId);
  if(recovery?.scheduledAt?.getTime()===input.scheduledAt.getTime())throw new TRPCError({code:'CONFLICT',message:'Choose a different time from the declined appointment.'});
  await assertRecordedSlotFree(tx,ownerId,rows[0].candidateId,{scheduledAt:new Date(input.scheduledAt.getTime()-input.bufferMinutes*60000),durationMinutes:input.durationMinutes+2*input.bufferMinutes,timezone:'UTC'});
  const connection=(await tx.select().from(googleCalendarConnections).where(eq(googleCalendarConnections.ownerId,ownerId)).limit(1))[0];
  if(connection?.status!=='active'||connection.revision!==proposed.googleConnectionRevision||!proposed.googleCheckedAt||Date.now()-new Date(proposed.googleCheckedAt).getTime()>30000)throw new TRPCError({code:'CONFLICT',message:'Calendar connection or availability check changed. Review again.'});
  const currentResponses=digest([ownerId,input.groupId,input.durationMinutes,input.bufferMinutes,rows.map((r:any)=>[r.id,r.revision]).sort()]);
  if(digest([currentResponses,connection.revision,connection.calendarId])!==input.responsesFingerprint)throw new TRPCError({code:'CONFLICT',message:'Responses or selected calendar changed. Review proposals again.'});
  const job=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,rows[0].jobId))).limit(1))[0];if(!job)throw new TRPCError({code:'NOT_FOUND'});
  const candidate=rows.find((r:any)=>r.participant==='candidate');
  let saved:{id:string;alreadyExists:boolean};
  if(recovery){await rescheduleInterviewInTransaction(tx,ownerId,actorId,{id:recovery.id,scheduledAt:input.scheduledAt,durationMinutes:input.durationMinutes,timezone:candidate?.timezone||'UTC',meetingUrl:input.meetingUrl});saved={id:recovery.id,alreadyExists:false};}
  else saved=await scheduleInterviewInTransaction(tx,ownerId,actorId,{candidateId:rows[0].candidateId,companyId:job.companyId,jobId:job.id,scheduledAt:input.scheduledAt,durationMinutes:input.durationMinutes,timezone:candidate?.timezone||'UTC',meetingUrl:input.meetingUrl,requestKey:'availability:'+input.groupId});
  await appendWorkflowEvent(tx,ownerId,'availability.booked',input.groupId,1,{requestHash:bookingHash(input),interviewId:saved.id,participantAcceptance:false});
  for(const row of rows)await tx.update(invites).set({status:'booked',tokenHash:'',revision:row.revision+1}).where(eq(invites.id,row.id));
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'availability.booked',resourceType:'availability',resourceId:input.groupId,metadata:{interviewId:saved.id,participantAcceptance:false}},tx);
  return {...saved,participantAcceptance:false};
 });
}

/** Replace expired/lost recovery links without changing their interview binding or opening parallel recovery chains. */
export async function restartInterviewRecovery(ownerId:number,actorId:number,input:{groupId:string;requestKey:string}){
 return withWorkspaceTransaction(ownerId,async tx=>{
  const old=await tx.select().from(invites).where(and(eq(invites.ownerId,ownerId),eq(invites.groupId,input.groupId)));
  if(old.length!==2)throw new TRPCError({code:'NOT_FOUND',message:'Owned recovery request is required.'});
  const requestHash=digest(input.requestKey),prior=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,input.groupId),eq(workflowEvents.eventType,'interview.recovery_replaced'))).limit(1))[0];
  if(prior){if(prior.metadata?.requestHash!==requestHash)throw new TRPCError({code:'CONFLICT',message:'This recovery request was replaced. Use the latest request.'});return {groupId:String(prior.metadata.groupId),links:[],alreadyExists:true};}
  await requireSchedulableCandidate(tx,ownerId,old[0].candidateId);
  const interview=await assertRecoveryCurrent(tx,ownerId,input.groupId,old[0].candidateId,old[0].jobId);
  if(!interview)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Only a bound interview recovery can be restarted.'});
  const created=await createAvailabilityInvitesInTransaction(tx,ownerId,String(actorId),{candidateId:interview.candidateId,jobId:interview.jobId,requestKey:`recovery-restart:${input.groupId}:${requestHash.slice(0,32)}`,expiresHours:48});
  if(created.alreadyExists)throw new TRPCError({code:'CONFLICT',message:'Replacement identity already exists.'});
  const source=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,input.groupId),eq(workflowEvents.eventType,'interview.recovery_requested'))).limit(1))[0];
  await appendWorkflowEvent(tx,ownerId,'interview.recovery_requested',created.groupId,1,{interviewId:interview.id,scheduleFingerprint:source.metadata.scheduleFingerprint});
  await appendWorkflowEvent(tx,ownerId,'interview.recovery_replaced',input.groupId,1,{requestHash,groupId:created.groupId});
  for(const row of old)await tx.update(invites).set({status:'revoked',tokenHash:'',revision:row.revision+1}).where(eq(invites.id,row.id));
  return created;
 });
}
