import { processDueInvoiceCollections } from "../services/invoiceCollections";
import { replanFollowUp, replanFollowUpInput, snoozeFollowUp, snoozeFollowUpInput } from "../services/followupRecovery";
import { reconcileEmailDispatch, reconcileEmailInput } from "../services/emailReconciliation";
import { and, desc, eq, lt } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { approvals, candidates, consents, contacts, conversations, emailDispatches, emailIdentities, followUpPlans, interviews, invoices, messages, workflowEvents, workspaceSettings } from "../../drizzle/schema";
import { FOLLOW_UP_SCENARIOS } from "../../shared/followups";
import { protectedProcedure, router } from "../_core/trpc";
import { createId, ensureWorkspace, requireDb } from "../db";
import { enrollFollowUp, followUpInput } from "../services/followups";
import { controlFollowUp, grantFollowUpSending } from "../services/followupControl";
import { processDueAutomationBatch } from "../services/queue";
import { processDueInterviewReminders } from "../services/interviewReminders";
import { lockedSelect } from "../services/database";
import { appendWorkflowEvent } from "../services/workflowStore";

const idInput = z.object({ id: z.string().min(4) });
export const followupsRouter = router({
  catalog: protectedProcedure.query(() => FOLLOW_UP_SCENARIOS.map(([id, label, purpose]) => ({ id, label, purpose, enrollment: id === "FU18" ? "confirmed_interview" : ["FU26", "FU27"].includes(id) ? "invoice" : "owner_selected_conversation" }))),
  options: protectedProcedure.query(async ({ ctx }) => {
    const db = await requireDb(), owner = ctx.user.id;
    const [people, businessContacts, senders, threads, meetings, bills] = await Promise.all([
      db.select({ id: candidates.id, name: candidates.fullName, email: candidates.email, state: candidates.profileState }).from(candidates).where(eq(candidates.ownerId, owner)).limit(300),
      db.select({ id: contacts.id, name: contacts.name, email: contacts.email, permission: contacts.contactPermission, companyId: contacts.companyId }).from(contacts).where(eq(contacts.ownerId, owner)).limit(300),
      db.select().from(emailIdentities).where(eq(emailIdentities.ownerId, owner)),
      db.select().from(conversations).where(eq(conversations.ownerId, owner)).limit(300),
      db.select().from(interviews).where(eq(interviews.ownerId, owner)).limit(300),
      db.select().from(invoices).where(eq(invoices.ownerId, owner)).limit(300),
    ]);
    return { candidates: people, contacts: businessContacts, senders: senders.map(s => ({ id: s.id, email: s.email, purpose: s.purpose, status: s.status })), conversations: threads, interviews: meetings, invoices: bills };
  }),
  list: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(200).default(100) }).default({ limit: 100 })).query(async ({ ctx, input }) => (await requireDb()).select().from(followUpPlans).where(eq(followUpPlans.ownerId, ctx.user.id)).orderBy(desc(followUpPlans.updatedAt)).limit(input.limit)),
  detail: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    const db = await requireDb(), owner = ctx.user.id;
    const plan = (await db.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, owner), eq(followUpPlans.id, input.id))).limit(1))[0];
    if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "Follow-up was not found." });
    const dispatches = await db.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, owner), eq(emailDispatches.planId, plan.id))).orderBy(desc(emailDispatches.createdAt)).limit(50);
    const deliveries = await Promise.all(dispatches.map(async dispatch => ({ ...dispatch, resolutions: await db.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, owner), eq(workflowEvents.aggregateId, dispatch.id))).orderBy(desc(workflowEvents.createdAt)).limit(30), message: (await db.select().from(messages).where(and(eq(messages.ownerId, owner), eq(messages.id, dispatch.messageId))).limit(1))[0], approval: (await db.select().from(approvals).where(and(eq(approvals.ownerId, owner), eq(approvals.id, dispatch.approvalId))).limit(1))[0] })));
    const events = await db.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, owner), eq(workflowEvents.aggregateId, plan.id))).orderBy(desc(workflowEvents.createdAt)).limit(100);
    return { plan, deliveries, events };
  }),
  versions: protectedProcedure.input(idInput.extend({ cursor: z.number().int().positive().optional(), limit: z.number().int().min(1).max(30).default(10) })).query(async ({ ctx, input }) => {
    const db = await requireDb();
    const plan = (await db.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ctx.user.id), eq(followUpPlans.id, input.id))).limit(1))[0];
    if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "Follow-up was not found." });
    const rows = await db.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ctx.user.id), eq(workflowEvents.aggregateId, plan.id), eq(workflowEvents.eventType, "followup.definition_recorded"), ...(input.cursor ? [lt(workflowEvents.revision, input.cursor)] : []))).orderBy(desc(workflowEvents.revision)).limit(input.limit + 1);
    const items = rows.slice(0, input.limit);
    return { items, nextCursor: rows.length > input.limit ? items[items.length - 1].revision : undefined };
  }),
  enroll: protectedProcedure.input(followUpInput).mutation(({ ctx, input }) => enrollFollowUp(ctx.user.id, input, ctx.actor.id)),
  control: protectedProcedure.input(idInput.extend({ expectedRevision: z.number().int().positive(), action: z.enum(["pause", "resume", "cancel", "complete"]), reason: z.string().trim().min(3).max(500) })).mutation(({ ctx, input }) => controlFollowUp(ctx.user.id, input.id, input.action, input.reason, input.expectedRevision)),
  grantSending: protectedProcedure.input(idInput.extend({ expectedRevision: z.number().int().positive(), expiresAt: z.date(), maxSends: z.number().int().min(1).max(6) })).mutation(({ ctx, input }) => grantFollowUpSending(ctx.user.id, ctx.actor.id, input.id, input.expiresAt, input.maxSends, input.expectedRevision)),
  replan: protectedProcedure.input(replanFollowUpInput).mutation(({ ctx, input }) => replanFollowUp(ctx.user.id, ctx.actor.id, input)),
  snooze: protectedProcedure.input(snoozeFollowUpInput).mutation(({ ctx, input }) => snoozeFollowUp(ctx.user.id, ctx.actor.id, input)),
  reconcileDispatch: protectedProcedure.input(reconcileEmailInput).mutation(({ ctx, input }) => reconcileEmailDispatch(ctx.user.id, ctx.actor.id, input)),
  recoveryQueue: protectedProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const rows = await db.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ctx.user.id), eq(emailDispatches.status, "reconciliation_required"))).orderBy(desc(emailDispatches.claimedAt)).limit(100);
    return Promise.all(rows.map(async dispatch => ({ ...dispatch, message: (await db.select({ subject: messages.subject }).from(messages).where(and(eq(messages.ownerId, ctx.user.id), eq(messages.id, dispatch.messageId))).limit(1))[0] })));
  }),
  processDue: protectedProcedure.mutation(async ({ ctx }) => {
    const enrollment = await processDueInterviewReminders(ctx.user.id, 25);
    const collections = await processDueInvoiceCollections(ctx.user.id, 25);
    const batch = await processDueAutomationBatch(ctx.user.id, 25);
    return { enrollment, collections, batch };
  }),
  recordPermission: protectedProcedure.input(z.object({ candidateId: z.string().min(4).optional(), contactId: z.string().min(4).optional(), evidence: z.string().trim().min(12).max(1000), expiresAt: z.date() })).mutation(async ({ ctx, input }) => {
    if (Boolean(input.candidateId) === Boolean(input.contactId) || input.expiresAt <= new Date()) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose one recipient and a future expiry." });
    const db = await requireDb(), ownerId = ctx.user.id;
    await ensureWorkspace(ownerId);
    return db.transaction(async (tx: any) => {
      await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
      const table = input.candidateId ? candidates : contacts, personId = input.candidateId ?? input.contactId!;
      const person = (await tx.select().from(table).where(and(eq(table.ownerId, ownerId), eq(table.id, personId))).limit(1))[0];
      if (!person || person.withdrawnAt || person.deletedAt || person.doNotContactAt || person.optedOutAt || ["withdrawn", "deleted", "deletion_pending", "do_not_contact"].includes(person.profileState)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Recipient is unavailable for communication permission." });
      const evidenceId = createId("prm_");
      if (input.candidateId) await tx.insert(consents).values({ id: evidenceId, ownerId, candidateId: personId, consentType: "recruitment_communication", status: "granted", method: "owner_recorded", noticeVersion: "owner-evidence-v1", grantedAt: new Date(), expiresAt: input.expiresAt, dataScope: { evidence: input.evidence, recordedBy: ctx.actor.id } });
      else {
        // Contacts have no consent table; store expiry with the permission event and enforce it at dispatch.
        await tx.update(contacts).set({ contactPermission: "permitted", lastVerifiedAt: new Date() }).where(eq(contacts.id, personId));
      }
      const previous = (await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.aggregateId, personId), eq(workflowEvents.eventType, "communication.permission_recorded"))).orderBy(desc(workflowEvents.revision)).limit(1))[0];
      await appendWorkflowEvent(tx, ownerId, "communication.permission_recorded", personId, (previous?.revision ?? 0) + 1, { evidenceId, evidence: input.evidence, expiresAt: input.expiresAt.toISOString(), recordedBy: ctx.actor.id }, evidenceId);
      return { evidenceId };
    });
  }),
});
