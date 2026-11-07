import {TRPCError} from '@trpc/server';
import {and,desc,eq,inArray} from 'drizzle-orm';
import {automationQueue,jobs,workflowEvents,workspaceSettings} from '../../drizzle/schema';
import {rankingRefreshInput,type RankingRefreshSettings} from '../../shared/rankingRefresh';
import {createId,recordAudit} from '../db';
import {lockedSelect,withWorkspaceTransaction} from './database';
import {jobRequirementFingerprint} from './jobIntake';
import {rankedPoolInTransaction,savePoolSnapshotInTransaction,queueMatchInTransaction} from './rankedMatching';
import {appendWorkflowEvent,workflowHash} from './workflowStore';

const eventType='match.refresh_configured';
const taskKey=(jobId:string,revision:number,cycle:number)=>`rank-refresh:${jobId}:${revision}:${cycle}`;
async function owned(tx:any,ownerId:number,id:string){const j=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,id))).limit(1))[0];if(!j)throw new TRPCError({code:'NOT_FOUND',message:'Requirement was not found.'});return j;}
const config=async(tx:any,ownerId:number,id:string)=>(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,eventType),eq(workflowEvents.aggregateId,id))).orderBy(desc(workflowEvents.revision)).limit(1))[0];
async function schedule(tx:any,ownerId:number,jobId:string,revision:number,cycle:number,at:Date){
 const key=taskKey(jobId,revision,cycle),prior=(await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.idempotencyKey,key))).limit(1))[0];
 if(!prior)await tx.insert(automationQueue).values({id:createId('que_'),ownerId,jobType:'rank_refresh',status:'queued',scheduledAt:at,attempts:0,maxAttempts:3,priority:0,payload:{jobId,revision,cycle},idempotencyKey:key});
}
export async function getRankingRefresh(ownerId:number,jobId:string){return withWorkspaceTransaction(ownerId,async tx=>{
 const job=await owned(tx,ownerId,jobId),c=await config(tx,ownerId,jobId);
 const stopped=c?(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'match.refresh_stopped'),eq(workflowEvents.aggregateId,jobId),eq(workflowEvents.revision,c.revision))).limit(1))[0]:null;
 const runs=c?await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'match.refresh_ran'),eq(workflowEvents.aggregateId,jobId))).orderBy(desc(workflowEvents.createdAt),desc(workflowEvents.id)).limit(100):[];
 const currentRuns=runs.filter((r:any)=>r.metadata.planRevision===c.revision);
 const tasks=await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.jobType,'rank_refresh'))).orderBy(desc(automationQueue.createdAt));
 const task=tasks.find((t:any)=>t.payload?.jobId===jobId&&t.payload.revision===c?.revision&&['queued','running','retryable_failed','blocked','permanently_failed'].includes(t.status));
 const settings=c?.metadata.settings as RankingRefreshSettings|undefined;
 const sourceChanged=Boolean(c&&(c.metadata.requirementFingerprint!==jobRequirementFingerprint(job)||c.metadata.jobState!==job.pipelineState));
 return {jobId,revision:c?.revision??0,settings:settings??null,effectiveEnabled:Boolean(settings?.enabled&&!stopped&&!sourceChanged&&new Date(settings.expiresAt)>new Date()),sourceChanged,stopReason:stopped?.metadata.reason as string|undefined,runs:currentRuns.map((r:any)=>({cycle:r.revision,...r.metadata})),history:runs.map((r:any)=>({cycle:r.revision,...r.metadata})),newAiTasks:currentRuns.reduce((n:number,r:any)=>n+(r.metadata.newAiTasks??0),0),task:task?{status:task.status,scheduledAt:task.scheduledAt,lastError:task.lastError}:null};
 });}
