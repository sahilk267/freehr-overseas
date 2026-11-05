import {createHash} from 'node:crypto';
import type {interviews} from '../../drizzle/schema';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Reminder edits do not change the appointment. The monotonic counter prevents away/back revival. */
export function confirmationScheduleFingerprint(row:typeof interviews.$inferSelect){return digest([row.id,row.candidateId,row.companyId,row.jobId,row.scheduledAt?.toISOString(),row.durationMinutes,row.timezone,row.meetingUrl??null,row.rescheduleCount]);}
