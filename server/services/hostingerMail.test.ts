import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseThreadReference,
  detectOptOut,
  getHostingerMailApiStatus,
  getSenderAddress,
  isApprovedSenderAddress,
  resolveSentMessageInHostinger,
  sendViaHostingerMailApi,
  verifyHostingerMailApi,
} from "./hostingerMail";

describe("Hostinger Mail API safeguards", () => {
  const environment = { ...process.env };
  afterEach(() => {
    process.env = { ...environment };
    vi.restoreAllMocks();
  });

  it("allows only configured-domain sender identities", () => {
    expect(isApprovedSenderAddress("clients@overseasjob.in")).toBe(true);
    expect(isApprovedSenderAddress("clients@another-domain.test")).toBe(false);
  });

  it("uses explicit .fl sender addresses when configured", () => {
    process.env.HOSTINGER_MAILBOX_OWNER_ADDRESS = "owner.fl@overseasjob.in";
    process.env.HOSTINGER_MAILBOX_CLIENTS_ADDRESS = "clients.fl@overseasjob.in";
    process.env.HOSTINGER_MAILBOX_TALENT_ADDRESS = "talent.fl@overseasjob.in";
    process.env.HOSTINGER_MAILBOX_INTERVIEWS_ADDRESS = "interviews.fl@overseasjob.in";
    process.env.HOSTINGER_MAILBOX_FINANCE_ADDRESS = "finance.fl@overseasjob.in";
    process.env.HOSTINGER_MAILBOX_PRIVACY_ADDRESS = "privacy.fl@overseasjob.in";
    expect(getSenderAddress("owner")).toBe("owner.fl@overseasjob.in");
    expect(getSenderAddress("clients")).toBe("clients.fl@overseasjob.in");
    expect(getHostingerMailApiStatus().configuredSenderAddressCount).toBe(6);
  });

  it("keeps the API integration disabled when no bearer token is configured", () => {
    delete process.env.HOSTINGER_MAIL_API_TOKEN;
    expect(getHostingerMailApiStatus().configured).toBe(false);
  });

  it("fails API verification safely when bearer credentials are absent", async () => {
    delete process.env.HOSTINGER_MAIL_API_TOKEN;
    await expect(verifyHostingerMailApi()).resolves.toEqual({ ok: false, status: "credentials_missing" });
  });

  it("correlates the immediate reply reference before older thread references", () => {
    expect(chooseThreadReference({ inReplyTo: "<reply@example.test>", references: ["<parent@example.test>"] })).toBe("<reply@example.test>");
  });

  it("detects opt-out language before a follow-up can be scheduled", () => {
    expect(detectOptOut("Please unsubscribe and do not contact me again.")).toBe(true);
    expect(detectOptOut("Thank you, I can take a call tomorrow.")).toBe(false);
  });

  it("handles standard 204 empty response by resolving Sent folder with providerMessageId === null", async () => {
    process.env.HOSTINGER_MAIL_API_TOKEN = "test-token";
    process.env.HOSTINGER_MAILBOX_INTERVIEWS_ID = "mbox-123";

    const { SendApi, MessagesApi } = await import("hostinger-mail-api-sdk");

    // Simulate 204 No Content empty response from sendEmail
    const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockResolvedValueOnce({
      status: 204,
      data: undefined,
    } as any);

    // Mock Sent folder message search
    const searchSpy = vi.spyOn(MessagesApi.prototype, "searchMessages").mockResolvedValueOnce({
      data: {
        data: [
          {
            uid: 456,
            path: "INBOX.Sent",
            subject: "Interview Followup",
            messageId: "<rfc-msg-999@overseasjob.in>",
            inReplyTo: "<orig-111@overseasjob.in>",
            to: [{ address: "candidate@example.test" }],
            date: new Date().toISOString(),
          },
        ],
      },
    } as any);

    const result = await sendViaHostingerMailApi({
      purpose: "interviews",
      to: "candidate@example.test",
      displayName: "Interviews Team",
      subject: "Interview Followup",
      text: "Thank you for attending.",
    });

    expect(sendSpy).toHaveBeenCalled();
    expect(searchSpy).toHaveBeenCalled();

    // Critical semantics invariant:
    expect(result.providerMessageId).toBeNull();
    expect(result.providerUid).toBe(456);
    expect(result.providerFolder).toBe("INBOX.Sent");
    expect(result.messageId).toBe("<rfc-msg-999@overseasjob.in>");
    expect(result.inReplyTo).toBe("<orig-111@overseasjob.in>");
  });

  it("fails safely when multiple matching messages are found in Sent folder (ambiguous)", async () => {
    process.env.HOSTINGER_MAIL_API_TOKEN = "test-token";

    const { MessagesApi } = await import("hostinger-mail-api-sdk");
    vi.spyOn(MessagesApi.prototype, "searchMessages").mockResolvedValueOnce({
      data: {
        data: [
          {
            uid: 101,
            subject: "Ambiguous Subject",
            to: [{ address: "dup@example.test" }],
            date: new Date().toISOString(),
          },
          {
            uid: 102,
            subject: "Ambiguous Subject",
            to: [{ address: "dup@example.test" }],
            date: new Date().toISOString(),
          },
        ],
      },
    } as any);

    const res = await resolveSentMessageInHostinger({
      mailboxResourceId: "mbox-123",
      to: "dup@example.test",
      subject: "Ambiguous Subject",
    });

    expect(res.isAmbiguous).toBe(true);
    expect(res.providerUid).toBeNull();
    expect(res.messageId).toBeNull();
  });
});

