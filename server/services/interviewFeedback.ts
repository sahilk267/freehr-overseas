import { jobIntakeFieldsSchema } from "../../shared/jobIntake";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import {
  contacts,
  conversations,
  emailIdentities,
  feedback,
  interviews,
  workflowEvents,
  workspaceSettings,
} from "../../drizzle/schema";
import {
  feedbackPanelInput,
  structuredFeedbackInput,
  resolveFeedbackInput,
} from "../../shared/interviewFeedback";
import { calculateWeightedScorecard } from "../../shared/weightedScorecard";
import { createId, recordAudit } from "../db";
import { ensureSafeAiText } from "../workflow";
import { withWorkspaceTransaction } from "./database";
import { appendWorkflowEvent, workflowHash } from "./workflowStore";
import {
  interviewFeedbackContext,
  feedbackEvent,
} from "./interviewFeedbackState";
import { enrollFollowUpInTransaction, stopRelatedFollowUps } from "./followups";
import { invalidateCandidateMatches } from "./candidateEvidenceLifecycle";
import { hasClientCommunicationPermission } from "./communicationPermission";
const fail = (message: string) =>
  new TRPCError({ code: "PRECONDITION_FAILED", message });
const recipientIdentity = (interviewId: string, key: string) =>
  workflowHash([interviewId, key]).slice(0, 36);
