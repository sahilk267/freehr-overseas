import { and, eq } from "drizzle-orm";
import { candidates, conversations, emailIdentities, interviews, jobs, workspaceSettings } from "../../drizzle/schema";
import { createId, ensureWorkspace, requireDb } from "../db";
import { lockedSelect } from "./database";
import { enrollFollowUp } from "./followups";

export async function enrollInterviewFollowUp(ownerId: number, interviewId: string, expectedScheduledAt?: string | null) {
  const db = await requireDb();
  await ensureWorkspace(ownerId);
  const context = await db.transaction(async (tx: any) => {
    await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
    const interview = (await tx.select().from(interviews).where(and(eq(interviews.ownerId, ownerId), eq(interviews.id, interviewId))).limit(1))[0];
    if (!interview || interview.status !== "confirmed" || interview.calendarStatus !== "confirmed" || !interview.scheduledAt || interview.scheduledAt <= new Date() || (expectedScheduledAt && interview.scheduledAt.toISOString() !== expectedScheduledAt)) throw new Error("Interview reminder is stale or unconfirmed.");
    const candidate = (await tx.select().from(candidates).where(and(eq(candidates.id, interview.candidateId), eq(candidates.ownerId, ownerId))).limit(1))[0];
    const job = (await tx.select().from(jobs).where(and(eq(jobs.id, interview.jobId), eq(jobs.ownerId, ownerId))).limit(1))[0];
    const identity = (await tx.select().from(emailIdentities).where(and(eq(emailIdentities.ownerId, ownerId), eq(emailIdentities.purpose, "interviews"), eq(emailIdentities.status, "active"))).limit(1))[0];
    if (!candidate?.email || !job || !identity) throw new Error("Interview needs an eligible candidate and an active interview sender.");
    let conversation = (await tx.select().from(conversations).where(and(eq(conversations.ownerId, ownerId), eq(conversations.candidateId, candidate.id), eq(conversations.jobId, job.id))).limit(1))[0];
    if (!conversation) {
      const id = createId("cnv_");
      await tx.insert(conversations).values({ id, ownerId, candidateId: candidate.id, jobId: job.id, companyId: interview.companyId, channel: "email", status: "active" });
      conversation = { id };
    }
    return { interview, candidate, job, identity, conversation };
  });
  const { interview, candidate, job, identity, conversation } = context;
  const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: interview.timezone }).format(interview.scheduledAt);
  return enrollFollowUp(ownerId, {
    scenarioId: "FU18", conversationId: conversation.id, senderIdentityId: identity.id, resourceType: "interview", resourceId: interview.id,
    objective: "Remind the candidate about the confirmed interview", timezone: interview.timezone,
    startsAt: new Date(), deadlineAt: interview.scheduledAt, responseWindowMinutes: 60,
    steps: [{ delayMinutes: 0, subject: `Interview reminder: ${job.title}`, body: `Hello ${candidate.fullName},\n\nYour ${job.title} interview is confirmed for ${when} (${interview.timezone}).${interview.meetingUrl ? `\nMeeting: ${interview.meetingUrl}` : ""}\n\nReply if you need to change this arrangement. To stop recruitment messages, reply STOP.` }],
  });
}
