import { and, eq } from "drizzle-orm";
import {
  approvals,
  automationQueue,
  companies,
  invoices,
  placements,
  screenings,
  shortlists,
  workspaceSettings,
} from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
import { findMatchingRule, getPolicyGraceMinutes } from "./policyEngine";

export const consequentialActionTypes = new Set([
  "candidate_final_decision",
  "replacement_case",
  "invoice_payment_status",
  "invoice_dispute",
  "invoice_credit",
]);

export interface ApprovalRecord {
  id: string;
  ownerId: number;
  actionType: string;
  resourceType: string;
  resourceId: string;
  status: string;
  reason?: string | null;
  payload?: unknown;
  decidedById?: number | null;
  decidedAt?: Date | null;
  decisionSource?: "manual" | "policy" | null;
}

export async function recordDecision(
  db: any,
  approvalId: string,
  decision: "approved" | "rejected",
  decidedById: number,
  decidedAt: Date,
  reason?: string | null,
  source: "manual" | "policy" = "manual",
) {
  await db
    .update(approvals)
    .set({
      status: decision,
      decidedById,
      decidedAt,
      reason,
      decisionSource: source,
    })
    .where(eq(approvals.id, approvalId));
}

export async function applySideEffect(
  db: any,
  approval: ApprovalRecord,
  decidedAt: Date,
  decidedById: number,
) {
  // 1) client_onboarding
  if (approval.actionType === "client_onboarding") {
    await db
      .update(companies)
      .set({
        pipelineState: "active",
        companyType: "client",
        verificationState: "verified",
        onboardingApprovedAt: decidedAt,
        onboardingApprovedById: decidedById,
      })
      .where(
        and(
          eq(companies.id, approval.resourceId),
          eq(companies.ownerId, approval.ownerId),
        ),
      );
  }

  // 2) candidate_share
  if (approval.actionType === "candidate_share") {
    await db
      .update(shortlists)
      .set({
        status: "shared",
        sharedAt: decidedAt,
        shareExpiresAt: new Date(decidedAt.getTime() + 1000 * 60 * 60 * 24 * 14),
      })
      .where(
        and(
          eq(shortlists.id, approval.resourceId),
          eq(shortlists.ownerId, approval.ownerId),
        ),
      );
  }

  // 3) placement_confirmation
  if (approval.actionType === "placement_confirmation") {
    const payload = approval.payload as { joiningEvidence?: string[] } | null;
    await db
      .update(placements)
      .set({
        status: "joining_confirmed",
        joiningConfirmedAt: decidedAt,
        joiningEvidence: payload?.joiningEvidence ?? null,
      })
      .where(
        and(
          eq(placements.id, approval.resourceId),
          eq(placements.ownerId, approval.ownerId),
        ),
      );
  }

  // 4) invoice_issue
  if (approval.actionType === "invoice_issue") {
    await db
      .update(invoices)
      .set({
        status: "issued",
        issuedAt: decidedAt,
      })
      .where(
        and(
          eq(invoices.id, approval.resourceId),
          eq(invoices.ownerId, approval.ownerId),
        ),
      );
  }

  // 5) candidate_final_decision
  if (approval.actionType === "candidate_final_decision") {
    await db
      .update(screenings)
      .set({
        status: "owner_decided",
      })
      .where(eq(screenings.id, approval.resourceId));
  }

  // 6) replacement_case
  if (approval.actionType === "replacement_case") {
    await db
      .update(placements)
      .set({
        status: "replacement_requested",
        replacementRequestedAt: decidedAt,
      })
      .where(eq(placements.id, approval.resourceId));
  }

  // 7) invoice_payment_status
  if (approval.actionType === "invoice_payment_status") {
    const payload = approval.payload as { status?: string } | null;
    await db
      .update(invoices)
      .set({
        status: payload?.status ?? "payment_pending",
        paidAt: payload?.status === "paid" ? decidedAt : null,
      })
      .where(eq(invoices.id, approval.resourceId));
  }

  // 8) invoice_dispute
  if (approval.actionType === "invoice_dispute") {
    const payload = approval.payload as { evidence?: string } | null;
    await db
      .update(invoices)
      .set({
        status: "disputed",
        disputeReason: payload?.evidence ?? null,
      })
      .where(eq(invoices.id, approval.resourceId));
  }

  // 9) invoice_credit
  if (approval.actionType === "invoice_credit") {
    await db
      .update(invoices)
      .set({
        status: "credited",
      })
      .where(eq(invoices.id, approval.resourceId));
  }
}

export async function applyApprovalDecision(
  db: any,
  approval: ApprovalRecord,
  decision: "approved" | "rejected",
  decidedById: number,
  note?: string,
  source: "manual" | "policy" = "manual",
) {
  const decidedAt = new Date();
  const finalReason = note ?? approval.reason;

  // 1. Update the approvals row
  await recordDecision(
    db,
    approval.id,
    decision,
    decidedById,
    decidedAt,
    finalReason,
    source,
  );

  // 2. Run side-effects for all 9 action types when approved
  if (decision === "approved") {
    await applySideEffect(db, approval, decidedAt, decidedById);
  }

  // 3. Record audit event with the same shape plus source in metadata
  const actionPrefix = consequentialActionTypes.has(approval.actionType)
    ? "consequential"
    : "approval";

  await recordAudit({
    ownerId: approval.ownerId,
    actorType: "user",
    actorId: String(decidedById),
    action: `${actionPrefix}.${decision}`,
    resourceType: approval.resourceType,
    resourceId: approval.resourceId,
    metadata: {
      actionType: approval.actionType,
      approvalId: approval.id,
      source,
    },
  });

  return { success: true };
}

