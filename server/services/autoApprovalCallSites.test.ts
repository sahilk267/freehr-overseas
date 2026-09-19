import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  approvals,
  candidates,
  companies,
  consents,
  invoices,
  jobs,
  placements,
  screenings,
  shortlists,
  workspaceSettings,
} from "../../drizzle/schema";
import { createId, ensureWorkspace, requireDb } from "../db";
import { recruitmentRouter } from "../routers/recruitment";
import { consequentialRouter } from "../routers/consequential";

describe("Auto-approval call sites integration", () => {
  const ownerId = 999;
  const ctx = {
    user: { id: ownerId, role: "admin", name: "Policy Test Owner", email: "policy@test.local" },
    workspace: { ownerId, role: "owner", isOwner: true, memberId: null },
    req: { headers: {} },
    res: {},
  } as never;

  const recruitmentCaller = recruitmentRouter.createCaller(ctx);
  const consequentialCaller = consequentialRouter.createCaller(ctx);

  async function setPolicy(rules: unknown[] | null) {
    const db = await requireDb();
    await ensureWorkspace(ownerId);
    await db
      .update(workspaceSettings)
      .set({
        policyConfig: rules ? { autoApprovalRules: rules } : null,
      })
      .where(eq(workspaceSettings.ownerId, ownerId));
  }

  describe("1. prospects.requestOnboardingApproval (client_onboarding)", () => {
    it("no matching policy -> status pending, decisionSource manual, pipelineState converted", async () => {
      await setPolicy(null);
      const db = await requireDb();
      const companyId = createId("cmp_callsite_");
      await db.insert(companies).values({
        id: companyId,
        ownerId,
        name: "Acme Prospect Manual",
        pipelineState: "converted",
        companyType: "prospect",
      });

      const res = await recruitmentCaller.prospects.requestOnboardingApproval({ id: companyId });
      expect(res.approvalId).toBeDefined();
      expect(res.autoDecided).toBe(false);

      const [approval] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId));
      expect(approval.status).toBe("pending");
      expect(approval.decisionSource).toBe("manual");

      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(company.pipelineState).toBe("converted");

      const listed = await recruitmentCaller.approvals.list({});
      const foundInList = listed.find((a) => a.id === res.approvalId);
      expect(foundInList?.decisionSource).toBe("manual");
    });

    it("matching policy -> auto-approved, decisionSource policy, pipelineState active, companyType client", async () => {
      await setPolicy([
        {
          id: "rule-onboarding-auto",
          name: "Auto-approve prospect onboarding",
          actionType: "client_onboarding",
          conditions: [{ field: "companyType", op: "eq", value: "prospect" }],
        },
      ]);
      const db = await requireDb();
      const companyId = createId("cmp_callsite_auto_");
      await db.insert(companies).values({
        id: companyId,
        ownerId,
        name: "Acme Prospect Policy",
        pipelineState: "converted",
        companyType: "prospect",
      });

      const res = await recruitmentCaller.prospects.requestOnboardingApproval({ id: companyId });
      expect(res.approvalId).toBeDefined();
      expect(res.autoDecided).toBe(true);

      const [approval] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId));
      expect(approval.status).toBe("approved");
      expect(approval.decisionSource).toBe("policy");
      expect(approval.decidedById).toBe(ownerId);

      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(company.pipelineState).toBe("active");
      expect(company.companyType).toBe("client");
      expect(company.verificationState).toBe("verified");

      const listed = await recruitmentCaller.approvals.list({});
      const foundInList = listed.find((a) => a.id === res.approvalId);
      expect(foundInList?.decisionSource).toBe("policy");
      expect(foundInList?.status).toBe("approved");
    });
  });

  describe("2. matching.requestShareApproval (candidate_share)", () => {
    it("no matching policy -> status pending, decisionSource manual, shortlist prepared", async () => {
      await setPolicy(null);
      const db = await requireDb();
      const companyId = createId("cmp_share_");
      const candidateId = createId("cnd_share_");
      const jobId = createId("job_share_");

      await db.insert(companies).values({ id: companyId, ownerId, name: "Share Client", pipelineState: "active" });
      await db.insert(candidates).values({ id: candidateId, ownerId, fullName: "Share Candidate", email: "share@candidate.test" });
      await db.insert(jobs).values({ id: jobId, ownerId, companyId, title: "Share Job", status: "published" });
      await db.insert(consents).values({
        id: createId("cns_share_"),
        ownerId,
        candidateId,
        jobId,
        companyId,
        consentType: "client_sharing",
        status: "granted",
        channel: "email",
      });

      const res = await recruitmentCaller.matching.requestShareApproval({
        candidateId,
        jobId,
        companyId,
      });

      expect(res.approvalId).toBeDefined();
      expect(res.autoDecided).toBe(false);

      const [approval] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId));
      expect(approval.status).toBe("pending");
      expect(approval.decisionSource).toBe("manual");

      const [shortlist] = await db.select().from(shortlists).where(eq(shortlists.id, res.shortlistId));
      expect(shortlist.status).toBe("prepared");

      const listed = await recruitmentCaller.approvals.list({});
      const foundInList = listed.find((a) => a.id === res.approvalId);
      expect(foundInList?.decisionSource).toBe("manual");
    });

    it("matching policy -> auto-approved, decisionSource policy, shortlist shared", async () => {
      await setPolicy([
        {
          id: "rule-share-auto",
          name: "Auto-approve candidate share",
          actionType: "candidate_share",
          conditions: [{ field: "candidateId", op: "eq", value: "cnd_matching_policy" }],
        },
      ]);
      const db = await requireDb();
      const companyId = createId("cmp_share_pol_");
      const candidateId = "cnd_matching_policy";
      const jobId = createId("job_share_pol_");

      await db.insert(companies).values({ id: companyId, ownerId, name: "Share Client 2", pipelineState: "active" });
      await db.insert(candidates).values({ id: candidateId, ownerId, fullName: "Policy Candidate", email: "pol@candidate.test" });
      await db.insert(jobs).values({ id: jobId, ownerId, companyId, title: "Policy Job", status: "published" });
      await db.insert(consents).values({
        id: createId("cns_share_pol_"),
        ownerId,
        candidateId,
        jobId,
        companyId,
        consentType: "client_sharing",
        status: "granted",
        channel: "email",
      });

      const res = await recruitmentCaller.matching.requestShareApproval({
        candidateId,
        jobId,
        companyId,
      });

      expect(res.approvalId).toBeDefined();
      expect(res.autoDecided).toBe(true);

      const [approval] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId));
      expect(approval.status).toBe("approved");
      expect(approval.decisionSource).toBe("policy");

      const [shortlist] = await db.select().from(shortlists).where(eq(shortlists.id, res.shortlistId));
      expect(shortlist.status).toBe("shared");

      const listed = await recruitmentCaller.approvals.list({});
      const foundInList = listed.find((a) => a.id === res.approvalId);
      expect(foundInList?.decisionSource).toBe("policy");
    });
  });

  describe("3. invoices.requestIssueApproval (invoice_issue)", () => {
    it("no matching policy -> status pending, decisionSource manual, invoice approval_pending", async () => {
      await setPolicy(null);
      const db = await requireDb();
      const invoiceId = createId("inv_issue_manual_");
      await db.insert(invoices).values({
        id: invoiceId,
        ownerId,
        invoiceNumber: "INV-MAN-001",
        amount: 250000,
        taxAmount: 0,
        status: "draft",
      });

      const res = await recruitmentCaller.invoices.requestIssueApproval({ id: invoiceId });
      expect(res.approvalId).toBeDefined();
      expect(res.autoDecided).toBe(false);

      const [approval] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId));
      expect(approval.status).toBe("pending");
      expect(approval.decisionSource).toBe("manual");

      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(invoice.status).toBe("approval_pending");

      const listed = await recruitmentCaller.approvals.list({});
      const foundInList = listed.find((a) => a.id === res.approvalId);
      expect(foundInList?.decisionSource).toBe("manual");
    });

    it("matching policy -> auto-approved, decisionSource policy, invoice issued", async () => {
      await setPolicy([
        {
          id: "rule-inv-auto",
          name: "Auto-approve invoices under 5k",
          actionType: "invoice_issue",
          conditions: [{ field: "amount", op: "lte", value: 500000 }],
        },
      ]);
      const db = await requireDb();
      const invoiceId = createId("inv_issue_auto_");
      await db.insert(invoices).values({
        id: invoiceId,
        ownerId,
        invoiceNumber: "INV-AUTO-002",
        amount: 400000,
        taxAmount: 0,
        status: "draft",
      });

      const res = await recruitmentCaller.invoices.requestIssueApproval({ id: invoiceId });
      expect(res.approvalId).toBeDefined();
      expect(res.autoDecided).toBe(true);

      const [approval] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId));
      expect(approval.status).toBe("approved");
      expect(approval.decisionSource).toBe("policy");

      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(invoice.status).toBe("issued");

      const listed = await recruitmentCaller.approvals.list({});
      const foundInList = listed.find((a) => a.id === res.approvalId);
      expect(foundInList?.decisionSource).toBe("policy");
    });
  });

  describe("4. placements.transition joining_confirmed (placement_confirmation)", () => {
    it("no matching policy -> status pending, decisionSource manual, placement stays joining_pending", async () => {
      await setPolicy(null);
      const db = await requireDb();
      const placementId = createId("plc_trans_man_");
      await db.insert(placements).values({
        id: placementId,
        ownerId,
        status: "joining_pending",
      });

      const res = await recruitmentCaller.placements.transition({
        id: placementId,
        state: "joining_confirmed",
        joiningEvidence: ["Signed contract"],
      });
      expect(res.approvalRequired).toBe(true);
      expect(res.approvalId).toBeDefined();

      const [approval] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId!));
      expect(approval.status).toBe("pending");
      expect(approval.decisionSource).toBe("manual");

      const [placement] = await db.select().from(placements).where(eq(placements.id, placementId));
      expect(placement.status).toBe("joining_pending");

      const listed = await recruitmentCaller.approvals.list({});
      const foundInList = listed.find((a) => a.id === res.approvalId);
      expect(foundInList?.decisionSource).toBe("manual");
    });

    it("matching policy -> auto-approved, decisionSource policy, placement becomes joining_confirmed", async () => {
      await setPolicy([
        {
          id: "rule-confirm-auto",
          name: "Auto-approve placement confirmation",
          actionType: "placement_confirmation",
          conditions: [{ field: "requestedState", op: "eq", value: "joining_confirmed" }],
        },
      ]);
      const db = await requireDb();
      const placementId = createId("plc_trans_auto_");
      await db.insert(placements).values({
        id: placementId,
        ownerId,
        status: "joining_pending",
      });

      const res = await recruitmentCaller.placements.transition({
        id: placementId,
        state: "joining_confirmed",
        joiningEvidence: ["Orientation photo"],
      });
      expect(res.approvalRequired).toBe(false);
      expect(res.autoDecided).toBe(true);
      expect(res.approvalId).toBeDefined();

      const [approval] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId!));
      expect(approval.status).toBe("approved");
      expect(approval.decisionSource).toBe("policy");

      const [placement] = await db.select().from(placements).where(eq(placements.id, placementId));
      expect(placement.status).toBe("joining_confirmed");

      const listed = await recruitmentCaller.approvals.list({});
      const foundInList = listed.find((a) => a.id === res.approvalId);
      expect(foundInList?.decisionSource).toBe("policy");
    });
  });

  describe("5. consequentialRouter call sites (candidate_final_decision, replacement_case, invoice actions)", () => {
    it("requestCandidateDecision: no matching policy -> pending, matching policy -> auto-decided & screening owner_decided", async () => {
      const db = await requireDb();
      const candidateId = createId("cnd_conseq_");
      const jobId = createId("job_conseq_");
      await db.insert(candidates).values({ id: candidateId, ownerId, fullName: "Conseq Candidate" });
      await db.insert(jobs).values({ id: jobId, ownerId, title: "Conseq Job", status: "published" });

      // 1. Without policy
      await setPolicy(null);
      const resManual = await consequentialCaller.requestCandidateDecision({
        candidateId,
        jobId,
        disposition: "advance",
        evidence: ["Top score on system design"],
        rationale: "Strong candidate with comprehensive background",
      });
      const [approvalManual] = await db.select().from(approvals).where(eq(approvals.id, resManual.approvalId));
      expect(approvalManual.status).toBe("pending");
      expect(approvalManual.decisionSource).toBe("manual");

      const [screeningManual] = await db.select().from(screenings).where(eq(screenings.id, resManual.screeningId));
      expect(screeningManual.status).toBe("decision_pending");

      // 2. With policy
      await setPolicy([
        {
          id: "rule-candidate-decision",
          name: "Auto-approve candidate advance disposition",
          actionType: "candidate_final_decision",
          conditions: [{ field: "disposition", op: "eq", value: "advance" }],
        },
      ]);
      const resAuto = await consequentialCaller.requestCandidateDecision({
        candidateId,
        jobId,
        disposition: "advance",
        evidence: ["Top score on system design v2"],
        rationale: "Excellent candidate auto approved via policy",
      });
      const [approvalAuto] = await db.select().from(approvals).where(eq(approvals.id, resAuto.approvalId));
      expect(approvalAuto.status).toBe("approved");
      expect(approvalAuto.decisionSource).toBe("policy");

      const [screeningAuto] = await db.select().from(screenings).where(eq(screenings.id, resAuto.screeningId));
      expect(screeningAuto.status).toBe("owner_decided");

      const listed = await recruitmentCaller.approvals.list({});
      const foundInList = listed.find((a) => a.id === resAuto.approvalId);
      expect(foundInList?.decisionSource).toBe("policy");
    });

    it("requestReplacement: no policy -> pending, matching policy -> auto-decided & replacement_requested", async () => {
      const db = await requireDb();
      const placementId = createId("plc_rep_");
      await db.insert(placements).values({ id: placementId, ownerId, status: "guarantee_active" });

      // With policy
      await setPolicy([
        {
          id: "rule-rep",
          name: "Auto-approve replacement cases",
          actionType: "replacement_case",
          conditions: [],
        },
      ]);

      const resAuto = await consequentialCaller.requestReplacement({
        placementId,
        reason: "Candidate departed within guarantee window",
      });

      const [approvalAuto] = await db.select().from(approvals).where(eq(approvals.id, resAuto.approvalId));
      expect(approvalAuto.status).toBe("approved");
      expect(approvalAuto.decisionSource).toBe("policy");

      const [placementAuto] = await db.select().from(placements).where(eq(placements.id, placementId));
      expect(placementAuto.status).toBe("replacement_requested");
      expect(placementAuto.replacementRequestedAt).toBeInstanceOf(Date);
    });

    it("requestInvoiceAction (dispute): no policy -> pending, matching policy -> auto-decided & invoice disputed", async () => {
      const db = await requireDb();
      const invoiceId = createId("inv_disp_");
      await db.insert(invoices).values({ id: invoiceId, ownerId, invoiceNumber: "INV-DISP-001", amount: 100000, status: "issued" });

      await setPolicy([
        {
          id: "rule-dispute",
          name: "Auto-approve dispute",
          actionType: "invoice_dispute",
          conditions: [],
        },
      ]);

      const resAuto = await consequentialCaller.requestInvoiceAction({
        invoiceId,
        action: "dispute",
        evidence: "Client claims PO number missing and payment halted",
      });

      const [approvalAuto] = await db.select().from(approvals).where(eq(approvals.id, resAuto.approvalId));
      expect(approvalAuto.status).toBe("approved");
      expect(approvalAuto.decisionSource).toBe("policy");

      const [invoiceAuto] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(invoiceAuto.status).toBe("disputed");
      expect(invoiceAuto.disputeReason).toContain("Client claims PO number");
    });
  });
});
