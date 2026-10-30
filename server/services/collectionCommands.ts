import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { contacts, conversations, emailIdentities, invoiceCollectionSettings, invoicePaymentPromises, invoices, messages, workspaceSettings } from "../../drizzle/schema";
import { createId, ensureWorkspace, requireDb } from "../db";
import { lockedSelect } from "./database";
import { COLLECTIBLE_STATES, collectionEligibleAt, collectionReplyCursor, DAY_MS, invoiceCollectionFacts } from "./collectionFacts";
import { cancelCollectionTimer, scheduleCollectionEvaluation } from "./collectionTimers";
import { stopRelatedFollowUps } from "./followups";
import { appendWorkflowEvent, workflowHash } from "./workflowStore";

export const collectionSettingsInput = z.object({ invoiceId: z.string().min(4), expectedRevision: z.number().int().min(0), contactId: z.string().min(4), senderIdentityId: z.string().min(4), enabled: z.boolean(), onHold: z.boolean(), graceDays: z.number().int().min(0).max(30), maxNudges: z.number().int().min(1).max(3), reason: z.string().trim().min(8).max(500), reviewedReplies: z.literal(true) }).strict();
export const paymentPromiseInput = z.object({ invoiceId: z.string().min(4), expectedPromiseId: z.string().min(4).nullable(), idempotencyKey: z.string().min(12).max(128), amount: z.number().int().positive().max(2147483647), dueAt: z.date(), evidence: z.string().trim().min(12).max(1500), acknowledgeNotPayment: z.literal(true) }).strict();
export const cancelPromiseInput = z.object({ invoiceId: z.string().min(4), promiseId: z.string().min(4), reason: z.string().trim().min(8).max(500) }).strict();

async function lockInvoice(tx: any, ownerId: number, invoiceId: string) {
  await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
  const invoice = (await lockedSelect(tx.select().from(invoices).where(and(eq(invoices.ownerId, ownerId), eq(invoices.id, invoiceId))).limit(1)))[0];
  if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice was not found." });
  return { ...invoice };
}

