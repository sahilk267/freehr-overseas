import { stopFollowUp } from "./workflowStore";
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
  messages,
  payments,
  emailIdentities,
  suppressionList,
  emailDispatches,
  followUpPlans,
} from "../../drizzle/schema";
import { createId, hashContactValue, recordAudit, requireDb } from "../db";
import { assertSharingEligible } from "./sharingEligibility";
import { lockedSelect } from "./database";
import { emailContentHash } from "./emailAuthorization";
import { enqueueEmailDispatch, followUpEligibility } from "./followups";
import { findMatchingRule, getPolicyGraceMinutes } from "./policyEngine";
import {
  assertTransition,
  CONSEQUENTIAL_ACTION_TYPES,
  getConsequentialActionDefinition,
  isConsequentialAction,
} from "../workflow";
import { calculateGuaranteeDates } from "./guaranteeTracking";

export const consequentialActionTypes = CONSEQUENTIAL_ACTION_TYPES;

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
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")));
}

export async function applySideEffect(
  db: any,
  approval: ApprovalRecord,
  decidedAt: Date,
  decidedById: number,
) {
  const recognizedSideEffectActions = new Set([
    "client_onboarding",
    "candidate_share",
    "placement_confirmation",
    "invoice_issue",
    "candidate_final_decision",
    "final_candidate_decision",
    "replacement_case",
    "invoice_payment_status",
    "invoice_dispute",
    "invoice_credit",
    "invoice_write_off",
    "automation_stop",
    "email_send",
  ]);

  if (!recognizedSideEffectActions.has(approval.actionType)) {
    throw new Error(
      `Unsupported consequential action side effect: "${approval.actionType}". Cannot execute unverified domain side effect.`,
    );
  }

  // Approval authorizes the immutable message record; it never sends an email.
  if (approval.actionType === "email_send") {
    const message = (await db.select().from(messages).where(and(eq(messages.id, approval.resourceId), eq(messages.ownerId, approval.ownerId))).limit(1))[0];
    const payload = approval.payload as { senderIdentityId?: string; recipient?: string; senderAddress?: string; senderPurpose?: string; contentHash?: string } | null;
    const identity = payload?.senderIdentityId ? (await db.select().from(emailIdentities).where(and(eq(emailIdentities.id, payload.senderIdentityId), eq(emailIdentities.ownerId, approval.ownerId))).limit(1))[0] : null;
    if (!message || message.status !== "approval_pending" || !identity || identity.status !== "active" || !payload?.recipient) throw new Error("Email authorization is stale or incomplete.");
    if (payload.senderAddress !== identity.email || payload.senderPurpose !== identity.purpose) throw new Error("Sender identity changed; a new approval is required.");
    if (payload.contentHash !== emailContentHash({ senderIdentityId: identity.id, recipient: payload.recipient, subject: message.subject ?? "", body: message.body })) throw new Error("Email content changed; a new approval is required.");
    const suppressed = (await db.select().from(suppressionList).where(and(eq(suppressionList.ownerId, approval.ownerId), eq(suppressionList.valueHash, hashContactValue(payload.recipient)), eq(suppressionList.active, true))).limit(1))[0];
    if (suppressed) throw new Error("Email recipient is suppressed.");
    const dispatch = (await db.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, approval.ownerId), eq(emailDispatches.approvalId, approval.id))).limit(1))[0];
    if (dispatch) {
      if (dispatch.status !== "queued") throw new Error("Dispatch is no longer pending authorization.");
      if (dispatch.planId) {
        const plan = (await db.select().from(followUpPlans).where(and(eq(followUpPlans.id, dispatch.planId), eq(followUpPlans.ownerId, approval.ownerId))).limit(1))[0];
        if (!plan || plan.revision !== dispatch.planRevision || plan.status !== "approval_pending") throw new Error("Follow-up approval is stale.");
        const eligible = await followUpEligibility(db, plan);
        if (eligible.state !== "eligible") throw new Error(eligible.reason);
      }
      const dueAt = new Date();
      await enqueueEmailDispatch(db, approval.ownerId, dispatch.id, dueAt);
      if (dispatch.planId) await db.update(followUpPlans).set({ nextActionAt: dueAt }).where(and(eq(followUpPlans.id, dispatch.planId), eq(followUpPlans.ownerId, approval.ownerId)));
    }
    return;
  }

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
    const shortlist = (await db.select().from(shortlists).where(and(eq(shortlists.id, approval.resourceId), eq(shortlists.ownerId, approval.ownerId))).limit(1))[0];
    if (!shortlist || !["prepared", "approval_pending"].includes(shortlist.status)) throw new Error("Shortlist sharing approval is stale.");
    await assertSharingEligible(db, { ownerId: approval.ownerId, candidateId: shortlist.candidateId, jobId: shortlist.jobId, companyId: shortlist.companyId }, true);
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
    const { guaranteeStartAt, guaranteeEndAt } = calculateGuaranteeDates(decidedAt);
    await db
      .update(placements)
      .set({
        status: "joining_confirmed",
        joiningConfirmedAt: decidedAt,
        joiningEvidence: payload?.joiningEvidence ?? null,
        guaranteeStartAt,
        guaranteeEndAt,
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

  // 5) candidate_final_decision & alias final_candidate_decision
  if (approval.actionType === "candidate_final_decision" || approval.actionType === "final_candidate_decision") {
    await db
      .update(screenings)
      .set({
        status: "owner_decided",
      })
      .where(
        and(
          eq(screenings.id, approval.resourceId),
          eq(screenings.ownerId, approval.ownerId),
        ),
      );
  }

  // 6) replacement_case
  if (approval.actionType === "replacement_case") {
    await db
      .update(placements)
      .set({
        status: "replacement_requested",
        replacementRequestedAt: decidedAt,
      })
      .where(
        and(
          eq(placements.id, approval.resourceId),
          eq(placements.ownerId, approval.ownerId),
        ),
      );
  }

  if (["invoice_payment_status", "invoice_dispute", "invoice_credit", "invoice_write_off"].includes(approval.actionType)) {
    const invoice = (await lockedSelect(db.select().from(invoices).where(and(eq(invoices.id, approval.resourceId), eq(invoices.ownerId, approval.ownerId))).limit(1)))[0];
    if (!invoice) throw new Error("Invoice not found.");
    const target = approval.actionType === "invoice_payment_status" ? (approval.payload as { status?: string } | null)?.status ?? "payment_pending" : approval.actionType === "invoice_dispute" ? "disputed" : approval.actionType === "invoice_credit" ? "credited" : "written_off";
    if (invoice.status !== target) assertTransition("invoice", invoice.status, target);
  }

  // 7) invoice_payment_status
  if (approval.actionType === "invoice_payment_status") {
    const payload = approval.payload as { status?: string } | null;
    if (["paid", "partially_paid"].includes(payload?.status ?? "")) {
      const invoice = (await lockedSelect(db.select().from(invoices).where(and(eq(invoices.id, approval.resourceId), eq(invoices.ownerId, approval.ownerId))).limit(1)))[0];
      if (!invoice) throw new Error("Invoice not found.");
      const receipts = await db.select().from(payments).where(and(eq(payments.invoiceId, invoice.id), eq(payments.ownerId, approval.ownerId), eq(payments.status, "succeeded")));
      const received = receipts.filter((receipt: typeof payments.$inferSelect) => receipt.currency === (invoice.currency ?? "INR")).reduce((sum: number, receipt: typeof payments.$inferSelect) => sum + receipt.amount, 0);
      const total = invoice.amount + (invoice.taxAmount ?? 0);
      if (payload?.status === "paid" ? received < total : received <= 0 || received >= total) throw new Error("Settlement status requires matching payment receipts; record the evidenced receipt first.");
    }
    await db
      .update(invoices)
      .set({
        status: payload?.status ?? "payment_pending",
        paidAt: payload?.status === "paid" ? decidedAt : null,
      })
      .where(
        and(
          eq(invoices.id, approval.resourceId),
          eq(invoices.ownerId, approval.ownerId),
        ),
      );
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
      .where(
        and(
          eq(invoices.id, approval.resourceId),
          eq(invoices.ownerId, approval.ownerId),
        ),
      );
  }

  // 9) invoice_credit
  if (approval.actionType === "invoice_credit") {
    await db
      .update(invoices)
      .set({
        status: "credited",
      })
      .where(
        and(
          eq(invoices.id, approval.resourceId),
          eq(invoices.ownerId, approval.ownerId),
        ),
      );
  }

  // 10) invoice_write_off
  if (approval.actionType === "invoice_write_off") {
    await db
      .update(invoices)
      .set({
        status: "written_off",
      })
      .where(and(eq(invoices.id, approval.resourceId), eq(invoices.ownerId, approval.ownerId)));
  }

  // 11) automation_stop
  if (approval.actionType === "automation_stop") {
    await db
      .update(workspaceSettings)
      .set({
        emergencyStop: true,
      })
      .where(eq(workspaceSettings.ownerId, approval.ownerId));
  }
}

export async function applyApprovalDecision(
  db: any,
  approval: ApprovalRecord,
  decision: "approved" | "rejected",
  decidedById: number,
  note?: string,
  source: "manual" | "policy" = "manual",
  auditPrefix: "approval" | "consequential" = "approval",
) {
  const decidedAt = new Date();
  const finalReason = note ?? approval.reason;

  const runDecisionTransaction = async (tx: any) => {
    if (approval.actionType === "email_send" || approval.actionType.startsWith("invoice_")) await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, approval.ownerId)).limit(1));
    // 1. Fetch current status within transaction to enforce concurrency and idempotency
    const current = (
      await lockedSelect(tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, approval.id), eq(approvals.ownerId, approval.ownerId)))
        .limit(1))
    )[0];

    if (!current) throw new Error("Approval was not found.");

    if (current && current.status !== "pending") {
      // Idempotent return if already decided with identical decision
      if (current.status === decision) {
        return { success: true, alreadyDecided: true };
      }
      throw new Error(`Approval ${approval.id} has already been decided (${current.status}).`);
    }

    // 2. Record decision in approvals row
    await recordDecision(
      tx,
      approval.id,
      decision,
      decidedById,
      decidedAt,
      finalReason,
      source,
    );

    // 3. Apply side-effect if approved
    if (decision === "approved") {
      await applySideEffect(tx, current, decidedAt, decidedById);
    } else if (current.actionType === "email_send") {
      const dispatch = (await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, current.ownerId), eq(emailDispatches.approvalId, current.id))).limit(1))[0];
      if (dispatch?.planId) {
        const plan = (await tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, current.ownerId), eq(followUpPlans.id, dispatch.planId))).limit(1))[0];
        if (plan) await stopFollowUp(tx, plan, "paused", "Owner rejected the pending message.");
      }
    }

    return { success: true };
  };

  try {
    let result: { success: boolean; alreadyDecided?: boolean };
    if (typeof db?.transaction === "function") {
      result = await db.transaction(runDecisionTransaction);
    } else {
      result = await runDecisionTransaction(db);
    }

    // 4. Record audit on successful commit
    await recordAudit({
      ownerId: approval.ownerId,
      actorType: "user",
      actorId: String(decidedById),
      action: `${auditPrefix}.${decision}`,
      resourceType: approval.resourceType,
      resourceId: approval.resourceId,
      metadata: {
        actionType: approval.actionType,
        approvalId: approval.id,
        source,
      },
    });

    return result;
  } catch (error) {
    try {
      await recordAudit({
        ownerId: approval.ownerId,
        actorType: "user",
        actorId: String(decidedById),
        action: "approval.execution_failed",
        resourceType: approval.resourceType,
        resourceId: approval.resourceId,
        metadata: {
          actionType: approval.actionType,
          approvalId: approval.id,
          source,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // ignore secondary audit error
    }
    throw error;
  }
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

  const actionDef = getConsequentialActionDefinition(actionType);
  const allowAutoApproval = actionDef ? actionDef.allowAutoApproval : true;

  const safePayload = payload ?? {};
  const matchedRule = allowAutoApproval
    ? findMatchingRule(policyConfig, actionType, safePayload)
    : null;
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
