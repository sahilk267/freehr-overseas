import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  candidateDocuments,
  workflowEvents,
  automationQueue,
} from "../../drizzle/schema";
import { careerRecordsSchema } from "../../shared/careerEvidence";
import { candidateEvidenceInTransaction } from "./candidateEvidence";
import { withWorkspaceTransaction } from "./database";
import {
  hasGeneralCandidateProcessingConsent,
  recordCandidateDocumentChange,
} from "./candidateEvidenceLifecycle";
import { readPrivateDocument } from "./privateStorage";
import { extractDocumentText } from "./documentText";
import {
  CAREER_PARSER_VERSION,
  careerTextHash,
  careerDocumentSourceHash,
  careerEvidenceIntegrity,
  groundCareerRecords,
} from "./careerExtraction";
import { recordAudit } from "../db";
import { appendWorkflowEvent, workflowHash } from "./workflowStore";
async function priorCorrection(tx: any, ownerId: number, documentId: string) {
  return (
    await tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          eq(workflowEvents.aggregateId, documentId),
          eq(workflowEvents.eventType, "candidate.career_source_recorded")
        )
      )
      .orderBy(desc(workflowEvents.revision))
      .limit(1)
  )[0];
}
export const recordCareerSourceInput = z
  .object({
    candidateId: z.string().min(4).max(36),
    documentId: z.string().min(4).max(36),
    expectedFingerprint: z.string().length(64),
    records: careerRecordsSchema,
    reason: z.string().trim().min(8).max(2000),
  })
  .strict();
