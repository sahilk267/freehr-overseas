import {TRPCError} from '@trpc/server';
import {and,eq} from 'drizzle-orm';
import {automationQueue,candidateDocuments} from '../../drizzle/schema';
import {recordAudit,createId} from '../db';
import {withWorkspaceTransaction,lockedSelect} from './database';
import {candidateEvidenceInTransaction} from './candidateEvidence';
import {recordCandidateDocumentChange,hasGeneralCandidateProcessingConsent} from './candidateEvidenceLifecycle';
export async function supersedeCandidateDocument(ownerId:number,actorId:number,input:{oldDocumentId:string;newDocumentId:string;expectedFingerprint:string;reason:string}){
 return withWorkspaceTransaction(ownerId,async tx=>{
  const old=(await lockedSelect(tx.select().from(candidateDocuments).where(and(eq(candidateDocuments.ownerId,ownerId),eq(candidateDocuments.id,input.oldDocumentId))).limit(1)))[0],replacement=(await lockedSelect(tx.select().from(candidateDocuments).where(and(eq(candidateDocuments.ownerId,ownerId),eq(candidateDocuments.id,input.newDocumentId))).limit(1)))[0];
  if(!old||!replacement||old.candidateId!==replacement.candidateId)throw new TRPCError({code:'NOT_FOUND',message:'Two owned documents for the same candidate are required.'});
  const provenance=old.provenance as any??{},nextProvenance=replacement.provenance as any??{};
  if(provenance.supersededBy===replacement.id)return {alreadySuperseded:true};
  const d=await candidateEvidenceInTransaction(tx,ownerId,old.candidateId);
  if(d.fingerprint!==input.expectedFingerprint)throw new TRPCError({code:'CONFLICT',message:'Candidate/document evidence changed. Reload before replacing a source.'});
  if(d.suppressed||old.id===replacement.id||old.storageKey===replacement.storageKey||provenance.supersededBy||nextProvenance.supersededBy||replacement.documentType!==old.documentType||replacement.scanState!=='clean'||replacement.parseState!=='parsed')throw new TRPCError({code:'PRECONDITION_FAILED',message:'A distinct current clean parsed replacement of the same document type is required.'});
  await tx.update(candidateDocuments).set({parseState:'superseded',provenance:{...provenance,supersededBy:replacement.id,supersededAt:new Date().toISOString(),supersessionReason:input.reason}}).where(eq(candidateDocuments.id,old.id));
  await tx.update(candidateDocuments).set({provenance:{...nextProvenance,replacesDocumentId:old.id}}).where(eq(candidateDocuments.id,replacement.id));
  const tasks=await tx.select().from(automationQueue).where(eq(automationQueue.ownerId,ownerId));
  for(const task of tasks)if(task.payload?.documentId===old.id&&['queued','retryable_failed','blocked'].includes(task.status))await tx.update(automationQueue).set({status:'cancelled',lastError:'Document was superseded.',lockToken:null,lockedAt:null}).where(eq(automationQueue.id,task.id));
  const changed=await recordCandidateDocumentChange(tx,ownerId,old.candidateId,{oldDocumentId:old.id,newDocumentId:replacement.id,reason:input.reason,actorId});
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'candidate.document_superseded',resourceType:'candidate_document',resourceId:old.id,metadata:{replacementId:replacement.id,...changed}},tx);
  return {alreadySuperseded:false,...changed};
 });
}
export async function retryCandidateDocumentParsing(ownerId:number,actorId:number,input:{documentId:string;expectedFingerprint:string}){
 return withWorkspaceTransaction(ownerId,async tx=>{
  const doc=(await tx.select().from(candidateDocuments).where(and(eq(candidateDocuments.ownerId,ownerId),eq(candidateDocuments.id,input.documentId))).limit(1))[0];
  if(!doc)throw new TRPCError({code:'NOT_FOUND',message:'Document was not found.'});
  const d=await candidateEvidenceInTransaction(tx,ownerId,doc.candidateId);
  if(d.fingerprint!==input.expectedFingerprint)throw new TRPCError({code:'CONFLICT',message:'Candidate evidence changed. Reload before retrying.'});
  if(d.suppressed||doc.scanState!=='clean'||doc.documentType!=='cv'||(doc.provenance as any)?.supersededBy)throw new TRPCError({code:'PRECONDITION_FAILED',message:'A current clean CV source and active candidate are required.'});
  if(!await hasGeneralCandidateProcessingConsent(tx,ownerId,doc.candidateId))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Current general candidate processing consent is required.'});
  const key='parse_cv:'+doc.id,task=(await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.idempotencyKey,key))).limit(1))[0];
  if(doc.parseState==='parsed'||task?.status==='completed'||task?.status==='running')return {queueId:task?.id??null,alreadyQueued:true,status:task?.status??'parsed'};
  if(task&&['queued','retryable_failed'].includes(task.status))return {queueId:task.id,alreadyQueued:true,status:task.status};
  const id=task?.id??createId('que_');
  if(task)await tx.update(automationQueue).set({status:'queued',scheduledAt:new Date(),attempts:0,lastError:null,lockToken:null,lockedAt:null,completedAt:null}).where(eq(automationQueue.id,task.id));
  else await tx.insert(automationQueue).values({id,ownerId,jobType:'parse_cv',status:'queued',attempts:0,maxAttempts:3,priority:10,scheduledAt:new Date(),payload:{documentId:doc.id,candidateId:doc.candidateId},idempotencyKey:key});
  await tx.update(candidateDocuments).set({parseState:'queued',provenance:{...(doc.provenance as any??{}),lastParseError:null}}).where(eq(candidateDocuments.id,doc.id));
  await recordCandidateDocumentChange(tx,ownerId,doc.candidateId,{documentId:doc.id,reason:'Explicit owner parsing retry',actorId});
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'candidate.document_parse_requeued',resourceType:'candidate_document',resourceId:doc.id,metadata:{queueId:id}},tx);
  return {queueId:id,alreadyQueued:Boolean(task),status:'queued'};
 });
}
