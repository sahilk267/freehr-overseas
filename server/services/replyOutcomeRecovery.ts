import {alias} from 'drizzle-orm/mysql-core';
import {TRPCError} from '@trpc/server';
import {and,asc,eq,exists,notExists,sql} from 'drizzle-orm';
import {approvals,clientDiscoveryMeetings,clientDiscoveryRequests,emailDispatches,messages,workflowEvents,workspaceSettings} from '../../drizzle/schema';
import {requireDb} from '../db';
import {withWorkspaceTransaction} from './database';
import {assertDiscoverySource} from './clientDiscovery';
import {clientReplyCase,finishReplyAction} from './replyTriage';
import {completeAcceptedReply} from './replyMail';
import {emailContentHash} from './emailAuthorization';
import type {ReplyMailScope} from './replyMailScope';
import {appendWorkflowEvent} from './workflowStore';

const marker='outreach.outcome_checked';
/** Bounded compatibility source. It only consumes stored outcomes; it never sends or books. */
export async function processObservedReplyOutcomes(ownerId?:number,limit=5){
 const db=await requireDb(),marks=alias(workflowEvents,'reply_outcome_markers'),bound=Math.min(25,Math.max(1,limit));
 const enabled=(owner:any)=>exists(db.select({id:workspaceSettings.ownerId}).from(workspaceSettings).where(and(eq(workspaceSettings.ownerId,owner),eq(workspaceSettings.backgroundEnabled,true),eq(workspaceSettings.emergencyStop,false))));
 const unchecked=(owner:any,id:any)=>notExists(db.select({id:marks.id}).from(marks).where(and(eq(marks.ownerId,owner),eq(marks.aggregateId,id),eq(marks.eventType,marker))));
 const requestConditions=[eq(clientDiscoveryRequests.status,'booked'),enabled(clientDiscoveryRequests.ownerId),unchecked(clientDiscoveryRequests.ownerId,clientDiscoveryRequests.id)];
 const receiptConditions=[eq(workflowEvents.eventType,'outreach.reply_email_prepared'),enabled(workflowEvents.ownerId),unchecked(workflowEvents.ownerId,workflowEvents.id),exists(db.select({id:emailDispatches.id}).from(emailDispatches).where(and(eq(emailDispatches.ownerId,workflowEvents.ownerId),eq(emailDispatches.status,'sent'),eq(emailDispatches.messageId,sql`JSON_UNQUOTE(JSON_EXTRACT(${workflowEvents.metadata}, '$.messageId'))`))))];
 if(ownerId!==undefined){requestConditions.push(eq(clientDiscoveryRequests.ownerId,ownerId));receiptConditions.push(eq(workflowEvents.ownerId,ownerId));}
 const requests=await db.select().from(clientDiscoveryRequests).where(and(...requestConditions)).orderBy(asc(clientDiscoveryRequests.createdAt),asc(clientDiscoveryRequests.id)).limit(bound);
 const receipts=await db.select().from(workflowEvents).where(and(...receiptConditions)).orderBy(asc(workflowEvents.createdAt),asc(workflowEvents.id)).limit(bound);
 let completed=0,skipped=0;
 for(const candidate of [...requests.map(r=>({kind:'discovery' as const,row:r})),...receipts.map(r=>({kind:'response' as const,row:r}))]){
  const changed=await withWorkspaceTransaction(candidate.row.ownerId,async tx=>{
   const owner=candidate.row.ownerId,id=candidate.row.id,settings=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,owner)).limit(1))[0];
   if(!settings?.backgroundEnabled||settings.emergencyStop)return false;
   if((await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,owner),eq(workflowEvents.eventType,marker),eq(workflowEvents.aggregateId,id))).limit(1)).length)return false;
   const checked=async(reason:string)=>{await appendWorkflowEvent(tx,owner,marker,id,1,{kind:candidate.kind,reason});return false;};
   if(candidate.kind==='discovery'){
    const r=(await tx.select().from(clientDiscoveryRequests).where(and(eq(clientDiscoveryRequests.ownerId,owner),eq(clientDiscoveryRequests.id,id))).limit(1))[0];
    const meeting=r?(await tx.select().from(clientDiscoveryMeetings).where(and(eq(clientDiscoveryMeetings.ownerId,owner),eq(clientDiscoveryMeetings.requestId,r.id))).limit(1))[0]:null;
    const proof=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,owner),eq(workflowEvents.eventType,'discovery.booked'),eq(workflowEvents.aggregateId,id))).limit(1))[0];
    if(r?.status!=='booked'||meeting?.status!=='tentative'||proof?.metadata?.meetingId!==meeting.id)return checked('missing_or_cancelled_booking');
    try{await assertDiscoverySource(tx,owner,r);}catch(e){if(!(e instanceof TRPCError)||!['NOT_FOUND','CONFLICT','PRECONDITION_FAILED'].includes(e.code))throw e;return checked('stale_or_completed_goal');}
    const d=await clientReplyCase(tx,owner,r.conversationId),action=d.action as {revision:number}|null;
    const result=await finishReplyAction(tx,owner,{conversationId:r.conversationId,messageId:d.message!.id,replyRevision:d.replyRevision,actionRevision:action!.revision},{kind:'discovery_booked',reason:'A recorded tentative discovery meeting was booked; attendance is not confirmed.',resourceId:meeting.id});
    await checked(result.completed?'observed_booking':'stale_goal');return result.completed&&!result.alreadyCompleted;
   }
   const e=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,owner),eq(workflowEvents.id,id),eq(workflowEvents.eventType,'outreach.reply_email_prepared'))).limit(1))[0];
   if(!e)return checked('missing_intent');
   const messageId=String(e.metadata?.messageId??''),dispatch=(await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId,owner),eq(emailDispatches.messageId,messageId))).limit(1))[0];
   // In-memory adapters cannot evaluate the correlated receipt predicate. Leave pending intents untouched.
   if(dispatch?.status!=='sent')return false;
   const message=(await tx.select().from(messages).where(and(eq(messages.ownerId,owner),eq(messages.id,messageId))).limit(1))[0];
   const approval=(await tx.select().from(approvals).where(and(eq(approvals.ownerId,owner),eq(approvals.id,dispatch.approvalId),eq(approvals.resourceId,messageId))).limit(1))[0];
   const receipt=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,owner),eq(workflowEvents.eventType,'email.provider_accepted'),eq(workflowEvents.aggregateId,dispatch.id))).limit(1))[0];
   const payload=approval?.payload as {replyScope?:ReplyMailScope;recipient?:string;senderIdentityId?:string;contentHash?:string}|null;
   const scope=payload?.replyScope;
   if(message?.status!=='sent'||receipt?.metadata?.messageId!==messageId||!scope||!payload?.recipient||!payload.senderIdentityId||scope.messageId!==e.aggregateId||scope.actionRevision!==e.revision||message.conversationId!==scope.conversationId||payload.contentHash!==emailContentHash({senderIdentityId:payload.senderIdentityId,recipient:payload.recipient,subject:message.subject??'',body:message.body,replyScope:scope}))return checked('unverified_receipt');
   const result=await completeAcceptedReply(tx,owner,{recipient:payload.recipient,replyScope:scope},message);
   await checked(result.completed?'observed_provider_acceptance':'stale_or_different_goal');return result.completed&&!result.alreadyCompleted;
  });if(changed)completed++;else skipped++;
 }
 return {scanned:requests.length+receipts.length,completed,skipped};
}
