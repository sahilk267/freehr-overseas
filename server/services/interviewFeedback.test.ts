import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  candidates,
  contacts,
  feedback,
  interviews,
  jobs,
  matches,
  placements,
  rightsRequests,
  workflowEvents,
  workspaceSettings,
} from "../../drizzle/schema";
import * as dbModule from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { compareInterviewFeedback } from "../../shared/interviewFeedback";
import {
  configureInterviewFeedback,
  recordStructuredInterviewFeedback,
  resolveInterviewFeedback,
  interviewFeedbackDetail,
  ensureInterviewFeedbackConversation,
  enrollInterviewFeedbackReminder,
} from "./interviewFeedback";
import { prepareFollowUp, followUpEligibility } from "./followups";
import { buildMatchContext } from "./matchContext";
const owners: number[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const ownerId of owners.splice(0))
    await (await dbModule.requireDb())
      .update(workspaceSettings)
      .set({ backgroundEnabled: false })
      .where(eq(workspaceSettings.ownerId, ownerId));
});
const criteria = [
  { criterion: "Systems design evidence", weight: 60, required: true },
  { criterion: "Testing evidence", weight: 40, required: false },
];
async function fixture() {
  const f = await followupFixture();
  owners.push(f.ownerId);
  await f.db
    .update(placements)
    .set({ status: "offer_pending" })
    .where(eq(placements.ownerId, f.ownerId));
  await f.db
    .update(jobs)
    .set({ scorecard: criteria })
    .where(eq(jobs.id, f.jobId));
  await f.db
    .update(interviews)
    .set({
      status: "completed",
      scheduledAt: new Date(Date.now() - 2 * 3600000),
      completedAt: new Date(Date.now() - 3600000),
    })
    .where(eq(interviews.id, f.interviewId));
  const before = await interviewFeedbackDetail(f.ownerId, f.interviewId),
    panelInput = {
      interviewId: f.interviewId,
      expectedFingerprint: before.fingerprint,
      expectedRevision: 0,
      reviewers: [
        {
          key: "lead_reviewer",
          name: "Synthetic lead reviewer",
          contactId: f.contactId,
        },
        { key: "second_reviewer", name: "Synthetic second reviewer" },
      ],
      dueAt: new Date(Date.now() + 86400000),
      reason: "Synthetic current interviewer rubric and panel for QA.",
    };
  await configureInterviewFeedback(f.ownerId, f.ownerId, panelInput);
  return {
    ...f,
    panelInput,
    detail: () => interviewFeedbackDetail(f.ownerId, f.interviewId),
  };
}
async function responseInput(f: any, key = "lead_reviewer", score = 4) {
  const d = await f.detail();
  return {
    interviewId: f.interviewId,
    expectedFingerprint: d.fingerprint,
    panelRevision: d.panel.revision,
    reviewerKey: key,
    requestKey: dbModule.createId("feedback_request_"),
    rawFeedback:
      "The reviewer observed sound system design and a tested failure recovery example.",
    ratings: [
      { criterionIndex: 0, score, quote: "sound system design" },
      { criterionIndex: 1, score, quote: "tested failure recovery example" },
    ],
    limitations:
      "Synthetic owner-recorded observations; no independently authenticated interviewer.",
    reason: "Synthetic evidence-based panel observation for local QA.",
  };
}
const resolveInput = (d: any, action = "owner_review") => ({
  interviewId: d.interviewId,
  expectedFingerprint: d.fingerprint,
  panelRevision: d.panel.revision,
  expectedResponseHash: d.responseHash,
  nextAction: action as "owner_review",
  evidence:
    "Synthetic explicit panel next-action review; no client identity or hiring decision is asserted.",
});
describe("structured interviewer evidence and shared feedback follow-ups", () => {
  it("keeps differing and unknown ratings visible without averaging into a hiring decision", () => {
    const c = compareInterviewFeedback(
      criteria,
      [
        { reviewerKey: "a", ratings: [{ criterionIndex: 0, score: 1 }] },
        { reviewerKey: "b", ratings: [{ criterionIndex: 0, score: 5 }] },
      ],
      ["a", "b", "c"]
    );
    expect(c.rows[0]).toMatchObject({
      minimum: 1,
      maximum: 5,
      conflict: true,
      unknownReviewers: ["c"],
    });
    expect(c.rows[1].minimum).toBeNull();
    expect(c.missingReviewers).toEqual(["c"]);
    expect(c.finalDisposition).toBe(false);
  });
  it("versions an exact source panel and reuses an identical request", async () => {
    const f = await fixture();
    expect(
      await configureInterviewFeedback(f.ownerId, f.ownerId, f.panelInput)
    ).toMatchObject({ revision: 1, alreadySaved: true });
    expect((await f.detail()).panel.criteria).toEqual(criteria);
  });
  it("rejects foreign panel contacts, duplicate identities and invalid employer weights", async () => {
    const f = await fixture(),
      d = await f.detail(),
      other = await fixture();
    await expect(
      configureInterviewFeedback(f.ownerId, f.ownerId, {
        ...f.panelInput,
        expectedRevision: 1,
        expectedFingerprint: d.fingerprint,
        reviewers: [
          {
            key: "foreign",
            name: "Synthetic foreign contact",
            contactId: other.contactId,
          },
        ],
      })
    ).rejects.toThrow(/exact owned client/);
    await expect(
      configureInterviewFeedback(f.ownerId, f.ownerId, {
        ...f.panelInput,
        expectedRevision: 1,
        reviewers: [f.panelInput.reviewers[0], f.panelInput.reviewers[0]],
      })
    ).rejects.toThrow(/unique/);
    await f.db
      .update(jobs)
      .set({ scorecard: [{ criterion: "Bad weight", weight: 70 }] })
      .where(eq(jobs.id, f.jobId));
    const changed = await f.detail();
    await expect(
      configureInterviewFeedback(f.ownerId, f.ownerId, {
        ...f.panelInput,
        expectedRevision: 1,
        expectedFingerprint: changed.fingerprint,
      })
    ).rejects.toThrow(/rubric/);
  });
  it("requires actual recorded completion of a past interview before feedback", async () => {
    const f = await fixture(),
      input = await responseInput(f);
    await f.db
      .update(interviews)
      .set({ status: "confirmed", completedAt: null })
      .where(eq(interviews.id, f.interviewId));
    await expect(
      recordStructuredInterviewFeedback(f.ownerId, f.ownerId, input)
    ).rejects.toThrow(/completed past/);
  });
  it("rejects numeric scores without literal supporting feedback evidence and duplicate criteria", async () => {
    const f = await fixture(),
      input = await responseInput(f);
    await expect(
      recordStructuredInterviewFeedback(f.ownerId, f.ownerId, {
        ...input,
        ratings: [
          {
            criterionIndex: 0,
            score: 5,
            quote: "Not in the recorded feedback",
          },
        ],
      })
    ).rejects.toThrow(/exact supporting quote/);
    await expect(
      recordStructuredInterviewFeedback(f.ownerId, f.ownerId, {
        ...input,
        ratings: [input.ratings[0], input.ratings[0]],
      })
    ).rejects.toThrow(/at most once/);
  });
  it("records separate reviewer responses, preserves unknowns and reaches received only after the assigned panel responds", async () => {
    const f = await fixture(),
      input = await responseInput(f);
    const saved = await recordStructuredInterviewFeedback(
      f.ownerId,
      f.ownerId,
      input
    );
    expect(
      await recordStructuredInterviewFeedback(f.ownerId, f.ownerId, input)
    ).toMatchObject({ id: saved.id, alreadySaved: true });
    expect((await f.detail()).interviewStatus).toBe("feedback_pending");
    const second = await responseInput(f, "second_reviewer", 1);
    await recordStructuredInterviewFeedback(f.ownerId, f.ownerId, {
      ...second,
      ratings: [
        { criterionIndex: 0, score: 1, quote: "sound system design" },
        { criterionIndex: 1, score: null },
      ],
    });
    const d = await f.detail();
    expect(d.interviewStatus).toBe("feedback_received");
    expect(d.comparison.rows[0].conflict).toBe(true);
    expect(d.comparison.rows[1].unknownReviewers).toContain("second_reviewer");
    expect(
      d.responses.every(
        (r: any) =>
          r.finalDecision == null && r.scorecard.identityVerified === false
      )
    ).toBe(true);
  });
  it("prevents a different request key from duplicating an active reviewer response", async () => {
    const f = await fixture(),
      input = await responseInput(f);
    await recordStructuredInterviewFeedback(f.ownerId, f.ownerId, input);
    await expect(
      recordStructuredInterviewFeedback(f.ownerId, f.ownerId, {
        ...input,
        requestKey: dbModule.createId("another_"),
      })
    ).rejects.toThrow(/explicit exact correction/);
    expect((await f.detail()).responses).toHaveLength(1);
  });
  it("preserves corrected observations as history and invalidates an older reviewed next action", async () => {
    const f = await fixture(),
      input = await responseInput(f),
      saved = await recordStructuredInterviewFeedback(
        f.ownerId,
        f.ownerId,
        input
      );
    await resolveInterviewFeedback(
      f.ownerId,
      f.ownerId,
      resolveInput(await f.detail())
    );
    await recordStructuredInterviewFeedback(f.ownerId, f.ownerId, {
      ...input,
      requestKey: dbModule.createId("correction_"),
      supersedesId: saved.id,
      rawFeedback: input.rawFeedback + " Additional evidence was recorded.",
      reason: "Synthetic explicit correction of the prior reviewer statement.",
    });
    const d = await f.detail();
    expect(d.history).toHaveLength(2);
    expect(d.responses).toHaveLength(1);
    expect(d.resolution).toBeNull();
  });
  it("blocks legacy status-only/raw recording once a structured panel governs the interview", async () => {
    const f = await fixture();
    await expect(
      f.caller.recruitment.feedback.record({
        interviewId: f.interviewId,
        authorName: "Unscoped legacy actor",
        rawFeedback:
          "An unscoped status-only feedback record must not replace the panel.",
      })
    ).rejects.toThrow(/structured feedback panel/);
  });
  it("rejects stale plan/role source and changed observation hashes", async () => {
    const f = await fixture(),
      input = await responseInput(f);
    await f.db
      .update(jobs)
      .set({ title: "Changed rubric scope" })
      .where(eq(jobs.id, f.jobId));
    await expect(
      recordStructuredInterviewFeedback(f.ownerId, f.ownerId, input)
    ).rejects.toThrow(/exact feedback panel/);
    expect((await f.detail()).current).toBe(false);
  });
  it("does not consider a next round while assigned reviewers are missing or apply candidate progression", async () => {
    const f = await fixture();
    await recordStructuredInterviewFeedback(
      f.ownerId,
      f.ownerId,
      await responseInput(f)
    );
    await expect(
      resolveInterviewFeedback(
        f.ownerId,
        f.ownerId,
        resolveInput(await f.detail(), "consider_next_round")
      )
    ).rejects.toThrow(/missing panel/);
    const input = resolveInput(await f.detail(), "request_clarification");
    await resolveInterviewFeedback(f.ownerId, f.ownerId, input);
    expect(
      await resolveInterviewFeedback(f.ownerId, f.ownerId, input)
    ).toMatchObject({ alreadySaved: true });
    expect(
      (
        await f.db
          .select()
          .from(candidates)
          .where(eq(candidates.id, f.candidateId))
      )[0].profileState
    ).toBe("consented");
  });
  it("invalidates old match context and includes bounded unverified interview observations for grounded review", async () => {
    const f = await fixture(),
      before = await buildMatchContext(f.db, f.ownerId, f.candidateId, f.jobId);
    await recordStructuredInterviewFeedback(
      f.ownerId,
      f.ownerId,
      await responseInput(f)
    );
    const after = await buildMatchContext(
      f.db,
      f.ownerId,
      f.candidateId,
      f.jobId
    );
    expect(after.candidateFingerprint).not.toBe(before.candidateFingerprint);
    expect(after.payload.candidate.interviewFeedback).toMatchObject({
      scope: "latest_updated_panel_only",
      identityVerified: false,
      finalDisposition: false,
    });
    expect(after.payload.candidate.interviewFeedback.observations).toHaveLength(
      1
    );
  });
  it("prepares one exact contact thread and enrolls reviewer-specific FU20 on the existing outbox", async () => {
    const f = await fixture(),
      input = { interviewId: f.interviewId, reviewerKey: "lead_reviewer" },
      thread = await ensureInterviewFeedbackConversation(
        f.ownerId,
        f.ownerId,
        input
      );
    expect(
      await ensureInterviewFeedbackConversation(f.ownerId, f.ownerId, input)
    ).toMatchObject({ id: thread.id, alreadyExists: true });
    const plan = await enrollInterviewFeedbackReminder(f.ownerId, f.ownerId, {
        ...input,
        conversationId: thread.id,
        senderIdentityId: f.senders.interviews,
      }),
      prepared = await prepareFollowUp(f.ownerId, {
        planId: plan.id,
        revision: 1,
        stepIndex: 0,
      });
    expect(prepared.status).toBe("approval_pending");
    await recordStructuredInterviewFeedback(
      f.ownerId,
      f.ownerId,
      await responseInput(f)
    );
    expect((await f.getPlan(plan.id)).status).toBe("completed");
  });
  it("prevents feedback reminders from using a different contact or candidate conversation", async () => {
    const f = await fixture();
    await expect(
      enrollInterviewFeedbackReminder(f.ownerId, f.ownerId, {
        interviewId: f.interviewId,
        reviewerKey: "lead_reviewer",
        conversationId: f.conversationId,
        senderIdentityId: f.senders.interviews,
      })
    ).rejects.toThrow();
  });
  it("rechecks expiry, changed schedule and reviewer permission before shared reminder preparation", async () => {
    const f = await fixture(),
      thread = await ensureInterviewFeedbackConversation(f.ownerId, f.ownerId, {
        interviewId: f.interviewId,
        reviewerKey: "lead_reviewer",
      }),
      plan = await enrollInterviewFeedbackReminder(f.ownerId, f.ownerId, {
        interviewId: f.interviewId,
        reviewerKey: "lead_reviewer",
        conversationId: thread.id,
        senderIdentityId: f.senders.interviews,
      });
    await f.db
      .update(contacts)
      .set({ optedOutAt: new Date(), contactPermission: "opted_out" })
      .where(eq(contacts.id, f.contactId));
    expect(
      (
        await prepareFollowUp(f.ownerId, {
          planId: plan.id,
          revision: 1,
          stepIndex: 0,
        })
      ).status
    ).toBe("cancelled");
  });
  it("isolates owner data and rejects protected recruitment signals", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      interviewFeedbackDetail(other.ownerId, f.interviewId)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      recordStructuredInterviewFeedback(f.ownerId, f.ownerId, {
        ...(await responseInput(f)),
        rawFeedback:
          "The reviewer used a caste preference which must not become a signal.",
      })
    ).rejects.toThrow(/protected/);
  });
  it("erases structured and legacy feedback and cancels client-thread reminders with candidate privacy cleanup", async () => {
    const f = await fixture(),
      thread = await ensureInterviewFeedbackConversation(f.ownerId, f.ownerId, {
        interviewId: f.interviewId,
        reviewerKey: "lead_reviewer",
      }),
      plan = await enrollInterviewFeedbackReminder(f.ownerId, f.ownerId, {
        interviewId: f.interviewId,
        reviewerKey: "lead_reviewer",
        conversationId: thread.id,
        senderIdentityId: f.senders.interviews,
      });
    await prepareFollowUp(f.ownerId, {
      planId: plan.id,
      revision: 1,
      stepIndex: 0,
    });
    const id = dbModule.createId("legacy_feedback_");
    await f.db
      .insert(feedback)
      .values({
        id,
        ownerId: f.ownerId,
        interviewId: f.interviewId,
        authorName: "Synthetic historical author",
        rawFeedback: "Synthetic legacy feedback must also be erased.",
      });
    const requestId = dbModule.createId("rights_");
    await f.db
      .insert(rightsRequests)
      .values({
        id: requestId,
        ownerId: f.ownerId,
        candidateId: f.candidateId,
        requestType: "deletion",
        status: "received",
      });
    await f.caller.recruitment.candidateWorkflows.privacy.fulfillDeletion({
      requestId,
      resolutionNote:
        "Erase synthetic interview feedback including client-thread reminders.",
    });
    expect((await f.getPlan(plan.id)).status).toBe("cancelled");
    const rows = await f.db
      .select()
      .from(feedback)
      .where(eq(feedback.ownerId, f.ownerId));
    expect(
      rows.every(r => r.rawFeedback === "[erased]" && r.scorecard === null)
    ).toBe(true);
    const events = await f.db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.ownerId, f.ownerId));
    expect(
      events
        .filter(e => e.eventType.startsWith("interview.feedback_"))
        .every(e => (e.metadata as any).redacted)
    ).toBe(true);
    expect((await f.detail()).panel).toBe(null);
  });
  it("rechecks candidate processing scope before recording observations", async () => {
    const f = await fixture(),
      input = await responseInput(f);
    const { consents } = await import("../../drizzle/schema");
    await f.db
      .update(consents)
      .set({ status: "withdrawn" })
      .where(eq(consents.ownerId, f.ownerId));
    await expect(
      recordStructuredInterviewFeedback(f.ownerId, f.ownerId, input)
    ).rejects.toThrow(/current exact feedback panel/);
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")(
    "serializes competing reviewer requests and rolls back a feedback row if audit fails",
    async () => {
      const f = await fixture(),
        input = await responseInput(f),
        results = await Promise.allSettled([
          recordStructuredInterviewFeedback(f.ownerId, f.ownerId, input),
          recordStructuredInterviewFeedback(f.ownerId, f.ownerId, {
            ...input,
            requestKey: dbModule.createId("competing_"),
          }),
        ]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const before = await f.detail(),
        original = dbModule.recordAudit;
      vi.spyOn(dbModule, "recordAudit").mockImplementation(async (p, tx) => {
        if (p.action === "interview.structured_feedback_recorded")
          throw Error("Synthetic feedback audit failure");
        return original(p, tx);
      });
      await expect(
        recordStructuredInterviewFeedback(
          f.ownerId,
          f.ownerId,
          await responseInput(f, "second_reviewer")
        )
      ).rejects.toThrow(/audit failure/);
      expect((await f.detail()).responses).toHaveLength(
        before.responses.length
      );
    }
  );
});
