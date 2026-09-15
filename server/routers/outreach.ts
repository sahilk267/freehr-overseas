import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { companies, contacts, conversations, feeProposals, messages, automationQueue } from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { ensureSafeAiText } from "../workflow";

export const outreachRouter = router({
  draftSequence: protectedProcedure.input(z.object({ contactId: z.string().min(4), purpose: z.enum(["client_intro", "hiring_discovery", "candidate_outreach", "interview_reminder"]), context: z.string().trim().min(8).max(6000) })).mutation(async ({ ctx, input }) => {
    ensureSafeAiText(input.context);
    const db = await requireDb();
    const contact = (await db.select().from(contacts).where(and(eq(contacts.id, input.contactId), eq(contacts.ownerId, ctx.user.id))).limit(1))[0];
    if (!contact) throw new TRPCError({ code: "NOT_FOUND", message: "Contact was not found." });
    if (contact.optedOutAt || contact.contactPermission === "opted_out") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This contact has opted out and cannot receive outreach." });
    const conversationId = createId("cvn_");
    const messageId = createId("msg_");
    const queueId = createId("que_");
    await db.insert(conversations).values({ id: conversationId, ownerId: ctx.user.id, companyId: contact.companyId, contactId: contact.id, channel: "email", status: "drafting" });
    await db.insert(messages).values({ id: messageId, conversationId, ownerId: ctx.user.id, direction: "outbound", status: "drafting", body: "AI outreach draft pending", idempotencyKey: `message:${messageId}`, aiGenerated: true });
    await db.insert(automationQueue).values({ id: queueId, ownerId: ctx.user.id, jobType: "draft_outreach", payload: { purpose: input.purpose, contact: { name: contact.name, title: contact.title, companyId: contact.companyId }, context: input.context, policy: "Draft only. Include a clear opt-out. No message may be sent automatically." }, idempotencyKey: `draft_outreach:${messageId}` });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "outreach.draft_queued", resourceType: "message", resourceId: messageId, nextState: "drafting", metadata: { conversationId, queueId, purpose: input.purpose } });
    return { conversationId, messageId, queueId };
  }),
  classifyInboundReply: protectedProcedure.input(z.object({ conversationId: z.string().min(4), messageText: z.string().trim().min(1).max(12000) })).mutation(async ({ ctx, input }) => {
    ensureSafeAiText(input.messageText);
    const db = await requireDb();
    const conversation = (await db.select().from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.ownerId, ctx.user.id))).limit(1))[0];
    if (!conversation) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation was not found." });
    const messageId = createId("msg_");
    const queueId = createId("que_");
    await db.insert(messages).values({ id: messageId, conversationId: conversation.id, ownerId: ctx.user.id, direction: "inbound", status: "received", body: input.messageText, idempotencyKey: `inbound:${messageId}`, aiGenerated: false, deliveredAt: new Date() });
    await db.insert(automationQueue).values({ id: queueId, ownerId: ctx.user.id, jobType: "classify_reply", payload: { messageText: input.messageText, instruction: "Classify only. If the message asks to stop contact, recommend stop_contact." }, idempotencyKey: `classify_reply:${messageId}` });
    await db.update(conversations).set({ status: "reply_received", lastMessageAt: new Date() }).where(eq(conversations.id, conversation.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "outreach.reply_queued_for_classification", resourceType: "conversation", resourceId: conversation.id, nextState: "reply_received", metadata: { queueId } });
    return { messageId, queueId };
  }),
  list: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 })).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.select().from(conversations).where(eq(conversations.ownerId, ctx.user.id)).orderBy(desc(conversations.updatedAt)).limit(input.limit);
  }),
});

export const agreementsRouter = router({
  list: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 })).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.select().from(feeProposals).where(eq(feeProposals.ownerId, ctx.user.id)).orderBy(desc(feeProposals.updatedAt)).limit(input.limit);
  }),
  draft: protectedProcedure.input(z.object({ companyId: z.string().min(4), feeType: z.enum(["percentage", "fixed"]), feeValue: z.string().trim().min(1).max(32), currency: z.string().trim().min(3).max(8).default("INR"), guaranteeDays: z.number().int().min(0).max(365).default(90), paymentTermsDays: z.number().int().min(1).max(180).default(30), ownershipDays: z.number().int().min(1).max(730).default(180), termsText: z.string().trim().min(50).max(12000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const company = (await db.select().from(companies).where(and(eq(companies.id, input.companyId), eq(companies.ownerId, ctx.user.id))).limit(1))[0];
    if (!company) throw new TRPCError({ code: "NOT_FOUND", message: "Company was not found." });
    const id = createId("fee_");
    await db.insert(feeProposals).values({ id, ownerId: ctx.user.id, companyId: input.companyId, feeType: input.feeType, feeValue: input.feeValue, currency: input.currency, guaranteeDays: input.guaranteeDays, paymentTermsDays: input.paymentTermsDays, ownershipDays: input.ownershipDays, termsText: input.termsText, state: "draft" });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "agreement.drafted", resourceType: "fee_proposal", resourceId: id, nextState: "draft" });
    return { id };
  }),
  recordAcceptance: protectedProcedure.input(z.object({ proposalId: z.string().min(4), acceptedBy: z.string().email(), acceptanceEvidence: z.string().trim().min(10).max(2000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const proposal = (await db.select().from(feeProposals).where(and(eq(feeProposals.id, input.proposalId), eq(feeProposals.ownerId, ctx.user.id))).limit(1))[0];
    if (!proposal) throw new TRPCError({ code: "NOT_FOUND", message: "Fee proposal was not found." });
    await db.update(feeProposals).set({ state: "accepted", acceptedAt: new Date(), acceptedBy: input.acceptedBy }).where(eq(feeProposals.id, proposal.id));
    await db.update(companies).set({ pipelineState: "converted" }).where(and(eq(companies.id, proposal.companyId), eq(companies.ownerId, ctx.user.id)));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "agreement.acceptance_recorded", resourceType: "fee_proposal", resourceId: proposal.id, previousState: proposal.state, nextState: "accepted", metadata: { acceptedBy: input.acceptedBy, acceptanceEvidence: input.acceptanceEvidence } });
    return { success: true };
  }),
});
