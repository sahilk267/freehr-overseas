import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { createId, requireDb } from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { enrollFollowUp, prepareFollowUp } from "./followups";
import { deliverApprovedEmail } from "./emailDelivery";
import { controlFollowUp } from "./followupControl";
import {
  nextRecipientContactTime,
  getRecipientTiming,
  readContactTiming,
  saveContactTiming,
  retireContactTiming,
} from "./contactTiming";
const send = vi.hoisted(() =>
  vi.fn(async (_input: any) => ({
    providerMessageId: "synthetic-contact-timing-receipt",
  }))
);
vi.mock("./hostingerMail", async original => ({
  ...(await original()),
  isSenderIdentityConfigured: () => true,
  sendViaHostingerMailApi: send,
}));
const workspace = { timezone: "UTC", quietStart: "00:00", quietEnd: "00:00" },
  at = new Date("2026-11-13T12:00:00Z"),
  fields = (override: any = {}) => ({
    timezone: "UTC",
    preferredChannel: "email" as const,
    validUntil: new Date("2027-01-01"),
    ...override,
  });
const owners: number[] = [];
beforeEach(() => send.mockClear());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const ownerId of owners.splice(0))
    await (await requireDb())
      .update(schema.workspaceSettings)
      .set({ backgroundEnabled: false })
      .where(eq(schema.workspaceSettings.ownerId, ownerId));
});
describe("recipient and workspace contact-window intersection", () => {
  it("retains the existing workspace window when no restriction is recorded", () => {
    expect(
      nextRecipientContactTime(
        new Date("2026-11-13T06:00:00Z"),
        { ...workspace, quietStart: "20:00", quietEnd: "08:00" },
        null
      ).toISOString()
    ).toBe("2026-11-13T08:00:00.000Z");
  });
  it("defers to a recorded return time before intersecting existing quiet hours", () => {
    expect(
      nextRecipientContactTime(
        at,
        { ...workspace, quietStart: "20:00", quietEnd: "08:00" },
        fields({ notBefore: new Date("2026-11-14T03:00:00Z") })
      ).toISOString()
    ).toBe("2026-11-14T08:00:00.000Z");
  });
  it("intersects different IANA timezones without widening either permitted window", () => {
    const f = fields({
      timezone: "Asia/Kolkata",
      window: { start: "09:00", end: "17:00", businessDaysOnly: false },
    });
    expect(
      nextRecipientContactTime(
        new Date("2026-11-13T04:00:00Z"),
        { ...workspace, quietStart: "17:00", quietEnd: "09:00" },
        f
      ).toISOString()
    ).toBe("2026-11-13T09:00:00.000Z");
  });
  it("honors local weekdays and half-open contact-window ends", () => {
    const f = fields({
      window: { start: "09:00", end: "17:00", businessDaysOnly: true },
    });
    expect(
      nextRecipientContactTime(
        new Date("2026-11-13T17:00:00Z"),
        workspace,
        f
      ).toISOString()
    ).toBe("2026-11-16T09:00:00.000Z");
  });
  it("supports overnight windows without converting them to all-day contact", () => {
    const f = fields({
      window: { start: "22:00", end: "06:00", businessDaysOnly: false },
    });
    expect(
      nextRecipientContactTime(
        new Date("2026-11-13T21:00:00Z"),
        workspace,
        f
      ).toISOString()
    ).toBe("2026-11-13T22:00:00.000Z");
    expect(
      nextRecipientContactTime(
        new Date("2026-11-13T06:00:00Z"),
        workspace,
        f
      ).toISOString()
    ).toBe("2026-11-13T22:00:00.000Z");
  });
  it("uses the actual daylight-saving offset at the future recipient date", () => {
    const f = fields({
      timezone: "America/New_York",
      validUntil: new Date("2027-04-01"),
      window: { start: "09:00", end: "17:00", businessDaysOnly: false },
    });
    expect(
      nextRecipientContactTime(
        new Date("2027-03-14T12:00:00Z"),
        workspace,
        f
      ).toISOString()
    ).toBe("2027-03-14T13:00:00.000Z");
    expect(
      nextRecipientContactTime(
        new Date("2027-01-14T13:00:00Z"),
        workspace,
        f
      ).toISOString()
    ).toBe("2027-01-14T14:00:00.000Z");
  });
  it("fails a non-overlapping or expired recipient restriction instead of dropping it", () => {
    expect(() =>
      nextRecipientContactTime(
        at,
        { ...workspace, quietStart: "10:00", quietEnd: "09:00" },
        fields({
          window: { start: "11:00", end: "12:00", businessDaysOnly: false },
        })
      )
    ).toThrow(/overlap|jointly permitted/);
    expect(() =>
      nextRecipientContactTime(
        at,
        workspace,
        fields({ validUntil: new Date("2026-11-12") })
      )
    ).toThrow(/expired/);
  });
  it("withholds email for a different preferred channel without inventing an adapter", () => {
    expect(() =>
      nextRecipientContactTime(
        at,
        workspace,
        fields({ preferredChannel: "whatsapp" })
      )
    ).toThrow(/another channel/);
  });
});
async function fixture() {
  const f = await followupFixture();
  owners.push(f.ownerId);
  const messageId = createId("msg_"),
    sourceQuote =
      "I am away this week. Please email after my return and only during my daytime contact window.";
  await f.db.insert(schema.messages).values({
    id: messageId,
    idempotencyKey: "synthetic-timing-source:" + messageId,
    ownerId: f.ownerId,
    conversationId: f.conversationId,
    direction: "inbound",
    status: "received",
    body: sourceQuote,
    createdAt: new Date(Date.now() - 60000),
  });
  const created = await enrollFollowUp(f.ownerId, {
      ...f.input,
      conversationId: f.conversationId,
    }),
    plan = (
      await f.db
        .select()
        .from(schema.followUpPlans)
        .where(eq(schema.followUpPlans.id, created.id))
    )[0],
    input = {
      planId: plan.id,
      expectedRevision: 0,
      messageId,
      sourceQuote,
      fields: {
        timezone: "UTC",
        preferredChannel: "email" as const,
        notBefore: new Date(Date.now() + 3 * 3600000),
        validUntil: new Date(Date.now() + 7 * 86400000),
      },
      reason:
        "Review the exact synthetic source and record a conservative contact hold.",
    };
  return { ...f, plan, messageId, sourceQuote, input };
}
async function priorReceipt(f: any, at: Date, recipientHash: string) {
  const messageId = createId("msg_"),
    approvalId = createId("apr_");
  await f.db
    .insert(schema.messages)
    .values({
      id: messageId,
      ownerId: f.ownerId,
      conversationId: f.plan.conversationId,
      direction: "outbound",
      status: "sent",
      body: "Synthetic historical receipt for admission regression.",
      idempotencyKey: "synthetic-timing-prior:" + messageId,
      sentAt: at,
      createdAt: at,
    });
  await f.db
    .insert(schema.approvals)
    .values({
      id: approvalId,
      ownerId: f.ownerId,
      requestedBy: "user",
      actionType: "email_send",
      resourceType: "message",
      resourceId: messageId,
      status: "approved",
      actionedAt: at,
    });
  await f.db
    .insert(schema.emailDispatches)
    .values({
      id: createId("dsp_"),
      ownerId: f.ownerId,
      messageId,
      approvalId,
      recipientHash,
      status: "sent",
      scheduledAt: at,
      claimedAt: at,
    });
}
describe("source-bound recipient timing and canonical delivery admission", () => {
  it("records an exact inbound quotation once and exposes a timing-only preview", async () => {
    const f = await fixture();
    expect(
      (await saveContactTiming(f.ownerId, f.ownerId, f.input)).revision
    ).toBe(1);
    expect(
      (await saveContactTiming(f.ownerId, f.ownerId, f.input)).alreadySaved
    ).toBe(true);
    const d = await readContactTiming(f.ownerId, f.plan.id);
    expect(d.status).toBe("recorded");
    expect(d.revision).toBe(1);
    expect(d.record.independentlyVerified).toBe(false);
    expect(new Date(d.nextPermittedAt!).getTime()).toBeGreaterThanOrEqual(
      f.input.fields.notBefore.getTime()
    );
  });
  it("rejects fabricated quotes, unreceived sources and another owner’s plan", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      saveContactTiming(f.ownerId, f.ownerId, {
        ...f.input,
        sourceQuote: "An invented source quotation must not be accepted.",
      })
    ).rejects.toThrow(/quotation/);
    await expect(
      saveContactTiming(other.ownerId, other.ownerId, f.input)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.db
      .update(schema.messages)
      .set({ status: "draft" })
      .where(eq(schema.messages.id, f.messageId));
    await expect(
      saveContactTiming(f.ownerId, f.ownerId, f.input)
    ).rejects.toThrow(/quotation/);
  });
  it("fences stale preference revisions and keeps the earlier source/version in history", async () => {
    const f = await fixture();
    await saveContactTiming(f.ownerId, f.ownerId, f.input);
    await expect(
      saveContactTiming(f.ownerId, f.ownerId, {
        ...f.input,
        reason:
          "A competing stale source must not replace the reviewed preference.",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await saveContactTiming(f.ownerId, f.ownerId, {
      ...f.input,
      expectedRevision: 1,
      fields: { ...f.input.fields, preferredLanguage: "hi-IN" },
    });
    expect(
      await f.db
        .select()
        .from(schema.workflowEvents)
        .where(
          and(
            eq(schema.workflowEvents.ownerId, f.ownerId),
            eq(schema.workflowEvents.eventType, "contact.timing_saved")
          )
        )
    ).toHaveLength(2);
  });
  it("rejects ambiguous empty windows and return/review dates outside the bounded authority", async () => {
    const f = await fixture();
    for (const changed of [
      { validUntil: new Date(Date.now() + 91 * 86400000) },
      { notBefore: new Date(Date.now() + 8 * 86400000) },
      { window: { start: "09:00", end: "09:00", businessDaysOnly: false } },
    ])
      await expect(
        saveContactTiming(f.ownerId, f.ownerId, {
          ...f.input,
          fields: { ...f.input.fields, ...changed },
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("defers the existing approved dispatch durably without consuming approval or contacting the provider", async () => {
    const f = await fixture();
    await saveContactTiming(f.ownerId, f.ownerId, f.input);
    const prepared = await prepareFollowUp(f.ownerId, {
      planId: f.plan.id,
      revision: f.plan.revision,
      stepIndex: 0,
    });
    await f.caller.recruitment.approvals.decide({
      id: prepared.approvalId,
      decision: "approved",
    });
    const result = await deliverApprovedEmail(f.ownerId, {
      dispatchId: prepared.dispatchId,
    });
    expect(result.status).toBe("deferred");
    expect(new Date(result.nextActionAt!).getTime()).toBeGreaterThanOrEqual(
      f.input.fields.notBefore.getTime()
    );
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await f.db
          .select()
          .from(schema.approvals)
          .where(eq(schema.approvals.id, prepared.approvalId))
      )[0].actionedAt
    ).toBeNull();
    expect(
      (
        await f.db
          .select()
          .from(schema.automationQueue)
          .where(
            eq(
              schema.automationQueue.idempotencyKey,
              "email_dispatch:" + prepared.dispatchId
            )
          )
      )[0].scheduledAt.getTime()
    ).toBeGreaterThanOrEqual(f.input.fields.notBefore.getTime());
  });
  it("continues to enforce suppression even if the recorded return time permits contact", async () => {
    const f = await fixture();
    await saveContactTiming(f.ownerId, f.ownerId, {
      ...f.input,
      fields: { ...f.input.fields, notBefore: new Date(Date.now() - 60000) },
    });
    const p = await prepareFollowUp(f.ownerId, {
      planId: f.plan.id,
      revision: f.plan.revision,
      stepIndex: 0,
    });
    await f.caller.recruitment.approvals.decide({
      id: p.approvalId,
      decision: "approved",
    });
    await f.db.insert(schema.suppressionList).values({
      id: createId("sup_"),
      ownerId: f.ownerId,
      channel: "email",
      valueHash: f.plan.recipientHash,
      active: true,
      reason: "Synthetic do-not-contact takes precedence over timing.",
      source: "synthetic_test",
    });
    await expect(
      deliverApprovedEmail(f.ownerId, { dispatchId: p.dispatchId })
    ).rejects.toThrow(/suppressed/);
    expect(send).not.toHaveBeenCalled();
  });
  it("withholds an expired or differently-channelled preference at actual send admission", async () => {
    const f = await fixture();
    await saveContactTiming(f.ownerId, f.ownerId, {
      ...f.input,
      fields: { ...f.input.fields, preferredChannel: "sms" },
    });
    const p = await prepareFollowUp(f.ownerId, {
      planId: f.plan.id,
      revision: f.plan.revision,
      stepIndex: 0,
    });
    await f.caller.recruitment.approvals.decide({
      id: p.approvalId,
      decision: "approved",
    });
    await expect(
      deliverApprovedEmail(f.ownerId, { dispatchId: p.dispatchId })
    ).rejects.toThrow(/another channel/);
    expect(send).not.toHaveBeenCalled();
  });
  it("does not resume a sequence merely because an out-of-office preference was recorded", async () => {
    const f = await fixture();
    await f.db.insert(schema.messages).values({
      id: createId("msg_"),
      ownerId: f.ownerId,
      conversationId: f.plan.conversationId,
      direction: "inbound",
      status: "received",
      body: "A newer synthetic reply still requires owner review.",
      idempotencyKey: createId("timing_new_reply_"),
      createdAt: new Date(),
    });
    await saveContactTiming(f.ownerId, f.ownerId, f.input);
    const p = await prepareFollowUp(f.ownerId, {
      planId: f.plan.id,
      revision: f.plan.revision,
      stepIndex: 0,
    });
    expect(p.status).toBe("paused");
    expect(send).not.toHaveBeenCalled();
  });
  it("does not transfer timing evidence when the underlying recipient address changes", async () => {
    const f = await fixture();
    await saveContactTiming(f.ownerId, f.ownerId, f.input);
    await f.db
      .update(schema.candidates)
      .set({ email: "different-recipient@example.test" })
      .where(eq(schema.candidates.id, f.candidateId));
    await expect(readContactTiming(f.ownerId, f.plan.id)).rejects.toThrow(
      /recipient changed/
    );
    expect(
      await getRecipientTiming(f.db, f.ownerId, "unknown-new-recipient-hash")
    ).toBeNull();
  });
  it("requires explicit retirement and preserves other consent/workflow guards", async () => {
    const f = await fixture();
    await saveContactTiming(f.ownerId, f.ownerId, f.input);
    await expect(
      retireContactTiming(f.ownerId, f.ownerId, {
        planId: f.plan.id,
        expectedRevision: 0,
        reason: "A stale retirement must not remove a newer restriction.",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await retireContactTiming(f.ownerId, f.ownerId, {
      planId: f.plan.id,
      expectedRevision: 1,
      reason:
        "The synthetic recipient explicitly corrected the timing preference.",
    });
    expect(
      await getRecipientTiming(f.db, f.ownerId, f.plan.recipientHash)
    ).toBeNull();
    expect((await readContactTiming(f.ownerId, f.plan.id)).status).toBe(
      "unrestricted"
    );
  });
  it("erases source quotes and contact timing history in canonical candidate privacy fulfillment", async () => {
    const f = await fixture();
    await saveContactTiming(f.ownerId, f.ownerId, f.input);
    await f.db
      .update(schema.placements)
      .set({ status: "closed" })
      .where(eq(schema.placements.ownerId, f.ownerId));
    const requestId = createId("rgt_");
    await f.db.insert(schema.rightsRequests).values({
      id: requestId,
      ownerId: f.ownerId,
      candidateId: f.candidateId,
      requestType: "deletion",
      status: "received",
      details: "Synthetic contact timing erasure acceptance.",
    });
    await f.caller.recruitment.candidateWorkflows.privacy.fulfillDeletion({
      requestId,
      resolutionNote:
        "Erase the synthetic inbound-derived contact preference and source quotation.",
    });
    const events = await f.db
      .select()
      .from(schema.workflowEvents)
      .where(
        and(
          eq(schema.workflowEvents.ownerId, f.ownerId),
          eq(schema.workflowEvents.eventType, "contact.timing_saved")
        )
      );
    expect(events.every((e: any) => e.metadata.redacted)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(f.sourceQuote);
  });
  it("re-applies the recipient window when minimum send spacing crosses its closing time", async () => {
    const f = await fixture(),
      now = new Date();
    now.setUTCHours(16, 59, 50, 0);
    await saveContactTiming(f.ownerId, f.ownerId, {
      ...f.input,
      fields: {
        timezone: "UTC",
        preferredChannel: "email",
        window: { start: "09:00", end: "17:00", businessDaysOnly: false },
        validUntil: new Date(Date.now() + 7 * 86400000),
      },
    });
    const p = await prepareFollowUp(f.ownerId, {
      planId: f.plan.id,
      revision: f.plan.revision,
      stepIndex: 0,
    });
    await f.caller.recruitment.approvals.decide({
      id: p.approvalId,
      decision: "approved",
    });
    await priorReceipt(
      f,
      new Date(now.getTime() - 10000),
      f.plan.recipientHash
    );
    const result = await deliverApprovedEmail(
        f.ownerId,
        { dispatchId: p.dispatchId },
        now
      ),
      expected = new Date(now);
    expected.setUTCDate(expected.getUTCDate() + 1);
    expected.setUTCHours(9, 0, 0, 0);
    expect(result.status).toBe("deferred");
    expect(new Date(result.nextActionAt!).toISOString()).toBe(
      expected.toISOString()
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("does not let daily budget deferral shorten a longer recipient return hold", async () => {
    const f = await fixture(),
      p = await prepareFollowUp(f.ownerId, {
        planId: f.plan.id,
        revision: f.plan.revision,
        stepIndex: 0,
      });
    await saveContactTiming(f.ownerId, f.ownerId, {
      ...f.input,
      fields: {
        ...f.input.fields,
        notBefore: new Date(Date.now() + 3 * 86400000),
      },
    });
    await f.caller.recruitment.approvals.decide({
      id: p.approvalId,
      decision: "approved",
    });
    await f.db
      .update(schema.workspaceSettings)
      .set({ dailyOutboundLimit: 1 })
      .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
    await priorReceipt(f, new Date(), "another_synthetic_recipient");
    const result = await deliverApprovedEmail(f.ownerId, {
      dispatchId: p.dispatchId,
    });
    expect(result.status).toBe("deferred");
    expect(new Date(result.nextActionAt!).getTime()).toBeGreaterThanOrEqual(
      Date.now() + 3 * 86400000 - 1000
    );
    expect(send).not.toHaveBeenCalled();
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")(
    "serializes competing timing corrections under the existing workspace lock",
    async () => {
      const f = await fixture(),
        results = await Promise.allSettled([
          saveContactTiming(f.ownerId, f.ownerId, f.input),
          saveContactTiming(f.ownerId, f.ownerId, {
            ...f.input,
            fields: { ...f.input.fields, preferredChannel: "phone" },
          }),
        ]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect((await readContactTiming(f.ownerId, f.plan.id)).revision).toBe(1);
    }
  );
});
