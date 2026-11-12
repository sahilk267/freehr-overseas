import { TRPCError } from "@trpc/server";
import { and, eq, desc } from "drizzle-orm";
import {
  candidates,
  companies,
  consents,
  feedback,
  interviews,
  jobs,
  workflowEvents,
} from "../../drizzle/schema";
import { candidateSuppressed } from "./candidateEvidence";
import { jobRequirementFingerprint } from "./jobIntake";
import { workflowHash } from "./workflowStore";
import { compareInterviewFeedback } from "../../shared/interviewFeedback";
export const feedbackEvent = async (
  tx: any,
  ownerId: number,
  type: string,
  id: string
) =>
  (
    await tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          eq(workflowEvents.eventType, type),
          eq(workflowEvents.aggregateId, id)
        )
      )
      .orderBy(desc(workflowEvents.revision))
      .limit(1)
  )[0];
export const feedbackScheduleHash = (i: any) =>
  workflowHash([
    i.id,
    i.candidateId,
    i.companyId,
    i.jobId,
    i.scheduledAt ? new Date(i.scheduledAt).toISOString() : null,
    i.durationMinutes,
    i.timezone,
    i.calendarSequence ?? 0,
  ]);
export async function interviewFeedbackContext(
  tx: any,
  ownerId: number,
  id: string
) {
  const interview = (
    await tx
      .select()
      .from(interviews)
      .where(and(eq(interviews.ownerId, ownerId), eq(interviews.id, id)))
      .limit(1)
  )[0];
  if (!interview)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Owned interview was not found.",
    });
  const job = (
      await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.ownerId, ownerId), eq(jobs.id, interview.jobId)))
        .limit(1)
    )[0],
    candidate = (
      await tx
        .select()
        .from(candidates)
        .where(
          and(
            eq(candidates.ownerId, ownerId),
            eq(candidates.id, interview.candidateId)
          )
        )
        .limit(1)
    )[0],
    company = (
      await tx
        .select()
        .from(companies)
        .where(
          and(
            eq(companies.ownerId, ownerId),
            eq(companies.id, interview.companyId)
          )
        )
        .limit(1)
    )[0];
  if (!job || job.companyId !== interview.companyId || !candidate || !company)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Interview source relationship was not found.",
    });
  const scheduleHash = feedbackScheduleHash(interview),
    requirementFingerprint = jobRequirementFingerprint(job),
    fingerprint = workflowHash([scheduleHash, requirementFingerprint]),
    panelRow = await feedbackEvent(tx, ownerId, "interview.feedback_panel", id),
    panel = panelRow?.metadata.redacted ? null : panelRow,
    current = Boolean(
      panel &&
        panel.metadata.fingerprint === fingerprint &&
        !panel.metadata.redacted
    );
  const rows = await tx
    .select()
    .from(feedback)
    .where(and(eq(feedback.ownerId, ownerId), eq(feedback.interviewId, id)))
    .orderBy(desc(feedback.submittedAt), desc(feedback.id));
  const events = await tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          eq(workflowEvents.eventType, "interview.feedback_superseded"),
          eq(workflowEvents.aggregateId, id)
        )
      ),
    superseded = new Set(events.map((e: any) => e.metadata.feedbackId));
  const active = current
    ? rows.filter(
        (f: any) =>
          f.scorecard?.schemaVersion === "interview-evidence-v1" &&
          f.scorecard.panelRevision === panel.revision &&
          f.scorecard.sourceFingerprint === fingerprint &&
          !superseded.has(f.id)
      )
    : [];
  const responses = active.map((f: any) => ({
      feedbackId: f.id,
      reviewerKey: f.scorecard.reviewerKey,
      ratings: f.scorecard.ratings,
    })),
    comparison = compareInterviewFeedback(
      current ? panel.metadata.criteria : [],
      responses,
      current ? panel.metadata.reviewers.map((r: any) => r.key) : []
    ),
    responseHash = workflowHash(
      active
        .map((f: any) => [f.id, f.scorecard.contentHash])
        .sort((a: any, b: any) => a[0].localeCompare(b[0]))
    ),
    resolution = await feedbackEvent(
      tx,
      ownerId,
      "interview.feedback_resolution",
      id
    );
  const grants = await tx
      .select()
      .from(consents)
      .where(
        and(
          eq(consents.ownerId, ownerId),
          eq(consents.candidateId, candidate.id),
          eq(consents.status, "granted")
        )
      ),
    processingPermitted = grants.some(
      (g: any) =>
        [
          "interview_processing",
          "platform_processing",
          "recruitment_communication",
        ].includes(g.consentType) &&
        (!g.jobId || g.jobId === job.id) &&
        (!g.companyId || g.companyId === company.id) &&
        (!g.expiresAt || new Date(g.expiresAt) > new Date())
    );
  const available =
    processingPermitted &&
    !candidateSuppressed(candidate) &&
    !["closed", "suppressed", "suspended", "not_fit"].includes(
      company.pipelineState
    ) &&
    !["cancelled", "archived"].includes(job.pipelineState) &&
    !["cancelled", "closed", "no_show"].includes(interview.status);
  return {
    interview,
    job,
    candidate,
    company,
    fingerprint,
    scheduleHash,
    requirementFingerprint,
    panel,
    current,
    rows,
    active,
    comparison,
    responseHash,
    resolution:
      resolution?.metadata.responseHash === responseHash &&
      resolution?.metadata.panelRevision === panel?.revision
        ? resolution
        : null,
    available,
  };
}
export async function interviewFeedbackFollowupState(
  tx: any,
  ownerId: number,
  recipientId: string,
  now = new Date()
) {
  const recipient = await feedbackEvent(
    tx,
    ownerId,
    "interview.feedback_recipient",
    recipientId
  );
  if (!recipient || recipient.metadata.redacted)
    return {
      state: "cancelled" as const,
      reason: "Feedback recipient is unavailable.",
    };
  const c = await interviewFeedbackContext(
      tx,
      ownerId,
      recipient.metadata.interviewId
    ),
    reviewer = c.panel?.metadata.reviewers.find(
      (r: any) => r.key === recipient.metadata.reviewerKey
    );
  if (
    !c.current ||
    !c.available ||
    c.panel.revision !== recipient.metadata.panelRevision ||
    !reviewer?.contactId
  )
    return {
      state: "cancelled" as const,
      reason: "Interview feedback source or panel changed.",
    };
  if (c.active.some((f: any) => f.scorecard.reviewerKey === reviewer.key))
    return {
      state: "completed" as const,
      reason: "The assigned reviewer feedback was recorded.",
    };
  if (
    !["completed", "feedback_pending", "feedback_received"].includes(
      c.interview.status
    )
  )
    return {
      state: "paused" as const,
      reason: "The interview has not been completed.",
    };
  if (new Date(c.panel.metadata.dueAt) <= now)
    return {
      state: "completed" as const,
      reason: "The feedback response window elapsed; owner review is required.",
    };
  return {
    state: "eligible" as const,
    fingerprint: workflowHash([
      c.fingerprint,
      c.panel.revision,
      reviewer.key,
      reviewer.contactId,
    ]),
    contactId: reviewer.contactId,
    jobId: c.job.id,
    companyId: c.company.id,
    deadlineAt: new Date(c.panel.metadata.dueAt),
  };
}
