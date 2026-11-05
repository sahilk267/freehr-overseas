import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { automationQueue, contacts, conversations, messages, suppressionList, workflowEvents } from "../../drizzle/schema";
import { createId } from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { assessReply, receiveReply, recommendedReplyAction } from "./replyTriage";

const interested = { classification: "interested", confidence: 95, nextAction: "prepare_follow_up", rationale: "Synthetic interest." };
async function fixture() {
  const f = await followupFixture();
  const receive = (body = "Can we arrange a discovery call?", providerMessageId = createId("provider_"), conversationId = f.clientConversationId) => receiveReply(f.ownerId, { conversationId, body, providerMessageId, source: "synthetic_test" });
  const payload = async (queueId: string | null) => (await f.db.select().from(automationQueue).where(eq(automationQueue.id, queueId!)))[0].payload as Record<string, unknown>;
  const detail = () => f.caller.recruitment.outreach.replyCase({ conversationId: f.clientConversationId });
  const conversation = async () => (await f.db.select().from(conversations).where(eq(conversations.id, f.clientConversationId)))[0];
  return { ...f, receive, payload, detail, conversation };
}
describe("current-reply triage and one bounded client next action", () => {
  it("deduplicates provider replay across ingress adapters without another queue or cursor", async () => {
    const f = await fixture(), id = createId("provider_"), first = await f.receive("Synthetic enquiry", id);
    expect(await f.receive("Synthetic enquiry", id)).toMatchObject({ messageId: first.messageId, alreadyReceived: true });
    expect(await f.db.select().from(messages).where(eq(messages.conversationId, f.clientConversationId))).toHaveLength(1);
    expect(await f.db.select().from(automationQueue).where(eq(automationQueue.ownerId, f.ownerId))).toHaveLength(1);
    expect(await f.detail()).toMatchObject({ replyRevision: 1 });
    await expect(f.receive("Changed content", id)).rejects.toThrow(/different content/);
    await expect(f.receive("Synthetic enquiry", id, f.conversationId)).rejects.toThrow(/different content/);
  });
  it("supports maximum-length provider IDs without exceeding stored idempotency length", async () => {
    const f = await fixture(); await f.receive("Synthetic", "p".repeat(255));
    const [message] = await f.db.select().from(messages).where(eq(messages.conversationId, f.clientConversationId));
    expect(message.idempotencyKey.length).toBeLessThanOrEqual(160);
  });
  it("rejects a different workspace's conversation", async () => {
    const f = await fixture(), other = await fixture();
    await expect(receiveReply(other.ownerId, { conversationId: f.clientConversationId, body: "Synthetic", source: "test" })).rejects.toThrow(/not found/);
    await expect(other.caller.recruitment.outreach.replyCase({ conversationId: f.clientConversationId })).rejects.toThrow(/not found/);
  });
  it("pauses the existing campaign chase atomically on any reply", async () => {
    const f = await fixture(), plan = await f.enroll({ scenarioId: "FU01", conversationId: f.clientConversationId, senderIdentityId: f.senders.clients });
    await f.prepare(plan.id);
    await f.receive();
    expect(await f.getPlan(plan.id)).toMatchObject({ status: "paused", executionMode: "review" });
  });
  it("immediately propagates deterministic opt-out and never silently restores permission", async () => {
    const f = await fixture(), stopped = await f.receive("Please stop contacting me");
    expect(stopped).toMatchObject({ optedOut: true, queueId: null });
    expect(await f.conversation()).toMatchObject({ status: "opted_out", classification: "stop_contact" });
    expect((await f.db.select().from(contacts).where(eq(contacts.id, f.contactId)))[0]).toMatchObject({ contactPermission: "opted_out" });
    expect(await f.db.select().from(suppressionList).where(eq(suppressionList.ownerId, f.ownerId))).toHaveLength(1);
    expect(await f.receive("Thank you")).toMatchObject({ optedOut: true, queueId: null });
    expect(await f.detail()).toMatchObject({ recommendation: "stop_contact", blocked: true });
  });
  it("manual classify ingress also applies opt-out before model processing", async () => {
    const f = await fixture();
    expect(await f.caller.recruitment.outreach.classifyInboundReply({ conversationId: f.clientConversationId, messageText: "Please stop contacting me" })).toMatchObject({ optedOut: true, queueId: null });
    expect(await f.conversation()).toMatchObject({ status: "opted_out" });
  });
  it("records stale AI evidence without overwriting the latest reply state", async () => {
    const f = await fixture(), old = await f.receive(), oldPayload = await f.payload(old.queueId);
    await f.receive("Please stop contacting me");
    expect(await assessReply(f.ownerId, oldPayload, interested, "synthetic-model")).toMatchObject({ applied: false });
    expect(await f.conversation()).toMatchObject({ status: "opted_out", classification: "stop_contact" });
    const [event] = await f.db.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, f.ownerId), eq(workflowEvents.eventType, "outreach.reply_assessed")));
    expect(event.metadata).toMatchObject({ applied: false, reason: "stale_or_unbound_reply" });
  });
  it("does not apply legacy unbound or modified-body jobs", async () => {
    const f = await fixture(), first = await f.receive(), payload = await f.payload(first.queueId);
    expect(await assessReply(f.ownerId, { conversationId: f.clientConversationId }, interested, "test")).toMatchObject({ applied: false, reason: "unbound_reply" });
    await f.db.update(messages).set({ body: "Edited input" }).where(eq(messages.id, first.messageId));
    expect(await assessReply(f.ownerId, payload, interested, "test")).toMatchObject({ applied: false });
    expect((await f.conversation()).classification).toBeNull();
  });
  it("only current validated model assessment supplies a discovery recommendation; replay is immutable", async () => {
    const f = await fixture(), first = await f.receive(), payload = await f.payload(first.queueId);
    expect(await assessReply(f.ownerId, payload, { ...interested, classification: "meeting_requested", nextAction: "schedule_discovery" }, "test")).toMatchObject({ applied: true, recommendation: "arrange_discovery" });
    expect(await assessReply(f.ownerId, payload, interested, "test")).toMatchObject({ alreadyAssessed: true });
    expect(await f.detail()).toMatchObject({ recommendation: "arrange_discovery", action: null });
    expect(await f.conversation()).toMatchObject({ status: "reply_received" });
  });
  it("routes uncertain and explicit model-review cases to owner review", () => {
    expect(recommendedReplyAction({ ...interested, confidence: 79 })).toBe("review_reply");
    expect(recommendedReplyAction({ ...interested, nextAction: "request_owner_review" })).toBe("review_reply");
    expect(recommendedReplyAction({ ...interested, classification: "unknown" })).toBe("review_reply");
  });
  it("applies a current model stop through the existing suppression and follow-up engine", async () => {
    const f = await fixture(), plan = await f.enroll({ scenarioId: "FU01", conversationId: f.clientConversationId, senderIdentityId: f.senders.clients });
    const first = await f.receive("Synthetic indirect refusal");
    await assessReply(f.ownerId, await f.payload(first.queueId), { ...interested, classification: "opt_out", nextAction: "stop_contact" }, "test");
    expect(await f.getPlan(plan.id)).toMatchObject({ status: "cancelled" });
    expect(await f.conversation()).toMatchObject({ status: "opted_out" });
    expect(await f.db.select().from(suppressionList).where(eq(suppressionList.ownerId, f.ownerId))).toHaveLength(1);
  });
  it("owner next actions are versioned, exact-retry safe and reject changed or stale input", async () => {
    const f = await fixture(), first = await f.receive();
    const input = { conversationId: f.clientConversationId, messageId: first.messageId, replyRevision: 1, expectedActionRevision: 0, action: "arrange_discovery" as const, notes: "Review availability with the client", dueAt: new Date(Date.now() + 3600000) };
    expect(await f.caller.recruitment.outreach.recordReplyAction(input)).toMatchObject({ revision: 1 });
    expect(await f.caller.recruitment.outreach.recordReplyAction(input)).toMatchObject({ revision: 1, alreadyRecorded: true });
    await expect(f.caller.recruitment.outreach.recordReplyAction({ ...input, notes: "Changed next action" })).rejects.toThrow(/Next action changed/);
    await f.receive("Newer requirement details");
    await expect(f.caller.recruitment.outreach.recordReplyAction({ ...input, expectedActionRevision: 1 })).rejects.toThrow(/newer reply/);
    expect(await f.detail()).toMatchObject({ replyRevision: 2, action: null });
  });
  it("does not repurpose candidate interviews or blocked clients as discovery tasks", async () => {
    const f = await fixture();
    await expect(f.caller.recruitment.outreach.replyCase({ conversationId: f.conversationId })).rejects.toThrow(/client contact/);
    const first = await f.receive("Please stop contacting me");
    await expect(f.caller.recruitment.outreach.recordReplyAction({ conversationId: f.clientConversationId, messageId: first.messageId, replyRevision: 1, expectedActionRevision: 0, action: "arrange_discovery", notes: "Invalid contact restart" })).rejects.toThrow(/blocked/);
  });
  it("redacts private capability quotes before storing or sending AI inputs", async () => {
    const f = await fixture(), first = await f.receive("Quoted https://freelancehr.overseasjob.in/availability#avi_example.secret-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(JSON.stringify(await f.payload(first.queueId))).not.toContain("secret-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect((await f.detail()).message!.body).not.toContain("secret-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("serializes concurrent duplicate receipts to one message, cursor and AI job in MySQL", async () => {
    const f = await fixture(), providerId = createId("parallel_");
    const results = await Promise.all([f.receive("Concurrent synthetic reply", providerId), f.receive("Concurrent synthetic reply", providerId)]);
    expect(results[0].messageId).toBe(results[1].messageId);
    expect(results.filter(result => result.alreadyReceived)).toHaveLength(1);
    expect(await f.db.select().from(messages).where(eq(messages.conversationId, f.clientConversationId))).toHaveLength(1);
    expect(await f.detail()).toMatchObject({ replyRevision: 1 });
  });
  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("serializes simultaneous distinct receipts without losing a cursor revision in MySQL", async () => {
    const f = await fixture();
    const results = await Promise.all([f.receive("First simultaneous reply"), f.receive("Second simultaneous reply")]);
    const payloads = await Promise.all(results.map(result => f.payload(result.queueId)));
    for (const payload of payloads) await assessReply(f.ownerId, payload, interested, "synthetic-test");
    const detail = await f.detail();
    expect(detail.replyRevision).toBe(2);
    const assessments = await f.db.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, f.ownerId), eq(workflowEvents.eventType, "outreach.reply_assessed")));
    expect(assessments.filter((event: any) => event.metadata.applied)).toHaveLength(1);
    expect(assessments.find((event: any) => event.metadata.applied)?.aggregateId).toBe(detail.message?.id);
  });

});
