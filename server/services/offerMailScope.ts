import { createHash, createHmac } from "node:crypto";
import { TRPCError } from "@trpc/server";
export type OfferMailScope = {
  kind: "offer_link" | "offer_otp";
  offerId: string;
  version: number;
  termsHash: string;
  authorityRevision: number;
  nonce: string;
  keyId: string;
  origin: string;
  recipientHash: string;
  challengeId?: string;
  transactionalOtp?: boolean;
};
export const offerMailValues = (s: OfferMailScope) => [
  "candidate_offer",
  s.kind,
  s.offerId,
  s.version,
  s.termsHash,
  s.authorityRevision,
  s.nonce,
  s.keyId,
  s.origin,
  s.recipientHash,
  s.challengeId ?? null,
  s.transactionalOtp === true,
];
function secret() {
  const value = (
    process.env.SESSION_SECRET ||
    process.env.JWT_SECRET ||
    ""
  ).trim();
  if (value.length < 32)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Configure a stable session secret before releasing private offers.",
    });
  return value;
}
export const offerKeyId = () =>
  createHmac("sha256", secret()).update("candidate-offer-key-v1").digest("hex");
export function offerOrigin() {
  try {
    const u = new URL(process.env.APP_BASE_URL || "");
    if (u.protocol !== "https:" || u.username || u.password) throw Error();
    return u.origin;
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Configure the HTTPS application origin before offer release.",
    });
  }
}
export function offerLinkToken(
  scope: Pick<
    OfferMailScope,
    | "offerId"
    | "version"
    | "termsHash"
    | "authorityRevision"
    | "nonce"
    | "keyId"
    | "origin"
  >
) {
  if (scope.keyId !== offerKeyId() || scope.origin !== offerOrigin())
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Offer link configuration changed. Reissue this offer authority.",
    });
  return createHmac("sha256", secret())
    .update(
      "offer-link-v1:" +
        JSON.stringify([
          scope.offerId,
          scope.version,
          scope.termsHash,
          scope.authorityRevision,
          scope.nonce,
          scope.keyId,
          scope.origin,
        ])
    )
    .digest("base64url");
}
export function offerOtp(scope: OfferMailScope) {
  if (
    scope.kind !== "offer_otp" ||
    !scope.challengeId ||
    scope.keyId !== offerKeyId() ||
    scope.origin !== offerOrigin()
  )
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Offer verification configuration changed.",
    });
  const value = createHmac("sha256", secret())
    .update("offer-otp-v1:" + JSON.stringify(offerMailValues(scope)))
    .digest("hex");
  return (BigInt("0x" + value) % 1000000n).toString().padStart(6, "0");
}
export const offerTokenHash = (token: string) =>
  createHash("sha256").update(JSON.stringify(token)).digest("hex");
export const offerOtpHash = (id: string, code: string) =>
  createHash("sha256")
    .update(JSON.stringify([id, code]))
    .digest("hex");
export const OFFER_LINK_MARKER =
  "[The private offer link is generated when this approved email is sent.]";
export const OFFER_OTP_MARKER =
  "[Your offer verification code is generated securely at delivery.]";
