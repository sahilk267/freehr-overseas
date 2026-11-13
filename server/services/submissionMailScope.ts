import { createHash, createHmac } from "node:crypto";
import { TRPCError } from "@trpc/server";
export type SubmissionMailScope = {
  kind: "submission_link" | "submission_otp";
  id: string;
  version: number;
  packHash: string;
  authorityRevision: number;
  recipientHash: string;
  nonce: string;
  keyId: string;
  origin: string;
  challengeId?: string;
  transactionalOtp?: boolean;
};
const secret = () => {
  const s = (process.env.SESSION_SECRET || process.env.JWT_SECRET || "").trim();
  if (s.length < 32)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "A stable session secret is required before submission release.",
    });
  return s;
};
export function submissionOrigin() {
  try {
    const u = new URL(process.env.APP_BASE_URL || "");
    if (u.protocol !== "https:" || u.username || u.password) throw Error();
    return u.origin;
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Configure the HTTPS application origin before submission release.",
    });
  }
}
export const submissionKeyId = () =>
  createHmac("sha256", secret())
    .update("client-submission-key-v1")
    .digest("hex");
export const submissionMailValues = (s: SubmissionMailScope) => [
  "client-submission-v1",
  s.kind,
  s.id,
  s.version,
  s.packHash,
  s.authorityRevision,
  s.recipientHash,
  s.nonce,
  s.keyId,
  s.origin,
  s.challengeId ?? null,
  s.transactionalOtp === true,
];
export const submissionHash = (s: string) =>
  createHash("sha256").update(JSON.stringify(s)).digest("hex");
export const submissionCodeHash = (id: string, code: string) =>
  createHash("sha256")
    .update(JSON.stringify([id, code]))
    .digest("hex");
export function submissionSecret(s: SubmissionMailScope, code = false) {
  if (s.keyId !== submissionKeyId() || s.origin !== submissionOrigin())
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Private submission configuration changed. Prepare a new release.",
    });
  const values = code
    ? submissionMailValues(s)
    : [
        s.id,
        s.version,
        s.packHash,
        s.authorityRevision,
        s.recipientHash,
        s.nonce,
        s.keyId,
        s.origin,
      ];
  const h = createHmac("sha256", secret()).update(
    (code ? "submission-otp:" : "submission-link:") + JSON.stringify(values)
  );
  return code
    ? (BigInt("0x" + h.digest("hex")) % 1000000n).toString().padStart(6, "0")
    : h.digest("base64url");
}
export const SUBMISSION_LINK_MARKER =
  "[The private client review link is generated at approved delivery.]";
export const SUBMISSION_OTP_MARKER =
  "[The client verification code is generated securely at delivery.]";