async function markActivity(tx: any, ownerId: number, c: any, action: string) {
  const id = workflowHash([c.interview.candidateId, c.interview.jobId]),
    old = await feedbackEvent(tx, ownerId, "interview.feedback_activity", id);
  await appendWorkflowEvent(
    tx,
    ownerId,
    "interview.feedback_activity",
    id,
    (old?.revision ?? 0) + 1,
    {
      candidateId: c.interview.candidateId,
      jobId: c.job.id,
      interviewId: c.interview.id,
      action,
    }
  );
  await invalidateCandidateMatches(
    tx,
    ownerId,
    c.interview.candidateId,
    "Interview feedback evidence changed; review the current panel observations.",
    c.job.id
  );
}
export async function configureInterviewFeedback(
  ownerId: number,
  actorId: number,
  raw: unknown
) {
  const input = feedbackPanelInput.parse(raw),
    requestHash = workflowHash(input);
  return withWorkspaceTransaction(ownerId, async tx => {
    const c = await interviewFeedbackContext(tx, ownerId, input.interviewId);
    if (
      c.panel?.revision === input.expectedRevision + 1 &&
      c.panel.metadata.requestHash === requestHash
    )
      return { revision: c.panel.revision, alreadySaved: true };
    if (
      c.fingerprint !== input.expectedFingerprint ||
      (c.panel?.revision ?? 0) !== input.expectedRevision
    )
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Interview source or feedback panel changed. Reload before saving.",
      });
    if (
      !c.available ||
      !c.interview.scheduledAt ||
      input.dueAt <= new Date() ||
      input.dueAt.getTime() > Date.now() + 30 * 86400000 ||
      input.dueAt <= new Date(c.interview.scheduledAt)
    )
      throw fail(
        "Use an available interview and a future feedback deadline within thirty days, after its scheduled time."
      );
    const criteria = jobIntakeFieldsSchema.shape.scorecard.parse(
      Array.isArray(c.job.scorecard) ? c.job.scorecard : []
    );
    try {
      calculateWeightedScorecard(criteria, []);
    } catch {
      throw fail(
        "Record a valid employer rubric totaling one hundred before configuring a feedback panel."
      );
    }
    for (const criterion of criteria) ensureSafeAiText(criterion.criterion);
    if (
      new Set(input.reviewers.map(r => r.key)).size !==
        input.reviewers.length ||
      new Set(input.reviewers.filter(r => r.contactId).map(r => r.contactId))
        .size !== input.reviewers.filter(r => r.contactId).length
    )
      throw fail(
        "Reviewer keys and assigned contact identities must be unique."
      );
    for (const r of input.reviewers) {
      ensureSafeAiText(r.name);
      if (
        r.contactId &&
        !(
          await tx
            .select()
            .from(contacts)
            .where(
              and(
                eq(contacts.ownerId, ownerId),
                eq(contacts.companyId, c.company.id),
                eq(contacts.id, r.contactId)
              )
            )
            .limit(1)
        )[0]
      )
        throw fail(
          "Each assigned reviewer contact must belong to the exact owned client."
        );
    }
    for (const r of c.panel?.metadata.reviewers ?? [])
      await stopRelatedFollowUps(
        tx,
        ownerId,
        {
          resourceType: "interview_feedback",
          resourceId: recipientIdentity(c.interview.id, r.key),
        },
        "Feedback panel was replaced.",
        "cancelled"
      );
    const revision = (c.panel?.revision ?? 0) + 1;
    await appendWorkflowEvent(
      tx,
      ownerId,
      "interview.feedback_panel",
      c.interview.id,
      revision,
      {
        candidateId: c.candidate.id,
        fingerprint: c.fingerprint,
        criteria,
        reviewers: input.reviewers,
        dueAt: input.dueAt.toISOString(),
        requestHash,
        reason: input.reason,
        actorId,
        identityVerified: false,
      }
    );
    await markActivity(tx, ownerId, c, "panel_changed");
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "interview.feedback_panel_saved",
        resourceType: "interview",
        resourceId: c.interview.id,
        metadata: { revision, reviewers: input.reviewers.length },
      },
      tx
    );
    return { revision, alreadySaved: false };
  });
}
export async function recordStructuredInterviewFeedback(
  ownerId: number,
  actorId: number,
  raw: unknown
) {
  const input = structuredFeedbackInput.parse(raw),
    requestHash = workflowHash(input);
  return withWorkspaceTransaction(ownerId, async tx => {
    const c = await interviewFeedbackContext(tx, ownerId, input.interviewId),
      identity = workflowHash([ownerId, input.requestKey]),
      prior = await feedbackEvent(
        tx,
        ownerId,
        "interview.feedback_identity",
        identity
      );
    if (prior) {
      if (prior.metadata.requestHash !== requestHash)
        throw new TRPCError({
          code: "CONFLICT",
          message: "Feedback request identity belongs to another observation.",
        });
      return { id: prior.metadata.feedbackId as string, alreadySaved: true };
    }
    if (
      !c.available ||
      !c.current ||
      c.fingerprint !== input.expectedFingerprint ||
      c.panel.revision !== input.panelRevision
    )
      throw fail("A current exact feedback panel is required.");
    if (
      !["completed", "feedback_pending", "feedback_received"].includes(
        c.interview.status
      ) ||
      !c.interview.completedAt ||
      c.interview.completedAt > new Date() ||
      !c.interview.scheduledAt ||
      c.interview.scheduledAt > new Date()
    )
      throw fail(
        "Feedback requires a completed past interview with its recorded completion time."
      );
    const reviewer = c.panel.metadata.reviewers.find(
      (r: any) => r.key === input.reviewerKey
    );
    if (!reviewer) throw fail("Choose a reviewer in the current exact panel.");
    const previous = c.active.find(
      (f: any) => f.scorecard.reviewerKey === reviewer.key
    );
    if (
      (previous?.id !== input.supersedesId && previous) ||
      (input.supersedesId && !previous)
    )
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "An existing reviewer response needs an explicit exact correction reference.",
      });
    ensureSafeAiText(input.rawFeedback);
    ensureSafeAiText(input.limitations);
    for (const r of input.ratings) {
      if (
        r.score !== null &&
        (!r.quote || !input.rawFeedback.includes(r.quote))
      )
        throw fail(
          "Every numeric rating needs an exact supporting quote in the recorded feedback."
        );
      if (r.quote) ensureSafeAiText(r.quote);
    }
    const calculated = calculateWeightedScorecard(
        c.panel.metadata.criteria,
        input.ratings
      ),
      id = createId("fbk_");
    await tx
      .insert(feedback)
      .values({
        id,
        ownerId,
        interviewId: c.interview.id,
        authorName: reviewer.name,
        rawFeedback: input.rawFeedback,
        scorecard: {
          schemaVersion: "interview-evidence-v1",
          panelRevision: c.panel.revision,
          sourceFingerprint: c.fingerprint,
          reviewerKey: reviewer.key,
          ratings: input.ratings,
          calculated,
          limitations: input.limitations,
          contentHash: requestHash,
          reason: input.reason,
          identityVerified: false,
          ownerRecorded: true,
        },
        finalDecision: null,
      });
    await appendWorkflowEvent(
      tx,
      ownerId,
      "interview.feedback_identity",
      identity,
      1,
      {
        candidateId: c.candidate.id,
        requestHash,
        feedbackId: id,
        interviewId: c.interview.id,
      }
    );
    if (previous)
      await appendWorkflowEvent(
        tx,
        ownerId,
        "interview.feedback_superseded",
        c.interview.id,
        c.panel.revision,
        {
          candidateId: c.candidate.id,
          feedbackId: previous.id,
          replacementId: id,
        },
        previous.id
      );
    await stopRelatedFollowUps(
      tx,
      ownerId,
      {
        resourceType: "interview_feedback",
        resourceId: recipientIdentity(c.interview.id, reviewer.key),
      },
      "Assigned reviewer feedback was recorded.",
      "completed"
    );
    const count = c.active.filter((f: any) => f.id !== previous?.id).length + 1;
    await tx
      .update(interviews)
      .set({
        status:
          count === c.panel.metadata.reviewers.length
            ? "feedback_received"
            : "feedback_pending",
      })
      .where(
        and(eq(interviews.ownerId, ownerId), eq(interviews.id, c.interview.id))
      );
    await markActivity(tx, ownerId, c, "response_recorded");
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "interview.structured_feedback_recorded",
        resourceType: "interview",
        resourceId: c.interview.id,
        metadata: {
          feedbackId: id,
          panelRevision: c.panel.revision,
          corrects: previous?.id ?? null,
          identityVerified: false,
        },
      },
      tx
    );
    return { id, alreadySaved: false };
  });
}
export async function resolveInterviewFeedback(
  ownerId: number,
  actorId: number,
  raw: unknown
) {
  const input = resolveFeedbackInput.parse(raw);
  return withWorkspaceTransaction(ownerId, async tx => {
    const c = await interviewFeedbackContext(tx, ownerId, input.interviewId);
    if (
      !c.current ||
      !c.available ||
      c.fingerprint !== input.expectedFingerprint ||
      c.panel.revision !== input.panelRevision ||
      c.responseHash !== input.expectedResponseHash ||
      !c.active.length
    )
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Current panel observations changed or are unavailable. Reload before recording a next action.",
      });
    if (
      input.nextAction === "consider_next_round" &&
      c.comparison.missingReviewers.length
    )
      throw fail(
        "Record the missing panel observations before considering the next round."
      );
    ensureSafeAiText(input.evidence);
    const previous = await feedbackEvent(
        tx,
        ownerId,
        "interview.feedback_resolution",
        c.interview.id
      ),
      requestHash = workflowHash(input);
    if (previous?.metadata.requestHash === requestHash)
      return { revision: previous.revision, alreadySaved: true };
    await appendWorkflowEvent(
      tx,
      ownerId,
      "interview.feedback_resolution",
      c.interview.id,
      (previous?.revision ?? 0) + 1,
      {
        candidateId: c.candidate.id,
        panelRevision: c.panel.revision,
        responseHash: c.responseHash,
        nextAction: input.nextAction,
        evidence: input.evidence,
        requestHash,
        actorId,
        clientIdentityVerified: false,
        finalDisposition: false,
      }
    );
    await markActivity(tx, ownerId, c, "next_action_reviewed");
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "interview.feedback_next_action_reviewed",
        resourceType: "interview",
        resourceId: c.interview.id,
        metadata: { nextAction: input.nextAction, finalDisposition: false },
      },
      tx
    );
    return { revision: (previous?.revision ?? 0) + 1, alreadySaved: false };
  });
}
export async function interviewFeedbackDetail(
  ownerId: number,
  interviewId: string
) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const c = await interviewFeedbackContext(tx, ownerId, interviewId),
      people = await tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.ownerId, ownerId),
            eq(contacts.companyId, c.company.id)
          )
        ),
      threads = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.ownerId, ownerId),
            eq(conversations.companyId, c.company.id),
            eq(conversations.jobId, c.job.id)
          )
        ),
      senders = await tx
        .select()
        .from(emailIdentities)
        .where(
          and(
            eq(emailIdentities.ownerId, ownerId),
            eq(emailIdentities.purpose, "interviews"),
            eq(emailIdentities.status, "active")
          )
        );
    return {
      interviewId,
      interviewStatus: c.interview.status,
      candidateId: c.candidate.id,
      fingerprint: c.fingerprint,
      panel: c.panel
        ? { revision: c.panel.revision, ...c.panel.metadata }
        : null,
      current: c.current,
      criteria: Array.isArray(c.job.scorecard) ? c.job.scorecard : [],
      responses: c.active,
      history: c.rows,
      comparison: c.comparison,
      responseHash: c.responseHash,
      resolution: c.resolution?.metadata ?? null,
      available: c.available,
      contacts: people.map((p: any) => ({ id: p.id, name: p.name })),
      conversations: threads
        .filter((t: any) => t.contactId && !t.candidateId)
        .map((t: any) => ({ id: t.id, contactId: t.contactId })),
      senders: senders.map((s: any) => ({ id: s.id, email: s.email })),
      identityVerified: false,
    };
  });
}
export async function enrollInterviewFeedbackReminder(
  ownerId: number,
  actorId: number,
  input: {
    interviewId: string;
    reviewerKey: string;
    conversationId: string;
    senderIdentityId: string;
  }
) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const c = await interviewFeedbackContext(tx, ownerId, input.interviewId),
      reviewer = c.panel?.metadata.reviewers.find(
        (r: any) => r.key === input.reviewerKey
      );
    if (
      !c.current ||
      !c.available ||
      !reviewer?.contactId ||
      c.active.some((f: any) => f.scorecard.reviewerKey === reviewer.key) ||
      !["completed", "feedback_pending", "feedback_received"].includes(
        c.interview.status
      ) ||
      !(await hasClientCommunicationPermission(tx, ownerId, reviewer.contactId))
    )
      throw fail(
        "A completed current interview, pending assigned reviewer and current client contact permission are required."
      );
    const recipientId = recipientIdentity(c.interview.id, reviewer.key),
      previous = await feedbackEvent(
        tx,
        ownerId,
        "interview.feedback_recipient",
        recipientId
      );
    if (!previous || previous.metadata.panelRevision !== c.panel.revision)
      await appendWorkflowEvent(
        tx,
        ownerId,
        "interview.feedback_recipient",
        recipientId,
        (previous?.revision ?? 0) + 1,
        {
          candidateId: c.candidate.id,
          interviewId: c.interview.id,
          reviewerKey: reviewer.key,
          panelRevision: c.panel.revision,
        }
      );
    const settings = (
      await tx
        .select()
        .from(workspaceSettings)
        .where(eq(workspaceSettings.ownerId, ownerId))
        .limit(1)
    )[0];
    return enrollFollowUpInTransaction(
      tx,
      ownerId,
      {
        scenarioId: "FU20",
        conversationId: input.conversationId,
        senderIdentityId: input.senderIdentityId,
        resourceType: "interview_feedback",
        resourceId: recipientId,
        timezone: settings.businessTimezone,
        deadlineAt: new Date(c.panel.metadata.dueAt),
        objective: "Receive the assigned interviewer’s job-related evidence",
        responseWindowMinutes: 60,
        steps: [
          {
            delayMinutes: 0,
            subject: "Interview feedback reminder",
            body: "Please reply with job-related observations and any missing evidence for the interview discussed in this thread. Do not include protected personal information. No hiring decision is implied. Reply STOP to opt out.",
          },
          {
            delayMinutes: 120,
            subject: "Follow-up on interview observations",
            body: "Following up on the requested interview observations before the stated review deadline. Please reply with evidence or ask your recruiter for clarification. Reply STOP to opt out.",
          },
        ],
      },
      actorId
    );
  });
}
export async function ensureInterviewFeedbackConversation(
  ownerId: number,
  actorId: number,
  input: { interviewId: string; reviewerKey: string }
) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const c = await interviewFeedbackContext(tx, ownerId, input.interviewId),
      reviewer = c.panel?.metadata.reviewers.find(
        (r: any) => r.key === input.reviewerKey
      );
    if (
      !c.current ||
      !c.available ||
      !reviewer?.contactId ||
      !(await hasClientCommunicationPermission(tx, ownerId, reviewer.contactId))
    )
      throw fail(
        "A current panel and permitted client reviewer contact are required."
      );
    const rows = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.ownerId, ownerId),
          eq(conversations.companyId, c.company.id),
          eq(conversations.jobId, c.job.id),
          eq(conversations.contactId, reviewer.contactId)
        )
      );
    const prior = rows.find(
      (r: any) =>
        !r.candidateId &&
        r.channel === "email" &&
        ["active", "drafting", "waiting"].includes(r.status)
    );
    if (prior) return { id: prior.id as string, alreadyExists: true };
    const id = createId("cnv_");
    await tx
      .insert(conversations)
      .values({
        id,
        ownerId,
        companyId: c.company.id,
        jobId: c.job.id,
        contactId: reviewer.contactId,
        candidateId: null,
        channel: "email",
        status: "active",
      });
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "interview.feedback_thread_prepared",
        resourceType: "conversation",
        resourceId: id,
        metadata: {
          interviewId: c.interview.id,
          reviewerKey: reviewer.key,
          sent: false,
        },
      },
      tx
    );
    return { id, alreadyExists: false };
  });
}
export async function eraseInterviewFeedbackContent(
  ownerId: number,
  candidateId: string
) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const cases = await tx
        .select()
        .from(interviews)
        .where(
          and(
            eq(interviews.ownerId, ownerId),
            eq(interviews.candidateId, candidateId)
          )
        ),
      events = await tx
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.ownerId, ownerId));
    for (const panel of events.filter(
      (e: any) =>
        e.eventType === "interview.feedback_panel" &&
        e.metadata?.candidateId === candidateId
    ))
      for (const reviewer of panel.metadata.reviewers ?? [])
        await stopRelatedFollowUps(
          tx,
          ownerId,
          {
            resourceType: "interview_feedback",
            resourceId: recipientIdentity(panel.aggregateId, reviewer.key),
          },
          "Candidate privacy erasure.",
          "cancelled"
        );
    for (const interview of cases)
      await tx
        .update(feedback)
        .set({
          authorName: "[erased]",
          rawFeedback: "[erased]",
          scorecard: null,
          aiSummary: null,
          finalDecision: null,
        })
        .where(
          and(
            eq(feedback.ownerId, ownerId),
            eq(feedback.interviewId, interview.id)
          )
        );
    for (const event of events)
      if (
        event.eventType.startsWith("interview.feedback_") &&
        event.metadata?.candidateId === candidateId
      )
        await tx
          .update(workflowEvents)
          .set({
            metadata: { redacted: true, reason: "candidate_privacy_erasure" },
          })
          .where(
            and(
              eq(workflowEvents.ownerId, ownerId),
              eq(workflowEvents.id, event.id)
            )
          );
  });
}
