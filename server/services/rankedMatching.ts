import {TRPCError} from '@trpc/server';
import {and,asc,desc,eq,like} from 'drizzle-orm';
import {automationQueue,candidates,jobs,workflowEvents} from '../../drizzle/schema';
import {createId,recordAudit} from '../db';
import {jobRequirementFingerprint} from './jobIntake';
import {MAX_AI_INPUT_CHARS} from './openrouter';
import {withWorkspaceTransaction} from './database';
import {buildMatchContext,MATCH_POLICY} from './matchContext';
import {candidateSuppressed} from './candidateEvidence';
import {appendWorkflowEvent,workflowHash} from './workflowStore';

export async function queueMatchInTransaction(tx:any,ownerId:number,actorId:number,candidateId:string,jobId:string,automated=false,refreshRevision?:number){
 const context=await buildMatchContext(tx,ownerId,candidateId,jobId);
 if(!context.canQueueAi)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Current candidate processing consent and an open candidate-job match are required before AI scoring.'});
 const payload=refreshRevision?{...context.payload,rankingRefreshAuthority:{jobId,revision:refreshRevision}}:context.payload;
 if(JSON.stringify(payload).length>MAX_AI_INPUT_CHARS)throw new TRPCError({code:'BAD_REQUEST',message:'Matching context exceeds the provider input limit. Review and compact the requirement/evidence before requesting AI; ranked review remains available.'});
 const key='score_match:'+workflowHash([ownerId,context.payload]);
 const prior=(await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.idempotencyKey,key))).limit(1))[0];
 if(prior){
  if(!automated&&!prior.result&&['cancelled','blocked','permanently_failed'].includes(prior.status)){
   await tx.update(automationQueue).set({status:'queued',attempts:0,scheduledAt:new Date(),lastError:null,lockToken:null,lockedAt:null,completedAt:null,payload:context.payload}).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.id,prior.id)));
   await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'match.score_requeued',resourceType:'candidate',resourceId:candidateId,metadata:{jobId,queueId:prior.id,previousState:prior.status}},tx);
   return {queueId:prior.id as string,alreadyQueued:true,status:'queued'};
  }
  return {queueId:prior.id as string,alreadyQueued:true,status:prior.status as string};
 }
 const id=createId('que_');await tx.insert(automationQueue).values({id,ownerId,jobType:'score_match',status:'queued',attempts:0,payload,idempotencyKey:key,priority:2,scheduledAt:new Date(),maxAttempts:3});
 await recordAudit({ownerId,actorType:automated?'system':'user',actorId:automated?'rank_refresh':String(actorId),action:'match.score_queued',resourceType:'candidate',resourceId:candidateId,metadata:{jobId,queueId:id,policy:MATCH_POLICY}},tx);
 return {queueId:id,alreadyQueued:false,status:'queued'};
}
export async function queueCurrentMatch(ownerId:number,actorId:number,input:{candidateId:string;jobId:string}){return withWorkspaceTransaction(ownerId,tx=>queueMatchInTransaction(tx,ownerId,actorId,input.candidateId,input.jobId));}
export const MAX_GLOBAL_CANDIDATES=1000;
export type PoolInput={jobId:string;offset:number;scanLimit:number;query?:string;scope?:'page'|'global'};
export async function rankedPoolInTransaction(tx:any,ownerId:number,input:PoolInput){
 const job=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,input.jobId))).limit(1))[0];
 if(!job)throw new TRPCError({code:'NOT_FOUND',message:'Job was not found.'});
 if(['cancelled','filled','archived'].includes(job.pipelineState))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Closed requirements cannot produce new matching work.'});
 const filters=[eq(candidates.ownerId,ownerId)];if(input.query)filters.push(like(candidates.fullName,'%'+input.query.replace(/[\\%_]/g,'\\$&')+'%'));
 const global=input.scope==='global',bound=global?MAX_GLOBAL_CANDIDATES:input.scanLimit;
 const rows=await tx.select().from(candidates).where(and(...filters)).orderBy(asc(candidates.id)).offset(global?0:input.offset).limit(bound+1);
 if(global&&rows.length>bound)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Global review supports up to 1000 matching owned profiles. Narrow the name filter or use inspected-page review; no records were silently omitted.'});
 const result:any[]=[];let suppressed=0;
 for(const c of rows.slice(0,bound)){if(candidateSuppressed(c)){suppressed++;continue;}const ctx=await buildMatchContext(tx,ownerId,c.id,input.jobId);result.push({candidateId:c.id,name:c.fullName,headline:c.headline,candidateFingerprint:ctx.candidateFingerprint,evidenceRevision:ctx.evidence.revision,fresh:ctx.evidence.fresh,processingConsent:ctx.processingConsent,canQueueAi:ctx.canQueueAi,...ctx.assessment});}
 result.sort((a,b)=>a.reviewPriority===b.reviewPriority?a.candidateId.localeCompare(b.candidateId):b.reviewPriority-a.reviewPriority);
 const display=global?result.slice(input.offset,input.offset+input.scanLimit):result;
 const covered={scope:global?'global':'page',fullyInspected:global||(input.offset===0&&rows.length<=bound),scanned:Math.min(rows.length,bound),reviewable:result.length,suppressed,hasMore:global?input.offset+input.scanLimit<result.length:rows.length>bound,nextOffset:global?(input.offset+input.scanLimit<result.length?input.offset+input.scanLimit:null):(rows.length>bound?input.offset+input.scanLimit:null),offset:input.offset,scanLimit:input.scanLimit};
 const datasetHash=workflowHash({policy:MATCH_POLICY,jobId:job.id,requirement:jobRequirementFingerprint(job),state:job.pipelineState,scope:global?'global':'page',query:input.query??null,offset:global?0:input.offset,rows:result,scanned:covered.scanned,suppressed});
 const previewHash=workflowHash({datasetHash,offset:input.offset,scanLimit:input.scanLimit});
 return {jobId:job.id,jobState:job.pipelineState,policy:MATCH_POLICY,previewHash,datasetHash,coverage:covered,rows:display,allRows:result,automaticRejection:false as const,sourcingAuthorized:false as const};
}
const publicPool=({allRows,...p}:Awaited<ReturnType<typeof rankedPoolInTransaction>>)=>p;
export async function savePoolSnapshotInTransaction(tx:any,ownerId:number,actorId:number,current:Awaited<ReturnType<typeof rankedPoolInTransaction>>,automated=false){
 const identity=current.coverage.scope==='global'?current.datasetHash:current.previewHash;
 const snapshotKey=workflowHash(['match.pool_ranked',current.jobId,1,identity]);
 const prior=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventKey,snapshotKey))).limit(1))[0];
 if(!prior){await appendWorkflowEvent(tx,ownerId,'match.pool_ranked',current.jobId,1,{previewHash:current.previewHash,datasetHash:current.datasetHash,policy:MATCH_POLICY,coverage:{...current.coverage,offset:current.coverage.scope==='global'?0:current.coverage.offset},rows:current.allRows.map(({name,headline,...r})=>r),actorId,automated,finalDisposition:false},identity);await recordAudit({ownerId,actorType:automated?'system':'user',actorId:automated?'rank_refresh':String(actorId),action:'match.pool_ranked',resourceType:'job',resourceId:current.jobId,metadata:{previewHash:current.previewHash,datasetHash:current.datasetHash,coverage:current.coverage,authorizedBy:actorId}},tx);}
 return {snapshotId:snapshotKey,alreadySaved:Boolean(prior)};
}
export async function previewRankedPool(ownerId:number,input:PoolInput){return withWorkspaceTransaction(ownerId,async tx=>publicPool(await rankedPoolInTransaction(tx,ownerId,input)));}
export async function actOnRankedPool(ownerId:number,actorId:number,input:PoolInput&{expectedPreviewHash:string;candidateIds:string[];queueAi:boolean}){
 return withWorkspaceTransaction(ownerId,async tx=>{
  const current=await rankedPoolInTransaction(tx,ownerId,{jobId:input.jobId,offset:input.offset,scanLimit:input.scanLimit,query:input.query,scope:input.scope});
  if(current.previewHash!==input.expectedPreviewHash)throw new TRPCError({code:'CONFLICT',message:'Ranked pool changed. Refresh before saving or queuing scores.'});
  const ids=[...new Set(input.candidateIds)].sort();if(input.queueAi&&!ids.length)throw new TRPCError({code:'BAD_REQUEST',message:'Select candidates for AI scoring.'});
  if(ids.some(id=>!current.rows.some(r=>r.candidateId===id)))throw new TRPCError({code:'BAD_REQUEST',message:'Selected candidate is outside this inspected pool.'});
  const snapshot=await savePoolSnapshotInTransaction(tx,ownerId,actorId,current);
  const queued=[];if(input.queueAi)for(const id of ids)queued.push(await queueMatchInTransaction(tx,ownerId,actorId,id,input.jobId));
  return {...snapshot,queued};
 });
}
export async function listRankedSnapshots(ownerId:number,jobId:string){return withWorkspaceTransaction(ownerId,async tx=>{if(!(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,jobId))).limit(1))[0])throw new TRPCError({code:'NOT_FOUND',message:'Job was not found.'});const rows=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'match.pool_ranked'),eq(workflowEvents.aggregateId,jobId))).orderBy(desc(workflowEvents.createdAt),desc(workflowEvents.id)).limit(5);return rows.map((r:any)=>({snapshotId:r.eventKey,createdAt:r.createdAt,previewHash:r.metadata.previewHash,coverage:r.metadata.coverage,policy:r.metadata.policy}));});}
