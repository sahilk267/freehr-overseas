import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { automationGrants, candidates, consents, contacts, emailIdentities, followUpPlans, outreachCampaignRecipients, outreachCampaigns, workspaceSettings } from "../../drizzle/schema";
import { createId } from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { deliverApprovedEmail } from "./emailDelivery";
import { stopOwnerFollowUps } from "./followupEvents";
import { processDueAutomationBatch } from "./queue";
import { processDueCampaigns } from "./campaigns";

const send = vi.hoisted(() => vi.fn(async () => ({ providerMessageId: "synthetic-campaign-acceptance" })));
vi.mock("./hostingerMail", async original => ({ ...await original(), isSenderIdentityConfigured: () => true, sendViaHostingerMailApi: send }));

async function fixture(overrides: Record<string, unknown> = {}) {
  const f = await followupFixture();
  const input = { requestKey: createId("request_"), name: "Synthetic client acquisition", scenarioId: "FU01" as const, senderIdentityId: f.senders.clients, recipientIds: [f.contactId], timezone: "UTC", businessDaysOnly: false, deadlineAt: new Date(Date.now() + 7 * 86400000), executionMode: "delegated" as const, steps: [{ delayMinutes: 0, subject: "Hello {{name}}", body: "Recruitment enquiry for {{company}}. {{opt_out}}" }], ...overrides };
  const draft = await f.caller.campaigns.draft(input as never);
  const detail = () => f.caller.campaigns.detail({ id: draft.id });
  const launch = async () => {
    const preview = await f.caller.campaigns.preview({ id: draft.id });
    const result = await f.caller.campaigns.launch({ id: draft.id, expectedRevision: 1, previewHash: preview.previewHash, authorizeSending: true });
    return { ...result, preview };
  };
  const tick = async () => {
    await f.db.update(outreachCampaigns).set({ lastProcessedAt: null }).where(eq(outreachCampaigns.id, draft.id));
    return processDueCampaigns(f.ownerId);
  };
  return { ...f, input, id: draft.id, detail, launch, tick };
}

