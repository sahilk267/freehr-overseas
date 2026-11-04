import { createHash } from "node:crypto";
const time = (value: unknown) => value ? new Date(value as string).toISOString() : null;
/** Server-only fingerprint of the saved scheduling state; never a provider authority grant. */
export function interviewEditFingerprint(row: any) {
  return createHash("sha256").update(JSON.stringify([row.id,row.status,row.calendarStatus,time(row.scheduledAt),row.durationMinutes??45,row.timezone??"UTC",row.meetingUrl??null,time(row.reminderAt),row.calendarSequence??0,row.rescheduleCount??0,time(row.completedAt)])).digest("hex");
}
