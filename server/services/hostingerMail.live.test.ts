import { describe, expect, it } from "vitest";
import { getHostingerMailApiStatus, verifyHostingerMailApi } from "./hostingerMail";

describe.skipIf(!process.env.HOSTINGER_MAIL_API_TOKEN)("Hostinger Mail API live configuration", () => {
  it("verifies the configured bearer token against the account endpoint", async () => {
    const status = getHostingerMailApiStatus();
    expect(status.tokenConfigured).toBe(true);
    expect(status.configuredMailboxCount).toBe(6);
    expect(status.configuredSenderAddressCount).toBe(6);
    const result = await verifyHostingerMailApi();
    expect(result).toEqual({ ok: true, status: "verified" });
  }, 30_000);
});
