import { ACTIVE_COLLECTION_STATES } from "./collectionFacts";
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { candidates, contacts, conversations, emailDispatches, followUpPlans, workspaceSettings } from "../../drizzle/schema";
import { hashContactValue, requireDb } from "../db";
import { lockedSelect } from "./database";
import { followUpEligibility, followUpInput, inboundCursor } from "./followups";
import { appendWorkflowEvent, followUpEnrollmentKey, recordFollowUpDefinition, scheduleFollowUp, stopFollowUp, type FollowUpPlan } from "./workflowStore";
import { validateTimezone } from "./workflowTiming";

export const followUpDefinitionInput = followUpInput.pick({ objective: true, senderIdentityId: true, timezone: true, businessDaysOnly: true, startsAt: true, deadlineAt: true, responseWindowMinutes: true, steps: true }).strict();
export const replanFollowUpInput = z.object({ id: z.string().min(4), expectedRevision: z.number().int().positive(), reason: z.string().trim().min(8).max(500), definition: followUpDefinitionInput }).strict();
export const snoozeFollowUpInput = z.object({ id: z.string().min(4), expectedRevision: z.number().int().positive(), reason: z.string().trim().min(8).max(500), until: z.date() }).strict();

export function assertFollowUpRevision(plan: FollowUpPlan, expectedRevision?: number) {
  if (expectedRevision !== undefined && plan.revision !== expectedRevision) throw new TRPCError({ code: "CONFLICT", message: "This sequence changed. Refresh and review its current revision before acting." });
}

async function editablePlan(tx: any, ownerId: number, id: string, revision: number) {
  await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
  // Network completion locks the outbox before the plan; use the same order.
  const unresolved = await lockedSelect(tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ownerId), eq(emailDispatches.planId, id), inArray(emailDispatches.status, ["dispatching", "reconciliation_required"]))));
  if (unresolved.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Reconcile the previous delivery before editing or snoozing this sequence." });
  const row = (await lockedSelect(tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.id, id))).limit(1)))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Follow-up was not found." });
  const plan = { ...row } as FollowUpPlan;
  assertFollowUpRevision(plan, revision);
  if (plan.recipient === "erased" || !plan.steps.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "An erased follow-up cannot be restarted." });
  return plan;
}

