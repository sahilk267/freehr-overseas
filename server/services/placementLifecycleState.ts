import {TRPCError} from '@trpc/server';
import {and,eq} from 'drizzle-orm';
import {candidates,companies,conversations,jobs,placements} from '../../drizzle/schema';
import {commercialEvent} from './commercialAgreements';
import {candidateSuppressed} from './candidateEvidence';
import {workflowHash} from './workflowStore';
export const lifecyclePlanId=(placementId:string,stage:string)=>workflowHash(['placement.lifecycle',placementId,stage]);
export const prejoiningStates=['offer_accepted','joining_pending'];
export const retentionStates=['joining_confirmed','invoice_eligible','guarantee_active','guarantee_ended'];
export const placementLifecycleFingerprint=(p:any)=>workflowHash([p.id,p.jobId,p.companyId,p.candidateId,p.currency,p.annualCompensation??null,p.joiningConfirmedAt?.toISOString()??null,p.guaranteeStartAt?.toISOString()??null,p.guaranteeEndAt?.toISOString()??null]);
export async function lifecyclePlacement(tx:any,ownerId:number,id:string){
 const p=(await tx.select().from(placements).where(and(eq(placements.ownerId,ownerId),eq(placements.id,id))).limit(1))[0];
 if(!p)throw new TRPCError({code:'NOT_FOUND',message:'Owned placement was not found.'});
 return {...p};
}
export async function lifecycleContext(tx:any,ownerId:number,p:any,activeCandidate=true){
 const candidate=(await tx.select().from(candidates).where(and(eq(candidates.ownerId,ownerId),eq(candidates.id,p.candidateId))).limit(1))[0];
 const job=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,p.jobId))).limit(1))[0];
 const company=(await tx.select().from(companies).where(and(eq(companies.ownerId,ownerId),eq(companies.id,p.companyId))).limit(1))[0];
 if(!candidate||activeCandidate&&candidateSuppressed(candidate)||!job||!company||job.companyId!==company.id||['closed','suppressed','declined','not_fit','suspended'].includes(company.pipelineState))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Placement candidate, client or role is unavailable for this workflow.'});
 return {candidate,job,company};
}
export async function placementCheckpointState(tx:any,ownerId:number,id:string,now=new Date()):Promise<any>{
 const event=await commercialEvent(tx,ownerId,'placement.lifecycle_checkpoint',id);
 if(!event||event.metadata?.redacted)return {state:'cancelled',reason:'Placement checkpoint is unavailable.'};
 const c=event.metadata,p=await lifecyclePlacement(tx,ownerId,c.placementId),plan=await commercialEvent(tx,ownerId,'placement.lifecycle_plan',c.planId);
 if(!plan?.metadata?.enabled||plan.revision!==c.planRevision||placementLifecycleFingerprint(p)!==c.placementFingerprint)return {state:'cancelled',reason:'Placement checkpoint source changed.'};
 if(!(c.stage==='prejoining'?prejoiningStates:retentionStates).includes(p.status))return {state:'cancelled',reason:'Placement is no longer in this checkpoint stage.'};
 if(await commercialEvent(tx,ownerId,'placement.lifecycle_response',id))return {state:'completed',reason:'A checkpoint response has been recorded.'};
 try{await lifecycleContext(tx,ownerId,p);}catch(e){if(!(e instanceof TRPCError))throw e;return {state:'cancelled',reason:e.message};}
 if(await commercialEvent(tx,ownerId,'placement.lifecycle_departure',p.id))return {state:'cancelled',reason:'Departure evidence ended routine placement check-ins.'};
 const thread=(await tx.select().from(conversations).where(and(eq(conversations.ownerId,ownerId),eq(conversations.id,c.conversationId))).limit(1))[0];
 if(!thread||thread.channel!=='email'||thread.companyId!==p.companyId||thread.jobId&&thread.jobId!==p.jobId||c.party==='candidate'&&(thread.candidateId!==p.candidateId||thread.contactId)||c.party==='client'&&(!thread.contactId||thread.candidateId))return {state:'cancelled',reason:'Checkpoint recipient relationship changed.'};
 if(new Date(c.deadlineAt)<=now)return {state:'cancelled',reason:'Placement checkpoint response window expired.'};
 return {state:'eligible',fingerprint:workflowHash([id,c.planRevision,c.placementFingerprint,c.dueAt,c.deadlineAt,c.conversationId]),candidateId:p.candidateId,jobId:p.jobId,placementId:p.id,conversationId:c.conversationId,deadlineAt:new Date(c.deadlineAt),dueAt:new Date(c.dueAt),stage:c.stage,party:c.party,senderIdentityId:c.senderIdentityId,label:c.label,checkpoint:c};
}
