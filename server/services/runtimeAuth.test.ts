import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../storage", () => ({ storagePut: vi.fn(), storageGetSignedUrl: vi.fn() }));
vi.mock("../db", () => ({ getUserByOpenId: vi.fn(), upsertUser: vi.fn() }));

const { assertProductionRuntimeConfiguration, getProductionRuntimeStatus, isOidcRuntime } = await import("./runtimeAuth");
const originalEnv = { ...process.env };

describe("portable production authentication guard", () => {
  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "production" };
    for (const key of ["AUTH_MODE", "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "APP_BASE_URL", "SESSION_SECRET", "PRIMARY_OWNER_OPEN_ID", "PRIMARY_OWNER_EMAIL", "STORAGE_BUCKET", "STORAGE_REGION", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY", "PRIVATE_STORAGE_MODE"]) delete process.env[key];
  });
  afterEach(() => { process.env = { ...originalEnv }; });

  it("fails closed when production OIDC and private storage configuration is absent", () => {
    expect(getProductionRuntimeStatus()).toMatchObject({ configured: false, oidcConfigured: false, privateStorage: { mode: "local", configured: true } });
    expect(() => assertProductionRuntimeConfiguration()).toThrow("production startup blocked");
  });

  it("recognizes the selected OIDC runtime only when explicitly configured", () => {
    expect(isOidcRuntime()).toBe(false);
    process.env.AUTH_MODE = "oidc";
    expect(isOidcRuntime()).toBe(true);
  });

  it("reports ready only after all OIDC, owner, and private storage settings are present", () => {
    Object.assign(process.env, {
      AUTH_MODE: "oidc",
      OIDC_ISSUER_URL: "https://identity.example.test",
      OIDC_CLIENT_ID: "freelancehr",
      OIDC_CLIENT_SECRET: "test-client-secret",
      APP_BASE_URL: "https://freelancehr.overseasjob.in",
      SESSION_SECRET: "01234567890123456789012345678901",
      PRIMARY_OWNER_OPEN_ID: "oidc_owner",
      STORAGE_BUCKET: "private-freelancehr",
      STORAGE_REGION: "ap-south-1",
      STORAGE_ACCESS_KEY_ID: "test-key",
      STORAGE_SECRET_ACCESS_KEY: "test-secret",
    });
    expect(getProductionRuntimeStatus()).toMatchObject({ configured: true, oidcConfigured: true, privateStorage: { mode: "local", configured: true } });
    expect(() => assertProductionRuntimeConfiguration()).not.toThrow();
  });
});
