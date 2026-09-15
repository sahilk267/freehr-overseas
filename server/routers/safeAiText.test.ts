import { describe, expect, it, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { requireDb } from "../db";
import { companies, contacts, conversations, candidates, jobs, interviews, screenings, matches, feedback, messages, automationQueue } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { recruitmentRouter } from "./recruitment";

describe("ensureSafeAiText entry point integration tests", () => {
  const ownerCtx = {
    user: { id: 1, role: "admin", name: "Owner", email: "owner@freelancehr.local" },
    req: {},
    res: {},
  } as never;

  const caller = recruitmentRouter.createCaller(ownerCtx);
  const ts = Date.now();
  const companyId = `cmp_safe_${ts}`;
  const contactId = `cnt_safe_${ts}`;
  const conversationId = `cvn_safe_${ts}`;
  const candidateId = `can_safe_${ts}`;
  const jobId = `job_safe_${ts}`;
  const interviewId = `int_safe_${ts}`;

  beforeEach(async () => {
    const db = await requireDb();
    await db.insert(companies).values({ id: companyId, ownerId: 1, name: "Safe AI Corp" });
    await db.insert(contacts).values({ id: contactId, ownerId: 1, companyId, name: "Hiring Manager", email: `safe_${ts}@example.com` });
    await db.insert(conversations).values({ id: conversationId, ownerId: 1, companyId, contactId, channel: "email", status: "contacted" });
    await db.insert(candidates).values({ id: candidateId, ownerId: 1, fullName: "Taylor Swift Developer" });
    await db.insert(jobs).values({ id: jobId, ownerId: 1, companyId, title: "Senior Cloud Engineer", mustHaveSkills: ["TypeScript", "AWS"] });
    await db.insert(interviews).values({ id: interviewId, ownerId: 1, companyId, candidateId, jobId, status: "completed" });
  });

  // Call Site 1: outreachRouter.draftSequence (input.context)
  describe("1. outreachRouter.draftSequence (input.context)", () => {
    it("rejects prohibited terms in context with TRPCError", async () => {
      await expect(
        caller.outreach.draftSequence({
          contactId,
          purpose: "client_intro",
          context: "Please highlight that the candidate follows a specific religion and attends church.",
        })
      ).rejects.toThrow(TRPCError);

      await expect(
        caller.outreach.draftSequence({
          contactId,
          purpose: "candidate_outreach",
          context: "Candidate is pregnant and looking for maternity leaves.",
        })
      ).rejects.toThrow(TRPCError);
    });

    it("allows legitimate context to pass through successfully", async () => {
      const res = await caller.outreach.draftSequence({
        contactId,
        purpose: "client_intro",
        context: "Introducing our senior distributed systems architect with extensive Node.js background.",
      });
      expect(res.conversationId).toBeTruthy();
      expect(res.queueId).toBeTruthy();

      const db = await requireDb();
      const [queued] = await db.select().from(automationQueue).where(eq(automationQueue.id, res.queueId));
      expect(queued).toBeDefined();
      expect((queued.payload as { context: string }).context).toContain("senior distributed systems architect");
    });
  });

  // Call Site 2: outreachRouter.classifyInboundReply (input.messageText)
  describe("2. outreachRouter.classifyInboundReply (input.messageText)", () => {
    it("rejects prohibited terms in messageText with TRPCError", async () => {
      await expect(
        caller.outreach.classifyInboundReply({
          conversationId,
          messageText: "We prefer not to interview this candidate due to caste preferences in our region.",
        })
      ).rejects.toThrow(TRPCError);

      await expect(
        caller.outreach.classifyInboundReply({
          conversationId,
          messageText: "Applicant stated she is pregnant, is there an age preference?",
        })
      ).rejects.toThrow(TRPCError);
    });

    it("allows legitimate inbound messageText to pass through successfully", async () => {
      const res = await caller.outreach.classifyInboundReply({
        conversationId,
        messageText: "Thanks for reaching out. We would like to schedule an initial technical discussion next Tuesday.",
      });
      expect(res.messageId).toBeTruthy();
      expect(res.queueId).toBeTruthy();

      const db = await requireDb();
      const [msg] = await db.select().from(messages).where(eq(messages.id, res.messageId));
      expect(msg.body).toBe("Thanks for reaching out. We would like to schedule an initial technical discussion next Tuesday.");
    });
  });

  // Call Site 3: matchingRouter.createEvidenceMatch (input.evidence, input.missingEvidence entries)
  describe("3. matchingRouter.createEvidenceMatch (input.evidence, input.missingEvidence entries)", () => {
    it("rejects prohibited terms in evidence entries with TRPCError", async () => {
      await expect(
        caller.matching.createEvidenceMatch({
          candidateId,
          jobId,
          ruleScore: 85,
          semanticScore: 90,
          confidence: 88,
          evidence: ["Candidate practices specific religion outside of work hours."],
          missingEvidence: [],
        })
      ).rejects.toThrow(TRPCError);
    });

    it("rejects prohibited terms in missingEvidence entries with TRPCError", async () => {
      await expect(
        caller.matching.createEvidenceMatch({
          candidateId,
          jobId,
          ruleScore: 85,
          semanticScore: 90,
          confidence: 88,
          evidence: ["Proven 8+ years with microservices architecture."],
          missingEvidence: ["Candidate undisclosed marital status and pregnant state."],
        })
      ).rejects.toThrow(TRPCError);
    });

    it("allows legitimate evidence and missingEvidence entries to pass through successfully", async () => {
      const res = await caller.matching.createEvidenceMatch({
        candidateId,
        jobId,
        ruleScore: 85,
        semanticScore: 90,
        confidence: 88,
        evidence: [
          "Demonstrated 7+ years of production TypeScript and microservices.",
          "Strong background in Kubernetes and infrastructure automation.",
        ],
        missingEvidence: ["Limited experience with GraphQL schemas."],
      });
      expect(res.id).toBeTruthy();

      const db = await requireDb();
      const [match] = await db.select().from(matches).where(eq(matches.id, res.id));
      expect(match).toBeDefined();
      expect(match.evidence).toEqual([
        "Demonstrated 7+ years of production TypeScript and microservices.",
        "Strong background in Kubernetes and infrastructure automation.",
      ]);
      expect(match.missingEvidence).toEqual(["Limited experience with GraphQL schemas."]);
    });
  });

  // Call Site 4: candidateWorkflows.ts → screenings.create (input.answers values, input.evidence entries)
  describe("4. candidateWorkflows.ts → screenings.create (input.answers values, input.evidence entries)", () => {
    it("rejects prohibited terms in answers with TRPCError", async () => {
      await expect(
        caller.candidateWorkflows.screenings.create({
          candidateId,
          jobId,
          answers: {
            cultureFit: "Candidate mentions religion as a deciding factor for work location.",
          },
          evidence: ["Strong architectural background"],
        })
      ).rejects.toThrow(TRPCError);

      await expect(
        caller.candidateWorkflows.screenings.create({
          candidateId,
          jobId,
          answers: {
            backgroundDetails: {
              familyInfo: "Candidate confirmed pregnant status.",
            },
          },
          evidence: ["5 years of Node.js"],
        })
      ).rejects.toThrow(TRPCError);
    });

    it("rejects prohibited terms in evidence entries with TRPCError", async () => {
      await expect(
        caller.candidateWorkflows.screenings.create({
          candidateId,
          jobId,
          answers: {
            technical: "Strong in Python and Go.",
          },
          evidence: ["Filter out due to disability concerns."],
        })
      ).rejects.toThrow(TRPCError);
    });

    it("allows legitimate answers and evidence to pass through successfully", async () => {
      const res = await caller.candidateWorkflows.screenings.create({
        candidateId,
        jobId,
        answers: {
          experienceYears: 6,
          preferredLanguage: "TypeScript",
          systemDesign: "Experienced with Kafka event pipelines and Redis caching.",
        },
        evidence: [
          "Passed technical screening on concurrency and distributed locking.",
          "Solid communication during system design walkthrough.",
        ],
        confidence: 90,
      });
      expect(res.id).toBeTruthy();

      const db = await requireDb();
      const [screening] = await db.select().from(screenings).where(eq(screenings.id, res.id));
      expect(screening).toBeDefined();
      expect((screening.answers as Record<string, unknown>).preferredLanguage).toBe("TypeScript");
      expect(screening.evidence).toContain("Passed technical screening on concurrency and distributed locking.");
    });
  });

  // Call Site 5: recruitment.ts → feedbackRouter.record (input.rawFeedback, input.roleEvidence)
  describe("5. recruitment.ts → feedbackRouter.record (input.rawFeedback, input.roleEvidence)", () => {
    it("rejects prohibited terms in rawFeedback with TRPCError", async () => {
      await expect(
        caller.feedback.record({
          interviewId,
          authorName: "Engineering Lead",
          rawFeedback: "Candidate is technically competent but interviewer asked about religion and personal background.",
          roleEvidence: ["Proficient in AWS"],
        })
      ).rejects.toThrow(TRPCError);

      await expect(
        caller.feedback.record({
          interviewId,
          authorName: "Engineering Lead",
          rawFeedback: "Interview notes mention candidate stated she is pregnant during interview.",
          roleEvidence: ["Solid React skills"],
        })
      ).rejects.toThrow(TRPCError);
    });

    it("rejects prohibited terms in roleEvidence with TRPCError", async () => {
      await expect(
        caller.feedback.record({
          interviewId,
          authorName: "Engineering Lead",
          rawFeedback: "Candidate performed exceptionally well in the algorithms and data structures interview.",
          roleEvidence: ["Flagged candidate caste or background background"],
        })
      ).rejects.toThrow(TRPCError);
    });

    it("allows legitimate rawFeedback and roleEvidence to pass through successfully", async () => {
      const res = await caller.feedback.record({
        interviewId,
        authorName: "Principal Architect",
        rawFeedback: "The candidate demonstrated excellent understanding of eventual consistency and SQL indexing tradeoffs.",
        technicalScore: 5,
        communicationScore: 4,
        roleEvidence: [
          "Designed a robust idempotent queue processing architecture.",
          "Answered database sharding questions with high clarity.",
        ],
      });
      expect(res.id).toBeTruthy();

      const db = await requireDb();
      const [fb] = await db.select().from(feedback).where(eq(feedback.id, res.id));
      expect(fb).toBeDefined();
      expect(fb.rawFeedback).toContain("eventual consistency");
    });
  });

  // Call Site 6: jobsRouter.create scorecard criterion text
  describe("6. jobsRouter.create scorecard criterion text", () => {
    it("rejects prohibited terms in scorecard criterion text with TRPCError", async () => {
      await expect(
        caller.jobs.create({
          companyId,
          title: "Senior Product Manager",
          mustHaveSkills: ["Roadmapping"],
          scorecard: [
            {
              criterion: "Must assess candidate religion alignment with corporate culture",
              weight: 100,
              required: true,
            },
          ],
        })
      ).rejects.toThrow(TRPCError);

      await expect(
        caller.jobs.create({
          companyId,
          title: "Operations Associate",
          mustHaveSkills: ["Logistics"],
          scorecard: [
            {
              criterion: "Screen if candidate is pregnant or plans maternity leaves",
              weight: 100,
              required: false,
            },
          ],
        })
      ).rejects.toThrow(TRPCError);
    });

    it("allows legitimate scorecard criterion text to pass through successfully", async () => {
      const res = await caller.jobs.create({
        companyId,
        title: "Staff Infrastructure Engineer",
        mustHaveSkills: ["Terraform", "Kubernetes"],
        scorecard: [
          {
            criterion: "Demonstrates production experience managing multi-region Kubernetes clusters",
            weight: 60,
            required: true,
          },
          {
            criterion: "Clear communication regarding disaster recovery and post-mortems",
            weight: 40,
            required: false,
          },
        ],
      });
      expect(res.id).toBeTruthy();

      const db = await requireDb();
      const [job] = await db.select().from(jobs).where(eq(jobs.id, res.id));
      expect(job).toBeDefined();
      expect(job.title).toBe("Staff Infrastructure Engineer");
      expect((job.scorecard as Array<{ criterion: string }>)[0].criterion).toBe(
        "Demonstrates production experience managing multi-region Kubernetes clusters"
      );
    });
  });
});