export async function requestOrAutoDecide(
  ctx: {
    user: { id: number };
    workspace?: { ownerId?: number } | null;
    [key: string]: unknown;
  },
  actionType: string,
  resourceType: string,
  resourceId: string,
  reason: string,
  payload?: Record<string, unknown>,
): Promise<{ approvalId: string; autoDecided: boolean }> {
  const db = await requireDb();
  const ownerId = ctx.workspace?.ownerId ?? ctx.user.id;

  // Load ctx.workspace's policyConfig (reuse existing workspaceSettings lookup pattern from queue.ts)
  const workspace = (
    await db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.ownerId, ownerId))
      .limit(1)
  )[0];
  const policyConfig = workspace?.policyConfig;

  const safePayload = payload ?? {};
  const matchedRule = findMatchingRule(policyConfig, actionType, safePayload);
  const shouldAutoApprove = matchedRule !== null;

  const approvalId = createId("apr_");
  const now = new Date();

  if (shouldAutoApprove) {
    const graceMinutes = getPolicyGraceMinutes(policyConfig, actionType, matchedRule);
    const isDelayed = typeof graceMinutes === "number" && graceMinutes > 0;

    // Insert the approval row with status "approved", decidedById: ownerId, decidedAt: now, decisionSource: "policy"
    await db.insert(approvals).values({
      id: approvalId,
      ownerId,
      requestedBy: "system",
      actionType,
      resourceType,
      resourceId,
      status: "approved",
      reason,
      payload: safePayload,
      decidedById: ownerId,
      decidedAt: now,
      decisionSource: "policy",
    });

    if (isDelayed) {
      const scheduledAt = new Date(now.getTime() + graceMinutes * 60 * 1000);
      const queueJobId = createId("que_");

      await db.insert(automationQueue).values({
        id: queueJobId,
        ownerId,
        jobType: "execute_policy_decision",
        status: "queued",
        priority: 100,
        attempts: 0,
        maxAttempts: 3,
        payload: {
          approvalId,
          actionType,
          resourceType,
          resourceId,
          reason,
          payload: safePayload,
          decidedById: ownerId,
          decidedAt: now.toISOString(),
        },
        idempotencyKey: `exec_policy:${approvalId}`,
        scheduledAt,
      });

      await recordAudit({
        ownerId,
        actorType: "system",
        action: "automation.queued",
        resourceType: "automation_job",
        resourceId: queueJobId,
        nextState: "queued",
        metadata: {
          jobType: "execute_policy_decision",
          approvalId,
          actionType,
          scheduledAt: scheduledAt.toISOString(),
          graceMinutes,
        },
      });

      await recordAudit({
        ownerId,
        actorType: "system",
        action: "approval.auto_decided",
        resourceType,
        resourceId,
        nextState: "approved",
        metadata: {
          actionType,
          reason,
          approvalId,
          source: "policy",
          delayed: true,
          graceMinutes,
          queueJobId,
          ...(matchedRule?.id ? { ruleId: matchedRule.id } : {}),
          ...(matchedRule?.name ? { ruleName: matchedRule.name } : {}),
        },
      });

      return { approvalId, autoDecided: true };
    }

    // Immediate execution: call applySideEffect directly without delay
    await applySideEffect(
      db,
      {
        id: approvalId,
        ownerId,
        actionType,
        resourceType,
        resourceId,
        status: "approved",
        reason,
        payload: safePayload,
        decidedById: ownerId,
        decidedAt: now,
        decisionSource: "policy",
      },
      now,
      ownerId,
    );

    // Record audit row for auto_decided with matched rule id/name if available
    await recordAudit({
      ownerId,
      actorType: "system",
      action: "approval.auto_decided",
      resourceType,
      resourceId,
      nextState: "approved",
      metadata: {
        actionType,
        reason,
        approvalId,
        source: "policy",
        delayed: false,
        ...(matchedRule?.id ? { ruleId: matchedRule.id } : {}),
        ...(matchedRule?.name ? { ruleName: matchedRule.name } : {}),
      },
    });

    return { approvalId, autoDecided: true };
  } else {
    // Insert as "pending" exactly as today
    await db.insert(approvals).values({
      id: approvalId,
      ownerId,
      requestedBy: "system",
      actionType,
      resourceType,
      resourceId,
      status: "pending",
      reason,
      payload: safePayload,
      decisionSource: "manual",
    });

    // Record audit row for pending approval request
    await recordAudit({
      ownerId,
      actorType: "system",
      action: "approval.requested",
      resourceType,
      resourceId,
      nextState: "pending",
      metadata: {
        actionType,
        reason,
        approvalId,
      },
    });

    return { approvalId, autoDecided: false };
  }
}
