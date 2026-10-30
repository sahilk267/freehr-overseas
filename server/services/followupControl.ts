import { assertFollowUpRevision } from "./followupRecovery";
import { emailContentHash } from "./emailAuthorization";
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { automationGrants, emailDispatches, followUpPlans, approvals, messages, workspaceSettings } from "../../drizzle/schema";
import { createId, requireDb } from "../db";
import { lockedSelect } from "./database";
import { followUpEligibility, inboundCursor, enqueueEmailDispatch } from "./followups";
import { appendWorkflowEvent, grantScopeHash, scheduleFollowUp, stopFollowUp, type FollowUpPlan } from "./workflowStore";

export async function controlFollowUp(ownerId: number, planId: string, action: "pause" | "resume" | "cancel" | "complete", reason: string, expectedRevision?: number) {
  const db = await requireDb();
  return db.transaction(async (tx: any) => {
    await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
    const plan = (await lockedSelect(tx.select().from(followUpPlans).where(and(eq(followUpPlans.id, planId), eq(followUpPlans.ownerId, ownerId))).limit(1)))[0] as FollowUpPlan;
    if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "Follow-up was not found." });
    assertFollowUpRevision(plan, expectedRevision);
    if (["cancelled", "completed", "exhausted"].includes(plan.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This sequence has ended." });
    if (action !== "resume") {
      await stopFollowUp(tx, plan, action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "completed", reason);
      return { status: action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "completed" };
    }
    if (!["paused", "blocked"].includes(plan.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a paused or blocked follow-up can resume." });
    const unresolved = await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ownerId), eq(emailDispatches.planId, plan.id), inArray(emailDispatches.status, ["dispatching", "reconciliation_required"])));
    if (unresolved.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Reconcile the previous delivery before resuming." });
    const resumed = { ...plan, revision: plan.revision + 1, executionMode: "review", replyCursor: await inboundCursor(tx, ownerId, plan.conversationId), status: "scheduled", reason: null };
    const eligible = await followUpEligibility(tx, resumed);
    if (eligible.state !== "eligible") throw new TRPCError({ code: "PRECONDITION_FAILED", message: eligible.reason });
    await tx.update(followUpPlans).set({ revision: resumed.revision, executionMode: "review", replyCursor: resumed.replyCursor, status: "scheduled", reason: null }).where(eq(followUpPlans.id, plan.id));
    await scheduleFollowUp(tx, resumed, new Date());
    await appendWorkflowEvent(tx, ownerId, "followup.resumed", plan.id, resumed.revision, { reason, executionMode: "review" });
    return { status: "scheduled" };
  });
}

export async function grantFollowUpSending(ownerId: number, actorId: number, planId: string, expiresAt: Date, maxSends: number, expectedRevision?: number) {
  const db = await requireDb();
  return db.transaction(async (tx: any) => {
    await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
    const plan = (await lockedSelect(tx.select().from(followUpPlans).where(and(eq(followUpPlans.id, planId), eq(followUpPlans.ownerId, ownerId))).limit(1)))[0] as FollowUpPlan;
    if (!plan || !["scheduled", "waiting", "approval_pending"].includes(plan.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Follow-up is not active." });
    assertFollowUpRevision(plan, expectedRevision);
    const remaining = plan.steps.length - plan.stepIndex;
    if (!Number.isInteger(maxSends) || maxSends < 1 || maxSends > remaining || expiresAt <= new Date() || expiresAt > plan.deadlineAt || expiresAt.getTime() > Date.now() + 30 * 86400000) throw new TRPCError({ code: "BAD_REQUEST", message: "Permission must fit the remaining sequence, deadline and thirty-day maximum." });
    const eligible = await followUpEligibility(tx, plan);
    if (eligible.state !== "eligible") throw new TRPCError({ code: "PRECONDITION_FAILED", message: eligible.reason });
    await tx.update(automationGrants).set({ active: false }).where(and(eq(automationGrants.ownerId, ownerId), eq(automationGrants.planId, plan.id)));
    const grantId = createId("grt_");
    await tx.insert(automationGrants).values({ id: grantId, ownerId, planId, planRevision: plan.revision, scopeHash: grantScopeHash(plan), maxSends, expiresAt, active: true, createdById: actorId });
    await tx.update(followUpPlans).set({ executionMode: "delegated" }).where(eq(followUpPlans.id, plan.id));
    if (plan.status === "approval_pending") {
      const dispatch = (await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ownerId), eq(emailDispatches.planId, plan.id), eq(emailDispatches.planRevision, plan.revision), eq(emailDispatches.stepIndex, plan.stepIndex), eq(emailDispatches.status, "queued"))).limit(1))[0];
      if (!dispatch) throw new Error("Pending follow-up dispatch is missing.");
      const approval = (await tx.select().from(approvals).where(eq(approvals.id, dispatch.approvalId)).limit(1))[0];
      if (!approval || !["pending", "approved"].includes(approval.status) || approval.actionedAt) throw new Error("Pending follow-up authorization is no longer available.");
      const message = (await tx.select().from(messages).where(and(eq(messages.ownerId, ownerId), eq(messages.id, dispatch.messageId))).limit(1))[0];
      const step = plan.steps[plan.stepIndex];
      const payload = approval.payload as { senderIdentityId?: string; recipient?: string; contentHash?: string };
      if (!message || message.subject !== step.subject || message.body !== step.body || payload.senderIdentityId !== plan.senderIdentityId || payload.recipient !== plan.recipient || payload.contentHash !== emailContentHash({ senderIdentityId: plan.senderIdentityId, recipient: plan.recipient, subject: step.subject, body: step.body })) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Pending content changed; pause and review the sequence." });
      await tx.update(approvals).set({ status: "approved", decisionSource: "policy", decidedAt: new Date(), decidedById: actorId, payload: { ...(approval.payload as Record<string, unknown>), grantId } }).where(eq(approvals.id, approval.id));
      await tx.update(emailDispatches).set({ grantId }).where(eq(emailDispatches.id, dispatch.id));
      const dueAt = new Date();
      await enqueueEmailDispatch(tx, ownerId, dispatch.id, dueAt);
      await tx.update(followUpPlans).set({ nextActionAt: dueAt }).where(eq(followUpPlans.id, plan.id));
    }
    await appendWorkflowEvent(tx, ownerId, "followup.sending_delegated", plan.id, plan.revision, { grantId, maxSends, expiresAt: expiresAt.toISOString() }, grantId);
    return { grantId };
  });
}
