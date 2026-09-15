import { beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.fn();
vi.mock("hostinger-mail-api-sdk", () => ({
  Configuration: class Configuration { constructor(public options: unknown) {} },
  AccountApi: class AccountApi { async getCurrentAccount() { return {}; } },
  SendApi: class SendApi { sendEmail(...args: unknown[]) { return sendEmail(...args); } },
}));

const { sendViaHostingerMailApi, getSenderAddress } = await import("./hostingerMail");
const originalEnv = { ...process.env };

describe("Hostinger sender/resource-ID separation", () => {
  beforeEach(() => {
    process.env = { ...originalEnv, HOSTINGER_MAIL_API_TOKEN: "test-token", HOSTINGER_MAILBOX_CLIENTS_ID: "resource-123", HOSTINGER_MAILBOX_CLIENTS_ADDRESS: "clients.fl@overseasjob.in" };
    sendEmail.mockReset().mockResolvedValue({ data: { id: "provider-1" } });
  });

  it("passes the resource ID to the API while selecting the explicit sender address", async () => {
    const result = await sendViaHostingerMailApi({ purpose: "clients", to: "hirer@example.com", displayName: "FreelanceHR", subject: "Hiring need", text: "Draft" });
    expect(result).toMatchObject({ senderAddress: "clients.fl@overseasjob.in", mailboxResourceId: "resource-123" });
    expect(sendEmail).toHaveBeenCalledWith("resource-123", expect.objectContaining({ to: ["hirer@example.com"] }));
    expect(getSenderAddress("clients")).toBe("clients.fl@overseasjob.in");
  });

  it("surfaces a rejected plain email ID for remediation without changing sender selection", async () => {
    process.env.HOSTINGER_MAILBOX_CLIENTS_ID = "clients.fl@overseasjob.in";
    sendEmail.mockRejectedValue(new Error("mailboxResourceId must be a Hostinger resource ID"));
    await expect(sendViaHostingerMailApi({ purpose: "clients", to: "hirer@example.com", displayName: "FreelanceHR", subject: "Hiring need", text: "Draft" })).rejects.toThrow("mailboxResourceId must be a Hostinger resource ID");
    expect(getSenderAddress("clients")).toBe("clients.fl@overseasjob.in");
  });
});
