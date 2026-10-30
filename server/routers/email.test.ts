import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, emailDispatches, messages, suppressionList } from "../../drizzle/schema";
import { createId, hashContactValue } from "../db";
import { followupFixture } from "../testSupport/followupFixture";

const send = vi.hoisted(() => vi.fn(async () => ({ providerMessageId: "provider-email-test" })));
vi.mock("../services/hostingerMail", async original => ({ ...await original(), sendViaHostingerMailApi: send, isSenderIdentityConfigured: () => true }));
let f: Awaited<ReturnType<typeof followupFixture>>;
const request = () => f.caller.email.outbound.requestApproval({ conversationId: f.conversationId, senderIdentityId: f.senders.talent, recipient: f.address, subject: "Role", body: "A controlled recruitment message." });
async function approved() {
  const mail = await request();
  await f.caller.recruitment.approvals.decide({ id: mail.approvalId, decision: "approved" });
  return mail;
}
describe("email router controlled evidence with the shared delivery gateway", () => {
  beforeEach(async () => { send.mockReset().mockResolvedValue({ providerMessageId: "provider-email-test" }); f = await followupFixture(); });
  it("creates an owner-review approval and immutable content binding", async () => {
    const mail = await request();
    const detail = await f.caller.email.outbound.approvalDetail({ approvalId: mail.approvalId });
    expect(detail).toMatchObject({ approval: { actionType: "email_send", status: "pending", payload: { recipient: f.address, senderIdentityId: f.senders.talent } }, message: { status: "approval_pending", direction: "outbound" } });
    expect((detail.approval.payload as { contentHash: string }).contentHash).toHaveLength(64);
    expect(send).not.toHaveBeenCalled();
  });
  it("blocks suppressed recipients before creating approval or message", async () => {
    await f.db.insert(suppressionList).values({ id: createId("sup_"), ownerId: f.ownerId, channel: "email", valueHash: hashContactValue(f.address), reason: "Stop", source: "test", active: true });
    await expect(request()).rejects.toThrow(/suppressed/);
    expect(await f.db.select().from(approvals).where(eq(approvals.ownerId, f.ownerId))).toHaveLength(0);
  });
  it("scopes approval details and message history to the owner", async () => {
    const mail = await request(), other = await followupFixture();
    await expect(other.caller.email.outbound.approvalDetail({ approvalId: mail.approvalId })).rejects.toThrow(/not found/);
    await expect(other.caller.email.inbound.messages({ conversationId: f.conversationId, limit: 20 })).rejects.toThrow(/not found/);
    expect(await f.caller.email.inbound.messages({ conversationId: f.conversationId, limit: 20 })).toMatchObject([{ id: mail.messageId }]);
  });
  it("rejects delivery before an approved action exists", async () => {
    const mail = await request();
    await expect(f.caller.email.outbound.deliverApproved({ messageId: mail.messageId })).rejects.toThrow(/approved email action/);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects a supplied recipient that differs from the approval", async () => {
    const mail = await approved();
    await expect(f.caller.email.outbound.deliverApproved({ messageId: mail.messageId, recipient: "attacker@example.test" })).rejects.toThrow(/recipient.*match/);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects a supplied sender that differs from the approval", async () => {
    const mail = await approved();
    await expect(f.caller.email.outbound.deliverApproved({ messageId: mail.messageId, senderIdentityId: "wrong-sender" })).rejects.toThrow(/sender.*match/);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects an already consumed authorization", async () => {
    const mail = await approved();
    await f.db.update(approvals).set({ actionedAt: new Date() }).where(eq(approvals.id, mail.approvalId));
    await expect(f.caller.email.outbound.deliverApproved({ messageId: mail.messageId })).rejects.toThrow(/consumed/);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects an already sent message", async () => {
    const mail = await approved();
    await f.db.update(messages).set({ status: "sent" }).where(eq(messages.id, mail.messageId));
    await expect(f.caller.email.outbound.deliverApproved({ messageId: mail.messageId })).rejects.toThrow(/consumed/);
    expect(send).not.toHaveBeenCalled();
  });
  it("rechecks suppression after approval", async () => {
    const mail = await approved();
    await f.db.insert(suppressionList).values({ id: createId("sup_"), ownerId: f.ownerId, channel: "email", valueHash: hashContactValue(f.address), reason: "Stop", source: "test", active: true });
    await expect(f.caller.email.outbound.deliverApproved({ messageId: mail.messageId })).rejects.toThrow(/suppressed/);
    expect(send).not.toHaveBeenCalled();
  });
  it("rechecks content after approval", async () => {
    const mail = await approved();
    await f.db.update(messages).set({ body: "Changed unapproved message" }).where(eq(messages.id, mail.messageId));
    await expect(f.caller.email.outbound.deliverApproved({ messageId: mail.messageId })).rejects.toThrow(/content changed/);
    expect(send).not.toHaveBeenCalled();
  });
  it("delivers with only the approved message id and persists an acceptance receipt", async () => {
    const mail = await approved();
    expect(send).not.toHaveBeenCalled();
    expect(await f.caller.email.outbound.deliverApproved({ messageId: mail.messageId })).toMatchObject({ success: true, providerMessageId: "provider-email-test" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ purpose: "talent", to: f.address, subject: "Role", text: "A controlled recruitment message." }));
    expect((await f.db.select().from(approvals).where(eq(approvals.id, mail.approvalId)))[0].actionedAt).toBeInstanceOf(Date);
    expect((await f.db.select().from(emailDispatches).where(eq(emailDispatches.messageId, mail.messageId)))[0].status).toBe("sent");
    expect((await f.db.select().from(messages).where(eq(messages.id, mail.messageId)))[0]).toMatchObject({ status: "sent", providerMessageId: "provider-email-test", deliveredAt: null });
  });
});
