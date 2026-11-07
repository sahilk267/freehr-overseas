import {and,desc,eq} from 'drizzle-orm';
import {matches,workflowEvents,consents} from '../../drizzle/schema';
import {appendWorkflowEvent} from './workflowStore';
export async function invalidateCandidateMatches(tx:any,ownerId:number,candidateId:string,reason:string,jobId?:string){
 const rows=await tx.select().from(matches).where(and(eq(matches.ownerId,ownerId),eq(matches.candidateId,candidateId),...(jobId?[eq(matches.jobId,jobId)]:[])));
 let count=0;
 for(const m of rows)if(['candidate_found','low_confidence','evidence_validated','shortlisted'].includes(m.status)){await tx.update(matches).set({lowConfidence:true,status:m.status==='shortlisted'?m.status:'low_confidence',missingEvidence:[...new Set([...(Array.isArray(m.missingEvidence)?m.missingEvidence:[]),reason])]}).where(and(eq(matches.ownerId,ownerId),eq(matches.id,m.id)));count++;}
 return count;
}
export async function recordCandidateDocumentChange(tx:any,ownerId:number,candidateId:string,metadata:Record<string,unknown>){
 const previous=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,candidateId),eq(workflowEvents.eventType,'candidate.document_changed'))).orderBy(desc(workflowEvents.revision)).limit(1))[0];
 const revision=(previous?.revision??0)+1;
 await appendWorkflowEvent(tx,ownerId,'candidate.document_changed',candidateId,revision,metadata);
 const invalidated=await invalidateCandidateMatches(tx,ownerId,candidateId,'Candidate document evidence changed to version '+revision+'; review current sources.');
 return {revision,invalidated};
}

export async function hasGeneralCandidateProcessingConsent(tx:any,ownerId:number,candidateId:string){
 const grants=await tx.select().from(consents).where(and(eq(consents.ownerId,ownerId),eq(consents.candidateId,candidateId),eq(consents.status,'granted')));
 return grants.some((c:any)=>['platform_processing','recruitment_communication'].includes(c.consentType)&&!c.jobId&&!c.companyId&&(!c.expiresAt||new Date(c.expiresAt)>new Date()));
}
