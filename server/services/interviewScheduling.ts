import { interviewEditFingerprint } from "../../shared/interviewRevision";
import { enqueueCalendarSync } from "./calendarAutomation";
import { isValidTimezone } from "../../shared/dateTime";
import { appendWorkflowEvent, workflowHash } from "./workflowStore";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { candidates, companies, interviews, interviewSlotHolds as holds, jobs, workflowEvents } from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
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
    const held = await holdConflicts(tx, ownerId, input.candidateId, input);
    return { heldSlots: held.map(publicHold), hasConflict: rows.length > 0 || held.length > 0, scope: "recorded_candidate_interviews_and_holds" as const, conflicts: rows.map(row => ({ id: row.id, scheduledAt: row.scheduledAt!, durationMinutes: row.durationMinutes, timezone: row.timezone, status: row.status })) };
  });
}
type ScheduleInput = Slot & { candidateId: string; companyId: string; jobId: string; requestKey?: string };
export async function scheduleInterview(ownerId: number, actorId: number, input: ScheduleInput) {
  return withWorkspaceTransaction(ownerId, tx => scheduleInterviewInTransaction(tx, ownerId, actorId, input));
}
async function scheduleInterviewInTransaction(tx: any, ownerId: number, actorId: number, input: ScheduleInput, excludeHoldId?: string) {
    await candidate(tx, ownerId, input.candidateId);
    const company = (await tx.select().from(companies).where(and(eq(companies.ownerId, ownerId), eq(companies.id, input.companyId))).limit(1))[0];
    const job = (await tx.select().from(jobs).where(and(eq(jobs.ownerId, ownerId), eq(jobs.id, input.jobId))).limit(1))[0];
    if (!company || !job) throw missing("Client or job");
    if (job.companyId !== company.id) throw new TRPCError({ code: "BAD_REQUEST", message: "The specified job does not belong to the specified client." });
    const { requestKey: suppliedKey, ...definition } = input;
    const scheduledAt = instant(input.scheduledAt);
    const requestHash = workflowHash([input.candidateId, input.companyId, input.jobId, scheduledAt.toISOString(), input.timezone, input.durationMinutes, input.meetingUrl ?? null]);
    const requestKey = workflowHash(suppliedKey ?? requestHash), aggregateId = `interview-requests:${ownerId}`;
    const eventKey = workflowHash(["interview.create_requested", aggregateId, 1, requestKey]);
    const prior = (await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.eventKey, eventKey))).limit(1))[0];
    if (prior) {
      if (prior.metadata?.requestHash !== requestHash) throw new TRPCError({ code: "CONFLICT", message: "This scheduling request was already recorded with different content. Review the saved interview before starting a new request." });
      return { id: String(prior.metadata.interviewId), alreadyExists: true };
    }
    const remember = async (id: string) => appendWorkflowEvent(tx, ownerId, "interview.create_requested", aggregateId, 1, { requestHash, interviewId: id }, requestKey);
    await rejectHeldSlot(tx, ownerId, input.candidateId, input, excludeHoldId);
    const rows = await overlaps(tx, ownerId, input.candidateId, input);
    const exact = rows.find(row => row.companyId === input.companyId && row.jobId === input.jobId && row.scheduledAt!.getTime() === scheduledAt.getTime() && row.durationMinutes === input.durationMinutes && row.timezone === input.timezone && row.meetingUrl === (input.meetingUrl ?? null));
    if (exact && rows.length === 1) { await remember(exact.id); return { id: exact.id, alreadyExists: true }; }
    if (rows.length) rejectConflict();
    const id = createId("int_");
    await tx.insert(interviews).values({ ...definition, scheduledAt, id, ownerId, status: "scheduled", meetingUrl: input.meetingUrl ?? null, calendarProvider: "ics", calendarEventId: createInterviewEventUid(id), calendarStatus: "tentative", calendarSequence: 0, reminderAt: new Date(scheduledAt.getTime() - 86400000) });
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "interview.scheduled", resourceType: "interview", resourceId: id, nextState: "scheduled" }, tx);
    await enqueueCalendarSync(tx, ownerId, id);
    await remember(id);
    return { id, alreadyExists: false };
}
function checkEditFingerprint(row: any, expected?: string) {
  if (expected && interviewEditFingerprint(row) !== expected) throw new TRPCError({code:"CONFLICT",message:"This interview changed since you opened it. Reload and review the current schedule before editing."});
}
export async function rescheduleInterview(ownerId: number, actorId: number, input: Slot & { id: string; expectedFingerprint?: string }) {
  const result = await withWorkspaceTransaction(ownerId, async tx => {
    const row = await ownedInterview(tx, ownerId, input.id);
    checkEditFingerprint(row, input.expectedFingerprint);
    await candidate(tx, ownerId, row.candidateId);
    assertTransition("interview", row.status, "reschedule_requested");
    const scheduledAt = instant(input.scheduledAt), meetingUrl = input.meetingUrl === undefined ? row.meetingUrl : input.meetingUrl;
    if (row.scheduledAt?.getTime() === scheduledAt.getTime() && row.durationMinutes === input.durationMinutes && row.timezone === input.timezone && row.meetingUrl === meetingUrl) return { success: true, alreadyCurrent: true, calendarSequence: row.calendarSequence };
    await rejectHeldSlot(tx, ownerId, row.candidateId, input);
    if ((await overlaps(tx, ownerId, row.candidateId, input, row.id)).length) rejectConflict();
    await stopRelatedFollowUps(tx, ownerId, { resourceType: "interview", resourceId: row.id }, "Interview rescheduled; old reminders are invalid.");
    await tx.update(interviews).set({ status: "scheduled", scheduledAt, timezone: input.timezone, durationMinutes: input.durationMinutes, meetingUrl, calendarSequence: row.calendarSequence + 1, calendarStatus: "tentative", rescheduleCount: row.rescheduleCount + 1, reminderAt: new Date(scheduledAt.getTime() - 86400000), reminderSentAt: null }).where(eq(interviews.id, row.id));
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "interview.rescheduled", resourceType: "interview", resourceId: row.id, previousState: row.status, nextState: "scheduled", metadata: { calendarSequence: row.calendarSequence + 1 } }, tx);
    await enqueueCalendarSync(tx, ownerId, row.id);
    return { success: true, alreadyCurrent: false, calendarSequence: row.calendarSequence + 1 };
  });
  return result;
}
export async function changeInterviewState(ownerId: number, actorId: number, id: string, state: string, expectedFingerprint?: string) {
  const result = await withWorkspaceTransaction(ownerId, async tx => {
    const row = await ownedInterview(tx, ownerId, id);
    checkEditFingerprint(row, expectedFingerprint);
    if (row.status === state) return { success: true, alreadyCurrent: true };
    assertTransition("interview", row.status, state);
    if (reservedStates.includes(state)) {
      await candidate(tx, ownerId, row.candidateId);
      if (row.scheduledAt) await rejectHeldSlot(tx, ownerId, row.candidateId, { scheduledAt: row.scheduledAt, durationMinutes: row.durationMinutes, timezone: row.timezone });
      if (row.scheduledAt && (await overlaps(tx, ownerId, row.candidateId, { scheduledAt: row.scheduledAt, durationMinutes: row.durationMinutes, timezone: row.timezone }, row.id)).length) rejectConflict();
    }
    const ended = ["cancelled", "completed", "no_show", "closed", "feedback_pending", "reschedule_requested"].includes(state);
    if (ended) await stopRelatedFollowUps(tx, ownerId, { resourceType: "interview", resourceId: id }, `Interview state changed to ${state}.`, state === "completed" ? "completed" : "cancelled");
    await tx.update(interviews).set({ status: state, completedAt: state === "completed" ? new Date() : row.completedAt, ...(ended ? { reminderAt: null } : {}), calendarStatus: state === "confirmed" ? "confirmed" : state === "cancelled" ? "cancelled" : row.calendarStatus, calendarSequence: row.calendarSequence + (state === "cancelled" ? 1 : 0) }).where(eq(interviews.id, id));
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: state === "cancelled" ? "interview.cancelled" : "interview.state_changed", resourceType: "interview", resourceId: id, previousState: row.status, nextState: state }, tx);
    await enqueueCalendarSync(tx, ownerId, row.id);
    return { success: true, alreadyCurrent: false };
  });
  return result;
}

