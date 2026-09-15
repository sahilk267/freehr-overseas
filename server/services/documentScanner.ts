import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { candidateDocuments } from "../../drizzle/schema";
import { recordAudit, requireDb } from "../db";
import { readPrivateDocument } from "./privateStorage";

export type DocumentScanResult = {
  clean: boolean;
  status: "clean" | "flagged";
  reason?: string;
  findings: string[];
  sha256: string;
  sizeBytes: number;
};

// EICAR standard antivirus test string signature
const EICAR_SIGNATURE = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

// Common malicious executable magic headers
const EXECUTABLE_SIGNATURES = [
  { name: "windows_pe", check: (b: Buffer) => b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a }, // MZ
  { name: "linux_elf", check: (b: Buffer) => b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 }, // \x7fELF
  {
    name: "mach_o",
    check: (b: Buffer) =>
      b.length >= 4 &&
      ((b[0] === 0xfe && b[1] === 0xed && b[2] === 0xfa && (b[3] === 0xce || b[3] === 0xcf)) ||
        (b[0] === 0xce && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) ||
        (b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) ||
        (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe)),
  },
  { name: "shell_script", check: (b: Buffer) => b.length >= 2 && b[0] === 0x23 && b[1] === 0x21 }, // #!
];

export function scanDocumentBytes(bytes: Buffer, mimeType: string, expectedSha256?: string | null): DocumentScanResult {
  const sizeBytes = bytes.length;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const findings: string[] = [];

  // 1. Size bounds
  if (sizeBytes === 0) {
    findings.push("empty_payload");
    return { clean: false, status: "flagged", reason: "Document is empty (0 bytes).", findings, sha256, sizeBytes };
  }
  if (sizeBytes > 5 * 1024 * 1024) {
    findings.push("oversized_payload");
    return { clean: false, status: "flagged", reason: "Document exceeds the maximum 5 MB limit.", findings, sha256, sizeBytes };
  }

  // 2. Hash integrity check
  if (expectedSha256 && expectedSha256.toLowerCase() !== sha256.toLowerCase()) {
    findings.push("hash_mismatch");
    return { clean: false, status: "flagged", reason: "Document checksum mismatch: stored file content does not match upload sha256.", findings, sha256, sizeBytes };
  }

  // 3. EICAR malware test string detection
  const rawText = bytes.toString("latin1");
  if (rawText.includes(EICAR_SIGNATURE)) {
    findings.push("malware_test_signature_detected");
    return { clean: false, status: "flagged", reason: "Malware test signature (EICAR) detected.", findings, sha256, sizeBytes };
  }

  // 4. Executable / script polyglot check
  for (const sig of EXECUTABLE_SIGNATURES) {
    if (sig.check(bytes)) {
      findings.push(`executable_header_${sig.name}`);
      return { clean: false, status: "flagged", reason: `Executable binary or script payload detected (${sig.name}).`, findings, sha256, sizeBytes };
    }
  }

  // 5. MIME consistency & format magic header validation
  if (mimeType === "application/pdf") {
    // PDF must start with %PDF- (0x25 0x50 0x44 0x46 0x2d)
    const hasPdfHeader = bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    if (!hasPdfHeader) {
      findings.push("invalid_pdf_header");
      return { clean: false, status: "flagged", reason: "File signature mismatch: claimed PDF does not begin with %PDF- magic header.", findings, sha256, sizeBytes };
    }
    // Check for suspicious embedded script tags in PDF
    if (rawText.includes("<script") || rawText.includes("/JavaScript") || rawText.includes("/JS ")) {
      findings.push("pdf_embedded_javascript");
      return { clean: false, status: "flagged", reason: "Suspicious embedded JavaScript detected in PDF document.", findings, sha256, sizeBytes };
    }
  } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    // DOCX is a ZIP container, must begin with PK\x03\x04
    const hasZipHeader = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (!hasZipHeader) {
      findings.push("invalid_docx_header");
      return { clean: false, status: "flagged", reason: "File signature mismatch: claimed DOCX does not begin with ZIP PK header.", findings, sha256, sizeBytes };
    }
    // Check for malicious macros or embedded scripts in DOCX
    if (rawText.includes("vbaProject.bin") || rawText.includes("word/vbaData.xml")) {
      findings.push("docx_macro_detected");
      return { clean: false, status: "flagged", reason: "Document contains executable macro storage (vbaProject.bin).", findings, sha256, sizeBytes };
    }
  } else if (mimeType === "text/plain") {
    // Plain text should not contain binary null bytes in the first 1024 bytes
    const checkLength = Math.min(bytes.length, 1024);
    for (let i = 0; i < checkLength; i++) {
      if (bytes[i] === 0x00) {
        findings.push("binary_null_byte_in_text");
        return { clean: false, status: "flagged", reason: "Plain text document contains binary null bytes.", findings, sha256, sizeBytes };
      }
    }
    if (rawText.includes("<script") || rawText.includes("javascript:")) {
      findings.push("script_injection_in_text");
      return { clean: false, status: "flagged", reason: "Suspicious script injection payload detected in text document.", findings, sha256, sizeBytes };
    }
  }

  return { clean: true, status: "clean", findings: [], sha256, sizeBytes };
}

export async function scanCandidateDocument(documentId: string, ownerId: number): Promise<DocumentScanResult> {
  const db = await requireDb();
  const document = (
    await db
      .select()
      .from(candidateDocuments)
      .where(and(eq(candidateDocuments.id, documentId), eq(candidateDocuments.ownerId, ownerId)))
      .limit(1)
  )[0];

  if (!document) {
    throw new Error(`Candidate document ${documentId} was not found for owner ${ownerId}.`);
  }

  const bytes = await readPrivateDocument(document.storageKey);
  const scanResult = scanDocumentBytes(bytes, document.mimeType, document.sha256);

  if (scanResult.clean) {
    await db
      .update(candidateDocuments)
      .set({
        scanState: "clean",
        updatedAt: new Date(),
      })
      .where(eq(candidateDocuments.id, document.id));

    await recordAudit({
      ownerId,
      actorType: "system",
      action: "candidate.document_scanned",
      resourceType: "candidate_document",
      resourceId: document.id,
      previousState: document.scanState,
      nextState: "clean",
      metadata: {
        sha256: document.sha256,
        sizeBytes: document.sizeBytes,
        findings: [],
      },
    });
  } else {
    await db
      .update(candidateDocuments)
      .set({
        scanState: "flagged",
        parseState: "blocked",
        updatedAt: new Date(),
      })
      .where(eq(candidateDocuments.id, document.id));

    await recordAudit({
      ownerId,
      actorType: "system",
      action: "candidate.document_scan_flagged",
      resourceType: "candidate_document",
      resourceId: document.id,
      previousState: document.scanState,
      nextState: "flagged",
      metadata: {
        reason: scanResult.reason,
        findings: scanResult.findings,
        sha256: document.sha256,
      },
    });
  }

  return scanResult;
}
