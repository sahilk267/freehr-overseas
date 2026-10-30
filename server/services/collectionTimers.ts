import { and, eq, inArray } from "drizzle-orm";
import { automationQueue, invoicePaymentPromises } from "../../drizzle/schema";
import { createId } from "../db";
import { appendWorkflowEvent } from "./workflowStore";

export async function scheduleCollectionEvaluation(tx: any, ownerId: number, invoiceId: string, key: string, at: Date, ruleRevision?: number) {
  const existing = (await tx.select().from(automationQueue).where(eq(automationQueue.idempotencyKey, key)).limit(1))[0];
  if (existing) return;
  await tx.insert(automationQueue).values({ id: createId("que_"), ownerId, jobType: "invoice_collection_source", payload: { invoiceId, ruleRevision }, status: "queued", attempts: 0, maxAttempts: 3, priority: 12, scheduledAt: at, idempotencyKey: key });
}

export async function cancelCollectionTimer(tx: any, ownerId: number, key: string) {
  await tx.update(automationQueue).set({ status: "cancelled", lockToken: null, lockedAt: null, lastError: "Collection intent changed." }).where(and(eq(automationQueue.ownerId, ownerId), eq(automationQueue.idempotencyKey, key), inArray(automationQueue.status, ["queued", "retryable_failed"])));
}

export async function settlePaymentPromises(tx: any, ownerId: number, invoiceId: string, paid: number, now = new Date()) {
  const promises = await tx.select().from(invoicePaymentPromises).where(and(eq(invoicePaymentPromises.ownerId, ownerId), eq(invoicePaymentPromises.invoiceId, invoiceId), inArray(invoicePaymentPromises.status, ["open", "missed"])));
  for (const promise of promises) {
    if (paid - promise.baselinePaid < promise.amount) continue;
    await tx.update(invoicePaymentPromises).set({ status: now > promise.dueAt ? "met_late" : "met", settledAt: now }).where(eq(invoicePaymentPromises.id, promise.id));
    await cancelCollectionTimer(tx, ownerId, `collection_promise:${promise.id}`);
    await appendWorkflowEvent(tx, ownerId, "invoice.promise_met", invoiceId, promise.revision, { promiseId: promise.id, late: now > promise.dueAt, source: "succeeded_receipts" }, promise.id);
  }
}
