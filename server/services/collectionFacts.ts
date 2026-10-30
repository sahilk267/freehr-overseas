import { and, desc, eq, inArray } from "drizzle-orm";
import { approvals, conversations, messages, emailDispatches, followUpPlans, invoiceCollectionSettings, invoicePaymentPromises, payments } from "../../drizzle/schema";
import { lockedSelect } from "./database";
import { localClock } from "./workflowTiming";
import { workflowHash } from "./workflowStore";

export const COLLECTIBLE_STATES = ["issued", "delivered", "payment_pending", "partially_paid", "overdue"];
export const ACTIVE_COLLECTION_STATES = ["scheduled", "waiting", "approval_pending", "paused", "blocked"];
export const DAY_MS = 86400000;

export function collectionEligibleAt(dueAt: Date, graceDays: number, timezone: string) {
  if (!graceDays) return new Date(dueAt);
  const targetDay = new Date(Date.parse(`${localClock(dueAt, timezone).day}T00:00:00Z`) + graceDays * DAY_MS).toISOString().slice(0, 10);
  let low = dueAt.getTime(), high = low + (graceDays + 2) * DAY_MS;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (localClock(new Date(mid), timezone).day >= targetDay) high = mid; else low = mid;
  }
  return new Date(high);
}

export function agingDays(dueAt: Date | null, now: Date, timezone: string) {
  if (!dueAt || dueAt > now) return 0;
  return Math.max(0, Math.round((Date.parse(`${localClock(now, timezone).day}T00:00:00Z`) - Date.parse(`${localClock(dueAt, timezone).day}T00:00:00Z`)) / DAY_MS));
}

export async function collectionReplyCursor(tx: any, ownerId: number, contactId: string, lock = true) {
  const read = (query: any) => lock ? lockedSelect(query) : query;
  const threads = await tx.select().from(conversations).where(and(eq(conversations.ownerId, ownerId), eq(conversations.contactId, contactId)));
  const cursor: string[] = [];
  for (const thread of threads) {
    const inbound = await read(tx.select().from(messages).where(and(eq(messages.ownerId, ownerId), eq(messages.conversationId, thread.id), eq(messages.direction, "inbound"))).orderBy(desc(messages.createdAt)).limit(100));
    cursor.push(...inbound.map((m: typeof messages.$inferSelect) => m.id));
  }
  return cursor;
}

export async function invoiceCollectionFacts(tx: any, ownerId: number, invoice: any, now = new Date(), lock = true) {
  const read = (query: any) => lock ? lockedSelect(query) : query;
  const receipts = await read(tx.select().from(payments).where(and(eq(payments.ownerId, ownerId), eq(payments.invoiceId, invoice.id), eq(payments.status, "succeeded"))));
  if (receipts.some((r: typeof payments.$inferSelect) => r.currency !== invoice.currency || !Number.isSafeInteger(r.amount) || r.amount <= 0)) throw new Error("Receipt evidence does not match the invoice currency or amount.");
  const paid = receipts.reduce((sum: number, r: typeof payments.$inferSelect) => sum + r.amount, 0), total = invoice.amount + (invoice.taxAmount ?? 0), remaining = total - paid;
  if (![paid, total, remaining].every(Number.isSafeInteger) || total <= 0 || remaining < 0) throw new Error("Invoice balance requires financial reconciliation.");
  const rules = (await read(tx.select().from(invoiceCollectionSettings).where(and(eq(invoiceCollectionSettings.ownerId, ownerId), eq(invoiceCollectionSettings.invoiceId, invoice.id))).limit(1)))[0] ?? null;
  const promise = (await read(tx.select().from(invoicePaymentPromises).where(and(eq(invoicePaymentPromises.ownerId, ownerId), eq(invoicePaymentPromises.invoiceId, invoice.id))).orderBy(desc(invoicePaymentPromises.revision)).limit(1)))[0] ?? null;
  if (promise && promise.currency !== invoice.currency) throw new Error("Invoice balance requires financial reconciliation.");
  const promiseState = promise?.status === "open" && promise.dueAt <= now ? "missed" : promise?.status ?? null;
  const financialReview = (await read(tx.select().from(approvals).where(and(eq(approvals.ownerId, ownerId), eq(approvals.resourceId, invoice.id), eq(approvals.resourceType, "invoice"), inArray(approvals.actionType, ["invoice_dispute", "invoice_credit", "invoice_write_off"]), eq(approvals.status, "pending"))).limit(1)))[0];
  const plans = await tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.resourceType, "invoice"), eq(followUpPlans.resourceId, invoice.id)));
  const unresolved = plans.length ? await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId, ownerId), inArray(emailDispatches.planId, plans.map((p: typeof followUpPlans.$inferSelect) => p.id)), inArray(emailDispatches.status, ["dispatching", "reconciliation_required"]))).limit(1) : [];
  const hasUnreviewedReply = rules ? (await collectionReplyCursor(tx, ownerId, rules.contactId, lock)).some(id => !rules.replyCursor.includes(id)) : false;
  const reason = !COLLECTIBLE_STATES.includes(invoice.status) ? "Invoice is not collectible." : remaining === 0 ? "No outstanding invoice balance." : financialReview ? "A financial dispute or adjustment is awaiting owner review." : rules && (!rules.enabled || rules.onHold) ? rules.onHold ? "Collections are on owner hold." : "Collection follow-ups are disabled." : promiseState === "open" ? "A payment promise is still within its agreed time." : unresolved.length ? "A previous collection attempt requires delivery reconciliation." : hasUnreviewedReply ? "Client replied; review collection settings before another collection cycle." : null;
  const fingerprint = workflowHash(["invoice", invoice.id, invoice.amount, invoice.taxAmount ?? 0, invoice.currency, invoice.dueAt?.toISOString() ?? null, paid, rules?.revision ?? null, promise ? [promise.id, promise.revision, promise.amount, promise.baselinePaid, promise.dueAt.toISOString(), promiseState] : null]);
  return { paid, total, remaining, rules, promise, promiseState, hasUnreviewedReply, promisedRemaining: promise ? Math.max(0, promise.amount - Math.max(0, paid - promise.baselinePaid)) : 0, reason, fingerprint, plans };
}
