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

export async function queueMatchInTransaction(tx:any,ownerId:number,actorId:number,candidateId:string,jobId:string){
 const context=await buildMatchContext(tx,ownerId,candidateId,jobId);
 if(!context.canQueueAi)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Current candidate processing consent and an open candidate-job match are required before AI scoring.'});
 if(JSON.stringify(context.payload).length>MAX_AI_INPUT_CHARS)throw new TRPCError({code:'BAD_REQUEST',message:'Matching context exceeds the provider input limit. Review and compact the requirement/evidence before requesting AI; ranked review remains available.'});
 const key='score_match:'+workflowHash([ownerId,context.payload]);
 const prior=(await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.idempotencyKey,key))).limit(1))[0];
 if(prior)return {queueId:prior.id as string,alreadyQueued:true,status:prior.status as string};
 const id=createId('que_');await tx.insert(automationQueue).values({id,ownerId,jobType:'score_match',status:'queued',attempts:0,payload:context.payload,idempotencyKey:key,priority:2,scheduledAt:new Date(),maxAttempts:3});
 await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'match.score_queued',resourceType:'candidate',resourceId:candidateId,metadata:{jobId,queueId:id,policy:MATCH_POLICY}},tx);
 return {queueId:id,alreadyQueued:false,status:'queued'};
}
export async function queueCurrentMatch(ownerId:number,actorId:number,input:{candidateId:string;jobId:string}){return withWorkspaceTransaction(ownerId,tx=>queueMatchInTransaction(tx,ownerId,actorId,input.candidateId,input.jobId));}
export type PoolInput={jobId:string;offset:number;scanLimit:number;query?:string};
async function pool(tx:any,ownerId:number,input:PoolInput){
 const job=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,input.jobId))).limit(1))[0];
 if(!job)throw new TRPCError({code:'NOT_FOUND',message:'Job was not found.'});
 if(['cancelled','filled','archived'].includes(job.pipelineState))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Closed requirements cannot produce new matching work.'});
 const filters=[eq(candidates.ownerId,ownerId)];if(input.query)filters.push(like(candidates.fullName,'%'+input.query.replace(/[\\%_]/g,'\\$&')+'%'));
 const rows=await tx.select().from(candidates).where(and(...filters)).orderBy(asc(candidates.id)).offset(input.offset).limit(input.scanLimit+1);
 const result:any[]=[];let suppressed=0;
 for(const c of rows.slice(0,input.scanLimit)){if(candidateSuppressed(c)){suppressed++;continue;}const ctx=await buildMatchContext(tx,ownerId,c.id,input.jobId);result.push({candidateId:c.id,name:c.fullName,headline:c.headline,candidateFingerprint:ctx.candidateFingerprint,evidenceRevision:ctx.evidence.revision,fresh:ctx.evidence.fresh,processingConsent:ctx.processingConsent,canQueueAi:ctx.canQueueAi,...ctx.assessment});}
 result.sort((a,b)=>a.reviewPriority===b.reviewPriority?a.candidateId.localeCompare(b.candidateId):b.reviewPriority-a.reviewPriority);
 const covered={scanned:Math.min(rows.length,input.scanLimit),suppressed,hasMore:rows.length>input.scanLimit,nextOffset:rows.length>input.scanLimit?input.offset+input.scanLimit:null,offset:input.offset,scanLimit:input.scanLimit};
 const previewHash=workflowHash({policy:MATCH_POLICY,jobId:job.id,requirement:jobRequirementFingerprint(job),state:job.pipelineState,input,covered,rows:result});
 return {jobId:job.id,jobState:job.pipelineState,policy:MATCH_POLICY,previewHash,coverage:covered,rows:result,automaticRejection:false as const,sourcingAuthorized:false as const};
}
export async function previewRankedPool(ownerId:number,input:PoolInput){return withWorkspaceTransaction(ownerId,tx=>pool(tx,ownerId,input));}
export async function actOnRankedPool(ownerId:number,actorId:number,input:PoolInput&{expectedPreviewHash:string;candidateIds:string[];queueAi:boolean}){
 return withWorkspaceTransaction(ownerId,async tx=>{
  const current=await pool(tx,ownerId,{jobId:input.jobId,offset:input.offset,scanLimit:input.scanLimit,query:input.query});
  if(current.previewHash!==input.expectedPreviewHash)throw new TRPCError({code:'CONFLICT',message:'Ranked pool changed. Refresh before saving or queuing scores.'});
  const ids=[...new Set(input.candidateIds)].sort();if(input.queueAi&&!ids.length)throw new TRPCError({code:'BAD_REQUEST',message:'Select candidates for AI scoring.'});
  if(ids.some(id=>!current.rows.some(r=>r.candidateId===id)))throw new TRPCError({code:'BAD_REQUEST',message:'Selected candidate is outside this inspected pool.'});
  const snapshotKey=workflowHash(['match.pool_ranked',input.jobId,1,current.previewHash]);
  const prior=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventKey,snapshotKey))).limit(1))[0];
  if(!prior){await appendWorkflowEvent(tx,ownerId,'match.pool_ranked',input.jobId,1,{previewHash:current.previewHash,policy:MATCH_POLICY,coverage:current.coverage,rows:current.rows.map(({name,headline,...r})=>r),actorId,finalDisposition:false},current.previewHash);await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'match.pool_ranked',resourceType:'job',resourceId:input.jobId,metadata:{previewHash:current.previewHash,coverage:current.coverage}},tx);}
  const queued=[];if(input.queueAi)for(const id of ids)queued.push(await queueMatchInTransaction(tx,ownerId,actorId,id,input.jobId));
  return {snapshotId:snapshotKey,alreadySaved:Boolean(prior),queued};
 });
}
export async function listRankedSnapshots(ownerId:number,jobId:string){return withWorkspaceTransaction(ownerId,async tx=>{if(!(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,jobId))).limit(1))[0])throw new TRPCError({code:'NOT_FOUND',message:'Job was not found.'});const rows=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'match.pool_ranked'),eq(workflowEvents.aggregateId,jobId))).orderBy(desc(workflowEvents.createdAt),desc(workflowEvents.id)).limit(5);return rows.map((r:any)=>({snapshotId:r.eventKey,createdAt:r.createdAt,previewHash:r.metadata.previewHash,coverage:r.metadata.coverage,policy:r.metadata.policy}));});}
