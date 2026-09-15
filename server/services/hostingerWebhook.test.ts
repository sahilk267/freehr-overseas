import { afterEach, describe, expect, it } from "vitest";
import {
  isValidHostingerWebhookAuthorization,
  normalizeHostingerMailEvent,
  processHostingerMailWebhook,
} from "./hostingerWebhook";
import { getConfiguredPrimaryOwner, isPrimaryOwner, resolvePrimaryOwner } from "./primaryOwner";

describe("Hostinger Mail API webhook safeguards and owner resolution", () => {
  const environment = { ...process.env };
  afterEach(() => { process.env = { ...environment }; });

  it("accepts only the configured bearer token", () => {
    process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "webhook-secret";
    expect(isValidHostingerWebhookAuthorization("Bearer webhook-secret")).toBe(true);
    expect(isValidHostingerWebhookAuthorization("Bearer incorrect-secret")).toBe(false);
    expect(isValidHostingerWebhookAuthorization(undefined)).toBe(false);
  });

  it("normalizes a Hostinger received-message event into a safe intake payload", () => {
    expect(normalizeHostingerMailEvent({ event: "message.received", data: { message: { id: "provider-1", from: "candidate@example.test", subject: "Re: Role", text: "I am interested", inReplyTo: "<previous@example.test>", references: ["<previous@example.test>"] } } })).toMatchObject({ providerMessageId: "provider-1", sender: "candidate@example.test", inReplyTo: "<previous@example.test>", event: "message.received" });
  });

  it("rejects malformed provider events before they can enter a recruitment workflow", () => {
    expect(normalizeHostingerMailEvent({ event: "message.received", data: { message: { id: "provider-1" } } })).toBeNull();
  });

  it("resolves the primary owner correctly when only PRIMARY_OWNER_OPEN_ID is set", () => {
    delete process.env.OWNER_OPEN_ID;
    delete process.env.PRIMARY_OWNER_EMAIL;
    process.env.PRIMARY_OWNER_OPEN_ID = "primary-owner-123";

    const configured = getConfiguredPrimaryOwner();
    expect(configured.openId).toBe("primary-owner-123");
    expect(configured.email).toBeNull();

    expect(isPrimaryOwner({ openId: "primary-owner-123" })).toBe(true);
    expect(isPrimaryOwner({ openId: "other-user" })).toBe(false);
  });

  it("resolves the primary owner via legacy OWNER_OPEN_ID fallback when PRIMARY_OWNER_OPEN_ID is unset", () => {
    delete process.env.PRIMARY_OWNER_OPEN_ID;
    delete process.env.PRIMARY_OWNER_EMAIL;
    process.env.OWNER_OPEN_ID = "legacy-owner-456";

    const configured = getConfiguredPrimaryOwner();
    expect(configured.openId).toBe("legacy-owner-456");

    expect(isPrimaryOwner({ openId: "legacy-owner-456" })).toBe(true);
    expect(isPrimaryOwner({ openId: "other-user" })).toBe(false);
  });

  it("resolves the primary owner via PRIMARY_OWNER_EMAIL when openId is unset", () => {
    delete process.env.PRIMARY_OWNER_OPEN_ID;
    delete process.env.OWNER_OPEN_ID;
    process.env.PRIMARY_OWNER_EMAIL = "Owner@FreelanceHR.com";

    const configured = getConfiguredPrimaryOwner();
    expect(configured.email).toBe("owner@freelancehr.com");

    expect(isPrimaryOwner({ email: " owner@freelancehr.COM " })).toBe(true);
    expect(isPrimaryOwner({ email: "member@example.com" })).toBe(false);
  });

  it("proves processHostingerMailWebhook resolves the owner correctly when only PRIMARY_OWNER_OPEN_ID is set", async () => {
    delete process.env.OWNER_OPEN_ID;
    delete process.env.PRIMARY_OWNER_EMAIL;
    process.env.PRIMARY_OWNER_OPEN_ID = "owner_dev";
    process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "webhook-secret";

    // Owner should be resolved without 503 error
    const response = await processHostingerMailWebhook({
      authorization: "Bearer webhook-secret",
      body: {
        event: "message.received",
        data: {
          message: {
            id: "msg-123",
            from: "candidate@example.com",
            subject: "Application",
            text: "Hello, I am interested in the position.",
          },
        },
      },
    });

    // Successfully resolved owner and processed webhook (unmatched parent message leads to routed_to_exception 202, NOT 503)
    expect(response.statusCode).toBe(202);
    expect((response.body as any).status).toBe("routed_to_exception");
  });

  it("proves processHostingerMailWebhook resolves the owner via fallback when only legacy OWNER_OPEN_ID is set", async () => {
    delete process.env.PRIMARY_OWNER_OPEN_ID;
    delete process.env.PRIMARY_OWNER_EMAIL;
    process.env.OWNER_OPEN_ID = "owner_dev";
    process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "webhook-secret";

    const response = await processHostingerMailWebhook({
      authorization: "Bearer webhook-secret",
      body: {
        event: "message.received",
        data: {
          message: {
            id: "msg-456",
            from: "candidate@example.com",
            subject: "Application",
            text: "Hello",
          },
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect((response.body as any).status).toBe("routed_to_exception");
  });

  it("returns 503 when no owner can be resolved from configured environment", async () => {
    process.env.PRIMARY_OWNER_OPEN_ID = "non_existent_owner_99999";
    delete process.env.OWNER_OPEN_ID;
    delete process.env.PRIMARY_OWNER_EMAIL;
    process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "webhook-secret";

    const response = await processHostingerMailWebhook({
      authorization: "Bearer webhook-secret",
      body: {
        event: "message.received",
        data: {
          message: {
            id: "msg-789",
            from: "candidate@example.com",
            subject: "Application",
            text: "Hello",
          },
        },
      },
    });

    expect(response.statusCode).toBe(503);
    expect((response.body as any).error).toBe("Workspace owner is not initialized.");
  });
});
