import * as dbModule from "../db";
import {processOneQueuedJob} from "./queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { automationQueue, contacts, conversations, messages, incidents, workspaceSettings, suppressionList, workflowEvents } from "../../drizzle/schema";
import { requireDb, createId } from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { executeClientReplyDeadline, processLegacyReplyDeadlines, assessReply, receiveReply, recommendedReplyAction } from "./replyTriage";

const interested = { classification: "interested", confidence: 95, nextAction: "prepare_follow_up", rationale: "Synthetic interest." };
const deadlineOwners:number[]=[];
afterEach(async()=>{vi.restoreAllMocks();const db=await requireDb();for(const owner of deadlineOwners.splice(0))await db.update(workspaceSettings).set({backgroundEnabled:false}).where(eq(workspaceSettings.ownerId,owner));});
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

describe("current reply action deadlines through the existing queue",()=>{
 async function dueFixture(){const f=await fixture();deadlineOwners.push(f.ownerId);await f.db.update(workspaceSettings).set({backgroundEnabled:true}).where(eq(workspaceSettings.ownerId,f.ownerId));const r=await f.receive();await f.db.update(automationQueue).set({status:"cancelled"}).where(and(eq(automationQueue.ownerId,f.ownerId),eq(automationQueue.jobType,"classify_reply")));const input={conversationId:f.clientConversationId,messageId:r.messageId,replyRevision:1,expectedActionRevision:0,action:"prepare_response" as const,notes:"Review synthetic client reply",dueAt:new Date(Date.now()-60000)};await f.caller.recruitment.outreach.recordReplyAction(input);const jobs=()=>f.db.select().from(automationQueue).where(and(eq(automationQueue.ownerId,f.ownerId),eq(automationQueue.jobType,"client_reply_deadline")));const payload=(await jobs())[0].payload;const alerts=()=>f.db.select().from(incidents).where(eq(incidents.ownerId,f.ownerId));return {...f,input,jobs,deadlinePayload:payload,alerts};}
 it("schedules one version-bound deterministic job, escalates once and never prepares mail",async()=>{const f=await dueFixture();expect(await f.caller.recruitment.outreach.recordReplyAction(f.input)).toMatchObject({alreadyRecorded:true});expect(await f.jobs()).toHaveLength(1);expect(await processOneQueuedJob(f.ownerId)).toMatchObject({status:"completed"});expect((await f.jobs())[0].result).toMatchObject({status:"escalated"});expect(await executeClientReplyDeadline(f.ownerId,f.deadlinePayload)).toMatchObject({status:"already_escalated"});expect(await f.alerts()).toHaveLength(1);expect(await f.db.select().from(messages).where(and(eq(messages.ownerId,f.ownerId),eq(messages.direction,"outbound")))).toHaveLength(0);});
 it("revised or completed action resolves its escalation and cancels superseded timer",async()=>{const f=await dueFixture();await executeClientReplyDeadline(f.ownerId,f.deadlinePayload);await f.caller.recruitment.outreach.recordReplyAction({...f.input,expectedActionRevision:1,dueAt:undefined,notes:"Review completed, no next deadline"});expect((await f.alerts())[0].status).toBe("resolved");expect((await f.jobs())[0].status).toBe("cancelled");expect(await executeClientReplyDeadline(f.ownerId,f.deadlinePayload)).toMatchObject({status:"stale"});});
 it("new reply resolves the old incident without imposing its deadline on the new reply",async()=>{const f=await dueFixture();await executeClientReplyDeadline(f.ownerId,f.deadlinePayload);await f.receive("Please clarify our revised requirements");expect((await f.alerts())[0].status).toBe("resolved");expect(await executeClientReplyDeadline(f.ownerId,f.deadlinePayload)).toMatchObject({status:"stale"});});
 it("does not escalate paused or emergency-stopped workspaces",async()=>{const f=await dueFixture();for(const settings of [{backgroundEnabled:false},{backgroundEnabled:true,emergencyStop:true}]){await f.db.update(workspaceSettings).set(settings).where(eq(workspaceSettings.ownerId,f.ownerId));expect(await executeClientReplyDeadline(f.ownerId,f.deadlinePayload)).toMatchObject({status:"deferred"});expect((await processOneQueuedJob(f.ownerId)).status).toMatch(/empty|skipped/);expect(await f.alerts()).toHaveLength(0);}});
 it("rejects different workspace, changed generation, hash and opt-out",async()=>{const f=await dueFixture(),other=await dueFixture();expect(await executeClientReplyDeadline(other.ownerId,f.deadlinePayload)).toMatchObject({status:"stale"});for(const changed of [{actionRevision:2},{replyRevision:2},{requestHash:"forged"}])expect(await executeClientReplyDeadline(f.ownerId,{...f.deadlinePayload,...changed})).toMatchObject({status:"stale"});await f.receive("Stop contacting me");expect(await executeClientReplyDeadline(f.ownerId,f.deadlinePayload)).toMatchObject({status:"stale"});expect(await f.alerts()).toHaveLength(0);});
 it("defers a future deadline and never schedules terminal actions",async()=>{const f=await dueFixture();await f.caller.recruitment.outreach.recordReplyAction({...f.input,expectedActionRevision:1,dueAt:new Date(Date.now()+3600000)});const job=(await f.jobs()).find(j=>j.status==="queued")!;expect(await executeClientReplyDeadline(f.ownerId,job.payload)).toMatchObject({status:"deferred"});await f.caller.recruitment.outreach.recordReplyAction({...f.input,expectedActionRevision:2,action:"close_no_interest"});expect((await f.jobs()).some(j=>j.status==="queued")).toBe(false);expect(await f.alerts()).toHaveLength(0);});
 it("backfills an older reviewed due action once through the same job identity",async()=>{const f=await dueFixture();await f.db.delete(automationQueue).where(and(eq(automationQueue.ownerId,f.ownerId),eq(automationQueue.jobType,"client_reply_deadline")));expect(await processLegacyReplyDeadlines(f.ownerId)).toMatchObject({scheduled:1});expect(await f.jobs()).toHaveLength(1);expect(await processLegacyReplyDeadlines(f.ownerId)).toMatchObject({scheduled:0});expect(await processOneQueuedJob(f.ownerId)).toMatchObject({status:"completed"});expect(await f.alerts()).toHaveLength(1);});
 it.runIf(process.env.FREEHR_TEST_MYSQL==="1")("serializes duplicate timer executions into one escalation",async()=>{const f=await dueFixture();await Promise.all([executeClientReplyDeadline(f.ownerId,f.deadlinePayload),executeClientReplyDeadline(f.ownerId,f.deadlinePayload)]);expect(await f.alerts()).toHaveLength(1);});
 it("explicit completion preserves action history, resolves escalation and cannot be replayed into another goal",async()=>{const f=await dueFixture();await executeClientReplyDeadline(f.ownerId,f.deadlinePayload);const input={conversationId:f.clientConversationId,messageId:f.input.messageId,replyRevision:1,actionRevision:1,reason:"Owner reviewed the client question and completed this task"};expect(await f.caller.recruitment.outreach.completeReplyAction(input)).toMatchObject({completed:true,alreadyCompleted:false});expect(await f.caller.recruitment.outreach.completeReplyAction(input)).toMatchObject({alreadyCompleted:true});const d=await f.detail();expect(d.action).toMatchObject({revision:1,dueAt:f.input.dueAt.toISOString()});expect(d.completion).toMatchObject({kind:"owner_review",reason:input.reason});expect((await f.conversation()).nextActionAt).toBeNull();expect((await f.alerts())[0].status).toBe("resolved");expect(await executeClientReplyDeadline(f.ownerId,f.deadlinePayload)).toMatchObject({status:"stale"});expect(await f.db.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,f.ownerId),eq(workflowEvents.eventType,"outreach.reply_action_completed")))).toHaveLength(1);});
 it("completion is scoped to owner, current message and exact action version",async()=>{const f=await dueFixture(),other=await dueFixture(),input={conversationId:f.clientConversationId,messageId:f.input.messageId,replyRevision:1,actionRevision:1,reason:"Owner review is complete"};await expect(other.caller.recruitment.outreach.completeReplyAction(input)).rejects.toThrow(/not found/);await expect(f.caller.recruitment.outreach.completeReplyAction({...input,actionRevision:2})).rejects.toMatchObject({code:"CONFLICT"});await f.receive("A newer client question");await expect(f.caller.recruitment.outreach.completeReplyAction(input)).rejects.toMatchObject({code:"CONFLICT"});expect((await f.detail()).completion).toBeNull();});
 it("a deliberate new action creates a fresh incomplete generation without inheriting completion",async()=>{const f=await dueFixture();await f.caller.recruitment.outreach.completeReplyAction({conversationId:f.clientConversationId,messageId:f.input.messageId,replyRevision:1,actionRevision:1,reason:"Original task completed"});await f.caller.recruitment.outreach.recordReplyAction({...f.input,expectedActionRevision:1,notes:"Fresh task after completion"});expect((await f.detail()).completion).toBeNull();expect((await f.detail()).action).toMatchObject({revision:2});expect((await f.jobs()).filter(j=>j.status==="queued")).toHaveLength(1);await executeClientReplyDeadline(f.ownerId,(await f.jobs()).find(j=>j.status==="queued")!.payload);expect((await f.alerts()).filter(i=>i.status==="detected")).toHaveLength(1);});
 it.runIf(process.env.FREEHR_TEST_MYSQL==="1")("completion and deadline race serialize without a surviving open alert",async()=>{const f=await dueFixture();await Promise.all([executeClientReplyDeadline(f.ownerId,f.deadlinePayload),f.caller.recruitment.outreach.completeReplyAction({conversationId:f.clientConversationId,messageId:f.input.messageId,replyRevision:1,actionRevision:1,reason:"Concurrent owner completion"})]);expect((await f.alerts()).filter(i=>i.status!=="resolved")).toHaveLength(0);expect((await f.detail()).completion).toMatchObject({kind:"owner_review"});});
 it.runIf(process.env.FREEHR_TEST_MYSQL==="1")("completion audit failure rolls back task, timer and incident changes",async()=>{const f=await dueFixture();await executeClientReplyDeadline(f.ownerId,f.deadlinePayload);const original=dbModule.recordAudit;vi.spyOn(dbModule,"recordAudit").mockImplementation(async(input,tx)=>{if(input.action==="outreach.reply_action_completed")throw Error("Synthetic completion persistence failure");return original(input,tx);});await expect(f.caller.recruitment.outreach.completeReplyAction({conversationId:f.clientConversationId,messageId:f.input.messageId,replyRevision:1,actionRevision:1,reason:"Completion rollback check"})).rejects.toThrow(/completion persistence/);expect((await f.detail()).completion).toBeNull();expect((await f.alerts())[0].status).toBe("detected");expect((await f.jobs())[0].status).toBe("queued");});

 it("backfills legacy deadlines that MySQL rounded to a whole second",async()=>{const f=await dueFixture();await f.db.delete(automationQueue).where(and(eq(automationQueue.ownerId,f.ownerId),eq(automationQueue.jobType,"client_reply_deadline")));const rounded=new Date(Math.round(f.input.dueAt.getTime()/1000)*1000);await f.db.update(conversations).set({nextActionAt:rounded}).where(eq(conversations.id,f.clientConversationId));expect(await processLegacyReplyDeadlines(f.ownerId)).toMatchObject({scheduled:1});expect(await f.jobs()).toHaveLength(1);});

});
