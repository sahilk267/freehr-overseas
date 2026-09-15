import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { automationQueue, candidateDocuments, candidates, workspaceSettings } from "../../drizzle/schema";
import { createId, requireDb } from "../db";
import { eq } from "drizzle-orm";
import { scanCandidateDocument, scanDocumentBytes } from "./documentScanner";
import { putPrivateDocument } from "./privateStorage";
import { processOneQueuedJob } from "./queue";
import { router } from "../_core/trpc";
import { recruitmentRouter } from "../routers/recruitment";

const testRouter = router({ recruitment: recruitmentRouter });

describe("document scanner and safe access enforcement", () => {
  const testOwnerId = 555;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      PRIVATE_STORAGE_MODE: "local",
      PRIVATE_LOCAL_STORAGE_PATH: `/tmp/freelancehr-test-scanner-${process.pid}`,
    };

    const db = await requireDb();
    await db.delete(candidateDocuments).where(eq(candidateDocuments.ownerId, testOwnerId));
    await db.delete(automationQueue).where(eq(automationQueue.ownerId, testOwnerId));
    await db.delete(candidates).where(eq(candidates.ownerId, testOwnerId));
    await db.delete(workspaceSettings).where(eq(workspaceSettings.ownerId, testOwnerId));

    await db.insert(workspaceSettings).values({
      id: 555,
      ownerId: testOwnerId,
      businessName: "Test Security Workspace",
      automationMode: "controlled",
      emergencyStop: false,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("byte-level inspection (scanDocumentBytes)", () => {
    it("approves a clean PDF with matching sha256", () => {
      const pdfBytes = Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF");
      const sha = createHash("sha256").update(pdfBytes).digest("hex");
      const result = scanDocumentBytes(pdfBytes, "application/pdf", sha);
      expect(result.clean).toBe(true);
      expect(result.status).toBe("clean");
      expect(result.findings).toHaveLength(0);
      expect(result.sha256).toBe(sha);
    });

    it("approves a clean DOCX zip payload", () => {
      const docxBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
      const result = scanDocumentBytes(docxBytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      expect(result.clean).toBe(true);
      expect(result.status).toBe("clean");
    });

    it("approves a clean plain text resume", () => {
      const txtBytes = Buffer.from("Senior Fullstack Engineer\nExperience: 8 years TypeScript, React, Node.js");
      const result = scanDocumentBytes(txtBytes, "text/plain");
      expect(result.clean).toBe(true);
      expect(result.status).toBe("clean");
    });

    it("flags document if computed hash does not match expected sha256", () => {
      const bytes = Buffer.from("%PDF-1.4 Sample document content");
      const result = scanDocumentBytes(bytes, "application/pdf", "wrong-sha256-digest");
      expect(result.clean).toBe(false);
      expect(result.status).toBe("flagged");
      expect(result.findings).toContain("hash_mismatch");
    });

    it("flags empty document (0 bytes)", () => {
      const result = scanDocumentBytes(Buffer.alloc(0), "application/pdf");
      expect(result.clean).toBe(false);
      expect(result.status).toBe("flagged");
      expect(result.findings).toContain("empty_payload");
    });

    it("flags document exceeding the 5 MB threshold", () => {
      const largeBytes = Buffer.alloc(5 * 1024 * 1024 + 10, "%PDF-1.4");
      const result = scanDocumentBytes(largeBytes, "application/pdf");
      expect(result.clean).toBe(false);
      expect(result.status).toBe("flagged");
      expect(result.findings).toContain("oversized_payload");
    });

    it("flags PDF claiming to be PDF without %PDF- magic header", () => {
      const spoofedPdf = Buffer.from("<html><body>Malicious HTML masquerading as PDF</body></html>");
      const result = scanDocumentBytes(spoofedPdf, "application/pdf");
      expect(result.clean).toBe(false);
      expect(result.status).toBe("flagged");
      expect(result.findings).toContain("invalid_pdf_header");
    });

    it("flags DOCX without ZIP PK magic header", () => {
      const spoofedDocx = Buffer.from("This is just plain text not a docx package");
      const result = scanDocumentBytes(spoofedDocx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      expect(result.clean).toBe(false);
      expect(result.status).toBe("flagged");
      expect(result.findings).toContain("invalid_docx_header");
    });

    it("flags plain text document with embedded binary null bytes", () => {
      const badText = Buffer.from("Normal text\x00with hidden binary payload");
      const result = scanDocumentBytes(badText, "text/plain");
      expect(result.clean).toBe(false);
      expect(result.status).toBe("flagged");
      expect(result.findings).toContain("binary_null_byte_in_text");
    });

    it("flags EICAR standard antivirus test signature", () => {
      const eicarPayload = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
      const result = scanDocumentBytes(eicarPayload, "text/plain");
      expect(result.clean).toBe(false);
      expect(result.status).toBe("flagged");
      expect(result.findings).toContain("malware_test_signature_detected");
    });

    it("flags executable Windows PE (MZ) binary uploaded as document", () => {
      const peBytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]); // MZ header
      const result = scanDocumentBytes(peBytes, "application/pdf");
      expect(result.clean).toBe(false);
      expect(result.status).toBe("flagged");
      expect(result.findings).toContain("executable_header_windows_pe");
    });

    it("flags Linux ELF executable binary", () => {
      const elfBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]); // \x7fELF
      const result = scanDocumentBytes(elfBytes, "application/pdf");
      expect(result.clean).toBe(false);
      expect(result.status).toBe("flagged");
      expect(result.findings).toContain("executable_header_linux_elf");
    });

    it("flags macro-enabled Word document with vbaProject.bin", () => {
      const macroDocx = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from("word/vbaProject.bin malicious macro code"),
      ]);
      const result = scanDocumentBytes(macroDocx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      expect(result.clean).toBe(false);
      expect(result.status).toBe("flagged");
      expect(result.findings).toContain("docx_macro_detected");
    });
  });

  describe("access gate & queue scanning end-to-end", () => {
    it("refuses access to an unscanned document and permits access once clean", async () => {
      const db = await requireDb();

      // 1. Create candidate
      const candidateId = createId("cnd_");
      await db.insert(candidates).values({
        id: candidateId,
        ownerId: testOwnerId,
        fullName: "Jordan Lee",
        email: "jordan@example.test",
        profileState: "available",
        sourceType: "manual",
      });

      // 2. Upload valid PDF document
      const fileBytes = Buffer.from("%PDF-1.4 FreelanceHR clean CV payload for testing");
      const fileSha = createHash("sha256").update(fileBytes).digest("hex");
      const storageKey = `private/${testOwnerId}/candidates/${candidateId}/resume.pdf`;
      await putPrivateDocument(storageKey, fileBytes, "application/pdf");

      const docId = createId("doc_");
      await db.insert(candidateDocuments).values({
        id: docId,
        candidateId,
        ownerId: testOwnerId,
        documentType: "cv",
        storageKey: `local/${storageKey}`,
        storageUrl: `/api/private-storage/${encodeURIComponent(storageKey)}`,
        originalName: "resume.pdf",
        mimeType: "application/pdf",
        sizeBytes: fileBytes.length,
        sha256: fileSha,
        scanState: "accepted_pending_scan",
        parseState: "queued",
      });

      // 3. documents.access MUST reject access while scanState is accepted_pending_scan
      const caller = testRouter.createCaller({
        user: { id: testOwnerId, role: "admin", email: "owner@example.test" },
        req: { headers: { "x-freelancehr-workspace": String(testOwnerId) } },
        res: {},
      } as never);

      await expect(caller.recruitment.candidates.documents.access({ documentId: docId })).rejects.toThrow(
        "Document is pending security scanning and cannot be accessed yet."
      );

      // 4. Run document scan
      const scanResult = await scanCandidateDocument(docId, testOwnerId);
      expect(scanResult.clean).toBe(true);
      expect(scanResult.status).toBe("clean");

      // Verify DB scanState updated to clean
      const updatedDoc = (await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, docId)).limit(1))[0];
      expect(updatedDoc?.scanState).toBe("clean");

      // 5. documents.access MUST now succeed and return signed URL
      const accessResult = await caller.recruitment.candidates.documents.access({ documentId: docId });
      expect(accessResult.url).toContain(encodeURIComponent(storageKey));
      expect(accessResult.expiresAt).toBeInstanceOf(Date);
    });

    it("refuses access to a flagged document and blocks downstream parsing", async () => {
      const db = await requireDb();

      const candidateId = createId("cnd_");
      await db.insert(candidates).values({
        id: candidateId,
        ownerId: testOwnerId,
        fullName: "Alex Rivera",
        profileState: "available",
        sourceType: "manual",
      });

      // Upload file with EICAR test malware string
      const badBytes = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
      const badSha = createHash("sha256").update(badBytes).digest("hex");
      const storageKey = `private/${testOwnerId}/candidates/${candidateId}/bad.txt`;
      await putPrivateDocument(storageKey, badBytes, "text/plain");

      const docId = createId("doc_");
      await db.insert(candidateDocuments).values({
        id: docId,
        candidateId,
        ownerId: testOwnerId,
        documentType: "cv",
        storageKey: `local/${storageKey}`,
        storageUrl: `/api/private-storage/${encodeURIComponent(storageKey)}`,
        originalName: "bad.txt",
        mimeType: "text/plain",
        sizeBytes: badBytes.length,
        sha256: badSha,
        scanState: "accepted_pending_scan",
        parseState: "queued",
      });

      const caller = testRouter.createCaller({
        user: { id: testOwnerId, role: "admin", email: "owner@example.test" },
        req: { headers: { "x-freelancehr-workspace": String(testOwnerId) } },
        res: {},
      } as never);

      // Perform scan
      const scanResult = await scanCandidateDocument(docId, testOwnerId);
      expect(scanResult.clean).toBe(false);
      expect(scanResult.status).toBe("flagged");

      // Document scanState should be flagged, parseState should be blocked
      const updatedDoc = (await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, docId)).limit(1))[0];
      expect(updatedDoc?.scanState).toBe("flagged");
      expect(updatedDoc?.parseState).toBe("blocked");

      // documents.access MUST reject access with flagged message
      await expect(caller.recruitment.candidates.documents.access({ documentId: docId })).rejects.toThrow(
        "Document was flagged during security scanning and cannot be accessed."
      );
    });

    it("processes scan_document job asynchronously via automationQueue", async () => {
      const db = await requireDb();

      const candidateId = createId("cnd_");
      await db.insert(candidates).values({
        id: candidateId,
        ownerId: testOwnerId,
        fullName: "Taylor Chen",
        profileState: "available",
        sourceType: "manual",
      });

      const fileBytes = Buffer.from("%PDF-1.4 Valid candidate CV content");
      const fileSha = createHash("sha256").update(fileBytes).digest("hex");
      const storageKey = `private/${testOwnerId}/candidates/${candidateId}/cv.pdf`;
      await putPrivateDocument(storageKey, fileBytes, "application/pdf");

      const docId = createId("doc_");
      await db.insert(candidateDocuments).values({
        id: docId,
        candidateId,
        ownerId: testOwnerId,
        documentType: "cv",
        storageKey: `local/${storageKey}`,
        storageUrl: `/api/private-storage/${encodeURIComponent(storageKey)}`,
        originalName: "cv.pdf",
        mimeType: "application/pdf",
        sizeBytes: fileBytes.length,
        sha256: fileSha,
        scanState: "accepted_pending_scan",
        parseState: "queued",
      });

      const jobId = createId("que_");
      await db.insert(automationQueue).values({
        id: jobId,
        ownerId: testOwnerId,
        jobType: "scan_document",
        status: "queued",
        payload: { candidateId, documentId: docId },
        priority: 1,
        scheduledAt: new Date(),
        maxAttempts: 3,
      });

      // Process job via queue engine
      const processResult = await processOneQueuedJob(testOwnerId);
      expect(processResult.status).toBe("completed");
      expect(processResult.jobId).toBe(jobId);

      // Verify queue item completed
      const finishedJob = (await db.select().from(automationQueue).where(eq(automationQueue.id, jobId)).limit(1))[0];
      expect(finishedJob?.status).toBe("completed");

      // Verify document marked clean
      const scannedDoc = (await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, docId)).limit(1))[0];
      expect(scannedDoc?.scanState).toBe("clean");
    });
  });
});
