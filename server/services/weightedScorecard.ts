import {invalidateCandidateMatches} from './candidateEvidenceLifecycle';
import {TRPCError} from '@trpc/server';
import {and,desc,eq} from 'drizzle-orm';
import {jobs,workflowEvents} from '../../drizzle/schema';
import {calculateWeightedScorecard,weightedScorecardInput,criterionRatingSchema} from '../../shared/weightedScorecard';
import {recordAudit} from '../db';
import {ensureSafeAiText} from '../workflow';
import {candidateEvidenceInTransaction} from './candidateEvidence';
import {candidateReviewOwnerRecords} from './candidateReview';
import {withWorkspaceTransaction} from './database';
import {jobRequirementFingerprint} from './jobIntake';
import {appendWorkflowEvent,workflowHash} from './workflowStore';
const norm=(s:string)=>s.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const identity=(candidateId:string,jobId:string)=>workflowHash([candidateId,jobId]);
async function source(tx:any,ownerId:number,job:any,evidence:any,r:ReturnType<typeof criterionRatingSchema.parse>){
 if(r.score===null)return {sourceHash:null};
 if(!r.source)throw new TRPCError({code:'BAD_REQUEST',message:'Each rated criterion needs a source and supporting quote.'});
 let body='';
 if(r.source.kind==='profile')body=JSON.stringify(evidence.fields??{});
 else if(r.source.kind==='parsed_document'){const documentId=r.source.documentId,d=evidence.documents.find((d:any)=>d.documentId===documentId);if(!d?.parsedData||d.supersededBy||d.scanState!=='clean'||d.parseState!=='parsed')throw new TRPCError({code:'PRECONDITION_FAILED',message:'A current owned clean parsed source document is required.'});body=JSON.stringify(d.parsedData);}
 else if(r.source.kind==='candidate_response'){const found=await candidateReviewOwnerRecords(tx,ownerId,r.source.inviteId);if(found.request.metadata.candidateId!==evidence.candidateId||found.request.metadata.jobId!==job.id||found.request.metadata.requirementFingerprint!==jobRequirementFingerprint(job)||found.response?.revision!==r.source.responseRevision)throw new TRPCError({code:'CONFLICT',message:'Candidate response source changed or belongs to another case.'});body=found.response.metadata.answers[r.source.questionId]??'';}
 else body=r.source.observation;
 if(!norm(body).includes(norm(r.source.quote)))throw new TRPCError({code:'BAD_REQUEST',message:'Supporting quote is absent from its selected source.'});
 ensureSafeAiText(r.source.quote);
 return {sourceHash:workflowHash(body)};
}
export async function weightedScorecardInTransaction(tx:any,ownerId:number,job:any,evidence:any){
 const id=identity(evidence.candidateId,job.id),row=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'match.scorecard_assessed'),eq(workflowEvents.aggregateId,id))).orderBy(desc(workflowEvents.revision)).limit(1))[0];
 const criteria=(Array.isArray(job.scorecard)?job.scorecard:[]) as {criterion:string;weight:number;required?:boolean}[];
 let current=Boolean(row&&row.metadata.candidateFingerprint===evidence.fingerprint&&row.metadata.requirementFingerprint===jobRequirementFingerprint(job)),sourceCurrent=true;
 if(row){for(const r of row.metadata.ratings){try{const now=await source(tx,ownerId,job,evidence,r);if(now.sourceHash!==r.sourceHash)sourceCurrent=false;}catch{sourceCurrent=false;}}}
 current=current&&sourceCurrent;
 let result:ReturnType<typeof calculateWeightedScorecard>|null=null;try{result=calculateWeightedScorecard(criteria,current?row.metadata.ratings:[]);}catch{}
 return {revision:row?.revision??0,current,sourceCurrent,criteria,result,ratings:row?.metadata.ratings??[],reason:row?.metadata.reason??null,signature:row?workflowHash({eventKey:row.eventKey,current,sourceCurrent,metadata:row.metadata}):null,candidateFingerprint:evidence.fingerprint,requirementFingerprint:jobRequirementFingerprint(job),independentlyVerified:false as const};
}
export async function getWeightedScorecard(ownerId:number,candidateId:string,jobId:string){return withWorkspaceTransaction(ownerId,async tx=>{const job=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,jobId))).limit(1))[0];if(!job)throw new TRPCError({code:'NOT_FOUND',message:'Requirement was not found.'});const d=await candidateEvidenceInTransaction(tx,ownerId,candidateId);return weightedScorecardInTransaction(tx,ownerId,job,d);});}
export async function saveWeightedScorecard(ownerId:number,actorId:number,raw:Parameters<typeof weightedScorecardInput.parse>[0]){
 const input=weightedScorecardInput.parse(raw),requestHash=workflowHash(input);
 return withWorkspaceTransaction(ownerId,async tx=>{
  const job=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,input.jobId))).limit(1))[0];if(!job)throw new TRPCError({code:'NOT_FOUND',message:'Requirement was not found.'});
  const d=await candidateEvidenceInTransaction(tx,ownerId,input.candidateId),previous=await weightedScorecardInTransaction(tx,ownerId,job,d),id=identity(input.candidateId,input.jobId);
  const prior=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'match.scorecard_assessed'),eq(workflowEvents.aggregateId,id),eq(workflowEvents.revision,input.expectedRevision+1))).limit(1))[0];
  if(prior?.metadata.requestHash===requestHash)return {revision:prior.revision,alreadySaved:true};
  if(previous.revision!==input.expectedRevision||d.fingerprint!==input.expectedCandidateFingerprint||jobRequirementFingerprint(job)!==input.expectedRequirementFingerprint)throw new TRPCError({code:'CONFLICT',message:'Criteria or candidate evidence changed. Reload the scorecard.'});
  if(d.suppressed||['cancelled','filled','archived'].includes(job.pipelineState))throw new TRPCError({code:'PRECONDITION_FAILED',message:'A current candidate and open role are required.'});
  let result;try{result=calculateWeightedScorecard(previous.criteria,input.ratings);}catch(e){throw new TRPCError({code:'BAD_REQUEST',message:(e as Error).message});}
  const ratings=[];for(const r of input.ratings)ratings.push({...r,...await source(tx,ownerId,job,d,r)});
  await appendWorkflowEvent(tx,ownerId,'match.scorecard_assessed',id,previous.revision+1,{candidateId:input.candidateId,jobId:input.jobId,candidateFingerprint:d.fingerprint,requirementFingerprint:jobRequirementFingerprint(job),ratings,result,reason:input.reason,requestHash,actorId,independentlyVerified:false});
  await invalidateCandidateMatches(tx,ownerId,input.candidateId,'Employer scorecard was reviewed; reassess this candidate/job score.',input.jobId);
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'match.scorecard_assessed',resourceType:'candidate',resourceId:input.candidateId,metadata:{jobId:input.jobId,revision:previous.revision+1,assessedWeight:result.assessedWeight}},tx);
  return {revision:previous.revision+1,alreadySaved:false};
 });
}