export async function configureRankingRefresh(ownerId:number,actorId:number,raw:Parameters<typeof rankingRefreshInput.parse>[0]){
 if(ownerId!==actorId)throw new TRPCError({code:'FORBIDDEN',message:'Only the workspace owner can grant unattended ranking authority.'});
 const input=rankingRefreshInput.parse(raw),{jobId,expectedRevision,...settings}=input,requestHash=workflowHash(settings);
 return withWorkspaceTransaction(ownerId,async tx=>{
  const job=await owned(tx,ownerId,jobId),c=await config(tx,ownerId,jobId),revision=c?.revision??0;
  if(revision===expectedRevision+1&&c.metadata.requestHash===requestHash)return {revision,alreadyConfigured:true};
  if(revision!==expectedRevision)throw new TRPCError({code:'CONFLICT',message:'Refresh plan changed. Reload before configuring it.'});
  if(settings.enabled){
   const workspace=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0];
   if(!workspace?.backgroundEnabled||workspace.emergencyStop)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Enable the existing background worker and clear its emergency stop before authorizing refresh.'});
   if(['cancelled','filled','archived'].includes(job.pipelineState))throw new TRPCError({code:'PRECONDITION_FAILED',message:'A closed requirement cannot receive unattended ranking authority.'});
   if(settings.expiresAt<=new Date()||settings.expiresAt.getTime()>Date.now()+30*86400000)throw new TRPCError({code:'BAD_REQUEST',message:'Refresh authority must expire within the next 30 days.'});
   if(settings.queueAi&&settings.maxAiTasks===0)throw new TRPCError({code:'BAD_REQUEST',message:'An explicit positive total AI-task budget is required for unattended scoring.'});
  }
  const tasks=await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.jobType,'rank_refresh')));
  for(const task of tasks)if(task.payload?.jobId===jobId&&['queued','retryable_failed','blocked','permanently_failed'].includes(task.status))await tx.update(automationQueue).set({status:'cancelled',lastError:'Refresh authority changed.',lockToken:null,lockedAt:null}).where(eq(automationQueue.id,task.id));
  const priorRuns=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'match.refresh_ran'),eq(workflowEvents.aggregateId,jobId)));
  const minted=priorRuns.filter((r:any)=>r.metadata.planRevision===revision).flatMap((r:any)=>(r.metadata.tasks??[]).filter((t:any)=>t.alreadyQueued===false).map((t:any)=>t.queueId));
  for(const id of minted)await tx.update(automationQueue).set({status:'cancelled',lastError:'Unattended ranking authority revoked.',lockToken:null,lockedAt:null}).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.id,id),inArray(automationQueue.status,['queued','retryable_failed'])));
  await appendWorkflowEvent(tx,ownerId,eventType,jobId,revision+1,{settings,requestHash,requirementFingerprint:jobRequirementFingerprint(job),jobState:job.pipelineState,authorizedBy:actorId});
  if(settings.enabled)await schedule(tx,ownerId,jobId,revision+1,1,new Date());
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'match.refresh_configured',resourceType:'job',resourceId:jobId,metadata:{revision:revision+1,settings}},tx);
  return {revision:revision+1,alreadyConfigured:false};
 });
}
export async function executeRankingRefresh(ownerId:number,payload:Record<string,unknown>,lease?:{id:string;lockToken:string}){
 const {jobId,revision,cycle}=payload;
 if(typeof jobId!=='string'||!Number.isInteger(revision)||!Number.isInteger(cycle)||Number(revision)<1||Number(cycle)<1||Number(cycle)>100)throw new TRPCError({code:'BAD_REQUEST',message:'Malformed ranking refresh task.'});
 return withWorkspaceTransaction(ownerId,async tx=>{
  if(lease){const row=(await lockedSelect(tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.id,lease.id),eq(automationQueue.lockToken,lease.lockToken),eq(automationQueue.status,'running'))).limit(1)))[0];if(!row)throw new TRPCError({code:'CONFLICT',message:'Refresh task lease was lost.'});}
  const job=await owned(tx,ownerId,jobId),c=await config(tx,ownerId,jobId),s=c?.metadata.settings as RankingRefreshSettings|undefined;
  const workspace=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0];
  if(!workspace?.backgroundEnabled||workspace.emergencyStop)return {status:'deferred',nextActionAt:new Date(Date.now()+60000)};
  const discriminator=String(revision),prior=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventKey,workflowHash(['match.refresh_ran',jobId,cycle,discriminator])))).limit(1))[0];
  if(prior)return {status:'already_recorded',snapshotId:prior.metadata.snapshotId};
  const stopped=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'match.refresh_stopped'),eq(workflowEvents.aggregateId,jobId),eq(workflowEvents.revision,Number(revision)))).limit(1))[0];
  let reason='';
  if(!c||c.revision!==revision||!s?.enabled)reason='Authority was changed or disabled.';
  else if(stopped)reason=String(stopped.metadata.reason);
  else if(new Date(s.expiresAt)<=new Date())reason='Refresh authority expired.';
  else if(c.metadata.requirementFingerprint!==jobRequirementFingerprint(job)||c.metadata.jobState!==job.pipelineState)reason='Requirement version or state changed; owner reauthorization is required.';
  else if(Number(cycle)>s.maxRuns)reason='Maximum refresh runs reached.';
  const stop=async(message:string)=>{await appendWorkflowEvent(tx,ownerId,'match.refresh_stopped',jobId,Number(revision),{reason:message,cycle},'');return {status:'stopped',reason:message};};
  if(reason)return stop(reason);
  // Only the earliest unfinished canonical cycle may run, including direct retries.
  const previous=Number(cycle)>1?(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventKey,workflowHash(['match.refresh_ran',jobId,Number(cycle)-1,discriminator])))).limit(1))[0]:null;
  if(Number(cycle)>1&&!previous)throw new TRPCError({code:'PRECONDITION_FAILED',message:'The previous refresh cycle is not complete.'});
  if(previous&&new Date(previous.metadata.nextAt)>new Date())return {status:'deferred',nextActionAt:new Date(previous.metadata.nextAt)};
  const current=await rankedPoolInTransaction(tx,ownerId,{jobId,offset:0,scanLimit:100,scope:'global',query:s!.query||undefined});
  const snapshot=await savePoolSnapshotInTransaction(tx,ownerId,Number(c!.metadata.authorizedBy),current,true);
  const runs=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'match.refresh_ran'),eq(workflowEvents.aggregateId,jobId)));
  const consumed=runs.filter((r:any)=>r.metadata.planRevision===revision).reduce((n:number,r:any)=>n+(r.metadata.newAiTasks??0),0);
  const tasks:{candidateId:string;status:string;queueId?:string;alreadyQueued?:boolean}[]=[];let newAiTasks=0;
  const existingScores=s!.queueAi?await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.jobType,'score_match'))):[];
  const needsCurrentScore=(r:any)=>!existingScores.some((t:any)=>t.payload?.candidateId===r.candidateId&&t.payload.jobId===jobId&&t.payload.candidateContextFingerprint===r.candidateFingerprint&&t.payload.requirementFingerprint===jobRequirementFingerprint(job)&&t.payload.policy===current.policy);
  if(s!.queueAi&&consumed<s!.maxAiTasks){for(const row of current.allRows.filter(r=>r.canQueueAi&&r.fresh&&r.eligibility==='review_ready'&&r.reviewPriority>=s!.minPriority&&needsCurrentScore(r)).slice(0,Math.min(s!.maxPerRun,s!.maxAiTasks-consumed))){try{const task=await queueMatchInTransaction(tx,ownerId,Number(c!.metadata.authorizedBy),row.candidateId,jobId,true,Number(revision));tasks.push({candidateId:row.candidateId,...task});if(!task.alreadyQueued)newAiTasks++;}catch(e){if(!(e instanceof TRPCError))throw e;tasks.push({candidateId:row.candidateId,status:'skipped_'+e.code});}}}
  const nextAt=new Date(Date.now()+s!.intervalMinutes*60000),finished=Number(cycle)>=s!.maxRuns||nextAt>=new Date(s!.expiresAt);
  await appendWorkflowEvent(tx,ownerId,'match.refresh_ran',jobId,Number(cycle),{planRevision:revision,cycle,snapshotId:snapshot.snapshotId,datasetHash:current.datasetHash,newAiTasks,tasks,scanned:current.coverage.scanned,nextAt:finished?null:nextAt.toISOString()},discriminator);
  await recordAudit({ownerId,actorType:'system',actorId:'rank_refresh',action:'match.refresh_ran',resourceType:'job',resourceId:jobId,metadata:{planRevision:revision,cycle,snapshotId:snapshot.snapshotId,newAiTasks}},tx);
  if(finished)await stop('Refresh run or expiry limit reached.');else await schedule(tx,ownerId,jobId,Number(revision),Number(cycle)+1,nextAt);
  return {status:'refreshed',snapshotId:snapshot.snapshotId,newAiTasks,tasks,nextAt:finished?null:nextAt};
 });
}

export async function assertRankingRefreshAuthority(tx:any,ownerId:number,raw:unknown){
 if(!raw)return;
 const a=raw as {jobId?:string;revision?:number};
 if(typeof a.jobId!=='string'||!Number.isInteger(a.revision))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Ranking refresh authority is malformed.'});
 const j=await owned(tx,ownerId,a.jobId),c=await config(tx,ownerId,a.jobId),s=c?.metadata.settings as RankingRefreshSettings|undefined;
 if(!c||c.revision!==a.revision||!s?.enabled||new Date(s.expiresAt)<=new Date()||c.metadata.requirementFingerprint!==jobRequirementFingerprint(j)||c.metadata.jobState!==j.pipelineState)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Ranking refresh authority expired or changed. Review before requesting a fresh score.'});
}
