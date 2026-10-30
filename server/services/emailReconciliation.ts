import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { approvals, automationQueue, emailDispatches, followUpPlans, incidents, messages, workflowEvents, workspaceSettings } from "../../drizzle/schema";
import { requireDb } from "../db";
import { lockedSelect } from "./database";
import { appendWorkflowEvent, stopFollowUp, workflowHash, type FollowUpPlan } from "./workflowStore";

export const reconcileEmailInput = z.object({
  dispatchId: z.string().min(4), outcome: z.enum(["accepted", "not_accepted", "unknown"]),
  evidenceReference: z.string().trim().min(5).max(500), reason: z.string().trim().min(20).max(1500),
  acceptedAt: z.date().optional(), reviewedProviderEvidence: z.literal(true),
}).strict();

// This records a human's provider evidence. It does not infer acceptance from a
// timeout, an empty Sent-folder search, or a plausible subject/recipient match.
export async function reconcileEmailDispatch(ownerId: number, actorId: number, raw: z.input<typeof reconcileEmailInput>) {
  const input = reconcileEmailInput.parse(raw), db = await requireDb(), now = new Date();
  if (input.outcome === "accepted" && (!input.acceptedAt || input.acceptedAt > now)) throw new TRPCError({ code: "BAD_REQUEST", message: "Record the actual acceptance time, which cannot be in the future." });
  const resolutionHash = workflowHash([input.outcome, input.evidenceReference, input.acceptedAt?.toISOString() ?? null]);
  return db.transaction(async (tx: any) => {
    await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
    const dispatch = (await lockedSelect(tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ownerId), eq(emailDispatches.id, input.dispatchId))).limit(1)))[0];
    if (!dispatch) throw new TRPCError({ code: "NOT_FOUND", message: "Delivery was not found." });
    const previous = (await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.aggregateId, dispatch.id), eq(workflowEvents.eventType, "email.reconciled"))).limit(1))[0];
    if (previous) {
      if (previous.metadata?.resolutionHash !== resolutionHash) throw new TRPCError({ code: "CONFLICT", message: "This delivery already has a different recorded resolution." });
      return { status: dispatch.status, alreadyResolved: true };
    }
    if (dispatch.status !== "reconciliation_required") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only an uncertain completed attempt can be reconciled. An active or interrupted worker requires separate investigation." });
    const message = (await lockedSelect(tx.select().from(messages).where(and(eq(messages.ownerId, ownerId), eq(messages.id, dispatch.messageId))).limit(1)))[0];
    const approval = (await lockedSelect(tx.select().from(approvals).where(and(eq(approvals.ownerId, ownerId), eq(approvals.id, dispatch.approvalId))).limit(1)))[0];
    if (!message || !approval?.actionedAt || !dispatch.claimedAt || approval.actionType !== "email_send" || approval.resourceId !== message.id) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The original claimed delivery evidence is incomplete." });
    if (input.acceptedAt && input.acceptedAt.getTime() < dispatch.claimedAt.getTime() - 5 * 60000) throw new TRPCError({ code: "BAD_REQUEST", message: "Acceptance time must correspond to this delivery attempt." });
    const planRow = dispatch.planId ? (await lockedSelect(tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.id, dispatch.planId))).limit(1)))[0] : null;
    const plan = planRow ? { ...planRow } as FollowUpPlan : null;
    const erased = plan?.recipient === "erased";
    const evidence = { actorId, source: "owner_recorded", outcome: input.outcome, evidenceReference: erased ? null : input.evidenceReference, reason: erased ? "Candidate erasure" : input.reason, redacted: erased, acceptedAt: input.acceptedAt?.toISOString() ?? null, resolutionHash };
    if (input.outcome === "unknown") {
      await appendWorkflowEvent(tx, ownerId, "email.reconciliation_inconclusive", dispatch.id, 1, evidence, resolutionHash);
      return { status: "reconciliation_required", alreadyResolved: false };
    }
    const status = input.outcome === "accepted" ? "accepted_recorded" : "not_accepted_recorded";
    await tx.update(emailDispatches).set({ status, completedAt: now, lastError: null }).where(eq(emailDispatches.id, dispatch.id));
    // Keep approval consumption, original claim time and cap reservation intact.
    // Owner evidence is not a provider delivery webhook or a verified receipt ID.
    await tx.update(messages).set({ status }).where(eq(messages.id, message.id));
    await tx.update(automationQueue).set({ status: "cancelled", lockToken: null, lockedAt: null, lastError: "Delivery reconciled; any further send needs a new reviewed action." }).where(and(eq(automationQueue.ownerId, ownerId), eq(automationQueue.idempotencyKey, `email_dispatch:${dispatch.id}`), inArray(automationQueue.status, ["queued", "retryable_failed", "blocked"])));
    if (plan) {
      if (input.outcome === "accepted" && plan.steps.length && plan.stepIndex === dispatch.stepIndex && plan.revision >= dispatch.planRevision) {
        await tx.update(followUpPlans).set({ stepIndex: plan.stepIndex + 1 }).where(eq(followUpPlans.id, plan.id));
        await appendWorkflowEvent(tx, ownerId, "followup.acceptance_recorded", plan.id, plan.revision, { dispatchId: dispatch.id, source: "owner_recorded", actorId }, dispatch.id);
      }
      await stopFollowUp(tx, plan, "paused", "Delivery outcome recorded by owner; review before any further action.");
    }
    await tx.update(incidents).set({ status: "resolved", resolvedAt: now, containmentNotes: `Owner-recorded ${input.outcome}; evidence is retained in the delivery workflow history.` }).where(and(eq(incidents.ownerId, ownerId), eq(incidents.incidentType, "email_dispatch_reconciliation"), eq(incidents.affectedResourceId, message.id), inArray(incidents.status, ["detected", "investigating", "contained"])));
    await appendWorkflowEvent(tx, ownerId, "email.reconciled", dispatch.id, 1, evidence);
    return { status, alreadyResolved: false };
  });
}
