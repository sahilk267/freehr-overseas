import {TRPCError} from '@trpc/server';
import {and,asc,eq,like,notInArray} from 'drizzle-orm';
import {jobs,workflowEvents} from '../../drizzle/schema';
import {recordAudit} from '../db';
import {withWorkspaceTransaction} from './database';
import {candidateEvidenceInTransaction} from './candidateEvidence';
import {buildMatchContext,MATCH_POLICY} from './matchContext';
import {queueMatchInTransaction} from './rankedMatching';
import {appendWorkflowEvent,workflowHash} from './workflowStore';

export const MAX_CANDIDATE_JOBS=500;
export type CandidateJobsInput={candidateId:string;query?:string;offset:number;limit:number};
async function rank(tx:any,ownerId:number,input:CandidateJobsInput){
 const candidate=await candidateEvidenceInTransaction(tx,ownerId,input.candidateId);
 if(candidate.suppressed)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Suppressed candidate profiles cannot be ranked for jobs.'});
 const filters=[eq(jobs.ownerId,ownerId),notInArray(jobs.pipelineState,['cancelled','filled','archived'])];
 if(input.query)filters.push(like(jobs.title,'%'+input.query.replace(/[\\%_]/g,'\\$&')+'%'));
 const records=await tx.select().from(jobs).where(and(...filters)).orderBy(asc(jobs.id)).limit(MAX_CANDIDATE_JOBS+1);
 if(records.length>MAX_CANDIDATE_JOBS)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Candidate job ranking supports up to 500 matching open requirements. Narrow the title filter; no requirements were silently omitted.'});
 const rows=[];
 for(const job of records){const c=await buildMatchContext(tx,ownerId,input.candidateId,job.id);rows.push({jobId:job.id,title:job.title,jobState:job.pipelineState,requirementFingerprint:c.requirementFingerprint,candidateFingerprint:c.candidateFingerprint,canQueueAi:c.canQueueAi,...c.assessment});}
 rows.sort((a,b)=>a.reviewPriority===b.reviewPriority?a.jobId.localeCompare(b.jobId):b.reviewPriority-a.reviewPriority);
 const datasetHash=workflowHash({candidateId:input.candidateId,candidateFingerprint:candidate.fingerprint,policy:MATCH_POLICY,query:input.query??null,rows});
 return {candidateId:input.candidateId,policy:MATCH_POLICY,datasetHash,previewHash:workflowHash({datasetHash,offset:input.offset,limit:input.limit}),coverage:{fullyInspected:true,scanned:rows.length,offset:input.offset,limit:input.limit,hasMore:input.offset+input.limit<rows.length,nextOffset:input.offset+input.limit<rows.length?input.offset+input.limit:null},rows:rows.slice(input.offset,input.offset+input.limit),allRows:rows,automaticRejection:false,sourcingAuthorized:false};
}
export async function previewCandidateJobs(ownerId:number,input:CandidateJobsInput){return withWorkspaceTransaction(ownerId,async tx=>{const {allRows,...result}=await rank(tx,ownerId,input);return result;});}
export async function actOnCandidateJobs(ownerId:number,actorId:number,input:CandidateJobsInput&{expectedPreviewHash:string;jobIds:string[];queueAi:boolean}){
 return withWorkspaceTransaction(ownerId,async tx=>{
  const current=await rank(tx,ownerId,input);
  if(current.previewHash!==input.expectedPreviewHash)throw new TRPCError({code:'CONFLICT',message:'Candidate/job ranking changed. Refresh before acting.'});
  const ids=[...new Set(input.jobIds)].sort();
  if(input.queueAi&&!ids.length)throw new TRPCError({code:'BAD_REQUEST',message:'Select jobs for AI scoring.'});
  if(ids.some(id=>!current.rows.some(r=>r.jobId===id)))throw new TRPCError({code:'BAD_REQUEST',message:'A selected requirement is outside this displayed ranking page.'});
  const snapshotId=workflowHash(['match.jobs_ranked',input.candidateId,1,current.datasetHash]);
  const prior=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventKey,snapshotId))).limit(1))[0];
  if(!prior){await appendWorkflowEvent(tx,ownerId,'match.jobs_ranked',input.candidateId,1,{datasetHash:current.datasetHash,policy:MATCH_POLICY,rows:current.allRows.map(({title,...r})=>r),coverage:current.coverage,actorId,finalDisposition:false},current.datasetHash);await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'match.jobs_ranked',resourceType:'candidate',resourceId:input.candidateId,metadata:{datasetHash:current.datasetHash,scanned:current.coverage.scanned}},tx);}
  const queued=[];if(input.queueAi)for(const id of ids)queued.push(await queueMatchInTransaction(tx,ownerId,actorId,input.candidateId,id));
  return {snapshotId,alreadySaved:Boolean(prior),queued};
 });
}
