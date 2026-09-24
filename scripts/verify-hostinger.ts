/**
 * Standalone verification script for Fastify production server route parity & bodyLimit.
 * 
 * Verifies:
 * 1. GET /api/private-storage/* route:
 *    - 401 when unauthenticated
 *    - 404 when document not found
 *    - 404 when document owner does not match authenticated user
 *    - 200 with Content-Type, Content-Disposition, and file bytes when valid & owned
 *    - Inactive when PRIVATE_STORAGE_MODE !== "local"
 * 2. POST /api/scheduled/interview-reminders route:
 *    - 403 when caller is not a cron task (missing isCron or taskUid)
 *    - 200 with skipped="orphan" when workspace is not found for taskUid
 *    - 200 with processed result when taskUid matches a workspace
 * 3. Body limit verification:
 *    - Accepts ~7.2 MB body (simulating base64-encoded ~5 MB binary file in JSON envelope)
 *    - Rejects >10 MB body with HTTP 413 (FST_ERR_CTP_BODY_TOO_LARGE)
 * 
 * Run with: npx tsx scripts/verify-hostinger.ts
 */

import { buildFastifyServer } from "../server/hostinger";
import { requireDb, createId } from "../server/db";
import { candidateDocuments, workspaceSettings, users, type User } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { putPrivateDocument } from "../server/services/privateStorage";
import { sdk } from "../server/_core/sdk";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

