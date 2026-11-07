import {and,eq,inArray} from 'drizzle-orm';
import {automationQueue,emailDispatches,incidents,workspaceSettings} from '../../drizzle/schema';
import {createId,recordAudit} from '../db';
import {withWorkspaceTransaction} from './database';
import {appendWorkflowEvent,cancelUnusedEmailDispatch,workflowHash} from './workflowStore';
import {stopRelatedFollowUps} from './followups';
import {reviewEvent,reviewRequest,reviewScope} from './candidateReviewState';
export async function scheduleCandidateReviewDeadline(tx:any,ownerId:number,id:string,kind:'expiry'|'review',revision:number,at:Date){
 const key=`candidate_review_deadline:${id}:${kind}:${revision}`;
 const existing=(await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.idempotencyKey,key))).limit(1))[0];
 if(!existing)await tx.insert(automationQueue).values({id:createId('que_'),ownerId,jobType:'candidate_review_deadline',status:'queued',scheduledAt:at,priority:15,maxAttempts:3,idempotencyKey:key,payload:{inviteId:id,kind,responseRevision:revision}});
}
export async function resolveCandidateReviewIncidents(tx:any,ownerId:number,id:string,reason:string){
 await tx.update(incidents).set({status:'resolved',resolvedAt:new Date(),containmentNotes:reason}).where(and(eq(incidents.ownerId,ownerId),eq(incidents.affectedResourceType,'candidate_review'),eq(incidents.affectedResourceId,id),inArray(incidents.status,['detected','triaged','contained','investigated'])));
}
export async function stopCandidateReviewWork(tx:any,ownerId:number,id:string,reason:string,completed=false,finish=false){
 await stopRelatedFollowUps(tx,ownerId,{resourceType:'candidate_review',resourceId:id},reason,completed?'completed':'cancelled');
 const mail=await reviewEvent(tx,ownerId,'candidate.review_email_requested',id);
 if(mail){const dispatch=(await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId,ownerId),eq(emailDispatches.messageId,String(mail.metadata.messageId)))).limit(1))[0];if(dispatch)await cancelUnusedEmailDispatch(tx,ownerId,dispatch,reason);}
 if(finish){const tasks=await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.jobType,'candidate_review_deadline'),inArray(automationQueue.status,['queued','retryable_failed','blocked'])));for(const task of tasks)if(task.payload?.inviteId===id)await tx.update(automationQueue).set({status:'cancelled',lockToken:null,lockedAt:null,lastError:reason}).where(eq(automationQueue.id,task.id));}
}
/** Internal deadlines share the physical worker queue; they never send recipient messages. */
export async function executeCandidateReviewDeadline(ownerId:number,raw:any){
 const id=raw?.inviteId,kind=raw?.kind,revision=raw?.responseRevision;
 if(typeof id!=='string'||!['expiry','review'].includes(kind)||!Number.isInteger(revision)||revision<0)throw Error('Invalid candidate review deadline.');
 return withWorkspaceTransaction(ownerId,async tx=>{
  const settings=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0];
  if(!settings?.backgroundEnabled||settings.emergencyStop)return {status:'deferred',nextActionAt:new Date(Date.now()+60000)};
  const r=await reviewRequest(tx,ownerId,id),response=await reviewEvent(tx,ownerId,'candidate.review_responded',id),a=await reviewEvent(tx,ownerId,'candidate.review_authority',id);
  const eventType='candidate.review_deadline_'+kind;
  const prior=await reviewEvent(tx,ownerId,eventType,id);
  if(prior&&(kind==='expiry'||prior.revision===revision))return {status:'skipped'};
  if(await reviewEvent(tx,ownerId,'candidate.review_adopted',id)||await reviewEvent(tx,ownerId,'candidate.review_completed',id)||await reviewEvent(tx,ownerId,'candidate.review_clarified',id))return {status:'skipped'};
  if(kind==='review'&&(!response||response.revision!==revision))return {status:'skipped'};
  if(kind==='expiry'&&!a?.metadata.tokenHash)return {status:'skipped'};
  const due=kind==='expiry'?new Date(r.metadata.expiresAt):new Date(new Date(response.metadata.receivedAt).getTime()+24*3600000);
  if(due>new Date())return {status:'deferred',nextActionAt:due};
  let current=true;try{await reviewScope(tx,ownerId,r,true);}catch(e){if(!(e instanceof Error)||!('code' in e))throw e;current=false;}
  if(kind==='expiry'&&a?.metadata.tokenHash)await appendWorkflowEvent(tx,ownerId,'candidate.review_authority',id,a.revision+1,{candidateId:r.metadata.candidateId,tokenHash:'',revoked:true,reason:'Private review expired'});
  await stopCandidateReviewWork(tx,ownerId,id,kind==='expiry'?'Private review expired.':'Candidate response needs owner review.',Boolean(response),!current);
  let incidentId:string|null=null;
  if(current&&(kind==='review'||!response)){
   incidentId=workflowHash(['candidate.review.deadline',ownerId,id,kind]).slice(0,36);
   const old=(await tx.select().from(incidents).where(and(eq(incidents.ownerId,ownerId),eq(incidents.id,incidentId))).limit(1))[0];
   const summary=kind==='review'?'Candidate response is awaiting owner evidence review. Review the latest response; no hiring decision was made.':'Candidate evidence request expired without a response. Review communication permission and issue a fresh request if appropriate.';
   if(old)await tx.update(incidents).set({status:'detected',resolvedAt:null,summary}).where(eq(incidents.id,incidentId));
   else await tx.insert(incidents).values({id:incidentId,ownerId,incidentType:kind==='review'?'candidate_review_overdue':'candidate_review_expired',severity:'medium',status:'detected',affectedResourceType:'candidate_review',affectedResourceId:id,summary,detectedAt:new Date()});
  }else await resolveCandidateReviewIncidents(tx,ownerId,id,'Candidate review source changed or candidate answered.');
  await appendWorkflowEvent(tx,ownerId,eventType,id,kind==='expiry'?1:revision,{candidateId:r.metadata.candidateId,incidentId,current,responseRevision:response?.revision??0});
  await recordAudit({ownerId,actorType:'cron',action:'candidate.review_deadline_processed',resourceType:'candidate_review',resourceId:id,metadata:{kind,incidentId,current}},tx);
  return {status:incidentId?'escalated':'closed',incidentId};
 });
}
