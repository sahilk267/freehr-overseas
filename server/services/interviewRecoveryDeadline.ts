import {recoveryIncidentId,recoveryIncidentType} from './interviewRecoveryIncidents';
import {and,asc,eq,exists,inArray,lte,notExists} from 'drizzle-orm';
import {TRPCError} from '@trpc/server';
import {availabilityInvites,incidents,workflowEvents,workspaceSettings} from '../../drizzle/schema';
import {recordAudit,requireDb} from '../db';
import {withWorkspaceTransaction} from './database';
import {assertRecoveryCurrent} from './interviewRecovery';
import {requireSchedulableCandidate} from './interviewScheduling';
import {appendWorkflowEvent} from './workflowStore';
/** Existing managed/supervised workers call this source. It never sends messages or chooses a time. */
export async function processDueRecoveryDeadlines(ownerId?:number,limit=10){
 const db=await requireDb(),now=new Date();
 const conditions=[lte(availabilityInvites.expiresAt,now),inArray(availabilityInvites.status,['pending','submitted']),
  exists(db.select({id:workflowEvents.id}).from(workflowEvents).where(and(eq(workflowEvents.ownerId,availabilityInvites.ownerId),eq(workflowEvents.aggregateId,availabilityInvites.groupId),eq(workflowEvents.eventType,'interview.recovery_requested')))),
  exists(db.select({id:workspaceSettings.ownerId}).from(workspaceSettings).where(and(eq(workspaceSettings.ownerId,availabilityInvites.ownerId),eq(workspaceSettings.backgroundEnabled,true),eq(workspaceSettings.emergencyStop,false)))),
  notExists(db.select({id:workflowEvents.id}).from(workflowEvents).where(and(eq(workflowEvents.ownerId,availabilityInvites.ownerId),eq(workflowEvents.aggregateId,availabilityInvites.groupId),inArray(workflowEvents.eventType,['interview.recovery_expired','interview.recovery_expiry_skipped']))))];
 if(ownerId!==undefined)conditions.push(eq(availabilityInvites.ownerId,ownerId));
 const due=await db.select().from(availabilityInvites).where(and(...conditions)).orderBy(asc(availabilityInvites.expiresAt),asc(availabilityInvites.id)).limit(Math.min(25,Math.max(1,limit))),seen=new Set<string>();let escalated=0,skipped=0;
 for(const item of due){const key=item.ownerId+':'+item.groupId;if(seen.has(key))continue;seen.add(key);
  const result=await withWorkspaceTransaction(item.ownerId,async tx=>{
   const workspace=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,item.ownerId)).limit(1))[0];
   if(!workspace?.backgroundEnabled||workspace.emergencyStop)return 'skipped';
   const rows:typeof availabilityInvites.$inferSelect[]=(await tx.select().from(availabilityInvites).where(and(eq(availabilityInvites.ownerId,item.ownerId),eq(availabilityInvites.groupId,item.groupId)))).map((r:typeof availabilityInvites.$inferSelect)=>({...r}));
   if(rows.length!==2||rows.some(r=>!['pending','submitted'].includes(r.status))||!rows.some(r=>r.expiresAt<=new Date()))return 'skipped';
   const prior=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,item.ownerId),eq(workflowEvents.aggregateId,item.groupId),inArray(workflowEvents.eventType,['interview.recovery_expired','interview.recovery_expiry_skipped']))).limit(1);if(prior.length)return 'skipped';
   let interview;
   try{interview=await assertRecoveryCurrent(tx,item.ownerId,item.groupId,rows[0].candidateId,rows[0].jobId);await requireSchedulableCandidate(tx,item.ownerId,rows[0].candidateId);}catch(e){interview=undefined;if(!(e instanceof TRPCError)||!['CONFLICT','NOT_FOUND','PRECONDITION_FAILED'].includes(e.code))throw e;}
   if(!interview){
    // The memory adapter cannot evaluate correlated EXISTS; ordinary requests remain untouched.
    const recovery=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,item.ownerId),eq(workflowEvents.aggregateId,item.groupId),eq(workflowEvents.eventType,'interview.recovery_requested'))).limit(1))[0];if(!recovery)return 'skipped';
   }
   for(const row of rows)await tx.update(availabilityInvites).set({status:'revoked',tokenHash:'',revision:row.revision+1}).where(eq(availabilityInvites.id,row.id));
   if(!interview){await appendWorkflowEvent(tx,item.ownerId,'interview.recovery_expiry_skipped',item.groupId,1,{reason:'Interview or candidate is no longer eligible.'});return 'skipped';}
   const id=recoveryIncidentId(item.ownerId,item.groupId),existing=(await tx.select().from(incidents).where(and(eq(incidents.ownerId,item.ownerId),eq(incidents.id,id))).limit(1))[0];
   if(!existing)await tx.insert(incidents).values({id,ownerId:item.ownerId,incidentType:recoveryIncidentType,severity:'medium',status:'detected',affectedResourceType:'interview',affectedResourceId:interview.id,summary:'Interview recovery expired before a different time was saved. Review the interview and replace its latest availability request.',detectedAt:new Date()});
   await appendWorkflowEvent(tx,item.ownerId,'interview.recovery_expired',item.groupId,1,{incidentId:id,interviewId:interview.id,candidateResponded:rows.some(r=>r.participant==='candidate'&&r.status==='submitted'),interviewerResponded:rows.some(r=>r.participant==='interviewer'&&r.status==='submitted')});
   await recordAudit({ownerId:item.ownerId,actorType:'cron',action:'interview.recovery_deadline_escalated',resourceType:'interview',resourceId:interview.id,metadata:{incidentId:id,groupId:item.groupId}},tx);return 'escalated';
  });if(result==='escalated')escalated++;else skipped++;
 }
 return {scanned:due.length,escalated,skipped};
}
