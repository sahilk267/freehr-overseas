import { canonicalHash } from "./canonicalHash";
import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, like } from "drizzle-orm";
import { z } from "zod";
import {
  approvals,
  candidates,
  contacts,
  consents,
  conversations,
  emailDispatches,
  emailIdentities,
  jobs,
  messages,
  shortlists,
  workflowEvents,
  workspaceSettings,
} from "../../drizzle/schema";
import {
  prepareSubmissionInput,
  submissionFeedback,
  submissionSession,
} from "../../shared/submission";
import { createId, hashContactValue, recordAudit, requireDb } from "../db";
import { withWorkspaceTransaction } from "./database";
import {
  appendWorkflowEvent,
  cancelUnusedEmailDispatch,
  workflowHash,
} from "./workflowStore";
import {
  enqueueEmailDispatch,
  enrollFollowUpInTransaction,
  stopRelatedFollowUps,
} from "./followups";
import { isSenderIdentityConfigured } from "./hostingerMail";
import { emailContentHash } from "./emailAuthorization";
import { localClock } from "./workflowTiming";
import {
  authenticateSubmission,
  currentSubmission,
  requireSubmissionApproval,
  secureSubmissionEqual,
  submissionDenied,
  submissionEvent,
  submissionRecord,
  submissionSources,
} from "./submissionState";
import {
  SUBMISSION_LINK_MARKER,
  SUBMISSION_OTP_MARKER,
  submissionCodeHash,
  submissionHash,
  submissionKeyId,
  submissionOrigin,
  submissionSecret,
  type SubmissionMailScope,
} from "./submissionMailScope";
const fail = (message: string) =>
  new TRPCError({ code: "PRECONDITION_FAILED", message });
