import { and, asc, eq, gt, gte, isNull, lte, notExists, or } from "drizzle-orm";
import { interviews, workflowEvents, workspaceSettings } from "../../drizzle/schema";
import { ensureWorkspace, requireDb } from "../db";
import { lockedSelect } from "./database";
import { enrollInterviewFollowUp } from "./interviewFollowups";
import { appendWorkflowEvent } from "./workflowStore";

export const reminderAtFor = (scheduledAt: Date, leadHours = 24) => new Date(scheduledAt.getTime() - leadHours * 3600000);
export const reminderIdempotencyKey = (interviewId: string, scheduledAt: Date | null) => `interview-reminder:${interviewId}:${scheduledAt?.getTime() ?? "none"}`;

// This source enrolls FU18; the central follow-up/outbox worker owns sending.
export async function processDueInterviewReminders(ownerId?: number, limit = 10) {
  const db = await requireDb(), now = new Date();
  const conditions = [lte(interviews.reminderAt, now), gte(interviews.scheduledAt, now), isNull(interviews.reminderSentAt), eq(interviews.calendarStatus, "confirmed"), eq(interviews.status, "confirmed")];
  if (typeof ownerId === "number") conditions.push(eq(interviews.ownerId, ownerId));
  // A bounded scan must progress past already enrolled schedules and temporarily
  // blocked sources; otherwise the same first page starves every later interview.
  conditions.push(notExists(db.select({ id: workflowEvents.id }).from(workflowEvents).where(and(
    eq(workflowEvents.ownerId, interviews.ownerId), eq(workflowEvents.aggregateId, interviews.id), eq(workflowEvents.revision, interviews.calendarSequence),
    or(eq(workflowEvents.eventType, "interview.followup_enrolled"), and(eq(workflowEvents.eventType, "followup.source_blocked"), gt(workflowEvents.createdAt, new Date(now.getTime() - 15 * 60000))))
  ))));
  const due = await db.select().from(interviews).where(and(...conditions)).orderBy(asc(interviews.reminderAt), asc(interviews.id)).limit(Math.min(Math.max(limit, 1), 25));
  let queued = 0, blocked = 0;
  for (const interview of due) {
    try {
      const result = await enrollInterviewFollowUp(interview.ownerId, interview.id, interview.scheduledAt?.toISOString());
      if (!result.alreadyEnrolled) queued++;
    } catch {
      blocked++;
      await ensureWorkspace(interview.ownerId);
      await db.transaction(async (tx: any) => {
        await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, interview.ownerId)).limit(1));
        await appendWorkflowEvent(tx, interview.ownerId, "followup.source_blocked", interview.id, interview.calendarSequence ?? 0, { reason: "Interview follow-up needs current permission, confirmed schedule and an active interview sender." }, String(Math.floor(now.getTime() / (15 * 60000))));
      });
    }
  }
  return { scanned: due.length, queued, blocked };
}