describe("campaign intent using the one central follow-up and delivery engine", () => {
  beforeEach(() => send.mockReset().mockResolvedValue({ providerMessageId: "synthetic-campaign-acceptance" }));
  it("deduplicates a retried draft and rejects changed content under its request key", async () => {
    const f = await fixture();
    expect(await f.caller.campaigns.draft(f.input)).toMatchObject({ id: f.id, alreadyCreated: true });
    await expect(f.caller.campaigns.draft({ ...f.input, name: "Changed intent" })).rejects.toThrow(/different campaign/);
    expect((await f.detail()).recipients).toHaveLength(1);
  });
  it("renders exact personalized previews and prevents automatic sending without express scope approval", async () => {
    const f = await fixture(), p = await f.caller.campaigns.preview({ id: f.id });
    expect(p.audience[0].steps[0]).toMatchObject({ subject: "Hello Synthetic client contact", body: "Recruitment enquiry for Synthetic test client. Reply STOP to stop future messages." });
    await expect(f.caller.campaigns.launch({ id: f.id, expectedRevision: 1, previewHash: p.previewHash, authorizeSending: false })).rejects.toThrow(/Explicitly authorize/);
    expect((await f.detail()).campaign.status).toBe("draft");
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects a stale preview when an audience address changes", async () => {
    const f = await fixture(), p = await f.caller.campaigns.preview({ id: f.id });
    await f.db.update(contacts).set({ email: "changed@example.test" }).where(eq(contacts.id, f.contactId));
    await expect(f.caller.campaigns.launch({ id: f.id, expectedRevision: 1, previewHash: p.previewHash, authorizeSending: true })).rejects.toThrow(/fresh preview/);
    expect((await f.detail()).campaign.status).toBe("draft");
  });
  it("cannot turn an unreviewed draft into an active campaign through pause/resume controls", async () => {
    const f = await fixture();
    await expect(f.caller.campaigns.control({ id: f.id, expectedRevision: 1, action: "pause" })).rejects.toThrow(/active reviewed/);
    await expect(f.caller.campaigns.control({ id: f.id, expectedRevision: 1, action: "resume_review" })).rejects.toThrow(/paused/);
    expect((await f.detail()).campaign).toMatchObject({ status: "draft", revision: 1 });
  });
  it("launch replay reuses the activation and source replay creates only one plan/grant", async () => {
    const f = await fixture(), result = await f.launch();
    expect(await f.caller.campaigns.launch({ id: f.id, expectedRevision: 1, previewHash: result.preview.previewHash, authorizeSending: true })).toMatchObject({ alreadyActive: true });
    expect(await f.tick()).toMatchObject({ enrolled: 1, failures: [] });
    expect(await f.tick()).toMatchObject({ enrolled: 0, failures: [] });
    const member = (await f.detail()).recipients[0];
    expect(await f.getPlan(member.planId!)).toMatchObject({ executionMode: "delegated", steps: result.preview.audience[0].steps });
    expect(await f.db.select().from(automationGrants).where(eq(automationGrants.planId, member.planId!))).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });
  it("bounded background batches discover campaign intent and use the existing outbox", async () => {
    const f = await fixture(); await f.launch();
    const result = await processDueAutomationBatch(f.ownerId, 2);
    expect(result.sources?.campaigns).toMatchObject({ enrolled: 1, failures: [] });
    expect((await f.detail()).recipients[0].planId).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("review mode prepares a pending message without sending or granting", async () => {
    const f = await fixture({ executionMode: "review" }); await f.launch(); await f.tick();
    const id = (await f.detail()).recipients[0].planId!;
    const prepared = await f.prepare(id);
    expect(prepared.status).toBe("approval_pending");
    expect((await f.getPlan(id)).executionMode).toBe("review");
    expect(await f.db.select().from(automationGrants).where(eq(automationGrants.planId, id))).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
  it("pausing revokes authority and blocks an already prepared dispatch", async () => {
    const f = await fixture(); await f.launch(); await f.tick();
    const id = (await f.detail()).recipients[0].planId!, prepared = await f.prepare(id);
    await f.caller.campaigns.control({ id: f.id, expectedRevision: 2, action: "pause" });
    expect((await f.getPlan(id)).status).toBe("paused");
    expect((await f.db.select().from(automationGrants).where(eq(automationGrants.planId, id)))[0].active).toBe(false);
    await expect(deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("resume does not silently renew grants or restart a replied/paused sequence", async () => {
    const f = await fixture(); await f.launch(); await f.tick();
    const id = (await f.detail()).recipients[0].planId!;
    await f.caller.campaigns.control({ id: f.id, expectedRevision: 2, action: "pause" });
    await f.caller.campaigns.control({ id: f.id, expectedRevision: 3, action: "resume_review" }); await f.tick();
    expect((await f.detail()).campaign).toMatchObject({ executionMode: "review", status: "active" });
    expect(await f.getPlan(id)).toMatchObject({ status: "paused", executionMode: "review" });
    expect(send).not.toHaveBeenCalled();
  });
  it("a reply stops the campaign recipient's delegated chase before classification", async () => {
    const f = await fixture(); await f.launch(); await f.tick();
    const id = (await f.detail()).recipients[0].planId!, p = await f.getPlan(id);
    const prepared = await f.prepare(id);
    await f.caller.email.inbound.record({ conversationId: p.conversationId, sender: `${f.contactId}@example.test`, body: "Can we arrange a discussion?" });
    expect((await f.getPlan(id)).status).toBe("paused");
    await expect(deliverApprovedEmail(f.ownerId, { dispatchId: prepared.dispatchId })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("address changes after launch never redirect the approved messages", async () => {
    const f = await fixture(); await f.launch();
    await f.db.update(contacts).set({ email: "redirect@example.test" }).where(eq(contacts.id, f.contactId));
    expect(await f.tick()).toMatchObject({ enrolled: 0, skipped: 1 });
    expect((await f.detail()).recipients[0]).toMatchObject({ status: "skipped", planId: null });
  });
  it("suppression and another active sequence prevent enrollment", async () => {
    const f = await fixture(); await f.launch();
    await f.enroll({ scenarioId: "FU01", conversationId: f.clientConversationId, senderIdentityId: f.senders.clients });
    expect(await f.tick()).toMatchObject({ enrolled: 0, skipped: 1 });
    expect((await f.detail()).recipients[0].reason).toMatch(/Another active/);
  });
  it("inactive senders cannot launch", async () => {
    const f = await fixture();
    await f.db.update(emailIdentities).set({ status: "disabled" }).where(eq(emailIdentities.id, f.senders.clients));
    expect((await f.caller.campaigns.preview({ id: f.id })).senderReady).toBe(false);
    await expect(f.launch()).rejects.toThrow(/verified/);
  });
  it("duplicate addresses are selected once even when legacy contact rows differ", async () => {
    const f = await fixture();
    const duplicateId = createId("ctc_");
    await f.db.insert(contacts).values({ id: duplicateId, ownerId: f.ownerId, companyId: f.companyId, name: "Duplicate synthetic person", email: `${f.contactId}@example.test`, contactPermission: "permitted" });
    const other = await f.caller.campaigns.draft({ ...f.input, requestKey: createId(), recipientIds: [f.contactId, duplicateId] });
    const preview = await f.caller.campaigns.preview({ id: other.id });
    expect(preview.eligibleCount).toBe(1);
    expect(preview.audience.filter(p => p.reason?.includes("Duplicate"))).toHaveLength(1);
  });
  it("rejects unsupported variables, missing opt-out, oversized audiences and foreign recipients", async () => {
    const f = await fixture();
    await expect(f.caller.campaigns.draft({ ...f.input, requestKey: createId(), steps: [{ delayMinutes: 0, subject: "{{secret}}", body: "Hello there {{opt_out}}" }] })).rejects.toThrow(/variables/);
    await expect(f.caller.campaigns.draft({ ...f.input, requestKey: createId(), steps: [{ delayMinutes: 0, subject: "Hello", body: "No way to opt out" }] })).rejects.toThrow(/opt_out/);
    await expect(f.caller.campaigns.draft({ ...f.input, requestKey: createId(), recipientIds: Array(101).fill(f.contactId) })).rejects.toThrow();
    const other = await followupFixture();
    await expect(f.caller.campaigns.draft({ ...f.input, requestKey: createId(), recipientIds: [other.contactId] })).rejects.toThrow(/another workspace/);
    await expect(other.caller.campaigns.detail({ id: f.id })).rejects.toThrow(/not found/);
  });
  it("does not create plans while the workspace emergency stop is enabled", async () => {
    const f = await fixture(); await f.launch();
    await f.db.update(workspaceSettings).set({ emergencyStop: true }).where(eq(workspaceSettings.ownerId, f.ownerId));
    expect(await f.tick()).toMatchObject({ enrolled: 0 });
    expect((await f.detail()).recipients[0].planId).toBeNull();
  });
  it("candidate campaigns require actual recruitment communication permission, never manufacture it", async () => {
    const f = await followupFixture();
    await f.db.update(consents).set({ status: "withdrawn" }).where(eq(consents.candidateId, f.candidateId));
    const created = await f.caller.campaigns.draft({ requestKey: createId(), name: "Candidate permission boundary", scenarioId: "FU09", senderIdentityId: f.senders.talent, recipientIds: [f.candidateId], timezone: "UTC", businessDaysOnly: false, deadlineAt: new Date(Date.now() + 86400000), executionMode: "delegated", steps: [{ delayMinutes: 0, subject: "Hello {{name}}", body: "Please confirm your preferences. {{opt_out}}" }] });
    const p = await f.caller.campaigns.preview({ id: created.id });
    expect(p.eligibleCount).toBe(0); expect(p.audience[0].reason).toMatch(/permission/);
    expect((await f.db.select().from(consents).where(eq(consents.candidateId, f.candidateId)))[0].status).toBe("withdrawn");
  });
  it("candidate erasure redacts campaign message snapshots, including unstarted members", async () => {
    const f = await followupFixture();
    const created = await f.caller.campaigns.draft({ requestKey: createId(), name: "Candidate erasure fixture", scenarioId: "FU09", senderIdentityId: f.senders.talent, recipientIds: [f.candidateId], timezone: "UTC", deadlineAt: new Date(Date.now() + 86400000), steps: [{ delayMinutes: 0, subject: "Hello {{name}}", body: "Please confirm your preferences. {{opt_out}}" }] });
    const p = await f.caller.campaigns.preview({ id: created.id }); await f.caller.campaigns.launch({ id: created.id, expectedRevision: 1, previewHash: p.previewHash, authorizeSending: false });
    expect((await f.caller.campaigns.detail({ id: created.id })).recipients[0].renderedSteps).toBeTruthy();
    await f.db.update(candidates).set({ deletedAt: new Date(), profileState: "deleted" }).where(eq(candidates.id, f.candidateId));
    await stopOwnerFollowUps(f.ownerId, { candidateId: f.candidateId }, "cancelled", "Candidate erasure", true);
    expect((await f.caller.campaigns.detail({ id: created.id })).recipients[0]).toMatchObject({ renderedSteps: null, recipientHash: null, status: "cancelled" });
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")("serializes competing MySQL campaign launches and source evaluations", async () => {
    const f = await fixture(), p = await f.caller.campaigns.preview({ id: f.id });
    const command = { id: f.id, expectedRevision: 1, previewHash: p.previewHash, authorizeSending: true };
    await Promise.all([f.caller.campaigns.launch(command), f.caller.campaigns.launch(command)]);
    const results = await Promise.all([processDueCampaigns(f.ownerId), processDueCampaigns(f.ownerId)]);
    expect(results.reduce((n, r) => n + r.enrolled, 0)).toBe(1);
    const member = (await f.detail()).recipients[0];
    expect(await f.db.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, f.ownerId), eq(followUpPlans.id, member.planId!)))).toHaveLength(1);
    expect(await f.db.select().from(automationGrants).where(eq(automationGrants.planId, member.planId!))).toHaveLength(1);
  });
});
