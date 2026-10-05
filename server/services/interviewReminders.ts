import { and, eq, isNull, lte, ne } from "drizzle-orm";
import { automationQueue, interviews } from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";

export const reminderAtFor = (scheduledAt: Date, leadHours = 24) =>
  new Date(scheduledAt.getTime() - leadHours * 60 * 60 * 1000);

export const reminderIdempotencyKey = (interviewId: string, scheduledAt: Date | null) =>
  `interview-reminder:${interviewId}:${scheduledAt?.getTime() ?? "none"}`;

export async function processDueInterviewReminders(ownerId?: number, limit = 10) {
  const db = await requireDb();
  const now = new Date();

  // Eligible: reminderAt <= now, reminderSentAt is NULL, confirmed status, not already reminder_sent
  const conditions = [
    lte(interviews.reminderAt, now),
    isNull(interviews.reminderSentAt),
    eq(interviews.calendarStatus, "confirmed"),
    ne(interviews.status, "reminder_sent"),
  ];
  if (typeof ownerId === "number") {
    conditions.unshift(eq(interviews.ownerId, ownerId));
  }

  const due = await db
    .select()
    .from(interviews)
    .where(and(...conditions))
    .limit(Math.min(Math.max(limit, 1), 25));

  let queued = 0;
  for (const interview of due) {
    const interviewOwnerId = interview.ownerId;
    const idempotencyKey = reminderIdempotencyKey(interview.id, interview.scheduledAt);

    // Check if an existing queue job with this idempotencyKey is already queued, processing, or completed
    const existingJob = (
      await db
        .select()
        .from(automationQueue)
        .where(eq(automationQueue.idempotencyKey, idempotencyKey))
        .limit(1)
    )[0];

    if (existingJob) {
      if (
        existingJob.status === "queued" ||
        existingJob.status === "processing" ||
        existingJob.status === "completed"
      ) {
        // Already queued or completed; skip without re-queuing
        continue;
      }
    }

    try {
      await db.insert(automationQueue).values({
        id: createId("que_"),
        ownerId: interviewOwnerId,
        jobType: "send_reminder",
        status: "queued",
        payload: {
          interviewId: interview.id,
          scheduledAt: interview.scheduledAt?.toISOString() ?? null,
          timezone: interview.timezone,
        },
        priority: 30,
        scheduledAt: now,
        maxAttempts: 3,
        idempotencyKey,
      });

      await recordAudit({
        ownerId: interviewOwnerId,
        actorType: "system",
        action: "interview.reminder_queued",
        resourceType: "interview",
        resourceId: interview.id,
        metadata: {
          reminderAt: interview.reminderAt?.toISOString() ?? null,
        },
      });

      queued += 1;
    } catch (error) {
      // If unique constraint error, another process already queued it
      if (error instanceof Error && /duplicate|unique/i.test(error.message)) {
        continue;
      }
      // If queue insertion fails, interview remains with reminderSentAt = null for later retry
      throw error;
    }
  }

  return { scanned: due.length, queued };
}
