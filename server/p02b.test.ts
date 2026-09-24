import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  candidateDocuments,
  candidates,
  rightsRequests,
} from "../drizzle/schema";
import { _resetDbForTesting, createId, getDb, requireDb, verifyDatabaseConnectivity } from "./db";
import { buildFastifyServer } from "./hostinger";
import { appRouter } from "./routers";
import { deletePrivateDocument, putPrivateDocument, readPrivateDocument } from "./services/privateStorage";
import { sdk } from "./_core/sdk";

describe("P0.2-B Safety & Security Suite", () => {
  const originalEnv = { ...process.env };

  const validProductionEnv = {
    NODE_ENV: "production",
    AUTH_MODE: "oidc",
    OIDC_ISSUER_URL: "https://auth.example.com",
    OIDC_CLIENT_ID: "client_id_test_123",
    OIDC_CLIENT_SECRET: "client_secret_test_123",
    APP_BASE_URL: "https://app.example.com",
    SESSION_SECRET: "a_very_long_session_secret_at_least_32_characters_long",
    PRIMARY_OWNER_EMAIL: "owner@example.com",
    PRIVATE_STORAGE_MODE: "local",
    CRON_SECRET: "test_super_secure_cron_secret_32_chars",
  };

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetDbForTesting();
    vi.restoreAllMocks();
  });

  describe("A — Database Startup Connectivity Safety", () => {
    it("1. production + missing DATABASE_URL -> startup blocked with configuration error", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.VITEST;
      delete process.env.DATABASE_URL;
      _resetDbForTesting();

      const result = await verifyDatabaseConnectivity();
      expect(result.connected).toBe(false);
      expect(result.error).toMatch(/Database configuration error: DATABASE_URL/i);

      await expect(getDb()).rejects.toThrow(/Database configuration error/i);
    });

    it("2. production + invalid/unreachable DB -> startup blocked with connectivity error", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.VITEST;
      process.env.DATABASE_URL = "mysql://invalid_user:invalid_pass@127.0.0.1:59999/nonexistent";
      _resetDbForTesting();

      const result = await verifyDatabaseConnectivity();
      expect(result.connected).toBe(false);
      expect(result.error).toMatch(/Database connectivity error/i);

      await expect(getDb()).rejects.toThrow(/Database connectivity error/i);
    });

    it("3. production + valid DB -> startup connectivity check succeeds", async () => {
      _resetDbForTesting();
      const result = await verifyDatabaseConnectivity();
      expect(result.connected).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("B — Production Cron Authentication Safety", () => {
    const validSecret = "test_super_secure_cron_secret_32_chars";

    function setupProductionCronEnv(overrides: Record<string, string | undefined> = {}) {
      Object.assign(process.env, validProductionEnv, overrides);
    }

    it("4. production + valid CRON_SECRET -> scheduled request accepted via x-cron-key and Bearer", async () => {
      setupProductionCronEnv();
      const app = await buildFastifyServer({ logger: false });

      // via x-cron-key
      const keyRes = await app.inject({
        method: "POST",
        url: "/api/scheduled/interview-reminders",
        headers: {
          "x-cron-key": validSecret,
          "x-cron-task-uid": "global",
        },
      });
      expect(keyRes.statusCode).toBe(200);
      expect(keyRes.json()?.ok).toBe(true);

      // via Bearer token
      const bearerRes = await app.inject({
        method: "POST",
        url: "/api/scheduled/automation-queue",
        headers: {
          authorization: `Bearer ${validSecret}`,
        },
        query: { taskUid: "global" },
      });
      expect(bearerRes.statusCode).toBe(200);
      expect(bearerRes.json()?.ok).toBe(true);
    });

    it("5. production + missing CRON_SECRET -> rejected with HTTP 401", async () => {
      setupProductionCronEnv();
      delete process.env.CRON_SECRET;
      // In production, missing CRON_SECRET prevents startup or immediately rejects
      let app: any;
      try {
        app = await buildFastifyServer({ logger: false });
      } catch (err: any) {
        expect(err.message).toMatch(/CRON_SECRET/i);
        return;
      }

      const res = await app.inject({
        method: "POST",
        url: "/api/scheduled/interview-reminders",
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()?.error).toBe("cron-authentication-required");
    });

    it("6. production + invalid CRON_SECRET -> rejected with HTTP 401", async () => {
      setupProductionCronEnv();
      const app = await buildFastifyServer({ logger: false });

      const res = await app.inject({
        method: "POST",
        url: "/api/scheduled/interview-reminders",
        headers: {
          "x-cron-key": "invalid_wrong_secret_attempt",
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()?.error).toBe("cron-authentication-required");
    });

    it("7. production must NOT fall back to preview OAuth", async () => {
      setupProductionCronEnv();
      const app = await buildFastifyServer({ logger: false });

      const authenticateSpy = vi.spyOn(sdk, "authenticateRequest");

      const res = await app.inject({
        method: "POST",
        url: "/api/scheduled/interview-reminders",
        headers: {
          authorization: "Bearer wrong_token",
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()?.error).toBe("cron-authentication-required");
      // Assert preview OAuth was NEVER called
      expect(authenticateSpy).not.toHaveBeenCalled();
    });

    it("8. all scheduled endpoints enforce identical production protection", async () => {
      setupProductionCronEnv();
      const app = await buildFastifyServer({ logger: false });

      const endpoints = [
        "/api/scheduled/interview-reminders",
        "/api/scheduled/automation-queue",
      ];

      for (const endpoint of endpoints) {
        // Without auth -> 401
        const unauth = await app.inject({ method: "POST", url: endpoint });
        expect(unauth.statusCode).toBe(401);
        expect(unauth.json()?.error).toBe("cron-authentication-required");

        // With wrong auth -> 401
        const wrongAuth = await app.inject({
          method: "POST",
          url: endpoint,
          headers: { "x-cron-key": "incorrect" },
        });
        expect(wrongAuth.statusCode).toBe(401);
        expect(wrongAuth.json()?.error).toBe("cron-authentication-required");

        // With valid auth -> 200
        const validAuth = await app.inject({
          method: "POST",
          url: endpoint,
          headers: { "x-cron-key": validSecret, "x-cron-task-uid": "global" },
        });
        expect(validAuth.statusCode).toBe(200);
        expect(validAuth.json()?.ok).toBe(true);
      }
    });
  });

  describe("C — Privacy Erasure Fail-Closed Suite", () => {
    const testOwnerId = 1;
    const caller = appRouter.createCaller({
      user: { id: testOwnerId, role: "admin", name: "Admin", email: "partner@freelancehr.local" },
      req: {},
      res: {},
    } as any);

    beforeEach(() => {
      delete process.env.OWNER_ONLY_MODE;
    });

    it("9. physical local file deletion succeeds -> erasure can complete", async () => {
      process.env.PRIVATE_STORAGE_MODE = "local";
      const db = await requireDb();

      const candidateId = createId("cnd_");
      await db.insert(candidates).values({
        id: candidateId,
        ownerId: testOwnerId,
        fullName: "Test Candidate Erasure",
        email: "erase_me@test.local",
        profileState: "available",
      });

      const key = `candidates/${candidateId}/resume.pdf`;
      await putPrivateDocument(key, Buffer.from("test resume content for deletion"), "application/pdf");

      const docId = createId("doc_");
      await db.insert(candidateDocuments).values({
        id: docId,
        candidateId,
        ownerId: testOwnerId,
        documentType: "cv",
        storageKey: `local/${key}`,
        originalName: "test_resume.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 100,
        scanState: "clean",
        parseState: "parsed",
      });

      const requestId = createId("rgt_");
      await db.insert(rightsRequests).values({
        id: requestId,
        ownerId: testOwnerId,
        candidateId,
        requestType: "deletion",
        status: "received",
        details: "Statutory erasure test",
      });

      const result = await caller.recruitment.candidateWorkflows.privacy.fulfillDeletion({
        requestId,
        resolutionNote: "Fulfilled erasure for test",
      });

      expect(result.success).toBe(true);

      // Verify DB record is redacted
      const [updatedDoc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, docId));
      expect(updatedDoc.scanState).toBe("redacted");
      expect(updatedDoc.originalName).toBe("redacted.bin");

      // Verify candidate profile is deleted
      const [updatedCand] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
      expect(updatedCand.profileState).toBe("deleted");
      expect(updatedCand.email).toBeNull();

      // Verify rights request is resolved
      const [updatedReq] = await db.select().from(rightsRequests).where(eq(rightsRequests.id, requestId));
      expect(updatedReq.status).toBe("resolved");

      // Verify physical file was deleted from disk
      await expect(readPrivateDocument(key)).rejects.toThrow();
    });

    it("10. physical deletion fails -> erasure does NOT complete and fails closed", async () => {
      const db = await requireDb();

      const candidateId = createId("cnd_");
      await db.insert(candidates).values({
        id: candidateId,
        ownerId: testOwnerId,
        fullName: "Test Fail Candidate",
        email: "fail_candidate@test.local",
        profileState: "available",
      });

      const docId = createId("doc_");
      await db.insert(candidateDocuments).values({
        id: docId,
        candidateId,
        ownerId: testOwnerId,
        documentType: "cv",
        storageKey: "managed/candidates/fail.pdf",
        originalName: "fail.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 100,
        scanState: "clean",
        parseState: "parsed",
      });

      const requestId = createId("rgt_");
      await db.insert(rightsRequests).values({
        id: requestId,
        ownerId: testOwnerId,
        candidateId,
        requestType: "deletion",
        status: "received",
        details: "Fail test",
      });

      // Set storage mode to managed to trigger physical deletion failure
      process.env.PRIVATE_STORAGE_MODE = "managed";

      await expect(
        caller.recruitment.candidateWorkflows.privacy.fulfillDeletion({
          requestId,
          resolutionNote: "Attempt with managed storage",
        })
      ).rejects.toThrow(/Physical document deletion is not supported/i);

      // Verify fail-closed invariants:
      // 1. Candidate remains intact (not deleted)
      const [cand] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
      expect(cand.profileState).toBe("available");
      expect(cand.email).toBe("fail_candidate@test.local");

      // 2. Document is NOT marked redacted
      const [doc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, docId));
      expect(doc.scanState).toBe("clean");
      expect(doc.originalName).toBe("fail.pdf");

      // 3. Request transitions to investigation
      const [req] = await db.select().from(rightsRequests).where(eq(rightsRequests.id, requestId));
      expect(req.status).toBe("investigation");

      // 4. Audit failure recorded
      const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "privacy.erasure_failed"), eq(auditEvents.resourceId, docId)));
      expect(audits.length).toBeGreaterThan(0);
    });

    it("11. already-missing file (ENOENT) is handled idempotently", async () => {
      process.env.PRIVATE_STORAGE_MODE = "local";

      const result = await deletePrivateDocument("local/candidates/non_existent_file.pdf");
      expect(result).toBe(true);
    });

    it("12. unsupported managed storage cannot falsely report deletion success", async () => {
      process.env.PRIVATE_STORAGE_MODE = "managed";

      await expect(deletePrivateDocument("managed/candidates/any.pdf")).rejects.toThrow(
        /Physical document deletion is not supported in managed storage mode/i
      );
    });
  });
});
