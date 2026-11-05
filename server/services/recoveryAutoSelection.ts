import {and,desc,eq,inArray} from 'drizzle-orm';
import {TRPCError} from '@trpc/server';
import {availabilityInvites,automationQueue,googleCalendarConnections,incidents,jobs,workflowEvents,workspaceSettings} from '../../drizzle/schema';
import {createId,recordAudit,requireDb} from '../db';
import {withWorkspaceTransaction} from './database';
import {appendWorkflowEvent,workflowHash} from './workflowStore';
import {assertRecoveryCurrent} from './interviewRecovery';
import {confirmationScheduleFingerprint} from './interviewScheduleIdentity';
import {requireSchedulableCandidate} from './interviewScheduling';
import {bookCollectedAvailability,proposeCollectedAvailability} from './participantAvailability';
import {recoveryIncidentId,resolveRecoveryDeadline} from './interviewRecoveryIncidents';
const eventType='interview.recovery_automation_configured';
const key=(groupId:string,revision:number)=>`recovery-auto:${groupId}:${revision}`;
type Settings={enabled:boolean;durationMinutes:number;bufferMinutes:number;minLeadMinutes:number;horizonDays:number};
type Scope=Settings & {interviewId:string;scheduleFingerprint:string;connectionRevision:number;calendarId:string;windowEnd:string;requestHash:string};
export type RecoveryAutomationInput=Settings & {groupId:string;expectedRevision:number};
class WorkerPaused extends Error {}
class AuthorityChanged extends TRPCError {constructor(){super({code:'PRECONDITION_FAILED',message:'Recovery automation authority, resource or calendar changed.'});}}
async function latest(tx:any,ownerId:number,groupId:string){return (await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,groupId),eq(workflowEvents.eventType,eventType))).orderBy(desc(workflowEvents.revision)).limit(1))[0] as typeof workflowEvents.$inferSelect|undefined;}
async function pair(tx:any,ownerId:number,groupId:string){const rows:typeof availabilityInvites.$inferSelect[]=await tx.select().from(availabilityInvites).where(and(eq(availabilityInvites.ownerId,ownerId),eq(availabilityInvites.groupId,groupId)));if(rows.length!==2)throw new TRPCError({code:'NOT_FOUND',message:'Owned recovery request is required.'});return rows.map(r=>({...r}));}
async function state(tx:any,ownerId:number,groupId:string){await pair(tx,ownerId,groupId);const row=await latest(tx,ownerId,groupId),s=row?.metadata as Partial<Scope>|undefined;const task=row?(await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.idempotencyKey,key(groupId,row.revision)))).limit(1))[0]:undefined;return {revision:row?.revision??0,enabled:s?.enabled===true,durationMinutes:s?.durationMinutes??45,bufferMinutes:s?.bufferMinutes??15,minLeadMinutes:s?.minLeadMinutes??60,horizonDays:s?.horizonDays??14,windowEnd:s?.windowEnd,jobStatus:task?.status??null,outcome:(task?.result as {status?:string}|null)?.status??null};}
export async function recoveryAutomationStatus(ownerId:number,groupId:string){return state(await requireDb(),ownerId,groupId);}
export async function configureRecoveryAutomation(ownerId:number,actorId:number,input:RecoveryAutomationInput){
 if(!Number.isInteger(input.durationMinutes)||input.durationMinutes<15||input.durationMinutes>240||!Number.isInteger(input.bufferMinutes)||input.bufferMinutes<0||input.bufferMinutes>60||!Number.isInteger(input.minLeadMinutes)||input.minLeadMinutes<15||!Number.isInteger(input.horizonDays)||input.horizonDays<1||input.horizonDays>31||input.minLeadMinutes>=input.horizonDays*1440)throw new TRPCError({code:'BAD_REQUEST',message:'Choose a 15–240 minute duration, 0–60 minute buffer, valid notice and 1–31 day horizon.'});
 return withWorkspaceTransaction(ownerId,async tx=>{
  const rows=await pair(tx,ownerId,input.groupId),old=await latest(tx,ownerId,input.groupId),revision=old?.revision??0,requestHash=workflowHash([input.expectedRevision,input.enabled,input.durationMinutes,input.bufferMinutes,input.minLeadMinutes,input.horizonDays]);
  if(revision!==input.expectedRevision){if(revision===input.expectedRevision+1&&(old?.metadata as Partial<Scope>|undefined)?.requestHash===requestHash)return state(tx,ownerId,input.groupId);throw new TRPCError({code:'CONFLICT',message:'Automation settings changed. Refresh before authorizing.'});}
  let scope:Partial<Scope>={...input,requestHash};
  if(input.enabled){
   if(rows.some(r=>!['pending','submitted'].includes(r.status)||r.expiresAt<=new Date()))throw new AuthorityChanged();
   const interview=await assertRecoveryCurrent(tx,ownerId,input.groupId,rows[0].candidateId,rows[0].jobId);if(!interview)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Only a bound interview recovery can use automatic selection.'});
   await requireSchedulableCandidate(tx,ownerId,interview.candidateId);
   const workspace=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0],connection=(await tx.select().from(googleCalendarConnections).where(eq(googleCalendarConnections.ownerId,ownerId)).limit(1))[0];
   if(!workspace?.backgroundEnabled||workspace.emergencyStop||connection?.status!=='active')throw new TRPCError({code:'PRECONDITION_FAILED',message:'Enable the worker, clear emergency stop and connect Google Calendar first.'});
   scope={...scope,interviewId:interview.id,scheduleFingerprint:confirmationScheduleFingerprint(interview),connectionRevision:connection.revision,calendarId:connection.calendarId,windowEnd:new Date(Date.now()+input.horizonDays*86400000).toISOString()};
  }
  await tx.update(automationQueue).set({status:'cancelled',lastError:'Owner changed recovery automation settings.'}).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.idempotencyKey,key(input.groupId,revision)),inArray(automationQueue.status,['queued','retryable_failed'])));
  await appendWorkflowEvent(tx,ownerId,eventType,input.groupId,revision+1,scope);
  if(input.enabled)await resolveRecoveryDeadline(tx,ownerId,input.groupId,'Owner authorized revised automatic recovery limits.');
  if(input.enabled)await tx.insert(automationQueue).values({id:createId('que_'),ownerId,jobType:'recovery_auto_select',payload:{groupId:input.groupId,revision:revision+1},priority:15,status:'queued',scheduledAt:new Date(),attempts:0,maxAttempts:3,idempotencyKey:key(input.groupId,revision+1)});
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'interview.recovery_automation_configured',resourceType:'availability',resourceId:input.groupId,metadata:{enabled:input.enabled,revision:revision+1}},tx);
  return state(tx,ownerId,input.groupId);
 });
}
async function authorized(tx:any,ownerId:number,groupId:string,revision:number){
 const row=await latest(tx,ownerId,groupId),s=row?.metadata as Scope|undefined,workspace=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0];
 if(!row||row.revision!==revision||!s?.enabled)throw new AuthorityChanged();
 if(!workspace?.backgroundEnabled||workspace.emergencyStop)throw new WorkerPaused();
 const rows=await pair(tx,ownerId,groupId);if(rows.some(r=>!['pending','submitted'].includes(r.status)||r.expiresAt<=new Date())||new Date(s.windowEnd)<=new Date())throw new AuthorityChanged();
 let interview;try{interview=await assertRecoveryCurrent(tx,ownerId,groupId,rows[0].candidateId,rows[0].jobId);await requireSchedulableCandidate(tx,ownerId,rows[0].candidateId);}catch(e){if(e instanceof TRPCError&&['CONFLICT','NOT_FOUND','PRECONDITION_FAILED'].includes(e.code))throw new AuthorityChanged();throw e;}
 const connection=(await tx.select().from(googleCalendarConnections).where(eq(googleCalendarConnections.ownerId,ownerId)).limit(1))[0],job=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,rows[0].jobId))).limit(1))[0];
 if(!interview||interview.id!==s.interviewId||confirmationScheduleFingerprint(interview)!==s.scheduleFingerprint||connection?.status!=='active'||connection.revision!==s.connectionRevision||connection.calendarId!==s.calendarId||!job||job.companyId!==interview.companyId||['cancelled','archived','filled','paused'].includes(job.pipelineState))throw new AuthorityChanged();
 return {scope:s,rows};
}
export async function executeRecoveryAutoSelection(ownerId:number,payload:unknown){
 const p=payload as {groupId?:string;revision?:number};if(!p||typeof p.groupId!=='string'||p.groupId.length<4||p.groupId.length>36||!Number.isInteger(p.revision)||(p.revision??0)<1)throw new TRPCError({code:'BAD_REQUEST',message:'Malformed recovery automation task.'});const groupId=p.groupId,revision=p.revision!;
 try{
  const previous=(await (await requireDb()).select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,groupId),eq(workflowEvents.eventType,'availability.booked'))).limit(1))[0];
  if(previous)return {status:'already_booked',id:String(previous.metadata?.interviewId),participantAcceptance:false};
  const terminal=(await (await requireDb()).select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,groupId),eq(workflowEvents.eventType,'interview.recovery_auto_needs_review'),eq(workflowEvents.revision,revision))).limit(1))[0];
  if(terminal)return {status:'needs_review',alreadyExists:true,participantAcceptance:false};
  const current=await withWorkspaceTransaction(ownerId,tx=>authorized(tx,ownerId,groupId,revision));
  if(current.rows.some(r=>r.status!=='submitted'))return {status:'deferred',nextActionAt:new Date(Math.min(Date.now()+60000,...current.rows.map(r=>r.expiresAt.getTime())))};
  const s=current.scope,selectionWindow={start:new Date(Date.now()+s.minLeadMinutes*60000),end:new Date(s.windowEnd)},proposed=await proposeCollectedAvailability(ownerId,groupId,s.durationMinutes,s.bufferMinutes,selectionWindow),slot=proposed.slots[0];
  if(!slot){
   await withWorkspaceTransaction(ownerId,async tx=>{
    const latest=await authorized(tx,ownerId,groupId,revision);if(workflowHash(latest.rows.map(r=>[r.id,r.revision]).sort())!==workflowHash(current.rows.map(r=>[r.id,r.revision]).sort()))throw new TRPCError({code:'CONFLICT',message:'Responses changed during automatic selection.'});
    const id=recoveryIncidentId(ownerId,groupId),existing=(await tx.select().from(incidents).where(and(eq(incidents.ownerId,ownerId),eq(incidents.id,id))).limit(1))[0];
    const values={incidentType:'interview_recovery_auto_review',status:'detected',severity:'medium' as const,affectedResourceType:'interview',affectedResourceId:s.interviewId,summary:'Automatic recovery found no suitable slot within the authorized notice and horizon. Review availability or authorize revised limits.',resolvedAt:null};
    if(existing)await tx.update(incidents).set(values).where(eq(incidents.id,id));else await tx.insert(incidents).values({id,ownerId,...values});
    await appendWorkflowEvent(tx,ownerId,'interview.recovery_auto_needs_review',groupId,revision,{incidentId:id});
   });return {status:'needs_review',reason:'No suitable authorized slot.',participantAcceptance:false};
  }
  const saved=await bookCollectedAvailability(ownerId,ownerId,{groupId,scheduledAt:slot.start,durationMinutes:s.durationMinutes,bufferMinutes:s.bufferMinutes,responsesFingerprint:proposed.responsesFingerprint},{actorId:key(groupId,revision),revision,selectionWindow,validate:async tx=>{await authorized(tx,ownerId,groupId,revision);if(slot.start.getTime()<Date.now()+s.minLeadMinutes*60000)throw new TRPCError({code:'CONFLICT',message:'The notice window advanced. Retry with a fresh slot.'});}});
  return {status:'booked',...saved};
 }catch(e){if(e instanceof WorkerPaused)return {status:'deferred',nextActionAt:new Date(Date.now()+60000)};if(e instanceof AuthorityChanged)return {status:'cancelled',reason:e.message};throw e;}
}
