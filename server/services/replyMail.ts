import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { approvals, automationQueue, contacts, conversations, emailDispatches, emailIdentities, messages, suppressionList, workflowEvents } from "../../drizzle/schema";
import { createId, hashContactValue, recordAudit } from "../db";
import { hasClientCommunicationPermission } from "./communicationPermission";
import { withWorkspaceTransaction } from "./database";
import { emailContentHash } from "./emailAuthorization";
import { finishReplyAction, clientReplyCase } from "./replyTriage";
import type { ReplyMailScope } from "./replyMailScope";
import { appendWorkflowEvent, workflowHash } from "./workflowStore";

const fail = (message: string) => new TRPCError({ code: "PRECONDITION_FAILED", message });
async function eligibleRecipient(tx: any, ownerId: number, contactId: string, now: Date) {
  const contact = (await tx.select().from(contacts).where(and(eq(contacts.ownerId, ownerId), eq(contacts.id, contactId))).limit(1))[0];
  if (!contact?.email || !await hasClientCommunicationPermission(tx, ownerId, contactId, now)) throw fail("Current client communication permission is missing or expired.");
  const address = contact.email.trim().toLowerCase();
  const blocked = (await tx.select().from(suppressionList).where(and(eq(suppressionList.ownerId, ownerId), eq(suppressionList.channel, "email"), eq(suppressionList.valueHash, hashContactValue(address)), eq(suppressionList.active, true))).limit(1))[0];
  if (blocked) throw fail("Client recipient is suppressed.");
  return address as string;
}

export async function validateReplyEmail(tx: any, ownerId: number, payload: { recipient?: string; replyScope?: ReplyMailScope }, message: { conversationId: string }, now = new Date()) {
  const scope = payload.replyScope;
  if (!scope) return;
  if (message.conversationId !== scope.conversationId) throw fail("Reply email thread binding changed.");
  const detail = await clientReplyCase(tx, ownerId, scope.conversationId);
  const action = detail.action as { action?: string; revision: number } | null;
  if (detail.blocked || detail.completion || detail.message?.id !== scope.messageId || detail.replyRevision !== scope.replyRevision || workflowHash(detail.message.body) !== scope.bodyHash || action?.revision !== scope.actionRevision || !["arrange_discovery", "clarify_requirement", "prepare_response"].includes(action.action ?? "")) throw fail("Client reply or next action changed; prepare a new response for review.");
  const contact = (await tx.select().from(contacts).where(and(eq(contacts.ownerId, ownerId), eq(contacts.id, scope.contactId))).limit(1))[0];
  // Scope must still name the thread's canonical contact, not just an eligible unrelated recipient.
  const conversation = (await tx.select().from(conversations).where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, scope.conversationId))).limit(1))[0];
  if (!contact || conversation?.contactId !== scope.contactId) throw fail("Client reply contact changed.");
  const address = await eligibleRecipient(tx, ownerId, scope.contactId, now);
  if (address !== payload.recipient?.trim().toLowerCase() || hashContactValue(address) !== scope.recipientHash) throw fail("Client reply recipient changed.");
}

