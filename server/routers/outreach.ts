import {amendAgreement,withdrawAgreementDraft,createAgreement,agreementHistory,getAgreement,reviseAgreement,agreementReviseInput,bindAgreementToJob,jobCommercialOptions,recordAgreementAcceptance} from '../services/commercialAgreements';
import {agreementTermsSchema} from '../../shared/commercialAgreement';
import { cancelReplyEmail, prepareReplyEmail } from "../services/replyMail";
import { completeReplyAction, clientReplyCase, receiveReply, recordReplyAction, REPLY_ACTIONS } from "../services/replyTriage";
import {redactAvailabilityLinks} from "../services/privateLinkRedaction";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { companies, contacts, conversations, feeProposals, messages, automationQueue } from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { ensureSafeAiText } from "../workflow";
import { DEFAULT_GUARANTEE_DAYS } from "../services/guaranteeTracking";

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
    await db.insert(automationQueue).values({ id: queueId, ownerId: ctx.user.id, jobType: "draft_outreach", payload: { messageId, purpose: input.purpose, contact: { name: contact.name, title: contact.title, companyId: contact.companyId }, context: input.context, policy: "Draft only. Include a clear opt-out. No message may be sent automatically." }, idempotencyKey: `draft_outreach:${messageId}` });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "outreach.draft_queued", resourceType: "message", resourceId: messageId, nextState: "drafting", metadata: { conversationId, queueId, purpose: input.purpose } });
    return { conversationId, messageId, queueId };
  }),
  classifyInboundReply: protectedProcedure.input(z.object({ conversationId: z.string().min(4), messageText: z.string().trim().min(1).max(12000) })).mutation(async ({ ctx, input }) => {
    const messageText=redactAvailabilityLinks(input.messageText);
    ensureSafeAiText(messageText);
    const db = await requireDb();
    const conversation = (await db.select().from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.ownerId, ctx.user.id))).limit(1))[0];
    if (!conversation) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation was not found." });
    return receiveReply(ctx.user.id, { conversationId: conversation.id, body: messageText, source: "owner_recorded_reply" });
  }),
  cancelReplyEmail: protectedProcedure.input(z.object({ approvalId: z.string().min(4), reason: z.string().trim().min(8).max(500) })).mutation(({ ctx, input }) => cancelReplyEmail(ctx.user.id, input.approvalId, input.reason)),
  prepareReplyEmail: protectedProcedure.input(z.object({ conversationId: z.string().min(4), messageId: z.string().min(4), replyRevision: z.number().int().positive(), actionRevision: z.number().int().positive(), senderIdentityId: z.string().min(4), subject: z.string().trim().min(1).max(255), body: z.string().trim().min(8).max(11500) })).mutation(({ ctx, input }) => prepareReplyEmail(ctx.user.id, input)),
  replyCase: protectedProcedure.input(z.object({ conversationId: z.string().min(4) })).query(async ({ ctx, input }) => clientReplyCase(await requireDb(), ctx.user.id, input.conversationId)),
  completeReplyAction: protectedProcedure.input(z.object({conversationId:z.string().min(4).max(36),messageId:z.string().min(4).max(36),replyRevision:z.number().int().positive(),actionRevision:z.number().int().positive(),reason:z.string().trim().min(8).max(2000)})).mutation(({ctx,input})=>completeReplyAction(ctx.user.id,input)),
  recordReplyAction: protectedProcedure.input(z.object({ conversationId: z.string().min(4), messageId: z.string().min(4), replyRevision: z.number().int().positive(), expectedActionRevision: z.number().int().min(0), action: z.enum(REPLY_ACTIONS), notes: z.string().trim().min(8).max(2000), dueAt: z.coerce.date().optional() })).mutation(({ ctx, input }) => recordReplyAction(ctx.user.id, input)),
  list: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 })).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.select().from(conversations).where(eq(conversations.ownerId, ctx.user.id)).orderBy(desc(conversations.updatedAt)).limit(input.limit);
  }),
});

const agreementDraftFlatInput=z.object({companyId:z.string().min(4),requestKey:z.string().min(8).max(100).optional(),feeType:z.enum(['percentage','fixed']),feeValue:z.string(),currency:z.string().default('INR'),guaranteeDays:z.number().default(90),paymentTermsDays:z.number().default(30),ownershipDays:z.number().default(180),termsText:z.string(),taxRateBasisPoints:z.number().default(0)}).superRefine((v,ctx)=>{const {companyId,requestKey,...terms}=v;const r=agreementTermsSchema.safeParse(terms);if(!r.success)for(const issue of r.error.issues)ctx.addIssue({...issue,path:issue.path} as any);});
export const agreementsRouter = router({
  list: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 })).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.select().from(feeProposals).where(eq(feeProposals.ownerId, ctx.user.id)).orderBy(desc(feeProposals.updatedAt)).limit(input.limit);
  }),
  amend:protectedProcedure.input(z.object({id:z.string().min(4).max(36),expectedTermsHash:z.string().length(64),requestKey:z.string().min(8).max(100),reason:z.string().trim().min(8).max(2000)})).mutation(({ctx,input})=>amendAgreement(ctx.user.id,ctx.actor.id,input)),
  withdrawDraft:protectedProcedure.input(z.object({id:z.string().min(4).max(36),expectedVersion:z.number().int().positive(),expectedTermsHash:z.string().length(64),reason:z.string().trim().min(8).max(2000)})).mutation(({ctx,input})=>withdrawAgreementDraft(ctx.user.id,ctx.actor.id,input)),
  detail:protectedProcedure.input(z.object({id:z.string().min(4).max(36)})).query(({ctx,input})=>getAgreement(ctx.user.id,input.id)),
  history:protectedProcedure.input(z.object({id:z.string().min(4).max(36)})).query(({ctx,input})=>agreementHistory(ctx.user.id,input.id)),
  revise:protectedProcedure.input(agreementReviseInput).mutation(({ctx,input})=>reviseAgreement(ctx.user.id,ctx.actor.id,input)),
  jobOptions:protectedProcedure.input(z.object({proposalId:z.string().min(4).max(36)})).query(({ctx,input})=>jobCommercialOptions(ctx.user.id,input.proposalId)),
  bindJob:protectedProcedure.input(z.object({jobId:z.string().min(4).max(36),proposalId:z.string().min(4).max(36),expectedTermsHash:z.string().length(64),expectedJobFingerprint:z.string().length(64),reason:z.string().trim().min(8).max(2000)})).mutation(({ctx,input})=>bindAgreementToJob(ctx.user.id,ctx.actor.id,input)),
  draft:protectedProcedure.input(agreementDraftFlatInput).mutation(({ctx,input})=>{const {companyId,requestKey,...terms}=input;return createAgreement(ctx.user.id,ctx.actor.id,{companyId,requestKey,terms});}),
  recordAcceptance:protectedProcedure.input(z.object({proposalId:z.string().min(4),acceptedBy:z.string().email(),acceptanceEvidence:z.string().trim().min(10).max(2000),expectedVersion:z.number().int().positive().optional(),expectedTermsHash:z.string().length(64).optional()})).mutation(({ctx,input})=>recordAgreementAcceptance(ctx.user.id,ctx.actor.id,input)),
});
