import { and, eq, isNull, lte } from "drizzle-orm";
import { automationQueue, interviews } from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";

export const reminderAtFor = (scheduledAt: Date, leadHours = 24) => new Date(scheduledAt.getTime() - leadHours * 60 * 60 * 1000);
export const reminderIdempotencyKey = (interviewId: string, scheduledAt: Date | null) => `interview-reminder:${interviewId}:${scheduledAt?.getTime() ?? "none"}`;

export async function processDueInterviewReminders(ownerId: number, limit = 10) {
  const db = await requireDb();
  const now = new Date();
  const due = await db.select().from(interviews).where(and(eq(interviews.ownerId, ownerId), lte(interviews.reminderAt, now), isNull(interviews.reminderSentAt), eq(interviews.calendarStatus, "confirmed"))).limit(Math.min(Math.max(limit, 1), 25));
  let queued = 0;
  for (const interview of due) {
    const claimed = await db.update(interviews).set({ reminderSentAt: now }).where(and(eq(interviews.id, interview.id), isNull(interviews.reminderSentAt), eq(interviews.calendarStatus, "confirmed")));
    if (!claimed[0]?.affectedRows) continue;
    try {
      await db.insert(automationQueue).values({ id: createId("que_"), ownerId, jobType: "send_reminder", status: "queued", payload: { interviewId: interview.id, scheduledAt: interview.scheduledAt?.toISOString() ?? null, timezone: interview.timezone, mode: "draft_only" }, priority: 30, scheduledAt: now, maxAttempts: 3, idempotencyKey: reminderIdempotencyKey(interview.id, interview.scheduledAt) });
      await recordAudit({ ownerId, actorType: "system", action: "interview.reminder_queued", resourceType: "interview", resourceId: interview.id, metadata: { mode: "draft_only", reminderAt: interview.reminderAt?.toISOString() ?? null } });
      queued += 1;
    } catch (error) {
      await db.update(interviews).set({ reminderSentAt: null }).where(eq(interviews.id, interview.id));
      if (!(error instanceof Error && /duplicate|unique/i.test(error.message))) throw error;
    }
  }
  return { scanned: due.length, queued };
}