export async function prepareReplyEmail(ownerId: number, input: { conversationId: string; messageId: string; replyRevision: number; actionRevision: number; senderIdentityId: string; subject: string; body: string }) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const detail = await clientReplyCase(tx, ownerId, input.conversationId);
    const conversation = (await tx.select().from(conversations).where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, input.conversationId))).limit(1))[0];
    if (!conversation?.contactId || !detail.message) throw fail("A current client reply is required.");
    const recipient = await eligibleRecipient(tx, ownerId, conversation.contactId, new Date());
    const replyScope: ReplyMailScope = { conversationId: input.conversationId, messageId: input.messageId, replyRevision: input.replyRevision, bodyHash: workflowHash(detail.message.body), actionRevision: input.actionRevision, contactId: conversation.contactId, recipientHash: hashContactValue(recipient) };
    await validateReplyEmail(tx, ownerId, { recipient, replyScope }, { conversationId: input.conversationId });
    const sender = (await tx.select().from(emailIdentities).where(and(eq(emailIdentities.ownerId, ownerId), eq(emailIdentities.id, input.senderIdentityId))).limit(1))[0];
    if (!sender || sender.status !== "active" || sender.purpose !== "clients") throw fail("Select an active client sender identity.");
    const subject = input.subject.trim(), body = `${input.body.trim()}\n\nReply STOP to stop future messages.`;
    const requestHash = workflowHash([replyScope, sender.id, sender.email, sender.purpose, subject, body]);
    // One approved-outbox intent per next-action revision, including after rejection or unknown outcomes.
    const prior = (await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.eventType, "outreach.reply_email_prepared"), eq(workflowEvents.aggregateId, input.messageId), eq(workflowEvents.revision, input.actionRevision))).limit(1))[0];
    if (prior) {
      if (prior.metadata.requestHash !== requestHash) throw new TRPCError({ code: "CONFLICT", message: "A different response already exists for this next action. Review it before recording a revised action." });
      return { messageId: prior.metadata.messageId as string, approvalId: prior.metadata.approvalId as string, alreadyExists: true };
    }
    // Editing a task cannot fork a second send while the earlier reply response is unresolved or consumed.
    const previous = await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.eventType, "outreach.reply_email_prepared"), eq(workflowEvents.aggregateId, input.messageId)));
    for (const event of previous) {
      const dispatch = (await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ownerId), eq(emailDispatches.messageId, String(event.metadata.messageId)))).limit(1))[0];
      if (!dispatch || dispatch.status !== "cancelled" || dispatch.claimedAt) throw fail("The previous response must be rejected or cancelled without a delivery attempt before preparing another.");
    }
    const messageId = createId("msg_"), approvalId = createId("apr_"), dispatchId = createId("dsp_");
    await tx.insert(messages).values({ id: messageId, ownerId, conversationId: input.conversationId, direction: "outbound", status: "approval_pending", subject, body, idempotencyKey: `reply_email:${messageId}`, aiGenerated: false });
    await tx.insert(approvals).values({ id: approvalId, ownerId, requestedBy: "user", actionType: "email_send", resourceType: "message", resourceId: messageId, status: "pending", actionedAt: null, reason: "Review the current client reply and exact response. A newer reply, task revision or permission change invalidates this authorization.", payload: { senderIdentityId: sender.id, senderAddress: sender.email, senderPurpose: sender.purpose, recipient, replyScope, contentHash: emailContentHash({ senderIdentityId: sender.id, recipient, subject, body, replyScope }) } });
    await tx.insert(emailDispatches).values({ id: dispatchId, ownerId, messageId, approvalId, recipientHash: replyScope.recipientHash, status: "queued", scheduledAt: new Date() });
    await appendWorkflowEvent(tx, ownerId, "outreach.reply_email_prepared", input.messageId, input.actionRevision, { messageId, approvalId, requestHash });
    await recordAudit({ ownerId, actorType: "user", actorId: String(ownerId), action: "outreach.reply_email_prepared", resourceType: "message", resourceId: messageId, metadata: { approvalId, inboundMessageId: input.messageId, actionRevision: input.actionRevision } }, tx);
    return { messageId, approvalId, alreadyExists: false };
  });
}

/** Revoke only unused reply authority; an in-flight/unknown/sent attempt needs reconciliation. */
export async function cancelReplyEmail(ownerId: number, approvalId: string, reason: string) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const approval = (await tx.select().from(approvals).where(and(eq(approvals.ownerId, ownerId), eq(approvals.id, approvalId), eq(approvals.actionType, "email_send"))).limit(1))[0];
    if (!(approval?.payload as { replyScope?: ReplyMailScope } | null)?.replyScope) throw new TRPCError({ code: "NOT_FOUND", message: "Client response approval was not found." });
    const dispatch = (await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ownerId), eq(emailDispatches.approvalId, approvalId))).limit(1))[0];
    if (approval.status === "cancelled" && dispatch?.status === "cancelled" && !dispatch.claimedAt) return { alreadyCancelled: true };
    if (approval.actionedAt || !["pending", "approved"].includes(approval.status) || !dispatch || dispatch.status !== "queued" || dispatch.claimedAt) throw fail("This response has been consumed or attempted; reconcile delivery before taking another action.");
    await tx.update(approvals).set({ status: "cancelled" }).where(and(eq(approvals.ownerId, ownerId), eq(approvals.id, approvalId)));
    await tx.update(emailDispatches).set({ status: "cancelled", lastError: reason }).where(and(eq(emailDispatches.ownerId, ownerId), eq(emailDispatches.id, dispatch.id)));
    await tx.update(messages).set({ status: "cancelled" }).where(and(eq(messages.ownerId, ownerId), eq(messages.id, approval.resourceId)));
    await tx.update(automationQueue).set({ status: "cancelled", lockToken: null, lockedAt: null, lastError: reason }).where(and(eq(automationQueue.ownerId, ownerId), eq(automationQueue.idempotencyKey, `email_dispatch:${dispatch.id}`), inArray(automationQueue.status, ["queued", "retryable_failed", "blocked"])));
    await appendWorkflowEvent(tx, ownerId, "outreach.reply_email_cancelled", approvalId, 1, { reason, messageId: approval.resourceId });
    await recordAudit({ ownerId, actorType: "user", actorId: String(ownerId), action: "outreach.reply_email_cancelled", resourceType: "message", resourceId: approval.resourceId, metadata: { approvalId, reason } }, tx);
    return { alreadyCancelled: false };
  });
}

/** Receipt has already been persisted. Stale intent must not turn a known acceptance into an uncertain send. */
export async function completeAcceptedReply(tx:any,ownerId:number,payload:{recipient:string;replyScope:ReplyMailScope},message:{id:string;conversationId:string}){
 try{await validateReplyEmail(tx,ownerId,payload,message);}catch(e){if(!(e instanceof TRPCError)||!["NOT_FOUND","CONFLICT","PRECONDITION_FAILED"].includes(e.code))throw e;return {completed:false,reason:"stale_action"};}
 return finishReplyAction(tx,ownerId,payload.replyScope,{kind:"response_provider_accepted",reason:"Provider accepted the approved response; recipient delivery is not confirmed.",resourceId:message.id});
}
