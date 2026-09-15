import { beforeEach, describe, expect, it, vi } from "vitest";

const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const audits: Array<Record<string, unknown>> = [];
let matched = true;

vi.mock("../db", () => ({
  createId: (prefix = "") => `${prefix}test-id`,
  getUserByOpenId: async () => ({ id: 7, openId: "owner" }),
  hashContactValue: (value: string) => `hash:${value}`,
  recordAudit: async (entry: Record<string, unknown>) => { audits.push(entry); },
  requireDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => matched ? [{ id: "parent-message", conversationId: "conversation-1", ownerId: 7 }] : [] }) }) }),
    insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => { inserts.push({ table, values }); return { onDuplicateKeyUpdate: async () => undefined }; } }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
}));

vi.mock("../_core/env", () => ({ ENV: { ownerOpenId: "owner" } }));

const { processHostingerMailWebhook } = await import("./hostingerWebhook");

describe("Hostinger Mail webhook persistence", () => {
  beforeEach(() => { inserts.length = 0; audits.length = 0; matched = true; process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "unit-secret"; });

  const payload = { event: "message.received", data: { message: { id: "provider-reply-1", from: "candidate@example.test", subject: "Re: Role", text: "I am interested", inReplyTo: "<outbound-message@example.test>", references: ["<older-message@example.test>"] } } };

  it("queues controlled reply classification and records an audit event for a matched thread", async () => {
    const result = await processHostingerMailWebhook({ authorization: "Bearer unit-secret", body: payload });
    expect(result).toMatchObject({ statusCode: 202, body: { status: "classification_queued", conversationId: "conversation-1" } });
    expect(inserts.some(entry => entry.values.jobType === "classify_reply" && entry.values.idempotencyKey === "classify_reply:provider-reply-1")).toBe(true);
    expect(audits.some(entry => entry.action === "email.webhook_classification_queued" && entry.resourceId === "conversation-1")).toBe(true);
  });

  it("routes an unmatched provider thread to an exception without scheduling classification", async () => {
    matched = false;
    const result = await processHostingerMailWebhook({ authorization: "Bearer unit-secret", body: payload });
    expect(result).toMatchObject({ statusCode: 202, body: { status: "routed_to_exception" } });
    expect(inserts.some(entry => entry.values.incidentType === "hostinger_mail_unmatched_event")).toBe(true);
    expect(inserts.some(entry => entry.values.jobType === "classify_reply")).toBe(false);
    expect(audits.some(entry => entry.action === "email.webhook_unmatched")).toBe(true);
  });
});