async function runVerification() {
  console.log("=== Fastify Production Server Verification ===\n");

  const originalEnv = { ...process.env };
  process.env.NODE_ENV = "test";
  process.env.PRIVATE_STORAGE_MODE = "local";
  process.env.PRIVATE_LOCAL_STORAGE_PATH = `/tmp/freelancehr-test-${Date.now()}`;
  delete process.env.OWNER_ONLY_MODE;

  const db = await requireDb();
  const testUserId = 1;

  // Build server instance in local storage mode
  const app = await buildFastifyServer({ logger: false });

  console.log("Section 1: Private Storage Route (GET /api/private-storage/*)");

  // 1a. Unauthenticated request -> 401
  const originalAuthenticateRequest = sdk.authenticateRequest;
  sdk.authenticateRequest = async () => {
    throw new Error("Invalid session");
  };

  const unauthRes = await app.inject({
    method: "GET",
    url: "/api/private-storage/private/1/test-doc.pdf",
  });
  assert(unauthRes.statusCode === 401, "Unauthenticated request returns 401");
  assert(unauthRes.json()?.error === "authentication-required", "Error is 'authentication-required'");

  // Set up authenticated user mock for tests
  const testUser: User = {
    id: testUserId,
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

  // Create test document in local storage
  const fileKey = `private/${testUserId}/candidates/cand_aarav/resume.pdf`;
  await putPrivateDocument(fileKey, Buffer.from("%PDF-1.4 FreelanceHR resume test file"), "application/pdf");

  const docId = createId("doc_");
  await db.insert(candidateDocuments).values({
    id: docId,
    ownerId: testUserId,
    candidateId: "cand_aarav",
    originalName: "resume.pdf",
    mimeType: "application/pdf",
    sizeBytes: 38,
    storageKey: `local/${fileKey}`,
    storageUrl: `/api/private-storage/${fileKey}`,
    documentType: "cv",
    sha256: "test-hash",
    scanState: "clean",
    extractedText: "Test CV",
    createdAt: new Date(),
  });

  // 1b. Non-existent document -> 404
  const notFoundRes = await app.inject({
    method: "GET",
    url: "/api/private-storage/private/1/nonexistent.pdf",
  });
  assert(notFoundRes.statusCode === 404, "Non-existent document returns 404");
  assert(notFoundRes.json()?.error === "document-not-found", "Error is 'document-not-found'");

  // 1c. Document owned by another user -> 404
  const otherDocId = createId("doc_");
  const otherFileKey = `private/999/candidates/cand_other/secret.pdf`;
  await putPrivateDocument(otherFileKey, Buffer.from("%PDF-1.4 other user file"), "application/pdf");
  await db.insert(candidateDocuments).values({
    id: otherDocId,
    ownerId: 999, // Different owner
    candidateId: "cand_other",
    originalName: "secret.pdf",
    mimeType: "application/pdf",
    sizeBytes: 30,
    storageKey: `local/${otherFileKey}`,
    storageUrl: `/api/private-storage/${otherFileKey}`,
    documentType: "cv",
    sha256: "test-hash-other",
    scanState: "clean",
    createdAt: new Date(),
  });

  const forbiddenRes = await app.inject({
    method: "GET",
    url: `/api/private-storage/${otherFileKey}`,
  });
  assert(forbiddenRes.statusCode === 404, "Document owned by another user returns 404");

  // 1d. Valid authenticated request for owned document -> 200 with headers & bytes
  const validRes = await app.inject({
    method: "GET",
    url: `/api/private-storage/${fileKey}`,
  });
  assert(validRes.statusCode === 200, "Authorized owner request returns 200");
  assert(validRes.headers["content-type"] === "application/pdf", "Content-Type is 'application/pdf'");
  assert(validRes.headers["content-disposition"] === "inline", "Content-Disposition is 'inline'");
  assert(validRes.body.includes("%PDF-1.4 FreelanceHR resume test file"), "File content streamed correctly");

  // 1e. Route inactive when PRIVATE_STORAGE_MODE !== "local"
  process.env.PRIVATE_STORAGE_MODE = "s3";
  process.env.STORAGE_BUCKET = "test-bucket";
  process.env.STORAGE_REGION = "ap-south-1";
  process.env.STORAGE_ACCESS_KEY_ID = "key";
  process.env.STORAGE_SECRET_ACCESS_KEY = "secret";
  const s3App = await buildFastifyServer({ logger: false });
  const s3Res = await s3App.inject({
    method: "GET",
    url: `/api/private-storage/${fileKey}`,
  });
  assert(s3Res.statusCode === 404, "Route inactive (404) when PRIVATE_STORAGE_MODE is 's3'");
  process.env.PRIVATE_STORAGE_MODE = "local";

  console.log("\nSection 2: Scheduled Interview Reminders (POST /api/scheduled/interview-reminders)");

  // 2a. Non-cron user -> 403
  sdk.authenticateRequest = async () => testUser as any;
  const nonCronRes = await app.inject({
    method: "POST",
    url: "/api/scheduled/interview-reminders",
  });
  assert(nonCronRes.statusCode === 403, "Non-cron user returns 403");
  assert(nonCronRes.json()?.error === "cron-only", "Error is 'cron-only'");

  // 2b. Cron user with unknown taskUid -> skipped: "orphan"
  sdk.authenticateRequest = async () => ({
    id: -1,
    openId: "cron_sample_task",
    isCron: true,
    taskUid: "task_orphan_123",
  } as any);

  const orphanRes = await app.inject({
    method: "POST",
    url: "/api/scheduled/interview-reminders",
  });
  assert(orphanRes.statusCode === 200, "Cron request returns 200");
  assert(orphanRes.json()?.skipped === "orphan", "Returns skipped='orphan' for unregistered taskUid");

  // 2c. Cron user with valid workspace taskUid -> executes processDueInterviewReminders
  const cronTaskUid = "task_valid_cron_999";
  await db.update(workspaceSettings).set({ scheduleCronTaskUid: cronTaskUid }).where(eq(workspaceSettings.id, 1));
  sdk.authenticateRequest = async () => ({
    id: -1,
    openId: "cron_sample_task",
    isCron: true,
    taskUid: cronTaskUid,
  } as any);

  const validCronRes = await app.inject({
    method: "POST",
    url: "/api/scheduled/interview-reminders",
  });
  assert(validCronRes.statusCode === 200, "Valid cron request returns 200");
  assert(validCronRes.json()?.ok === true, "Response has ok: true");
  assert(typeof validCronRes.json()?.scanned === "number", "Returns scanned count number");
  assert(typeof validCronRes.json()?.queued === "number", "Returns queued count number");

  // Restore sdk.authenticateRequest
  sdk.authenticateRequest = originalAuthenticateRequest;

  console.log("\nSection 3: Fastify bodyLimit (10 MB Ceiling)");

  // 3a. Near-5MB payload (~7.2 MB base64 JSON payload)
  // 5 MB binary file -> 5 * 1024 * 1024 * 4 / 3 = 6,990,507 characters
  const base64SevenMb = "A".repeat(7 * 1024 * 1024);
  const near5MbPayload = {
    data: base64SevenMb,
  };

  const uploadRes = await app.inject({
    method: "POST",
    url: "/api/webhooks/hostinger-mail",
    payload: near5MbPayload,
  });
  // Note: the request must NOT be rejected by Fastify with HTTP 413 (FST_ERR_CTP_BODY_TOO_LARGE).
  assert(uploadRes.statusCode !== 413, `Fastify accepts ~7.2 MB body without 413 (got ${uploadRes.statusCode})`);

  // 3b. Payload exceeding 10 MB limit (e.g. 11 MB) -> 413
  const elevenMbPayload = {
    data: "A".repeat(11 * 1024 * 1024),
  };
  const tooLargeRes = await app.inject({
    method: "POST",
    url: "/api/webhooks/hostinger-mail",
    payload: elevenMbPayload,
  });
  assert(tooLargeRes.statusCode === 413, "Payload exceeding 10 MB is rejected with HTTP 413");
  assert(tooLargeRes.json()?.code === "FST_ERR_CTP_BODY_TOO_LARGE", "Fastify error code is FST_ERR_CTP_BODY_TOO_LARGE");

  // Cleanup
  process.env = originalEnv;

  console.log(`\nVerification complete: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch(err => {
  console.error("Verification failed with uncaught exception:", err);
  process.exit(1);
});
