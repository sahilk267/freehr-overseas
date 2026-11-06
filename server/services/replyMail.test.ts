import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, contacts, conversations, emailDispatches, messages } from "../../drizzle/schema";
import { followupFixture } from "../testSupport/followupFixture";
import { createId } from "../db";
import { receiveReply } from "./replyTriage";
import { deliverApprovedEmail } from "./emailDelivery";
import { appendWorkflowEvent } from "./workflowStore";
import { emailContentHash } from "./emailAuthorization";
import { createHash } from "node:crypto";
const send = vi.hoisted(() => vi.fn(async (_input: Record<string, unknown>) => ({ providerMessageId: "synthetic-reply-acceptance" })));
vi.mock("./hostingerMail", async original => ({ ...await original(), isSenderIdentityConfigured: () => true, sendViaHostingerMailApi: send }));
async function fixture() {
  const f = await followupFixture();
  const inbound = await receiveReply(f.ownerId, { conversationId: f.clientConversationId, body: "Could we discuss hiring requirements tomorrow?", source: "test" });
  const actionInput = { conversationId: f.clientConversationId, messageId: inbound.messageId, replyRevision: 1, expectedActionRevision: 0, action: "arrange_discovery" as const, notes: "Confirm suitable discovery times with client" };
  await f.caller.recruitment.outreach.recordReplyAction(actionInput);
  const input = { conversationId: f.clientConversationId, messageId: inbound.messageId, replyRevision: 1, actionRevision: 1, senderIdentityId: f.senders.clients, subject: "Discovery availability", body: "Please share two convenient times for a short discovery call." };
  const prepare = () => f.caller.recruitment.outreach.prepareReplyEmail(input);
  const approve = (id: string) => f.caller.recruitment.approvals.decide({ id, decision: "approved" });
  return { ...f, input, actionInput, prepare, approve };
}
describe("current-reply-bound client response using the existing approval and dispatch gateway", () => {
  beforeEach(() => send.mockClear());
  it("prepares one immutable recipient-bound draft and reuses an exact retry without sending", async () => {
    const f = await fixture(), draft = await f.prepare();
    expect(await f.prepare()).toMatchObject({ ...draft, alreadyExists: true });
    const detail = await f.caller.email.outbound.approvalDetail({ approvalId: draft.approvalId });
    expect(detail.approval.payload).toMatchObject({ senderIdentityId: f.senders.clients, replyScope: { messageId: f.input.messageId, replyRevision: 1, actionRevision: 1, contactId: f.contactId } });
    expect(detail.message?.body).toContain("Reply STOP");
    expect(await f.db.select().from(emailDispatches).where(eq(emailDispatches.ownerId, f.ownerId))).toHaveLength(1);
    await expect(f.caller.recruitment.outreach.prepareReplyEmail({ ...f.input, body: "Different response content" })).rejects.toThrow(/different response/);
    expect(send).not.toHaveBeenCalled();
  });
  it("retains ordinary email hash compatibility when no reply scope is present", () => {
    const input = { senderIdentityId: "sender", recipient: "EXAMPLE@example.test", subject: "subject", body: "body" };
    expect(emailContentHash(input)).toBe(createHash("sha256").update(JSON.stringify([input.senderIdentityId, input.recipient.toLowerCase(), input.subject, input.body])).digest("hex"));
  });
  it("a newer inbound reply invalidates pending authorization", async () => {
    const f = await fixture(), draft = await f.prepare();
    await receiveReply(f.ownerId, { conversationId: f.clientConversationId, body: "Actually please clarify the fees first", source: "test" });
    await expect(f.approve(draft.approvalId)).rejects.toThrow(/reply or next action changed/);
    expect(send).not.toHaveBeenCalled();
  });
  it("a newer reply after approval still prevents delivery and leaves authority unconsumed", async () => {
    const f = await fixture(), draft = await f.prepare(); await f.approve(draft.approvalId);
    await receiveReply(f.ownerId, { conversationId: f.clientConversationId, body: "The requirement has changed", source: "test" });
    await expect(deliverApprovedEmail(f.ownerId, { messageId: draft.messageId })).rejects.toThrow(/reply or next action changed/);
    expect((await f.db.select().from(approvals).where(eq(approvals.id, draft.approvalId)))[0].actionedAt).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
  it("task edits and contact-address changes invalidate prepared authorization", async () => {
    const f = await fixture(), draft = await f.prepare();
    await f.caller.recruitment.outreach.recordReplyAction({ ...f.actionInput, expectedActionRevision: 1, notes: "Clarify requirements before arranging discovery" });
    await expect(f.approve(draft.approvalId)).rejects.toThrow(/reply or next action changed/);
    const g = await fixture(), second = await g.prepare();
    await g.db.update(contacts).set({ email: "changed@example.test" }).where(eq(contacts.id, g.contactId));
    await expect(g.approve(second.approvalId)).rejects.toThrow(/recipient changed/);
  });
  it("permission expiry and opt-out prevent authorization and delivery", async () => {
    const f = await fixture(), draft = await f.prepare();
    await appendWorkflowEvent(f.db, f.ownerId, "communication.permission_recorded", f.contactId, 1, { expiresAt: new Date(Date.now() - 60000).toISOString() });
    await expect(f.approve(draft.approvalId)).rejects.toThrow(/permission.*expired/);
    const g = await fixture(), second = await g.prepare(); await g.approve(second.approvalId);
    await g.db.update(contacts).set({ contactPermission: "opted_out", optedOutAt: new Date() }).where(eq(contacts.id, g.contactId));
    await expect(deliverApprovedEmail(g.ownerId, { messageId: second.messageId })).rejects.toThrow(/reply or next action changed/);
    expect(send).not.toHaveBeenCalled();
  });
  it("cannot substitute a different conversation contact", async () => {
    const f = await fixture(), draft = await f.prepare();
    await f.db.update(conversations).set({ contactId: null }).where(eq(conversations.id, f.clientConversationId));
    await expect(f.approve(draft.approvalId)).rejects.toThrow(/client contact/);
  });
  it("rejects candidate threads, unrelated owners and wrong-purpose sender identities", async () => {
    const f = await fixture(), other = await followupFixture();
    await expect(other.caller.recruitment.outreach.prepareReplyEmail(f.input)).rejects.toThrow(/not found/);
    await expect(f.caller.recruitment.outreach.prepareReplyEmail({ ...f.input, conversationId: f.conversationId })).rejects.toThrow(/client contact/);
    await expect(f.caller.recruitment.outreach.prepareReplyEmail({ ...f.input, senderIdentityId: f.senders.talent })).rejects.toThrow(/client sender/);
  });
  it("rejection cancels the draft and permits a separately revised owner action", async () => {
    const f = await fixture(), draft = await f.prepare();
    await f.caller.recruitment.approvals.decide({ id: draft.approvalId, decision: "rejected", reason: "Rework this response" });
    expect((await f.db.select().from(messages).where(eq(messages.id, draft.messageId)))[0].status).toBe("cancelled");
    expect((await f.db.select().from(emailDispatches).where(eq(emailDispatches.messageId, draft.messageId)))[0].status).toBe("cancelled");
    await f.caller.recruitment.outreach.recordReplyAction({ ...f.actionInput, expectedActionRevision: 1, notes: "Revised discovery response after review" });
    expect(await f.caller.recruitment.outreach.prepareReplyEmail({ ...f.input, actionRevision: 2, body: "Revised response for owner review" })).toMatchObject({ alreadyExists: false });
    expect(send).not.toHaveBeenCalled();
  });
  it("changing an action cannot fork a second pending or consumed response", async () => {
    const f = await fixture(); await f.prepare();
    await f.caller.recruitment.outreach.recordReplyAction({ ...f.actionInput, expectedActionRevision: 1, notes: "Revised task with unresolved previous response" });
    await expect(f.caller.recruitment.outreach.prepareReplyEmail({ ...f.input, actionRevision: 2 })).rejects.toThrow(/previous response/);
  });
  it("shared delivery sends the exact approved response once, then blocks replay and replacement", async () => {
    const f = await fixture(), draft = await f.prepare(); await f.approve(draft.approvalId);
    expect(await deliverApprovedEmail(f.ownerId, { messageId: draft.messageId })).toMatchObject({ success: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ purpose: "clients", subject: f.input.subject, text: expect.stringContaining(f.input.body) });
    await expect(deliverApprovedEmail(f.ownerId, { messageId: draft.messageId })).rejects.toThrow(/consumed/);
    await f.caller.recruitment.outreach.recordReplyAction({ ...f.actionInput, expectedActionRevision: 1, notes: "Revised task after a consumed response" });
    await expect(f.caller.recruitment.outreach.prepareReplyEmail({ ...f.input, actionRevision: 2 })).rejects.toThrow(/previous response/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("can revoke approved but unused authority, cancel its queue and replace only after an explicit task revision", async () => {
    const f = await fixture(), draft = await f.prepare(); await f.approve(draft.approvalId);
    const cancelInput = { approvalId: draft.approvalId, reason: "Owner requested a revised client response" };
    expect(await f.caller.recruitment.outreach.cancelReplyEmail(cancelInput)).toMatchObject({ alreadyCancelled: false });
    expect(await f.caller.recruitment.outreach.cancelReplyEmail(cancelInput)).toMatchObject({ alreadyCancelled: true });
    await expect(deliverApprovedEmail(f.ownerId, { messageId: draft.messageId })).rejects.toThrow();
    await f.caller.recruitment.outreach.recordReplyAction({ ...f.actionInput, expectedActionRevision: 1, notes: "Revised next action after cancelling unused authority" });
    expect(await f.caller.recruitment.outreach.prepareReplyEmail({ ...f.input, actionRevision: 2 })).toMatchObject({ alreadyExists: false });
    expect(send).not.toHaveBeenCalled();
  });
  it("cannot cancel attempted or unknown authority, and denies unrelated owners", async () => {
    const f = await fixture(), draft = await f.prepare(), other = await followupFixture();
    await expect(other.caller.recruitment.outreach.cancelReplyEmail({ approvalId: draft.approvalId, reason: "Unrelated owner cancellation" })).rejects.toThrow(/not found/);
    await f.db.update(emailDispatches).set({ status: "reconciliation_required", claimedAt: new Date() }).where(eq(emailDispatches.messageId, draft.messageId));
    await expect(f.caller.recruitment.outreach.cancelReplyEmail({ approvalId: draft.approvalId, reason: "Invalid unknown outcome cancellation" })).rejects.toThrow(/consumed or attempted/);
    expect((await f.caller.recruitment.outreach.replyCase({ conversationId: f.clientConversationId })).response?.cancellable).toBe(false);
  });

});

describe("reply response outcome completion",()=>{
 beforeEach(()=>send.mockClear());
 async function responseGoal(){const f=await fixture();await f.caller.recruitment.outreach.recordReplyAction({...f.actionInput,expectedActionRevision:1,action:"prepare_response",notes:"Send an approved response to the current client reply"});const input={...f.input,actionRevision:2};const d=await f.caller.recruitment.outreach.prepareReplyEmail(input);await f.approve(d.approvalId);return {...f,d};}
 it("only actual provider acceptance completes a prepare-response goal, with delivery still unverified",async()=>{const f=await responseGoal();expect((await f.caller.recruitment.outreach.replyCase({conversationId:f.clientConversationId})).completion).toBeNull();await deliverApprovedEmail(f.ownerId,{messageId:f.d.messageId});const detail=await f.caller.recruitment.outreach.replyCase({conversationId:f.clientConversationId});expect(detail.completion).toMatchObject({kind:"response_provider_accepted",resourceId:f.d.messageId});expect(detail.completion?.reason).toMatch(/delivery is not confirmed/);expect(detail.response?.deliveryStatus).toBe("sent");expect(send).toHaveBeenCalledTimes(1);});
 it("sending a discovery invitation does not complete booking or imply attendance",async()=>{const f=await fixture(),d=await f.prepare();await f.approve(d.approvalId);await deliverApprovedEmail(f.ownerId,{messageId:d.messageId});expect((await f.caller.recruitment.outreach.replyCase({conversationId:f.clientConversationId})).completion).toBeNull();});
 it("unknown provider outcome preserves reconciliation and leaves the task incomplete",async()=>{const f=await responseGoal();send.mockRejectedValueOnce(Error("Synthetic lost provider acknowledgement"));await expect(deliverApprovedEmail(f.ownerId,{messageId:f.d.messageId})).rejects.toThrow(/reconciliation/);const detail=await f.caller.recruitment.outreach.replyCase({conversationId:f.clientConversationId});expect(detail.completion).toBeNull();expect(detail.response?.deliveryStatus).toBe("reconciliation_required");await expect(f.caller.recruitment.outreach.completeReplyAction({conversationId:f.clientConversationId,messageId:f.input.messageId,replyRevision:1,actionRevision:2,reason:"Owner tries to close uncertain delivery"})).rejects.toThrow(/uncertain delivery/);});
 it("a reply arriving during the provider call cannot complete the newer task or erase a known acceptance",async()=>{const f=await responseGoal();send.mockImplementationOnce(async()=>{await receiveReply(f.ownerId,{conversationId:f.clientConversationId,body:"Our question has changed",source:"synthetic_test"});return {providerMessageId:"synthetic-late-acceptance"};});expect(await deliverApprovedEmail(f.ownerId,{messageId:f.d.messageId})).toMatchObject({success:true});expect((await f.caller.recruitment.outreach.replyCase({conversationId:f.clientConversationId})).completion).toBeNull();expect((await f.db.select().from(emailDispatches).where(eq(emailDispatches.messageId,f.d.messageId)))[0].status).toBe("sent");});
 it("owner completion requires cancelling unused outbound approval first",async()=>{const f=await fixture(),d=await f.prepare(),scope={conversationId:f.clientConversationId,messageId:f.input.messageId,replyRevision:1,actionRevision:1,reason:"Owner finished this review task"};await expect(f.caller.recruitment.outreach.completeReplyAction(scope)).rejects.toThrow(/prepared response/);await f.caller.recruitment.outreach.cancelReplyEmail({approvalId:d.approvalId,reason:"Cancel unused approval before completing review"});expect(await f.caller.recruitment.outreach.completeReplyAction(scope)).toMatchObject({completed:true});await expect(f.prepare()).rejects.toThrow(/next action changed/);expect(send).not.toHaveBeenCalled();});
 it("recipient changes during sending preserve known acceptance without completing changed intent",async()=>{const f=await responseGoal();send.mockImplementationOnce(async()=>{await f.db.update(contacts).set({email:"changed-recipient@example.test"}).where(eq(contacts.id,f.contactId));return {providerMessageId:"synthetic-prior-recipient-acceptance"};});expect(await deliverApprovedEmail(f.ownerId,{messageId:f.d.messageId})).toMatchObject({success:true});expect((await f.caller.recruitment.outreach.replyCase({conversationId:f.clientConversationId})).completion).toBeNull();expect((await f.db.select().from(emailDispatches).where(eq(emailDispatches.messageId,f.d.messageId)))[0].status).toBe("sent");});

});
