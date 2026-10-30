import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ claims: {} as Record<string, unknown>, upsert: vi.fn(), audit: vi.fn() }));
vi.mock("jose", async original => ({ ...await original(), jwtVerify: vi.fn(async () => ({ payload: fixture.claims })) }));
vi.mock("../db", () => ({ upsertUser: fixture.upsert, recordAudit: fixture.audit, getUserByOpenId: vi.fn(async () => ({ id: 1, openId: "oidc-user", role: "user" })) }));
const { completeOidcLogin } = await import("./runtimeAuth");

describe("OIDC email trust boundary", () => {
  beforeEach(() => {
    fixture.upsert.mockClear(); fixture.audit.mockReset().mockResolvedValue(undefined);
    for (const [name, value] of Object.entries({ AUTH_MODE: "oidc", OIDC_ISSUER_URL: "https://idp.example.test", OIDC_CLIENT_ID: "test-client", OIDC_CLIENT_SECRET: "test-only-secret", APP_BASE_URL: "https://app.example.test", SESSION_SECRET: "oidc-test-signing-key-at-least-32-characters", CRON_SECRET: "test-cron-secret", PRIMARY_OWNER_EMAIL: "owner@example.test", OWNER_ONLY_MODE: "false" })) vi.stubEnv(name, value);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("well-known") ? { issuer: "https://idp.example.test", authorization_endpoint: "https://idp.example.test/auth", token_endpoint: "https://idp.example.test/token", jwks_uri: "https://idp.example.test/keys" } : { id_token: "verified-by-test-fixture" }), { status: 200 })));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  const login = () => completeOidcLogin({ code: "test-code", state: "test-state", cookieHeader: `__Host-fh_oidc_state=${Buffer.from(JSON.stringify({ state: "test-state", nonce: "test-nonce", verifier: "test-verifier" })).toString("base64url")}` });

  it.each([false, undefined, "true"])("does not provision an email-identified account when email_verified is %s", async verified => {
    fixture.claims = { sub: "external-subject", nonce: "test-nonce", email: "owner@example.test", email_verified: verified };
    await expect(login()).rejects.toThrow(/email must be verified/);
    expect(fixture.upsert).not.toHaveBeenCalled();
  });
  it("provisions a genuinely verified address after token validation", async () => {
    fixture.claims = { sub: "external-subject", nonce: "test-nonce", email: "OWNER@example.test", email_verified: true };
    await expect(login()).resolves.toHaveProperty("sessionCookie");
    expect(fixture.upsert).toHaveBeenCalledWith(expect.objectContaining({ email: "owner@example.test", loginMethod: "oidc" }));
  });
});
