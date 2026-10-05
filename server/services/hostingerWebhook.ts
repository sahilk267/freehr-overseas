import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  automationQueue,
  candidates,
  contacts,
  conversations,
  incidents,
  messages,
  suppressionList,
} from "../../drizzle/schema";
import { createId, hashContactValue, recordAudit, requireDb } from "../db";
import { resolvePrimaryOwner } from "./primaryOwner";
import { detectOptOut, normalizeMessageRef } from "./hostingerMail";

type UnknownRecord = Record<string, unknown>;
const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
const asString = (...values: unknown[]) =>
  values.find(value => typeof value === "string" && value.trim()) as string | undefined;

export function isValidHostingerWebhookAuthorization(authorization: string | undefined) {
  const expected = process.env.HOSTINGER_MAIL_WEBHOOK_SECRET?.trim();
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || !token) return false;
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);
  return expectedBuffer.length === tokenBuffer.length && timingSafeEqual(expectedBuffer, tokenBuffer);
}

export function normalizeHostingerMailEvent(body: unknown) {
  const root = asRecord(body);
  const data = asRecord(root.data);
  const message = asRecord(data.message ?? root.message ?? data);
  const providerMessageId = asString(
    message.messageId,
    message.message_id,
    message.id,
    data.messageId,
    data.message_id,
  );
  const senderValue = message.from ?? data.from;
  const sender =
    typeof senderValue === "string"
      ? senderValue.trim().toLowerCase()
      : asString(asRecord(senderValue).address, asRecord(senderValue).email)?.trim().toLowerCase();
  const referencesRaw = message.references ?? data.references;
  const references = Array.isArray(referencesRaw)
    ? referencesRaw
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .map(value => value.trim())
    : [];
  const inReplyTo = asString(
    message.inReplyTo,
    message.in_reply_to,
    data.inReplyTo,
    data.in_reply_to,
  )?.trim();
  const subject = asString(message.subject, data.subject)?.trim();
  const text = asString(
    message.text,
    message.textBody,
    message.text_body,
    data.text,
    data.textBody,
    data.text_body,
  )?.trim();
  if (!providerMessageId || !sender || !text) return null;
  return {
    providerMessageId,
    sender,
    subject,
    text,
    inReplyTo,
    references,
    event: asString(root.event, root.type, data.event) ?? "message.received",
  };
}

