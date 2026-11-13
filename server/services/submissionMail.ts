import { TRPCError } from "@trpc/server";
import { hashContactValue } from "../db";
import { currentSubmission, submissionEvent } from "./submissionState";
import { emailContentHash } from "./emailAuthorization";
import {
  SUBMISSION_LINK_MARKER,
  SUBMISSION_OTP_MARKER,
  submissionCodeHash,
  submissionSecret,
  type SubmissionMailScope,
} from "./submissionMailScope";
export async function materializeSubmissionEmail(
  tx: any,
  ownerId: number,
  payload: { recipient?: string; submissionScope?: SubmissionMailScope },
  message: { conversationId: string; body: string },
  now = new Date()
) {
  const s = payload.submissionScope;
  if (!s) return null;
  const r = await currentSubmission(tx, ownerId, s.id, now),
    a = r.authority.metadata;
  const fail = () =>
    new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Submission mail source, recipient, authority or verification request changed.",
    });
  if (
    s.version !== r.v.revision ||
    s.packHash !== r.v.metadata.packHash ||
    s.authorityRevision !== r.authority.revision ||
    s.recipientHash !== hashContactValue(r.source.contact.email) ||
    payload.recipient?.trim().toLowerCase() !==
      r.source.contact.email.trim().toLowerCase() ||
    message.conversationId !== r.release.metadata.conversationId
  )
    throw fail();
  if (s.kind === "submission_link") {
    if (
      s.nonce !== a.nonce ||
      s.keyId !== a.keyId ||
      s.origin !== a.origin ||
      !message.body.includes(SUBMISSION_LINK_MARKER)
    )
      throw fail();
    return {
      body: message.body.replace(
        SUBMISSION_LINK_MARKER,
        `${s.origin}/client-review#${s.id}.${submissionSecret(s)}`
      ),
      transactionalOtp: false,
    };
  }
  if (
    s.kind !== "submission_otp" ||
    !s.challengeId ||
    s.transactionalOtp !== true ||
    !r.v.metadata.transactionalOtp
  )
    throw fail();
  const c = await submissionEvent(tx, ownerId, "otp", s.challengeId),
    current = await submissionEvent(tx, ownerId, "otp_current", s.id),
    subject = "Client review verification code";
  if (
    !c ||
    current?.metadata.challengeId !== s.challengeId ||
    c.metadata.shortlistId !== s.id ||
    c.metadata.authorityRevision !== r.authority.revision ||
    new Date(c.metadata.expiresAt).getTime() - now.getTime() < 30000 ||
    c.metadata.contentHash !==
      emailContentHash({
        senderIdentityId: r.source.sender.id,
        recipient: payload.recipient!,
        subject,
        body: SUBMISSION_OTP_MARKER,
        submissionScope: s,
      }) ||
    !message.body.includes(SUBMISSION_OTP_MARKER) ||
    (await submissionEvent(tx, ownerId, "otp_consumed", s.challengeId))
  )
    throw fail();
  const code = submissionSecret(s, true);
  if (submissionCodeHash(s.challengeId, code) !== c.metadata.codeHash)
    throw fail();
  return {
    body: message.body.replace(
      SUBMISSION_OTP_MARKER,
      `Your private client review code is ${code}. It expires in 10 minutes. Enter it only on the private review page you opened. Do not share this code. Ignore this email if you did not request it.`
    ),
    transactionalOtp: true,
  };
}
