import { afterEach, describe, expect, it } from "vitest";
import { chooseThreadReference, detectOptOut, getHostingerMailApiStatus, getSenderAddress, isApprovedSenderAddress, verifyHostingerMailApi } from "./hostingerMail";

describe("Hostinger Mail API safeguards", () => {
  const environment = { ...process.env };
  afterEach(() => { process.env = { ...environment }; });

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
});
