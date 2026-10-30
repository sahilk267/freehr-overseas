import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { automationQueue, candidates, companies, consents, emailIdentities, followUpPlans, interviews, jobs } from "../../drizzle/schema";
import { createId, requireDb } from "../db";
import { processDueInterviewReminders, reminderAtFor, reminderIdempotencyKey } from "./interviewReminders";

describe("interview reminder scheduling", () => {
  it("calculates the reminder from the stored UTC instant", () => {
    const scheduled = new Date("2026-09-01T10:00:00.000Z");
    expect(reminderAtFor(scheduled).toISOString()).toBe("2026-08-31T10:00:00.000Z");
    expect(reminderAtFor(scheduled, 2).toISOString()).toBe("2026-09-01T08:00:00.000Z");
  });

  it("creates a stable key for retries and reschedules", () => {
    const scheduled = new Date("2026-09-01T10:00:00.000Z");
    expect(reminderIdempotencyKey("int_1", scheduled)).toBe("interview-reminder:int_1:1788256800000");
    expect(reminderIdempotencyKey("int_1", null)).toBe("interview-reminder:int_1:none");
    expect(reminderIdempotencyKey("int_1", scheduled)).toBe(reminderIdempotencyKey("int_1", new Date(scheduled)));
  });

  it("queues due confirmed interviews without prematurely setting reminderSentAt", async () => {
    const db = await requireDb();
    const ownerId = 9101;
    const companyId = createId("cmp_ir_");
    const candidateId = createId("cnd_ir_");
    const jobId = createId("job_ir_");
    const interviewId = createId("int_ir_");

    await db.insert(companies).values({ id: companyId, ownerId, name: "IR Test Co" });
    await db.insert(candidates).values({ id: candidateId, ownerId, fullName: "IR Candidate", email: "ir.cand@test.local" });
    await db.insert(jobs).values({ id: jobId, ownerId, companyId, title: "IR Role", status: "published" });

    await db.insert(consents).values({ id: createId("cns_"), ownerId, candidateId, consentType: "interview_processing", status: "granted", noticeVersion: "test-v1" });
    await db.insert(emailIdentities).values({ id: createId("eid_"), ownerId, email: "interviews@overseasjob.in", purpose: "interviews", displayName: "Test", status: "active" });
    const scheduledAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const reminderAt = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago = due

    await db.insert(interviews).values({
      id: interviewId,
      ownerId,
      companyId,
      candidateId,
      jobId,
      status: "confirmed",
      calendarStatus: "confirmed",
      scheduledAt,
      reminderAt,
      reminderSentAt: null,
    });

    const result = await processDueInterviewReminders(ownerId);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.queued).toBeGreaterThanOrEqual(1);

    // Invariant: reminderSentAt MUST remain null after queueing
    const [fetched] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
    expect(fetched.reminderSentAt).toBeNull();
    expect(fetched.status).toBe("confirmed");

    const [plan] = await db.select().from(followUpPlans).where(eq(followUpPlans.resourceId, interviewId));
    expect(plan).toMatchObject({ scenarioId: "FU18", executionMode: "review" });
    const [queuedJob] = await db.select().from(automationQueue).where(eq(automationQueue.idempotencyKey, `followup:${plan.id}:1:0`));
    expect(queuedJob).toMatchObject({ jobType: "follow_up", status: "queued" });
    expect((queuedJob.payload as any).planId).toBe(plan.id);

    // Running again should not re-queue existing queued job
    const rerun = await processDueInterviewReminders(ownerId);
    expect(rerun.queued).toBe(0);
  });
});

