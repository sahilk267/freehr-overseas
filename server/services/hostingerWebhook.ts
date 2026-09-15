import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { automationQueue, conversations, incidents, messages, suppressionList } from "../../drizzle/schema";
import { createId, hashContactValue, recordAudit, requireDb } from "../db";
import { resolvePrimaryOwner } from "./primaryOwner";
import { chooseThreadReference, detectOptOut } from "./hostingerMail";

type UnknownRecord = Record<string, unknown>;
const asRecord = (value: unknown): UnknownRecord => value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
const asString = (...values: unknown[]) => values.find(value => typeof value === "string" && value.trim()) as string | undefined;

export function isValidHostingerWebhookAuthorization(authorization: string | undefined) {
  const expected = process.env.HOSTINGER_MAIL_WEBHOOK_SECRET?.trim();
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || !token) return false;
  const expectedBuffer = Buffer.from(expected); const tokenBuffer = Buffer.from(token);
  return expectedBuffer.length === tokenBuffer.length && timingSafeEqual(expectedBuffer, tokenBuffer);
}

export function normalizeHostingerMailEvent(body: unknown) {
  const root = asRecord(body); const data = asRecord(root.data); const message = asRecord(data.message ?? root.message ?? data);
  const providerMessageId = asString(message.messageId, message.message_id, message.id, data.messageId, data.message_id);
  const senderValue = message.from ?? data.from;
  const sender = typeof senderValue === "string" ? senderValue.trim().toLowerCase() : asString(asRecord(senderValue).address, asRecord(senderValue).email)?.trim().toLowerCase();
  const referencesRaw = message.references ?? data.references;
  const references = Array.isArray(referencesRaw) ? referencesRaw.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map(value => value.trim()) : [];
  const inReplyTo = asString(message.inReplyTo, message.in_reply_to, data.inReplyTo, data.in_reply_to)?.trim();
  const subject = asString(message.subject, data.subject)?.trim();
  const text = asString(message.text, message.textBody, message.text_body, data.text, data.textBody, data.text_body)?.trim();
  if (!providerMessageId || !sender || !text) return null;
  return { providerMessageId, sender, subject, text, inReplyTo, references, event: asString(root.event, root.type, data.event) ?? "message.received" };
}

export async function processHostingerMailWebhook(input: { authorization?: string; body: unknown }) {
  if (!isValidHostingerWebhookAuthorization(input.authorization)) return { statusCode: 401, body: { error: "Unauthorized webhook." } };
  const event = normalizeHostingerMailEvent(input.body);
  const owner = await resolvePrimaryOwner();
  if (!owner) return { statusCode: 503, body: { error: "Workspace owner is not initialized." } };
  const db = await requireDb();
  if (!event) {
    const incidentId = createId("inc_");
    await db.insert(incidents).values({ id: incidentId, ownerId: owner.id, incidentType: "hostinger_mail_malformed_event", severity: "medium", status: "detected", affectedResourceType: "mail_event", affectedResourceId: createId("evt_"), summary: "Hostinger Mail webhook payload could not be normalized." });
    await recordAudit({ ownerId: owner.id, actorType: "provider", actorId: "hostinger_mail_api", action: "email.webhook_malformed", resourceType: "mail_event", resourceId: incidentId });
    return { statusCode: 202, body: { status: "routed_to_exception" } };
  }
  if (event.event !== "message.received") return { statusCode: 202, body: { status: "ignored", event: event.event } };
  const reference = chooseThreadReference(event);
  const parent = reference ? (await db.select().from(messages).where(and(eq(messages.ownerId, owner.id), eq(messages.providerMessageId, reference))).limit(1))[0] : undefined;
  if (!parent) {
    const incidentId = createId("inc_");
    await db.insert(incidents).values({ id: incidentId, ownerId: owner.id, incidentType: "hostinger_mail_unmatched_event", severity: "medium", status: "detected", affectedResourceType: "email", affectedResourceId: event.providerMessageId, summary: "Hostinger Mail inbound event does not match an existing conversation." });
    await recordAudit({ ownerId: owner.id, actorType: "provider", actorId: "hostinger_mail_api", action: "email.webhook_unmatched", resourceType: "email", resourceId: event.providerMessageId, metadata: { incidentId } });
    return { statusCode: 202, body: { status: "routed_to_exception" } };
  }
  const optedOut = detectOptOut(event.text); const messageId = createId("msg_");
  await db.insert(messages).values({ id: messageId, conversationId: parent.conversationId, ownerId: owner.id, direction: "inbound", status: "received", subject: event.subject, body: event.text, providerMessageId: event.providerMessageId, idempotencyKey: `hostinger:event:${event.providerMessageId}`, aiGenerated: false, deliveredAt: new Date() }).onDuplicateKeyUpdate({ set: { deliveredAt: new Date() } });
  if (optedOut) await db.insert(suppressionList).values({ id: createId("sup_"), ownerId: owner.id, channel: "email", valueHash: hashContactValue(event.sender), reason: "Hostinger inbound opt-out detected", source: "hostinger_mail_webhook" }).onDuplicateKeyUpdate({ set: { active: true, reason: "Hostinger inbound opt-out detected", source: "hostinger_mail_webhook" } });
  await db.update(conversations).set({ status: optedOut ? "opted_out" : "reply_received", classification: optedOut ? "stop_contact" : null, lastMessageAt: new Date() }).where(eq(conversations.id, parent.conversationId));
  if (!optedOut) await db.insert(automationQueue).values({ id: createId("q_"), ownerId: owner.id, jobType: "classify_reply", status: "queued", payload: { conversationId: parent.conversationId, messageId, sender: event.sender, subject: event.subject, body: event.text, source: "hostinger_mail_webhook" }, priority: 30, scheduledAt: new Date(), maxAttempts: 3, idempotencyKey: `classify_reply:${event.providerMessageId}` }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
  await recordAudit({ ownerId: owner.id, actorType: "provider", actorId: "hostinger_mail_api", action: optedOut ? "email.webhook_opt_out" : "email.webhook_classification_queued", resourceType: "conversation", resourceId: parent.conversationId, nextState: optedOut ? "opted_out" : "reply_received", metadata: { messageId, providerMessageId: event.providerMessageId } });
  return { statusCode: 202, body: { status: optedOut ? "opted_out" : "classification_queued", conversationId: parent.conversationId } };
}
