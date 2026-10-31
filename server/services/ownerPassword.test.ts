import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

vi.mock("../db", () => ({ getUserByOpenId: vi.fn(), upsertUser: vi.fn(), recordAudit: vi.fn() }));
const { getUserByOpenId, upsertUser, recordAudit } = await import("../db");
const { authenticateRuntimeRequest, assertProductionRuntimeConfiguration, createOwnerPasswordLoginHandler, getProductionRuntimeStatus, getRuntimeLogoutCookie } = await import("./runtimeAuth");
const { createOwnerLoginLimiter, ownerCredentialVersion, verifyOwnerPassword } = await import("./ownerPassword");
const original = { ...process.env };
const password = "synthetic-owner-password-only";
const salt = "ab".repeat(16);
const hash = `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const owner = { id: 23, openId: "personal_owner", email: "owner@example.test", name: "Owner", role: "admin", loginMethod: "owner_password" } as any;
const origin = "https://freelancehr.overseasjob.in";

describe("personal owner authentication", () => {
  beforeEach(() => {
    process.env = { ...original, NODE_ENV: "production", AUTH_MODE: "owner_password", APP_BASE_URL: origin, OWNER_ONLY_MODE: "true", PRIMARY_OWNER_EMAIL: owner.email, PRIMARY_OWNER_OPEN_ID: owner.openId, OWNER_PASSWORD_HASH: hash, SESSION_SECRET: "s".repeat(64), CRON_SECRET: "c".repeat(64), PRIVATE_STORAGE_MODE: "local" };
    for (const key of ["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_ISSUER_URL"]) delete process.env[key];
    vi.mocked(getUserByOpenId).mockResolvedValue(owner);
    vi.mocked(upsertUser).mockResolvedValue();
    vi.mocked(recordAudit).mockResolvedValue(undefined as any);
  });
  afterEach(() => { process.env = { ...original }; vi.clearAllMocks(); });

  it("starts without Google credentials, but fails closed on missing or malformed owner settings", () => {
    expect(getProductionRuntimeStatus()).toMatchObject({ authConfigured: true, oidcConfigured: false, authMode: "owner_password" });
    expect(() => assertProductionRuntimeConfiguration()).not.toThrow();
    for (const [key, value] of [["OWNER_PASSWORD_HASH", "plaintext"], ["PRIMARY_OWNER_OPEN_ID", ""], ["OWNER_ONLY_MODE", "false"], ["PRIMARY_OWNER_EMAIL", "one@example.test,two@example.test"], ["APP_BASE_URL", "http://example.test"]]) {
      const before = process.env[key]; process.env[key] = value;
      expect(() => assertProductionRuntimeConfiguration()).toThrow("production startup blocked");
      process.env[key] = before;
    }
  });

  it("verifies salted passwords and rejects incorrect and excessive input", async () => {
    expect(await verifyOwnerPassword(password)).toBe(true);
    expect(await verifyOwnerPassword("wrong")).toBe(false);
    expect(await verifyOwnerPassword("x".repeat(257))).toBe(false);
  });

  it("rejects cross-origin, missing-origin, wrong-account and malformed requests without provisioning", async () => {
    const login = createOwnerPasswordLoginHandler();
    expect((await login({ body: { email: owner.email, password }, origin: "https://attacker.test" })).status).toBe(403);
    expect((await login({ body: { email: owner.email, password } })).status).toBe(403);
    for (const body of [null, {}, { email: owner.email, password: "wrong" }, { email: "other@example.test", password }, { email: owner.email, password: "x".repeat(257) }]) {
      expect(await login({ body, origin })).toMatchObject({ status: 401, error: "Email or password is incorrect." });
    }
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("creates an owner session, protects cookies and invalidates it when the password hash changes", async () => {
    const result = await createOwnerPasswordLoginHandler()({ body: { email: owner.email.toUpperCase(), password }, origin });
    expect(result.status).toBe(200);
    expect(result.cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(result.cookie).toContain("Max-Age=28800");
    const cookie = result.cookie!.split(";")[0];
    expect(await authenticateRuntimeRequest({ headers: { cookie } })).toEqual(owner);
    expect(await authenticateRuntimeRequest({ headers: {} })).toBeNull();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.login", ownerId: owner.id }));
    process.env.OWNER_PASSWORD_HASH = `scrypt:${"cd".repeat(16)}:${"ef".repeat(64)}`;
    expect(await authenticateRuntimeRequest({ headers: { cookie } })).toBeNull();
    expect(getRuntimeLogoutCookie()).toContain("Max-Age=0");
  });

  it("rejects preview or OIDC sessions and forged cookies even with an owner subject", async () => {
    const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(owner.openId).setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
    expect(await authenticateRuntimeRequest({ headers: { cookie: `__Host-fh_session=${token}` } })).toBeNull();
    expect(await authenticateRuntimeRequest({ headers: { cookie: "__Host-fh_session=forged" } })).toBeNull();
    for (const [subject, expiry] of [[owner.openId, "-1s"], ["other_owner", "1h"]]) {
      const token = await new SignJWT({ authMode: "owner_password", credentialVersion: ownerCredentialVersion() }).setProtectedHeader({ alg: "HS256" }).setSubject(subject).setExpirationTime(expiry).sign(new TextEncoder().encode(process.env.SESSION_SECRET));
      expect(await authenticateRuntimeRequest({ headers: { cookie: `__Host-fh_session=${token}` } })).toBeNull();
    }
  });

  it("bounds password attempts and reopens its window without accumulating IP entries", async () => {
    const allow = createOwnerLoginLimiter();
    for (let i = 0; i < 10; i++) expect(allow(100_000)).toBe(true);
    expect(allow(100_001)).toBe(false);
    expect(allow(160_000)).toBe(true);
    const login = createOwnerPasswordLoginHandler();
    for (let i = 0; i < 10; i++) await login({ body: {}, origin });
    expect((await login({ body: {}, origin })).status).toBe(429);
  });
});
