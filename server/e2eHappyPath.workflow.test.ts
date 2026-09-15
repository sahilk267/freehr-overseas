import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
  approvals,
  candidates,
  companies,
  interviews,
  invoices,
  jobs,
  placements,
  shortlists,
} from "../drizzle/schema";
import { requireDb } from "./db";
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
});
