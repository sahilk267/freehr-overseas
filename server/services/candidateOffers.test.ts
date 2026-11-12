import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  approvals,
  automationQueue,
  candidates,
  companies,
  consents,
  contacts,
  emailDispatches,
  invoices,
  jobs,
  messages,
  placements,
  rightsRequests,
  workflowEvents,
  workspaceSettings,
} from "../../drizzle/schema";
import * as dbModule from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import {
  createAgreement,
  getAgreement,
  recordAgreementAcceptance,
  jobCommercialOptions,
  bindAgreementToJob,
} from "./commercialAgreements";
import {
  bindPlacementCommercial,
  placementCommercialRead,
  commercialContext,
  draftContractInvoice,
} from "./commercialObligations";
import { offerFixedAnnual, type OfferTerms } from "../../shared/candidateOffer";
import {
  recordOfferAuthority,
  saveOfferDraft,
  requestOfferRelease,
  revealOfferLink,
  publicOfferEntry,
  requestOfferOtp,
  verifyOfferOtp,
  readAuthenticatedOffer,
  recordCandidateOfferReply,
  offerOwnerDetail,
  closeCandidateOffer,
  reviewOfferCondition,
  reportCandidateOfferWithdrawal,
  recordOfferLinkShared,
  enrollOfferFollowup,
  executeOfferDeadline,
  prepareOfferCounterDraft,
} from "./candidateOffers";
import {
  offerPlacementIdentity,
  assertCurrentOfferAcceptance,
} from "./candidateOfferState";
import { prepareOfferLinkEmail } from "./candidateOfferMail";
import { generateCandidateOfferDocument } from "./candidateOfferDocument";
import { deliverApprovedEmail } from "./emailDelivery";
import { prepareFollowUp, followUpEligibility } from "./followups";
import { OFFER_OTP_MARKER } from "./offerMailScope";
import { processOneQueuedJob } from "./queue";
const send = vi.hoisted(() =>
  vi.fn(async (_input: any) => ({
    providerMessageId: "synthetic-offer-provider-id",
  }))
);
vi.mock("./hostingerMail", async original => ({
  ...(await original()),
  isSenderIdentityConfigured: () => true,
  sendViaHostingerMailApi: send,
}));
const owners: number[] = [];
beforeEach(() => {
  send.mockClear();
  send.mockResolvedValue({ providerMessageId: "synthetic-offer-provider-id" });
  vi.stubEnv(
    "SESSION_SECRET",
    "synthetic-offer-secret-longer-than-thirty-two-characters"
  );
  vi.stubEnv("APP_BASE_URL", "https://freelancehr.overseasjob.in");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const ownerId of owners.splice(0))
    await (await dbModule.requireDb())
      .update(workspaceSettings)
      .set({ backgroundEnabled: false })
      .where(eq(workspaceSettings.ownerId, ownerId));
});
async function fixture() {
  const f = await followupFixture();
  owners.push(f.ownerId);
  const p = (
    await f.db
      .select()
      .from(placements)
      .where(eq(placements.ownerId, f.ownerId))
  )[0];
  await f.db.delete(invoices).where(eq(invoices.id, f.invoiceId));
  await f.db.delete(placements).where(eq(placements.id, p.id));
  await f.db
    .update(jobs)
    .set({ pipelineState: "draft" })
    .where(eq(jobs.id, f.jobId));
  const proposal = await createAgreement(f.ownerId, f.ownerId, {
      companyId: f.companyId,
      requestKey: dbModule.createId("offer_fee_"),
      terms: {
        feeType: "percentage",
        feeValue: "8.33",
        currency: "INR",
        guaranteeDays: 45,
        paymentTermsDays: 15,
        ownershipDays: 180,
        taxRateBasisPoints: 1800,
        termsText:
          "Synthetic agency terms only: the explicitly reviewed annual fee salary basis is required. No actual client contract.",
      },
    }),
    a = await getAgreement(f.ownerId, proposal.id);
  await recordAgreementAcceptance(f.ownerId, f.ownerId, {
    proposalId: proposal.id,
    acceptedBy: "client@example.test",
    acceptanceEvidence:
      "Synthetic owner-recorded agency acceptance, no real external signature.",
    expectedVersion: a.version,
    expectedTermsHash: a.termsHash,
  });
  const role = (await jobCommercialOptions(f.ownerId, proposal.id)).find(
    (j: any) => j.id === f.jobId
  );
  await bindAgreementToJob(f.ownerId, f.ownerId, {
    jobId: f.jobId,
    proposalId: proposal.id,
    expectedTermsHash: a.termsHash,
    expectedJobFingerprint: role.commercialFingerprint,
    reason: "Synthetic exact role agreement for offer QA.",
  });
  await f.db.insert(placements).values({
    id: p.id,
    ownerId: f.ownerId,
    companyId: f.companyId,
    jobId: f.jobId,
    candidateId: f.candidateId,
    currency: "INR",
    status: "offer_pending",
  });
  const binding = await placementCommercialRead(f.ownerId, p.id);
  await bindPlacementCommercial(f.ownerId, f.ownerId, {
    placementId: p.id,
    expectedPlacementFingerprint: binding.placementFingerprint,
    expectedTermsHash: a.termsHash,
    currency: "INR",
    annualCompensationMinorUnits: 100000000,
    reason: "Synthetic explicit pre-offer annual salary basis.",
  });
  await f.db
    .update(workspaceSettings)
    .set({
      backgroundEnabled: true,
      policyConfig: {
        aiDailyLimit: 0,
        followupRecipientDailyLimit: 3,
        minRecipientSpacingMinutes: 60,
        autoApprovalRules: [{ actionType: "offer_release", enabled: true }],
      },
    })
    .where(eq(workspaceSettings.ownerId, f.ownerId));
  const placement = (
      await f.db.select().from(placements).where(eq(placements.id, p.id))
    )[0],
    authority = {
      placementId: p.id,
      expectedPlacementIdentity: offerPlacementIdentity(placement),
      expectedRevision: 0,
      clientContactId: f.contactId,
      currency: "INR",
      minAnnualFixedMinor: 100000000,
      maxAnnualFixedMinor: 150000000,
      validUntil: new Date(Date.now() + 14 * 86400000),
      evidence:
        "Synthetic client bounds documented by owner for QA, client identity unverified.",
    };
  await recordOfferAuthority(f.ownerId, f.ownerId, authority);
  const terms: OfferTerms = {
    roleTitle: "Synthetic senior engineer",
    location: "Bengaluru",
    employmentType: "full_time",
    currency: "INR",
    annualBaseMinor: 110000000,
    annualGuaranteedAllowancesMinor: 10000000,
    variableCompensation: [
      {
        label: "Performance target",
        annualTargetMinor: 5000000,
        guaranteed: false,
      },
    ],
    oneTimePayments: [{ label: "Relocation support", amountMinor: 1000000 }],
    benefits: ["Synthetic health benefit"],
    conditions: [],
    joiningTimezone: "Asia/Kolkata",
    intendedJoiningAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    termsText:
      "Synthetic client-provided offer terms for QA only. No genuine employment offer, legal signature or recipient delivery is claimed.",
  };
  const draftInput = {
      placementId: p.id,
      expectedVersion: 0,
      terms,
      feeBasis: "annual_fixed" as const,
      feeBasisEvidence:
        "Synthetic accepted agency fee basis: annual fixed compensation, excluding variable targets and one-time payments.",
      reason: "Create the exact synthetic offer version for QA.",
    },
    draft = await saveOfferDraft(f.ownerId, f.ownerId, draftInput);
  return {
    ...f,
    placementId: p.id,
    authority,
    terms,
    draftInput,
    offerId: draft.id,
    read: () => offerOwnerDetail(f.ownerId, p.id),
  };
}
async function release(f: any, patch: any = {}) {
  const d = await f.read(),
    input = {
      id: f.offerId,
      expectedVersion: d.offer.version,
      expectedTermsHash: d.offer.termsHash,
      senderIdentityId: f.senders.talent,
      allowOtpEmail: true,
      transactionalOtp: true,
      reason:
        "Owner reviews this synthetic exact offer and bounded email-code authority.",
      ...patch,
    },
    requested = await requestOfferRelease(f.ownerId, f.ownerId, input);
  await f.caller.recruitment.approvals.decide({
    id: requested.approvalId,
    decision: "approved",
  });
  const fragment = (await revealOfferLink(f.ownerId, f.ownerId, f.offerId))
      .fragment,
    [id, token] = fragment.split(".");
  return { input, requested, cap: { id, token } };
}
async function session(f: any) {
  const r = await release(f),
    challenge = await requestOfferOtp(r.cap),
    before = (
      await f.db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.ownerId, f.ownerId),
            eq(workflowEvents.eventType, "offer.otp_created"),
            eq(workflowEvents.aggregateId, challenge.challengeId)
          )
        )
    )[0],
    dispatch = (
      await f.db
        .select()
        .from(emailDispatches)
        .where(eq(emailDispatches.id, before.metadata.dispatchId))
    )[0];
  expect(
    (
      await f.db
        .select()
        .from(messages)
        .where(eq(messages.id, dispatch.messageId))
    )[0].body
  ).toBe(OFFER_OTP_MARKER);
  await deliverApprovedEmail(f.ownerId, { dispatchId: dispatch.id });
  const text = send.mock.calls.at(-1)![0].text,
    code = /code is (\d{6})/.exec(text)![1],
    verified = await verifyOfferOtp({
      ...r.cap,
      challengeId: challenge.challengeId,
      code,
    });
  if (!verified.sessionId || !verified.sessionToken)
    throw Error("Verification failed");
  const auth = {
    id: f.offerId,
    sessionId: verified.sessionId,
    sessionToken: verified.sessionToken,
  };
  return {
    ...r,
    challenge,
    dispatch,
    code,
    auth,
    view: await readAuthenticatedOffer(auth),
  };
}
const reply = (s: any, patch: any = {}) => ({
  ...s.auth,
  expectedVersion: s.view.version,
  expectedTermsHash: s.view.termsHash,
  decision: "accept" as const,
  typedName: "Synthetic candidate",
  acknowledged: true as const,
  noticeVersion: "offer-response-v1" as const,
  note: "Synthetic response only.",
  ...patch,
});
describe("versioned offers with scoped email-possession responses", () => {
  it("deduplicates drafts, separates fixed/variable/one-time pay and keeps client authorization owner-evidenced", async () => {
    const f = await fixture();
    expect(
      await saveOfferDraft(f.ownerId, f.ownerId, f.draftInput)
    ).toMatchObject({ alreadySaved: true });
    const d = await f.read();
    expect(offerFixedAnnual(d.offer.terms)).toBe(120000000);
    expect(d.authority.clientIdentityVerified).toBe(false);
    expect(d.offer.release).toBe(null);
    expect(send).not.toHaveBeenCalled();
  });
  it("fences out-of-bound/currency drafts and stale version edits without creating another offer", async () => {
    const f = await fixture(),
      d = await f.read(),
      edit = {
        ...f.draftInput,
        expectedVersion: 1,
        expectedTermsHash: d.offer.termsHash,
      };
    await expect(
      saveOfferDraft(f.ownerId, f.ownerId, {
        ...edit,
        terms: { ...f.terms, annualBaseMinor: 180000000 },
      })
    ).rejects.toThrow(/authorized currency and bounds/);
    await expect(
      saveOfferDraft(f.ownerId, f.ownerId, {
        ...edit,
        terms: { ...f.terms, currency: "USD" },
      })
    ).rejects.toThrow(/currency/);
    await expect(
      saveOfferDraft(f.ownerId, f.ownerId, {
        ...edit,
        expectedTermsHash: "a".repeat(64),
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("requires a real owner release decision even when a matching automatic rule exists", async () => {
    const f = await fixture(),
      d = await f.read(),
      request = await requestOfferRelease(f.ownerId, f.ownerId, {
        id: f.offerId,
        expectedVersion: 1,
        expectedTermsHash: d.offer.termsHash,
        senderIdentityId: f.senders.talent,
        allowOtpEmail: true,
        transactionalOtp: true,
        reason: "Synthetic exact offer review requested.",
      });
    expect(
      (
        await f.db
          .select()
          .from(approvals)
          .where(eq(approvals.id, request.approvalId))
      )[0].status
    ).toBe("pending");
    await expect(
      revealOfferLink(f.ownerId, f.ownerId, f.offerId)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rejects release after client bounds, sender or underlying role changes", async () => {
    const f = await fixture(),
      d = await f.read(),
      r = await requestOfferRelease(f.ownerId, f.ownerId, {
        id: f.offerId,
        expectedVersion: 1,
        expectedTermsHash: d.offer.termsHash,
        senderIdentityId: f.senders.talent,
        allowOtpEmail: true,
        transactionalOtp: true,
        reason: "Synthetic release with later stale source.",
      });
    await f.db
      .update(jobs)
      .set({ location: "Source location changed" })
      .where(eq(jobs.id, f.jobId));
    await expect(
      f.caller.recruitment.approvals.decide({
        id: r.approvalId,
        decision: "approved",
      })
    ).rejects.toThrow(/stale/);
  });
  it("exposes no salary/name or client negotiation ceiling to a bearer link before email verification", async () => {
    const f = await fixture(),
      r = await release(f),
      entry = await publicOfferEntry(r.cap);
    expect(entry.maskedEmail).toContain("***");
    expect(entry).not.toHaveProperty("terms");
    expect(entry).not.toHaveProperty("candidateName");
    expect(entry).not.toHaveProperty("maxAnnualFixedMinor");
    await expect(
      publicOfferEntry({ ...r.cap, token: "a".repeat(43) })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("delivers the OTP through the existing outbox and keeps queued content code-free", async () => {
    const f = await fixture(),
      s = await session(f);
    expect(s.view.terms.annualBaseMinor).toBe(110000000);
    expect(s.view).not.toHaveProperty("clientAuthority");
    expect(send).toHaveBeenCalledTimes(1);
    expect(s.code).toMatch(/^\d{6}$/);
    await expect(
      verifyOfferOtp({
        ...s.cap,
        challengeId: s.challenge.challengeId,
        code: s.code,
      })
    ).rejects.toThrow(/already used/);
  });
  it("records one exact-version acceptance and atomically updates the accepted agency salary basis and fee", async () => {
    const f = await fixture(),
      s = await session(f);
    expect(await recordCandidateOfferReply(reply(s))).toMatchObject({
      decision: "accept",
      alreadyRecorded: false,
    });
    expect(await recordCandidateOfferReply(reply(s))).toMatchObject({
      alreadyRecorded: true,
    });
    const p = (
      await f.db
        .select()
        .from(placements)
        .where(eq(placements.id, f.placementId))
    )[0];
    expect(p.status).toBe("offer_accepted");
    expect(p.annualCompensation).toBe(120000000);
    const c = await commercialContext(f.db, f.ownerId, p);
    expect(c.fee).toMatchObject({
      amount: 9996000,
      taxAmount: 1799280,
      totalAmount: 11795280,
    });
    expect(c.binding.offerFeeBasis).toBe("annual_fixed");
    expect((await readAuthenticatedOffer(s.auth)).response).toMatchObject({
      emailPossessionVerified: true,
      legalIdentityVerified: false,
      qualifiedSignatureVerified: false,
    });
    const grants = await f.db
      .select()
      .from(consents)
      .where(
        and(
          eq(consents.ownerId, f.ownerId),
          eq(consents.consentType, "offer_response")
        )
      );
    expect(grants).toHaveLength(1);
  });
  it("does not include variable targets in the agency fee unless the explicit reviewed basis includes them", async () => {
    const f = await fixture(),
      d = await f.read();
    await saveOfferDraft(f.ownerId, f.ownerId, {
      ...f.draftInput,
      expectedVersion: 1,
      expectedTermsHash: d.offer.termsHash,
      feeBasis: "annual_target",
      feeBasisEvidence:
        "Synthetic agency contract explicitly includes annual variable targets.",
    });
    const s = await session(f);
    await recordCandidateOfferReply(reply(s));
    const p = (
      await f.db
        .select()
        .from(placements)
        .where(eq(placements.id, f.placementId))
    )[0];
    expect(p.annualCompensation).toBe(125000000);
    expect(
      (await commercialContext(f.db, f.ownerId, p)).binding.offerFeeBasis
    ).toBe("annual_target");
  });
  it("rejects changed term hashes and conflicting replies and does not close employment on decline", async () => {
    const f = await fixture(),
      s = await session(f);
    await expect(
      recordCandidateOfferReply(reply(s, { expectedTermsHash: "a".repeat(64) }))
    ).rejects.toThrow(/current exact/);
    await recordCandidateOfferReply(reply(s, { decision: "decline" }));
    await expect(recordCandidateOfferReply(reply(s))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await f.read()).placementStatus).toBe("offer_issued");
  });
  it("keeps counteroffers self-reported until a new bounded draft and owner release", async () => {
    const f = await fixture(),
      s = await session(f);
    await recordCandidateOfferReply(
      reply(s, { decision: "counter", counterAnnualFixedMinor: 130000000 })
    );
    expect((await f.read()).placementStatus).toBe("offer_issued");
    await prepareOfferCounterDraft(f.ownerId, f.ownerId, {
      id: f.offerId,
      reason:
        "Synthetic owner requests the counter draft within client bounds.",
    });
    const d = await f.read();
    expect(d.offer.version).toBe(2);
    expect(offerFixedAnnual(d.offer.terms)).toBe(130000000);
    expect(d.offer.release).toBe(null);
    await expect(publicOfferEntry(s.cap)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("does not turn an out-of-range candidate request into a promised concession", async () => {
    const f = await fixture(),
      s = await session(f);
    await recordCandidateOfferReply(
      reply(s, { decision: "counter", counterAnnualFixedMinor: 200000000 })
    );
    await expect(
      prepareOfferCounterDraft(f.ownerId, f.ownerId, {
        id: f.offerId,
        reason:
          "Synthetic out-of-bounds counter must wait for client authority.",
      })
    ).rejects.toThrow(/bounds/);
    expect((await f.read()).offer.version).toBe(1);
  });
  it("locks after five wrong codes and commits the failed-attempt counter", async () => {
    const f = await fixture(),
      r = await release(f),
      c = await requestOfferOtp(r.cap),
      row = (
        await f.db
          .select()
          .from(workflowEvents)
          .where(eq(workflowEvents.aggregateId, c.challengeId))
      )[0],
      d = (
        await f.db
          .select()
          .from(emailDispatches)
          .where(eq(emailDispatches.id, row.metadata.dispatchId))
      )[0];
    await deliverApprovedEmail(f.ownerId, { dispatchId: d.id });
    const code = /code is (\d{6})/.exec(send.mock.calls.at(-1)![0].text)![1],
      wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++)
      await expect(
        verifyOfferOtp({ ...r.cap, challengeId: c.challengeId, code: wrong })
      ).rejects.toThrow(/invalid/);
    await expect(
      verifyOfferOtp({ ...r.cap, challengeId: c.challengeId, code })
    ).rejects.toThrow(/invalid/);
    const attempts = await f.db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, f.ownerId),
          eq(workflowEvents.eventType, "offer.otp_attempt")
        )
      );
    expect(Math.max(...attempts.map((a: any) => a.metadata.failedCount))).toBe(
      5
    );
  });
  it("deduplicates simultaneous code requests, rate-limits resends and does not send when disabled", async () => {
    const f = await fixture(),
      r = await release(f, { allowOtpEmail: false, transactionalOtp: false });
    await expect(requestOfferOtp(r.cap)).rejects.toThrow(/not enabled/);
    expect(send).not.toHaveBeenCalled();
    const g = await fixture(),
      s = await release(g),
      a = await requestOfferOtp(s.cap),
      b = await requestOfferOtp({ ...s.cap, resend: true });
    expect(a.challengeId).toBe(b.challengeId);
    expect(b.alreadyRequested).toBe(true);
  });
  it("allows explicitly authorized security codes without normal outreach spacing but preserves emergency stop", async () => {
    const f = await fixture(),
      r = await release(f),
      link = await prepareOfferLinkEmail(f.ownerId, f.ownerId, f.offerId);
    await f.caller.recruitment.approvals.decide({
      id: link.approvalId,
      decision: "approved",
    });
    await deliverApprovedEmail(f.ownerId, { dispatchId: link.dispatchId });
    const c = await requestOfferOtp(r.cap),
      row = (
        await f.db
          .select()
          .from(workflowEvents)
          .where(eq(workflowEvents.aggregateId, c.challengeId))
      )[0];
    await f.db
      .update(workspaceSettings)
      .set({ emergencyStop: true })
      .where(eq(workspaceSettings.ownerId, f.ownerId));
    expect(
      (
        await deliverApprovedEmail(f.ownerId, {
          dispatchId: row.metadata.dispatchId,
        })
      ).status
    ).toBe("deferred");
    await f.db
      .update(workspaceSettings)
      .set({ emergencyStop: false })
      .where(eq(workspaceSettings.ownerId, f.ownerId));
    expect(
      (
        await deliverApprovedEmail(f.ownerId, {
          dispatchId: row.metadata.dispatchId,
        })
      ).status
    ).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("rejects stale code delivery after revocation", async () => {
    const f = await fixture(),
      r = await release(f),
      c = await requestOfferOtp(r.cap),
      row = (
        await f.db
          .select()
          .from(workflowEvents)
          .where(eq(workflowEvents.aggregateId, c.challengeId))
      )[0];
    await closeCandidateOffer(f.ownerId, f.ownerId, {
      id: f.offerId,
      version: 1,
      reason: "Synthetic owner withdraws this unaccepted offer.",
    });
    await expect(
      deliverApprovedEmail(f.ownerId, { dispatchId: row.metadata.dispatchId })
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await expect(publicOfferEntry(r.cap)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("blocks legacy status and offer-decision endpoints from accepting controlled terms", async () => {
    const f = await fixture();
    await expect(
      f.caller.recruitment.placements.extendOffer({
        placementId: f.placementId,
        annualCompensation: 120000000,
        currency: "INR",
      })
    ).rejects.toThrow(/versioned offer/);
    await expect(
      f.caller.recruitment.placements.transition({
        id: f.placementId,
        state: "offer_issued",
      })
    ).rejects.toThrow(/versioned offer/);
    await release(f);
    await expect(
      f.caller.recruitment.placements.recordOfferDecision({
        placementId: f.placementId,
        decision: "accepted",
        note: "Status must not impersonate candidate acceptance.",
      })
    ).rejects.toThrow();
    await expect(
      f.caller.recruitment.placements.transition({
        id: f.placementId,
        state: "joining_pending",
      })
    ).rejects.toThrow(/email-confirmed/);
  });
  it("honors required conditions, newer blocked evidence and explicit regulated-document provenance", async () => {
    const f = await fixture(),
      d = await f.read();
    await saveOfferDraft(f.ownerId, f.ownerId, {
      ...f.draftInput,
      expectedVersion: 1,
      expectedTermsHash: d.offer.termsHash,
      terms: {
        ...f.terms,
        conditions: [
          {
            id: "work_authority",
            category: "work_authorization",
            label: "Review official work authorization evidence",
            required: true,
          },
        ],
      },
    });
    const s = await session(f);
    await recordCandidateOfferReply(reply(s));
    let p = (
      await f.db
        .select()
        .from(placements)
        .where(eq(placements.id, f.placementId))
    )[0];
    await expect(
      assertCurrentOfferAcceptance(f.db, f.ownerId, p)
    ).rejects.toThrow(/condition/);
    const input = {
      id: f.offerId,
      version: s.view.version,
      termsHash: s.view.termsHash,
      conditionId: "work_authority",
      evidence: "Synthetic official evidence reviewed by owner only.",
    };
    await expect(
      reviewOfferCondition(f.ownerId, f.ownerId, input)
    ).rejects.toThrow(/issuer/);
    await reviewOfferCondition(f.ownerId, f.ownerId, {
      ...input,
      issuer: "Synthetic authority",
      reference: "QA-ONLY",
      validUntil: new Date(Date.now() + 86400000),
    });
    await expect(
      assertCurrentOfferAcceptance(f.db, f.ownerId, p)
    ).resolves.toBeUndefined();
    await reviewOfferCondition(f.ownerId, f.ownerId, {
      ...input,
      state: "blocked",
      evidence: "Synthetic later evidence revocation blocks this condition.",
    });
    await expect(
      assertCurrentOfferAcceptance(f.db, f.ownerId, p)
    ).rejects.toThrow(/condition/);
  });
  it("records an authenticated withdrawal report without declaring legal termination", async () => {
    const f = await fixture(),
      s = await session(f);
    await recordCandidateOfferReply(reply(s));
    expect(
      await reportCandidateOfferWithdrawal({
        ...s.auth,
        acknowledged: true,
        reason: "Synthetic candidate reports withdrawal for owner review.",
      })
    ).toMatchObject({ ownerReviewRequired: true });
    const p = (
      await f.db
        .select()
        .from(placements)
        .where(eq(placements.id, f.placementId))
    )[0];
    expect(p.status).toBe("offer_accepted");
    await expect(
      assertCurrentOfferAcceptance(f.db, f.ownerId, p)
    ).rejects.toThrow(/acceptance/);
  });
  it("prevents unilateral edits/revocation of accepted terms and preserves a valid joining handoff", async () => {
    const f = await fixture(),
      s = await session(f);
    await recordCandidateOfferReply(reply(s));
    await expect(
      closeCandidateOffer(f.ownerId, f.ownerId, {
        id: f.offerId,
        version: 1,
        reason: "An accepted offer cannot be silently withdrawn.",
      })
    ).rejects.toThrow(/unilaterally/);
    await expect(
      saveOfferDraft(f.ownerId, f.ownerId, {
        ...f.draftInput,
        expectedVersion: 1,
        expectedTermsHash: s.view.termsHash,
      })
    ).rejects.toThrow(/immutable/);
    await f.caller.recruitment.placements.transition({
      id: f.placementId,
      state: "joining_pending",
    });
    const a = await f.caller.recruitment.placements.transition({
      id: f.placementId,
      state: "joining_confirmed",
      joiningAt: new Date(Date.now() - 1000),
      joiningEvidence: [
        "Synthetic owner-reviewed joining evidence after email acceptance.",
      ],
    });
    await f.caller.recruitment.approvals.decide({
      id: a.approvalId,
      decision: "approved",
    });
    expect((await f.read()).placementStatus).toBe("joining_confirmed");
  });
  it("cancels offer follow-ups after a response and rejects unshared-link enrollment", async () => {
    const f = await fixture(),
      r = await release(f);
    await expect(
      enrollOfferFollowup(f.ownerId, f.ownerId, f.offerId)
    ).rejects.toThrow(/shared/);
    await recordOfferLinkShared(f.ownerId, f.ownerId, {
      id: f.offerId,
      evidence:
        "Synthetic manual sharing evidence, not actual recipient delivery.",
    });
    const plan = await enrollOfferFollowup(f.ownerId, f.ownerId, f.offerId),
      out = await prepareFollowUp(f.ownerId, {
        planId: plan.id,
        revision: 1,
        stepIndex: 0,
      });
    expect(out.status).toBe("approval_pending");
    await closeCandidateOffer(f.ownerId, f.ownerId, {
      id: f.offerId,
      version: 1,
      reason: "Synthetic close cancels unused reminders.",
    });
    expect(
      (
        await f.db
          .select()
          .from(approvals)
          .where(eq(approvals.id, out.approvalId))
      )[0].status
    ).toBe("cancelled");

    const deadlines = await f.db
      .select()
      .from(automationQueue)
      .where(
        and(
          eq(automationQueue.ownerId, f.ownerId),
          eq(automationQueue.jobType, "offer_deadline")
        )
      );
    expect(deadlines.every((task: any) => task.status === "cancelled")).toBe(
      true
    );
  });
  it("escapes offer pack output and detects tampered stored terms", async () => {
    const f = await fixture(),
      d = await f.read();
    await saveOfferDraft(f.ownerId, f.ownerId, {
      ...f.draftInput,
      expectedVersion: 1,
      expectedTermsHash: d.offer.termsHash,
      terms: {
        ...f.terms,
        roleTitle: "<script>bad()</script>",
        termsText:
          "Synthetic contract text <img src=x onerror=bad()> must remain escaped.",
      },
    });
    const doc = await generateCandidateOfferDocument(f.ownerId, f.offerId);
    expect(doc.html).toContain("&lt;script&gt;");
    expect(doc.html).not.toContain("<script>bad");
    const row = (
      await f.db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.ownerId, f.ownerId),
            eq(workflowEvents.eventType, "offer.version_saved"),
            eq(workflowEvents.revision, 2)
          )
        )
    )[0];
    await f.db
      .update(workflowEvents)
      .set({
        metadata: {
          ...row.metadata,
          terms: { ...row.metadata.terms, annualBaseMinor: 1 },
        },
      })
      .where(eq(workflowEvents.id, row.id));
    await expect(f.read()).rejects.toThrow(/immutable reference/);
  });
  it("expires released offers on the existing managed queue without deciding employment", async () => {
    const f = await fixture();
    await release(f);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 3 * 86400000));
    const outcome = await processOneQueuedJob(f.ownerId);
    expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
    expect((await f.read()).placementStatus).toBe("offer_issued");
    expect((await f.read()).offer.closed.method).toBe("expired");
  });
  it("invalidates public links and queued codes after signing-secret rotation", async () => {
    const f = await fixture(),
      r = await release(f),
      c = await requestOfferOtp(r.cap),
      row = (
        await f.db
          .select()
          .from(workflowEvents)
          .where(eq(workflowEvents.aggregateId, c.challengeId))
      )[0];
    vi.stubEnv(
      "SESSION_SECRET",
      "rotated-synthetic-offer-secret-longer-than-thirty-two-characters"
    );
    await expect(publicOfferEntry(r.cap)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      deliverApprovedEmail(f.ownerId, { dispatchId: row.metadata.dispatchId })
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects cross-owner detail access and recipient changes after release", async () => {
    const f = await fixture(),
      r = await release(f),
      other = await fixture();
    await expect(
      offerOwnerDetail(other.ownerId, f.placementId)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.db
      .update(candidates)
      .set({ email: "changed@example.test" })
      .where(eq(candidates.id, f.candidateId));
    await expect(publicOfferEntry(r.cap)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("redacts private offer, OTP/session and compensation evidence during candidate erasure", async () => {
    const f = await fixture(),
      s = await session(f);
    await recordCandidateOfferReply(reply(s));
    const requestId = dbModule.createId("rights_");
    await f.db.insert(rightsRequests).values({
      id: requestId,
      ownerId: f.ownerId,
      candidateId: f.candidateId,
      requestType: "deletion",
      status: "received",
      details: "Synthetic offer privacy erasure",
    });
    await f.caller.recruitment.candidateWorkflows.privacy.fulfillDeletion({
      requestId,
      resolutionNote:
        "Erase synthetic offer response and email verification evidence.",
    });
    const rows = await f.db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.ownerId, f.ownerId));
    expect(
      rows
        .filter((e: any) => e.eventType.startsWith("offer."))
        .every((e: any) => e.metadata.redacted)
    ).toBe(true);
    const mail = await f.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.ownerId, f.ownerId),
          eq(approvals.actionType, "email_send")
        )
      );
    expect(mail.some((a: any) => a.payload?.offerScope)).toBe(false);
    await expect(readAuthenticatedOffer(s.auth)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")(
    "serializes duplicate verification requests and conflicting accept/decline replies",
    async () => {
      const f = await fixture(),
        r = await release(f),
        [a, b] = await Promise.all([
          requestOfferOtp(r.cap),
          requestOfferOtp(r.cap),
        ]);
      expect(a.challengeId).toBe(b.challengeId);
      const c = (
        await f.db
          .select()
          .from(workflowEvents)
          .where(eq(workflowEvents.aggregateId, a.challengeId))
      )[0];
      await deliverApprovedEmail(f.ownerId, {
        dispatchId: c.metadata.dispatchId,
      });
      const code = /code is (\d{6})/.exec(send.mock.calls.at(-1)![0].text)![1],
        verified = await verifyOfferOtp({
          ...r.cap,
          challengeId: a.challengeId,
          code,
        }),
        auth = {
          id: f.offerId,
          sessionId: verified.sessionId!,
          sessionToken: verified.sessionToken!,
        },
        view = await readAuthenticatedOffer(auth),
        s = { auth, view };
      const results = await Promise.allSettled([
        recordCandidateOfferReply(reply(s)),
        recordCandidateOfferReply(reply(s, { decision: "decline" })),
      ]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(
        await f.db
          .select()
          .from(workflowEvents)
          .where(
            and(
              eq(workflowEvents.ownerId, f.ownerId),
              eq(workflowEvents.eventType, "offer.response_recorded")
            )
          )
      ).toHaveLength(1);
    }
  );
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")(
    "rolls back accepted response, compensation and typed consent if audit fails",
    async () => {
      const f = await fixture(),
        s = await session(f),
        before = (
          await f.db
            .select()
            .from(placements)
            .where(eq(placements.id, f.placementId))
        )[0].annualCompensation,
        original = dbModule.recordAudit;
      vi.spyOn(dbModule, "recordAudit").mockImplementation(
        async (input, tx) => {
          if (input.action === "offer.candidate_response_recorded")
            throw Error("Synthetic response audit failure");
          return original(input, tx);
        }
      );
      await expect(recordCandidateOfferReply(reply(s))).rejects.toThrow(
        /audit failure/
      );
      expect((await f.read()).offer.accepted).toBe(null);
      expect(
        (
          await f.db
            .select()
            .from(placements)
            .where(eq(placements.id, f.placementId))
        )[0].annualCompensation
      ).toBe(before);
      expect(
        await f.db
          .select()
          .from(consents)
          .where(
            and(
              eq(consents.ownerId, f.ownerId),
              eq(consents.consentType, "offer_response")
            )
          )
      ).toHaveLength(0);
    }
  );
});