export async function replanFollowUp(ownerId: number, actorId: number, raw: z.input<typeof replanFollowUpInput>) {
  const input = replanFollowUpInput.parse(raw), now = new Date(), definition = input.definition;
  validateTimezone(definition.timezone);
  const startsAt = new Date((definition.startsAt ?? now).getTime() + definition.steps[0].delayMinutes * 60000);
  if (definition.deadlineAt <= startsAt || definition.deadlineAt <= now || definition.deadlineAt.getTime() > now.getTime() + 366 * 86400000) throw new TRPCError({ code: "BAD_REQUEST", message: "Deadline must follow the start and be within one year." });
  const db = await requireDb();
  return db.transaction(async (tx: any) => {
    const plan = await editablePlan(tx, ownerId, input.id, input.expectedRevision);
    const conversation = (await lockedSelect(tx.select().from(conversations).where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, plan.conversationId))).limit(1)))[0];
    if (!conversation) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation was not found." });
    const table = conversation.candidateId ? candidates : contacts;
    const person = (await lockedSelect(tx.select().from(table).where(and(eq(table.ownerId, ownerId), eq(table.id, conversation.candidateId ?? conversation.contactId ?? ""))).limit(1)))[0];
    const recipient = z.string().email().parse(person?.email?.trim().toLowerCase());
    const next = { ...plan, ...definition, revision: plan.revision + 1, recipient, recipientHash: hashContactValue(recipient), resourceFingerprint: "", replyCursor: await inboundCursor(tx, ownerId, plan.conversationId), status: "scheduled", executionMode: "review", stepIndex: 0, reason: null, nextActionAt: startsAt } as FollowUpPlan;
    const eligible = await followUpEligibility(tx, next, now);
    if (eligible.state !== "eligible") throw new TRPCError({ code: "PRECONDITION_FAILED", message: eligible.reason });
    next.resourceFingerprint = eligible.fingerprint!;
    next.enrollmentKey = followUpEnrollmentKey(next);
    const collision = (await lockedSelect(tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.enrollmentKey, next.enrollmentKey))).limit(1)))[0];
    if (collision && collision.id !== plan.id) throw new TRPCError({ code: "CONFLICT", message: "Another sequence already owns this recipient and resource version. Open that sequence instead." });
    if (plan.resourceType === "invoice") {
      const active = await lockedSelect(tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.resourceType, "invoice"), eq(followUpPlans.resourceId, plan.resourceId), inArray(followUpPlans.status, ACTIVE_COLLECTION_STATES))).limit(2));
      if (active.some((p: FollowUpPlan) => p.id !== plan.id)) throw new TRPCError({ code: "CONFLICT", message: "Another active collection sequence owns this invoice." });
    }
    await recordFollowUpDefinition(tx, plan);
    await stopFollowUp(tx, plan, "paused", "Sequence replaced after owner review.");
    await tx.update(followUpPlans).set({ objective: next.objective, senderIdentityId: next.senderIdentityId, recipient, recipientHash: next.recipientHash, resourceFingerprint: next.resourceFingerprint, enrollmentKey: next.enrollmentKey, replyCursor: next.replyCursor, revision: next.revision, stepIndex: 0, steps: next.steps, timezone: next.timezone, businessDaysOnly: next.businessDaysOnly, responseWindowMinutes: next.responseWindowMinutes, deadlineAt: next.deadlineAt, status: "scheduled", executionMode: "review", reason: null }).where(and(eq(followUpPlans.id, plan.id), eq(followUpPlans.ownerId, ownerId)));
    await recordFollowUpDefinition(tx, next, actorId, input.reason);
    await scheduleFollowUp(tx, next, startsAt);
    await appendWorkflowEvent(tx, ownerId, "followup.replanned", plan.id, next.revision, { actorId, reason: input.reason, previousRevision: plan.revision, executionMode: "review" });
    return { id: plan.id, revision: next.revision, status: "scheduled" };
  });
}

export async function snoozeFollowUp(ownerId: number, actorId: number, raw: z.input<typeof snoozeFollowUpInput>) {
  const input = snoozeFollowUpInput.parse(raw), db = await requireDb();
  return db.transaction(async (tx: any) => {
    const plan = await editablePlan(tx, ownerId, input.id, input.expectedRevision);
    if (!["scheduled", "waiting", "approval_pending", "paused", "blocked"].includes(plan.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only an active or paused sequence can be snoozed." });
    if (input.until <= new Date() || input.until >= plan.deadlineAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Snooze time must be in the future and before the sequence deadline." });
    const next = { ...plan, revision: plan.revision + 1, status: "scheduled", executionMode: "review", reason: null, replyCursor: await inboundCursor(tx, ownerId, plan.conversationId) };
    const eligible = await followUpEligibility(tx, next);
    if (eligible.state !== "eligible") throw new TRPCError({ code: "PRECONDITION_FAILED", message: eligible.reason });
    await recordFollowUpDefinition(tx, plan);
    await stopFollowUp(tx, plan, "paused", "Owner snoozed the sequence.");
    await tx.update(followUpPlans).set({ revision: next.revision, status: "scheduled", executionMode: "review", replyCursor: next.replyCursor, reason: null }).where(eq(followUpPlans.id, plan.id));
    await recordFollowUpDefinition(tx, next, actorId, input.reason);
    await scheduleFollowUp(tx, next, input.until);
    await appendWorkflowEvent(tx, ownerId, "followup.snoozed", plan.id, next.revision, { actorId, reason: input.reason, until: input.until.toISOString(), previousRevision: plan.revision });
    return { id: plan.id, revision: next.revision, nextActionAt: input.until, status: "scheduled" };
  });
}
