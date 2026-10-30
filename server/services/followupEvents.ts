import { stopFollowUp } from "./workflowStore";
import { and, eq } from "drizzle-orm";
import { emailDispatches, followUpPlans, workflowEvents, workspaceSettings } from "../../drizzle/schema";
import { ensureWorkspace, requireDb } from "../db";
import { lockedSelect } from "./database";
import { stopRelatedFollowUps } from "./followups";

export async function stopOwnerFollowUps(ownerId: number, match: { candidateId?: string; conversationId?: string; recipientHash?: string; resourceType?: string; resourceId?: string }, status: "paused" | "cancelled" | "completed", reason: string, redact = false) {
  const db = await requireDb();
  await ensureWorkspace(ownerId);
  await db.transaction(async (tx: any) => {
    await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
    await stopRelatedFollowUps(tx, ownerId, match, reason, status);
    if (redact && match.candidateId) {
      const plans = await tx.select().from(followUpPlans).where(eq(followUpPlans.candidateId, match.candidateId));
      for (const plan of plans.filter((p: typeof followUpPlans.$inferSelect) => p.ownerId === ownerId)) {
        await tx.update(followUpPlans).set({ recipient: "erased", objective: "Erased candidate follow-up", steps: [], replyCursor: [], reason: "Candidate erasure" }).where(eq(followUpPlans.id, plan.id));
        await tx.update(workflowEvents).set({ metadata: { redacted: true, reason: "Candidate erasure" } }).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.aggregateId, plan.id)));
        const dispatches = await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ownerId), eq(emailDispatches.planId, plan.id)));
        for (const dispatch of dispatches) {
          const evidence = await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.aggregateId, dispatch.id)));
          for (const event of evidence.filter((e: typeof workflowEvents.$inferSelect) => ["email.reconciled", "email.reconciliation_inconclusive"].includes(e.eventType))) {
            const metadata = event.metadata as { resolutionHash?: string; outcome?: string };
            await tx.update(workflowEvents).set({ metadata: { redacted: true, resolutionHash: metadata?.resolutionHash, outcome: metadata?.outcome, source: "owner_recorded" } }).where(eq(workflowEvents.id, event.id));
          }
        }
      }
    }
  });
}

export async function blockFollowUpFailure(ownerId: number, input: { planId?: string; dispatchId?: string; revision?: number; stepIndex?: number }, reason: string) {
  const db = await requireDb();
  await db.transaction(async (tx: any) => {
    await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
    const dispatch = input.dispatchId ? (await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ownerId), eq(emailDispatches.id, input.dispatchId))).limit(1))[0] : null;
    const planId = input.planId ?? dispatch?.planId;
    if (!planId) return;
    const plan = (await lockedSelect(tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.id, planId))).limit(1)))[0];
    if (plan && ((dispatch && (dispatch.planRevision !== plan.revision || dispatch.stepIndex !== plan.stepIndex)) || (input.revision !== undefined && input.revision !== plan.revision))) return;
    if (plan && !["cancelled", "completed", "exhausted", "blocked"].includes(plan.status)) await stopFollowUp(tx, plan, "blocked", reason);
  });
}
