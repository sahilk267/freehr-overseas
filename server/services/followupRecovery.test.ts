import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, automationGrants, automationQueue, candidates, emailDispatches, followUpPlans, messages, workflowEvents } from "../../drizzle/schema";
import { followupFixture } from "../testSupport/followupFixture";
import { controlFollowUp, grantFollowUpSending } from "./followupControl";
import { replanFollowUp, snoozeFollowUp } from "./followupRecovery";
import { reconcileEmailDispatch } from "./emailReconciliation";
import { deliverApprovedEmail } from "./emailDelivery";
import { prepareFollowUp } from "./followups";
import { stopOwnerFollowUps } from "./followupEvents";

const send = vi.hoisted(() => vi.fn(async () => ({ providerMessageId: "recovery-test-receipt" })));
vi.mock("./hostingerMail", async original => ({ ...await original(), isSenderIdentityConfigured: () => true, sendViaHostingerMailApi: send }));
type Fixture = Awaited<ReturnType<typeof followupFixture>>;
const definition = (f: Fixture, body = "A revised message after reviewing the recipient's reply. Reply STOP to opt out.") => ({ objective: "Updated candidate interest enquiry", senderIdentityId: f.senders.talent, timezone: "UTC", businessDaysOnly: false, startsAt: new Date(), deadlineAt: new Date(Date.now() + 5 * 86400000), responseWindowMinutes: 60, steps: [{ delayMinutes: 0, subject: "Updated enquiry", body }] });
const update = async (f: Fixture, id: string, patch: Record<string, unknown> = {}) => replanFollowUp(f.ownerId, f.ownerId, { id, expectedRevision: (await f.getPlan(id)).revision, reason: "Owner reviewed the current conversation and evidence", definition: { ...definition(f), ...patch } });
async function approved(f: Fixture, id: string) { const prepared = await f.prepare(id); await f.caller.recruitment.approvals.decide({ id: prepared.approvalId!, decision: "approved" }); return prepared; }
async function uncertain() {
  const f = await followupFixture(), p = await f.enroll(), d = await approved(f, p.id);
  send.mockRejectedValueOnce(new Error("Transport closed after request left the app"));
  await expect(deliverApprovedEmail(f.ownerId, { dispatchId: d.dispatchId })).rejects.toThrow(/reconciliation/);
  return { f, p, d };
}
const evidence = (dispatchId: string, outcome: "accepted" | "not_accepted" | "unknown" = "accepted") => ({ dispatchId, outcome, evidenceReference: "provider-ticket-2026-001", reason: "Owner reviewed the provider records for this exact synthetic email attempt.", reviewedProviderEvidence: true as const, ...(outcome === "accepted" ? { acceptedAt: new Date() } : {}) });