export async function recordCareerSource(
  ownerId: number,
  actorId: number,
  raw: z.input<typeof recordCareerSourceInput>
) {
  const input = recordCareerSourceInput.parse(raw),
    requestHash = workflowHash(input);
  const source = await withWorkspaceTransaction(ownerId, async tx => {
    const d = await candidateEvidenceInTransaction(
        tx,
        ownerId,
        input.candidateId
      ),
      doc = (
        await tx
          .select()
          .from(candidateDocuments)
          .where(
            and(
              eq(candidateDocuments.ownerId, ownerId),
              eq(candidateDocuments.id, input.documentId)
            )
          )
          .limit(1)
      )[0];
    const prior = await priorCorrection(tx, ownerId, input.documentId);
    if (
      doc?.candidateId === d.candidateId &&
      !d.suppressed &&
      prior?.metadata.requestHash === requestHash &&
      prior.metadata.integrityHash ===
        (doc.parsedData as any)?.careerEvidence?.integrityHash
    )
      return {
        alreadySaved: true as const,
        recorded: true,
        records: prior.metadata.records as number,
        supported: prior.metadata.supported as number,
      };
    if (d.fingerprint !== input.expectedFingerprint)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Candidate evidence changed. Reload the current source.",
      });
    if (
      !doc ||
      doc.candidateId !== d.candidateId ||
      doc.documentType !== "cv" ||
      doc.scanState !== "clean" ||
      !["parsed", "queued", "failed"].includes(doc.parseState) ||
      (doc.provenance as any)?.supersededBy ||
      !doc.sha256 ||
      d.suppressed ||
      !(await hasGeneralCandidateProcessingConsent(tx, ownerId, d.candidateId))
    )
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "A current clean CV with its scanned hash and general processing permission is required. Legacy sources without hashes need re-upload.",
      });
    return {
      storageKey: doc.storageKey,
      mimeType: doc.mimeType,
      sha256: doc.sha256,
      hash: careerDocumentSourceHash(doc),
    };
  });
  if ("alreadySaved" in source) return source;
  const bytes = await readPrivateDocument(source.storageKey);
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The stored CV bytes differ from the scanned source.",
    });
  const text = await extractDocumentText(bytes, source.mimeType, {
      strictDocx: true,
      maxPdfPages: 100,
      rejectOverflow: true,
      maxChars: 12000,
    }),
    records = groundCareerRecords(text, input.records);
  return withWorkspaceTransaction(ownerId, async tx => {
    const d = await candidateEvidenceInTransaction(
        tx,
        ownerId,
        input.candidateId
      ),
      doc = (
        await tx
          .select()
          .from(candidateDocuments)
          .where(
            and(
              eq(candidateDocuments.ownerId, ownerId),
              eq(candidateDocuments.id, input.documentId)
            )
          )
          .limit(1)
      )[0];
    const prior = await priorCorrection(tx, ownerId, input.documentId);
    if (
      doc?.candidateId === d.candidateId &&
      !d.suppressed &&
      prior?.metadata.requestHash === requestHash &&
      prior.metadata.integrityHash ===
        (doc.parsedData as any)?.careerEvidence?.integrityHash
    )
      return {
        alreadySaved: true,
        recorded: true,
        records: prior.metadata.records as number,
        supported: prior.metadata.supported as number,
      };
    if (
      !doc ||
      d.fingerprint !== input.expectedFingerprint ||
      careerDocumentSourceHash(doc) !== source.hash ||
      !["parsed", "queued", "failed"].includes(doc.parseState) ||
      d.suppressed ||
      !(await hasGeneralCandidateProcessingConsent(tx, ownerId, d.candidateId))
    )
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "The candidate, source or processing permission changed during extraction.",
      });
    const c = {
        parserVersion: CAREER_PARSER_VERSION,
        sourceTextHash: careerTextHash(text),
        documentSourceHash: source.hash,
        documentId: doc.id,
        candidateId: doc.candidateId,
        documentSha256: doc.sha256,
        model: "owner_literal_source",
        observedAt: new Date().toISOString(),
        records,
      },
      careerEvidence = { ...c, integrityHash: careerEvidenceIntegrity(c) };
    await tx
      .update(candidateDocuments)
      .set({
        parseState: "parsed",
        provenance: {
          ...((doc.provenance as any) ?? {}),
          lastParseError: null,
          careerExtractionMethod: "owner_literal_source",
        },
        parsedData: { ...((doc.parsedData as any) ?? {}), careerEvidence },
      })
      .where(
        and(
          eq(candidateDocuments.ownerId, ownerId),
          eq(candidateDocuments.id, doc.id)
        )
      );
    const unused = await tx
      .select()
      .from(automationQueue)
      .where(
        and(
          eq(automationQueue.ownerId, ownerId),
          eq(automationQueue.jobType, "parse_cv"),
          inArray(automationQueue.status, [
            "queued",
            "retryable_failed",
            "blocked",
          ])
        )
      );
    for (const task of unused.filter(
      (task: any) => task.payload?.documentId === doc.id
    ))
      await tx
        .update(automationQueue)
        .set({
          status: "cancelled",
          lastError:
            "Reviewed literal career extraction replaced unused AI parsing work.",
          lockToken: null,
          lockedAt: null,
        })
        .where(
          and(
            eq(automationQueue.ownerId, ownerId),
            eq(automationQueue.id, task.id),
            inArray(automationQueue.status, [
              "queued",
              "retryable_failed",
              "blocked",
            ])
          )
        );
    await appendWorkflowEvent(
      tx,
      ownerId,
      "candidate.career_source_recorded",
      doc.id,
      (prior?.revision ?? 0) + 1,
      {
        candidateId: d.candidateId,
        requestHash,
        integrityHash: careerEvidence.integrityHash,
        records: records.length,
        supported: records.filter(r => r.supported).length,
        actorId,
        reason: input.reason,
      }
    );
    await recordCandidateDocumentChange(tx, ownerId, d.candidateId, {
      candidateId: d.candidateId,
      documentId: doc.id,
      reason: "Literal career source extraction changed",
      actorId,
    });
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "candidate.career_source_recorded",
        resourceType: "candidate_document",
        resourceId: doc.id,
        metadata: {
          candidateId: d.candidateId,
          records: records.length,
          supported: records.filter(r => r.supported).length,
          independentlyVerified: false,
        },
      },
      tx
    );
    return {
      recorded: true,
      records: records.length,
      supported: records.filter(r => r.supported).length,
    };
  });
}
