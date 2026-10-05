import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  approvals,
  candidates,
  companies,
  consents,
  feedback,
  interviews,
  invoices,
  jobs,
  matches,
  placements,
  screenings,
  shortlists,
} from "../drizzle/schema";
import { createId, ensureWorkspace, requireDb } from "./db";
import { appRouter } from "./routers";

function createCaller(userId: number, role: "owner" | "admin" | "member" = "owner") {
  return appRouter.createCaller({
    user: {
      id: userId,
      openId: `user_${userId}`,
      email: `user_${userId}@test.local`,
      name: `User ${userId}`,
      role: "admin",
    },
    actor: {
      id: userId,
      openId: `user_${userId}`,
      email: `user_${userId}@test.local`,
      name: `User ${userId}`,
      role: "admin",
    },
    workspace: {
      id: `ws_${userId}`,
      ownerId: userId,
      role: "owner",
      isOwner: true,
      memberId: null,
    },
    req: {
      headers: {},
    } as any,
    res: {} as any,
  } as never);
}

describe("P1-A Core Recruitment Operating Loop", () => {
  const ownerA = 1001;
  const ownerB = 2002;

  // =========================================================================
  // PHASE A: CLIENT -> JOB
  // =========================================================================
  describe("Phase A: Client -> Job", () => {
    it("creates a valid job with scorecard and must-have skills for an owned client", async () => {
      const callerA = createCaller(ownerA);
      await ensureWorkspace(ownerA);

      const client = await callerA.recruitment.prospects.create({
        name: "Acme Global Tech",
        domain: "acmeglobal.test",
        sector: "Technology",
        location: "Singapore",
      });

      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "Senior Full Stack Engineer",
        department: "Engineering",
        location: "Singapore",
        workModel: "hybrid",
        compensationMin: 120000,
        compensationMax: 160000,
        experienceMinYears: 5,
        experienceMaxYears: 10,
        mustHaveSkills: ["TypeScript", "Node.js", "React"],
        niceToHaveSkills: ["PostgreSQL", "TailwindCSS"],
        scorecard: [
          { criterion: "System Architecture & Design", weight: 40, required: true },
          { criterion: "TypeScript & React Expertise", weight: 35, required: true },
          { criterion: "Communication & Leadership", weight: 25, required: false },
        ],
      });

      expect(job.id).toBeDefined();
      expect(job.requirementQuality).toBeGreaterThanOrEqual(70);

      const db = await requireDb();
      const [persistedJob] = await db.select().from(jobs).where(eq(jobs.id, job.id));
      expect(persistedJob.ownerId).toBe(ownerA);
      expect(persistedJob.companyId).toBe(client.id);
      expect(persistedJob.pipelineState).toBe("draft");
    });

    it("rejects job creation for non-existent or cross-owner client", async () => {
      const callerA = createCaller(ownerA);
      const callerB = createCaller(ownerB);
      await ensureWorkspace(ownerA);
      await ensureWorkspace(ownerB);

      const clientB = await callerB.recruitment.prospects.create({
        name: "Owner B Enterprise",
      });

      // Cross-owner client rejection
      await expect(
        callerA.recruitment.jobs.create({
          companyId: clientB.id,
          title: "Hacker Attempt Job",
          mustHaveSkills: ["Java"],
        }),
      ).rejects.toThrow(/not found/i);

      // Non-existent client rejection
      await expect(
        callerA.recruitment.jobs.create({
          companyId: "cmp_non_existent_9999",
          title: "Phantom Job",
          mustHaveSkills: ["Python"],
        }),
      ).rejects.toThrow(/not found/i);
    });
  });

  // =========================================================================
  // PHASE B: CANDIDATE -> SCREENING
  // =========================================================================
  describe("Phase B: Candidate -> Screening & Consent", () => {
    it("enforces consent before transitioning candidate to consented states", async () => {
      const callerA = createCaller(ownerA);
      await ensureWorkspace(ownerA);

      const candidate = await callerA.recruitment.candidates.create({
        fullName: "Jane Doe Candidate",
        email: "jane.doe@test.local",
        headline: "Principal Cloud Architect",
        location: "Bengaluru, India",
      });

      // Attempt transition to 'screening' without consent -> must fail
      await expect(
        callerA.recruitment.candidates.transition({
          id: candidate.id,
          state: "screening",
        }),
      ).rejects.toThrow(/consent/i);

      // Grant valid platform_processing consent -> transitions candidate to 'consented'
      await callerA.recruitment.candidates.grantConsent({
        candidateId: candidate.id,
        consentType: "platform_processing",
      });

      // Advance candidate from consented -> available -> screening
      await callerA.recruitment.candidates.transition({
        id: candidate.id,
        state: "available",
      });

      const transitionResult = await callerA.recruitment.candidates.transition({
        id: candidate.id,
        state: "screening",
      });
      expect(transitionResult.success).toBe(true);
    });

    it("creates screening record with validated ownership", async () => {
      const callerA = createCaller(ownerA);
      const callerB = createCaller(ownerB);

      const clientA = await callerA.recruitment.prospects.create({ name: "Screening Client" });
      const jobA = await callerA.recruitment.jobs.create({
        companyId: clientA.id,
        title: "Screening Role",
        mustHaveSkills: ["Go"],
      });
      const candidateA = await callerA.recruitment.candidates.create({
        fullName: "Screening Candidate",
        email: "screening.cand@test.local",
      });

      const screening = await callerA.recruitment.candidateWorkflows.screenings.create({
        candidateId: candidateA.id,
        jobId: jobA.id,
        answers: { experienceYears: 7, relocation: "Yes" },
        evidence: ["Confirmed 7 years experience in distributed systems"],
        confidence: 90,
      });
      expect(screening.id).toBeDefined();

      // Cross-owner attempt to screen Owner A's candidate for Owner B's job fails
      await expect(
        callerB.recruitment.candidateWorkflows.screenings.create({
          candidateId: candidateA.id,
          jobId: jobA.id,
          answers: {},
          evidence: ["Unauthorized"],
        }),
      ).rejects.toThrow(/not found/i);
    });
  });

  // =========================================================================
  // PHASE C: JOB <-> CANDIDATE MATCHING
  // =========================================================================
  describe("Phase C: Matching", () => {
    it("persists structured evidence match and respects ownership", async () => {
      const callerA = createCaller(ownerA);
      const callerB = createCaller(ownerB);

      const client = await callerA.recruitment.prospects.create({ name: "Match Co" });
      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "Staff Data Engineer",
        mustHaveSkills: ["Spark", "Kafka", "SQL"],
      });
      const candidate = await callerA.recruitment.candidates.create({
        fullName: "Data Specialist",
        email: "data.specialist@test.local",
      });

      const match = await callerA.recruitment.matching.createEvidenceMatch({
        candidateId: candidate.id,
        jobId: job.id,
        ruleScore: 88,
        semanticScore: 92,
        confidence: 90,
        evidence: ["5 years Spark in production", "Led Kafka streaming pipeline"],
        missingEvidence: [],
      });

      expect(match.id).toBeDefined();
      expect(match.lowConfidence).toBe(false);

      const db = await requireDb();
      const [persisted] = await db.select().from(matches).where(eq(matches.id, match.id));
      expect(persisted.ownerId).toBe(ownerA);
      expect(persisted.ruleScore).toBe(88);

      // Cross-owner match attempt rejected
      await expect(
        callerB.recruitment.matching.createEvidenceMatch({
          candidateId: candidate.id,
          jobId: job.id,
          ruleScore: 50,
          semanticScore: 50,
          confidence: 50,
          evidence: ["Fake evidence"],
        }),
      ).rejects.toThrow(/not found/i);
    });
  });

  // =========================================================================
  // PHASE D: SHORTLIST & GOVERNED SHARING
  // =========================================================================
  describe("Phase D: Shortlist & Governed Sharing", () => {
    it("rejects candidate sharing when client_sharing consent is missing, and requests approval when present", async () => {
      const callerA = createCaller(ownerA);

      const client = await callerA.recruitment.prospects.create({ name: "Share Client Ltd" });
      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "Frontend Architect",
        mustHaveSkills: ["React", "CSS"],
      });
      const candidate = await callerA.recruitment.candidates.create({
        fullName: "Shortlist Candidate",
        email: "shl.cand@test.local",
      });

      // Without client_sharing consent -> rejected
      await expect(
        callerA.recruitment.matching.requestShareApproval({
          candidateId: candidate.id,
          jobId: job.id,
          companyId: client.id,
        }),
      ).rejects.toThrow(/consent/i);

      // Grant explicit client_sharing consent linked to job and client
      await callerA.recruitment.candidates.grantConsent({
        candidateId: candidate.id,
        consentType: "client_sharing",
        jobId: job.id,
        companyId: client.id,
      });

      const shareResult = await callerA.recruitment.matching.requestShareApproval({
        candidateId: candidate.id,
        jobId: job.id,
        companyId: client.id,
      });

      expect(shareResult.shortlistId).toBeDefined();
      expect(shareResult.approvalId).toBeDefined();

      const db = await requireDb();
      const [persistedApproval] = await db.select().from(approvals).where(eq(approvals.id, shareResult.approvalId!));
      expect(persistedApproval.actionType).toBe("candidate_share");
      expect(persistedApproval.status).toBe("pending");
    });
  });

  // =========================================================================
  // PHASE E: INTERVIEW SCHEDULING & FEEDBACK
  // =========================================================================
  describe("Phase E: Interview Scheduling & Feedback", () => {
    it("schedules interview, conducts it, records feedback, and prevents cross-owner access", async () => {
      const callerA = createCaller(ownerA);
      const callerB = createCaller(ownerB);

      const client = await callerA.recruitment.prospects.create({ name: "Interview Co" });
      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "Lead Backend Engineer",
        mustHaveSkills: ["Rust"],
      });
      const candidate = await callerA.recruitment.candidates.create({
        fullName: "Interview Candidate",
        email: "interview.cand@test.local",
      });

      const scheduledAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const interview = await callerA.recruitment.interviews.create({
        companyId: client.id,
        candidateId: candidate.id,
        jobId: job.id,
        scheduledAt,
        durationMinutes: 60,
      });

      expect(interview.id).toBeDefined();

      // Transition interview from scheduled -> confirmed -> completed
      await callerA.recruitment.interviews.transition({
        id: interview.id,
        state: "confirmed",
      });

      await callerA.recruitment.interviews.transition({
        id: interview.id,
        state: "completed",
      });

      // Record feedback
      const feedbackRecord = await callerA.recruitment.feedback.record({
        interviewId: interview.id,
        authorName: "Engineering Director",
        rawFeedback: "Strong systems fundamentals, articulate communication, excellent problem-solving.",
        technicalScore: 5,
        communicationScore: 5,
        roleEvidence: ["Designed clean consensus algorithm on whiteboard"],
      });
      expect(feedbackRecord.id).toBeDefined();

      const db = await requireDb();
      const [updatedInterview] = await db.select().from(interviews).where(eq(interviews.id, interview.id));
      expect(updatedInterview.status).toBe("feedback_received");

      // Cross-owner attempt to read or write feedback fails
      await expect(
        callerB.recruitment.feedback.list({
          interviewId: interview.id,
        }),
      ).rejects.toThrow(/not found/i);
    });
  });

  // =========================================================================
  // PHASE F: FINAL CANDIDATE DECISION (GOVERNED)
  // =========================================================================
  describe("Phase F: Final Candidate Decision", () => {
    it("routes candidate decision to consequential approval and applies side effect upon owner approval", async () => {
      const callerA = createCaller(ownerA);

      const client = await callerA.recruitment.prospects.create({ name: "Decision Client" });
      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "Principal Security Engineer",
        mustHaveSkills: ["AppSec"],
      });
      const candidate = await callerA.recruitment.candidates.create({
        fullName: "Decision Candidate",
        email: "dec.cand@test.local",
      });

      const decisionRequest = await callerA.recruitment.consequential.requestCandidateDecision({
        candidateId: candidate.id,
        jobId: job.id,
        disposition: "advance",
        evidence: ["Passed all technical rounds with top ratings"],
        rationale: "Strong culture add, matches all required security certifications.",
      });

      expect(decisionRequest.screeningId).toBeDefined();
      expect(decisionRequest.approvalId).toBeDefined();

      const db = await requireDb();
      const [screeningBefore] = await db.select().from(screenings).where(eq(screenings.id, decisionRequest.screeningId));
      expect(screeningBefore.status).toBe("decision_pending");

      // Approve the governed decision
      await callerA.recruitment.approvals.decide({
        id: decisionRequest.approvalId,
        decision: "approved",
        note: "Approved by workspace owner.",
      });

      const [screeningAfter] = await db.select().from(screenings).where(eq(screenings.id, decisionRequest.screeningId));
      expect(screeningAfter.status).toBe("owner_decided");
    });
  });

  // =========================================================================
  // PHASE G: PLACEMENT & JOINING CONFIRMATION
  // =========================================================================
  describe("Phase G: Placement & Joining Confirmation", () => {
    it("creates placement, governs joining confirmation, and requires joining evidence", async () => {
      const callerA = createCaller(ownerA);

      const client = await callerA.recruitment.prospects.create({ name: "Placement Client" });
      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "Head of Infrastructure",
        mustHaveSkills: ["Kubernetes"],
      });
      const candidate = await callerA.recruitment.candidates.create({
        fullName: "Placed Candidate",
        email: "placed.cand@test.local",
      });

      const placement = await callerA.recruitment.placements.create({
        companyId: client.id,
        candidateId: candidate.id,
        jobId: job.id,
        annualCompensation: 220000,
      });

      expect(placement.id).toBeDefined();

      // Transitioning: offer_pending -> offer_issued -> offer_accepted -> joining_pending
      await callerA.recruitment.placements.transition({
        id: placement.id,
        state: "offer_issued",
      });

      await callerA.recruitment.placements.transition({
        id: placement.id,
        state: "offer_accepted",
      });

      await callerA.recruitment.placements.transition({
        id: placement.id,
        state: "joining_pending",
      });

      // Transitioning to joining_confirmed requires joining evidence and routes to consequential approval
      const confirmResult = await callerA.recruitment.placements.transition({
        id: placement.id,
        state: "joining_confirmed",
        joiningEvidence: ["Signed employment contract", "Verified employee ID badge"],
      });

      expect(confirmResult.approvalRequired).toBe(true);
      expect(confirmResult.approvalId).toBeDefined();

      // Owner approves placement confirmation
      await callerA.recruitment.approvals.decide({
        id: confirmResult.approvalId!,
        decision: "approved",
        note: "Joining verified with HR.",
      });

      const db = await requireDb();
      const [updatedPlacement] = await db.select().from(placements).where(eq(placements.id, placement.id));
      expect(updatedPlacement.status).toBe("joining_confirmed");
      expect(updatedPlacement.joiningConfirmedAt).toBeInstanceOf(Date);
    });
  });

  // =========================================================================
  // PHASE H: FINANCE HANDOFF & INVOICING
  // =========================================================================
  describe("Phase H: Finance Handoff", () => {
    it("allows draft invoice only when placement is invoice_eligible, rejects cross-client mismatch", async () => {
      const callerA = createCaller(ownerA);

      const client = await callerA.recruitment.prospects.create({ name: "Finance Client" });
      const otherClient = await callerA.recruitment.prospects.create({ name: "Other Client" });
      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "Finance Role",
        mustHaveSkills: ["Finance"],
      });
      const candidate = await callerA.recruitment.candidates.create({
        fullName: "Finance Candidate",
        email: "fin.cand@test.local",
      });

      const placement = await callerA.recruitment.placements.create({
        companyId: client.id,
        candidateId: candidate.id,
        jobId: job.id,
        annualCompensation: 150000,
      });

      // In offer_pending state -> cannot draft invoice
      await expect(
        callerA.recruitment.invoices.draft({
          placementId: placement.id,
          companyId: client.id,
          invoiceNumber: "INV-PRE-001",
          amount: 30000,
        }),
      ).rejects.toThrow(/invoice-eligible/i);

      // Advance placement to invoice_eligible
      const db = await requireDb();
      await db.update(placements).set({ status: "invoice_eligible" }).where(eq(placements.id, placement.id));

      // Client mismatch rejection
      await expect(
        callerA.recruitment.invoices.draft({
          placementId: placement.id,
          companyId: otherClient.id,
          invoiceNumber: "INV-MISMATCH-001",
          amount: 30000,
        }),
      ).rejects.toThrow(/does not match/i);

      // Valid draft invoice creation
      const draft = await callerA.recruitment.invoices.draft({
        placementId: placement.id,
        companyId: client.id,
        invoiceNumber: "INV-P1A-001",
        amount: 30000,
        taxAmount: 5400,
      });

      expect(draft.id).toBeDefined();

      const [persistedInvoice] = await db.select().from(invoices).where(eq(invoices.id, draft.id));
      expect(persistedInvoice.status).toBe("draft");
      expect(persistedInvoice.amount).toBe(30000);
      expect(persistedInvoice.ownerId).toBe(ownerA);
    });
  });
});
