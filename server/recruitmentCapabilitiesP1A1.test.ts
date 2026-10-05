import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  approvals,
  candidateDocuments,
  candidates,
  companies,
  consents,
  jobs,
  matches,
  placements,
  screenings,
  shortlists,
  suppressionList,
} from "../drizzle/schema";
import { createId, ensureWorkspace, hashContactValue, requireDb } from "./db";
import { appRouter } from "./routers";
import { computeGuaranteeStatus } from "./services/guaranteeTracking";

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

describe("P1-A.1 — Core Recruitment Feature Implementation", () => {
  const ownerA = 3001;
  const ownerB = 4002;

  // =========================================================================
  // 1. FEAT-066: Internal Candidate Skill Search
  // =========================================================================
  describe("FEAT-066: Internal Candidate Skill Search", () => {
    it("searches candidates by single skill, multiple skills, and respects eligibility and isolation", async () => {
      const callerA = createCaller(ownerA);
      const callerB = createCaller(ownerB);
      await ensureWorkspace(ownerA);
      await ensureWorkspace(ownerB);

      const db = await requireDb();

      // Candidate 1: React + TypeScript + Node.js
      const cand1 = await callerA.recruitment.candidates.create({
        fullName: "Alice Developer",
        headline: "Senior React & TypeScript Specialist",
        location: "Bengaluru, India",
      });
      await db.insert(candidateDocuments).values({
        id: createId("doc_"),
        candidateId: cand1.id,
        ownerId: ownerA,
        documentType: "cv",
        storageKey: `private/${ownerA}/${cand1.id}/cv.pdf`,
        storageUrl: "https://storage.local/cv.pdf",
        originalName: "cv.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        scanState: "clean",
        parseState: "parsed",
        parsedData: { skills: ["React", "TypeScript", "Node.js", "GraphQL"] },
      });

      // Candidate 2: Python + PyTorch + AI
      const cand2 = await callerA.recruitment.candidates.create({
        fullName: "Bob Engineer",
        headline: "Machine Learning Engineer",
        location: "Hyderabad, India",
      });
      await db.insert(candidateDocuments).values({
        id: createId("doc_"),
        candidateId: cand2.id,
        ownerId: ownerA,
        documentType: "cv",
        storageKey: `private/${ownerA}/${cand2.id}/cv.pdf`,
        storageUrl: "https://storage.local/cv.pdf",
        originalName: "cv.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        scanState: "clean",
        parseState: "parsed",
        parsedData: { skills: ["Python", "PyTorch", "FastAPI", "Docker"] },
      });

      // Candidate 3: Owner B candidate (React) -> must be isolated from Owner A
      const candB = await callerB.recruitment.candidates.create({
        fullName: "Charlie Isolated",
        headline: "Lead React Developer",
      });
      await db.insert(candidateDocuments).values({
        id: createId("doc_"),
        candidateId: candB.id,
        ownerId: ownerB,
        documentType: "cv",
        storageKey: `private/${ownerB}/${candB.id}/cv.pdf`,
        storageUrl: "https://storage.local/cv.pdf",
        originalName: "cv.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        scanState: "clean",
        parseState: "parsed",
        parsedData: { skills: ["React", "Redux"] },
      });

      // Candidate 4: Suppressed/deleted candidate -> must be excluded
      const candDeleted = await callerA.recruitment.candidates.create({
        fullName: "David Deleted",
        headline: "Senior React Architect",
      });
      await db.update(candidates).set({ profileState: "deleted" }).where(eq(candidates.id, candDeleted.id));

      // Test 1: Search single skill 'React'
      const reactSearch = await callerA.recruitment.candidates.searchSkills({
        skills: ["React"],
      });
      expect(reactSearch.total).toBe(1);
      expect(reactSearch.items[0].id).toBe(cand1.id);
      expect(reactSearch.items[0].matchedSkills).toContain("react");
      expect(reactSearch.items.some(c => c.id === candB.id)).toBe(false);
      expect(reactSearch.items.some(c => c.id === candDeleted.id)).toBe(false);

      // Test 2: Multi-skill matchMode 'all' vs 'any'
      const multiAny = await callerA.recruitment.candidates.searchSkills({
        skills: ["React", "Python"],
        matchMode: "any",
      });
      expect(multiAny.total).toBe(2);

      const multiAll = await callerA.recruitment.candidates.searchSkills({
        skills: ["React", "Python"],
        matchMode: "all",
      });
      expect(multiAll.total).toBe(0);

      // Test 3: No-match search
      const noMatch = await callerA.recruitment.candidates.searchSkills({
        skills: ["COBOL", "Fortran"],
      });
      expect(noMatch.total).toBe(0);
      expect(noMatch.items).toHaveLength(0);

      // Test 4: Pagination
      const paged = await callerA.recruitment.candidates.searchSkills({
        skills: ["React", "Python"],
        matchMode: "any",
        limit: 1,
        offset: 0,
      });
      expect(paged.items).toHaveLength(1);
      expect(paged.total).toBe(2);
    });
  });

  // =========================================================================
  // 2. FEAT-073: Candidate Share Approval Request Completion
  // =========================================================================
  describe("FEAT-073: Candidate Share Approval Request Completion", () => {
    it("enforces consent, suppression, active job state, and governed approval before sharing", async () => {
      const callerA = createCaller(ownerA);
      const callerB = createCaller(ownerB);

      const client = await callerA.recruitment.prospects.create({ name: "Share Enterprise" });
      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "Principal Cloud Engineer",
        mustHaveSkills: ["AWS"],
      });
      const candidate = await callerA.recruitment.candidates.create({
        fullName: "Sarah Shareable",
        email: "sarah.share@test.local",
      });

      // 1. Missing consent -> Rejected
      await expect(
        callerA.recruitment.matching.requestShareApproval({
          candidateId: candidate.id,
          jobId: job.id,
          companyId: client.id,
        }),
      ).rejects.toThrow(/consent/i);

      // 2. Grant explicit consent
      await callerA.recruitment.candidates.grantConsent({
        candidateId: candidate.id,
        consentType: "client_sharing",
        jobId: job.id,
        companyId: client.id,
      });

      // 3. Valid share request -> created in pending state, NOT yet shared
      const shareReq = await callerA.recruitment.matching.requestShareApproval({
        candidateId: candidate.id,
        jobId: job.id,
        companyId: client.id,
      });

      expect(shareReq.shortlistId).toBeDefined();
      expect(shareReq.approvalId).toBeDefined();

      const db = await requireDb();
      const [shortlistBefore] = await db.select().from(shortlists).where(eq(shortlists.id, shareReq.shortlistId));
      expect(shortlistBefore.status).toBe("approval_pending");

      // 4. Repeated request while pending -> idempotent return of existing approval
      const duplicateReq = await callerA.recruitment.matching.requestShareApproval({
        candidateId: candidate.id,
        jobId: job.id,
        companyId: client.id,
      });
      expect(duplicateReq.shortlistId).toBe(shareReq.shortlistId);
      expect(duplicateReq.approvalId).toBe(shareReq.approvalId);

      // 5. Approve candidate share
      await callerA.recruitment.approvals.decide({
        id: shareReq.approvalId!,
        decision: "approved",
        note: "Approved candidate sharing with client.",
      });

      const [shortlistAfter] = await db.select().from(shortlists).where(eq(shortlists.id, shareReq.shortlistId));
      expect(shortlistAfter.status).toBe("shared");
      expect(shortlistAfter.sharedAt).toBeInstanceOf(Date);
      expect(shortlistAfter.shareExpiresAt).toBeInstanceOf(Date);

      // 6. Attempting to share again after already shared -> Rejected
      await expect(
        callerA.recruitment.matching.requestShareApproval({
          candidateId: candidate.id,
          jobId: job.id,
          companyId: client.id,
        }),
      ).rejects.toThrow(/already been shared/i);

      // 7. Cross-owner candidate / job rejection
      await expect(
        callerB.recruitment.matching.requestShareApproval({
          candidateId: candidate.id,
          jobId: job.id,
          companyId: client.id,
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("rejects candidate sharing if candidate is on the suppression list", async () => {
      const callerA = createCaller(ownerA);

      const client = await callerA.recruitment.prospects.create({ name: "Suppression Client" });
      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "DevOps Engineer",
        mustHaveSkills: ["Terraform"],
      });
      const candidate = await callerA.recruitment.candidates.create({
        fullName: "Suppressed Candidate",
        email: "suppressed.cand@test.local",
      });

      await callerA.recruitment.candidates.grantConsent({
        candidateId: candidate.id,
        consentType: "client_sharing",
        jobId: job.id,
        companyId: client.id,
      });

      // Suppress candidate
      const db = await requireDb();
      await db.insert(suppressionList).values({
        id: createId("sup_"),
        ownerId: ownerA,
        channel: "email",
        valueHash: hashContactValue("suppressed.cand@test.local"),
        reason: "candidate_opt_out",
        source: "owner",
        active: true,
      });

      await expect(
        callerA.recruitment.matching.requestShareApproval({
          candidateId: candidate.id,
          jobId: job.id,
          companyId: client.id,
        }),
      ).rejects.toThrow(/suppressed/i);
    });
  });

  // =========================================================================
  // 3. FEAT-082 & FEAT-083: Placement Creation & Commercial Offer Extension
  // =========================================================================
  describe("FEAT-082 & FEAT-083: Placement Creation & Commercial Job Offer Extension", () => {
    it("requires a positive final candidate decision, prevents duplicate placement, and extends commercial offer", async () => {
      const callerA = createCaller(ownerA);

      const client = await callerA.recruitment.prospects.create({ name: "Offer Enterprise" });
      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "VP of Engineering",
        mustHaveSkills: ["Executive Leadership"],
      });
      const candidate = await callerA.recruitment.candidates.create({
        fullName: "VPE Candidate",
        email: "vpe.cand@test.local",
      });

      // 1. Without final candidate decision -> placement creation rejected
      await expect(
        callerA.recruitment.placements.create({
          companyId: client.id,
          candidateId: candidate.id,
          jobId: job.id,
          annualCompensation: 250000,
        }),
      ).rejects.toThrow(/final candidate decision/i);

      // 2. Create and approve candidate final decision
      const decisionReq = await callerA.recruitment.consequential.requestCandidateDecision({
        candidateId: candidate.id,
        jobId: job.id,
        disposition: "advance",
        evidence: ["Passed all executive rounds with unanimous consensus"],
        rationale: "Outstanding fit for the leadership role.",
      });

      await callerA.recruitment.approvals.decide({
        id: decisionReq.approvalId,
        decision: "approved",
      });

      // 3. Now placement creation succeeds in offer_pending state
      const placement = await callerA.recruitment.placements.create({
        companyId: client.id,
        candidateId: candidate.id,
        jobId: job.id,
        annualCompensation: 250000,
        currency: "INR",
      });
      expect(placement.id).toBeDefined();

      const db = await requireDb();
      const [persistedPlacement] = await db.select().from(placements).where(eq(placements.id, placement.id));
      expect(persistedPlacement.status).toBe("offer_pending");

      // 4. Duplicate placement creation rejected
      await expect(
        callerA.recruitment.placements.create({
          companyId: client.id,
          candidateId: candidate.id,
          jobId: job.id,
          annualCompensation: 250000,
        }),
      ).rejects.toThrow(/already exists/i);

      // 5. Commercial Job Offer Extension (FEAT-082)
      const extended = await callerA.recruitment.placements.extendOffer({
        placementId: placement.id,
        annualCompensation: 260000,
        currency: "INR",
        notes: "Formal offer extended with equity package.",
      });
      expect(extended.status).toBe("offer_issued");
      expect(extended.offerIssuedAt).toBeInstanceOf(Date);

      const [afterExtend] = await db.select().from(placements).where(eq(placements.id, placement.id));
      expect(afterExtend.status).toBe("offer_issued");
      expect(afterExtend.annualCompensation).toBe(260000);

      // 6. Offer Decision: Acceptance (FEAT-082)
      const decisionResult = await callerA.recruitment.placements.recordOfferDecision({
        placementId: placement.id,
        decision: "accepted",
        note: "Candidate signed formal offer letter.",
      });
      expect(decisionResult.status).toBe("offer_accepted");

      const [afterAccept] = await db.select().from(placements).where(eq(placements.id, placement.id));
      expect(afterAccept.status).toBe("offer_accepted");
      expect(afterAccept.offerAcceptedAt).toBeInstanceOf(Date);
    });
  });

  // =========================================================================
  // 5. FEAT-086: Candidate Joining Confirmation Side Effect
  // =========================================================================
  describe("FEAT-086: Candidate Joining Confirmation Side Effect", () => {
    it("governs joining confirmation, verifies joining evidence, and sets joiningConfirmedAt and guarantee timestamps", async () => {
      const callerA = createCaller(ownerA);

      const client = await callerA.recruitment.prospects.create({ name: "Joining Client" });
      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "Staff SRE",
        mustHaveSkills: ["Kubernetes", "Linux"],
      });
      const candidate = await callerA.recruitment.candidates.create({
        fullName: "SRE Placed",
        email: "sre.placed@test.local",
      });

      // Positive screening decision
      const decision = await callerA.recruitment.consequential.requestCandidateDecision({
        candidateId: candidate.id,
        jobId: job.id,
        disposition: "advance",
        evidence: ["Top tier SRE skills"],
        rationale: "Ready for offer.",
      });
      await callerA.recruitment.approvals.decide({ id: decision.approvalId, decision: "approved" });

      const placement = await callerA.recruitment.placements.create({
        companyId: client.id,
        candidateId: candidate.id,
        jobId: job.id,
        annualCompensation: 180000,
      });

      // Progress: offer_pending -> offer_issued -> offer_accepted -> joining_pending
      await callerA.recruitment.placements.extendOffer({
        placementId: placement.id,
        annualCompensation: 180000,
      });
      await callerA.recruitment.placements.recordOfferDecision({
        placementId: placement.id,
        decision: "accepted",
      });
      await callerA.recruitment.placements.transition({
        id: placement.id,
        state: "joining_pending",
      });

      // Attempt joining without evidence -> rejected
      await expect(
        callerA.recruitment.placements.transition({
          id: placement.id,
          state: "joining_confirmed",
          joiningEvidence: [],
        }),
      ).rejects.toThrow(/joining evidence/i);

      // Request joining confirmation with evidence
      const confirmReq = await callerA.recruitment.placements.transition({
        id: placement.id,
        state: "joining_confirmed",
        joiningEvidence: ["Verified Day 1 onboarding badge", "Joined Slack workspace"],
      });

      expect(confirmReq.approvalRequired).toBe(true);
      expect(confirmReq.approvalId).toBeDefined();

      // Owner approves joining confirmation
      await callerA.recruitment.approvals.decide({
        id: confirmReq.approvalId!,
        decision: "approved",
        note: "Verified arrival at client office.",
      });

      const db = await requireDb();
      const [joinedPlacement] = await db.select().from(placements).where(eq(placements.id, placement.id));
      expect(joinedPlacement.status).toBe("joining_confirmed");
      expect(joinedPlacement.joiningConfirmedAt).toBeInstanceOf(Date);
      expect(joinedPlacement.guaranteeStartAt).toBeInstanceOf(Date);
      expect(joinedPlacement.guaranteeEndAt).toBeInstanceOf(Date);
    });
  });

  // =========================================================================
  // 6. FEAT-088: Guarantee Period Active Tracking
  // =========================================================================
  describe("FEAT-088: Guarantee Period Active Tracking", () => {
    it("computes active, expired, not-started, and replacement statuses deterministically", async () => {
      const callerA = createCaller(ownerA);

      const now = new Date("2026-10-05T12:00:00.000Z");

      // 1. Active guarantee: started 30 days ago, ends in 60 days
      const activeStart = new Date("2026-09-05T12:00:00.000Z");
      const activeEnd = new Date("2026-12-04T12:00:00.000Z");
      const activeStatus = computeGuaranteeStatus(
        {
          id: "plc_act_1",
          status: "joining_confirmed",
          guaranteeStartAt: activeStart,
          guaranteeEndAt: activeEnd,
        },
        now,
      );
      expect(activeStatus.status).toBe("active");
      expect(activeStatus.isActive).toBe(true);
      expect(activeStatus.isExpired).toBe(false);
      expect(activeStatus.daysRemaining).toBe(60);

      // 2. Expired guarantee: started 100 days ago, ended 10 days ago
      const expiredStart = new Date("2026-06-27T12:00:00.000Z");
      const expiredEnd = new Date("2026-09-25T12:00:00.000Z");
      const expiredStatus = computeGuaranteeStatus(
        {
          id: "plc_exp_1",
          status: "guarantee_ended",
          guaranteeStartAt: expiredStart,
          guaranteeEndAt: expiredEnd,
        },
        now,
      );
      expect(expiredStatus.status).toBe("expired");
      expect(expiredStatus.isActive).toBe(false);
      expect(expiredStatus.isExpired).toBe(true);
      expect(expiredStatus.daysRemaining).toBe(0);

      // 3. Not started guarantee
      const notStartedStatus = computeGuaranteeStatus(
        {
          id: "plc_ns_1",
          status: "offer_accepted",
          guaranteeStartAt: null,
          guaranteeEndAt: null,
        },
        now,
      );
      expect(notStartedStatus.status).toBe("not_started");
      expect(notStartedStatus.isActive).toBe(false);

      // 4. Replacement requested status
      const replacementStatus = computeGuaranteeStatus(
        {
          id: "plc_rep_1",
          status: "replacement_requested",
          guaranteeStartAt: activeStart,
          guaranteeEndAt: activeEnd,
        },
        now,
      );
      expect(replacementStatus.status).toBe("replacement_requested");
      expect(replacementStatus.isActive).toBe(false);

      // 5. Querying getGuaranteeStatus via placement endpoint
      const client = await callerA.recruitment.prospects.create({ name: "Guarantee Client" });
      const job = await callerA.recruitment.jobs.create({
        companyId: client.id,
        title: "Guarantee Engineer",
        mustHaveSkills: ["QA"],
      });
      const candidate = await callerA.recruitment.candidates.create({
        fullName: "QA Candidate",
        email: "qa.cand@test.local",
      });

      const dec = await callerA.recruitment.consequential.requestCandidateDecision({
        candidateId: candidate.id,
        jobId: job.id,
        disposition: "advance",
        evidence: ["Top QA engineer"],
        rationale: "Approved",
      });
      await callerA.recruitment.approvals.decide({ id: dec.approvalId, decision: "approved" });

      const placement = await callerA.recruitment.placements.create({
        companyId: client.id,
        candidateId: candidate.id,
        jobId: job.id,
        annualCompensation: 120000,
      });

      const guaranteeInfo = await callerA.recruitment.placements.getGuaranteeStatus({
        id: placement.id,
      });
      expect(guaranteeInfo.placementId).toBe(placement.id);
      expect(guaranteeInfo.status).toBe("not_started");
    });
  });
});