export async function saveCollectionSettings(ownerId: number, actorId: number, raw: z.input<typeof collectionSettingsInput>) {
  const input = collectionSettingsInput.parse(raw), db = await requireDb(); await ensureWorkspace(ownerId);
  return db.transaction(async (tx: any) => {
    const invoice = await lockInvoice(tx, ownerId, input.invoiceId);
    const previous = (await lockedSelect(tx.select().from(invoiceCollectionSettings).where(and(eq(invoiceCollectionSettings.ownerId, ownerId), eq(invoiceCollectionSettings.invoiceId, invoice.id))).limit(1)))[0];
    if ((previous?.revision ?? 0) !== input.expectedRevision) throw new TRPCError({ code: "CONFLICT", message: "Collection settings changed. Reload and review the current version." });
    const contact = (await lockedSelect(tx.select().from(contacts).where(and(eq(contacts.ownerId, ownerId), eq(contacts.id, input.contactId))).limit(1)))[0];
    const sender = (await lockedSelect(tx.select().from(emailIdentities).where(and(eq(emailIdentities.ownerId, ownerId), eq(emailIdentities.id, input.senderIdentityId))).limit(1)))[0];
    if (!contact?.email || contact.companyId !== invoice.companyId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Choose an owned contact from this invoice's company." });
    if (!sender || sender.purpose !== "finance" || (input.enabled && sender.status !== "active")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Choose an active finance sender for collection follow-ups." });
    if (input.enabled && (!COLLECTIBLE_STATES.includes(invoice.status) || !invoice.dueAt)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Enable collections only for an issued, collectible invoice with an agreed due date." });
    const id = previous?.id ?? createId("col_"), revision = (previous?.revision ?? 0) + 1;
    const values = { ownerId, invoiceId: invoice.id, contactId: contact.id, senderIdentityId: sender.id, enabled: input.enabled, onHold: input.onHold, holdReason: input.onHold ? input.reason : null, graceDays: input.graceDays, maxNudges: input.maxNudges, replyCursor: await collectionReplyCursor(tx, ownerId, contact.id), revision, updatedById: actorId, lastEvaluatedAt: null };
    if (previous) { await cancelCollectionTimer(tx, ownerId, `collection_source:${id}:${previous.revision}`); await tx.update(invoiceCollectionSettings).set(values).where(eq(invoiceCollectionSettings.id, id)); }
    else await tx.insert(invoiceCollectionSettings).values({ id, ...values });
    await stopRelatedFollowUps(tx, ownerId, { resourceType: "invoice", resourceId: invoice.id }, "Owner changed collection intent; review a new sequence.", "cancelled");
    if (input.enabled && !input.onHold) {
      const workspace = (await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1))[0];
      const eligibleAt = collectionEligibleAt(invoice.dueAt, input.graceDays, workspace.businessTimezone);
      await scheduleCollectionEvaluation(tx, ownerId, invoice.id, `collection_source:${id}:${revision}`, new Date(Math.max(Date.now(), eligibleAt.getTime())), revision);
    }
    await appendWorkflowEvent(tx, ownerId, "invoice.collections_configured", invoice.id, revision, { actorId, reason: input.reason, enabled: input.enabled, onHold: input.onHold, contactId: contact.id, maxNudges: input.maxNudges, graceDays: input.graceDays });
    return { id, revision, enabled: input.enabled, onHold: input.onHold };
  });
}

export async function recordPaymentPromise(ownerId: number, actorId: number, raw: z.input<typeof paymentPromiseInput>) {
  const input = paymentPromiseInput.parse(raw), db = await requireDb(), now = new Date(); await ensureWorkspace(ownerId);
  const commandHash = workflowHash([input.invoiceId, input.amount, input.dueAt.toISOString(), input.evidence, input.expectedPromiseId]);
  return db.transaction(async (tx: any) => {
    const invoice = await lockInvoice(tx, ownerId, input.invoiceId);
    const existing = (await lockedSelect(tx.select().from(invoicePaymentPromises).where(and(eq(invoicePaymentPromises.ownerId, ownerId), eq(invoicePaymentPromises.idempotencyKey, input.idempotencyKey))).limit(1)))[0];
    if (existing) {
      if (existing.commandHash !== commandHash) throw new TRPCError({ code: "CONFLICT", message: "This promise reference was already used for different evidence." });
      return { id: existing.id, revision: existing.revision, alreadyRecorded: true };
    }
    const facts = await invoiceCollectionFacts(tx, ownerId, invoice, now);
    if (!COLLECTIBLE_STATES.includes(invoice.status) || !facts.remaining || input.amount > facts.remaining) throw new TRPCError({ code: "BAD_REQUEST", message: "A promise must be positive and cannot exceed this collectible invoice's remaining balance." });
    if (input.dueAt <= now || input.dueAt.getTime() > now.getTime() + 180 * DAY_MS) throw new TRPCError({ code: "BAD_REQUEST", message: "Promise time must be in the future and within 180 days." });
    const current = facts.promise && ["open", "missed"].includes(facts.promise.status) ? facts.promise : null;
    if ((current?.id ?? null) !== input.expectedPromiseId) throw new TRPCError({ code: "CONFLICT", message: "The active payment promise changed. Review it before replacing it." });
    if (current) {
      await tx.update(invoicePaymentPromises).set({ status: "superseded", settledAt: now }).where(eq(invoicePaymentPromises.id, current.id));
      await cancelCollectionTimer(tx, ownerId, `collection_promise:${current.id}`);
    }
    const id = createId("prm_"), revision = (facts.promise?.revision ?? 0) + 1;
    await tx.insert(invoicePaymentPromises).values({ id, ownerId, invoiceId: invoice.id, revision, amount: input.amount, currency: invoice.currency, baselinePaid: facts.paid, dueAt: input.dueAt, status: "open", evidence: input.evidence, idempotencyKey: input.idempotencyKey, commandHash, recordedById: actorId, settledAt: null });
    await stopRelatedFollowUps(tx, ownerId, { resourceType: "invoice", resourceId: invoice.id }, "Payment promise recorded; collection messages are held until its deadline.", "cancelled");
    await scheduleCollectionEvaluation(tx, ownerId, invoice.id, `collection_promise:${id}`, input.dueAt);
    await appendWorkflowEvent(tx, ownerId, "invoice.promise_recorded", invoice.id, revision, { actorId, promiseId: id, amount: input.amount, currency: invoice.currency, dueAt: input.dueAt.toISOString(), source: "owner_recorded", replaces: current?.id ?? null }, id);
    return { id, revision, alreadyRecorded: false };
  });
}

export async function cancelPaymentPromise(ownerId: number, actorId: number, raw: z.input<typeof cancelPromiseInput>) {
  const input = cancelPromiseInput.parse(raw), db = await requireDb();
  return db.transaction(async (tx: any) => {
    const invoice = await lockInvoice(tx, ownerId, input.invoiceId);
    const promise = (await lockedSelect(tx.select().from(invoicePaymentPromises).where(and(eq(invoicePaymentPromises.ownerId, ownerId), eq(invoicePaymentPromises.invoiceId, invoice.id), eq(invoicePaymentPromises.id, input.promiseId))).limit(1)))[0];
    if (!promise || !["open", "missed"].includes(promise.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This payment promise is no longer active." });
    await tx.update(invoicePaymentPromises).set({ status: "cancelled", settledAt: new Date() }).where(eq(invoicePaymentPromises.id, promise.id));
    await cancelCollectionTimer(tx, ownerId, `collection_promise:${promise.id}`);
    await stopRelatedFollowUps(tx, ownerId, { resourceType: "invoice", resourceId: invoice.id }, "Payment promise cancelled; review collection context again.", "cancelled");
    await scheduleCollectionEvaluation(tx, ownerId, invoice.id, `collection_promise_cancelled:${promise.id}`, new Date());
    await appendWorkflowEvent(tx, ownerId, "invoice.promise_cancelled", invoice.id, promise.revision, { actorId, reason: input.reason, promiseId: promise.id }, promise.id);
    return { status: "cancelled" };
  });
}
