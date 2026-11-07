import {invalidateCandidateMatches} from './candidateEvidenceLifecycle';
import {TRPCError} from '@trpc/server';
import {and,desc,eq} from 'drizzle-orm';
import {candidates,candidateDocuments,matches,workflowEvents} from '../../drizzle/schema';
import {candidateEvidenceSaveSchema,type CandidateEvidenceFields} from '../../shared/candidateEvidence';
import {recordAudit} from '../db';
import {ensureSafeAiText} from '../workflow';
import {lockedSelect,withWorkspaceTransaction} from './database';
import {appendWorkflowEvent,workflowHash} from './workflowStore';

export const candidateSuppressed=(r:any)=>Boolean(r.deletedAt||r.withdrawnAt||r.doNotContactAt||['deleted','deletion_pending','withdrawn','do_not_contact'].includes(r.profileState));
export async function candidateEvidenceInTransaction(tx:any,ownerId:number,id:string){
 const r=(await lockedSelect(tx.select().from(candidates).where(and(eq(candidates.ownerId,ownerId),eq(candidates.id,id))).limit(1)))[0];
 if(!r||r.deletedAt||['deleted','deletion_pending'].includes(r.profileState))throw new TRPCError({code:'NOT_FOUND',message:'Candidate was not found.'});
 const latest=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,id),eq(workflowEvents.eventType,'candidate.evidence_saved'))).orderBy(desc(workflowEvents.revision)).limit(1))[0];
 const documents=await tx.select().from(candidateDocuments).where(and(eq(candidateDocuments.ownerId,ownerId),eq(candidateDocuments.candidateId,id))).orderBy(desc(candidateDocuments.createdAt),desc(candidateDocuments.id)).limit(21);
 const fields=latest?.metadata.fields as CandidateEvidenceFields|undefined;
 const fresh=Boolean(fields&&new Date(fields.observedAt)<=new Date()&&new Date(fields.validUntil)>new Date());
 const documentChange=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,id),eq(workflowEvents.eventType,'candidate.document_changed'))).orderBy(desc(workflowEvents.revision)).limit(1))[0];
 const base={id:r.id,headline:r.headline,location:r.location,availability:r.availability,compensationExpectation:r.compensationExpectation,currency:r.currency,workAuthorization:r.workAuthorization,profileState:r.profileState,doNotContactAt:r.doNotContactAt,withdrawnAt:r.withdrawnAt,deletedAt:r.deletedAt};
 const evidence=documents.slice(0,20).map((d:any)=>({documentId:d.id,sha256:d.sha256,scanState:d.scanState,parseState:d.parseState,supersededBy:(d.provenance as any)?.supersededBy??null,parsedData:d.scanState==='clean'&&d.parseState==='parsed'&&!(d.provenance as any)?.supersededBy?d.parsedData:null}));
 const fingerprint=workflowHash({base,revision:latest?.revision??0,fields:fields??null,documents:evidence,documentsTruncated:documents.length>20,documentRevision:documentChange?.revision??0,fresh});
 return {candidateId:id,revision:latest?.revision??0,fingerprint,fields:fields??null,fresh,suppressed:candidateSuppressed(r),source:(latest?.metadata.source??'owner_recorded') as string,independentlyVerified:false as const,candidate:r,documents:evidence,documentsTruncated:documents.length>20};
}
export async function getCandidateEvidence(ownerId:number,id:string){return withWorkspaceTransaction(ownerId,async tx=>{const d=await candidateEvidenceInTransaction(tx,ownerId,id);return {candidateId:d.candidateId,revision:d.revision,fingerprint:d.fingerprint,fields:d.fields,fresh:d.fresh,suppressed:d.suppressed,source:d.source,independentlyVerified:d.independentlyVerified};});}
export async function saveCandidateEvidenceInTransaction(tx:any,ownerId:number,actorId:number,raw:Parameters<typeof candidateEvidenceSaveSchema.parse>[0],provenance:Record<string,unknown>={}){
 const input=candidateEvidenceSaveSchema.parse(raw),f=input.fields;
 const unique=(values:string[])=>{const seen=new Set<string>();return values.filter(s=>{const key=s.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});};
 f.skills=unique(f.skills);f.workModels=[...new Set(f.workModels)];f.locations=unique(f.locations);
 for(const s of f.skills)ensureSafeAiText(s);
 if(f.observedAt.getTime()>Date.now()+60000||f.validUntil<=f.observedAt||f.validUntil.getTime()>f.observedAt.getTime()+180*86400000)throw new TRPCError({code:'BAD_REQUEST',message:'Use a past observation date and an expiry within 180 days of observation.'});
 const requestHash=workflowHash({fields:f,reason:input.reason});
  const d=await candidateEvidenceInTransaction(tx,ownerId,input.candidateId);
  const prior=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,d.candidateId),eq(workflowEvents.eventType,'candidate.evidence_saved'),eq(workflowEvents.revision,input.expectedRevision+1))).limit(1))[0];
  if(prior?.metadata.requestHash===requestHash&&prior.metadata.parentFingerprint===input.expectedFingerprint)return {revision:prior.revision,alreadySaved:true};
  if(d.revision!==input.expectedRevision||d.fingerprint!==input.expectedFingerprint)throw new TRPCError({code:'CONFLICT',message:'Candidate evidence changed. Reload before saving.'});
  if(d.suppressed)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Evidence cannot reactivate a suppressed candidate.'});
  const revision=d.revision+1;await appendWorkflowEvent(tx,ownerId,'candidate.evidence_saved',d.candidateId,revision,{fields:f,reason:input.reason,requestHash,parentFingerprint:input.expectedFingerprint,actorId,source:'owner_recorded',...provenance,independentlyVerified:false});
  const invalidated=await invalidateCandidateMatches(tx,ownerId,d.candidateId,'Candidate evidence changed to version '+revision+'; review the current profile.');
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'candidate.evidence_saved',resourceType:'candidate',resourceId:d.candidateId,metadata:{revision,invalidatedMatches:invalidated,independentlyVerified:false}},tx);
  return {revision,alreadySaved:false};
}
export async function saveCandidateEvidence(ownerId:number,actorId:number,raw:Parameters<typeof candidateEvidenceSaveSchema.parse>[0]){return withWorkspaceTransaction(ownerId,tx=>saveCandidateEvidenceInTransaction(tx,ownerId,actorId,raw));}
