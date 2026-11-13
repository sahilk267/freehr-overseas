import {materializeSubmissionEmail} from './submissionMail';
import {applySubmissionApproval} from './submissionState';
import type {SubmissionMailScope} from './submissionMailScope';
import {applyOfferRelease} from './candidateOffers';
import {materializeOfferEmail} from './candidateOfferMail';
import {assertCurrentOfferAcceptance} from './candidateOfferState';
import type {OfferMailScope} from './offerMailScope';
import {placementLifecycleFingerprint,lifecyclePlanId} from './placementLifecycleState';
import {appendWorkflowEvent} from './workflowStore';
import {commercialEvent} from './commercialAgreements';
import {activatePlacementRetention,applyReplacementWorkflow} from './placementLifecycle';
import {commercialGuaranteeDates,commercialInvoiceIssue} from './commercialObligations';
import {validateReplyEmail} from "./replyMail";
import type {ReplyMailScope} from "./replyMailScope";
import {materializeAvailabilityEmail,revokePreparedPrivateLink} from "./availabilityMail";
import type {AvailabilityMailScope} from "./availabilityMailScope";
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
    "offer_release",
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

  if(approval.actionType==='offer_release'){await applyOfferRelease(db,approval,decidedAt,decidedById);return;}

  // Approval authorizes the immutable message record; it never sends an email.
  if (approval.actionType === "email_send") {
    const message = (await db.select().from(messages).where(and(eq(messages.id, approval.resourceId), eq(messages.ownerId, approval.ownerId))).limit(1))[0];
    const payload = approval.payload as { senderIdentityId?: string; recipient?: string; senderAddress?: string; senderPurpose?: string; contentHash?: string; privateLink?:AvailabilityMailScope; replyScope?:ReplyMailScope;offerScope?:OfferMailScope;submissionScope?:SubmissionMailScope } | null;
    const identity = payload?.senderIdentityId ? (await db.select().from(emailIdentities).where(and(eq(emailIdentities.id, payload.senderIdentityId), eq(emailIdentities.ownerId, approval.ownerId))).limit(1))[0] : null;
    if (!message || message.status !== "approval_pending" || !identity || identity.status !== "active" || !payload?.recipient) throw new Error("Email authorization is stale or incomplete.");
    if (payload.senderAddress !== identity.email || payload.senderPurpose !== identity.purpose) throw new Error("Sender identity changed; a new approval is required.");
    if (payload.contentHash !== emailContentHash({ senderIdentityId: identity.id, recipient: payload.recipient, subject: message.subject ?? "", body: message.body, privateLink:payload.privateLink, replyScope:payload.replyScope,offerScope:payload.offerScope,submissionScope:payload.submissionScope })) throw new Error("Email content changed; a new approval is required.");
    const suppressed = (await db.select().from(suppressionList).where(and(eq(suppressionList.ownerId, approval.ownerId), eq(suppressionList.valueHash, hashContactValue(payload.recipient)), eq(suppressionList.active, true))).limit(1))[0];
    if (suppressed) throw new Error("Email recipient is suppressed.");
    await validateReplyEmail(db, approval.ownerId, payload, message, decidedAt);
    await materializeAvailabilityEmail(db,approval.ownerId,payload,message,decidedAt);
    await materializeOfferEmail(db,approval.ownerId,payload,message,decidedAt);
    await materializeSubmissionEmail(db,approval.ownerId,payload,message,decidedAt);
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
    await applySubmissionApproval(db,approval);
    await db
      .update(shortlists)
      .set({
        status: "release_ready",
        sharedAt: null,
        shareExpiresAt: null,
      })
      .where(
        and(
          eq(shortlists.id, approval.resourceId),
          eq(shortlists.ownerId, approval.ownerId),
        ),
      );
  }

  if(approval.actionType==="candidate_share")await db.update(approvals).set({actionedAt:decidedAt}).where(and(eq(approvals.ownerId,approval.ownerId),eq(approvals.id,approval.id)));

  // 3) placement_confirmation
  if (approval.actionType === "placement_confirmation") {
    const payload = approval.payload as { joiningEvidence?: string[]; joiningAt?:string; placementSourceFingerprint?:string } | null;
    const placement=(await db.select().from(placements).where(and(eq(placements.ownerId,approval.ownerId),eq(placements.id,approval.resourceId))).limit(1))[0];
    if(!placement)throw Error("Owned placement was not found.");
    await assertCurrentOfferAcceptance(db,approval.ownerId,placement);
    if(placement.status!=='joining_pending'||payload?.placementSourceFingerprint&&payload.placementSourceFingerprint!==placementLifecycleFingerprint(placement))throw new Error('Joining approval is stale; review the current placement and request confirmation again.');
    if(!payload?.joiningEvidence?.length)throw new Error('Current joining evidence is required.');
    const retention=await commercialEvent(db,approval.ownerId,'placement.lifecycle_plan',lifecyclePlanId(placement.id,'retention'));
    if(retention?.metadata?.enabled&&!payload.joiningAt)throw new Error('An explicit actual joining date is required for the configured retention plan.');
    const joiningDate=payload.joiningAt?new Date(payload.joiningAt):decidedAt;
    const joiningAt=new Date(Math.floor(joiningDate.getTime()/1000)*1000);
    if(!Number.isFinite(joiningDate.getTime())||joiningDate>decidedAt||joiningDate.getTime()<decidedAt.getTime()-366*86400000)throw new Error('Actual joining date is invalid.');
    const { guaranteeStartAt, guaranteeEndAt } = await commercialGuaranteeDates(db,approval.ownerId,placement,joiningAt);
    await appendWorkflowEvent(db,approval.ownerId,'placement.lifecycle_joining_date',placement.id,1,{candidateId:placement.candidateId,joinedAt:joiningAt.toISOString(),confirmedAt:decidedAt.toISOString(),approvalId:approval.id,dateSource:payload.joiningAt?'explicit_owner_evidence':'legacy_confirmation_time',identityVerified:false});
    await db
      .update(placements)
      .set({
        status: "joining_confirmed",
        joiningConfirmedAt: joiningAt,
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

  if(approval.actionType==='placement_confirmation'){
    const joined=(await db.select().from(placements).where(and(eq(placements.ownerId,approval.ownerId),eq(placements.id,approval.resourceId))).limit(1))[0];
    if(joined)await activatePlacementRetention(db,approval.ownerId,joined);
  }

  // 4) invoice_issue
  if (approval.actionType === "invoice_issue") {
    const invoice=(await db.select().from(invoices).where(and(eq(invoices.ownerId,approval.ownerId),eq(invoices.id,approval.resourceId))).limit(1))[0];if(!invoice)throw Error("Owned invoice was not found.");
    const commercial=await commercialInvoiceIssue(db,approval.ownerId,invoice,decidedAt);
    await db
      .update(invoices)
      .set({
        status: "issued",
        issuedAt: decidedAt,
        ...commercial,
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
  if (approval.actionType === "replacement_case" && !await applyReplacementWorkflow(db,approval,decidedAt,decidedById)) {
    if(await commercialEvent(db,approval.ownerId,"replacement.workflow_opened",approval.resourceId))throw new Error("A replacement workflow already owns this placement obligation; the legacy approval is stale.");
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
    if (["candidate_share","email_send","placement_confirmation","replacement_case","offer_release"].includes(approval.actionType) || approval.actionType.startsWith("invoice_")) await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, approval.ownerId)).limit(1));
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
      if ((current.payload as {replyScope?:ReplyMailScope}|null)?.replyScope) {
        await tx.update(emailDispatches).set({status:"cancelled",lastError:"Owner rejected client response."}).where(and(eq(emailDispatches.ownerId,current.ownerId),eq(emailDispatches.approvalId,current.id),eq(emailDispatches.status,"queued")));
        await tx.update(messages).set({status:"cancelled"}).where(and(eq(messages.ownerId,current.ownerId),eq(messages.id,current.resourceId),eq(messages.status,"approval_pending")));
      }
      const privateLink=(current.payload as {privateLink?:AvailabilityMailScope}|null)?.privateLink;
      if(privateLink){
        await tx.update(emailDispatches).set({status:"cancelled",lastError:"Owner rejected private link delivery."}).where(and(eq(emailDispatches.ownerId,current.ownerId),eq(emailDispatches.approvalId,current.id)));
        await tx.update(messages).set({status:"cancelled"}).where(and(eq(messages.ownerId,current.ownerId),eq(messages.id,current.resourceId)));
        await revokePreparedPrivateLink(tx,current.ownerId,privateLink);
      }
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

    if(result.alreadyDecided)return result;
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
