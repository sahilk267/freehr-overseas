import { createHash } from "node:crypto";

export function emailContentHash(input: { senderIdentityId: string; recipient: string; subject: string; body: string }) {
  return createHash("sha256").update(JSON.stringify([input.senderIdentityId, input.recipient.trim().toLowerCase(), input.subject, input.body])).digest("hex");
}
