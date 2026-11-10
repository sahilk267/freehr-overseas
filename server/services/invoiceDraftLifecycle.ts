import {TRPCError} from '@trpc/server';
import {and,eq,inArray} from 'drizzle-orm';
import {approvals,automationQueue,invoices,payments} from '../../drizzle/schema';
import {recordAudit} from '../db';
import {withWorkspaceTransaction,lockedSelect} from './database';
import {commercialEvent} from './commercialAgreements';
import {appendWorkflowEvent,workflowHash} from './workflowStore';
import {stopRelatedFollowUps} from './followups';
const projection=(i:any)=>({id:i.id,placementId:i.placementId,companyId:i.companyId,status:i.status,amount:i.amount,taxAmount:i.taxAmount,currency:i.currency,dueAt:i.dueAt,issuedAt:i.issuedAt,paidAt:i.paidAt});
const canCancel=(i:any)=>['draft','validation','approval_pending'].includes(i.status)&&!i.issuedAt&&!i.paidAt;
async function owned(tx:any,ownerId:number,id:string){const i=(await lockedSelect(tx.select().from(invoices).where(and(eq(invoices.ownerId,ownerId),eq(invoices.id,id))).limit(1)))[0];if(!i)throw new TRPCError({code:'NOT_FOUND',message:'Owned invoice draft was not found.'});return i;}
export async function invoiceDraftLifecycle(ownerId:number,id:string){return withWorkspaceTransaction(ownerId,async tx=>{const i=await owned(tx,ownerId,id);return {id,status:i.status,canCancel:canCancel(i),fingerprint:workflowHash(projection(i))};});}
export async function cancelInvoiceDraft(ownerId:number,actorId:number,input:{id:string;expectedFingerprint:string;reason:string}){return withWorkspaceTransaction(ownerId,async tx=>{
 const i=await owned(tx,ownerId,input.id),requestHash=workflowHash(input),old=await commercialEvent(tx,ownerId,'invoice.draft_cancelled',input.id);
 if(old){if(old.metadata.requestHash!==requestHash)throw new TRPCError({code:'CONFLICT',message:'A different draft cancellation is already recorded.'});return {alreadyCancelled:true};}
 if(workflowHash(projection(i))!==input.expectedFingerprint)throw new TRPCError({code:'CONFLICT',message:'Invoice draft changed. Reload before cancellation.'});
 if(!canCancel(i)||(await tx.select().from(payments).where(and(eq(payments.ownerId,ownerId),eq(payments.invoiceId,i.id))).limit(1)).length)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Only an unissued draft without payment history can be cancelled. Use a reviewed financial correction for issued obligations.'});
 const pending=await tx.select().from(approvals).where(and(eq(approvals.ownerId,ownerId),eq(approvals.resourceType,'invoice'),eq(approvals.resourceId,i.id),eq(approvals.actionType,'invoice_issue'),inArray(approvals.status,['pending','approved'])));
 for(const a of pending){if(a.actionedAt)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Invoice issuance was already consumed.'});await tx.update(approvals).set({status:'cancelled'}).where(eq(approvals.id,a.id));const tasks=await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.jobType,'execute_policy_decision'),inArray(automationQueue.status,['queued','retryable_failed','blocked'])));for(const task of tasks)if(task.payload?.approvalId===a.id)await tx.update(automationQueue).set({status:'cancelled',lockToken:null,lockedAt:null,lastError:'Unissued invoice draft cancelled.'}).where(eq(automationQueue.id,task.id));}
 await stopRelatedFollowUps(tx,ownerId,{resourceType:'invoice',resourceId:i.id},'Unissued invoice draft cancelled.');await tx.update(invoices).set({status:'cancelled'}).where(and(eq(invoices.ownerId,ownerId),eq(invoices.id,i.id)));
 await appendWorkflowEvent(tx,ownerId,'invoice.draft_cancelled',i.id,1,{requestHash,reason:input.reason,actorId,issued:false});await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'invoice.draft_cancelled',resourceType:'invoice',resourceId:i.id,metadata:{reason:input.reason,issued:false}},tx);return {alreadyCancelled:false};
});}
