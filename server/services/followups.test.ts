import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, automationGrants, automationQueue, candidates, consents, emailDispatches, followUpPlans, messages, workspaceSettings } from "../../drizzle/schema";
import { followupFixture } from "../testSupport/followupFixture";
import { controlFollowUp, grantFollowUpSending } from "./followupControl";
import { deliverApprovedEmail } from "./emailDelivery";
import { processDueInterviewReminders } from "./interviewReminders";
import { followUpEligibility, prepareFollowUp } from "./followups";
import { processOneQueuedJob } from "./queue";

const send = vi.hoisted(() => vi.fn(async () => ({ providerMessageId: "synthetic-provider-receipt" })));
vi.mock("./hostingerMail", async original => ({ ...await original(), isSenderIdentityConfigured: () => true, sendViaHostingerMailApi: send }));

async function approved(f: Awaited<ReturnType<typeof followupFixture>>, id: string) {
  const prepared = await f.prepare(id);
  await f.caller.recruitment.approvals.decide({ id: prepared.approvalId!, decision: "approved" });
  return prepared;
}

describe("durable follow-up workflows (mock provider, executable on migrated MySQL)", () => {
  beforeEach(() => send.mockReset().mockResolvedValue({ providerMessageId: "synthetic-provider-receipt" }));
  it("deduplicates enrollment and repeated preparation, and defaults to review", async () => {
    const f = await followupFixture(), p = await f.enroll();
    expect(await f.enroll()).toMatchObject({ id: p.id, alreadyEnrolled: true });
    expect((await f.getPlan(p.id)).executionMode).toBe("review");
    await f.prepare(p.id); await f.prepare(p.id);
    expect(await f.db.select().from(emailDispatches).where(eq(emailDispatches.planId, p.id))).toHaveLength(1);
    expect(await f.db.select().from(automationQueue).where(and(eq(automationQueue.ownerId, f.ownerId), eq(automationQueue.jobType, "deliver_email")))).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
  it("sends only after owner approval, then schedules the next step from provider acceptance", async () => {
    const f = await followupFixture(), p = await f.enroll(), prepared = await approved(f, p.id);
    expect(send).not.toHaveBeenCalled();
    expect(await deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })).toMatchObject({ success: true, status: "sent" });
    const plan = await f.getPlan(p.id);
    expect(plan).toMatchObject({ status: "waiting", stepIndex: 1 });
    expect(plan.nextActionAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60000);
    expect((await f.db.select().from(messages).where(eq(messages.id, prepared.messageId!)))[0].deliveredAt).toBeNull();
    await expect(deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })).rejects.toThrow(/consumed|cancelled/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("pauses a prepared message on reply, revokes permission and invalidates stale approval", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await grantFollowUpSending(f.ownerId, f.ownerId, p.id, new Date(Date.now() + 3600000), 2);
    const prepared = await f.prepare(p.id);
    await f.caller.email.inbound.record({ conversationId: f.conversationId, sender: f.address, body: "I am interested. Can we discuss?" });
    expect((await f.getPlan(p.id)).status).toBe("paused");
    expect((await f.db.select().from(automationGrants).where(eq(automationGrants.planId, p.id)))[0].active).toBe(false);
    await expect(deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })).rejects.toThrow();
    await controlFollowUp(f.ownerId, p.id, "resume", "Owner reviewed the recipient reply");
    expect(await f.getPlan(p.id)).toMatchObject({ executionMode: "review", revision: 3 });
    expect(send).not.toHaveBeenCalled();
  });
  it("cancels every sequence to an opted-out recipient before classification", async () => {
    const f = await followupFixture(), a = await f.enroll(), b = await f.enroll({ scenarioId: "FU10" });
    await f.caller.email.inbound.record({ conversationId: f.conversationId, sender: f.address, body: "STOP, unsubscribe me." });
    expect((await f.getPlan(a.id)).status).toBe("cancelled");
    expect((await f.getPlan(b.id)).status).toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
  });
  it("rechecks a new reply at dispatch even if the reply hook has not run", async () => {
    const f = await followupFixture(), p = await f.enroll(), prepared = await approved(f, p.id);
    await f.db.insert(messages).values({ id: `msg_${Math.random()}`, ownerId: f.ownerId, conversationId: f.conversationId, direction: "inbound", status: "received", idempotencyKey: `reply_${Math.random()}`, body: "Reply before delivery" });
    expect(await deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })).toMatchObject({ status: "paused" });
    expect(send).not.toHaveBeenCalled();
  });
  it("withdrawal cancels queued messages and prevents late preparation", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await f.caller.recruitment.candidates.withdraw({ candidateId: f.candidateId });
    expect((await f.getPlan(p.id)).status).toBe("cancelled");
    expect(await prepareFollowUp(f.ownerId, { planId: p.id, revision: 1, stepIndex: 0 })).toMatchObject({ status: "cancelled" });
    expect(send).not.toHaveBeenCalled();
  });
  it("uses purpose-appropriate consent rather than platform processing alone", async () => {
    const f = await followupFixture();
    await f.db.update(consents).set({ consentType: "platform_processing" }).where(eq(consents.candidateId, f.candidateId));
    await expect(f.enroll()).rejects.toThrow(/communication permission/);
  });
  it("binds delegated authority to exact content, expiry and send count", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await grantFollowUpSending(f.ownerId, f.ownerId, p.id, new Date(Date.now() + 86400000), 1);
    const first = await f.prepare(p.id);
    expect(await deliverApprovedEmail(f.ownerId, { dispatchId: first.dispatchId })).toMatchObject({ status: "sent" });
    const second = await f.prepare(p.id);
    expect(await deliverApprovedEmail(f.ownerId, { dispatchId: second.dispatchId })).toMatchObject({ status: "blocked" });
    expect((await f.getPlan(p.id)).status).toBe("blocked");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("detects a changed delegated sequence before preparing another message", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await grantFollowUpSending(f.ownerId, f.ownerId, p.id, new Date(Date.now() + 3600000), 2);
    await f.db.update(followUpPlans).set({ steps: [{ ...f.input.steps[0], body: "Different unapproved recipient content" }] }).where(eq(followUpPlans.id, p.id));
    expect(await f.prepare(p.id)).toMatchObject({ status: "blocked" });
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects tampered pending content when granting automatic sending", async () => {
    const f = await followupFixture(), p = await f.enroll(), prepared = await f.prepare(p.id);
    await f.db.update(messages).set({ body: "Tampered content that the owner did not delegate" }).where(eq(messages.id, prepared.messageId!));
    await expect(grantFollowUpSending(f.ownerId, f.ownerId, p.id, new Date(Date.now() + 3600000), 2)).rejects.toThrow(/content changed/);
    expect((await f.getPlan(p.id)).executionMode).toBe("review");
  });
  it("defers at quiet hours without consuming an approval", async () => {
    const f = await followupFixture(), p = await f.enroll(), prepared = await approved(f, p.id);
    const now = new Date(); now.setUTCHours(23, 0, 0, 0);
    await f.db.update(workspaceSettings).set({ quietHoursStart: "20:00", quietHoursEnd: "08:00" }).where(eq(workspaceSettings.ownerId, f.ownerId));
    const result = await deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId }, now);
    expect(result.status).toBe("deferred");
    expect((await f.db.select().from(approvals).where(eq(approvals.id, prepared.approvalId!)))[0].actionedAt).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
  it("applies workspace caps and recipient spacing across sequences", async () => {
    const f = await followupFixture(), a = await f.enroll(), pa = await approved(f, a.id);
    await deliverApprovedEmail(f.ownerId, { dispatchId: pa.dispatchId });
    const b = await f.enroll({ scenarioId: "FU10" }), pb = await approved(f, b.id);
    expect(await deliverApprovedEmail(f.ownerId, { dispatchId: pb.dispatchId })).toMatchObject({ status: "deferred" });
    await f.db.update(workspaceSettings).set({ dailyOutboundLimit: 1 }).where(eq(workspaceSettings.ownerId, f.ownerId));
    const result = await deliverApprovedEmail(f.ownerId, { dispatchId: pb.dispatchId });
    expect(result.status).toBe("deferred");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("respects emergency stop before consuming an authorization", async () => {
    const f = await followupFixture(), p = await f.enroll(), prepared = await approved(f, p.id);
    await f.db.update(workspaceSettings).set({ emergencyStop: true }).where(eq(workspaceSettings.ownerId, f.ownerId));
    expect(await deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })).toMatchObject({ success: false });
    expect((await f.db.select().from(approvals).where(eq(approvals.id, prepared.approvalId!)))[0].actionedAt).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
  it("quarantines an unknown provider outcome, with no automatic resend or resume", async () => {
    const f = await followupFixture(), p = await f.enroll(), prepared = await approved(f, p.id);
    send.mockRejectedValueOnce(new Error("Connection closed after provider accepted request"));
    await expect(deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })).rejects.toThrow(/reconciliation/);
    expect((await f.getPlan(p.id)).status).toBe("blocked");
    await expect(deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })).rejects.toThrow(/consumed/);
    await expect(controlFollowUp(f.ownerId, p.id, "resume", "Attempt to resume unresolved delivery")).rejects.toThrow(/Reconcile/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejecting a pending approval pauses the plan", async () => {
    const f = await followupFixture(), p = await f.enroll(), prepared = await f.prepare(p.id);
    await f.caller.recruitment.approvals.decide({ id: prepared.approvalId!, decision: "rejected" });
    expect((await f.getPlan(p.id)).status).toBe("paused");
    expect(send).not.toHaveBeenCalled();
  });
  it("routes due interview reminders through FU18 and marks them only after accepted delivery", async () => {
    const f = await followupFixture();
    expect(await processDueInterviewReminders(f.ownerId)).toMatchObject({ queued: 1, blocked: 0 });
    expect(await processDueInterviewReminders(f.ownerId)).toMatchObject({ queued: 0 });
    const p = (await f.db.select().from(followUpPlans).where(eq(followUpPlans.ownerId, f.ownerId)))[0];
    const prepared = await approved(f, p.id);
    const { interviews } = await import("../../drizzle/schema");
    expect((await f.db.select().from(interviews).where(eq(interviews.id, f.interviewId)))[0].reminderSentAt).toBeNull();
    await deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId });
    expect((await f.db.select().from(interviews).where(eq(interviews.id, f.interviewId)))[0]).toMatchObject({ status: "reminder_sent", reminderSentAt: expect.any(Date) });
  });
  it("cancels an old interview sequence on reschedule and rejects its authorization", async () => {
    const f = await followupFixture(); await processDueInterviewReminders(f.ownerId);
    const p = (await f.db.select().from(followUpPlans).where(eq(followUpPlans.ownerId, f.ownerId)))[0];
    const prepared = await approved(f, p.id);
    await f.caller.recruitment.interviews.reschedule({ id: f.interviewId, scheduledAt: new Date(Date.now() + 86400000), timezone: "UTC", durationMinutes: 30 });
    expect((await f.getPlan(p.id)).status).toBe("cancelled");
    await expect(deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("invalidates collection content after a partial receipt and completes after full payment", async () => {
    const f = await followupFixture();
    const invoiceInput = { scenarioId: "FU26", conversationId: f.clientConversationId, senderIdentityId: f.senders.finance, resourceType: "invoice", resourceId: f.invoiceId };
    const a = await f.enroll(invoiceInput); await approved(f, a.id);
    await f.caller.recruitment.invoices.recordPayment({ id: f.invoiceId, provider: "test_bank", providerEventId: `part_${f.invoiceId}`, amount: 4000 });
    expect((await f.getPlan(a.id)).status).toBe("cancelled");
    const b = await f.enroll(invoiceInput); expect(b.id).not.toBe(a.id);
    await f.caller.recruitment.invoices.recordPayment({ id: f.invoiceId, provider: "test_bank", providerEventId: `full_${f.invoiceId}`, amount: 6000 });
    expect((await f.getPlan(b.id)).status).toBe("completed");
    expect(send).not.toHaveBeenCalled();
  });
  it("executes a follow-up deterministically through the physical queue", async () => {
    const f = await followupFixture(), p = await f.enroll();
    expect(await processOneQueuedJob(f.ownerId)).toMatchObject({ status: "completed" });
    expect((await f.getPlan(p.id)).status).toBe("approval_pending");
    expect(send).not.toHaveBeenCalled();
  });
  it("cancels old physical tasks and lets a resumed revision reach review", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await approved(f, p.id);
    await controlFollowUp(f.ownerId, p.id, "pause", "Owner paused the previous revision");
    await controlFollowUp(f.ownerId, p.id, "resume", "Owner reviewed the sequence");
    expect(await processOneQueuedJob(f.ownerId)).toMatchObject({ status: "completed" });
    expect((await f.getPlan(p.id)).status).toBe("approval_pending");
    const outbox = await f.db.select().from(emailDispatches).where(eq(emailDispatches.planId, p.id));
    expect(outbox.filter((d: typeof emailDispatches.$inferSelect) => d.status === "queued")).toHaveLength(1);
    expect(outbox.filter((d: typeof emailDispatches.$inferSelect) => d.status === "cancelled")).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });
  it("records acceptance during a pause and resumes at the next step", async () => {
    const f = await followupFixture(), p = await f.enroll(), prepared = await approved(f, p.id);
    let started!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    send.mockImplementationOnce(async () => { started(); await finish; return { providerMessageId: "accepted-during-pause" }; });
    const delivery = deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId });
    await began;
    await controlFollowUp(f.ownerId, p.id, "pause", "Owner pauses while transport is in progress");
    await expect(controlFollowUp(f.ownerId, p.id, "resume", "Cannot resume before outcome is known")).rejects.toThrow(/Reconcile/);
    release(); await delivery;
    expect(await f.getPlan(p.id)).toMatchObject({ status: "paused", stepIndex: 1 });
    await controlFollowUp(f.ownerId, p.id, "resume", "Provider acceptance has been reconciled");
    expect(await f.getPlan(p.id)).toMatchObject({ status: "scheduled", stepIndex: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects expired or over-broad grants and blocks a grant that expires before preparation", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await expect(grantFollowUpSending(f.ownerId, f.ownerId, p.id, new Date(Date.now() - 1000), 1)).rejects.toThrow(/Permission/);
    await expect(grantFollowUpSending(f.ownerId, f.ownerId, p.id, new Date(Date.now() + 3600000), 3)).rejects.toThrow(/Permission/);
    const grant = await grantFollowUpSending(f.ownerId, f.ownerId, p.id, new Date(Date.now() + 3600000), 2);
    await f.db.update(automationGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(automationGrants.id, grant.grantId));
    expect(await f.prepare(p.id)).toMatchObject({ status: "blocked" });
    expect(send).not.toHaveBeenCalled();
  });
  it("invalidates the sequence when its sender purpose or address changes", async () => {
    const f = await followupFixture(), p = await f.enroll();
    const { emailIdentities } = await import("../../drizzle/schema");
    await f.db.update(emailIdentities).set({ purpose: "clients" }).where(eq(emailIdentities.id, f.senders.talent));
    expect(await f.prepare(p.id)).toMatchObject({ status: "blocked" });
    expect(send).not.toHaveBeenCalled();
  });
  it("finishes a bounded sequence after the response window without creating a third message", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await grantFollowUpSending(f.ownerId, f.ownerId, p.id, new Date(Date.now() + 86400000), 2);
    const a = await f.prepare(p.id); await deliverApprovedEmail(f.ownerId, { dispatchId: a.dispatchId });
    const b = await f.prepare(p.id); await deliverApprovedEmail(f.ownerId, { dispatchId: b.dispatchId }, new Date(Date.now() + 3600000));
    const plan = await f.getPlan(p.id);
    expect(await prepareFollowUp(f.ownerId, { planId: p.id, revision: plan.revision, stepIndex: plan.stepIndex }, new Date(plan.nextActionAt.getTime() + 1000))).toMatchObject({ status: "exhausted" });
    expect(await f.db.select().from(emailDispatches).where(eq(emailDispatches.planId, p.id))).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("keeps plan details, control, delegation and dispatch inside the owner workspace", async () => {
    const f = await followupFixture(), other = await followupFixture(), p = await f.enroll(), prepared = await approved(f, p.id);
    await expect(other.caller.followups.detail({ id: p.id })).rejects.toThrow(/not found/);
    await expect(controlFollowUp(other.ownerId, p.id, "pause", "Foreign workspace attempt")).rejects.toThrow(/not found/);
    await expect(grantFollowUpSending(other.ownerId, other.ownerId, p.id, new Date(Date.now() + 3600000), 1)).rejects.toThrow(/not active/);
    await expect(deliverApprovedEmail(other.ownerId, { dispatchId: prepared.dispatchId })).rejects.toThrow(/not found/);
    expect(send).not.toHaveBeenCalled();
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("reads current withdrawal state after a transaction has already opened an older MySQL snapshot", async () => {
    const f = await followupFixture(), p = await f.enroll(), plan = await f.getPlan(p.id);
    const result = await f.db.transaction(async (tx: any) => {
      const original = (await tx.select().from(candidates).where(eq(candidates.id, f.candidateId)).limit(1))[0];
      expect(original.withdrawnAt).toBeNull();
      await f.db.update(candidates).set({ profileState: "withdrawn", withdrawnAt: new Date() }).where(eq(candidates.id, f.candidateId));
      return followUpEligibility(tx, plan);
    });
    expect(result).toMatchObject({ state: "cancelled" });
    expect(send).not.toHaveBeenCalled();
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("progresses past enrolled interview sources instead of rescanning the first page forever", async () => {
    const f = await followupFixture();
    const { interviews } = await import("../../drizzle/schema");
    const { createId } = await import("../db");
    await f.db.insert(interviews).values({ id: createId("int_"), ownerId: f.ownerId, candidateId: f.candidateId, companyId: f.companyId, jobId: f.jobId, status: "confirmed", calendarStatus: "confirmed", scheduledAt: new Date(Date.now() + 5 * 3600000), reminderAt: new Date(Date.now() - 50000) });
    expect(await processDueInterviewReminders(f.ownerId, 1)).toMatchObject({ queued: 1 });
    expect(await processDueInterviewReminders(f.ownerId, 1)).toMatchObject({ queued: 1 });
    expect(await processDueInterviewReminders(f.ownerId, 1)).toMatchObject({ scanned: 0, queued: 0 });
    expect(await f.db.select().from(followUpPlans).where(eq(followUpPlans.ownerId, f.ownerId))).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("reserves the final daily slot atomically across two distinct dispatches", async () => {
    const f = await followupFixture();
    await f.db.update(workspaceSettings).set({ dailyOutboundLimit: 1 }).where(eq(workspaceSettings.ownerId, f.ownerId));
    const a = await f.enroll(), pa = await approved(f, a.id), b = await f.enroll({ scenarioId: "FU10" }), pb = await approved(f, b.id);
    const outcomes = await Promise.all([deliverApprovedEmail(f.ownerId, { dispatchId: pa.dispatchId }), deliverApprovedEmail(f.ownerId, { dispatchId: pb.dispatchId })]);
    expect(outcomes.map(r => r.status).sort()).toEqual(["deferred", "sent"]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("allows only one competing queue worker to prepare the due step", async () => {
    const f = await followupFixture(), p = await f.enroll();
    await Promise.all([processOneQueuedJob(f.ownerId), processOneQueuedJob(f.ownerId)]);
    expect(await f.db.select().from(emailDispatches).where(eq(emailDispatches.planId, p.id))).toHaveLength(1);
    expect((await f.getPlan(p.id)).status).toBe("approval_pending");
    expect(send).not.toHaveBeenCalled();
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("serializes duplicate enrollment and concurrent delivery of one approval on MySQL", async () => {
    const f = await followupFixture();
    const enrolled = await Promise.all([f.enroll(), f.enroll()]);
    expect(enrolled[0].id).toBe(enrolled[1].id);
    const p = enrolled[0];
    const prepared = await approved(f, p.id);
    const outcomes = await Promise.allSettled([deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId }), deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
