import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { contacts, emailIdentities, invoicePaymentPromises, invoices, workflowEvents, workspaceSettings } from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { ensureWorkspace, requireDb } from "../db";
import { agingDays, COLLECTIBLE_STATES, invoiceCollectionFacts } from "../services/collectionFacts";
import { cancelPaymentPromise, cancelPromiseInput, collectionSettingsInput, paymentPromiseInput, recordPaymentPromise, saveCollectionSettings } from "../services/collectionCommands";
import { processDueInvoiceCollections } from "../services/invoiceCollections";

export const collectionsRouter = router({
  ledger: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(25), cursor: z.string().min(4).optional() })).query(async ({ ctx, input }) => {
    const db = await requireDb(); const workspace = await ensureWorkspace(ctx.user.id); const now = new Date();
    return db.transaction(async (tx: any) => {
      const rows = await tx.select().from(invoices).where(and(eq(invoices.ownerId, ctx.user.id), ...(input.cursor ? [gt(invoices.id, input.cursor)] : []))).orderBy(asc(invoices.id)).limit(input.limit + 1);
      const items = await Promise.all(rows.slice(0, input.limit).map(async invoice => {
        try {
          const facts = await invoiceCollectionFacts(tx, ctx.user.id, invoice, now, false);
          const days = agingDays(invoice.dueAt, now, workspace.businessTimezone);
          const collectible = COLLECTIBLE_STATES.includes(invoice.status), overdue = collectible && facts.remaining > 0 && invoice.dueAt && invoice.dueAt < now;
          return { ...invoice, paid: facts.paid, remaining: facts.remaining, daysPastDue: days, agingBucket: !facts.remaining ? "settled" : invoice.status === "disputed" ? "disputed" : !collectible ? ["draft", "validation", "approval_pending"].includes(invoice.status) ? "not issued" : "closed" : !invoice.dueAt ? "undated" : !overdue ? "current" : days <= 30 ? "1–30 days" : days <= 60 ? "31–60 days" : days <= 90 ? "61–90 days" : "90+ days", collectionsEnabled: facts.rules?.enabled ?? false, onHold: facts.rules?.onHold ?? false, promise: facts.promise ? { id: facts.promise.id, amount: facts.promise.amount, dueAt: facts.promise.dueAt, status: facts.promiseState, remaining: facts.promisedRemaining } : null, holdReason: facts.reason, reconciliationIssue: invoice.status === "paid" && facts.remaining > 0 ? "Paid state is not supported by the recorded receipts." : null };
        } catch (error) { if (!(error instanceof Error) || !/^(Receipt evidence|Invoice balance)/.test(error.message)) throw error; return { ...invoice, paid: null, remaining: null, daysPastDue: 0, agingBucket: "review_required", collectionsEnabled: false, onHold: true, promise: null, holdReason: "Invoice evidence requires reconciliation.", reconciliationIssue: "Verify receipt currency and invoice balance before collection." }; }
      }));
      return { items, nextCursor: rows.length > input.limit ? rows[input.limit - 1].id : undefined, timezone: workspace.businessTimezone, asOf: now };
    });
  }),
  detail: protectedProcedure.input(z.object({ invoiceId: z.string().min(4) })).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.transaction(async (tx: any) => {
      const invoice = (await tx.select().from(invoices).where(and(eq(invoices.ownerId, ctx.user.id), eq(invoices.id, input.invoiceId))).limit(1))[0];
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice was not found." });
      const facts = await invoiceCollectionFacts(tx, ctx.user.id, invoice, new Date(), false);
      const diagnostics = await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ctx.user.id), eq(workflowEvents.aggregateId, invoice.id), inArray(workflowEvents.eventType, ["invoice.collection_blocked", "invoice.collection_enrolled", "invoice.collection_source_failed"]))).orderBy(desc(workflowEvents.createdAt)).limit(5);
      return { invoice, diagnostics, settings: facts.rules, paid: facts.paid, remaining: facts.remaining, holdReason: facts.reason, promiseState: facts.promiseState,
        promises: await tx.select().from(invoicePaymentPromises).where(and(eq(invoicePaymentPromises.ownerId, ctx.user.id), eq(invoicePaymentPromises.invoiceId, invoice.id))).orderBy(desc(invoicePaymentPromises.revision)).limit(30),
        contacts: await tx.select({ id: contacts.id, name: contacts.name, email: contacts.email, permission: contacts.contactPermission }).from(contacts).where(and(eq(contacts.ownerId, ctx.user.id), eq(contacts.companyId, invoice.companyId))).limit(200),
        senders: await tx.select({ id: emailIdentities.id, email: emailIdentities.email, status: emailIdentities.status }).from(emailIdentities).where(and(eq(emailIdentities.ownerId, ctx.user.id), eq(emailIdentities.purpose, "finance"))) };
    });
  }),
  saveSettings: protectedProcedure.input(collectionSettingsInput).mutation(({ ctx, input }) => saveCollectionSettings(ctx.user.id, ctx.actor.id, input)),
  recordPromise: protectedProcedure.input(paymentPromiseInput).mutation(({ ctx, input }) => recordPaymentPromise(ctx.user.id, ctx.actor.id, input)),
  cancelPromise: protectedProcedure.input(cancelPromiseInput).mutation(({ ctx, input }) => cancelPaymentPromise(ctx.user.id, ctx.actor.id, input)),
  processDue: protectedProcedure.mutation(({ ctx }) => processDueInvoiceCollections(ctx.user.id, 25)),
});