export async function processHostingerMailWebhook(input: { authorization?: string; body: unknown }) {
  if (!isValidHostingerWebhookAuthorization(input.authorization)) {
    return { statusCode: 401, body: { error: "Unauthorized webhook." } };
  }
  const event = normalizeHostingerMailEvent(input.body);
  const owner = await resolvePrimaryOwner();
  if (!owner) {
    return { statusCode: 503, body: { error: "Workspace owner is not initialized." } };
  }
  const db = await requireDb();
  if (!event) {
    const incidentId = createId("inc_");
    await db.insert(incidents).values({
      id: incidentId,
      ownerId: owner.id,
      incidentType: "hostinger_mail_malformed_event",
      severity: "medium",
      status: "detected",
      affectedResourceType: "mail_event",
      affectedResourceId: createId("evt_"),
      summary: "Hostinger Mail webhook payload could not be normalized.",
    });
    await recordAudit({
      ownerId: owner.id,
      actorType: "provider",
      actorId: "hostinger_mail_api",
      action: "email.webhook_malformed",
      resourceType: "mail_event",
      resourceId: incidentId,
    });
    return { statusCode: 202, body: { status: "routed_to_exception" } };
  }
  if (event.event !== "message.received") {
    return { statusCode: 202, body: { status: "ignored", event: event.event } };
  }

  let matchedParent: typeof messages.$inferSelect | undefined;
  let isAmbiguous = false;

  // Priority 1: Exact provider message ID match (if this event itself matches an existing message by providerMessageId)
  if (event.providerMessageId) {
    const existingMsg = (
      await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, owner.id),
            eq(messages.providerMessageId, event.providerMessageId),
          ),
        )
        .limit(2)
    );
    if (existingMsg.length === 1) {
      matchedParent = existingMsg[0];
    } else if (existingMsg.length > 1) {
      isAmbiguous = true;
    }
  }

  // Priority 2: Exact In-Reply-To match
  if (!matchedParent && !isAmbiguous && event.inReplyTo && event.inReplyTo.trim()) {
    const rawRef = event.inReplyTo.trim();
    const cleaned = normalizeMessageRef(rawRef);
    const refVariants = new Set<string>([rawRef]);
    if (cleaned) {
      refVariants.add(cleaned);
      refVariants.add(`<${cleaned}>`);
    }

    const matchedMsgs: (typeof messages.$inferSelect)[] = [];
    for (const ref of refVariants) {
      const found = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, owner.id),
            or(eq(messages.providerMessageId, ref), eq(messages.id, ref)),
          ),
        )
        .limit(5);
      if (Array.isArray(found)) {
        matchedMsgs.push(...found);
      }
    }

    const uniqueMsgs = Array.from(new Map(matchedMsgs.map(m => [m.id, m])).values());
    const uniqueConvIds = Array.from(new Set(uniqueMsgs.map(m => m.conversationId)));
    if (uniqueConvIds.length === 1) {
      matchedParent = uniqueMsgs[0];
    } else if (uniqueConvIds.length > 1) {
      isAmbiguous = true;
    }
  }

  // Priority 3: References match
  if (!matchedParent && !isAmbiguous && event.references && event.references.length > 0) {
    const refVariants = new Set<string>();
    for (const r of event.references) {
      if (r && r.trim()) {
        const raw = r.trim();
        refVariants.add(raw);
        const cleaned = normalizeMessageRef(raw);
        if (cleaned) {
          refVariants.add(cleaned);
          refVariants.add(`<${cleaned}>`);
        }
      }
    }

    const matchedMsgs: (typeof messages.$inferSelect)[] = [];
    for (const ref of refVariants) {
      const found = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, owner.id),
            or(eq(messages.providerMessageId, ref), eq(messages.id, ref)),
          ),
        )
        .limit(5);
      if (Array.isArray(found)) {
        matchedMsgs.push(...found);
      }
    }

    const uniqueMsgs = Array.from(new Map(matchedMsgs.map(m => [m.id, m])).values());
    const uniqueConvIds = Array.from(new Set(uniqueMsgs.map(m => m.conversationId)));
    if (uniqueConvIds.length === 1) {
      matchedParent = uniqueMsgs[0];
    } else if (uniqueConvIds.length > 1) {
      isAmbiguous = true;
    }
  }

  // Priority 4: Safe conversation fallback only if unambiguous
  if (!matchedParent && !isAmbiguous && event.sender) {
    const senderEmail = event.sender.toLowerCase().trim();
    const candidateRows = await db
      .select()
      .from(candidates)
      .where(
        and(
          eq(candidates.ownerId, owner.id),
          or(
            eq(candidates.email, senderEmail),
            eq(candidates.emailHash, hashContactValue(senderEmail)),
          ),
        ),
      )
      .limit(5);

    const contactRows = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.ownerId, owner.id), eq(contacts.email, senderEmail)))
      .limit(5);

    const matchedCandidateIds = Array.isArray(candidateRows) ? candidateRows.map(c => c.id) : [];
    const matchedContactIds = Array.isArray(contactRows) ? contactRows.map(c => c.id) : [];

    let matchingConversations: (typeof conversations.$inferSelect)[] = [];
    if (matchedCandidateIds.length > 0 || matchedContactIds.length > 0) {
      const convList = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.ownerId, owner.id),
            or(
              matchedCandidateIds.length > 0
                ? inArray(conversations.candidateId, matchedCandidateIds)
                : undefined,
              matchedContactIds.length > 0
                ? inArray(conversations.contactId, matchedContactIds)
                : undefined,
            ),
          ),
        )
        .limit(5);
      matchingConversations = Array.isArray(convList) ? convList.filter(c => c.status !== "closed" && c.status !== "archived") : [];
    }

    if (matchingConversations.length === 0) {
      const candidateConvs = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.ownerId, owner.id),
            inArray(conversations.status, ["open", "reply_received", "waiting", "active", "not_started"]),
          ),
        )
        .limit(10);

      for (const conv of candidateConvs) {
        const msgs = await db
          .select()
          .from(messages)
          .where(and(eq(messages.ownerId, owner.id), eq(messages.conversationId, conv.id)))
          .limit(10);
        const hasSender = msgs.some(
          m =>
            m.body.toLowerCase().includes(senderEmail) ||
            (m.idempotencyKey && m.idempotencyKey.includes(senderEmail)),
        );
        if (hasSender) {
          matchingConversations.push(conv);
        }
      }
    }

    const uniqueConvIds = Array.from(new Set(matchingConversations.map(c => c.id)));
    if (uniqueConvIds.length === 1) {
      const lastMsg = (
        await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.ownerId, owner.id),
              eq(messages.conversationId, uniqueConvIds[0]),
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(1)
      )[0];
      if (lastMsg) {
        matchedParent = lastMsg;
      }
    } else if (uniqueConvIds.length > 1) {
      isAmbiguous = true;
    }
  }

  // Handle ambiguous: do not select arbitrarily!
  if (isAmbiguous) {
    const incidentId = createId("inc_");
    await db.insert(incidents).values({
      id: incidentId,
      ownerId: owner.id,
      incidentType: "hostinger_mail_ambiguous_event",
      severity: "medium",
      status: "detected",
      affectedResourceType: "email",
      affectedResourceId: event.providerMessageId,
      summary: "Hostinger Mail inbound event matches multiple conversations ambiguously.",
    });
    await recordAudit({
      ownerId: owner.id,
      actorType: "provider",
      actorId: "hostinger_mail_api",
      action: "email.webhook_ambiguous",
      resourceType: "email",
      resourceId: event.providerMessageId,
      metadata: { incidentId },
    });
    return { statusCode: 202, body: { status: "routed_to_exception", reason: "ambiguous_match" } };
  }

  // Handle unmatched:
  if (!matchedParent) {
    const incidentId = createId("inc_");
    await db.insert(incidents).values({
      id: incidentId,
      ownerId: owner.id,
      incidentType: "hostinger_mail_unmatched_event",
      severity: "medium",
      status: "detected",
      affectedResourceType: "email",
      affectedResourceId: event.providerMessageId,
      summary: "Hostinger Mail inbound event does not match an existing conversation.",
    });
    await recordAudit({
      ownerId: owner.id,
      actorType: "provider",
      actorId: "hostinger_mail_api",
      action: "email.webhook_unmatched",
      resourceType: "email",
      resourceId: event.providerMessageId,
      metadata: { incidentId },
    });
    return { statusCode: 202, body: { status: "routed_to_exception", reason: "unmatched" } };
  }

  const optedOut = detectOptOut(event.text);
  const messageId = createId("msg_");
  await db
    .insert(messages)
    .values({
      id: messageId,
      conversationId: matchedParent.conversationId,
      ownerId: owner.id,
      direction: "inbound",
      status: "received",
      subject: event.subject,
      body: event.text,
      providerMessageId: event.providerMessageId,
      idempotencyKey: `hostinger:event:${event.providerMessageId}`,
      aiGenerated: false,
      deliveredAt: new Date(),
    })
    .onDuplicateKeyUpdate({ set: { deliveredAt: new Date() } });

  if (optedOut) {
    await db
      .insert(suppressionList)
      .values({
        id: createId("sup_"),
        ownerId: owner.id,
        channel: "email",
        valueHash: hashContactValue(event.sender),
        reason: "Hostinger inbound opt-out detected",
        source: "hostinger_mail_webhook",
      })
      .onDuplicateKeyUpdate({
        set: {
          active: true,
          reason: "Hostinger inbound opt-out detected",
          source: "hostinger_mail_webhook",
        },
      });
  }

  await db
    .update(conversations)
    .set({
      status: optedOut ? "opted_out" : "reply_received",
      classification: optedOut ? "stop_contact" : null,
      lastMessageAt: new Date(),
    })
    .where(eq(conversations.id, matchedParent.conversationId));

  if (!optedOut) {
    await db
      .insert(automationQueue)
      .values({
        id: createId("q_"),
        ownerId: owner.id,
        jobType: "classify_reply",
        status: "queued",
        payload: {
          conversationId: matchedParent.conversationId,
          messageId,
          sender: event.sender,
          subject: event.subject,
          body: event.text,
          source: "hostinger_mail_webhook",
        },
        priority: 30,
        scheduledAt: new Date(),
        maxAttempts: 3,
        idempotencyKey: `classify_reply:${event.providerMessageId}`,
      })
      .onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
  }

  await recordAudit({
    ownerId: owner.id,
    actorType: "provider",
    actorId: "hostinger_mail_api",
    action: optedOut ? "email.webhook_opt_out" : "email.webhook_classification_queued",
    resourceType: "conversation",
    resourceId: matchedParent.conversationId,
    nextState: optedOut ? "opted_out" : "reply_received",
    metadata: { messageId, providerMessageId: event.providerMessageId },
  });

  return {
    statusCode: 202,
    body: {
      status: optedOut ? "opted_out" : "classification_queued",
      conversationId: matchedParent.conversationId,
    },
  };
}
