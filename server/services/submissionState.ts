import { canonicalHash } from "./canonicalHash";
import { timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  approvals,
  contacts,
  emailIdentities,
  shortlists,
  suppressionList,
  workflowEvents,
} from "../../drizzle/schema";
import { hashContactValue, requireDb } from "../db";
import { assertSharingEligible } from "./sharingEligibility";
import { candidateEvidenceInTransaction } from "./candidateEvidence";
import { hasClientCommunicationPermission } from "./communicationPermission";
import { jobRequirementFingerprint } from "./jobIntake";
import { workflowHash } from "./workflowStore";
import {
  submissionHash,
  submissionKeyId,
  submissionOrigin,
} from "./submissionMailScope";
export const submissionEvent = async (
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
          eq(workflowEvents.eventType, "submission." + type),
          eq(workflowEvents.aggregateId, id)
        )
      )
      .orderBy(desc(workflowEvents.revision))
      .limit(1)
  )[0];
export const submissionDenied = () =>
  new TRPCError({
    code: "NOT_FOUND",
    message: "This private client review is unavailable or expired.",
  });
export const secureSubmissionEqual = (a: unknown, b: string) =>
  typeof a === "string" &&
  /^[a-f0-9]{64}$/.test(a) &&
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
export async function submissionRecord(tx: any, ownerId: number, id: string) {
  const s = (
      await tx
        .select()
        .from(shortlists)
        .where(and(eq(shortlists.ownerId, ownerId), eq(shortlists.id, id)))
        .limit(1)
    )[0],
    v = await submissionEvent(tx, ownerId, "pack", id);
  if (!s || !v || v.metadata?.redacted) throw submissionDenied();
  if (
    v.metadata.packHash !==
    canonicalHash({ id, version: v.revision, pack: v.metadata.pack })
  )
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Submission pack does not match its immutable source.",
    });
  return { s, v };
}
export async function submissionSources(
  tx: any,
  ownerId: number,
  s: any,
  contactId: string,
  senderId: string
) {
  const eligible = await assertSharingEligible(
      tx,
      {
        ownerId,
        candidateId: s.candidateId,
        companyId: s.companyId,
        jobId: s.jobId,
      },
      true
    ),
    d = await candidateEvidenceInTransaction(tx, ownerId, s.candidateId),
    contact = (
      await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.ownerId, ownerId), eq(contacts.id, contactId)))
        .limit(1)
    )[0],
    sender = (
      await tx
        .select()
        .from(emailIdentities)
        .where(
          and(
            eq(emailIdentities.ownerId, ownerId),
            eq(emailIdentities.id, senderId)
          )
        )
        .limit(1)
    )[0];
  if (
    !d.fresh ||
    d.suppressed ||
    !contact ||
    contact.companyId !== s.companyId ||
    !contact.email ||
    !(await hasClientCommunicationPermission(tx, ownerId, contact.id)) ||
    !sender ||
    sender.purpose !== "clients" ||
    sender.status !== "active"
  )
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Current structured candidate evidence, exact sharing consent, permitted client contact and active client sender are required.",
    });
  if (
    (
      await tx
        .select()
        .from(suppressionList)
        .where(
          and(
            eq(suppressionList.ownerId, ownerId),
            eq(suppressionList.valueHash, hashContactValue(contact.email)),
            eq(suppressionList.active, true)
          )
        )
        .limit(1)
    )[0]
  )
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The client recipient is suppressed.",
    });
  const sourceHash = workflowHash({
    candidateFingerprint: d.fingerprint,
    requirementFingerprint: jobRequirementFingerprint(eligible.job),
    companyState: eligible.company.pipelineState,
    contactId,
    recipientHash: hashContactValue(contact.email),
    consentId: eligible.consent.id,
    consentExpiry: eligible.consent.expiresAt,
    consentScope: eligible.consent.dataScope,
    senderId,
    senderEmail: sender.email,
    senderPurpose: sender.purpose,
  });
  return { ...eligible, d, contact, sender, sourceHash };
}
export async function currentSubmission(
  tx: any,
  ownerId: number,
  id: string,
  now = new Date(),
  released = true
) {
  const { s, v } = await submissionRecord(tx, ownerId, id),
    m = v.metadata,
    source = await submissionSources(
      tx,
      ownerId,
      s,
      m.contactId,
      m.senderIdentityId
    );
  if (
    source.sourceHash !== m.sourceHash ||
    new Date(m.expiresAt) <= now ||
    ["withdrawn", "expired"].includes(s.status)
  )
    throw submissionDenied();
  const authority = await submissionEvent(tx, ownerId, "authority", id),
    release = await submissionEvent(tx, ownerId, "released", id);
  if (
    released &&
    (!authority?.metadata.tokenHash ||
      authority.metadata.version !== v.revision ||
      authority.metadata.packHash !== m.packHash ||
      authority.metadata.keyId !== submissionKeyId() ||
      authority.metadata.origin !== submissionOrigin() ||
      release?.revision !== v.revision ||
      !["shared", "viewed"].includes(s.status))
  )
    throw submissionDenied();
  if (released) await requireSubmissionApproval(tx, ownerId, { s, v });
  return { s, v, source, authority, release };
}
export async function authenticateSubmission(
  id: string,
  token: string,
  tx?: any,
  ownerId?: number
) {
  const db = tx ?? (await requireDb()),
    a = ownerId
      ? await submissionEvent(db, ownerId, "authority", id)
      : (
          await db
            .select()
            .from(workflowEvents)
            .where(
              and(
                eq(workflowEvents.eventType, "submission.authority"),
                eq(workflowEvents.aggregateId, id)
              )
            )
            .orderBy(desc(workflowEvents.revision))
            .limit(1)
        )[0];
  if (
    !a ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !secureSubmissionEqual(a.metadata?.tokenHash, submissionHash(token))
  )
    throw submissionDenied();
  return a;
}
export async function applySubmissionApproval(tx: any, approval: any) {
  const p = approval.payload,
    governed = await submissionEvent(
      tx,
      approval.ownerId,
      "pack",
      approval.resourceId
    );
  if (!p?.submissionVersion) {
    if (governed && !governed.metadata?.redacted)
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "The current versioned submission requires its exact pack approval.",
      });
    return;
  }
  const r = await currentSubmission(
    tx,
    approval.ownerId,
    approval.resourceId,
    new Date(),
    false
  );
  if (
    r.v.revision !== p.submissionVersion ||
    r.v.metadata.packHash !== p.packHash ||
    r.v.metadata.sourceHash !== p.sourceHash ||
    r.v.metadata.approvalId !== approval.id
  )
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Submission profile, recipient or consent changed. Review a new pack.",
    });
}
export async function requireSubmissionApproval(
  tx: any,
  ownerId: number,
  r: any
) {
  const a = (
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
  if (
    !a ||
    a.actionType !== "candidate_share" ||
    a.resourceId !== r.s.id ||
    a.status !== "approved" ||
    !a.actionedAt ||
    a.payload?.submissionVersion !== r.v.revision ||
    a.payload?.packHash !== r.v.metadata.packHash
  )
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The exact current submission pack needs completed owner sharing approval.",
    });
  return a;
}
export async function submissionFollowupState(
  tx: any,
  ownerId: number,
  id: string,
  scenarioId: string,
  now = new Date()
) {
  try {
    const r = await currentSubmission(tx, ownerId, id, now),
      feedback = await submissionEvent(tx, ownerId, "feedback", id),
      view = await submissionEvent(tx, ownerId, "viewed", id);
    if (feedback?.metadata.version === r.v.revision)
      return {
        state: "completed" as const,
        reason: "Client feedback is recorded for owner review.",
      };
    if (scenarioId === "FU15" && view?.revision === r.v.revision)
      return {
        state: "completed" as const,
        reason: "The released profile was opened.",
      };
    return {
      state: "eligible" as const,
      conversationId: r.release.metadata.conversationId,
      senderIdentityId: r.source.sender.id,
      deadlineAt: new Date(r.v.metadata.expiresAt),
      fingerprint: workflowHash([
        r.v.metadata.packHash,
        r.v.metadata.sourceHash,
        r.authority.revision,
      ]),
    };
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    return {
      state: "cancelled" as const,
      reason: "Submission source, permission, access or deadline changed.",
    };
  }
}
