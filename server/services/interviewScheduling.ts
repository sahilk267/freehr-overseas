import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { candidates, companies, interviews, jobs } from "../../drizzle/schema";
import { createId, recordAudit } from "../db";
import { assertTransition } from "../workflow";
import { withWorkspaceTransaction, lockedSelect } from "./database";
import { createInterviewEventUid } from "./calendar";
import { stopRelatedFollowUps } from "./followups";

type Slot = { scheduledAt: Date; durationMinutes: number; timezone: string; meetingUrl?: string | null };
const reservedStates = ["proposed", "scheduled", "confirmed", "reminder_sent", "reschedule_requested"];
const instant = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000);
const missing = (label: string) => new TRPCError({ code: "NOT_FOUND", message: `${label} was not found in this workspace.` });
async function ownedInterview(tx: any, ownerId: number, id: string) {
  const row = (await lockedSelect(tx.select().from(interviews).where(and(eq(interviews.ownerId, ownerId), eq(interviews.id, id))).limit(1)))[0];
  if (!row) throw missing("Interview");
  return { ...row, calendarSequence: row.calendarSequence ?? 0, rescheduleCount: row.rescheduleCount ?? 0, meetingUrl: row.meetingUrl ?? null } as typeof interviews.$inferSelect;
}
async function candidate(tx: any, ownerId: number, id: string) {
  const row = (await lockedSelect(tx.select().from(candidates).where(and(eq(candidates.ownerId, ownerId), eq(candidates.id, id))).limit(1)))[0];
  if (!row) throw missing("Candidate");
  if (row.deletedAt || row.withdrawnAt || row.doNotContactAt || ["deleted", "deletion_pending", "withdrawn", "do_not_contact"].includes(row.profileState)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This candidate is withdrawn, erased or unavailable for scheduling." });
}
async function overlaps(tx: any, ownerId: number, candidateId: string, slot: Slot, excludeId?: string) {
  const start = instant(slot.scheduledAt).getTime(), end = start + slot.durationMinutes * 60000;
  const rows: Array<typeof interviews.$inferSelect> = await tx.select().from(interviews).where(and(eq(interviews.ownerId, ownerId), eq(interviews.candidateId, candidateId), inArray(interviews.status, reservedStates)));
  return rows.filter(row => row.id !== excludeId && row.calendarStatus !== "cancelled" && row.scheduledAt && new Date(row.scheduledAt).getTime() < end && new Date(row.scheduledAt).getTime() + Math.max(1, row.durationMinutes || 45) * 60000 > start);
}
const rejectConflict = () => { throw new TRPCError({ code: "CONFLICT", message: "This candidate already has an overlapping recorded interview. Check their schedule and choose another time." }); };
export async function previewInterviewSlot(ownerId: number, input: Slot & { candidateId: string; excludeInterviewId?: string }) {
  return withWorkspaceTransaction(ownerId, async tx => {
    await candidate(tx, ownerId, input.candidateId);
    if (input.excludeInterviewId && (await ownedInterview(tx, ownerId, input.excludeInterviewId)).candidateId !== input.candidateId) throw missing("Interview for this candidate");
    const rows = await overlaps(tx, ownerId, input.candidateId, input, input.excludeInterviewId);
    return { hasConflict: rows.length > 0, scope: "recorded_candidate_interviews" as const, conflicts: rows.map(row => ({ id: row.id, scheduledAt: row.scheduledAt!, durationMinutes: row.durationMinutes, timezone: row.timezone, status: row.status })) };
  });
}
export async function scheduleInterview(ownerId: number, actorId: number, input: Slot & { candidateId: string; companyId: string; jobId: string }) {
  const result = await withWorkspaceTransaction(ownerId, async tx => {
    await candidate(tx, ownerId, input.candidateId);
    const company = (await tx.select().from(companies).where(and(eq(companies.ownerId, ownerId), eq(companies.id, input.companyId))).limit(1))[0];
    const job = (await tx.select().from(jobs).where(and(eq(jobs.ownerId, ownerId), eq(jobs.id, input.jobId))).limit(1))[0];
    if (!company || !job) throw missing("Client or job");
    if (job.companyId !== company.id) throw new TRPCError({ code: "BAD_REQUEST", message: "The specified job does not belong to the specified client." });
    const scheduledAt = instant(input.scheduledAt), rows = await overlaps(tx, ownerId, input.candidateId, input);
    const exact = rows.find(row => row.companyId === input.companyId && row.jobId === input.jobId && row.scheduledAt!.getTime() === scheduledAt.getTime() && row.durationMinutes === input.durationMinutes && row.timezone === input.timezone && row.meetingUrl === (input.meetingUrl ?? null));
    if (exact && rows.length === 1) return { id: exact.id, alreadyExists: true };
    if (rows.length) rejectConflict();
    const id = createId("int_");
    await tx.insert(interviews).values({ ...input, scheduledAt, id, ownerId, status: "scheduled", meetingUrl: input.meetingUrl ?? null, calendarProvider: "ics", calendarEventId: createInterviewEventUid(id), calendarStatus: "tentative", calendarSequence: 0, reminderAt: new Date(scheduledAt.getTime() - 86400000) });
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "interview.scheduled", resourceType: "interview", resourceId: id, nextState: "scheduled" }, tx);
    return { id, alreadyExists: false };
  });
  return result;
}
export async function rescheduleInterview(ownerId: number, actorId: number, input: Slot & { id: string }) {
  const result = await withWorkspaceTransaction(ownerId, async tx => {
    const row = await ownedInterview(tx, ownerId, input.id);
    await candidate(tx, ownerId, row.candidateId);
    assertTransition("interview", row.status, "reschedule_requested");
    const scheduledAt = instant(input.scheduledAt), meetingUrl = input.meetingUrl === undefined ? row.meetingUrl : input.meetingUrl;
    if (row.scheduledAt?.getTime() === scheduledAt.getTime() && row.durationMinutes === input.durationMinutes && row.timezone === input.timezone && row.meetingUrl === meetingUrl) return { success: true, alreadyCurrent: true, calendarSequence: row.calendarSequence };
    if ((await overlaps(tx, ownerId, row.candidateId, input, row.id)).length) rejectConflict();
    await stopRelatedFollowUps(tx, ownerId, { resourceType: "interview", resourceId: row.id }, "Interview rescheduled; old reminders are invalid.");
    await tx.update(interviews).set({ status: "scheduled", scheduledAt, timezone: input.timezone, durationMinutes: input.durationMinutes, meetingUrl, calendarSequence: row.calendarSequence + 1, calendarStatus: "tentative", rescheduleCount: row.rescheduleCount + 1, reminderAt: new Date(scheduledAt.getTime() - 86400000), reminderSentAt: null }).where(eq(interviews.id, row.id));
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "interview.rescheduled", resourceType: "interview", resourceId: row.id, previousState: row.status, nextState: "scheduled", metadata: { calendarSequence: row.calendarSequence + 1 } }, tx);
    return { success: true, alreadyCurrent: false, calendarSequence: row.calendarSequence + 1 };
  });
  return result;
}
export async function changeInterviewState(ownerId: number, actorId: number, id: string, state: string) {
  const result = await withWorkspaceTransaction(ownerId, async tx => {
    const row = await ownedInterview(tx, ownerId, id);
    if (row.status === state) return { success: true, alreadyCurrent: true };
    assertTransition("interview", row.status, state);
    if (reservedStates.includes(state)) {
      await candidate(tx, ownerId, row.candidateId);
      if (row.scheduledAt && (await overlaps(tx, ownerId, row.candidateId, { scheduledAt: row.scheduledAt, durationMinutes: row.durationMinutes, timezone: row.timezone }, row.id)).length) rejectConflict();
    }
    const ended = ["cancelled", "completed", "no_show", "closed", "feedback_pending", "reschedule_requested"].includes(state);
    if (ended) await stopRelatedFollowUps(tx, ownerId, { resourceType: "interview", resourceId: id }, `Interview state changed to ${state}.`, state === "completed" ? "completed" : "cancelled");
    await tx.update(interviews).set({ status: state, completedAt: state === "completed" ? new Date() : row.completedAt, ...(ended ? { reminderAt: null } : {}), calendarStatus: state === "confirmed" ? "confirmed" : state === "cancelled" ? "cancelled" : row.calendarStatus, calendarSequence: row.calendarSequence + (state === "cancelled" ? 1 : 0) }).where(eq(interviews.id, id));
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: state === "cancelled" ? "interview.cancelled" : "interview.state_changed", resourceType: "interview", resourceId: id, previousState: row.status, nextState: state }, tx);
    return { success: true, alreadyCurrent: false };
  });
  return result;
}

export async function configureInterviewReminder(ownerId: number, actorId: number, id: string, reminderAt: Date | null) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const row = await ownedInterview(tx, ownerId, id);
    if (reminderAt && (row.calendarStatus === "cancelled" || ["completed", "feedback_pending", "closed", "no_show"].includes(row.status))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ended interviews cannot receive reminders." });
    const next = reminderAt ? instant(reminderAt) : null;
    if ((row.reminderAt?.getTime() ?? null) === (next?.getTime() ?? null)) return { success: true, alreadyCurrent: true };
    await stopRelatedFollowUps(tx, ownerId, { resourceType: "interview", resourceId: id }, "Interview reminder configuration changed.");
    await tx.update(interviews).set({ reminderAt: next, reminderSentAt: null, calendarSequence: row.calendarSequence + 1 }).where(eq(interviews.id, id));
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "interview.reminder_configured", resourceType: "interview", resourceId: id, metadata: { reminderAt: next?.toISOString() ?? null, calendarSequence: row.calendarSequence + 1 } }, tx);
    return { success: true, alreadyCurrent: false };
  });
}
