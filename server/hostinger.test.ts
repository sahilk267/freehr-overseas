import { describe, expect, it, vi } from "vitest";
import { buildFastifyServer } from "./hostinger";
import { requireDb, createId } from "./db";
import { automationQueue, candidateDocuments, workspaceSettings, type User } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { putPrivateDocument } from "./services/privateStorage";
import { sdk } from "./_core/sdk";

vi.mock("./services/aiRouting", () => ({
  runControlledAiTask: vi.fn().mockResolvedValue({
    result: { status: "processed" },
    selectedModel: "test-model",
    latencyMs: 5,
  }),
}));

describe("Fastify production server (server/hostinger.ts)", () => {
  it("verifies GET /api/private-storage/* route behavior and security", async () => {
    const originalEnv = { ...process.env };
    process.env.NODE_ENV = "test";
    process.env.PRIVATE_STORAGE_MODE = "local";
    process.env.PRIVATE_LOCAL_STORAGE_PATH = `/tmp/freelancehr-vitest-${Date.now()}`;

    const app = await buildFastifyServer({ logger: false });
    const originalAuthenticateRequest = sdk.authenticateRequest;

    // 1. Unauthenticated request -> 401
    sdk.authenticateRequest = async () => {
      throw new Error("Invalid session");
    };
    const unauthRes = await app.inject({
      method: "GET",
      url: "/api/private-storage/private/1/test-doc.pdf",
    });
    expect(unauthRes.statusCode).toBe(401);
    expect(unauthRes.json()?.error).toBe("authentication-required");

    // 2. Set up authenticated user
    const testUser: User = {
      id: 1,
      openId: "owner_dev",
      name: "Sahil (Owner)",
      email: "owner@freelancehr.local",
      loginMethod: "manus",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    };
    sdk.authenticateRequest = async () => testUser as any;

    // 3. Non-existent document -> 404
    const notFoundRes = await app.inject({
      method: "GET",
      url: "/api/private-storage/private/1/nonexistent.pdf",
    });
    expect(notFoundRes.statusCode).toBe(404);
    expect(notFoundRes.json()?.error).toBe("document-not-found");

    // 4. Document owned by another user -> 404
    const db = await requireDb();
    const otherFileKey = "private/999/candidates/c_other/secret.pdf";
    await putPrivateDocument(otherFileKey, Buffer.from("%PDF-1.4 other user"), "application/pdf");
    await db.insert(candidateDocuments).values({
      id: createId("doc_"),
      ownerId: 999,
      candidateId: "c_other",
      originalName: "secret.pdf",
      mimeType: "application/pdf",
      byteSize: 20,
      storageKey: `local/${otherFileKey}`,
      documentType: "cv",
      sha256: "hash-other",
      createdAt: new Date(),
    });

    const forbiddenRes = await app.inject({
      method: "GET",
      url: `/api/private-storage/${otherFileKey}`,
    });
    expect(forbiddenRes.statusCode).toBe(404);

    // 5. Unscanned document (accepted_pending_scan) -> 403 forbidden
    const pendingFileKey = "private/1/candidates/c_1/pending_resume.pdf";
    await putPrivateDocument(pendingFileKey, Buffer.from("%PDF-1.4 FreelanceHR pending scan file"), "application/pdf");
    const pendingDocId = createId("doc_");
    await db.insert(candidateDocuments).values({
      id: pendingDocId,
      ownerId: 1,
      candidateId: "c_1",
      originalName: "pending_resume.pdf",
      mimeType: "application/pdf",
      byteSize: 40,
      storageKey: `local/${pendingFileKey}`,
      documentType: "cv",
      sha256: "hash-pending",
      scanState: "accepted_pending_scan",
      createdAt: new Date(),
    });

    const pendingRes = await app.inject({
      method: "GET",
      url: `/api/private-storage/${pendingFileKey}`,
    });
    expect(pendingRes.statusCode).toBe(403);
    expect(JSON.parse(pendingRes.body).error).toBe("document-scan-pending");

    // 6. Flagged document -> 403 forbidden
    const flaggedFileKey = "private/1/candidates/c_1/flagged_resume.pdf";
    await putPrivateDocument(flaggedFileKey, Buffer.from("%PDF-1.4 Flagged file"), "application/pdf");
    await db.insert(candidateDocuments).values({
      id: createId("doc_"),
      ownerId: 1,
      candidateId: "c_1",
      originalName: "flagged_resume.pdf",
      mimeType: "application/pdf",
      byteSize: 30,
      storageKey: `local/${flaggedFileKey}`,
      documentType: "cv",
      sha256: "hash-flagged",
      scanState: "flagged",
      createdAt: new Date(),
    });

    const flaggedRes = await app.inject({
      method: "GET",
      url: `/api/private-storage/${flaggedFileKey}`,
    });
    expect(flaggedRes.statusCode).toBe(403);
    expect(JSON.parse(flaggedRes.body).error).toBe("document-flagged");

    // 7. Clean document -> 200 with headers & bytes
    const validFileKey = "private/1/candidates/c_1/resume.pdf";
    await putPrivateDocument(validFileKey, Buffer.from("%PDF-1.4 FreelanceHR resume test file"), "application/pdf");
    await db.insert(candidateDocuments).values({
      id: createId("doc_"),
      ownerId: 1,
      candidateId: "c_1",
      originalName: "resume.pdf",
      mimeType: "application/pdf",
      byteSize: 38,
      storageKey: `local/${validFileKey}`,
      documentType: "cv",
      sha256: "hash-valid",
      scanState: "clean",
      createdAt: new Date(),
    });

    const validRes = await app.inject({
      method: "GET",
      url: `/api/private-storage/${validFileKey}`,
    });
    expect(validRes.statusCode).toBe(200);
    expect(validRes.headers["content-type"]).toBe("application/pdf");
    expect(validRes.headers["content-disposition"]).toBe("inline");
    expect(validRes.body).toContain("%PDF-1.4 FreelanceHR resume test file");

    // 8. Inactive when PRIVATE_STORAGE_MODE !== "local"
    process.env.PRIVATE_STORAGE_MODE = "s3";
    process.env.STORAGE_BUCKET = "test-bucket";
    process.env.STORAGE_REGION = "ap-south-1";
    process.env.STORAGE_ACCESS_KEY_ID = "key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "secret";
    const s3App = await buildFastifyServer({ logger: false });
    const s3Res = await s3App.inject({
      method: "GET",
      url: `/api/private-storage/${validFileKey}`,
    });
    expect(s3Res.statusCode).toBe(404);

    sdk.authenticateRequest = originalAuthenticateRequest;
    process.env = originalEnv;
  });

  it("verifies POST /api/scheduled/interview-reminders cron-only guard and dispatch", async () => {
    const app = await buildFastifyServer({ logger: false });
    const db = await requireDb();
    const originalAuthenticateRequest = sdk.authenticateRequest;

    // 1. Non-cron user -> 403
    sdk.authenticateRequest = async () => ({
      id: 1,
      openId: "regular_user",
      name: "Regular",
      role: "user",
    } as any);
    const nonCronRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/interview-reminders",
    });
    expect(nonCronRes.statusCode).toBe(403);
    expect(nonCronRes.json()?.error).toBe("cron-only");

    // 2. Cron user with orphan taskUid -> skipped: "orphan"
    sdk.authenticateRequest = async () => ({
      id: -1,
      openId: "cron_scheduler",
      isCron: true,
      taskUid: "task_orphan_vitest",
    } as any);
    const orphanRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/interview-reminders",
    });
    expect(orphanRes.statusCode).toBe(200);
    expect(orphanRes.json()?.skipped).toBe("orphan");

    // 3. Cron user with valid workspace taskUid -> executes processDueInterviewReminders
    const cronTaskUid = "task_valid_vitest_cron";
    await db.update(workspaceSettings).set({ scheduleCronTaskUid: cronTaskUid }).where(eq(workspaceSettings.id, 1));
    sdk.authenticateRequest = async () => ({
      id: -1,
      openId: "cron_scheduler",
      isCron: true,
      taskUid: cronTaskUid,
    } as any);

    const validCronRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/interview-reminders",
    });
    expect(validCronRes.statusCode).toBe(200);
    expect(validCronRes.json()?.ok).toBe(true);
    expect(typeof validCronRes.json()?.scanned).toBe("number");
    expect(typeof validCronRes.json()?.queued).toBe("number");

    sdk.authenticateRequest = originalAuthenticateRequest;
  });

  it("verifies POST /api/scheduled/automation-queue cron-only guard, batch processing, and batch limit", async () => {
    const app = await buildFastifyServer({ logger: false });
    const db = await requireDb();
    const originalAuthenticateRequest = sdk.authenticateRequest;

    // 1. Non-cron user -> 403
    sdk.authenticateRequest = async () => ({
      id: 1,
      openId: "regular_user",
      name: "Regular",
      role: "user",
    } as any);
    const nonCronRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/automation-queue",
    });
    expect(nonCronRes.statusCode).toBe(403);
    expect(nonCronRes.json()?.error).toBe("cron-only");

    // 2. Cron user without taskUid -> 403
    sdk.authenticateRequest = async () => ({
      id: -1,
      openId: "cron_scheduler",
      isCron: true,
    } as any);
    const noTaskUidRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/automation-queue",
    });
    expect(noTaskUidRes.statusCode).toBe(403);
    expect(noTaskUidRes.json()?.error).toBe("cron-only");

    // 3. Cron user with orphan taskUid -> skipped: "orphan"
    sdk.authenticateRequest = async () => ({
      id: -1,
      openId: "cron_scheduler",
      isCron: true,
      taskUid: "task_orphan_queue_vitest",
    } as any);
    const orphanRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/automation-queue",
    });
    expect(orphanRes.statusCode).toBe(200);
    expect(orphanRes.json()?.skipped).toBe("orphan");

    // 4. Cron user with valid workspace taskUid -> executes batch processing up to batch limit
    const queueCronTaskUid = "task_valid_queue_vitest";
    await db.update(workspaceSettings).set({ automationCronTaskUid: queueCronTaskUid }).where(eq(workspaceSettings.id, 1));
    sdk.authenticateRequest = async () => ({
      id: -1,
      openId: "cron_scheduler",
      isCron: true,
      taskUid: queueCronTaskUid,
    } as any);

    // Seed 4 queued jobs for owner 1
    const jobIds = [createId("que_"), createId("que_"), createId("que_"), createId("que_")];
    for (const [idx, id] of jobIds.entries()) {
      await db.insert(automationQueue).values({
        id,
        ownerId: 1,
        jobType: "parse_cv",
        status: "queued",
        payload: { text: `Sample CV ${idx}` },
        priority: 10,
        scheduledAt: new Date(Date.now() - 1000),
        maxAttempts: 3,
        idempotencyKey: `test-queue-${id}`,
      });
    }

    // Call endpoint with limit=2 -> stops at batch limit
    const batchLimitRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/automation-queue?limit=2",
    });
    expect(batchLimitRes.statusCode).toBe(200);
    const batchData = batchLimitRes.json();
    expect(batchData?.ok).toBe(true);
    expect(batchData?.processed).toBe(2);
    expect(batchData?.completed).toBe(2);

    // Call endpoint again without query limit -> processes multiple remaining due jobs in one invocation
    const secondBatchRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/automation-queue",
    });
    expect(secondBatchRes.statusCode).toBe(200);
    const secondData = secondBatchRes.json();
    expect(secondData?.ok).toBe(true);
    expect(secondData?.processed).toBe(2);
    expect(secondData?.completed).toBe(2);

    sdk.authenticateRequest = originalAuthenticateRequest;
  });

  it("verifies 10 MB bodyLimit accepts near-5MB upload and rejects >10MB", async () => {
    const app = await buildFastifyServer({ logger: false });

    // 1. Accepts ~7.2 MB body (simulating base64 5 MB binary file + JSON envelope)
    const base64SevenMb = "A".repeat(7 * 1024 * 1024);
    const acceptRes = await app.inject({
      method: "POST",
      url: "/api/webhooks/hostinger-mail",
      payload: { data: base64SevenMb },
    });
    // Transport layer accepts body; Fastify does not reject with 413
    expect(acceptRes.statusCode).not.toBe(413);

    // 2. Rejects 11 MB body with HTTP 413 (FST_ERR_CTP_BODY_TOO_LARGE)
    const elevenMbPayload = { data: "A".repeat(11 * 1024 * 1024) };
    const rejectRes = await app.inject({
      method: "POST",
      url: "/api/webhooks/hostinger-mail",
      payload: elevenMbPayload,
    });
    expect(rejectRes.statusCode).toBe(413);
    expect(rejectRes.json()?.code).toBe("FST_ERR_CTP_BODY_TOO_LARGE");
  });

  it("verifies CRON_SECRET header authentication without OAuth dependency (GAP-02)", async () => {
    const originalSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "test_cron_secret_32_characters_long";
    const app = await buildFastifyServer({ logger: false });
    const originalAuthenticateRequest = sdk.authenticateRequest;
    sdk.authenticateRequest = vi.fn().mockRejectedValue(new Error("Should not call OAuth when CRON_SECRET is valid"));

    // 1. Valid X-Cron-Key header
    const cronKeyRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/interview-reminders",
      headers: {
        "x-cron-key": "test_cron_secret_32_characters_long",
        "x-cron-task-uid": "global",
      },
    });
    expect(cronKeyRes.statusCode).toBe(200);
    expect(cronKeyRes.json()?.ok).toBe(true);

    // 2. Valid Authorization: Bearer <CRON_SECRET> header
    const bearerRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/automation-queue",
      headers: {
        authorization: "Bearer test_cron_secret_32_characters_long",
      },
      query: { taskUid: "global" },
    });
    expect(bearerRes.statusCode).toBe(200);
    expect(bearerRes.json()?.ok).toBe(true);

    // 3. Invalid cron secret falls back to sdk.authenticateRequest which fails
    const invalidRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/interview-reminders",
      headers: {
        "x-cron-key": "wrong_secret",
      },
    });
    expect(invalidRes.statusCode).toBe(500);

    sdk.authenticateRequest = originalAuthenticateRequest;
    process.env.CRON_SECRET = originalSecret;
  });
});
