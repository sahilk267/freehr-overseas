import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import {
  approvals,
  auditEvents,
  candidates,
  companies,
  interviews,
  invoices,
  jobs,
  placements,
  screenings,
  shortlists,
  workspaceSettings,
} from "../drizzle/schema";
import { ensureWorkspace, requireDb } from "./db";
import { appRouter } from "./routers";

describe("E2E Recruitment Happy Path Integration Test", () => {
  const testOwnerId = 1;
  const ownerCtx = {
    user: { id: testOwnerId, role: "admin", name: "Agency Owner", email: "owner@freelancehr.local" },
    req: {},
    res: {},
  } as never;

  const caller = appRouter.createCaller(ownerCtx);

  it("walks the complete happy path end-to-end and asserts all consequential owner approvals are required and respected", async () => {
    const db = await requireDb();
    const timestamp = Date.now();

    // -------------------------------------------------------------------------
    // Step 1: Create prospect
    // -------------------------------------------------------------------------
    const { id: companyId } = await caller.recruitment.prospects.create({
      name: `Acme Corp ${timestamp}`,
      domain: `acme-${timestamp}.example.com`,
      sector: "Enterprise Software",
      location: "Bengaluru, India",
      sourceType: "manual",
      hiringSignal: "Expanding engineering leadership team",
      confidence: 85,
    });
    expect(companyId).toBeDefined();

    let [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.pipelineState).toBe("new");
    expect(company.companyType).toBe("prospect");

    // -------------------------------------------------------------------------
    // Step 2: Convert prospect through defined pipeline states
    // -------------------------------------------------------------------------
    await caller.recruitment.prospects.transition({ id: companyId, state: "researched" });
    await caller.recruitment.prospects.transition({ id: companyId, state: "qualified" });
    await caller.recruitment.prospects.transition({ id: companyId, state: "proposal_pending" });
    await caller.recruitment.prospects.transition({ id: companyId, state: "converted" });

    [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.pipelineState).toBe("converted");

    // -------------------------------------------------------------------------
    // Step 3: Onboard client (CONSEQUENTIAL OWNER APPROVAL REQUIRED)
    // -------------------------------------------------------------------------
    // Consequential gate: Request onboarding approval
    const { approvalId: onboardingApprovalId } =
      await caller.recruitment.prospects.requestOnboardingApproval({ id: companyId });
    expect(onboardingApprovalId).toBeDefined();

    let [onboardingApproval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, onboardingApprovalId));
    expect(onboardingApproval.actionType).toBe("client_onboarding");
    expect(onboardingApproval.status).toBe("pending");
    expect(onboardingApproval.resourceId).toBe(companyId);

    // Assert company is NOT active client yet before owner decides
    [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.pipelineState).toBe("converted");
    expect(company.companyType).toBe("prospect");

    // Owner approves onboarding
    const onboardingDecision = await caller.recruitment.approvals.decide({
      id: onboardingApprovalId,
      decision: "approved",
      note: "Contract signed, verified MSME documentation.",
    });
    expect(onboardingDecision.success).toBe(true);

    // Verify company has transitioned to active verified client
    [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.pipelineState).toBe("active");
    expect(company.companyType).toBe("client");
    expect(company.verificationState).toBe("verified");
    expect(company.onboardingApprovedAt).toBeDefined();

    // -------------------------------------------------------------------------
    // Step 4: Create and progress Job Requisition
    // -------------------------------------------------------------------------
    const { id: jobId } = await caller.recruitment.jobs.create({
      companyId,
      title: "Principal Cloud Architect",
      department: "Platform Engineering",
      location: "Bengaluru, Hybrid",
      compensationMin: 3500000,
      compensationMax: 4500000,
      mustHaveSkills: ["Distributed Systems", "PostgreSQL", "Go", "TypeScript"],
      niceToHaveSkills: ["Kubernetes", "AWS"],
      scorecard: [
        { criterion: "Distributed Systems Architecture", weight: 60, required: true },
        { criterion: "System Reliability & API Design", weight: 40, required: true },
      ],
    });
    expect(jobId).toBeDefined();

    let [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job.pipelineState).toBe("draft");

    // Job requires client confirmation before sourcing
    await caller.recruitment.jobs.transition({ id: jobId, state: "client_confirmation" });

    // Transitioning to approved requires clientConfirmedBy
    await expect(
      caller.recruitment.jobs.transition({ id: jobId, state: "approved" })
    ).rejects.toThrow(/Client confirmation is required/);

    await caller.recruitment.jobs.transition({
      id: jobId,
      state: "approved",
      clientConfirmedBy: "director.eng@acme.example.com",
    });
    await caller.recruitment.jobs.transition({ id: jobId, state: "sourcing" });

    [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job.pipelineState).toBe("sourcing");
    expect(job.clientConfirmedAt).toBeDefined();

    // -------------------------------------------------------------------------
    // Step 5: Create Candidate
    // -------------------------------------------------------------------------
    const { id: candidateId } = await caller.recruitment.candidates.create({
      fullName: `Arjun Mehra ${timestamp}`,
      email: `arjun.${timestamp}@example.com`,
      headline: "Principal Distributed Systems Architect",
    });
    expect(candidateId).toBeDefined();

    let [candidate] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(candidate.profileState).toBe("consent_pending");

    // -------------------------------------------------------------------------
    // Step 6: Candidate Consent & Precondition Verification
    // -------------------------------------------------------------------------
    // Attempting to jump to consented without consent fails with PRECONDITION_FAILED
    await expect(
      caller.recruitment.candidates.transition({ id: candidateId, state: "consented" })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Grant platform processing consent
    await caller.recruitment.candidates.grantConsent({
      candidateId,
      consentType: "platform_processing",
      noticeVersion: "v1.0",
    });

    // Also grant client sharing consent explicitly tied to this job & client
    await caller.recruitment.candidates.grantConsent({
      candidateId,
      jobId,
      companyId,
      consentType: "client_sharing",
      noticeVersion: "v1.0",
    });

    // Transition through recruitment pipeline states
    await caller.recruitment.candidates.transition({ id: candidateId, state: "consented" });
    await caller.recruitment.candidates.transition({ id: candidateId, state: "available" });
    await caller.recruitment.candidates.transition({ id: candidateId, state: "screening" });
    await caller.recruitment.candidates.transition({ id: candidateId, state: "qualified" });
    await caller.recruitment.candidates.transition({ id: candidateId, state: "shortlisted" });

    [candidate] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(candidate.profileState).toBe("shortlisted");

    // -------------------------------------------------------------------------
    // Step 7: Create Evidence-Validated Match
    // -------------------------------------------------------------------------
    const { id: matchId, lowConfidence } = await caller.recruitment.matching.createEvidenceMatch({
      candidateId,
      jobId,
      ruleScore: 95,
      semanticScore: 92,
      confidence: 94,
      evidence: [
        "10+ years architecting distributed event-driven systems",
        "Lead maintainer of mission-critical Go and TypeScript services",
        "Deep PostgreSQL query optimization and sharding experience",
      ],
    });
    expect(matchId).toBeDefined();
    expect(lowConfidence).toBe(false);

    // -------------------------------------------------------------------------
    // Step 8: Candidate Share (CONSEQUENTIAL OWNER APPROVAL REQUIRED)
    // -------------------------------------------------------------------------
    // Request share approval (verifies explicit client_sharing consent exists)
    const { shortlistId, approvalId: shareApprovalId } =
      await caller.recruitment.matching.requestShareApproval({
        candidateId,
        jobId,
        companyId,
        matchId,
      });
    expect(shortlistId).toBeDefined();
    expect(shareApprovalId).toBeDefined();

    let [shortlist] = await db.select().from(shortlists).where(eq(shortlists.id, shortlistId));
    expect(shortlist.status).toBe("prepared");

    // Owner approves candidate profile sharing
    const shareDecision = await caller.recruitment.approvals.decide({
      id: shareApprovalId,
      decision: "approved",
      note: "Strong match criteria and verified candidate sharing consent.",
    });
    expect(shareDecision.success).toBe(true);

    [shortlist] = await db.select().from(shortlists).where(eq(shortlists.id, shortlistId));
    expect(shortlist.status).toBe("shared");
    expect(shortlist.sharedAt).toBeDefined();

    // Advance candidate into interview pipeline
    await caller.recruitment.candidates.transition({ id: candidateId, state: "submitted" });
    await caller.recruitment.candidates.transition({ id: candidateId, state: "interview" });

    // -------------------------------------------------------------------------
    // Step 9: Schedule & Conduct Interview
    // -------------------------------------------------------------------------
    const interviewTime = new Date(Date.now() + 2 * 86400000);
    const { id: interviewId } = await caller.recruitment.interviews.create({
      companyId,
      candidateId,
      jobId,
      scheduledAt: interviewTime,
      timezone: "Asia/Kolkata",
      durationMinutes: 60,
      meetingUrl: "https://meet.example.com/interview-cloud-arch",
    });
    expect(interviewId).toBeDefined();

    // Progress interview status
    await caller.recruitment.interviews.transition({ id: interviewId, state: "confirmed" });
    await caller.recruitment.interviews.transition({ id: interviewId, state: "completed" });

    let [interview] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
    expect(interview.status).toBe("completed");
    expect(interview.completedAt).toBeDefined();

    // -------------------------------------------------------------------------
    // Step 10: Record Structured Interview Feedback
    // -------------------------------------------------------------------------
    const { id: feedbackId } = await caller.recruitment.feedback.record({
      interviewId,
      authorName: "CTO, Acme Corp",
      rawFeedback:
        "Arjun demonstrated exceptional distributed systems mastery. Highly structured problem solving and clean API design.",
      technicalScore: 5,
      communicationScore: 5,
      roleEvidence: [
        "Flawless distributed concurrency modeling",
        "Clear articulation of failure domains and rollback strategies",
      ],
    });
    expect(feedbackId).toBeDefined();

    [interview] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
    expect(interview.status).toBe("feedback_received");

    // -------------------------------------------------------------------------
    // Step 11: Create Placement & Progress to Joining
    // -------------------------------------------------------------------------
    await caller.recruitment.candidates.transition({ id: candidateId, state: "offer" });

    const { id: placementId } = await caller.recruitment.placements.create({
      companyId,
      candidateId,
      jobId,
      annualCompensation: 4200000,
    });
    expect(placementId).toBeDefined();

    let [placement] = await db.select().from(placements).where(eq(placements.id, placementId));
    expect(placement.status).toBe("offer_pending");

    await caller.recruitment.placements.transition({ id: placementId, state: "offer_issued" });
    await caller.recruitment.placements.transition({ id: placementId, state: "offer_accepted" });
    await caller.recruitment.placements.transition({ id: placementId, state: "joining_pending" });

    // -------------------------------------------------------------------------
    // Step 12: Joining Confirmation (CONSEQUENTIAL OWNER APPROVAL REQUIRED)
    // -------------------------------------------------------------------------
    // Attempting without joining evidence fails with BAD_REQUEST
    await expect(
      caller.recruitment.placements.transition({
        id: placementId,
        state: "joining_confirmed",
        joiningEvidence: [],
      })
    ).rejects.toThrow(/Joining evidence is required/);

    // Calling with joining evidence returns an approval requirement
    const joiningTransitionRes = await caller.recruitment.placements.transition({
      id: placementId,
      state: "joining_confirmed",
      joiningEvidence: [
        "Signed appointment letter executed by candidate",
        "Physical day-1 orientation verified at Acme Bengaluru campus",
      ],
    });
    expect(joiningTransitionRes.approvalRequired).toBe(true);
    expect(joiningTransitionRes.approvalId).toBeDefined();

    // Verify placement status is still joining_pending until approved
    [placement] = await db.select().from(placements).where(eq(placements.id, placementId));
    expect(placement.status).toBe("joining_pending");

    // Owner approves placement joining confirmation
    const joiningDecision = await caller.recruitment.approvals.decide({
      id: joiningTransitionRes.approvalId!,
      decision: "approved",
      note: "Verified physical reporting and joining confirmation with client HR.",
    });
    expect(joiningDecision.success).toBe(true);

    [placement] = await db.select().from(placements).where(eq(placements.id, placementId));
    expect(placement.status).toBe("joining_confirmed");
    expect(placement.joiningConfirmedAt).toBeDefined();

    // Candidate transitions to joined
    await caller.recruitment.candidates.transition({ id: candidateId, state: "joined" });
    [candidate] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(candidate.profileState).toBe("joined");

    // Progress placement to invoice_eligible
    await caller.recruitment.placements.transition({
      id: placementId,
      state: "invoice_eligible",
      joiningEvidence: ["30-day onboarding confirmation report completed"],
    });
    [placement] = await db.select().from(placements).where(eq(placements.id, placementId));
    expect(placement.status).toBe("invoice_eligible");

    // -------------------------------------------------------------------------
    // Step 13: Draft Invoice
    // -------------------------------------------------------------------------
    const invoiceNumber = `INV-${timestamp}-E2E`;
    const placementFee = 350000;
    const taxAmount = 63000;

    const { id: invoiceId } = await caller.recruitment.invoices.draft({
      placementId,
      companyId,
      invoiceNumber,
      amount: placementFee,
      taxAmount,
    });
    expect(invoiceId).toBeDefined();

    let [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(invoice.status).toBe("draft");
    expect(invoice.amount).toBe(placementFee);

    // -------------------------------------------------------------------------
    // Step 14: Invoice Issuance (CONSEQUENTIAL OWNER APPROVAL REQUIRED)
    // -------------------------------------------------------------------------
    const { approvalId: invoiceIssueApprovalId } =
      await caller.recruitment.invoices.requestIssueApproval({ id: invoiceId });
    expect(invoiceIssueApprovalId).toBeDefined();

    [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(invoice.status).toBe("approval_pending");

    // Owner approves invoice issuance
    const invoiceIssueDecision = await caller.recruitment.approvals.decide({
      id: invoiceIssueApprovalId,
      decision: "approved",
      note: "Fee calculation checked against 8.33% commercial term agreement.",
    });
    expect(invoiceIssueDecision.success).toBe(true);

    [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(invoice.status).toBe("issued");
    expect(invoice.issuedAt).toBeDefined();

    // -------------------------------------------------------------------------
    // Step 15: Consequential Payment Status Update (CONSEQUENTIAL OWNER APPROVAL REQUIRED)
    // -------------------------------------------------------------------------
    // Request payment status change to 'paid'
    const { approvalId: paymentApprovalId } =
      await caller.recruitment.consequential.requestInvoiceAction({
        invoiceId,
        action: "payment_status",
        status: "paid",
        evidence: "Bank statement reconciliation confirms full NEFT credit UTR-9876543210.",
      });
    expect(paymentApprovalId).toBeDefined();

    // Verify invoice is still issued until consequential approval is decided
    [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(invoice.status).toBe("issued");

    // Owner approves consequential payment status update
    const paymentDecision = await caller.recruitment.consequential.decide({
      approvalId: paymentApprovalId,
      decision: "approved",
      note: "Confirmed receipt in primary agency bank account.",
    });
    expect(paymentDecision.success).toBe(true);

    [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(invoice.status).toBe("paid");
    expect(invoice.paidAt).toBeDefined();
  });

  it("walks the workflow with an active auto-approval policy for candidate_share and invoice_issue, confirming zero pending approvals, manual candidate_final_decision, and distinct audit trail", async () => {
    const db = await requireDb();
    const timestamp = Date.now() + 1000;
    const policyOwnerId = 202;

    const policyOwnerCtx = {
      user: {
        id: policyOwnerId,
        role: "admin",
        name: "Policy Agency Owner",
        email: "policy-owner@freelancehr.local",
      },
      workspace: { ownerId: policyOwnerId, role: "owner", isOwner: true, memberId: null },
      req: { headers: {} },
      res: {},
    } as never;

    const caller = appRouter.createCaller(policyOwnerCtx);

    // -------------------------------------------------------------------------
    // Setup Policy: Active rules auto-approve candidate_share and invoice_issue
    // NOTE: candidate_final_decision intentionally has NO matching rule.
    // -------------------------------------------------------------------------
    await ensureWorkspace(policyOwnerId);
    await db
      .update(workspaceSettings)
      .set({
        policyConfig: {
          autoApprovalRules: [
            {
              id: "rule_auto_candidate_share",
              name: "Auto-approve candidate share with verified consent",
              actionType: "candidate_share",
              conditions: [],
            },
            {
              id: "rule_auto_invoice_issue",
              name: "Auto-approve invoice issuance up to 500,000",
              actionType: "invoice_issue",
              conditions: [{ field: "amount", op: "lte", value: 500000 }],
            },
          ],
        },
      })
      .where(eq(workspaceSettings.ownerId, policyOwnerId));

    // -------------------------------------------------------------------------
    // Step 1: Create prospect
    // -------------------------------------------------------------------------
    const { id: companyId } = await caller.recruitment.prospects.create({
      name: `Apex Solutions ${timestamp}`,
      domain: `apex-${timestamp}.example.com`,
      sector: "Financial Technology",
      location: "Mumbai, India",
      sourceType: "manual",
      hiringSignal: "Series B expansion, hiring core backend leadership",
      confidence: 90,
    });
    expect(companyId).toBeDefined();

    // -------------------------------------------------------------------------
    // Step 2: Convert prospect through pipeline states
    // -------------------------------------------------------------------------
    await caller.recruitment.prospects.transition({ id: companyId, state: "researched" });
    await caller.recruitment.prospects.transition({ id: companyId, state: "qualified" });
    await caller.recruitment.prospects.transition({ id: companyId, state: "proposal_pending" });
    await caller.recruitment.prospects.transition({ id: companyId, state: "converted" });

    // -------------------------------------------------------------------------
    // Step 3: Onboard client (NO auto-approval rule -> requires manual owner decide)
    // -------------------------------------------------------------------------
    const { approvalId: onboardingApprovalId } =
      await caller.recruitment.prospects.requestOnboardingApproval({ id: companyId });
    expect(onboardingApprovalId).toBeDefined();

    const onboardingDecision = await caller.recruitment.approvals.decide({
      id: onboardingApprovalId,
      decision: "approved",
      note: "Client agreement verified and signed.",
    });
    expect(onboardingDecision.success).toBe(true);

    let [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.pipelineState).toBe("active");
    expect(company.companyType).toBe("client");

    // -------------------------------------------------------------------------
    // Step 4: Create Job Requisition & Confirm
    // -------------------------------------------------------------------------
    const { id: jobId } = await caller.recruitment.jobs.create({
      companyId,
      title: "Staff Systems Engineer",
      department: "Core Banking Infrastructure",
      location: "Mumbai, On-site",
      compensationMin: 4000000,
      compensationMax: 5000000,
      mustHaveSkills: ["Rust", "Distributed Consensus", "PostgreSQL"],
      niceToHaveSkills: ["Raft", "Kafka"],
    });
    expect(jobId).toBeDefined();

    await caller.recruitment.jobs.transition({ id: jobId, state: "client_confirmation" });
    await caller.recruitment.jobs.transition({
      id: jobId,
      state: "approved",
      clientConfirmedBy: "vp.engineering@apex.example.com",
    });
    await caller.recruitment.jobs.transition({ id: jobId, state: "sourcing" });

    // -------------------------------------------------------------------------
    // Step 5: Create Candidate & Consents
    // -------------------------------------------------------------------------
    const { id: candidateId } = await caller.recruitment.candidates.create({
      fullName: `Priya Sharma ${timestamp}`,
      email: `priya.${timestamp}@example.com`,
      headline: "Staff Systems Engineer",
    });
    expect(candidateId).toBeDefined();

    await caller.recruitment.candidates.grantConsent({
      candidateId,
      consentType: "platform_processing",
      noticeVersion: "v1.0",
    });
    await caller.recruitment.candidates.grantConsent({
      candidateId,
      jobId,
      companyId,
      consentType: "client_sharing",
      noticeVersion: "v1.0",
    });

    await caller.recruitment.candidates.transition({ id: candidateId, state: "consented" });
    await caller.recruitment.candidates.transition({ id: candidateId, state: "available" });
    await caller.recruitment.candidates.transition({ id: candidateId, state: "screening" });
    await caller.recruitment.candidates.transition({ id: candidateId, state: "qualified" });
    await caller.recruitment.candidates.transition({ id: candidateId, state: "shortlisted" });

    // -------------------------------------------------------------------------
    // Step 6: Evidence Match
    // -------------------------------------------------------------------------
    const { id: matchId } = await caller.recruitment.matching.createEvidenceMatch({
      candidateId,
      jobId,
      ruleScore: 96,
      semanticScore: 94,
      confidence: 95,
      evidence: ["8+ years building high-throughput low-latency systems in Rust"],
    });
    expect(matchId).toBeDefined();

    // -------------------------------------------------------------------------
    // Step 7: Candidate Share — POLICY AUTO-APPROVES
    // -------------------------------------------------------------------------
    const shareRes = await caller.recruitment.matching.requestShareApproval({
      candidateId,
      jobId,
      companyId,
      matchId,
    });
    expect(shareRes.shortlistId).toBeDefined();
    expect(shareRes.approvalId).toBeDefined();
    expect(shareRes.autoDecided).toBe(true);

    // Confirm ZERO pending approvals for candidate_share
    const pendingShareApprovals = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.ownerId, policyOwnerId),
          eq(approvals.actionType, "candidate_share"),
          eq(approvals.status, "pending"),
        ),
      );
    expect(pendingShareApprovals.length).toBe(0);

    // Confirm approval record is marked approved with decisionSource: 'policy'
    const [shareApproval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, shareRes.approvalId!));
    expect(shareApproval.status).toBe("approved");
    expect(shareApproval.decisionSource).toBe("policy");

    // Shortlist reached 'shared' status immediately without manual decide() call
    let [shortlist] = await db.select().from(shortlists).where(eq(shortlists.id, shareRes.shortlistId));
    expect(shortlist.status).toBe("shared");
    expect(shortlist.sharedAt).toBeDefined();

    // Advance candidate to interview
    await caller.recruitment.candidates.transition({ id: candidateId, state: "submitted" });
    await caller.recruitment.candidates.transition({ id: candidateId, state: "interview" });

    // -------------------------------------------------------------------------
    // Step 8: Interview & Feedback
    // -------------------------------------------------------------------------
    const interviewTime = new Date(Date.now() + 86400000);
    const { id: interviewId } = await caller.recruitment.interviews.create({
      companyId,
      candidateId,
      jobId,
      scheduledAt: interviewTime,
      timezone: "Asia/Kolkata",
      durationMinutes: 60,
    });
    await caller.recruitment.interviews.transition({ id: interviewId, state: "confirmed" });
    await caller.recruitment.interviews.transition({ id: interviewId, state: "completed" });

    await caller.recruitment.feedback.record({
      interviewId,
      authorName: "Head of Infra, Apex Solutions",
      rawFeedback: "Priya aced the systems design and concurrency problem.",
      technicalScore: 5,
      communicationScore: 5,
      roleEvidence: ["Outstanding mastery of consensus algorithms"],
    });

    // -------------------------------------------------------------------------
    // Step 9: candidate_final_decision — NO matching rule, requires manual decide()
    // -------------------------------------------------------------------------
    const { screeningId, approvalId: finalDecisionApprovalId } =
      await caller.recruitment.consequential.requestCandidateDecision({
        candidateId,
        jobId,
        disposition: "advance",
        evidence: ["Passed technical round with 5/5 score from Head of Infra"],
        rationale: "Recommend advancing to offer stage based on interview results.",
      });
    expect(screeningId).toBeDefined();
    expect(finalDecisionApprovalId).toBeDefined();

    // Confirm screening is in 'decision_pending' before manual owner approval
    let [screening] = await db.select().from(screenings).where(eq(screenings.id, screeningId));
    expect(screening.status).toBe("decision_pending");

    // Confirm approval row is 'pending' with decisionSource: 'manual'
    let [finalDecisionApproval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, finalDecisionApprovalId));
    expect(finalDecisionApproval.status).toBe("pending");
    expect(finalDecisionApproval.decisionSource).toBe("manual");

    // Owner manual decide() call is REQUIRED
    const finalDecisionRes = await caller.recruitment.consequential.decide({
      approvalId: finalDecisionApprovalId,
      decision: "approved",
      note: "Owner confirms candidate final advance decision.",
    });
    expect(finalDecisionRes.success).toBe(true);

    // Screening advances to owner_decided
    [screening] = await db.select().from(screenings).where(eq(screenings.id, screeningId));
    expect(screening.status).toBe("owner_decided");

    [finalDecisionApproval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, finalDecisionApprovalId));
    expect(finalDecisionApproval.status).toBe("approved");
    expect(finalDecisionApproval.decisionSource).toBe("manual");

    // -------------------------------------------------------------------------
    // Step 10: Placement Progress & Joining Confirmation (Owner decides)
    // -------------------------------------------------------------------------
    await caller.recruitment.candidates.transition({ id: candidateId, state: "offer" });

    const { id: placementId } = await caller.recruitment.placements.create({
      companyId,
      candidateId,
      jobId,
      annualCompensation: 4800000,
    });
    await caller.recruitment.placements.transition({ id: placementId, state: "offer_issued" });
    await caller.recruitment.placements.transition({ id: placementId, state: "offer_accepted" });
    await caller.recruitment.placements.transition({ id: placementId, state: "joining_pending" });

    const joiningRes = await caller.recruitment.placements.transition({
      id: placementId,
      state: "joining_confirmed",
      joiningEvidence: ["Offer letter counter-signed", "Badge issued and orientation completed"],
    });
    expect(joiningRes.approvalRequired).toBe(true);
    expect(joiningRes.approvalId).toBeDefined();

    // Owner approves placement joining
    const joiningDecision = await caller.recruitment.approvals.decide({
      id: joiningRes.approvalId!,
      decision: "approved",
      note: "Day 1 verified with client HR.",
    });
    expect(joiningDecision.success).toBe(true);

    await caller.recruitment.candidates.transition({ id: candidateId, state: "joined" });
    await caller.recruitment.placements.transition({
      id: placementId,
      state: "invoice_eligible",
      joiningEvidence: ["30-day confirmation confirmed"],
    });

    let [placement] = await db.select().from(placements).where(eq(placements.id, placementId));
    expect(placement.status).toBe("invoice_eligible");

    // -------------------------------------------------------------------------
    // Step 11: Draft Invoice
    // -------------------------------------------------------------------------
    const invoiceNumber = `INV-${timestamp}-AUTO`;
    const placementFee = 400000;
    const taxAmount = 72000;

    const { id: invoiceId } = await caller.recruitment.invoices.draft({
      placementId,
      companyId,
      invoiceNumber,
      amount: placementFee,
      taxAmount,
    });
    expect(invoiceId).toBeDefined();

    let [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(invoice.status).toBe("draft");

    // -------------------------------------------------------------------------
    // Step 12: Invoice Issuance — POLICY AUTO-APPROVES
    // -------------------------------------------------------------------------
    const issueRes = await caller.recruitment.invoices.requestIssueApproval({ id: invoiceId });
    expect(issueRes.approvalId).toBeDefined();
    expect(issueRes.autoDecided).toBe(true);

    // Confirm ZERO pending approvals for invoice_issue
    const pendingInvoiceApprovals = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.ownerId, policyOwnerId),
          eq(approvals.actionType, "invoice_issue"),
          eq(approvals.status, "pending"),
        ),
      );
    expect(pendingInvoiceApprovals.length).toBe(0);

    // Confirm approval record is marked approved with decisionSource: 'policy'
    const [invoiceApproval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, issueRes.approvalId!));
    expect(invoiceApproval.status).toBe("approved");
    expect(invoiceApproval.decisionSource).toBe("policy");

    // Invoice reached 'issued' status immediately without manual decide() call
    [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(invoice.status).toBe("issued");
    expect(invoice.issuedAt).toBeDefined();

    // -------------------------------------------------------------------------
    // Step 13: Consequential Payment Status Update (Owner decides)
    // -------------------------------------------------------------------------
    const { approvalId: paymentApprovalId } =
      await caller.recruitment.consequential.requestInvoiceAction({
        invoiceId,
        action: "payment_status",
        status: "paid",
        evidence: "Bank UTR-9988776655 verified full credit.",
      });
    expect(paymentApprovalId).toBeDefined();

    const paymentDecision = await caller.recruitment.consequential.decide({
      approvalId: paymentApprovalId,
      decision: "approved",
      note: "Confirmed receipt in agency bank account.",
    });
    expect(paymentDecision.success).toBe(true);

    // -------------------------------------------------------------------------
    // Confirm End States Match Exactly
    // -------------------------------------------------------------------------
    [placement] = await db.select().from(placements).where(eq(placements.id, placementId));
    expect(placement.status).toBe("invoice_eligible");

    [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(invoice.status).toBe("paid");
    expect(invoice.paidAt).toBeDefined();

    // Confirm zero pending approvals for both candidate_share and invoice_issue
    const allPendingPolicySteps = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.ownerId, policyOwnerId),
          inArray(approvals.actionType, ["candidate_share", "invoice_issue"]),
          eq(approvals.status, "pending"),
        ),
      );
    expect(allPendingPolicySteps.length).toBe(0);

    // -------------------------------------------------------------------------
    // Confirm Audit Trail Distinctly Shows Policy-Decided vs Owner-Decided Steps
    // -------------------------------------------------------------------------
    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.ownerId, policyOwnerId));

    // Policy-decided steps
    const autoDecidedAudits = auditRows.filter(a => a.action === "approval.auto_decided");
    expect(autoDecidedAudits.length).toBeGreaterThanOrEqual(2);

    const shareAutoAudit = autoDecidedAudits.find(
      a => (a.metadata as Record<string, unknown>)?.actionType === "candidate_share",
    );
    expect(shareAutoAudit).toBeDefined();
    expect(shareAutoAudit?.actorType).toBe("system");
    expect((shareAutoAudit?.metadata as Record<string, unknown>)?.source).toBe("policy");

    const invoiceAutoAudit = autoDecidedAudits.find(
      a => (a.metadata as Record<string, unknown>)?.actionType === "invoice_issue",
    );
    expect(invoiceAutoAudit).toBeDefined();
    expect(invoiceAutoAudit?.actorType).toBe("system");
    expect((invoiceAutoAudit?.metadata as Record<string, unknown>)?.source).toBe("policy");

    // Owner-decided steps
    const ownerDecidedAudits = auditRows.filter(
      a => a.actorType === "user" && (a.action === "approval.approved" || a.action === "consequential.approved"),
    );
    expect(ownerDecidedAudits.length).toBeGreaterThanOrEqual(3);

    const candidateFinalDecisionAudit = ownerDecidedAudits.find(
      a => (a.metadata as Record<string, unknown>)?.actionType === "candidate_final_decision",
    );
    expect(candidateFinalDecisionAudit).toBeDefined();
    expect(candidateFinalDecisionAudit?.actorType).toBe("user");
    expect(candidateFinalDecisionAudit?.action).toBe("consequential.approved");
    expect((candidateFinalDecisionAudit?.metadata as Record<string, unknown>)?.source).toBe("manual");
  });
});
