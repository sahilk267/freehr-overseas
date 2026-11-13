import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import * as dbModule from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import {
  getCandidateEvidence,
  saveCandidateEvidence,
} from "./candidateEvidence";
import {
  prepareSubmission,
  releaseSubmission,
  prepareSubmissionMail,
  publicSubmissionEntry,
  requestSubmissionOtp,
  verifySubmissionOtp,
  readSubmission,
  respondSubmission,
  revokeSubmission,
  submissionDetail,
  enrollSubmissionFollowup,
  eraseSubmissionContent,
  submissionOptions,
} from "./submissions";
import { materializeSubmissionEmail } from "./submissionMail";
import { submissionEvent } from "./submissionState";
import {
  SUBMISSION_LINK_MARKER,
  SUBMISSION_OTP_MARKER,
  submissionSecret,
} from "./submissionMailScope";
import { deliverApprovedEmail } from "./emailDelivery";
import { followUpEligibility } from "./followups";
import { appendWorkflowEvent } from "./workflowStore";
const send = vi.hoisted(() =>
  vi.fn(async (_input: any) => ({
    providerMessageId: "synthetic-submission-receipt",
  }))
);
vi.mock("./hostingerMail", async original => ({
  ...(await original()),
  isSenderIdentityConfigured: () => true,
  sendViaHostingerMailApi: send,
}));
const owners: number[] = [];
beforeEach(() => {
  vi.stubEnv(
    "SESSION_SECRET",
    "synthetic-submission-secret-longer-than-thirty-two-characters"
  );
  vi.stubEnv("APP_BASE_URL", "https://freelancehr.overseasjob.in");
  send.mockClear();
  send.mockResolvedValue({ providerMessageId: "synthetic-submission-receipt" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const ownerId of owners.splice(0))
    await (await dbModule.requireDb())
      .update(schema.workspaceSettings)
      .set({ backgroundEnabled: false })
      .where(eq(schema.workspaceSettings.ownerId, ownerId));
});
async function fixture() {
  const f = await followupFixture();
  owners.push(f.ownerId);
  await f.db
    .update(schema.workspaceSettings)
    .set({ backgroundEnabled: true })
    .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
  const consentId = dbModule.createId("cns_");
  await f.db.insert(schema.consents).values({
    id: consentId,
    ownerId: f.ownerId,
    candidateId: f.candidateId,
    companyId: f.companyId,
    jobId: f.jobId,
    consentType: "client_sharing",
    status: "granted",
    noticeVersion: "synthetic-v1",
    dataScope: {
      fields: ["skills", "locations", "workModels", "noticePeriodDays"],
    },
  });
  const d = await getCandidateEvidence(f.ownerId, f.candidateId);
  await saveCandidateEvidence(f.ownerId, f.ownerId, {
    candidateId: f.candidateId,
    expectedRevision: d.revision,
    expectedFingerprint: d.fingerprint,
    fields: {
      skills: ["TypeScript", "Node.js"],
      locations: ["Mumbai"],
      workModels: ["remote"],
      noticePeriodDays: 30,
      observedAt: new Date(Date.now() - 60000),
      validUntil: new Date(Date.now() + 7 * 86400000),
      sourceNote:
        "Synthetic structured candidate statement for controlled tests.",
    },
    reason:
      "Record synthetic structured evidence for exact client submission tests.",
  });
  const input = {
    candidateId: f.candidateId,
    jobId: f.jobId,
    contactId: f.contactId,
    senderIdentityId: f.senders.clients,
    expectedVersion: 0,
    fields: ["skills", "locations", "workModels", "noticePeriodDays"] as (
      | "skills"
      | "locations"
      | "workModels"
      | "noticePeriodDays"
    )[],
    expiresHours: 72,
    transactionalOtp: true as const,
    requestKey: "synthetic-submission-initial",
  };
  return { ...f, consentId, input };
}
async function prepared() {
  const f = await fixture(),
    p = await prepareSubmission(f.ownerId, f.ownerId, f.input);
  return { ...f, p };
}
async function released() {
  const f = await prepared();
  await f.caller.recruitment.approvals.decide({
    id: f.p.approvalId,
    decision: "approved",
  });
  const released = await releaseSubmission(
    f.ownerId,
    f.ownerId,
    f.p.id,
    f.p.version
  );
  const [id, token] = released.fragment.split(".");
  return { ...f, cap: { id, token }, released };
}
async function invite(f: any) {
  const mail = await prepareSubmissionMail(f.ownerId, f.p.id);
  await f.caller.recruitment.approvals.decide({
    id: mail.approvalId,
    decision: "approved",
  });
  await deliverApprovedEmail(f.ownerId, { dispatchId: mail.dispatchId });
  return mail;
}
async function authenticated() {
  const f = await released();
  await invite(f);
  const otp = await requestSubmissionOtp(f.cap),
    c = await submissionEvent(f.db, f.ownerId, "otp", otp.challengeId),
    dispatch = (
      await f.db
        .select()
        .from(schema.emailDispatches)
        .where(eq(schema.emailDispatches.id, c.metadata.dispatchId))
    )[0],
    approval = (
      await f.db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.id, dispatch.approvalId))
    )[0],
    code = submissionSecret(approval.payload.submissionScope, true);
  await deliverApprovedEmail(f.ownerId, { dispatchId: dispatch.id });
  const session = await verifySubmissionOtp({
    ...f.cap,
    challengeId: otp.challengeId,
    code,
  });
  return {
    ...f,
    otp,
    dispatch,
    code,
    session,
    access: {
      ...f.cap,
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
    },
  };
}
describe("exact client submission profiles and real access semantics", () => {
  it("prepares only selected structured fields and deduplicates exact request identities", async () => {
    const f = await prepared(),
      again = await prepareSubmission(f.ownerId, f.ownerId, f.input),
      d = await submissionDetail(f.ownerId, f.p.id);
    expect(again.id).toBe(f.p.id);
    expect(again.alreadyPrepared).toBe(true);
    expect(d.pack.fields).toEqual({
      skills: ["TypeScript", "Node.js"],
      locations: ["Mumbai"],
      workModels: ["remote"],
      noticePeriodDays: 30,
    });
    expect(JSON.stringify(d.pack)).not.toContain(f.address);
    expect(JSON.stringify(d.pack)).not.toContain("Synthetic candidate");
    expect(d.pack.candidateApprovedExactPack).toBe(false);
    expect(d.sourceCurrent).toBe(true);
    expect(d.recipient.matchesPreparedHash).toBe(true);
    expect(d.sender.purpose).toBe("clients");
    await expect(
      prepareSubmission(f.ownerId, f.ownerId, {
        ...f.input,
        fields: ["skills"],
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("separates owner approval from actual access release and recipient review", async () => {
    const f = await prepared();
    await expect(
      releaseSubmission(f.ownerId, f.ownerId, f.p.id, 1)
    ).rejects.toThrow(/approval/);
    await f.caller.recruitment.approvals.decide({
      id: f.p.approvalId,
      decision: "approved",
    });
    let s = (
      await f.db
        .select()
        .from(schema.shortlists)
        .where(eq(schema.shortlists.id, f.p.id))
    )[0];
    expect(s.status).toBe("release_ready");
    expect(s.sharedAt).toBeNull();
    expect(s.viewedAt).toBeNull();
    const r = await releaseSubmission(f.ownerId, f.ownerId, f.p.id, 1);
    s = (
      await f.db
        .select()
        .from(schema.shortlists)
        .where(eq(schema.shortlists.id, f.p.id))
    )[0];
    expect(s.status).toBe("shared");
    expect(s.sharedAt).toBeInstanceOf(Date);
    expect(s.viewedAt).toBeNull();
    expect(
      (await releaseSubmission(f.ownerId, f.ownerId, f.p.id, 1)).fragment
    ).toBe(r.fragment);
  });
  it("requires exact client/job sharing consent and keeps another owner contact outside the release", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      prepareSubmission(f.ownerId, f.ownerId, {
        ...f.input,
        contactId: other.contactId,
      })
    ).rejects.toThrow(/contact/);
    await f.db
      .update(schema.consents)
      .set({ status: "withdrawn" })
      .where(eq(schema.consents.id, f.consentId));
    await expect(
      prepareSubmission(f.ownerId, f.ownerId, f.input)
    ).rejects.toThrow(/consent/);
  });
  it("enforces data-scope fields, fresh evidence and exclusion of direct contact values", async () => {
    const f = await fixture();
    await f.db
      .update(schema.consents)
      .set({ dataScope: { fields: ["skills"] } })
      .where(eq(schema.consents.id, f.consentId));
    await expect(
      prepareSubmission(f.ownerId, f.ownerId, f.input)
    ).rejects.toThrow(/scope/);
    await f.db
      .update(schema.consents)
      .set({ dataScope: null })
      .where(eq(schema.consents.id, f.consentId));
    const d = await getCandidateEvidence(f.ownerId, f.candidateId);
    await saveCandidateEvidence(f.ownerId, f.ownerId, {
      candidateId: f.candidateId,
      expectedRevision: d.revision,
      expectedFingerprint: d.fingerprint,
      fields: { ...d.fields!, skills: ["owner@example.test"] },
      reason:
        "Synthetic contact injection must not enter a minimized external profile.",
    });
    await expect(
      prepareSubmission(f.ownerId, f.ownerId, f.input)
    ).rejects.toThrow(/contact details/);
  });
  it("does not approve a changed recipient/source and rolls back the decision atomically", async () => {
    const f = await prepared();
    await f.db
      .update(schema.contacts)
      .set({ email: "changed@example.test" })
      .where(eq(schema.contacts.id, f.contactId));
    await expect(
      f.caller.recruitment.approvals.decide({
        id: f.p.approvalId,
        decision: "approved",
      })
    ).rejects.toThrow();
    expect(
      (
        await f.db
          .select()
          .from(schema.approvals)
          .where(eq(schema.approvals.id, f.p.approvalId))
      )[0].status
    ).toBe("pending");
  });
  it("does not return a profile, token or OTP in unauthenticated entry metadata", async () => {
    const f = await released(),
      entry = await publicSubmissionEntry(f.cap);
    expect(entry.maskedEmail).toContain("***@");
    expect(entry).not.toHaveProperty("pack");
    expect(JSON.stringify(entry)).not.toContain(f.cap.token);
    expect(
      (await submissionDetail(f.ownerId, f.p.id)).shortlist.viewedAt
    ).toBeNull();
    await expect(
      readSubmission({
        ...f.cap,
        sessionId: "fake_session",
        sessionToken: "A".repeat(43),
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("binds pending invitation content to the exact recipient and source at approval and send", async () => {
    const f = await released(),
      mail = await prepareSubmissionMail(f.ownerId, f.p.id),
      again = await prepareSubmissionMail(f.ownerId, f.p.id);
    expect(again.dispatchId).toBe(mail.dispatchId);
    const message = (
        await f.db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, mail.messageId))
      )[0],
      a = (
        await f.db
          .select()
          .from(schema.approvals)
          .where(eq(schema.approvals.id, mail.approvalId))
      )[0];
    expect(message.body).toContain(SUBMISSION_LINK_MARKER);
    expect(message.body).not.toContain(f.cap.token);
    const rendered = await materializeSubmissionEmail(
      f.db,
      f.ownerId,
      a.payload,
      message
    );
    expect(rendered?.body).toContain("/client-review#" + f.released.fragment);
    await f.db
      .update(schema.contacts)
      .set({ contactPermission: "unknown" })
      .where(eq(schema.contacts.id, f.contactId));
    await expect(
      f.caller.recruitment.approvals.decide({
        id: mail.approvalId,
        decision: "approved",
      })
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("uses the existing approved transport and records provider acceptance separately from opening", async () => {
    const f = await released(),
      mail = await prepareSubmissionMail(f.ownerId, f.p.id);
    await f.caller.recruitment.approvals.decide({
      id: mail.approvalId,
      decision: "approved",
    });
    await deliverApprovedEmail(f.ownerId, { dispatchId: mail.dispatchId });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].text).toContain(
      "/client-review#" + f.released.fragment
    );
    const d = await submissionDetail(f.ownerId, f.p.id);
    expect(d.shortlist.status).toBe("shared");
    expect(d.shortlist.viewedAt).toBeNull();
    expect(
      (
        await f.db
          .select()
          .from(schema.emailDispatches)
          .where(eq(schema.emailDispatches.id, mail.dispatchId))
      )[0].status
    ).toBe("sent");
  });
  it("fences private reads immediately after candidate, job, permission or recipient source changes", async () => {
    for (const change of [
      "consent",
      "candidate",
      "job",
      "contact",
      "company",
    ]) {
      const f = await released();
      if (change === "consent")
        await f.db
          .update(schema.consents)
          .set({ status: "withdrawn" })
          .where(eq(schema.consents.id, f.consentId));
      if (change === "candidate")
        await f.db
          .update(schema.candidates)
          .set({ doNotContactAt: new Date() })
          .where(eq(schema.candidates.id, f.candidateId));
      if (change === "job")
        await f.db
          .update(schema.jobs)
          .set({ pipelineState: "cancelled" })
          .where(eq(schema.jobs.id, f.jobId));
      if (change === "contact")
        await f.db
          .update(schema.contacts)
          .set({ email: "another@example.test" })
          .where(eq(schema.contacts.id, f.contactId));
      if (change === "company")
        await f.db
          .update(schema.companies)
          .set({ pipelineState: "suppressed" })
          .where(eq(schema.companies.id, f.companyId));
      await expect(publicSubmissionEntry(f.cap)).rejects.toThrow();
    }
  });
  it("revokes earlier links, queued mail and approved sources when a pack is replaced", async () => {
    const f = await released(),
      mail = await prepareSubmissionMail(f.ownerId, f.p.id),
      next = await prepareSubmission(f.ownerId, f.ownerId, {
        ...f.input,
        expectedVersion: 1,
        requestKey: "synthetic-new-pack-version",
        fields: ["skills"],
      });
    expect(next.version).toBe(2);
    await expect(publicSubmissionEntry(f.cap)).rejects.toThrow();
    expect(
      (
        await f.db
          .select()
          .from(schema.emailDispatches)
          .where(eq(schema.emailDispatches.id, mail.dispatchId))
      )[0].status
    ).toBe("cancelled");
    await expect(
      releaseSubmission(f.ownerId, f.ownerId, next.id, 1)
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("prevents legacy state, feedback and approval endpoints from bypassing governed access", async () => {
    const f = await released();
    await expect(
      f.caller.recruitment.candidateWorkflows.shortlists.updateState({
        id: f.p.id,
        status: "viewed",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.caller.recruitment.candidateWorkflows.shortlists.updateNote({
        id: f.p.id,
        clientFeedback: "Fake client response from an owner edit.",
      })
    ).rejects.toThrow();
    await expect(
      f.caller.recruitment.matching.requestShareApproval({
        candidateId: f.candidateId,
        jobId: f.jobId,
        companyId: f.companyId,
      })
    ).rejects.toThrow(/versioned submission/);
  });
});
describe("recipient email verification and correction history", () => {
  it("creates bounded automatic code mail with no raw code in storage or API results", async () => {
    const f = await released(),
      r = await requestSubmissionOtp(f.cap),
      c = await submissionEvent(f.db, f.ownerId, "otp", r.challengeId),
      a = (
        await f.db
          .select()
          .from(schema.approvals)
          .where(
            eq(
              schema.approvals.resourceId,
              (
                await f.db
                  .select()
                  .from(schema.emailDispatches)
                  .where(eq(schema.emailDispatches.id, c.metadata.dispatchId))
              )[0].messageId
            )
          )
      )[0],
      message = (
        await f.db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, a.resourceId))
      )[0];
    expect(a.status).toBe("approved");
    expect(message.body).toBe(SUBMISSION_OTP_MARKER);
    expect(JSON.stringify(r)).not.toContain(c.metadata.codeHash);
    expect((await requestSubmissionOtp(f.cap)).alreadyRequested).toBe(true);
  });
  it("requires accepted code delivery, consumes the code once and records verified email opening only after profile read", async () => {
    const f = await authenticated();
    await expect(
      verifySubmissionOtp({
        ...f.cap,
        challengeId: f.otp.challengeId,
        code: f.code,
      })
    ).rejects.toThrow(/already used/);
    let detail = await submissionDetail(f.ownerId, f.p.id);
    expect(detail.shortlist.viewedAt).toBeNull();
    const read = await readSubmission(f.access);
    expect(read.emailPossessionVerified).toBe(true);
    expect(read.clientAuthorityVerified).toBe(false);
    expect(read.pack).not.toHaveProperty("fullName");
    detail = await submissionDetail(f.ownerId, f.p.id);
    expect(detail.shortlist.status).toBe("viewed");
    expect(detail.view.emailPossessionVerified).toBe(true);
    expect((await readSubmission(f.access)).version).toBe(1);
  });
  it("never accepts a guessed undelivered code, even when its persisted hash matches", async () => {
    const f = await released(),
      otp = await requestSubmissionOtp(f.cap),
      c = await submissionEvent(f.db, f.ownerId, "otp", otp.challengeId),
      d = (
        await f.db
          .select()
          .from(schema.emailDispatches)
          .where(eq(schema.emailDispatches.id, c.metadata.dispatchId))
      )[0],
      a = (
        await f.db
          .select()
          .from(schema.approvals)
          .where(eq(schema.approvals.id, d.approvalId))
      )[0],
      code = submissionSecret(a.payload.submissionScope, true);
    await expect(
      verifySubmissionOtp({ ...f.cap, challengeId: otp.challengeId, code })
    ).rejects.toThrow(/undelivered/);
  });
  it("commits failed-attempt counters and blocks the sixth code guess", async () => {
    const f = await released(),
      otp = await requestSubmissionOtp(f.cap),
      c = await submissionEvent(f.db, f.ownerId, "otp", otp.challengeId);
    await deliverApprovedEmail(f.ownerId, {
      dispatchId: c.metadata.dispatchId,
    });
    for (let i = 0; i < 5; i++)
      await expect(
        verifySubmissionOtp({
          ...f.cap,
          challengeId: otp.challengeId,
          code: "invalid",
        })
      ).rejects.toThrow();
    expect(
      (await submissionEvent(f.db, f.ownerId, "otp_attempt", otp.challengeId))
        .metadata.failedCount
    ).toBe(5);
  });
  it("does not admit code mail while background execution, emergency stop or the agency budget prevents it", async () => {
    const f = await released();
    await f.db
      .update(schema.workspaceSettings)
      .set({ emergencyStop: true })
      .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
    await expect(requestSubmissionOtp(f.cap)).rejects.toThrow(/unavailable/);
    await f.db
      .update(schema.workspaceSettings)
      .set({ emergencyStop: false, dailyOutboundLimit: 0 })
      .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
    await expect(requestSubmissionOtp(f.cap)).rejects.toThrow(/budget/);
    expect(send).not.toHaveBeenCalled();
  });
  it("records immutable recipient feedback/corrections without booking, progressing or rejecting the candidate", async () => {
    const f = await authenticated();
    await readSubmission(f.access);
    const input = {
      ...f.access,
      expectedRevision: 0,
      requestKey: "synthetic-feedback-first",
      outcome: "interview_interest" as const,
      note: "Please clarify the job-related backend experience before considering an interview.",
      noticeVersion: "client-submission-v1" as const,
    };
    const first = await respondSubmission(input);
    expect(first.revision).toBe(1);
    expect((await respondSubmission(input)).alreadySaved).toBe(true);
    await expect(
      respondSubmission({
        ...input,
        note: "Different content using the same identity.",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await respondSubmission({
      ...input,
      expectedRevision: 1,
      requestKey: "synthetic-feedback-correction",
      outcome: "clarification_requested",
      note: "Correction: clarify the specific role evidence first.",
    });
    const d = await submissionDetail(f.ownerId, f.p.id);
    expect(d.feedback).toHaveLength(2);
    expect(d.feedback[1].note).toBe(input.note);
    expect(
      await f.db
        .select()
        .from(schema.interviews)
        .where(eq(schema.interviews.ownerId, f.ownerId))
    ).toHaveLength(1);
    expect(
      (
        await f.db
          .select()
          .from(schema.candidates)
          .where(eq(schema.candidates.id, f.candidateId))
      )[0].profileState
    ).toBe("consented");
  });
  it("fences an earlier session and feedback request after source revocation", async () => {
    const f = await authenticated();
    await readSubmission(f.access);
    await revokeSubmission(f.ownerId, f.ownerId, f.p.id);
    await expect(readSubmission(f.access)).rejects.toThrow();
    await expect(
      releaseSubmission(f.ownerId, f.ownerId, f.p.id, 1)
    ).rejects.toThrow();
  });
  it("uses FU15/FU16 through the shared engine and stops reminders on actual review and response", async () => {
    const f = await authenticated(),
      plan = await enrollSubmissionFollowup(f.ownerId, f.p.id);
    expect(
      (
        await f.db
          .select()
          .from(schema.followUpPlans)
          .where(eq(schema.followUpPlans.id, plan.id))
      )[0].scenarioId
    ).toBe("FU15");
    await readSubmission(f.access);
    expect(
      (
        await f.db
          .select()
          .from(schema.followUpPlans)
          .where(eq(schema.followUpPlans.id, plan.id))
      )[0].status
    ).toBe("completed");
    const feedbackPlan = await enrollSubmissionFollowup(f.ownerId, f.p.id);
    expect(
      (
        await f.db
          .select()
          .from(schema.followUpPlans)
          .where(eq(schema.followUpPlans.id, feedbackPlan.id))
      )[0].scenarioId
    ).toBe("FU16");
    await respondSubmission({
      ...f.access,
      expectedRevision: 0,
      requestKey: "synthetic-followup-feedback",
      outcome: "reviewed",
      note: "The exact profile was reviewed; clarification may follow.",
      noticeVersion: "client-submission-v1",
    });
    expect(
      (
        await f.db
          .select()
          .from(schema.followUpPlans)
          .where(eq(schema.followUpPlans.id, feedbackPlan.id))
      )[0].status
    ).toBe("completed");
  });
  it("invalidates a prepared reminder when sharing consent is withdrawn before delivery", async () => {
    const f = await released();
    await invite(f);
    const result = await enrollSubmissionFollowup(f.ownerId, f.p.id),
      plan = (
        await f.db
          .select()
          .from(schema.followUpPlans)
          .where(eq(schema.followUpPlans.id, result.id))
      )[0];
    await f.db
      .update(schema.consents)
      .set({ status: "withdrawn" })
      .where(eq(schema.consents.id, f.consentId));
    expect((await followUpEligibility(f.db, plan as any)).state).toBe(
      "cancelled"
    );
  });
  it("erases historical packs, feedback, sessions and unconsumed client-thread authority", async () => {
    const f = await authenticated();
    await readSubmission(f.access);
    await respondSubmission({
      ...f.access,
      expectedRevision: 0,
      requestKey: "synthetic-private-feedback",
      outcome: "reviewed",
      note: "PRIVATE_FEEDBACK_MARKER remains in history only until candidate erasure.",
      noticeVersion: "client-submission-v1",
    });
    const otpNew = await requestSubmissionOtp({ ...f.cap, resend: true });
    const mail = await prepareSubmissionMail(f.ownerId, f.p.id);
    await eraseSubmissionContent(f.ownerId, f.candidateId);
    await expect(publicSubmissionEntry(f.cap)).rejects.toThrow();
    const events = await f.db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.ownerId, f.ownerId));
    expect(
      events
        .filter((e: any) => e.eventType.startsWith("submission."))
        .every((e: any) => e.metadata.redacted === true)
    ).toBe(true);
    expect(
      JSON.stringify(
        events.filter((e: any) => e.eventType.startsWith("submission."))
      )
    ).not.toContain("PRIVATE_FEEDBACK_MARKER");
    expect(
      (
        await f.db
          .select()
          .from(schema.emailDispatches)
          .where(eq(schema.emailDispatches.id, mail.dispatchId))
      )[0].status
    ).toBe("sent");
  });
  it("denies owner APIs to anonymous callers and searches only owned source options", async () => {
    const f = await prepared(),
      other = await fixture();
    await expect(submissionDetail(other.ownerId, f.p.id)).rejects.toThrow();
    const { appRouter } = await import("../routers"),
      anon = appRouter.createCaller({
        user: null,
        req: { headers: {} },
        res: {},
      } as any);
    await expect(anon.submissions.detail({ id: f.p.id })).rejects.toMatchObject(
      { code: "UNAUTHORIZED" }
    );
    expect(
      (await submissionOptions(f.ownerId, { kind: "candidate" })).rows.map(
        (r: any) => r.id
      )
    ).toContain(f.candidateId);
    expect(
      (await submissionOptions(f.ownerId, { kind: "candidate" })).rows.map(
        (r: any) => r.id
      )
    ).not.toContain(other.candidateId);
  });
  it("expires released packs and short sessions and invalidates links after key/origin rotation", async () => {
    const f = await authenticated();
    const original = await submissionEvent(f.db, f.ownerId, "pack", f.p.id);
    await f.db
      .update(schema.workflowEvents)
      .set({
        metadata: {
          ...original.metadata,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      })
      .where(eq(schema.workflowEvents.id, original.id));
    await expect(publicSubmissionEntry(f.cap)).rejects.toThrow();
    await f.db
      .update(schema.workflowEvents)
      .set({ metadata: original.metadata })
      .where(eq(schema.workflowEvents.id, original.id));
    const session = await submissionEvent(
      f.db,
      f.ownerId,
      "session",
      f.session.sessionId
    );
    await f.db
      .update(schema.workflowEvents)
      .set({
        metadata: {
          ...session.metadata,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      })
      .where(eq(schema.workflowEvents.id, session.id));
    await expect(readSubmission(f.access)).rejects.toThrow();
    vi.stubEnv("APP_BASE_URL", "https://changed.example.test");
    await expect(publicSubmissionEntry(f.cap)).rejects.toThrow();
    vi.stubEnv("APP_BASE_URL", "https://freelancehr.overseasjob.in");
    vi.stubEnv(
      "SESSION_SECRET",
      "rotated-synthetic-submission-secret-longer-than-thirty-two-characters"
    );
    await expect(publicSubmissionEntry(f.cap)).rejects.toThrow();
  });
  it("fences a recipient/address change after approval at actual email admission without consuming authorization", async () => {
    const f = await released(),
      mail = await prepareSubmissionMail(f.ownerId, f.p.id);
    await f.caller.recruitment.approvals.decide({
      id: mail.approvalId,
      decision: "approved",
    });
    await f.db
      .update(schema.contacts)
      .set({ email: "changed-after-approval@example.test" })
      .where(eq(schema.contacts.id, f.contactId));
    await expect(
      deliverApprovedEmail(f.ownerId, { dispatchId: mail.dispatchId })
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await f.db
          .select()
          .from(schema.approvals)
          .where(eq(schema.approvals.id, mail.approvalId))
      )[0].actionedAt
    ).toBeNull();
  });
  it("requires a canonical sent invitation before enrolling a chase about an earlier email", async () => {
    const f = await released();
    await expect(enrollSubmissionFollowup(f.ownerId, f.p.id)).rejects.toThrow(
      /invitation/
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("blocks more than three same-day recipient code requests across different submission records", async () => {
    const f = await released(),
      recipient = (
        await f.db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.id, f.contactId))
      )[0];
    for (let i = 0; i < 3; i++)
      await appendWorkflowEvent(
        f.db,
        f.ownerId,
        "submission.otp",
        "synthetic_prior_code_" + i,
        1,
        {
          candidateId: f.candidateId,
          recipientHash: dbModule.hashContactValue(recipient.email),
          createdAt: new Date().toISOString(),
        }
      );
    await expect(requestSubmissionOtp(f.cap)).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });
  it("does not allow a generic share approval to bypass an exact governing pack", async () => {
    const f = await prepared(),
      id = dbModule.createId("apr_");
    await f.db.insert(schema.approvals).values({
      id,
      ownerId: f.ownerId,
      requestedBy: "user",
      actionType: "candidate_share",
      resourceType: "shortlist",
      resourceId: f.p.id,
      status: "pending",
      payload: {
        candidateId: f.candidateId,
        jobId: f.jobId,
        companyId: f.companyId,
      },
    });
    await expect(
      f.caller.recruitment.approvals.decide({ id, decision: "approved" })
    ).rejects.toThrow(/exact pack/);
    expect(
      (
        await f.db
          .select()
          .from(schema.shortlists)
          .where(eq(schema.shortlists.id, f.p.id))
      )[0].status
    ).toBe("approval_pending");
  });
  it("keeps authenticated non-progression feedback outside final candidate disposition authority", async () => {
    const f = await authenticated();
    await readSubmission(f.access);
    await respondSubmission({
      ...f.access,
      expectedRevision: 0,
      requestKey: "synthetic-non-progression",
      outcome: "not_progressing",
      note: "The recorded examples do not yet demonstrate this requirement; recruiter review is requested.",
      noticeVersion: "client-submission-v1",
    });
    expect(
      (
        await f.db
          .select()
          .from(schema.candidates)
          .where(eq(schema.candidates.id, f.candidateId))
      )[0].profileState
    ).toBe("consented");
    expect(
      await f.db
        .select()
        .from(schema.approvals)
        .where(
          and(
            eq(schema.approvals.ownerId, f.ownerId),
            eq(schema.approvals.actionType, "candidate_final_decision")
          )
        )
    ).toHaveLength(0);
  });
  it("propagates canonical privacy fulfillment through historical profile/client session erasure", async () => {
    const f = await authenticated();
    await readSubmission(f.access);
    await f.db
      .update(schema.placements)
      .set({ status: "closed" })
      .where(eq(schema.placements.ownerId, f.ownerId));
    const requestId = dbModule.createId("rgt_");
    await f.db.insert(schema.rightsRequests).values({
      id: requestId,
      ownerId: f.ownerId,
      candidateId: f.candidateId,
      requestType: "deletion",
      status: "received",
      details: "Synthetic client profile rights erasure acceptance.",
    });
    await f.caller.recruitment.candidateWorkflows.privacy.fulfillDeletion({
      requestId,
      resolutionNote:
        "Erase synthetic client review profile and all access authority.",
    });
    await expect(readSubmission(f.access)).rejects.toThrow();
    expect(
      (
        await f.db
          .select()
          .from(schema.workflowEvents)
          .where(
            and(
              eq(schema.workflowEvents.ownerId, f.ownerId),
              eq(schema.workflowEvents.eventType, "submission.pack")
            )
          )
      ).every((e: any) => e.metadata.redacted)
    ).toBe(true);
  });
  it("applies recruitment timing restrictions to invitations while preserving exact recipient-requested security-code authority", async () => {
    const f = await released();
    await appendWorkflowEvent(
      f.db,
      f.ownerId,
      "contact.timing_saved",
      (await submissionEvent(f.db, f.ownerId, "pack", f.p.id)).metadata
        .recipientHash,
      1,
      {
        active: true,
        fields: {
          timezone: "UTC",
          preferredChannel: "whatsapp",
          validUntil: new Date(Date.now() + 7 * 86400000),
        },
      }
    );
    const mail = await prepareSubmissionMail(f.ownerId, f.p.id);
    await f.caller.recruitment.approvals.decide({
      id: mail.approvalId,
      decision: "approved",
    });
    await expect(
      deliverApprovedEmail(f.ownerId, { dispatchId: mail.dispatchId })
    ).rejects.toThrow(/another channel/);
    expect(send).not.toHaveBeenCalled();
    const otp = await requestSubmissionOtp(f.cap),
      c = await submissionEvent(f.db, f.ownerId, "otp", otp.challengeId);
    await deliverApprovedEmail(f.ownerId, {
      dispatchId: c.metadata.dispatchId,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].subject).toBe(
      "Client review verification code"
    );
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")(
    "serializes competing profile requests into one immutable pack and one exact sharing approval",
    async () => {
      const f = await fixture(),
        results = await Promise.allSettled([
          prepareSubmission(f.ownerId, f.ownerId, f.input),
          prepareSubmission(f.ownerId, f.ownerId, {
            ...f.input,
            requestKey: "synthetic-competing-request",
          }),
        ]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(
        await f.db
          .select()
          .from(schema.shortlists)
          .where(eq(schema.shortlists.ownerId, f.ownerId))
      ).toHaveLength(1);
      expect(
        await f.db
          .select()
          .from(schema.approvals)
          .where(
            and(
              eq(schema.approvals.ownerId, f.ownerId),
              eq(schema.approvals.actionType, "candidate_share")
            )
          )
      ).toHaveLength(1);
    }
  );
});
