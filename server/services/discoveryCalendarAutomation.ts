import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { automationQueue, clientDiscoveryMeetings, googleCalendarConnections, workflowEvents, workspaceSettings } from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
import { withWorkspaceTransaction } from "./database";
import { googleDiscoverySnapshot, syncGoogleDiscovery } from "./googleCalendar";
import { appendWorkflowEvent, workflowHash } from "./workflowStore";
const policyType="discovery.calendar_policy",requestType="discovery.calendar_requested";
async function event(tx:any,ownerId:number,type:string,id:string){return (await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,type),eq(workflowEvents.aggregateId,id))).orderBy(desc(workflowEvents.revision)).limit(1))[0];}
async function context(tx:any,ownerId:number,meetingId:string){
 const meeting=(await tx.select().from(clientDiscoveryMeetings).where(and(eq(clientDiscoveryMeetings.ownerId,ownerId),eq(clientDiscoveryMeetings.id,meetingId))).limit(1))[0];if(!meeting)throw new TRPCError({code:"NOT_FOUND",message:"Owned discovery meeting is required."});
 const workspace=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0],connection=(await tx.select().from(googleCalendarConnections).where(eq(googleCalendarConnections.ownerId,ownerId)).limit(1))[0];
 const latest=await event(tx,ownerId,policyType,meetingId),policy=latest?.metadata??{enabled:false,connectionRevision:0,connectionId:null,calendarId:null};return {workspace,connection,policy,revision:latest?.revision??0,meeting};
}
function connected(c:any){return c?.status==="active"&&Boolean(c.tokensCipher&&c.accountHash);}
function current(c:any,p:any){return connected(c)&&c.id===p.connectionId&&c.revision===p.connectionRevision&&c.calendarId===p.calendarId;}
export async function discoveryCalendarStatus(ownerId:number,meetingId:string){
 const db=await requireDb(),c=await context(db,ownerId,meetingId);
 const jobs=(await db.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.jobType,"google_calendar_sync"))).orderBy(desc(automationQueue.createdAt)).limit(100)).filter((j:any)=>j.payload?.resourceType==="client_discovery"&&j.payload?.meetingId===meetingId);
 return {enabled:c.policy.enabled===true&&current(c.connection,c.policy),revision:c.revision,needsReenable:c.policy.enabled===true&&!current(c.connection,c.policy),workerEnabled:Boolean(c.workspace?.backgroundEnabled),emergencyStop:Boolean(c.workspace?.emergencyStop),jobs:jobs.map((j:any)=>({id:j.id,status:j.status,lastError:j.lastError,outcome:j.result?.action??j.result?.status??null})),scope:"one_discovery_meeting_no_invitations"};
}
export async function authorizeDiscoveryRequestCalendar(tx:any,ownerId:number,requestId:string,actorId:number){
 const c=(await tx.select().from(googleCalendarConnections).where(eq(googleCalendarConnections.ownerId,ownerId)).limit(1))[0],w=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0];
 if(!connected(c)||!w?.backgroundEnabled||w.emergencyStop)throw new TRPCError({code:"PRECONDITION_FAILED",message:"Connect Google Calendar and enable the managed worker before authorizing discovery sync."});
 await appendWorkflowEvent(tx,ownerId,requestType,requestId,1,{connectionId:c.id,connectionRevision:c.revision,calendarId:c.calendarId,actorId,invitationsSent:false});
}
export async function inheritDiscoveryCalendarPolicy(tx:any,ownerId:number,requestId:string,meetingId:string){
 const grant=await event(tx,ownerId,requestType,requestId);if(!grant)return;
 const c=await context(tx,ownerId,meetingId);if(!current(c.connection,grant.metadata))return;
 await appendWorkflowEvent(tx,ownerId,policyType,meetingId,1,{...grant.metadata,enabled:true,requestId});await enqueueDiscoveryCalendarSync(tx,ownerId,meetingId);
}
export async function configureDiscoveryCalendar(ownerId:number,actorId:number,input:{meetingId:string;expectedRevision:number;enabled:boolean;previewHash?:string}){
 await withWorkspaceTransaction(ownerId,async tx=>{
  const c=await context(tx,ownerId,input.meetingId);
  const already=Boolean(c.policy.enabled)===input.enabled&&(!input.enabled||current(c.connection,c.policy));
  if(c.revision===input.expectedRevision+1&&already)return;
  if(c.revision!==input.expectedRevision)throw new TRPCError({code:"CONFLICT",message:"Discovery calendar authority changed. Reload it."});
  if(input.enabled){if(!connected(c.connection)||!c.workspace.backgroundEnabled||c.workspace.emergencyStop)throw new TRPCError({code:"PRECONDITION_FAILED",message:"Connect Google Calendar and enable the managed worker first."});const snapshot=await googleDiscoverySnapshot(tx,ownerId,input.meetingId);if(snapshot.previewHash!==input.previewHash)throw new TRPCError({code:"CONFLICT",message:"Review a fresh discovery calendar preview before enabling sync."});}
  await appendWorkflowEvent(tx,ownerId,policyType,input.meetingId,c.revision+1,{enabled:input.enabled,connectionId:c.connection?.id??null,connectionRevision:c.connection?.revision??0,calendarId:c.connection?.calendarId??null});
  await recordAudit({ownerId,actorType:"user",actorId:String(actorId),action:input.enabled?"discovery.calendar_enabled":"discovery.calendar_paused",resourceType:"client_discovery_meeting",resourceId:input.meetingId,metadata:{invitationsSent:false}},tx);
  if(input.enabled)await enqueueDiscoveryCalendarSync(tx,ownerId,input.meetingId);
 });
 return discoveryCalendarStatus(ownerId,input.meetingId);
}
export async function enqueueDiscoveryCalendarSync(tx:any,ownerId:number,meetingId:string){
 const c=await context(tx,ownerId,meetingId);if(!c.policy.enabled||!current(c.connection,c.policy))return;
 const snapshot=await googleDiscoverySnapshot(tx,ownerId,meetingId),key="google-discovery:"+workflowHash([ownerId,c.revision,snapshot.previewHash]);
 if((await tx.select().from(automationQueue).where(eq(automationQueue.idempotencyKey,key)).limit(1))[0])return;
 await tx.insert(automationQueue).values({id:createId("que_"),ownerId,jobType:"google_calendar_sync",status:"queued",priority:15,attempts:0,maxAttempts:5,scheduledAt:new Date(),idempotencyKey:key,payload:{resourceType:"client_discovery",meetingId,previewHash:snapshot.previewHash,revision:c.revision}});
}
export async function executeDiscoveryCalendarSync(ownerId:number,payload:any){
 const admission=async()=>{const c=await context(await requireDb(),ownerId,payload.meetingId);if(!c.policy.enabled||c.revision!==payload.revision||!current(c.connection,c.policy))return {status:"cancelled"} as const;const snapshot=await withWorkspaceTransaction(ownerId,tx=>googleDiscoverySnapshot(tx,ownerId,payload.meetingId));if(snapshot.previewHash!==payload.previewHash)return {status:"cancelled"} as const;if(!c.workspace?.backgroundEnabled||c.workspace.emergencyStop)return {status:"deferred",nextActionAt:new Date(Date.now()+60000)} as const;return null;};
 const initial=await admission();if(initial)return initial;
 const guard=async()=>{if(await admission())throw new TRPCError({code:"PRECONDITION_FAILED",message:"Discovery calendar authority or worker state changed."});};
 try{return await syncGoogleDiscovery(ownerId,payload.meetingId,payload.previewHash,guard,"automatic");}catch(error){const state=await admission();if(state)return state;throw error;}
}