export async function stopSubmissionWork(
  tx: any,
  ownerId: number,
  id: string,
  reason: string
) {
  await stopRelatedFollowUps(
    tx,
    ownerId,
    { resourceType: "client_submission", resourceId: id },
    reason,
    "cancelled"
  );
  const mails = await tx
    .select()
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.ownerId, ownerId),
        eq(workflowEvents.eventType, "submission.mail_prepared"),
        eq(workflowEvents.aggregateId, id)
      )
    );
  for (const e of mails) {
    const d = (
      await tx
        .select()
        .from(emailDispatches)
        .where(
          and(
            eq(emailDispatches.ownerId, ownerId),
            eq(emailDispatches.id, e.metadata.dispatchId)
          )
        )
        .limit(1)
    )[0];
    if (d) await cancelUnusedEmailDispatch(tx, ownerId, d, reason);
  }
}
export async function revokeSubmissionInTransaction(
  tx: any,
  ownerId: number,
  id: string,
  reason: string
) {
  const a = await submissionEvent(tx, ownerId, "authority", id),
    v = await submissionEvent(tx, ownerId, "pack", id);
  if (a?.metadata.tokenHash)
    await appendWorkflowEvent(
      tx,
      ownerId,
      "submission.authority",
      id,
      a.revision + 1,
      {
        candidateId: v?.metadata.candidateId,
        version: v?.revision,
        tokenHash: "",
        revoked: true,
      }
    );
  await stopSubmissionWork(tx, ownerId, id, reason);
}
export async function prepareSubmission(
  ownerId: number,
  actorId: number,
  raw: z.input<typeof prepareSubmissionInput>
) {
  const input = prepareSubmissionInput.parse(raw);
  return withWorkspaceTransaction(ownerId, async tx => {
    const j = (
      await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.ownerId, ownerId), eq(jobs.id, input.jobId)))
        .limit(1)
    )[0];
    if (!j)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Owned role was not found.",
      });
    let s = (
      await tx
        .select()
        .from(shortlists)
        .where(
          and(
            eq(shortlists.ownerId, ownerId),
            eq(shortlists.candidateId, input.candidateId),
            eq(shortlists.jobId, input.jobId)
          )
        )
        .limit(1)
    )[0];
    const source = await submissionSources(
      tx,
      ownerId,
      s ?? {
        candidateId: input.candidateId,
        jobId: j.id,
        companyId: j.companyId,
      },
      input.contactId,
      input.senderIdentityId
    );
    if (!isSenderIdentityConfigured(source.sender))
      throw fail(
        "Configure the client mailbox before authorizing verification emails."
      );
    const key = workflowHash([ownerId, input.requestKey]),
      requestHash = workflowHash({
        ...input,
        fields: [...new Set(input.fields)].sort(),
        sourceHash: source.sourceHash,
      }),
      identity = await submissionEvent(tx, ownerId, "identity", key);
    if (identity) {
      if (identity.metadata.requestHash !== requestHash)
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Submission request key already belongs to a different profile or source.",
        });
      return {
        id: String(identity.metadata.shortlistId),
        version: Number(identity.metadata.version),
        approvalId: String(identity.metadata.approvalId),
        alreadyPrepared: true,
      };
    }
    const previous = s
      ? await submissionEvent(tx, ownerId, "pack", s.id)
      : null;
    if ((previous?.revision ?? 0) !== input.expectedVersion)
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Submission version changed. Reload before preparing a new pack.",
      });
    const selected = [...new Set(input.fields)],
      scope = source.consent.dataScope as any;
    if (
      Array.isArray(scope?.fields) &&
      selected.some(f => !scope.fields.includes(f))
    )
      throw fail(
        "Selected profile fields exceed the recorded sharing-consent scope."
      );
    const fields: any = {};
    for (const f of selected) {
      const value = source.d.fields?.[f];
      if (value !== undefined) fields[f] = value;
    }
    if (!Object.keys(fields).length)
      throw fail(
        "Selected fields have no current structured candidate evidence."
      );
    const sensitive =
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?\d[\s().-]*){7,}/i;
    for (const value of Object.values(fields).flat())
      if (
        typeof value === "string" &&
        (sensitive.test(value) ||
          (source.candidate.fullName?.length > 2 &&
            value
              .toLowerCase()
              .includes(source.candidate.fullName.toLowerCase())))
      )
        throw fail(
          "Remove contact details from shared profile fields; direct contact information is excluded from this pack."
        );
    if (!s) {
      s = {
        id: createId("shl_"),
        ownerId,
        companyId: j.companyId,
        jobId: j.id,
        candidateId: input.candidateId,
        status: "prepared",
        consentId: source.consent.id,
      };
      await tx.insert(shortlists).values(s);
    }
    await revokeSubmissionInTransaction(
      tx,
      ownerId,
      s.id,
      "A new immutable submission version replaced earlier access."
    );
    const pending = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.ownerId, ownerId),
          eq(approvals.resourceId, s.id),
          eq(approvals.actionType, "candidate_share"),
          eq(approvals.status, "pending")
        )
      );
    for (const a of pending)
      await tx
        .update(approvals)
        .set({ status: "cancelled" })
        .where(eq(approvals.id, a.id));
    const version = (previous?.revision ?? 0) + 1,
      approvalId = createId("apr_"),
      expiresAt = new Date(
        Math.min(
          Date.now() + input.expiresHours * 3600000,
          new Date(source.d.fields!.validUntil).getTime(),
          source.consent.expiresAt
            ? new Date(source.consent.expiresAt).getTime()
            : Infinity
        )
      ),
      pack = {
        profileLabel: "Candidate " + s.id.slice(-6),
        roleTitle: j.title,
        fields,
        observedAt: new Date(source.d.fields!.observedAt).toISOString(),
        evidenceValidUntil: new Date(source.d.fields!.validUntil).toISOString(),
        evidenceSource: source.d.source,
        independentlyVerified: false,
        candidateApprovedExactPack: false,
        limitations: [
          "Recorded structured evidence; no independent credential verification.",
          "Sharing consent is recorded for this job and client; exact profile approval and candidate identity are not independently verified.",
          "Unknown or omitted fields are not negative evidence. No CV, direct contact details or internal notes are included.",
        ],
      },
      packHash = canonicalHash({ id: s.id, version, pack });
    await appendWorkflowEvent(tx, ownerId, "submission.pack", s.id, version, {
      candidateId: s.candidateId,
      jobId: j.id,
      companyId: j.companyId,
      contactId: input.contactId,
      senderIdentityId: input.senderIdentityId,
      recipientHash: hashContactValue(source.contact.email),
      sourceHash: source.sourceHash,
      pack,
      packHash,
      expiresAt: expiresAt.toISOString(),
      approvalId,
      transactionalOtp: true,
    });
    await tx.insert(approvals).values({
      id: approvalId,
      ownerId,
      requestedBy: "user",
      actionType: "candidate_share",
      resourceType: "shortlist",
      resourceId: s.id,
      status: "pending",
      reason:
        "Review the exact minimized profile, recipient, sharing consent, expiry and bounded transactional email-code authority.",
      payload: {
        candidateId: s.candidateId,
        jobId: j.id,
        companyId: j.companyId,
        submissionVersion: version,
        packHash,
        sourceHash: source.sourceHash,
        transactionalOtp: true,
      },
    });
    await tx
      .update(shortlists)
      .set({
        status: "approval_pending",
        consentId: source.consent.id,
        sharedAt: null,
        viewedAt: null,
        shareExpiresAt: null,
      })
      .where(eq(shortlists.id, s.id));
    await appendWorkflowEvent(tx, ownerId, "submission.identity", key, 1, {
      candidateId: s.candidateId,
      shortlistId: s.id,
      version,
      approvalId,
      requestHash,
    });
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "submission.prepared",
        resourceType: "shortlist",
        resourceId: s.id,
        metadata: { version, packHash, approvalId },
      },
      tx
    );
    return { id: String(s.id), version, approvalId, alreadyPrepared: false };
  });
}
export async function releaseSubmission(
  ownerId: number,
  actorId: number,
  id: string,
  version: number
) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const r = await currentSubmission(tx, ownerId, id, new Date(), false);
    if (r.v.revision !== version)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Review the current submission version.",
      });
    await requireSubmissionApproval(tx, ownerId, r);
    let a = await submissionEvent(tx, ownerId, "authority", id),
      release = await submissionEvent(tx, ownerId, "released", id);
    if (release?.revision === version) {
      if (!a?.metadata.tokenHash || a.metadata.version !== version)
        throw fail(
          "Revoked access cannot be restored. Prepare a newly approved version."
        );
      const scope = {
        ...a.metadata,
        id,
        version,
        packHash: r.v.metadata.packHash,
        authorityRevision: a.revision,
        kind: "submission_link",
      } as SubmissionMailScope;
      return {
        id,
        version,
        fragment: id + "." + submissionSecret(scope),
        alreadyReleased: true,
      };
    }
    if (r.s.status !== "release_ready")
      throw fail(
        "A completed exact-pack approval is required before access release."
      );
    const existing = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.ownerId, ownerId),
          eq(conversations.contactId, r.source.contact.id),
          eq(conversations.jobId, r.s.jobId),
          eq(conversations.companyId, r.s.companyId),
          eq(conversations.channel, "email")
        )
      );
    let conversation = existing.find(
      (c: any) => c.status === "active" && !c.candidateId
    );
    if (!conversation) {
      conversation = {
        id: createId("cnv_"),
        ownerId,
        contactId: r.source.contact.id,
        candidateId: null,
        jobId: r.s.jobId,
        companyId: r.s.companyId,
        channel: "email",
        status: "active",
      };
      await tx.insert(conversations).values(conversation);
    }
    const scope: SubmissionMailScope = {
        kind: "submission_link",
        id,
        version,
        packHash: r.v.metadata.packHash,
        authorityRevision: (a?.revision ?? 0) + 1,
        recipientHash: r.v.metadata.recipientHash,
        nonce: randomBytes(24).toString("base64url"),
        keyId: submissionKeyId(),
        origin: submissionOrigin(),
      },
      token = submissionSecret(scope);
    await appendWorkflowEvent(
      tx,
      ownerId,
      "submission.authority",
      id,
      scope.authorityRevision,
      {
        ...scope,
        candidateId: r.s.candidateId,
        tokenHash: submissionHash(token),
      }
    );
    await appendWorkflowEvent(tx, ownerId, "submission.released", id, version, {
      candidateId: r.s.candidateId,
      jobId: r.s.jobId,
      companyId: r.s.companyId,
      contactId: r.source.contact.id,
      conversationId: conversation.id,
      packHash: r.v.metadata.packHash,
      recipientHash: scope.recipientHash,
      accessReleased: true,
      recipientDeliveryVerified: false,
      releasedBy: actorId,
    });
    await tx
      .update(shortlists)
      .set({
        status: "shared",
        sharedAt: new Date(),
        shareExpiresAt: new Date(r.v.metadata.expiresAt),
      })
      .where(eq(shortlists.id, id));
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "submission.access_released",
        resourceType: "shortlist",
        resourceId: id,
        metadata: {
          version,
          packHash: r.v.metadata.packHash,
          recipientDeliveryVerified: false,
        },
      },
      tx
    );
    return { id, version, fragment: id + "." + token, alreadyReleased: false };
  });
}
async function createSubmissionMail(
  tx: any,
  ownerId: number,
  r: any,
  scope: SubmissionMailScope,
  automatic = false
) {
  const subject = automatic
      ? "Client review verification code"
      : "Private candidate profile for review",
    body = automatic
      ? SUBMISSION_OTP_MARKER
      : "Please review the exact profile for " +
        r.v.metadata.pack.roleTitle +
        ".\n\n" +
        SUBMISSION_LINK_MARKER +
        "\n\nThis link is private and requires the assigned recipient’s email code. It expires " +
        r.v.metadata.expiresAt +
        ". Feedback does not confirm an interview or hiring decision. Reply STOP to stop these emails.",
    recipient = r.source.contact.email.trim().toLowerCase(),
    sender = r.source.sender,
    messageId = createId("msg_"),
    approvalId = createId("apr_"),
    dispatchId = createId("dsp_"),
    payload = {
      senderIdentityId: sender.id,
      senderAddress: sender.email,
      senderPurpose: sender.purpose,
      recipient,
      submissionScope: scope,
      contentHash: emailContentHash({
        senderIdentityId: sender.id,
        recipient,
        subject,
        body,
        submissionScope: scope,
      }),
    };
  await tx.insert(messages).values({
    id: messageId,
    ownerId,
    conversationId: r.release.metadata.conversationId,
    direction: "outbound",
    status: automatic ? "authorized" : "approval_pending",
    subject,
    body,
    aiGenerated: false,
    idempotencyKey: "email:" + messageId,
  });
  await tx.insert(approvals).values({
    id: approvalId,
    ownerId,
    requestedBy: automatic ? "system" : "user",
    actionType: "email_send",
    resourceType: "message",
    resourceId: messageId,
    status: automatic ? "approved" : "pending",
    actionedAt: null,
    reason: automatic
      ? "Bounded transactional email verification for the exact owner-approved submission and recipient."
      : "Review this exact private profile invitation; release is distinct from delivery.",
    payload,
    ...(automatic
      ? {
          decisionSource: "policy",
          decidedById: ownerId,
          decidedAt: new Date(),
        }
      : {}),
  });
  await tx.insert(emailDispatches).values({
    id: dispatchId,
    ownerId,
    messageId,
    approvalId,
    recipientHash: scope.recipientHash,
    status: "queued",
    scheduledAt: new Date(),
  });
  await appendWorkflowEvent(
    tx,
    ownerId,
    "submission.mail_prepared",
    r.s.id,
    r.v.revision,
    {
      candidateId: r.s.candidateId,
      messageId,
      approvalId,
      dispatchId,
      kind: scope.kind,
      challengeId: scope.challengeId ?? null,
    },
    messageId
  );
  if (automatic)
    await enqueueEmailDispatch(tx, ownerId, dispatchId, new Date());
  return {
    messageId,
    approvalId,
    dispatchId,
    contentHash: payload.contentHash,
  };
}
export async function prepareSubmissionMail(ownerId: number, id: string) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const r = await currentSubmission(tx, ownerId, id),
      previous = await tx
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.ownerId, ownerId),
            eq(workflowEvents.eventType, "submission.mail_prepared"),
            eq(workflowEvents.aggregateId, id)
          )
        );
    for (const e of previous.filter(
      (e: any) =>
        e.revision === r.v.revision && e.metadata.kind === "submission_link"
    )) {
      const d = (
        await tx
          .select()
          .from(emailDispatches)
          .where(eq(emailDispatches.id, e.metadata.dispatchId))
          .limit(1)
      )[0];
      if (d && !["cancelled", "failed"].includes(d.status))
        return { ...e.metadata, alreadyPrepared: true };
    }
    return createSubmissionMail(tx, ownerId, r, {
      ...r.authority.metadata,
      id,
      version: r.v.revision,
      authorityRevision: r.authority.revision,
      kind: "submission_link",
    });
  });
}
export async function publicSubmissionEntry(input: {
  id: string;
  token: string;
}) {
  const hint = await authenticateSubmission(input.id, input.token);
  return withWorkspaceTransaction(hint.ownerId, async tx => {
    await authenticateSubmission(input.id, input.token, tx, hint.ownerId);
    const r = await currentSubmission(tx, hint.ownerId, input.id);
    const parts = r.source.contact.email.split("@");
    return {
      id: input.id,
      version: r.v.revision,
      maskedEmail: parts[0].slice(0, 1) + "***@" + parts[1],
      expiresAt: r.v.metadata.expiresAt,
      noticeVersion: "client-submission-v1" as const,
    };
  });
}
export async function requestSubmissionOtp(input: {
  id: string;
  token: string;
  resend?: boolean;
}) {
  const hint = await authenticateSubmission(input.id, input.token);
  return withWorkspaceTransaction(hint.ownerId, async tx => {
    await authenticateSubmission(input.id, input.token, tx, hint.ownerId);
    const r = await currentSubmission(tx, hint.ownerId, input.id),
      workspace = (
        await tx
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.ownerId, hint.ownerId))
          .limit(1)
      )[0],
      now = new Date();
    if (
      !workspace.backgroundEnabled ||
      workspace.emergencyStop ||
      !r.v.metadata.transactionalOtp ||
      !isSenderIdentityConfigured(r.source.sender)
    )
      throw fail(
        "Client verification email is unavailable. Contact the recruiter."
      );
    const previousCurrent = await submissionEvent(
        tx,
        hint.ownerId,
        "otp_current",
        input.id
      ),
      previous = previousCurrent
        ? await submissionEvent(
            tx,
            hint.ownerId,
            "otp",
            previousCurrent.metadata.challengeId
          )
        : null;
    if (
      previous &&
      previous.metadata.authorityRevision === r.authority.revision &&
      new Date(previous.metadata.expiresAt) > now &&
      (!input.resend ||
        now.getTime() - new Date(previous.metadata.createdAt).getTime() < 60000)
    )
      return {
        challengeId: previous.aggregateId,
        expiresAt: previous.metadata.expiresAt,
        alreadyRequested: true,
      };
    const requests = await tx
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.ownerId, hint.ownerId),
            eq(workflowEvents.eventType, "submission.otp")
          )
        ),
      day = localClock(now, workspace.businessTimezone).day,
      recipientHash = r.v.metadata.recipientHash,
      recents = requests.filter(
        (e: any) =>
          e.metadata.recipientHash === recipientHash &&
          localClock(new Date(e.metadata.createdAt), workspace.businessTimezone)
            .day === day
      );
    if (
      recents.length >= 3 ||
      recents.some(
        (e: any) =>
          now.getTime() - new Date(e.metadata.createdAt).getTime() < 60000
      )
    )
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message:
          "Verification is limited to three codes per recipient/day with one minute between requests.",
      });
    const dispatches = await tx
      .select()
      .from(emailDispatches)
      .where(eq(emailDispatches.ownerId, hint.ownerId));
    if (
      !Number.isFinite(workspace.dailyOutboundLimit) ||
      dispatches.filter(
        (d: any) =>
          d.claimedAt &&
          localClock(new Date(d.claimedAt), workspace.businessTimezone).day ===
            day
      ).length >= workspace.dailyOutboundLimit
    )
      throw fail("The current agency mail budget is unavailable.");
    if (previous) {
      const d = (
        await tx
          .select()
          .from(emailDispatches)
          .where(eq(emailDispatches.id, previous.metadata.dispatchId))
          .limit(1)
      )[0];
      if (d)
        await cancelUnusedEmailDispatch(
          tx,
          hint.ownerId,
          d,
          "A newer verification code replaced this request."
        );
    }
    const challengeId = createId("sot_"),
      expiresAt = new Date(
        Math.min(
          now.getTime() + 10 * 60000,
          new Date(r.v.metadata.expiresAt).getTime()
        )
      ),
      scope: SubmissionMailScope = {
        ...r.authority.metadata,
        id: input.id,
        version: r.v.revision,
        authorityRevision: r.authority.revision,
        kind: "submission_otp",
        challengeId,
        nonce: randomBytes(24).toString("base64url"),
        transactionalOtp: true,
      },
      mail = await createSubmissionMail(tx, hint.ownerId, r, scope, true);
    await appendWorkflowEvent(
      tx,
      hint.ownerId,
      "submission.otp",
      challengeId,
      1,
      {
        candidateId: r.s.candidateId,
        shortlistId: r.s.id,
        version: r.v.revision,
        authorityRevision: r.authority.revision,
        recipientHash,
        codeHash: submissionCodeHash(
          challengeId,
          submissionSecret(scope, true)
        ),
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        dispatchId: mail.dispatchId,
        contentHash: mail.contentHash,
      }
    );
    await appendWorkflowEvent(
      tx,
      hint.ownerId,
      "submission.otp_current",
      r.s.id,
      (previousCurrent?.revision ?? 0) + 1,
      { candidateId: r.s.candidateId, challengeId }
    );
    return {
      challengeId,
      expiresAt: expiresAt.toISOString(),
      alreadyRequested: false,
    };
  });
}
export async function verifySubmissionOtp(input: {
  id: string;
  token: string;
  challengeId: string;
  code: string;
}) {
  const hint = await authenticateSubmission(input.id, input.token),
    result = await withWorkspaceTransaction(hint.ownerId, async tx => {
      await authenticateSubmission(input.id, input.token, tx, hint.ownerId);
      const r = await currentSubmission(tx, hint.ownerId, input.id),
        c = await submissionEvent(tx, hint.ownerId, "otp", input.challengeId),
        current = await submissionEvent(
          tx,
          hint.ownerId,
          "otp_current",
          input.id
        ),
        attempt = await submissionEvent(
          tx,
          hint.ownerId,
          "otp_attempt",
          input.challengeId
        );
      if (
        !c ||
        current?.metadata.challengeId !== input.challengeId ||
        c.metadata.shortlistId !== input.id ||
        c.metadata.authorityRevision !== r.authority.revision ||
        new Date(c.metadata.expiresAt) <= new Date() ||
        (attempt?.metadata.failedCount ?? 0) >= 5 ||
        (await submissionEvent(
          tx,
          hint.ownerId,
          "otp_consumed",
          input.challengeId
        ))
      )
        return null;
      const dispatch = (
        await tx
          .select()
          .from(emailDispatches)
          .where(
            and(
              eq(emailDispatches.ownerId, hint.ownerId),
              eq(emailDispatches.id, c.metadata.dispatchId)
            )
          )
          .limit(1)
      )[0];
      if (dispatch?.status !== "sent" || !dispatch.claimedAt) return null;
      if (
        !/^\d{6}$/.test(input.code) ||
        !secureSubmissionEqual(
          c.metadata.codeHash,
          submissionCodeHash(input.challengeId, input.code)
        )
      ) {
        await appendWorkflowEvent(
          tx,
          hint.ownerId,
          "submission.otp_attempt",
          input.challengeId,
          (attempt?.revision ?? 0) + 1,
          {
            candidateId: r.s.candidateId,
            failedCount: (attempt?.metadata.failedCount ?? 0) + 1,
          }
        );
        return null;
      }
      const sessionId = createId("srs_"),
        sessionToken = randomBytes(32).toString("base64url"),
        expiresAt = new Date(
          Math.min(
            Date.now() + 15 * 60000,
            new Date(r.v.metadata.expiresAt).getTime()
          )
        );
      await appendWorkflowEvent(
        tx,
        hint.ownerId,
        "submission.session",
        sessionId,
        1,
        {
          candidateId: r.s.candidateId,
          shortlistId: input.id,
          version: r.v.revision,
          authorityRevision: r.authority.revision,
          recipientHash: r.v.metadata.recipientHash,
          tokenHash: submissionHash(sessionToken),
          expiresAt: expiresAt.toISOString(),
          emailPossessionVerified: true,
          clientAuthorityVerified: false,
        }
      );
      await appendWorkflowEvent(
        tx,
        hint.ownerId,
        "submission.otp_consumed",
        input.challengeId,
        1,
        { candidateId: r.s.candidateId, sessionId }
      );
      return { sessionId, sessionToken, expiresAt: expiresAt.toISOString() };
    });
  if (!result)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The verification code is invalid, expired, undelivered or already used.",
    });
  return result;
}
async function sessionContext(
  tx: any,
  ownerId: number,
  input: z.infer<typeof submissionSession>
) {
  await authenticateSubmission(input.id, input.token, tx, ownerId);
  const r = await currentSubmission(tx, ownerId, input.id),
    session = await submissionEvent(tx, ownerId, "session", input.sessionId);
  if (
    !session ||
    !secureSubmissionEqual(
      session.metadata.tokenHash,
      submissionHash(input.sessionToken)
    ) ||
    session.metadata.shortlistId !== input.id ||
    session.metadata.version !== r.v.revision ||
    session.metadata.authorityRevision !== r.authority.revision ||
    session.metadata.recipientHash !== r.v.metadata.recipientHash ||
    new Date(session.metadata.expiresAt) <= new Date()
  )
    throw submissionDenied();
  return r;
}
export async function readSubmission(raw: z.input<typeof submissionSession>) {
  const input = submissionSession.parse(raw),
    hint = await authenticateSubmission(input.id, input.token);
  return withWorkspaceTransaction(hint.ownerId, async tx => {
    const r = await sessionContext(tx, hint.ownerId, input),
      view = await submissionEvent(tx, hint.ownerId, "viewed", input.id);
    if (view?.revision !== r.v.revision) {
      await appendWorkflowEvent(
        tx,
        hint.ownerId,
        "submission.viewed",
        input.id,
        r.v.revision,
        {
          candidateId: r.s.candidateId,
          jobId: r.s.jobId,
          companyId: r.s.companyId,
          recipientHash: r.v.metadata.recipientHash,
          sessionId: input.sessionId,
          emailPossessionVerified: true,
          clientAuthorityVerified: false,
        }
      );
      await tx
        .update(shortlists)
        .set({ status: "viewed", viewedAt: new Date() })
        .where(eq(shortlists.id, input.id));
      await stopRelatedFollowUps(
        tx,
        hint.ownerId,
        { resourceType: "client_submission", resourceId: input.id },
        "The exact profile was opened with email-possession verification.",
        "completed"
      );
    }
    const response = await submissionEvent(
      tx,
      hint.ownerId,
      "feedback",
      input.id
    );
    return {
      id: input.id,
      version: r.v.revision,
      pack: r.v.metadata.pack,
      expiresAt: r.v.metadata.expiresAt,
      emailPossessionVerified: true as const,
      clientAuthorityVerified: false as const,
      revision: response?.revision ?? 0,
      feedback:
        response?.metadata.version === r.v.revision &&
        response.metadata.recipientHash === r.v.metadata.recipientHash
          ? response.metadata
          : null,
      noticeVersion: "client-submission-v1" as const,
    };
  });
}
export async function respondSubmission(
  raw: z.input<typeof submissionFeedback>
) {
  const input = submissionFeedback.parse(raw),
    hint = await authenticateSubmission(input.id, input.token);
  return withWorkspaceTransaction(hint.ownerId, async tx => {
    const r = await sessionContext(tx, hint.ownerId, input),
      view = await submissionEvent(tx, hint.ownerId, "viewed", input.id);
    if (view?.revision !== r.v.revision)
      throw fail("Open the exact profile before submitting feedback.");
    const key = workflowHash([input.id, input.requestKey]),
      hash = workflowHash({
        version: r.v.revision,
        outcome: input.outcome,
        note: input.note,
        expectedRevision: input.expectedRevision,
        noticeVersion: input.noticeVersion,
      }),
      identity = await submissionEvent(
        tx,
        hint.ownerId,
        "feedback_identity",
        key
      );
    if (identity) {
      if (identity.metadata.requestHash !== hash)
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Feedback request key was already used for different content.",
        });
      return {
        revision: Number(identity.metadata.revision),
        alreadySaved: true,
      };
    }
    const previous = await submissionEvent(
      tx,
      hint.ownerId,
      "feedback",
      input.id
    );
    if ((previous?.revision ?? 0) !== input.expectedRevision)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Feedback changed. Reload before correcting it.",
      });
    const revision = input.expectedRevision + 1;
    await appendWorkflowEvent(
      tx,
      hint.ownerId,
      "submission.feedback",
      input.id,
      revision,
      {
        candidateId: r.s.candidateId,
        jobId: r.s.jobId,
        companyId: r.s.companyId,
        version: r.v.revision,
        packHash: r.v.metadata.packHash,
        recipientHash: r.v.metadata.recipientHash,
        outcome: input.outcome,
        note: input.note,
        sessionId: input.sessionId,
        emailPossessionVerified: true,
        clientAuthorityVerified: false,
        noticeVersion: input.noticeVersion,
        receivedAt: new Date().toISOString(),
      }
    );
    await appendWorkflowEvent(
      tx,
      hint.ownerId,
      "submission.feedback_identity",
      key,
      1,
      { candidateId: r.s.candidateId, revision, requestHash: hash }
    );
    await stopRelatedFollowUps(
      tx,
      hint.ownerId,
      { resourceType: "client_submission", resourceId: input.id },
      "Client feedback was recorded for owner review.",
      "completed"
    );
    await recordAudit(
      {
        ownerId: hint.ownerId,
        actorType: "provider",
        actorId: input.sessionId,
        action: "submission.feedback_received",
        resourceType: "shortlist",
        resourceId: input.id,
        metadata: {
          version: r.v.revision,
          revision,
          emailPossessionVerified: true,
          clientAuthorityVerified: false,
        },
      },
      tx
    );
    return { revision, alreadySaved: false };
  });
}
export async function revokeSubmission(
  ownerId: number,
  actorId: number,
  id: string
) {
  return withWorkspaceTransaction(ownerId, async tx => {
    await submissionRecord(tx, ownerId, id);
    await revokeSubmissionInTransaction(
      tx,
      ownerId,
      id,
      "Owner revoked the private client review."
    );
    await tx
      .update(shortlists)
      .set({ status: "withdrawn" })
      .where(eq(shortlists.id, id));
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "submission.revoked",
        resourceType: "shortlist",
        resourceId: id,
      },
      tx
    );
    return { success: true };
  });
}
async function submissionDeliveries(
  tx: any,
  ownerId: number,
  id: string,
  version: number
) {
  const mails = await tx
    .select()
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.ownerId, ownerId),
        eq(workflowEvents.aggregateId, id),
        eq(workflowEvents.eventType, "submission.mail_prepared")
      )
    )
    .orderBy(desc(workflowEvents.createdAt), desc(workflowEvents.id))
    .limit(101);
  const rows = [];
  for (const e of mails.filter((e: any) => e.revision === version)) {
    const d = (
      await tx
        .select()
        .from(emailDispatches)
        .where(
          and(
            eq(emailDispatches.ownerId, ownerId),
            eq(emailDispatches.id, e.metadata.dispatchId)
          )
        )
        .limit(1)
    )[0];
    if (d)
      rows.push({
        dispatchId: d.id,
        messageId: d.messageId,
        approvalId: d.approvalId,
        kind: e.metadata.kind,
        status: d.status,
        providerAccepted: d.status === "sent",
        recipientDeliveryVerified: false,
        claimedAt: d.claimedAt ?? null,
      });
  }
  return rows;
}
export async function submissionDetail(ownerId: number, id: string) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const r = await submissionRecord(tx, ownerId, id),
      history = await tx
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.ownerId, ownerId),
            eq(workflowEvents.aggregateId, id),
            eq(workflowEvents.eventType, "submission.feedback")
          )
        )
        .orderBy(desc(workflowEvents.revision))
        .limit(51),
      approval = (
        await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.ownerId, ownerId),
              eq(approvals.id, r.v.metadata.approvalId)
            )
          )
          .limit(1)
      )[0];
    let current = false,
      sourceCurrent = false;
    try {
      await currentSubmission(tx, ownerId, id, new Date(), false);
      sourceCurrent = true;
    } catch (error) {
      if (!(error instanceof TRPCError)) throw error;
    }
    try {
      await currentSubmission(tx, ownerId, id);
      current = true;
    } catch (error) {
      if (!(error instanceof TRPCError)) throw error;
    }
    const contact = (
      await tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.ownerId, ownerId),
            eq(contacts.id, r.v.metadata.contactId)
          )
        )
        .limit(1)
    )[0];
    const sender = (
      await tx
        .select()
        .from(emailIdentities)
        .where(
          and(
            eq(emailIdentities.ownerId, ownerId),
            eq(emailIdentities.id, r.v.metadata.senderIdentityId)
          )
        )
        .limit(1)
    )[0];
    const sharingConsent = (
      await tx
        .select()
        .from(consents)
        .where(
          and(
            eq(consents.ownerId, ownerId),
            eq(consents.id, r.s.consentId ?? "")
          )
        )
        .limit(1)
    )[0];
    return {
      id,
      shortlist: r.s,
      version: r.v.revision,
      pack: r.v.metadata.pack,
      packHash: r.v.metadata.packHash,
      expiresAt: r.v.metadata.expiresAt,
      contactId: r.v.metadata.contactId,
      approvalId: r.v.metadata.approvalId,
      approvalStatus: approval?.status ?? "missing",
      accessCurrent: current,
      sourceCurrent,
      recipient: {
        contactId: r.v.metadata.contactId,
        name: contact?.name ?? null,
        email: contact?.email ?? null,
        matchesPreparedHash: Boolean(
          contact?.email &&
            hashContactValue(contact.email) === r.v.metadata.recipientHash
        ),
      },
      sender: {
        id: r.v.metadata.senderIdentityId,
        email: sender?.email ?? null,
        purpose: sender?.purpose ?? null,
      },
      consent: {
        id: r.s.consentId,
        status: sharingConsent?.status ?? "missing",
        expiresAt: sharingConsent?.expiresAt ?? null,
        candidateId: r.s.candidateId,
        jobId: r.s.jobId,
        companyId: r.s.companyId,
      },
      delivery: await submissionDeliveries(tx, ownerId, id, r.v.revision),
      release:
        (await submissionEvent(tx, ownerId, "released", id))?.metadata ?? null,
      view:
        (await submissionEvent(tx, ownerId, "viewed", id))?.metadata ?? null,
      feedback: history
        .slice(0, 50)
        .map((e: any) => ({ revision: e.revision, ...e.metadata })),
      olderFeedbackAvailable: history.length > 50,
    };
  });
}
export async function eraseSubmissionContent(
  ownerId: number,
  candidateId: string
) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const rows = await tx
      .select()
      .from(shortlists)
      .where(
        and(
          eq(shortlists.ownerId, ownerId),
          eq(shortlists.candidateId, candidateId)
        )
      );
    for (const s of rows)
      await revokeSubmissionInTransaction(
        tx,
        ownerId,
        s.id,
        "Candidate privacy erasure stopped client review authority."
      );
    const events = await tx
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.ownerId, ownerId));
    for (const e of events)
      if (
        e.eventType.startsWith("submission.") &&
        e.metadata?.candidateId === candidateId
      )
        await tx
          .update(workflowEvents)
          .set({
            metadata: { redacted: true, reason: "candidate_privacy_erasure" },
          })
          .where(eq(workflowEvents.id, e.id));
    for (const s of rows)
      await tx
        .update(shortlists)
        .set({ clientFeedback: null })
        .where(eq(shortlists.id, s.id));
  });
}
export async function enrollSubmissionFollowup(ownerId: number, id: string) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const r = await currentSubmission(tx, ownerId, id);
    if (
      (await submissionEvent(tx, ownerId, "feedback", id))?.metadata.version ===
      r.v.revision
    )
      throw fail("Client feedback is already recorded.");
    const deliveries = await submissionDeliveries(
      tx,
      ownerId,
      id,
      r.v.revision
    );
    if (
      !deliveries.some(
        (m: any) => m.kind === "submission_link" && m.status === "sent"
      )
    )
      throw fail(
        "Send or reconcile the exact approved invitation before enrolling email review reminders."
      );
    return enrollFollowUpInTransaction(tx, ownerId, {
      scenarioId:
        (await submissionEvent(tx, ownerId, "viewed", id))?.revision ===
        r.v.revision
          ? "FU16"
          : "FU15",
      conversationId: r.release.metadata.conversationId,
      senderIdentityId: r.source.sender.id,
      resourceType: "client_submission",
      resourceId: id,
      objective: "Request review of the exact released candidate profile",
      timezone: "Asia/Kolkata",
      businessDaysOnly: true,
      deadlineAt: new Date(r.v.metadata.expiresAt),
      responseWindowMinutes: 1440,
      steps: [
        {
          delayMinutes: 0,
          subject: "Private candidate profile review",
          body: "Please review the private candidate profile in the earlier email. Reply with any access issue or clarification. Reply STOP to stop these emails.",
        },
        {
          delayMinutes: 1440,
          subject: "Candidate profile review follow-up",
          body: "Please confirm whether clarification is needed on the previously shared profile. Your reply will be reviewed by the recruiter. Reply STOP to stop these emails.",
        },
      ],
    });
  });
}
export async function submissionOptions(
  ownerId: number,
  input: {
    kind: "candidate" | "job" | "contact" | "sender";
    search?: string;
    jobId?: string;
  }
) {
  const db = await requireDb(),
    search = input.search?.trim() ?? "",
    pattern = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
  if (input.kind === "sender")
    return {
      rows: await db
        .select({ id: emailIdentities.id, label: emailIdentities.email })
        .from(emailIdentities)
        .where(
          and(
            eq(emailIdentities.ownerId, ownerId),
            eq(emailIdentities.status, "active"),
            eq(emailIdentities.purpose, "clients")
          )
        )
        .limit(100),
      more: false,
    };
  if (input.kind === "contact") {
    const j = (
      await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.ownerId, ownerId), eq(jobs.id, input.jobId ?? "")))
        .limit(1)
    )[0];
    if (!j) return { rows: [], more: false };
    const rows = await db
      .select({ id: contacts.id, label: contacts.name })
      .from(contacts)
      .where(
        and(
          eq(contacts.ownerId, ownerId),
          eq(contacts.companyId, j.companyId),
          ...(search ? [like(contacts.name, pattern)] : [])
        )
      )
      .limit(101);
    return { rows: rows.slice(0, 100), more: rows.length > 100 };
  }
  const t = input.kind === "job" ? jobs : candidates,
    label = input.kind === "job" ? jobs.title : candidates.fullName;
  const rows = await db
    .select({ id: t.id, label })
    .from(t)
    .where(
      and(eq(t.ownerId, ownerId), ...(search ? [like(label, pattern)] : []))
    )
    .limit(101);
  return { rows: rows.slice(0, 100), more: rows.length > 100 };
}
