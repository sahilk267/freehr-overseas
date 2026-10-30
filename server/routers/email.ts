import { stopOwnerFollowUps } from "../services/followupEvents";
import { deliverApprovedEmail } from "../services/emailDelivery";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { approvals, conversations, emailIdentities, incidents, messages, suppressionList } from "../../drizzle/schema";
import { createId, hashContactValue, recordAudit, requireDb } from "../db";
import { detectOptOut, getHostingerMailApiStatus, isApprovedSenderAddress, normalizeMessageRef, verifyHostingerMailApi, EMAIL_PURPOSES } from "../services/hostingerMail";
import { protectedProcedure, router } from "../_core/trpc";
import { emailContentHash } from "../services/emailAuthorization";

const identityInput = z.object({ email: z.string().email(), purpose: z.enum(EMAIL_PURPOSES), displayName: z.string().trim().min(2).max(160).default("FreelanceHR"), replyTo: z.string().email().optional() });

export const emailRouter = router({
  status: protectedProcedure.query(() => getHostingerMailApiStatus()),
  identities: router({
    list: protectedProcedure.query(async ({ ctx }) => (await requireDb()).select().from(emailIdentities).where(eq(emailIdentities.ownerId, ctx.user.id)).orderBy(emailIdentities.purpose)),
    save: protectedProcedure.input(identityInput).mutation(async ({ ctx, input }) => {
      if (!isApprovedSenderAddress(input.email)) throw new TRPCError({ code: "BAD_REQUEST", message: "Sender must use the configured approved domain." });
      const db = await requireDb(); const existing = (await db.select().from(emailIdentities).where(and(eq(emailIdentities.ownerId, ctx.user.id), eq(emailIdentities.email, input.email))).limit(1))[0];
      const id = existing?.id ?? createId("eid_");
      if (existing) await db.update(emailIdentities).set({ purpose: input.purpose, displayName: input.displayName, replyTo: input.replyTo ?? null }).where(eq(emailIdentities.id, id));
      else await db.insert(emailIdentities).values({ id, ownerId: ctx.user.id, ...input, status: "unverified" });
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "email.identity_saved", resourceType: "email_identity", resourceId: id, metadata: { email: input.email, purpose: input.purpose } });
      return { id };
    }),
    setStatus: protectedProcedure.input(z.object({ id: z.string().min(4), status: z.enum(["active", "disabled", "unverified"]) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb(); const identity = (await db.select().from(emailIdentities).where(and(eq(emailIdentities.id, input.id), eq(emailIdentities.ownerId, ctx.user.id))).limit(1))[0];
      if (!identity) throw new TRPCError({ code: "NOT_FOUND", message: "Email identity was not found." });
      if (input.status === "active" && !getHostingerMailApiStatus().configured) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Add Hostinger Mail API credentials before activating a sender." });
      await db.update(emailIdentities).set({ status: input.status, lastHealthCheckAt: new Date(), lastHealthStatus: input.status === "active" ? "api_configured" : "disabled" }).where(eq(emailIdentities.id, identity.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "email.identity_status_changed", resourceType: "email_identity", resourceId: identity.id, previousState: identity.status, nextState: input.status });
      return { success: true };
    }),
    verify: protectedProcedure.input(z.object({ id: z.string().min(4) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb(); const identity = (await db.select().from(emailIdentities).where(and(eq(emailIdentities.id, input.id), eq(emailIdentities.ownerId, ctx.user.id))).limit(1))[0];
      if (!identity) throw new TRPCError({ code: "NOT_FOUND", message: "Email identity was not found." });
      const result = await verifyHostingerMailApi();
      await db.update(emailIdentities).set({ lastHealthCheckAt: new Date(), lastHealthStatus: result.status, status: result.ok ? "active" : "unverified" }).where(eq(emailIdentities.id, identity.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "email.hostinger_api_verified", resourceType: "email_identity", resourceId: identity.id, previousState: identity.status, nextState: result.ok ? "active" : "unverified", metadata: { result: result.status } });
      return result;
    }),
  }),
  outbound: router({
    approvalDetail: protectedProcedure.input(z.object({ approvalId: z.string().min(4) })).query(async ({ ctx, input }) => {
      const db = await requireDb();
      const approval = (await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.ownerId, ctx.user.id), eq(approvals.actionType, "email_send"))).limit(1))[0];
      if (!approval) throw new TRPCError({ code: "NOT_FOUND", message: "Email approval was not found." });
      const message = (await db.select().from(messages).where(and(eq(messages.id, approval.resourceId), eq(messages.ownerId, ctx.user.id))).limit(1))[0] ?? null;
      const conversation = message ? (await db.select().from(conversations).where(and(eq(conversations.id, message.conversationId), eq(conversations.ownerId, ctx.user.id))).limit(1))[0] ?? null : null;
      return { approval, message, conversation };
    }),
    requestApproval: protectedProcedure.input(z.object({ conversationId: z.string().min(4), senderIdentityId: z.string().min(4), recipient: z.string().email(), subject: z.string().trim().min(1).max(255), body: z.string().trim().min(8).max(12000) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const identity = (await db.select().from(emailIdentities).where(and(eq(emailIdentities.id, input.senderIdentityId), eq(emailIdentities.ownerId, ctx.user.id))).limit(1))[0];
      if (!identity || identity.status !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Select an active, approved sender identity." });
      const blocked = (await db.select().from(suppressionList).where(and(eq(suppressionList.ownerId, ctx.user.id), eq(suppressionList.channel, "email"), eq(suppressionList.valueHash, hashContactValue(input.recipient)))).limit(1))[0];
      if (blocked?.active) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Recipient is suppressed and cannot receive outreach." });
      const conversation = (await db.select().from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.ownerId, ctx.user.id))).limit(1))[0];
      if (!conversation) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation was not found." });
      const messageId = createId("msg_"); const approvalId = createId("apr_");
      await db.insert(messages).values({ id: messageId, conversationId: input.conversationId, ownerId: ctx.user.id, direction: "outbound", status: "approval_pending", deliveredAt: null, subject: input.subject, body: input.body, idempotencyKey: `email:${messageId}`, aiGenerated: false });
      await db.insert(approvals).values({ id: approvalId, ownerId: ctx.user.id, requestedBy: "user", actionedAt: null, actionType: "email_send", resourceType: "message", resourceId: messageId, status: "pending", reason: "Every external recruitment email requires explicit owner approval.", payload: { senderIdentityId: identity.id, senderAddress: identity.email, senderPurpose: identity.purpose, recipient: input.recipient, contentHash: emailContentHash({ senderIdentityId: identity.id, recipient: input.recipient, subject: input.subject, body: input.body }) } });
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "email.send_approval_requested", resourceType: "message", resourceId: messageId, nextState: "approval_pending", metadata: { approvalId, sender: identity.email, recipient: input.recipient } });
      return { messageId, approvalId };
    }),
    deliverApproved: protectedProcedure.input(z.object({ messageId: z.string().min(4), senderIdentityId: z.string().min(4).optional(), recipient: z.string().email().optional() })).mutation(async ({ ctx, input }) => {
      return deliverApprovedEmail(ctx.user.id, input);

    }),
  }),
  inbound: router({
    status: protectedProcedure.query(() => getHostingerMailApiStatus()),
    verify: protectedProcedure.mutation(async ({ ctx }) => {
      const result = await verifyHostingerMailApi();
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "email.inbound_api_verified", resourceType: "mail_transport", resourceId: "hostinger_mail_api", metadata: { result: result.status } });
      return result;
    }),
    record: protectedProcedure.input(z.object({ conversationId: z.string().min(4), sender: z.string().email(), subject: z.string().max(255).optional(), body: z.string().trim().min(1).max(12000), providerMessageId: z.string().max(255).optional() })).mutation(async ({ ctx, input }) => {
      const db = await requireDb(); const conversation = (await db.select().from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.ownerId, ctx.user.id))).limit(1))[0];
      if (!conversation) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation was not found." });
      const id = createId("msg_"); const optedOut = detectOptOut(input.body);
      await db.insert(messages).values({ id, conversationId: conversation.id, ownerId: ctx.user.id, direction: "inbound", status: "received", subject: input.subject, body: input.body, providerMessageId: input.providerMessageId, idempotencyKey: `inbound:${input.providerMessageId ?? id}`, aiGenerated: false, deliveredAt: new Date() });
      if (optedOut) await db.insert(suppressionList).values({ id: createId("sup_"), ownerId: ctx.user.id, channel: "email", valueHash: hashContactValue(input.sender), reason: "Inbound opt-out detected", source: "inbound_mail" }).onDuplicateKeyUpdate({ set: { active: true, reason: "Inbound opt-out detected", source: "inbound_mail" } });
      await db.update(conversations).set({ status: optedOut ? "opted_out" : "reply_received", classification: optedOut ? "stop_contact" : null, lastMessageAt: new Date() }).where(eq(conversations.id, conversation.id));
      await stopOwnerFollowUps(ctx.user.id, optedOut ? { recipientHash: hashContactValue(input.sender) } : { conversationId: conversation.id }, optedOut ? "cancelled" : "paused", optedOut ? "Recipient opted out." : "Recipient replied; review before resuming.");
      await recordAudit({ ownerId: ctx.user.id, actorType: "provider", actorId: "inbound_mail", action: optedOut ? "email.opt_out_detected" : "email.inbound_recorded", resourceType: "conversation", resourceId: conversation.id, nextState: optedOut ? "opted_out" : "reply_received", metadata: { messageId: id } });
      return { messageId: id, optedOut };
    }),
    recordByThread: protectedProcedure.input(z.object({ sender: z.string().email(), subject: z.string().max(255).optional(), body: z.string().trim().min(1).max(12000), providerMessageId: z.string().min(3).max(255), inReplyTo: z.string().max(255).optional(), references: z.array(z.string().max(255)).max(20).default([]) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const rawRefs = [input.inReplyTo, ...(input.references || [])].filter((r): r is string => Boolean(r && r.trim()));
      const normalizedRefs = new Set<string>();
      for (const r of rawRefs) {
        normalizedRefs.add(r.trim());
        const cleaned = normalizeMessageRef(r);
        if (cleaned) {
          normalizedRefs.add(cleaned);
          normalizedRefs.add(`<${cleaned}>`);
        }
      }

      let parent: typeof messages.$inferSelect | undefined;

      // 1. Thread matching against providerMessageId or message id within the current user's workspace
      if (normalizedRefs.size > 0) {
        const refList = Array.from(normalizedRefs);
        for (const ref of refList) {
          const match = (
            await db
              .select()
              .from(messages)
              .where(and(eq(messages.ownerId, ctx.user.id), or(eq(messages.providerMessageId, ref), eq(messages.id, ref))))
              .limit(1)
          )[0];
          if (match) {
            parent = match;
            break;
          }
        }
      }

      // 2. Fallback matching by sender email when headers are absent
      if (!parent && input.sender) {
        const candidateConvs = await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.ownerId, ctx.user.id),
              inArray(conversations.status, ["open", "reply_received", "waiting"])
            )
          )
          .limit(10);

        const matchedConvs: typeof conversations.$inferSelect[] = [];
        for (const conv of candidateConvs) {
          const msgs = await db
            .select()
            .from(messages)
            .where(and(eq(messages.ownerId, ctx.user.id), eq(messages.conversationId, conv.id)))
            .limit(10);
          const hasSender = msgs.some(m =>
            m.body.toLowerCase().includes(input.sender.toLowerCase()) ||
            (m.idempotencyKey && m.idempotencyKey.includes(input.sender.toLowerCase()))
          );
          if (hasSender) {
            matchedConvs.push(conv);
          }
        }

        if (matchedConvs.length === 1) {
          const lastMsg = (
            await db
              .select()
              .from(messages)
              .where(and(eq(messages.ownerId, ctx.user.id), eq(messages.conversationId, matchedConvs[0].id)))
              .orderBy(desc(messages.createdAt))
              .limit(1)
          )[0];
          if (lastMsg) parent = lastMsg;
        } else if (matchedConvs.length > 1) {
          const incidentId = createId("inc_");
          await db.insert(incidents).values({
            id: incidentId,
            ownerId: ctx.user.id,
            incidentType: "ambiguous_inbound_email",
            severity: "medium",
            status: "detected",
            affectedResourceType: "email",
            affectedResourceId: input.providerMessageId,
            summary: `Inbound mail matched multiple active conversations (${matchedConvs.length}) for sender ${input.sender}.`,
          });
          await recordAudit({
            ownerId: ctx.user.id,
            actorType: "provider",
            actorId: "inbound_mail",
            action: "email.inbound_ambiguous",
            resourceType: "email",
            resourceId: input.providerMessageId,
            metadata: { incidentId, matchingConversationsCount: matchedConvs.length },
          });
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Inbound mail match was ambiguous across multiple conversations and has been routed to the exception center.",
          });
        }
      }

      if (!parent) {
        const incidentId = createId("inc_");
        await db.insert(incidents).values({ id: incidentId, ownerId: ctx.user.id, incidentType: "unmatched_inbound_email", severity: "medium", status: "detected", affectedResourceType: "email", affectedResourceId: input.providerMessageId, summary: "Inbound mail did not contain a recognized message thread reference." });
        await recordAudit({ ownerId: ctx.user.id, actorType: "provider", actorId: "inbound_mail", action: "email.inbound_unmatched", resourceType: "email", resourceId: input.providerMessageId, metadata: { incidentId } });
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Inbound mail could not be matched and has been routed to the exception center." });
      }
      const id = createId("msg_"); const optedOut = detectOptOut(input.body);
      await db.insert(messages).values({ id, conversationId: parent.conversationId, ownerId: ctx.user.id, direction: "inbound", status: "received", subject: input.subject, body: input.body, providerMessageId: input.providerMessageId, idempotencyKey: `inbound:${input.providerMessageId}`, aiGenerated: false, deliveredAt: new Date() });
      if (optedOut) await db.insert(suppressionList).values({ id: createId("sup_"), ownerId: ctx.user.id, channel: "email", valueHash: hashContactValue(input.sender), reason: "Inbound opt-out detected", source: "inbound_mail" }).onDuplicateKeyUpdate({ set: { active: true, reason: "Inbound opt-out detected", source: "inbound_mail" } });
      await db.update(conversations).set({ status: optedOut ? "opted_out" : "reply_received", classification: optedOut ? "stop_contact" : null, lastMessageAt: new Date() }).where(eq(conversations.id, parent.conversationId));
      await stopOwnerFollowUps(ctx.user.id, optedOut ? { recipientHash: hashContactValue(input.sender) } : { conversationId: parent.conversationId }, optedOut ? "cancelled" : "paused", optedOut ? "Recipient opted out." : "Recipient replied; review before resuming.");
      await recordAudit({ ownerId: ctx.user.id, actorType: "provider", actorId: "inbound_mail", action: optedOut ? "email.opt_out_detected" : "email.inbound_thread_matched", resourceType: "conversation", resourceId: parent.conversationId, nextState: optedOut ? "opted_out" : "reply_received", metadata: { messageId: id, parentMessageId: parent.id } });
      return { messageId: id, conversationId: parent.conversationId, optedOut };
    }),
    messages: protectedProcedure.input(z.object({ conversationId: z.string().min(4), limit: z.number().int().min(1).max(100).default(50) })).query(async ({ ctx, input }) => {
      const db = await requireDb(); const conversation = (await db.select().from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.ownerId, ctx.user.id))).limit(1))[0];
      if (!conversation) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation was not found." });
      return db.select().from(messages).where(and(eq(messages.ownerId, ctx.user.id), eq(messages.conversationId, input.conversationId))).orderBy(desc(messages.createdAt)).limit(input.limit);
    }),
    conversations: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 })).query(async ({ ctx, input }) => (await requireDb()).select().from(conversations).where(eq(conversations.ownerId, ctx.user.id)).orderBy(desc(conversations.updatedAt)).limit(input.limit)),
  }),
});
