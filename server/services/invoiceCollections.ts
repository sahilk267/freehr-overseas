import { assertTransition } from "../workflow";
import { and, asc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { contacts, invoiceCollectionSettings, invoicePaymentPromises, invoices, workspaceSettings } from "../../drizzle/schema";
import { ensureWorkspace, requireDb } from "../db";
import { formatMoney } from "../../shared/money";
import { lockedSelect } from "./database";

import { ACTIVE_COLLECTION_STATES, COLLECTIBLE_STATES, collectionEligibleAt, DAY_MS, invoiceCollectionFacts } from "./collectionFacts";
import { settlePaymentPromises } from "./collectionTimers";
import { enrollFollowUpInTransaction } from "./followups";
import { appendWorkflowEvent } from "./workflowStore";

export async function evaluateInvoiceCollection(ownerId: number, invoiceId: string, expectedRuleRevision?: number, now = new Date()) {
  const db = await requireDb(); await ensureWorkspace(ownerId);
  return db.transaction(async (tx: any) => {
    const workspace = (await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1)))[0];
    const invoice = (await lockedSelect(tx.select().from(invoices).where(and(eq(invoices.ownerId, ownerId), eq(invoices.id, invoiceId))).limit(1)))[0];
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice was not found." });
    let facts = await invoiceCollectionFacts(tx, ownerId, invoice, now);
    if (expectedRuleRevision !== undefined && expectedRuleRevision !== facts.rules?.revision) return { status: "cancelled", reason: "Superseded collection source intent." };
    // An evaluation cursor records past observation for fair bounded scans. All
    // future business deadlines are persisted as automationQueue jobs.
    if (facts.rules) await tx.update(invoiceCollectionSettings).set({ lastEvaluatedAt: now }).where(eq(invoiceCollectionSettings.id, facts.rules.id));
    if (workspace.emergencyStop) return { status: "deferred", nextActionAt: new Date(now.getTime() + 60000), reason: "Emergency stop is enabled." };
    await settlePaymentPromises(tx, ownerId, invoice.id, facts.paid, now);
    if (facts.promise?.status === "open" && facts.promise.dueAt <= now && facts.promisedRemaining > 0) {
      await tx.update(invoicePaymentPromises).set({ status: "missed" }).where(eq(invoicePaymentPromises.id, facts.promise.id));
      await appendWorkflowEvent(tx, ownerId, "invoice.promise_missed", invoice.id, facts.promise.revision, { promiseId: facts.promise.id }, facts.promise.id);
    }
    if (facts.remaining > 0 && invoice.dueAt && invoice.dueAt <= now && ["issued", "delivered", "payment_pending"].includes(invoice.status)) {
      assertTransition("invoice", invoice.status, "overdue");
      await tx.update(invoices).set({ status: "overdue" }).where(eq(invoices.id, invoice.id));
      await appendWorkflowEvent(tx, ownerId, "invoice.aged_overdue", invoice.id, 1, { dueAt: invoice.dueAt.toISOString(), source: "stored_due_date" }, invoice.dueAt.toISOString());
    }
    facts = await invoiceCollectionFacts(tx, ownerId, invoice, now);
    if (!facts.rules?.enabled) return { status: "disabled", reason: "Owner has not enabled collection follow-ups." };
    if (facts.reason) return { status: "held", reason: facts.reason };
    const rules = facts.rules;
    if (!invoice.dueAt) return { status: "held", reason: "An agreed invoice due date is required." };
    const eligibleAt = collectionEligibleAt(invoice.dueAt, rules.graceDays, workspace.businessTimezone);
    if (eligibleAt > now && facts.promiseState !== "missed") return { status: "deferred", nextActionAt: eligibleAt, reason: "Invoice grace period has not elapsed." };
    const active = facts.plans.find((p: any) => ACTIVE_COLLECTION_STATES.includes(p.status));
    if (active) return { status: "existing", planId: active.id, reason: "An existing collection sequence owns this invoice." };
    const contact = (await tx.select().from(contacts).where(and(eq(contacts.ownerId, ownerId), eq(contacts.id, rules.contactId))).limit(1))[0];
    if (!contact || contact.companyId !== invoice.companyId) return { status: "held", reason: "Invoice contact relationship changed." };
    const date = (at: Date) => new Intl.DateTimeFormat("en-IN", { timeZone: workspace.businessTimezone, dateStyle: "long" }).format(at);
    const promiseText = facts.promiseState === "missed" ? `\nYour recorded payment promise of ${formatMoney(facts.promise.amount, invoice.currency)} was due ${date(facts.promise.dueAt)}. Our receipts still leave ${formatMoney(facts.promisedRemaining, invoice.currency)} against that promise.\n` : "";
    const body = `Hello ${contact.name},\n\nInvoice ${invoice.invoiceNumber} was due ${date(invoice.dueAt)}. Recorded receipts: ${formatMoney(facts.paid, invoice.currency)}. Outstanding balance: ${formatMoney(facts.remaining, invoice.currency)}.\n${promiseText}\nPlease confirm payment timing, or reply with the payment reference if already paid. If you dispute this balance, reply so we can review it before further follow-up.\n\nTo stop these emails, reply STOP.`;
    const steps = [0, 3 * 1440, 4 * 1440].slice(0, rules.maxNudges).map((delayMinutes, index) => ({ delayMinutes, subject: `${index ? "Follow-up: " : ""}Invoice ${invoice.invoiceNumber} — ${formatMoney(facts.remaining, invoice.currency)} outstanding`, body }));
    try {
      const result = await enrollFollowUpInTransaction(tx, ownerId, { scenarioId: facts.promiseState === "missed" ? "FU27" : "FU26", contactId: contact.id, senderIdentityId: rules.senderIdentityId, resourceType: "invoice", resourceId: invoice.id, objective: `Review collection of invoice ${invoice.invoiceNumber}`, timezone: workspace.businessTimezone, businessDaysOnly: true, startsAt: now, deadlineAt: new Date(now.getTime() + 30 * DAY_MS), responseWindowMinutes: 3 * 1440, steps });
      await appendWorkflowEvent(tx, ownerId, "invoice.collection_enrolled", invoice.id, rules.revision, { planId: result.id, executionMode: "review", scenarioId: facts.promiseState === "missed" ? "FU27" : "FU26", balance: facts.remaining }, facts.fingerprint);
      return { status: result.alreadyEnrolled ? "existing" : "enrolled", planId: result.id };
    } catch (error) {
      if (!(error instanceof TRPCError)) throw error;
      await appendWorkflowEvent(tx, ownerId, "invoice.collection_blocked", invoice.id, rules.revision, { reason: error.message }, `${facts.fingerprint}:${Math.floor(now.getTime() / (15 * 60000))}`);
      return { status: "held", reason: error.message };
    }
  });
}

