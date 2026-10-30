import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { approvals, automationGrants, automationQueue, emailDispatches, followUpPlans, messages, workflowEvents } from "../../drizzle/schema";
import { createId } from "../db";

export const workflowHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type FollowUpPlan = typeof followUpPlans.$inferSelect;

export async function appendWorkflowEvent(tx: any, ownerId: number, eventType: string, aggregateId: string, revision: number, metadata: Record<string, unknown> = {}, discriminator = "") {
  const key = workflowHash([eventType, aggregateId, revision, discriminator]);
  const existing = (await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.eventKey, key))).limit(1))[0];
  if (existing) return;
  await tx.insert(workflowEvents).values({ id: createId("evt_"), ownerId, eventKey: key, eventType, aggregateId, revision, metadata });
}

export async function scheduleFollowUp(tx: any, plan: FollowUpPlan, at: Date) {
  at = new Date(Math.min(at.getTime(), plan.deadlineAt.getTime()));
  const key = `followup:${plan.id}:${plan.revision}:${plan.stepIndex}`;
  const existing = (await tx.select().from(automationQueue).where(eq(automationQueue.idempotencyKey, key)).limit(1))[0];
  const values = { status: "queued", scheduledAt: at, lockToken: null, lockedAt: null, lastError: null };
  if (!existing) await tx.insert(automationQueue).values({ id: createId("que_"), ownerId: plan.ownerId, jobType: "follow_up", payload: { planId: plan.id, revision: plan.revision, stepIndex: plan.stepIndex }, priority: 20, attempts: 0, maxAttempts: 3, idempotencyKey: key, ...values });
  else if (!["running", "completed"].includes(existing.status)) await tx.update(automationQueue).set(values).where(eq(automationQueue.id, existing.id));
  await tx.update(followUpPlans).set({ nextActionAt: at }).where(eq(followUpPlans.id, plan.id));
}

export async function stopFollowUp(tx: any, plan: FollowUpPlan, status: "paused" | "cancelled" | "completed" | "exhausted" | "blocked", reason: string) {
  // Keep the pre-transition revision stable, including in the local adapter.
  plan = { ...plan };
  if (["cancelled", "completed", "exhausted"].includes(plan.status)) return;
  await tx.update(followUpPlans).set({ status, reason, executionMode: "review", nextActionAt: null, revision: plan.revision + 1 }).where(and(eq(followUpPlans.id, plan.id), eq(followUpPlans.ownerId, plan.ownerId)));
  await tx.update(automationGrants).set({ active: false }).where(and(eq(automationGrants.ownerId, plan.ownerId), eq(automationGrants.planId, plan.id)));
  const pending = await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, plan.ownerId), eq(emailDispatches.planId, plan.id), eq(emailDispatches.status, "queued")));
  for (const dispatch of pending) {
    await tx.update(emailDispatches).set({ status: "cancelled", lastError: reason }).where(eq(emailDispatches.id, dispatch.id));
    await tx.update(messages).set({ status: "cancelled" }).where(and(eq(messages.ownerId, plan.ownerId), eq(messages.id, dispatch.messageId), eq(messages.status, "approval_pending")));
    await tx.update(approvals).set({ status: "cancelled" }).where(and(eq(approvals.id, dispatch.approvalId), inArray(approvals.status, ["pending", "approved"])));
  }
  const timerKeys = [`followup:${plan.id}:${plan.revision}:${plan.stepIndex}`, ...pending.map((dispatch: typeof emailDispatches.$inferSelect) => `email_dispatch:${dispatch.id}`)];
  await tx.update(automationQueue).set({ status: "cancelled", lockToken: null, lockedAt: null, lastError: reason }).where(and(eq(automationQueue.ownerId, plan.ownerId), inArray(automationQueue.idempotencyKey, timerKeys), inArray(automationQueue.status, ["queued", "retryable_failed"])));
  await appendWorkflowEvent(tx, plan.ownerId, `followup.${status}`, plan.id, plan.revision + 1, { reason });
}

export function grantScopeHash(plan: FollowUpPlan) {
  return workflowHash([plan.ownerId, plan.id, plan.revision, plan.scenarioId, plan.resourceType, plan.resourceId, plan.resourceFingerprint, plan.recipientHash, plan.senderIdentityId, plan.steps]);
}

export function followUpEnrollmentKey(plan: Pick<FollowUpPlan, "ownerId" | "scenarioId" | "resourceType" | "resourceId" | "recipientHash" | "resourceFingerprint">) {
  const key = workflowHash([plan.ownerId, plan.scenarioId, plan.resourceType, plan.resourceId, plan.recipientHash]);
  return workflowHash([key, plan.resourceType !== "conversation" ? plan.resourceFingerprint : ""]);
}

export async function recordFollowUpDefinition(tx: any, plan: FollowUpPlan, actorId?: number, reason?: string) {
  await appendWorkflowEvent(tx, plan.ownerId, "followup.definition_recorded", plan.id, plan.revision, { actorId: actorId ?? null, reason: reason ?? "Recorded existing sequence definition", definition: { objective: plan.objective, recipient: plan.recipient, scenarioId: plan.scenarioId, senderIdentityId: plan.senderIdentityId, resourceType: plan.resourceType, resourceId: plan.resourceId, resourceFingerprint: plan.resourceFingerprint, steps: plan.steps, timezone: plan.timezone, businessDaysOnly: plan.businessDaysOnly, responseWindowMinutes: plan.responseWindowMinutes, deadlineAt: plan.deadlineAt.toISOString() } });
}
