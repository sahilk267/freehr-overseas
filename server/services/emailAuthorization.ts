import {availabilityMailValues,type AvailabilityMailScope} from "./availabilityMailScope";
import { createHash } from "node:crypto";

export function emailContentHash(input: { senderIdentityId: string; recipient: string; subject: string; body: string; privateLink?:AvailabilityMailScope }) {
  const values:unknown[]=[input.senderIdentityId,input.recipient.trim().toLowerCase(),input.subject,input.body];
  if(input.privateLink)values.push(availabilityMailValues(input.privateLink));
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
