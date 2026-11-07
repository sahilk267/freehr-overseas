import {TRPCError} from '@trpc/server';
import {and,desc,eq} from 'drizzle-orm';
import {jobs,workflowEvents} from '../../drizzle/schema';
import {candidateEvidenceInTransaction} from './candidateEvidence';
import {jobRequirementFingerprint} from './jobIntake';
import {workflowHash} from './workflowStore';
export const reviewDenied=()=>new TRPCError({code:'UNAUTHORIZED',message:'Candidate review link is invalid, expired or unavailable.'});
export const reviewEvent=async(tx:any,ownerId:number,type:string,id:string)=>(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,type),eq(workflowEvents.aggregateId,id))).orderBy(desc(workflowEvents.revision)).limit(1))[0];
export async function reviewRequest(tx:any,ownerId:number,id:string){const row=await reviewEvent(tx,ownerId,'candidate.review_invited',id);if(!row?.metadata?.candidateId)throw reviewDenied();return row;}
export async function reviewScope(tx:any,ownerId:number,r:any,allowExpired=false,now=new Date()){
 const d=await candidateEvidenceInTransaction(tx,ownerId,r.metadata.candidateId),j=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,r.metadata.jobId))).limit(1))[0];
 if(d.suppressed||!j||['cancelled','filled','archived','paused'].includes(j.pipelineState)||d.fingerprint!==r.metadata.candidateFingerprint||jobRequirementFingerprint(j)!==r.metadata.requirementFingerprint||!allowExpired&&new Date(r.metadata.expiresAt)<=now)throw reviewDenied();return {d,j};
}
export async function candidateReviewFollowupState(tx:any,ownerId:number,id:string,now=new Date()){
 const r=await reviewRequest(tx,ownerId,id);
 if(await reviewEvent(tx,ownerId,'candidate.review_responded',id))return {state:'completed' as const,reason:'Candidate answered the private review.'};
 const a=await reviewEvent(tx,ownerId,'candidate.review_authority',id);
 if(!a?.metadata.tokenHash)return {state:'cancelled' as const,reason:'Private candidate review was revoked.'};
 try{await reviewScope(tx,ownerId,r,false,now);}catch(e){if(!(e instanceof TRPCError))throw e;return {state:'cancelled' as const,reason:'Candidate review source or deadline changed.'};}
 return {state:'eligible' as const,candidateId:r.metadata.candidateId,jobId:r.metadata.jobId,expiresAt:new Date(r.metadata.expiresAt),fingerprint:workflowHash([id,r.metadata.candidateFingerprint,r.metadata.requirementFingerprint,a.revision,a.metadata.tokenHash])};
}
