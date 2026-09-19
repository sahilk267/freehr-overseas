import { describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  approvals,
  auditEvents,
  companies,
  invoices,
  placements,
  screenings,
  shortlists,
} from "../../drizzle/schema";
import { createId, requireDb } from "../db";
import { recruitmentRouter } from "../routers/recruitment";
import { applyApprovalDecision, consequentialActionTypes } from "./approvalEngine";

describe("approvalEngine and decide() endpoints", () => {
  const ownerId = 1;
  const ownerCtx = {
    user: { id: ownerId, role: "admin", name: "Owner", email: "owner@freelancehr.local" },
    req: {},
    res: {},
  } as never;

  const caller = recruitmentRouter.createCaller(ownerCtx);

  async function getAuditForApproval(approvalId: string) {
    const db = await requireDb();
    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.ownerId, ownerId))
      .orderBy(desc(auditEvents.createdAt));
    return rows.find((r: any) => (r.metadata as any)?.approvalId === approvalId);
  }

  describe("approvalsRouter.decide() - 4 standard approval action types", () => {
    it("1. client_onboarding: approves company, transitions to active client, records audit with source=manual", async () => {
      const db = await requireDb();
      const companyId = createId("cmp_test_");
      await db.insert(companies).values({
        id: companyId,
        ownerId,
        name: "Acme Corp",
        pipelineState: "converted",
        companyType: "prospect",
        verificationState: "pending",
      });

      const approvalId = createId("apr_test_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "client_onboarding",
        resourceType: "company",
        resourceId: companyId,
        reason: "Client onboarding approval required",
      });

      const res = await caller.approvals.decide({
        id: approvalId,
        decision: "approved",
        note: "Approved by owner review",
      });
      expect(res.success).toBe(true);

      // Verify approval row state
      const [apr] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
      expect(apr.status).toBe("approved");
      expect(apr.decidedById).toBe(ownerId);
      expect(apr.decidedAt).toBeInstanceOf(Date);
      expect(apr.reason).toBe("Approved by owner review");
      expect(apr.decisionSource).toBe("manual");

      // Verify company state side-effect
      const [cmp] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(cmp.pipelineState).toBe("active");
      expect(cmp.companyType).toBe("client");
      expect(cmp.verificationState).toBe("verified");
      expect(cmp.onboardingApprovedAt).toBeInstanceOf(Date);
      expect(cmp.onboardingApprovedById).toBe(ownerId);

      // Verify audit row
      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.action).toBe("approval.approved");
      expect(audit.actorType).toBe("user");
      expect(audit.actorId).toBe(String(ownerId));
      expect(audit.resourceType).toBe("company");
      expect(audit.resourceId).toBe(companyId);
      expect(audit.metadata).toMatchObject({
        actionType: "client_onboarding",
        approvalId,
        source: "manual",
      });
    });

    it("2. candidate_share: approves shortlist sharing, updates status and share expiry, records audit", async () => {
      const db = await requireDb();
      const shortlistId = createId("shl_test_");
      await db.insert(shortlists).values({
        id: shortlistId,
        ownerId,
        companyId: "cmp_test_dummy",
        jobId: "job_test_dummy",
        status: "prepared",
      });

      const approvalId = createId("apr_test_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "candidate_share",
        resourceType: "shortlist",
        resourceId: shortlistId,
        reason: "Candidate share approval requested",
      });

      const res = await caller.approvals.decide({
        id: approvalId,
        decision: "approved",
      });
      expect(res.success).toBe(true);

      // Verify shortlist side-effect
      const [shl] = await db.select().from(shortlists).where(eq(shortlists.id, shortlistId));
      expect(shl.status).toBe("shared");
      expect(shl.sharedAt).toBeInstanceOf(Date);
      expect(shl.shareExpiresAt).toBeInstanceOf(Date);
      expect(shl.shareExpiresAt!.getTime()).toBeGreaterThan(Date.now());

      // Verify audit row
      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.action).toBe("approval.approved");
      expect(audit.metadata).toMatchObject({
        actionType: "candidate_share",
        approvalId,
        source: "manual",
      });
    });

    it("3. placement_confirmation: confirms placement and joining evidence, records audit", async () => {
      const db = await requireDb();
      const placementId = createId("plc_test_");
      await db.insert(placements).values({
        id: placementId,
        ownerId,
        companyId: "cmp_test_dummy",
        jobId: "job_test_dummy",
        candidateId: "can_test_dummy",
        status: "offer_accepted",
      });

      const approvalId = createId("apr_test_");
      const evidence = ["employment_contract_signed.pdf", "welcome_email.eml"];
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "placement_confirmation",
        resourceType: "placement",
        resourceId: placementId,
        reason: "Placement confirmation with joining proof",
        payload: { joiningEvidence: evidence },
      });

      const res = await caller.approvals.decide({
        id: approvalId,
        decision: "approved",
      });
      expect(res.success).toBe(true);

      // Verify placement side-effect
      const [plc] = await db.select().from(placements).where(eq(placements.id, placementId));
      expect(plc.status).toBe("joining_confirmed");
      expect(plc.joiningConfirmedAt).toBeInstanceOf(Date);
      expect(plc.joiningEvidence).toEqual(evidence);

      // Verify audit row
      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.action).toBe("approval.approved");
      expect(audit.metadata).toMatchObject({
        actionType: "placement_confirmation",
        approvalId,
        source: "manual",
      });
    });

    it("4. invoice_issue: marks invoice issued with timestamp, records audit", async () => {
      const db = await requireDb();
      const invoiceId = createId("inv_test_");
      await db.insert(invoices).values({
        id: invoiceId,
        ownerId,
        companyId: "cmp_test_dummy",
        placementId: "plc_test_dummy",
        invoiceNumber: `INV-${Date.now()}-ISSUE`,
        status: "approval_pending",
        amount: 150000,
      });

      const approvalId = createId("apr_test_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "invoice_issue",
        resourceType: "invoice",
        resourceId: invoiceId,
        reason: "Issue approval required",
      });

      const res = await caller.approvals.decide({
        id: approvalId,
        decision: "approved",
      });
      expect(res.success).toBe(true);

      // Verify invoice side-effect
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(inv.status).toBe("issued");
      expect(inv.issuedAt).toBeInstanceOf(Date);

      // Verify audit row
      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.action).toBe("approval.approved");
      expect(audit.metadata).toMatchObject({
        actionType: "invoice_issue",
        approvalId,
        source: "manual",
      });
    });
  });

  describe("consequentialRouter.decide() - 5 consequential action types", () => {
    it("5. candidate_final_decision: advances screening to owner_decided, records consequential audit", async () => {
      const db = await requireDb();
      const screeningId = createId("scr_test_");
      await db.insert(screenings).values({
        id: screeningId,
        ownerId,
        candidateId: "can_test_dummy",
        jobId: "job_test_dummy",
        status: "decision_pending",
      });

      const approvalId = createId("apr_test_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "candidate_final_decision",
        resourceType: "screening",
        resourceId: screeningId,
        reason: "Consequential candidate progression decision",
      });

      const res = await caller.consequential.decide({
        approvalId,
        decision: "approved",
        note: "Candidate validated for hire",
      });
      expect(res.success).toBe(true);

      // Verify screening state side-effect
      const [scr] = await db.select().from(screenings).where(eq(screenings.id, screeningId));
      expect(scr.status).toBe("owner_decided");

      // Verify audit row
      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.action).toBe("consequential.approved");
      expect(audit.actorType).toBe("user");
      expect(audit.actorId).toBe(String(ownerId));
      expect(audit.resourceType).toBe("screening");
      expect(audit.resourceId).toBe(screeningId);
      expect(audit.metadata).toMatchObject({
        actionType: "candidate_final_decision",
        approvalId,
        source: "manual",
      });
    });

    it("6. replacement_case: updates placement to replacement_requested with timestamp, records consequential audit", async () => {
      const db = await requireDb();
      const placementId = createId("plc_test_");
      await db.insert(placements).values({
        id: placementId,
        ownerId,
        companyId: "cmp_test_dummy",
        jobId: "job_test_dummy",
        candidateId: "can_test_dummy",
        status: "joining_confirmed",
      });

      const approvalId = createId("apr_test_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "replacement_case",
        resourceType: "placement",
        resourceId: placementId,
        reason: "Early departure within guarantee period",
      });

      const res = await caller.consequential.decide({
        approvalId,
        decision: "approved",
      });
      expect(res.success).toBe(true);

      // Verify placement state side-effect
      const [plc] = await db.select().from(placements).where(eq(placements.id, placementId));
      expect(plc.status).toBe("replacement_requested");
      expect(plc.replacementRequestedAt).toBeInstanceOf(Date);

      // Verify audit row
      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.action).toBe("consequential.approved");
      expect(audit.metadata).toMatchObject({
        actionType: "replacement_case",
        approvalId,
        source: "manual",
      });
    });

    it("7. invoice_payment_status: updates invoice status to paid with paidAt, records consequential audit", async () => {
      const db = await requireDb();
      const invoiceId = createId("inv_test_");
      await db.insert(invoices).values({
        id: invoiceId,
        ownerId,
        companyId: "cmp_test_dummy",
        placementId: "plc_test_dummy",
        invoiceNumber: `INV-${Date.now()}-PAY`,
        status: "issued",
        amount: 250000,
      });

      const approvalId = createId("apr_test_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "invoice_payment_status",
        resourceType: "invoice",
        resourceId: invoiceId,
        reason: "Reconciliation of payment receipt",
        payload: { status: "paid" },
      });

      const res = await caller.consequential.decide({
        approvalId,
        decision: "approved",
        note: "Bank credit verified",
      });
      expect(res.success).toBe(true);

      // Verify invoice side-effect
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(inv.status).toBe("paid");
      expect(inv.paidAt).toBeInstanceOf(Date);

      // Verify audit row
      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.action).toBe("consequential.approved");
      expect(audit.metadata).toMatchObject({
        actionType: "invoice_payment_status",
        approvalId,
        source: "manual",
      });
    });

    it("8. invoice_dispute: marks invoice disputed with reason, records consequential audit", async () => {
      const db = await requireDb();
      const invoiceId = createId("inv_test_");
      await db.insert(invoices).values({
        id: invoiceId,
        ownerId,
        companyId: "cmp_test_dummy",
        placementId: "plc_test_dummy",
        invoiceNumber: `INV-${Date.now()}-DISP`,
        status: "issued",
        amount: 250000,
      });

      const approvalId = createId("apr_test_");
      const disputeEvidence = "Client claims contract terms dispute over joining date";
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "invoice_dispute",
        resourceType: "invoice",
        resourceId: invoiceId,
        reason: "Client invoice dispute",
        payload: { evidence: disputeEvidence },
      });

      const res = await caller.consequential.decide({
        approvalId,
        decision: "approved",
      });
      expect(res.success).toBe(true);

      // Verify invoice side-effect
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(inv.status).toBe("disputed");
      expect(inv.disputeReason).toBe(disputeEvidence);

      // Verify audit row
      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.action).toBe("consequential.approved");
      expect(audit.metadata).toMatchObject({
        actionType: "invoice_dispute",
        approvalId,
        source: "manual",
      });
    });

    it("9. invoice_credit: marks invoice credited, records consequential audit", async () => {
      const db = await requireDb();
      const invoiceId = createId("inv_test_");
      await db.insert(invoices).values({
        id: invoiceId,
        ownerId,
        companyId: "cmp_test_dummy",
        placementId: "plc_test_dummy",
        invoiceNumber: `INV-${Date.now()}-CRED`,
        status: "disputed",
        amount: 250000,
      });

      const approvalId = createId("apr_test_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "invoice_credit",
        resourceType: "invoice",
        resourceId: invoiceId,
        reason: "Issuing full credit note",
      });

      const res = await caller.consequential.decide({
        approvalId,
        decision: "approved",
      });
      expect(res.success).toBe(true);

      // Verify invoice side-effect
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(inv.status).toBe("credited");

      // Verify audit row
      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.action).toBe("consequential.approved");
      expect(audit.metadata).toMatchObject({
        actionType: "invoice_credit",
        approvalId,
        source: "manual",
      });
    });
  });

  describe("Rejections and source='policy'", () => {
    it("rejecting an approval updates approval status to rejected and does NOT trigger side-effects", async () => {
      const db = await requireDb();
      const invoiceId = createId("inv_test_");
      await db.insert(invoices).values({
        id: invoiceId,
        ownerId,
        companyId: "cmp_test_dummy",
        placementId: "plc_test_dummy",
        invoiceNumber: `INV-${Date.now()}-REJ`,
        status: "approval_pending",
        amount: 100000,
      });

      const approvalId = createId("apr_test_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "invoice_issue",
        resourceType: "invoice",
        resourceId: invoiceId,
        reason: "Issue approval",
      });

      const res = await caller.approvals.decide({
        id: approvalId,
        decision: "rejected",
        note: "Rejected due to missing PO number",
      });
      expect(res.success).toBe(true);

      // Verify approval row is rejected
      const [apr] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
      expect(apr.status).toBe("rejected");
      expect(apr.reason).toBe("Rejected due to missing PO number");

      // Invoice must stay in approval_pending, NOT issued
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(inv.status).toBe("approval_pending");
      expect(inv.issuedAt).toBeFalsy();

      // Audit row recorded with approval.rejected
      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.action).toBe("approval.rejected");
      expect(audit.metadata).toMatchObject({
        actionType: "invoice_issue",
        approvalId,
        source: "manual",
      });
    });

    it("rejecting a consequential approval updates approval status and does NOT trigger side-effects", async () => {
      const db = await requireDb();
      const screeningId = createId("scr_test_");
      await db.insert(screenings).values({
        id: screeningId,
        ownerId,
        candidateId: "can_test_dummy",
        jobId: "job_test_dummy",
        status: "decision_pending",
      });

      const approvalId = createId("apr_test_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "candidate_final_decision",
        resourceType: "screening",
        resourceId: screeningId,
        reason: "Final decision",
      });

      const res = await caller.consequential.decide({
        approvalId,
        decision: "rejected",
        note: "Candidate did not pass reference check",
      });
      expect(res.success).toBe(true);

      // Verify screening state stayed in decision_pending, NOT owner_decided
      const [scr] = await db.select().from(screenings).where(eq(screenings.id, screeningId));
      expect(scr.status).toBe("decision_pending");

      // Audit row recorded with consequential.rejected
      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.action).toBe("consequential.rejected");
      expect(audit.metadata).toMatchObject({
        actionType: "candidate_final_decision",
        approvalId,
        source: "manual",
      });
    });

    it("supports source='policy' via direct applyApprovalDecision invocation", async () => {
      const db = await requireDb();
      const companyId = createId("cmp_test_");
      await db.insert(companies).values({
        id: companyId,
        ownerId,
        name: "Policy Approved Client",
        pipelineState: "converted",
        companyType: "prospect",
        verificationState: "pending",
      });

      const approvalId = createId("apr_test_");
      const approvalRow = {
        id: approvalId,
        ownerId,
        requestedBy: "system",
        status: "pending",
        actionType: "client_onboarding",
        resourceType: "company",
        resourceId: companyId,
        reason: "Auto-onboarding policy",
      };
      await db.insert(approvals).values(approvalRow);

      const res = await applyApprovalDecision(
        db,
        approvalRow,
        "approved",
        ownerId,
        "Approved via automated compliance policy",
        "policy",
      );
      expect(res.success).toBe(true);

      const [cmp] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(cmp.pipelineState).toBe("active");
      expect(cmp.companyType).toBe("client");

      const [apr] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
      expect(apr.status).toBe("approved");
      expect(apr.decisionSource).toBe("policy");

      const audit = await getAuditForApproval(approvalId);
      expect(audit).toBeDefined();
      expect(audit.metadata).toMatchObject({
        actionType: "client_onboarding",
        approvalId,
        source: "policy",
      });
    });
  });
});
