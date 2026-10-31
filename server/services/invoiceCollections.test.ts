import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { automationQueue, contacts, emailDispatches, followUpPlans, invoiceCollectionSettings, invoicePaymentPromises, invoices, messages, payments, workspaceSettings } from "../../drizzle/schema";
import { createId } from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { collectionEligibleAt, DAY_MS } from "./collectionFacts";
import { evaluateInvoiceCollection, processDueInvoiceCollections } from "./invoiceCollections";
import { saveCollectionSettings } from "./collectionCommands";
import { deliverApprovedEmail } from "./emailDelivery";
import { processDueAutomationBatch } from "./queue";

const send = vi.hoisted(() => vi.fn(async () => ({ providerMessageId: "synthetic-collection-receipt" })));
vi.mock("./hostingerMail", async original => ({ ...await original(), isSenderIdentityConfigured: () => true, sendViaHostingerMailApi: send }));
type Fixture = Awaited<ReturnType<typeof followupFixture>>;
async function fixture() { const f = await followupFixture(); await f.db.update(invoices).set({ dueAt: new Date(Date.now() - 2 * DAY_MS) }).where(eq(invoices.id, f.invoiceId)); return f; }
async function configure(f: Fixture, patch: Record<string, unknown> = {}) {
  const row = (await f.db.select().from(invoiceCollectionSettings).where(eq(invoiceCollectionSettings.invoiceId, f.invoiceId)))[0];
  return f.caller.collections.saveSettings({ invoiceId: f.invoiceId, expectedRevision: row?.revision ?? 0, contactId: f.contactId, senderIdentityId: f.senders.finance, enabled: true, onHold: false, graceDays: 0, maxNudges: 3, reviewedReplies: true, reason: "Owner reviewed the invoice and current client conversation", ...patch } as never);
}
const promiseInput = (f: Fixture, patch: Record<string, unknown> = {}) => ({ invoiceId: f.invoiceId, expectedPromiseId: null, idempotencyKey: createId("promise_command_"), amount: 5000, dueAt: new Date(Date.now() + DAY_MS), evidence: "Client confirmed this synthetic amount and payment date by email", acknowledgeNotPayment: true as const, ...patch });
async function invoicePlans(f: Fixture) { return f.db.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, f.ownerId), eq(followUpPlans.resourceType, "invoice"), eq(followUpPlans.resourceId, f.invoiceId))); }
async function payment(f: Fixture, amount: number) { return f.caller.recruitment.invoices.recordPayment({ id: f.invoiceId, provider: "test_bank", providerEventId: createId("receipt_"), amount }); }