describe("reviewed follow-up recovery and versioned commands", () => {
  beforeEach(() => send.mockReset().mockResolvedValue({ providerMessageId: "recovery-test-receipt" }));
  it("replans in place, preserves immutable content history and revokes the old send path", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await grantFollowUpSending(f.ownerId, f.ownerId, p.id, new Date(Date.now() + 3600000), 2);
    const old = await f.prepare(p.id);
    expect(await update(f, p.id)).toMatchObject({ id: p.id, revision: 2, status: "scheduled" });
    expect(await f.getPlan(p.id)).toMatchObject({ executionMode: "review", stepIndex: 0, objective: "Updated candidate interest enquiry" });
    expect((await f.db.select().from(automationGrants).where(eq(automationGrants.planId, p.id)))[0].active).toBe(false);
    expect((await f.db.select().from(emailDispatches).where(eq(emailDispatches.id, old.dispatchId!)))[0].status).toBe("cancelled");
    expect((await f.db.select().from(messages).where(eq(messages.id, old.messageId!)))[0].body).toBe(f.input.steps[0].body);
    const versions = await f.caller.followups.versions({ id: p.id, limit: 10 });
    expect(versions.items.map(v => v.revision)).toEqual([2, 1]);
    expect((versions.items[1].metadata as any).definition.steps[0].body).toBe(f.input.steps[0].body);
    expect(await prepareFollowUp(f.ownerId, { planId: p.id, revision: 1, stepIndex: 0 })).toMatchObject({ status: "cancelled" });
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects stale edits, pause actions and sending grants without changing the new revision", async () => {
    const f = await followupFixture(), p = await f.enroll(); await update(f, p.id);
    await expect(replanFollowUp(f.ownerId, f.ownerId, { id: p.id, expectedRevision: 1, reason: "Stale owner editor saving an older draft", definition: definition(f) })).rejects.toThrow(/changed/);
    await expect(controlFollowUp(f.ownerId, p.id, "pause", "Stale browser tab", 1)).rejects.toThrow(/changed/);
    await expect(grantFollowUpSending(f.ownerId, f.ownerId, p.id, new Date(Date.now() + 3600000), 1, 1)).rejects.toThrow(/changed/);
    expect((await f.getPlan(p.id)).revision).toBe(2);
  });
  it("restarts an ended business cycle with a new reviewed revision", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await controlFollowUp(f.ownerId, p.id, "complete", "Owner closed the previous enquiry");
    expect(await update(f, p.id)).toMatchObject({ revision: 3, status: "scheduled" });
    expect(await f.enroll()).toMatchObject({ id: p.id, alreadyEnrolled: true });
    expect(send).not.toHaveBeenCalled();
  });
  it("infers the current recipient again and cannot replace the linked resource through an edit", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await f.db.update(candidates).set({ email: "updated-person@example.test" }).where(eq(candidates.id, f.candidateId));
    await update(f, p.id);
    expect((await f.getPlan(p.id)).recipient).toBe("updated-person@example.test");
    await expect(f.caller.followups.replan({ id: p.id, expectedRevision: 2, reason: "Attempt to replace the owned context", definition: { ...definition(f), resourceId: "different-resource" } } as never)).rejects.toThrow();
  });
  it("rechecks withdrawal and sender purpose when replanning", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await expect(update(f, p.id, { senderIdentityId: f.senders.finance })).rejects.toThrow(/Sender/);
    await f.caller.recruitment.candidates.withdraw({ candidateId: f.candidateId });
    await expect(update(f, p.id)).rejects.toThrow(/withdrawn|suppressed/);
    expect((await f.getPlan(p.id)).status).toBe("cancelled");
  });
  it("refreshes invoice evidence after a partial receipt and refuses a competing canonical sequence", async () => {
    const f = await followupFixture();
    const invoiceInput = { scenarioId: "FU26", conversationId: f.clientConversationId, senderIdentityId: f.senders.finance, resourceType: "invoice", resourceId: f.invoiceId };
    const p = await f.enroll(invoiceInput);
    await f.caller.recruitment.invoices.recordPayment({ id: f.invoiceId, provider: "test_bank", providerEventId: `partial_${p.id}`, amount: 4000 });
    await update(f, p.id, { senderIdentityId: f.senders.finance, steps: [{ delayMinutes: 0, subject: "Remaining balance", body: "The remaining synthetic balance is INR 60.00. Please reply to discuss." }] });
    expect((await f.getPlan(p.id)).status).toBe("scheduled");
    expect(await f.enroll(invoiceInput)).toMatchObject({ id: p.id, alreadyEnrolled: true });
    await f.caller.recruitment.invoices.recordPayment({ id: f.invoiceId, provider: "test_bank", providerEventId: `second_${p.id}`, amount: 1000 });
    const competing = await f.enroll(invoiceInput);
    expect(competing.id).not.toBe(p.id);
    await expect(update(f, p.id, { senderIdentityId: f.senders.finance })).rejects.toThrow(/Another sequence/);
    expect((await f.getPlan(p.id)).status).toBe("cancelled");
  });
  it("snoozes the pending step, cancels its approval and returns authority to review", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await grantFollowUpSending(f.ownerId, f.ownerId, p.id, new Date(Date.now() + 3600000), 2);
    const d = await f.prepare(p.id), until = new Date(Date.now() + 2 * 3600000);
    expect(await snoozeFollowUp(f.ownerId, f.ownerId, { id: p.id, expectedRevision: 1, until, reason: "Recipient requested contact later in the day" })).toMatchObject({ revision: 2, nextActionAt: until });
    expect(await f.getPlan(p.id)).toMatchObject({ executionMode: "review", stepIndex: 0, nextActionAt: until });
    expect((await f.db.select().from(approvals).where(eq(approvals.id, d.approvalId!)))[0].status).toBe("cancelled");
    const [timer] = await f.db.select().from(automationQueue).where(eq(automationQueue.idempotencyKey, `followup:${p.id}:2:0`));
    expect(timer.scheduledAt.getTime()).toBe(until.getTime());
    await expect(snoozeFollowUp(f.ownerId, f.ownerId, { id: p.id, expectedRevision: 2, until: (await f.getPlan(p.id)).deadlineAt, reason: "This postponement would miss the deadline" })).rejects.toThrow(/deadline/);
    await expect(snoozeFollowUp(f.ownerId, f.ownerId, { id: p.id, expectedRevision: 2, until: new Date(Date.now() - 1000), reason: "This postponement is already in the past" })).rejects.toThrow(/future/);
    expect(send).not.toHaveBeenCalled();
  });
  it("refuses snoozes and edits while an outcome is unresolved", async () => {
    const { f, p } = await uncertain(), plan = await f.getPlan(p.id);
    await expect(update(f, p.id)).rejects.toThrow(/Reconcile/);
    await expect(snoozeFollowUp(f.ownerId, f.ownerId, { id: p.id, expectedRevision: plan.revision, until: new Date(Date.now() + 60000), reason: "Owner tries to bypass an uncertain attempt" })).rejects.toThrow(/Reconcile/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps an inconclusive finding blocked and does not infer a negative outcome", async () => {
    const { f, p, d } = await uncertain();
    expect(await reconcileEmailDispatch(f.ownerId, f.ownerId, evidence(d.dispatchId!, "unknown"))).toMatchObject({ status: "reconciliation_required" });
    expect((await f.getPlan(p.id)).status).toBe("blocked");
    await expect(controlFollowUp(f.ownerId, p.id, "resume", "No confirmed result yet")).rejects.toThrow(/Reconcile/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("records positive owner evidence once without fabricating provider receipt or delivery", async () => {
    const { f, p, d } = await uncertain(), finding = evidence(d.dispatchId!);
    expect(await reconcileEmailDispatch(f.ownerId, f.ownerId, finding)).toMatchObject({ status: "accepted_recorded", alreadyResolved: false });
    expect(await reconcileEmailDispatch(f.ownerId, f.ownerId, finding)).toMatchObject({ alreadyResolved: true });
    expect(await f.getPlan(p.id)).toMatchObject({ status: "paused", stepIndex: 1 });
    const [message] = await f.db.select().from(messages).where(eq(messages.id, d.messageId!));
    expect(message.status).toBe("accepted_recorded");
    expect(message.providerMessageId ?? null).toBeNull(); expect(message.sentAt ?? null).toBeNull(); expect(message.deliveredAt).toBeNull();
    await controlFollowUp(f.ownerId, p.id, "resume", "Reviewed the confirmed acceptance evidence");
    expect((await f.getPlan(p.id)).stepIndex).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("requires fresh review after confirmed non-acceptance and keeps the old approval consumed", async () => {
    const { f, p, d } = await uncertain();
    await reconcileEmailDispatch(f.ownerId, f.ownerId, evidence(d.dispatchId!, "not_accepted"));
    expect((await f.getPlan(p.id)).stepIndex).toBe(0);
    expect((await f.db.select().from(approvals).where(eq(approvals.id, d.approvalId!)))[0].actionedAt).toBeTruthy();
    await expect(deliverApprovedEmail(f.ownerId, { dispatchId: d.dispatchId })).rejects.toThrow(/consumed/);
    await controlFollowUp(f.ownerId, p.id, "resume", "Reviewed provider confirmation of non-acceptance");
    const next = await f.prepare(p.id);
    expect(next.approvalId).not.toBe(d.approvalId);
    expect((await f.db.select().from(approvals).where(eq(approvals.id, next.approvalId!)))[0].status).toBe("pending");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("refuses conflicting final evidence and a resolution for an active/unclaimed attempt", async () => {
    const { f, d } = await uncertain();
    await reconcileEmailDispatch(f.ownerId, f.ownerId, evidence(d.dispatchId!, "not_accepted"));
    await expect(reconcileEmailDispatch(f.ownerId, f.ownerId, evidence(d.dispatchId!, "accepted"))).rejects.toThrow(/different/);
    const other = await followupFixture(), p = await other.enroll(), pending = await approved(other, p.id);
    await expect(reconcileEmailDispatch(other.ownerId, other.ownerId, evidence(pending.dispatchId!))).rejects.toThrow(/uncertain/);
  });
  it("requires actual provider review and a plausible acceptance time", async () => {
    const { f, d } = await uncertain();
    await expect(reconcileEmailDispatch(f.ownerId, f.ownerId, { ...evidence(d.dispatchId!), reviewedProviderEvidence: false } as never)).rejects.toThrow();
    await expect(reconcileEmailDispatch(f.ownerId, f.ownerId, { ...evidence(d.dispatchId!), acceptedAt: new Date(Date.now() + 60000) })).rejects.toThrow(/future/);
    await expect(reconcileEmailDispatch(f.ownerId, f.ownerId, { ...evidence(d.dispatchId!), acceptedAt: new Date(Date.now() - 3600000) })).rejects.toThrow(/correspond/);
    await f.db.update(approvals).set({ resourceId: "unrelated-message" }).where(eq(approvals.id, d.approvalId!));
    await expect(reconcileEmailDispatch(f.ownerId, f.ownerId, evidence(d.dispatchId!))).rejects.toThrow(/incomplete/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("isolates recovery queue, evidence, history and edits across owners", async () => {
    const { f, p, d } = await uncertain(), other = await followupFixture();
    expect(await other.caller.followups.recoveryQueue()).toHaveLength(0);
    await expect(other.caller.followups.versions({ id: p.id, limit: 10 })).rejects.toThrow(/not found/);
    await expect(other.caller.followups.reconcileDispatch(evidence(d.dispatchId!))).rejects.toThrow(/not found/);
    await expect(other.caller.followups.replan({ id: p.id, expectedRevision: 2, reason: "Foreign workspace attempts to edit this sequence", definition: definition(other) })).rejects.toThrow(/not found/);
    expect(await f.caller.followups.recoveryQueue()).toHaveLength(1);
  });
  it("redacts definition and recovery evidence on candidate erasure", async () => {
    const { f, p, d } = await uncertain();
    await reconcileEmailDispatch(f.ownerId, f.ownerId, evidence(d.dispatchId!, "not_accepted"));
    await update(f, p.id);
    await stopOwnerFollowUps(f.ownerId, { candidateId: f.candidateId }, "cancelled", "Candidate erasure", true);
    const history = await f.caller.followups.versions({ id: p.id, limit: 10 });
    expect(history.items.every(v => (v.metadata as any).redacted && !(v.metadata as any).definition)).toBe(true);
    const resolution = (await f.db.select().from(workflowEvents).where(and(eq(workflowEvents.aggregateId, d.dispatchId!), eq(workflowEvents.eventType, "email.reconciled"))))[0];
    expect(resolution.metadata).toMatchObject({ redacted: true, outcome: "not_accepted" });
    expect(resolution.metadata.evidenceReference).toBeUndefined();
    await expect(update(f, p.id)).rejects.toThrow(/erased/);
  });
  it("pages immutable definitions by revision without repeating a version", async () => {
    const f = await followupFixture(), p = await f.enroll(); await update(f, p.id); await update(f, p.id);
    const first = await f.caller.followups.versions({ id: p.id, limit: 2 });
    expect(first.items.map(v => v.revision)).toEqual([3, 2]);
    const second = await f.caller.followups.versions({ id: p.id, limit: 2, cursor: first.nextCursor });
    expect(second.items.map(v => v.revision)).toEqual([1]);
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("allows one concurrent replan and rejects the stale competing command", async () => {
    const f = await followupFixture(), p = await f.enroll();
    const input = { id: p.id, expectedRevision: 1, reason: "Owner reviewed the current source evidence", definition: definition(f) };
    const results = await Promise.allSettled([replanFollowUp(f.ownerId, f.ownerId, input), replanFollowUp(f.ownerId, f.ownerId, input)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await f.getPlan(p.id)).revision).toBe(2);
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("serializes concurrent positive adjudications and advances the step once", async () => {
    const { f, p, d } = await uncertain(), input = evidence(d.dispatchId!);
    const results = await Promise.all([reconcileEmailDispatch(f.ownerId, f.ownerId, input), reconcileEmailDispatch(f.ownerId, f.ownerId, input)]);
    expect(results.filter(r => r.alreadyResolved)).toHaveLength(1);
    expect((await f.getPlan(p.id)).stepIndex).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
