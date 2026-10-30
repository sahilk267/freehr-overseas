import { and, eq, gte, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { approvals, automationGrants, emailDispatches, emailIdentities, followUpPlans, incidents, messages, suppressionList, workspaceSettings } from "../../drizzle/schema";
import { createId, ensureWorkspace, hashContactValue, recordAudit, requireDb } from "../db";
import { lockedSelect } from "./database";
import { emailContentHash } from "./emailAuthorization";
import { isSenderIdentityConfigured, sendViaHostingerMailApi } from "./hostingerMail";
import { advanceFollowUp, enqueueEmailDispatch, followUpEligibility } from "./followups";
import { appendWorkflowEvent, grantScopeHash, stopFollowUp, type FollowUpPlan } from "./workflowStore";
import { localClock, nextContactTime } from "./workflowTiming";

type DeliveryInput = { messageId?: string; dispatchId?: string; senderIdentityId?: string; recipient?: string };

export async function deliverApprovedEmail(ownerId: number, input: DeliveryInput, now = new Date()) {
  const db = await requireDb();
  await ensureWorkspace(ownerId);
  const claim = await db.transaction(async (tx: any) => {
    // One workspace lock serializes all admission/cap reservations, not network calls.
    const workspace = (await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1)))[0];
    if (workspace.emergencyStop) return { status: "deferred", nextActionAt: new Date(now.getTime() + 60000), reason: "Emergency stop is enabled." };
    let dispatch = input.dispatchId ? (await tx.select().from(emailDispatches).where(and(eq(emailDispatches.id, input.dispatchId), eq(emailDispatches.ownerId, ownerId))).limit(1))[0] : (await tx.select().from(emailDispatches).where(and(eq(emailDispatches.messageId, input.messageId ?? ""), eq(emailDispatches.ownerId, ownerId))).limit(1))[0];
    if (input.dispatchId && !dispatch) throw new TRPCError({ code: "NOT_FOUND", message: "Dispatch was not found." });
    const messageId = dispatch?.messageId ?? input.messageId;
    const message = (await lockedSelect(tx.select().from(messages).where(and(eq(messages.id, messageId ?? ""), eq(messages.ownerId, ownerId))).limit(1)))[0];
    const approval = (await lockedSelect(tx.select().from(approvals).where(and(eq(approvals.ownerId, ownerId), eq(approvals.actionType, "email_send"), eq(approvals.resourceId, messageId ?? ""), ...(dispatch ? [eq(approvals.id, dispatch.approvalId)] : []))).limit(1)))[0];
    if (!message || !approval || approval.status !== "approved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A current approved sender and approved email action are required." });
    if (approval.actionedAt || message.status === "sent" || (dispatch && dispatch.status !== "queued")) throw new TRPCError({ code: "CONFLICT", message: "This email approval has already been consumed or cancelled; reconcile before retrying." });
    const payload = approval.payload as { senderIdentityId?: string; recipient?: string; senderAddress?: string; senderPurpose?: string; contentHash?: string };
    if (!payload?.senderIdentityId || !payload?.recipient) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Approved email action is missing sender or recipient payload." });
    if (input.senderIdentityId && input.senderIdentityId !== payload.senderIdentityId) throw new TRPCError({ code: "BAD_REQUEST", message: "Supplied sender identity does not match the approved payload." });
    if (input.recipient && input.recipient.trim().toLowerCase() !== payload.recipient.trim().toLowerCase()) throw new TRPCError({ code: "BAD_REQUEST", message: "Supplied recipient does not match the approved payload." });
    if (payload.contentHash !== emailContentHash({ senderIdentityId: payload.senderIdentityId, recipient: payload.recipient, subject: message.subject ?? "", body: message.body })) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Email content changed or has no bound authorization; request a new approval." });
    const identity = (await lockedSelect(tx.select().from(emailIdentities).where(and(eq(emailIdentities.id, payload.senderIdentityId), eq(emailIdentities.ownerId, ownerId))).limit(1)))[0];
    if (!identity || identity.status !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A current approved sender is required." });
    if (payload.senderAddress !== identity.email || payload.senderPurpose !== identity.purpose) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Sender changed; request a new email approval." });
    const recipientHash = hashContactValue(payload.recipient);
    if ((await tx.select().from(suppressionList).where(and(eq(suppressionList.ownerId, ownerId), eq(suppressionList.channel, "email"), eq(suppressionList.valueHash, recipientHash), eq(suppressionList.active, true))).limit(1)).length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Recipient was suppressed before delivery." });
    const plan = dispatch?.planId ? (await lockedSelect(tx.select().from(followUpPlans).where(and(eq(followUpPlans.id, dispatch.planId), eq(followUpPlans.ownerId, ownerId))).limit(1)))[0] as FollowUpPlan : undefined;
    if (dispatch?.planId && (!plan || plan.status !== "approval_pending" || plan.revision !== dispatch.planRevision || plan.stepIndex !== dispatch.stepIndex)) return { status: "cancelled", reason: "Follow-up changed before delivery." };
    if (plan) {
      const eligibility = await followUpEligibility(tx, plan, now);
      if (eligibility.state !== "eligible") { await stopFollowUp(tx, plan, eligibility.state, eligibility.reason!); return { status: eligibility.state, reason: eligibility.reason }; }
    }
    if (dispatch?.grantId) {
      const grant = (await tx.select().from(automationGrants).where(and(eq(automationGrants.id, dispatch.grantId), eq(automationGrants.ownerId, ownerId))).limit(1))[0];
      const used = await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ownerId), eq(emailDispatches.grantId, dispatch.grantId)));
      if (!plan || !grant?.active || grant.expiresAt <= now || grant.planRevision !== plan.revision || grant.scopeHash !== grantScopeHash(plan) || used.filter((row: typeof emailDispatches.$inferSelect) => row.claimedAt).length >= grant.maxSends) {
        if (plan) await stopFollowUp(tx, plan, "blocked", "Automatic sending permission is expired, revoked or exhausted.");
        return { status: "blocked", reason: "Automatic sending permission is expired, revoked or exhausted." };
      }
    }
    if (!dispatch) {
      dispatch = { id: createId("dsp_"), ownerId, messageId: message.id, approvalId: approval.id, planId: null, planRevision: null, stepIndex: null, grantId: null, recipientHash, status: "queued", scheduledAt: now };
      await tx.insert(emailDispatches).values(dispatch);
    }
    const timezone = plan?.timezone ?? workspace.businessTimezone;
    const window = { timezone, quietStart: workspace.quietHoursStart, quietEnd: workspace.quietHoursEnd, businessDaysOnly: plan?.businessDaysOnly ?? false };
    let permittedAt = nextContactTime(now, window);
    const recent = await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ownerId), gte(emailDispatches.claimedAt, new Date(now.getTime() - 8 * 86400000))));
    const day = localClock(now, workspace.businessTimezone).day;
    const today = recent.filter((row: typeof emailDispatches.$inferSelect) => row.claimedAt && localClock(row.claimedAt, workspace.businessTimezone).day === day);
    const policy = (workspace.policyConfig ?? {}) as { followupRecipientDailyLimit?: number; minRecipientSpacingMinutes?: number };
    const recipientLimit = Math.max(1, Math.min(20, Number(policy.followupRecipientDailyLimit ?? 3)));
    const spacingMinutes = Math.max(1, Math.min(1440, Number(policy.minRecipientSpacingMinutes ?? 60)));
    const dailyLimit = Number(workspace.dailyOutboundLimit);
    if (![recipientLimit, spacingMinutes, dailyLimit].every(Number.isFinite) || dailyLimit < 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Outbound limits must be configured before delivery." });
    if (today.length >= dailyLimit || today.filter((row: typeof emailDispatches.$inferSelect) => row.recipientHash === recipientHash).length >= recipientLimit) {
      const nextDay = nextContactTime(now, { ...window, nextDay: true, timezone: workspace.businessTimezone });
      permittedAt = nextContactTime(nextDay, window);
    }
    const lastRecipientSend = recent.filter((row: typeof emailDispatches.$inferSelect) => row.recipientHash === recipientHash && row.claimedAt).reduce((latest: number, row: typeof emailDispatches.$inferSelect) => Math.max(latest, row.claimedAt!.getTime()), 0);
    if (lastRecipientSend && lastRecipientSend + spacingMinutes * 60_000 > permittedAt.getTime()) permittedAt = nextContactTime(new Date(lastRecipientSend + spacingMinutes * 60_000), window);
    if (plan && permittedAt >= plan.deadlineAt) { await stopFollowUp(tx, plan, "cancelled", "No permitted contact window before deadline."); return { status: "cancelled", reason: "No permitted contact window before deadline." }; }
    if (permittedAt > now) {
      await tx.update(emailDispatches).set({ scheduledAt: permittedAt }).where(eq(emailDispatches.id, dispatch.id));
      await enqueueEmailDispatch(tx, ownerId, dispatch.id, permittedAt);
      if (plan) await tx.update(followUpPlans).set({ nextActionAt: permittedAt }).where(eq(followUpPlans.id, plan.id));
      return { status: "deferred", nextActionAt: permittedAt, dispatchId: dispatch.id };
    }
    if (!isSenderIdentityConfigured(identity)) {
      if (plan) { await stopFollowUp(tx, plan, "blocked", "Sending mailbox does not match a configured transport; no delivery was attempted."); return { status: "blocked", reason: "Configure and verify the sending mailbox before resuming." }; }
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The sending mailbox is not configured; no delivery was attempted." });
    }
    const claimed = await tx.update(approvals).set({ actionedAt: now }).where(and(eq(approvals.id, approval.id), eq(approvals.ownerId, ownerId), eq(approvals.status, "approved"), isNull(approvals.actionedAt)));
    if (!claimed[0]?.affectedRows) throw new TRPCError({ code: "CONFLICT", message: "This email approval has already been consumed." });
    await tx.update(emailDispatches).set({ status: "dispatching", claimedAt: now }).where(eq(emailDispatches.id, dispatch.id));
    await appendWorkflowEvent(tx, ownerId, "email.dispatch_claimed", dispatch.id, 1, { messageId: message.id, approvalId: approval.id });
    return { status: "claimed", dispatch, message, identity, recipient: payload.recipient };
  });
  if (claim.status !== "claimed") return { success: false, ...claim };
  try {
    const receipt = await sendViaHostingerMailApi({ purpose: claim.identity.purpose, to: claim.recipient, displayName: claim.identity.displayName, subject: claim.message.subject ?? "", text: claim.message.body, messageId: claim.message.id });
    const acceptedAt = new Date();
    await db.transaction(async (tx: any) => {
      await tx.update(messages).set({ status: "sent", providerMessageId: receipt.providerMessageId, providerUid: receipt.providerUid, providerFolder: receipt.providerFolder, messageId: receipt.messageId, inReplyTo: receipt.inReplyTo, sentAt: acceptedAt }).where(eq(messages.id, claim.message.id));
      await tx.update(emailDispatches).set({ status: "sent", completedAt: acceptedAt }).where(eq(emailDispatches.id, claim.dispatch.id));
      await advanceFollowUp(tx, claim.dispatch, acceptedAt);
      await appendWorkflowEvent(tx, ownerId, "email.provider_accepted", claim.dispatch.id, 1, { messageId: claim.message.id, providerMessageId: receipt.providerMessageId });
    });
    await recordAudit({ ownerId, actorType: "system", action: "email.sent", resourceType: "message", resourceId: claim.message.id, metadata: { dispatchId: claim.dispatch.id, providerMessageId: receipt.providerMessageId } }).catch(() => {});
    return { success: true, status: "sent", providerMessageId: receipt.providerMessageId, dispatchId: claim.dispatch.id };
  } catch (error) {
    await db.transaction(async (tx: any) => {
      await tx.update(emailDispatches).set({ status: "reconciliation_required", lastError: "Delivery outcome is uncertain; reconcile before authorizing another attempt." }).where(eq(emailDispatches.id, claim.dispatch.id));
      await tx.update(messages).set({ status: "reconciliation_required" }).where(eq(messages.id, claim.message.id));
      await tx.insert(incidents).values({ id: createId("inc_"), ownerId, incidentType: "email_dispatch_reconciliation", severity: "high", status: "detected", affectedResourceType: "message", affectedResourceId: claim.message.id, summary: "Provider delivery outcome requires reconciliation. Automatic resend is disabled." });
      if (claim.dispatch.planId) {
        const plan = (await tx.select().from(followUpPlans).where(eq(followUpPlans.id, claim.dispatch.planId)).limit(1))[0];
        if (plan) await stopFollowUp(tx, plan, "blocked", "Delivery requires reconciliation.");
      }
    });
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Delivery requires reconciliation; no automatic resend will occur." });
  }
}