describe("invoice aging, promises and central collection enrollment", () => {
  beforeEach(() => send.mockReset().mockResolvedValue({ providerMessageId: "synthetic-collection-receipt" }));
  it("calculates grace boundaries on local calendar days across DST", () => {
    expect(collectionEligibleAt(new Date("2026-03-07T17:00:00Z"), 1, "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(collectionEligibleAt(new Date("2026-03-07T17:00:00Z"), 2, "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(collectionEligibleAt(new Date("2026-10-28T21:00:00Z"), 0, "Asia/Kolkata").toISOString()).toBe("2026-10-28T21:00:00.000Z");
  });
  it("keeps unconfigured invoices out of automatic enrollment and derives aging from due dates", async () => {
    const f = await fixture();
    expect(await processDueInvoiceCollections(f.ownerId)).toMatchObject({ scanned: 0, enrolled: 0 });
    const ledger = await f.caller.collections.ledger({ limit: 25 });
    expect(ledger.items[0]).toMatchObject({ paid: 0, remaining: 10000, agingBucket: "1–30 days", collectionsEnabled: false });
    expect(send).not.toHaveBeenCalled();
  });
  it("creates one bounded review sequence, with exact balance and queue-owned timers", async () => {
    const f = await fixture(); await configure(f);
    const first = await evaluateInvoiceCollection(f.ownerId, f.invoiceId);
    expect(first.status).toBe("enrolled");
    expect(await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).toMatchObject({ status: "existing", planId: first.planId });
    const plans = await invoicePlans(f);
    expect(plans).toHaveLength(1); expect(plans[0]).toMatchObject({ scenarioId: "FU26", executionMode: "review", recipient: `${f.contactId}@example.test`.toLowerCase() });
    expect(plans[0].steps.map((s: any) => s.delayMinutes)).toEqual([0, 4320, 5760]);
    expect(plans[0].steps[0].body).toContain("100.00");
    await processDueAutomationBatch(f.ownerId, 5);
    const outbox = await f.db.select().from(emailDispatches).where(eq(emailDispatches.planId, plans[0].id));
    expect(outbox).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });
  it("defers future due dates and grace periods rather than preparing premature messages", async () => {
    const f = await fixture(); await configure(f, { graceDays: 10 });
    expect(await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).toMatchObject({ status: "deferred" });
    expect(await invoicePlans(f)).toHaveLength(0);
    await f.db.update(invoices).set({ status: "payment_pending", dueAt: new Date(Date.now() + DAY_MS) }).where(eq(invoices.id, f.invoiceId));
    expect(await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).toMatchObject({ status: "deferred" });
    expect((await f.db.select().from(invoices).where(eq(invoices.id, f.invoiceId)))[0].status).toBe("payment_pending");
    // A stale invoice state cannot make a fully receipted obligation overdue.
    await payment(f, 10000);
    await f.db.update(invoices).set({ status: "issued", dueAt: new Date(Date.now() - DAY_MS) }).where(eq(invoices.id, f.invoiceId));
    expect(await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).toMatchObject({ status: "held", reason: "No outstanding invoice balance." });
    expect((await f.db.select().from(invoices).where(eq(invoices.id, f.invoiceId)))[0].status).toBe("issued");
    expect(send).not.toHaveBeenCalled();
  });
  it("requires an issued invoice due date and a contact from its actual company", async () => {
    const f = await fixture(), other = await fixture();
    await expect(configure(f, { contactId: other.contactId })).rejects.toThrow(/owned contact/);
    await f.db.update(invoices).set({ dueAt: null }).where(eq(invoices.id, f.invoiceId));
    await expect(configure(f)).rejects.toThrow(/due date/);
    await expect(configure(f, { senderIdentityId: f.senders.talent })).rejects.toThrow(/finance sender/);
    await f.db.update(invoices).set({ dueAt: new Date(Date.now() - DAY_MS) }).where(eq(invoices.id, f.invoiceId));
    await configure(f, { maxNudges: 1 });
    await expect(f.enroll({ scenarioId: "FU26", conversationId: f.clientConversationId, senderIdentityId: f.senders.finance, resourceType: "invoice", resourceId: f.invoiceId })).rejects.toThrow(/message limit/);
  });
  it("holds unknown contact permission and suppressed recipients without sending", async () => {
    const f = await fixture(); await configure(f);
    await f.db.update(contacts).set({ contactPermission: "unknown" }).where(eq(contacts.id, f.contactId));
    expect(await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).toMatchObject({ status: "held" });
    expect(await invoicePlans(f)).toHaveLength(0);
    await f.db.update(contacts).set({ contactPermission: "permitted", optedOutAt: new Date() }).where(eq(contacts.id, f.contactId));
    expect(await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).toMatchObject({ status: "held" });
    expect(send).not.toHaveBeenCalled();
  });
  it("cancels prepared authority on an owner hold and needs a new reviewed cycle", async () => {
    const f = await fixture(); await configure(f); const source = await evaluateInvoiceCollection(f.ownerId, f.invoiceId);
    const prepared = await f.prepare(source.planId!); await f.caller.recruitment.approvals.decide({ id: prepared.approvalId!, decision: "approved" });
    await configure(f, { onHold: true });
    expect(await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).toMatchObject({ status: "held", reason: "Collections are on owner hold." });
    await expect(deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })).rejects.toThrow();
    await configure(f, { onHold: false }); const next = await evaluateInvoiceCollection(f.ownerId, f.invoiceId);
    expect(next.status).toBe("enrolled"); expect(next.planId).not.toBe(source.planId);
    expect((await f.getPlan(next.planId!)).executionMode).toBe("review"); expect(send).not.toHaveBeenCalled();
  });
  it("freezes collections as soon as a dispute is requested, before approval", async () => {
    const f = await fixture(); await configure(f); const source = await evaluateInvoiceCollection(f.ownerId, f.invoiceId); const d = await f.prepare(source.planId!);
    await f.caller.recruitment.approvals.decide({ id: d.approvalId!, decision: "approved" });
    const dispute = await f.caller.recruitment.consequential.requestInvoiceAction({ invoiceId: f.invoiceId, action: "dispute", evidence: "Client disputes the salary basis used to calculate this fee" });
    expect((await f.getPlan(source.planId!)).status).toBe("cancelled");
    expect(await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).toMatchObject({ status: "held", reason: expect.stringContaining("dispute") });
    await expect(deliverApprovedEmail(f.ownerId, { dispatchId: d.dispatchId })).rejects.toThrow();
    await f.caller.recruitment.approvals.decide({ id: dispute.approvalId, decision: "approved" });
    const ledger = await f.caller.collections.ledger({ limit: 25 }); expect(ledger.items[0].agingBucket).toBe("disputed"); expect(ledger.items[0].remaining).toBe(10000);
    const settled = await fixture();
    const stale = await settled.caller.recruitment.consequential.requestInvoiceAction({ invoiceId: settled.invoiceId, action: "dispute", evidence: "Client queried this invoice before the full bank receipt arrived" });
    await payment(settled, 10000);
    await expect(settled.caller.recruitment.approvals.decide({ id: stale.approvalId, decision: "approved" })).rejects.toThrow(/paid.*disputed/);
    expect((await settled.db.select().from(invoices).where(eq(invoices.id, settled.invoiceId)))[0].status).toBe("paid");
    expect(send).not.toHaveBeenCalled();
  });
  it("records a promise without changing paid truth and holds existing collection authority", async () => {
    const f = await fixture(); await configure(f); const source = await evaluateInvoiceCollection(f.ownerId, f.invoiceId); await f.prepare(source.planId!);
    const promise = await f.caller.collections.recordPromise(promiseInput(f));
    expect((await f.db.select().from(invoices).where(eq(invoices.id, f.invoiceId)))[0].status).not.toBe("paid");
    expect(await f.db.select().from(payments).where(eq(payments.invoiceId, f.invoiceId))).toHaveLength(0);
    expect((await f.getPlan(source.planId!)).status).toBe("cancelled");
    expect(await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).toMatchObject({ status: "held", reason: expect.stringContaining("promise") });
    const [timer] = await f.db.select().from(automationQueue).where(eq(automationQueue.idempotencyKey, `collection_promise:${promise.id}`));
    expect(timer.jobType).toBe("invoice_collection_source");
    const ledger = await f.caller.collections.ledger({ limit: 25 }); expect(ledger.items[0]).toMatchObject({ paid: 0, remaining: 10000, promise: { status: "open", remaining: 5000 } });
  });
  it("deduplicates promise retries and rejects conflicting or excessive evidence", async () => {
    const f = await fixture(), input = promiseInput(f);
    const first = await f.caller.collections.recordPromise(input);
    expect(await f.caller.collections.recordPromise(input)).toMatchObject({ id: first.id, alreadyRecorded: true });
    await expect(f.caller.collections.recordPromise({ ...input, amount: 4000 })).rejects.toThrow(/different evidence/);
    await expect(f.caller.collections.recordPromise(promiseInput(f, { amount: 20000, expectedPromiseId: first.id }))).rejects.toThrow(/remaining balance/);
    await expect(f.caller.collections.recordPromise(promiseInput(f, { dueAt: new Date(Date.now() - DAY_MS), expectedPromiseId: first.id }))).rejects.toThrow(/future/);
    await expect(f.caller.collections.recordPromise(promiseInput(f, { acknowledgeNotPayment: false }) as never)).rejects.toThrow();
    expect(await f.db.select().from(invoicePaymentPromises).where(eq(invoicePaymentPromises.invoiceId, f.invoiceId))).toHaveLength(1);
  });
  it("requires current promise identity before replacement and cancels superseded timers", async () => {
    const f = await fixture(), first = await f.caller.collections.recordPromise(promiseInput(f));
    await expect(f.caller.collections.recordPromise(promiseInput(f))).rejects.toThrow(/promise changed/);
    const next = await f.caller.collections.recordPromise(promiseInput(f, { expectedPromiseId: first.id, amount: 4000 }));
    expect(next.id).not.toBe(first.id);
    expect((await f.db.select().from(invoicePaymentPromises).where(eq(invoicePaymentPromises.id, first.id)))[0].status).toBe("superseded");
    expect((await f.db.select().from(automationQueue).where(eq(automationQueue.idempotencyKey, `collection_promise:${first.id}`)))[0].status).toBe("cancelled");
  });
  it("marks a promise met only from additional receipts and retains the remaining invoice balance", async () => {
    const f = await fixture(); await payment(f, 2000); const p = await f.caller.collections.recordPromise(promiseInput(f));
    await payment(f, 2000); expect((await f.db.select().from(invoicePaymentPromises).where(eq(invoicePaymentPromises.id, p.id)))[0].status).toBe("open");
    await payment(f, 3000); expect((await f.db.select().from(invoicePaymentPromises).where(eq(invoicePaymentPromises.id, p.id)))[0].status).toBe("met");
    const ledger = await f.caller.collections.ledger({ limit: 25 }); expect(ledger.items[0]).toMatchObject({ paid: 7000, remaining: 3000 });
    expect((await f.db.select().from(invoices).where(eq(invoices.id, f.invoiceId)))[0].status).toBe("partially_paid");
  });
  it("preserves receipt baselines above the individual 32-bit payment amount limit", async () => {
    const f = await fixture(); await f.db.update(invoices).set({ amount: 2000000000, taxAmount: 500000000 }).where(eq(invoices.id, f.invoiceId));
    await payment(f, 2000000000); await payment(f, 300000000);
    const promise = await f.caller.collections.recordPromise(promiseInput(f, { amount: 100000000 }));
    expect((await f.db.select().from(invoicePaymentPromises).where(eq(invoicePaymentPromises.id, promise.id)))[0].baselinePaid).toBe(2300000000);
    expect((await f.caller.collections.ledger({ limit: 25 })).items[0].remaining).toBe(200000000);
  });
  it("enrolls FU27 after a missed promise without inventing a payment", async () => {
    const f = await fixture(); await configure(f); const input = promiseInput(f); const p = await f.caller.collections.recordPromise(input);
    const afterDeadline = new Date(input.dueAt.getTime() + 60000);
    const source = await evaluateInvoiceCollection(f.ownerId, f.invoiceId, undefined, afterDeadline);
    expect(source.status).toBe("enrolled");
    const plan = await f.getPlan(source.planId!); expect(plan.scenarioId).toBe("FU27"); expect(plan.executionMode).toBe("review"); expect(plan.steps[0].body).toContain("50.00");
    expect((await f.db.select().from(invoicePaymentPromises).where(eq(invoicePaymentPromises.id, p.id)))[0].status).toBe("missed");
    expect(await f.db.select().from(payments).where(eq(payments.invoiceId, f.invoiceId))).toHaveLength(0); expect(send).not.toHaveBeenCalled();
  });
  it("cancels a promise explicitly and resumes only via a new review sequence", async () => {
    const f = await fixture(); await configure(f); const p = await f.caller.collections.recordPromise(promiseInput(f));
    await f.caller.collections.cancelPromise({ invoiceId: f.invoiceId, promiseId: p.id, reason: "Client withdrew the proposed payment arrangement" });
    const result = await evaluateInvoiceCollection(f.ownerId, f.invoiceId); expect(result.status).toBe("enrolled");
    expect((await f.getPlan(result.planId!)).scenarioId).toBe("FU26"); expect(send).not.toHaveBeenCalled();
  });
  it("rebuilds balance-specific review content after a partial receipt and stops on settlement", async () => {
    const f = await fixture(); await configure(f); const first = await evaluateInvoiceCollection(f.ownerId, f.invoiceId);
    await payment(f, 4000); expect((await f.getPlan(first.planId!)).status).toBe("cancelled");
    const next = await evaluateInvoiceCollection(f.ownerId, f.invoiceId); expect(next.status).toBe("enrolled");
    expect((await f.getPlan(next.planId!)).steps[0].body).toContain("60.00");
    await payment(f, 6000); expect((await f.getPlan(next.planId!)).status).toBe("completed");
    expect((await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).status).not.toBe("enrolled");
  });
  it("never overrides an unreviewed reply after a balance change", async () => {
    const f = await fixture(); await configure(f); await evaluateInvoiceCollection(f.ownerId, f.invoiceId);
    const contact = (await f.db.select().from(contacts).where(eq(contacts.id, f.contactId)))[0];
    await f.caller.email.inbound.record({ conversationId: f.clientConversationId, sender: contact.email, body: "Please discuss this invoice before sending more collection reminders." });
    await payment(f, 1000);
    expect(await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).toMatchObject({ status: "held", reason: expect.stringContaining("Client replied") });
    await configure(f); expect((await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).status).toBe("enrolled"); expect(send).not.toHaveBeenCalled();
  });
  it("keeps unknown dispatches blocked across a changed collection configuration", async () => {
    // Exercise a transport outcome on a business day; weekend deferral never
    // calls the transport and cannot test reconciliation after an unknown send.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    try {
      const f = await fixture(); await configure(f); const first = await evaluateInvoiceCollection(f.ownerId, f.invoiceId), d = await f.prepare(first.planId!);
      await f.caller.recruitment.approvals.decide({ id: d.approvalId!, decision: "approved" });
      send.mockRejectedValueOnce(new Error("Unknown synthetic transport outcome"));
      await expect(deliverApprovedEmail(f.ownerId, { dispatchId: d.dispatchId })).rejects.toThrow(/reconciliation/);
      await configure(f, { maxNudges: 1 });
      expect(await evaluateInvoiceCollection(f.ownerId, f.invoiceId)).toMatchObject({ status: "held", reason: expect.stringContaining("reconciliation") });
      expect(send).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("preserves JPY and KWD minor units and isolates other owners' control", async () => {
    const f = await fixture(), other = await fixture(); await configure(f);
    await f.db.update(invoices).set({ currency: "KWD" }).where(eq(invoices.id, f.invoiceId));
    const source = await evaluateInvoiceCollection(f.ownerId, f.invoiceId); expect((await f.getPlan(source.planId!)).steps[0].body).toContain("10.000");
    await f.db.update(invoices).set({ currency: "JPY" }).where(eq(invoices.id, f.invoiceId));
    await configure(f); const yen = await evaluateInvoiceCollection(f.ownerId, f.invoiceId); expect((await f.getPlan(yen.planId!)).steps[0].body).toContain("10,000");
    await expect(other.caller.collections.detail({ invoiceId: f.invoiceId })).rejects.toThrow(/not found/);
    await expect(other.caller.collections.recordPromise(promiseInput(f))).rejects.toThrow(/not found/);
    expect((await other.caller.collections.ledger({ limit: 25 })).items.every(i => i.ownerId === other.ownerId)).toBe(true);
  });
  it("quarantines inconsistent receipt evidence instead of reporting a collectible balance", async () => {
    const f = await fixture(); await configure(f);
    await f.db.insert(payments).values({ id: createId("pay_"), ownerId: f.ownerId, invoiceId: f.invoiceId, provider: "fault_injection", providerEventId: createId("event_"), amount: 1000, currency: "USD", status: "succeeded" });
    const ledger = await f.caller.collections.ledger({ limit: 25 });
    expect(ledger.items[0]).toMatchObject({ remaining: null, agingBucket: "review_required", onHold: true });
    expect(await processDueInvoiceCollections(f.ownerId)).toMatchObject({ failed: 1, enrolled: 0 });
    await f.db.update(payments).set({ currency: "INR" }).where(eq(payments.invoiceId, f.invoiceId));
    const promise = await f.caller.collections.recordPromise(promiseInput(f));
    await f.db.update(invoicePaymentPromises).set({ currency: "USD" }).where(eq(invoicePaymentPromises.id, promise.id));
    expect((await f.caller.collections.ledger({ limit: 25 })).items[0].agingBucket).toBe("review_required");
    expect(await invoicePlans(f)).toHaveLength(0); expect(send).not.toHaveBeenCalled();
  });
  it("retains authoritative receipt and aging facts when AI quotas are exhausted", async () => {
    const f = await fixture(); await configure(f); await f.db.update(workspaceSettings).set({ policyConfig: { aiDailyLimit: 0 } }).where(eq(workspaceSettings.ownerId, f.ownerId));
    const result = await processDueAutomationBatch(f.ownerId, 5);
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(await invoicePlans(f)).toHaveLength(1); expect(send).not.toHaveBeenCalled();
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("serializes concurrent source enrollment and stale settings updates", async () => {
    const f = await fixture(); await configure(f);
    const results = await Promise.all([evaluateInvoiceCollection(f.ownerId, f.invoiceId), evaluateInvoiceCollection(f.ownerId, f.invoiceId)]);
    expect(results.filter(r => r.status === "enrolled")).toHaveLength(1); expect(await invoicePlans(f)).toHaveLength(1);
    const input = { invoiceId: f.invoiceId, expectedRevision: 1, contactId: f.contactId, senderIdentityId: f.senders.finance, enabled: true, onHold: false, graceDays: 0, maxNudges: 2, reason: "Owner reviewed this new collection version", reviewedReplies: true as const };
    const updates = await Promise.allSettled([saveCollectionSettings(f.ownerId, f.ownerId, input), saveCollectionSettings(f.ownerId, f.ownerId, input)]);
    expect(updates.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("deduplicates concurrent promise commands without fabricating receipts", async () => {
    const f = await fixture(), input = promiseInput(f);
    const results = await Promise.all([f.caller.collections.recordPromise(input), f.caller.collections.recordPromise(input)]);
    expect(results[0].id).toBe(results[1].id); expect(results.filter(r => r.alreadyRecorded)).toHaveLength(1);
    expect(await f.db.select().from(payments).where(eq(payments.invoiceId, f.invoiceId))).toHaveLength(0);
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("rotates a bounded scan past held or future sources", async () => {
    const f = await fixture(); await configure(f, { onHold: true });
    const [original] = await f.db.select().from(invoices).where(eq(invoices.id, f.invoiceId));
    const id = createId("inv_"); await f.db.insert(invoices).values({ id, ownerId: f.ownerId, companyId: f.companyId, placementId: original.placementId, invoiceNumber: id, amount: 5000, currency: "INR", status: "payment_pending", dueAt: new Date(Date.now() + DAY_MS) });
    await f.caller.collections.saveSettings({ invoiceId: id, expectedRevision: 0, contactId: f.contactId, senderIdentityId: f.senders.finance, enabled: true, onHold: false, graceDays: 0, maxNudges: 1, reason: "Owner reviewed a future collectible invoice", reviewedReplies: true });
    await processDueInvoiceCollections(f.ownerId, 1); await processDueInvoiceCollections(f.ownerId, 1);
    const rules = await f.db.select().from(invoiceCollectionSettings).where(eq(invoiceCollectionSettings.ownerId, f.ownerId));
    expect(rules.every(r => r.lastEvaluatedAt instanceof Date)).toBe(true); expect(send).not.toHaveBeenCalled();
  });
});