export async function configureInterviewReminder(ownerId: number, actorId: number, id: string, reminderAt: Date | null, expectedFingerprint?: string) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const row = await ownedInterview(tx, ownerId, id);
    checkEditFingerprint(row, expectedFingerprint);
    if (reminderAt && (row.calendarStatus === "cancelled" || ["completed", "feedback_pending", "closed", "no_show"].includes(row.status))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ended interviews cannot receive reminders." });
    const next = reminderAt ? instant(reminderAt) : null;
    if ((row.reminderAt?.getTime() ?? null) === (next?.getTime() ?? null)) return { success: true, alreadyCurrent: true };
    await stopRelatedFollowUps(tx, ownerId, { resourceType: "interview", resourceId: id }, "Interview reminder configuration changed.");
    await tx.update(interviews).set({ reminderAt: next, reminderSentAt: null, calendarSequence: row.calendarSequence + 1 }).where(eq(interviews.id, id));
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "interview.reminder_configured", resourceType: "interview", resourceId: id, metadata: { reminderAt: next?.toISOString() ?? null, calendarSequence: row.calendarSequence + 1 } }, tx);
    await enqueueCalendarSync(tx, ownerId, row.id);
    return { success: true, alreadyCurrent: false };
  });
}


function publicHold(row: typeof holds.$inferSelect) {
  return { id: row.id, candidateId: row.candidateId, scheduledAt: row.scheduledAt, timezone: row.timezone, durationMinutes: row.durationMinutes, expiresAt: row.expiresAt,
    status: row.status === "active" && new Date(row.expiresAt).getTime() <= Date.now() ? "expired" : row.status, interviewId: row.interviewId ?? null };
}
async function holdConflicts(tx: any, ownerId: number, candidateId: string, slot: Slot, excludeId?: string) {
  const start = instant(slot.scheduledAt).getTime(), end = start + slot.durationMinutes * 60000;
  const rows: Array<typeof holds.$inferSelect> = await tx.select().from(holds).where(and(eq(holds.ownerId, ownerId), eq(holds.candidateId, candidateId), eq(holds.status, "active"), gt(holds.expiresAt, new Date())));
  return rows.filter(row => row.id !== excludeId && new Date(row.expiresAt).getTime() > Date.now() && new Date(row.scheduledAt).getTime() < end && new Date(row.scheduledAt).getTime() + row.durationMinutes * 60000 > start);
}
async function rejectHeldSlot(tx: any, ownerId: number, candidateId: string, slot: Slot, excludeId?: string) {
  if ((await holdConflicts(tx, ownerId, candidateId, slot, excludeId)).length) throw new TRPCError({ code: "CONFLICT", message: "This candidate has an overlapping active internal slot hold. Book through that hold, release it or wait for expiry." });
}
async function ownedHold(tx: any, ownerId: number, id: string) {
  const row = (await lockedSelect(tx.select().from(holds).where(and(eq(holds.ownerId, ownerId), eq(holds.id, id))).limit(1)))[0];
  if (!row) throw missing("Slot hold");
  return { ...row } as typeof holds.$inferSelect;
}
export async function listInterviewHolds(ownerId: number) {
  return (await (await requireDb()).select().from(holds).where(eq(holds.ownerId, ownerId)).orderBy(desc(holds.createdAt), desc(holds.id)).limit(100)).map(publicHold);
}
export async function holdInterviewSlot(ownerId: number, actorId: number, input: Slot & { candidateId: string; requestKey: string; ttlMinutes: number }) {
  // Request identity never resurrects an expired/released/consumed hold.
  const id = "hld_" + workflowHash([ownerId, input.requestKey]).slice(0,32);
  const requestHash = workflowHash([input.candidateId, instant(input.scheduledAt).toISOString(), input.durationMinutes, input.timezone, input.ttlMinutes]);
  return withWorkspaceTransaction(ownerId, async tx => {
    const prior = (await tx.select().from(holds).where(and(eq(holds.ownerId, ownerId), eq(holds.id, id))).limit(1))[0];
    if (prior) {
      if (prior.requestHash !== requestHash) throw new TRPCError({ code: "CONFLICT", message: "Hold request content changed. Start a new hold request after reviewing the slot." });
      return { ...publicHold(prior), alreadyExists: true };
    }
    await candidate(tx, ownerId, input.candidateId);
    const now = Date.now(), scheduledAt = instant(input.scheduledAt);
    if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 15 || input.durationMinutes > 240 || !Number.isInteger(input.ttlMinutes) || input.ttlMinutes < 1 || input.ttlMinutes > 30 || !isValidTimezone(input.timezone) || !Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= now || scheduledAt.getTime() > now + 90*86400000) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a future slot within 90 days, a valid timezone, 15–240 minute duration and a 1–30 minute hold." });
    await rejectHeldSlot(tx, ownerId, input.candidateId, input);
    if ((await overlaps(tx, ownerId, input.candidateId, input)).length) rejectConflict();
    const row = { id, ownerId, candidateId: input.candidateId, requestHash, scheduledAt, timezone: input.timezone, durationMinutes: input.durationMinutes, expiresAt: new Date(Math.min(now + input.ttlMinutes*60000, scheduledAt.getTime())), status: "active", interviewId: null, bookingHash: null };
    await tx.insert(holds).values(row);
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "interview.slot_held", resourceType: "interview_hold", resourceId: id, metadata: { expiresAt: row.expiresAt.toISOString(), scope: "internal_candidate_only" } }, tx);
    return { ...publicHold(row as typeof holds.$inferSelect), alreadyExists: false };
  });
}
export async function releaseInterviewHold(ownerId: number, actorId: number, id: string) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const row = await ownedHold(tx, ownerId, id);
    if (row.status === "consumed") throw new TRPCError({ code: "CONFLICT", message: "This hold was booked. Manage the saved interview instead." });
    if (row.status === "released" || new Date(row.expiresAt).getTime() <= Date.now()) return publicHold(row);
    await tx.update(holds).set({ status: "released" }).where(eq(holds.id, id));
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "interview.slot_released", resourceType: "interview_hold", resourceId: id }, tx);
    return publicHold({ ...row, status: "released" });
  });
}
export async function bookInterviewHold(ownerId: number, actorId: number, input: { id: string; companyId: string; jobId: string; meetingUrl?: string }) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const hold = await ownedHold(tx, ownerId, input.id), bookingHash = workflowHash([input.companyId, input.jobId, input.meetingUrl ?? null]);
    if (hold.status === "consumed") {
      if (hold.bookingHash !== bookingHash || !hold.interviewId) throw new TRPCError({ code: "CONFLICT", message: "This hold was already booked with different details. Review the saved interview." });
      return { id: hold.interviewId, alreadyExists: true };
    }
    if (hold.status !== "active" || new Date(hold.expiresAt).getTime() <= Date.now() || new Date(hold.scheduledAt).getTime() <= Date.now()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This hold has expired or was released. Review availability and create a new hold." });
    const result = await scheduleInterviewInTransaction(tx, ownerId, actorId, { candidateId: hold.candidateId, companyId: input.companyId, jobId: input.jobId, scheduledAt: new Date(hold.scheduledAt), durationMinutes: hold.durationMinutes, timezone: hold.timezone, meetingUrl: input.meetingUrl, requestKey: `hold:${hold.id}` }, hold.id);
    if (new Date(hold.expiresAt).getTime() <= Date.now()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Hold expired during booking. Review the slot again." });
    await tx.update(holds).set({ status: "consumed", interviewId: result.id, bookingHash }).where(eq(holds.id, hold.id));
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "interview.slot_booked", resourceType: "interview_hold", resourceId: hold.id, metadata: { interviewId: result.id } }, tx);
    return result;
  });
}
