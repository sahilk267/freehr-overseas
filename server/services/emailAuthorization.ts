import {offerMailValues,type OfferMailScope} from './offerMailScope';
import {replyMailValues,type ReplyMailScope} from "./replyMailScope";
import {availabilityMailValues,type AvailabilityMailScope} from "./availabilityMailScope";
import { createHash } from "node:crypto";

export function emailContentHash(input: { senderIdentityId: string; recipient: string; subject: string; body: string; privateLink?:AvailabilityMailScope; replyScope?:ReplyMailScope;offerScope?:OfferMailScope }) {
  const values:unknown[]=[input.senderIdentityId,input.recipient.trim().toLowerCase(),input.subject,input.body];
  if(input.privateLink)values.push(availabilityMailValues(input.privateLink));
  if(input.replyScope)values.push(replyMailValues(input.replyScope));
  if(input.offerScope)values.push(offerMailValues(input.offerScope));
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