export async function processDueInvoiceCollections(ownerId?: number, limit = 25) {
  const db = await requireDb();
  const conditions = [eq(invoiceCollectionSettings.enabled, true)];
  if (ownerId !== undefined) conditions.push(eq(invoiceCollectionSettings.ownerId, ownerId));
  const rules = await db.select().from(invoiceCollectionSettings).where(and(...conditions)).orderBy(asc(invoiceCollectionSettings.lastEvaluatedAt), asc(invoiceCollectionSettings.id)).limit(Math.max(1, Math.min(25, limit)));
  let enrolled = 0, held = 0, failed = 0;
  for (const rule of rules) {
    try { const result = await evaluateInvoiceCollection(rule.ownerId, rule.invoiceId, rule.revision); if (result.status === "enrolled") enrolled++; if (result.status === "held") held++; }
    catch {
      failed++;
      // A failed source cannot monopolize the first page after a rollback.
      await db.update(invoiceCollectionSettings).set({ lastEvaluatedAt: new Date() }).where(and(eq(invoiceCollectionSettings.id, rule.id), eq(invoiceCollectionSettings.revision, rule.revision)));
      await appendWorkflowEvent(db, rule.ownerId, "invoice.collection_source_failed", rule.invoiceId, rule.revision, { reason: "Collection source evaluation failed; review invoice evidence and database configuration." }, String(Math.floor(Date.now() / (15 * 60000))));
    }
  }
  return { scanned: rules.length, enrolled, held, failed };
}
