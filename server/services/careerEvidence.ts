import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { workflowEvents } from "../../drizzle/schema";
import {
  analyzeCareerRecords,
  type GroundedCareerRecord,
} from "../../shared/careerEvidence";
import { candidateEvidenceInTransaction } from "./candidateEvidence";
import {
  CAREER_PARSER_VERSION,
  careerTextHash,
  careerEvidenceIntegrity,
} from "./careerExtraction";
import { withWorkspaceTransaction } from "./database";
import { appendWorkflowEvent, workflowHash } from "./workflowStore";
import {
  recordCandidateDocumentChange,
  hasGeneralCandidateProcessingConsent,
} from "./candidateEvidenceLifecycle";
import { recordAudit } from "../db";
import { ensureSafeAiText } from "../workflow";

async function latest(tx: any, ownerId: number, candidateId: string) {
  return (
    await tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          eq(workflowEvents.aggregateId, candidateId),
          eq(workflowEvents.eventType, "candidate.career_reviewed")
        )
      )
      .orderBy(desc(workflowEvents.revision))
      .limit(1)
  )[0];
}
export async function careerEvidenceInTransaction(
  tx: any,
  ownerId: number,
  d: any
) {
  const documents = d.documents
    .filter(
      (doc: any) =>
        doc.scanState === "clean" &&
        doc.parseState === "parsed" &&
        !doc.supersededBy &&
        doc.parsedData?.careerEvidence?.parserVersion === CAREER_PARSER_VERSION
    )
    .map((doc: any) => {
      const c = doc.parsedData.careerEvidence,
        records = c.records as GroundedCareerRecord[];
      if (
        c.documentId !== doc.documentId ||
        c.candidateId !== d.candidateId ||
        c.documentSha256 !== doc.sha256 ||
        c.integrityHash !== careerEvidenceIntegrity(c)
      )
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Stored career evidence failed its source integrity check.",
        });
      return {
        documentId: doc.documentId,
        sha256: doc.sha256,
        integrityHash: c.integrityHash,
        sourceTextHash: c.sourceTextHash,
        model: c.model,
        parserVersion: c.parserVersion,
        observedAt: c.observedAt,
        records,
        analysis: null as ReturnType<typeof analyzeCareerRecords> | null,
        pageMappingAvailable: false as const,
      };
    });
  const sourceSignature = workflowHash(
      documents.map((doc: any) => [
        doc.documentId,
        doc.sha256,
        doc.sourceTextHash,
        doc.integrityHash,
        doc.parserVersion,
        doc.records.map((r: any) => r.id),
      ])
    ),
    review = await latest(tx, ownerId, d.candidateId),
    current = review?.metadata.sourceSignature === sourceSignature;
  const decisions = current
    ? (review.metadata.decisions as Record<string, any>)
    : {};
  for (const doc of documents)
    doc.analysis = analyzeCareerRecords(
      doc.records.filter(
        (r: any) =>
          decisions[doc.documentId + ":" + r.id]?.disposition !== "excluded"
      ),
      doc.observedAt
    );
  const records = documents.flatMap((doc: any) =>
    doc.records.map((r: GroundedCareerRecord) => ({
      ...r,
      key: doc.documentId + ":" + r.id,
      documentId: doc.documentId,
      review: decisions[doc.documentId + ":" + r.id] ?? null,
    }))
  );
  const issues = documents.flatMap((doc: any) =>
    doc.analysis!.issues.map((issue: any) => ({
      ...issue,
      key: doc.documentId + ":" + issue.id,
      documentId: doc.documentId,
      review: decisions[doc.documentId + ":" + issue.id] ?? null,
    }))
  );
  const groups = new Map<string, any[]>();
  for (const r of records.filter(
    (r: any) =>
      r.supported &&
      r.kind === "employment" &&
      r.review?.disposition !== "excluded" &&
      r.start
  )) {
    const key = JSON.stringify([
      r.title.trim().toLowerCase(),
      r.organization?.trim().toLowerCase() ?? null,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [group, entries] of groups) {
    if (new Set(entries.map(r => r.documentId)).size < 2) continue;
    const differs = (a: any, b: any) =>
      Boolean(
        a &&
          b &&
          (a.precision === "day" && b.precision === "day"
            ? a.iso !== b.iso
            : a.lastMonth < b.firstMonth || b.lastMonth < a.firstMonth)
      );
    const conflicting = entries.some((a: any, i: number) =>
      entries
        .slice(i + 1)
        .some(
          (b: any) =>
            a.documentId !== b.documentId &&
            (differs(a.start, b.start) ||
              differs(a.end, b.end) ||
              a.current !== b.current)
        )
    );
    if (!conflicting) continue;
    const key = "cross_source:" + careerTextHash(group);
    issues.push({
      id: key,
      key,
      kind: "source_conflict",
      recordIds: entries.map(r => r.id),
      recordKeys: entries.map(r => r.key),
      documentId: null,
      explanation:
        "Current CV sources state different dates for the same role and organization. No source was silently chosen as authoritative.",
      question:
        "Which current CV source has the intended employment dates for this role? Please correct or supersede an outdated source; no personal explanation is required.",
      review: decisions[key] ?? null,
    });
  }
  const openIssues = issues.filter(
    (i: any) => !["excluded", "explained"].includes(i.review?.disposition)
  );
  return {
    candidateId: d.candidateId,
    fingerprint: d.fingerprint,
    revision: review?.revision ?? 0,
    sourceSignature,
    documents,
    records,
    issues,
    openIssues,
    reviewCurrent: Boolean(current),
    history: review
      ? {
          revision: review.revision,
          sourceSignature: review.metadata.sourceSignature,
          sourceCurrent: Boolean(current),
        }
      : null,
    suppressed: d.suppressed,
    documentsTruncated: d.documentsTruncated,
    independentlyVerified: false as const,
    finalDisposition: false as const,
  };
}
export async function getCareerEvidence(ownerId: number, candidateId: string) {
  return withWorkspaceTransaction(ownerId, async tx =>
    careerEvidenceInTransaction(
      tx,
      ownerId,
      await candidateEvidenceInTransaction(tx, ownerId, candidateId)
    )
  );
}
export const reviewCareerEvidenceInput = z
  .object({
    candidateId: z.string().min(4).max(36),
    expectedFingerprint: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    sourceSignature: z.string().length(64),
    decisions: z
      .array(
        z
          .object({
            targetId: z.string().min(4).max(200),
            disposition: z.enum([
              "source_checked",
              "needs_clarification",
              "excluded",
              "explained",
            ]),
            note: z.string().trim().min(8).max(2000),
          })
          .strict()
      )
      .min(1)
      .max(30),
    reason: z.string().trim().min(8).max(2000),
  })
  .strict();
export async function reviewCareerEvidence(
  ownerId: number,
  actorId: number,
  raw: z.input<typeof reviewCareerEvidenceInput>
) {
  const input = reviewCareerEvidenceInput.parse(raw),
    requestHash = workflowHash(input);
  return withWorkspaceTransaction(ownerId, async tx => {
    const d = await candidateEvidenceInTransaction(
        tx,
        ownerId,
        input.candidateId
      ),
      c = await careerEvidenceInTransaction(tx, ownerId, d),
      previous = await latest(tx, ownerId, input.candidateId);
    if (
      previous?.revision === input.expectedRevision + 1 &&
      previous.metadata.requestHash === requestHash
    )
      return { revision: previous.revision, alreadySaved: true };
    if (
      c.revision !== input.expectedRevision ||
      d.fingerprint !== input.expectedFingerprint ||
      c.sourceSignature !== input.sourceSignature
    )
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Career source or review changed. Reload the current candidate evidence.",
      });
    if (
      d.suppressed ||
      !(await hasGeneralCandidateProcessingConsent(tx, ownerId, d.candidateId))
    )
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "A current candidate and general processing permission are required for career evidence review.",
      });
    if (
      new Set(input.decisions.map(v => v.targetId)).size !==
      input.decisions.length
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Each source or issue may be reviewed only once per command.",
      });
    const decisions: Record<string, any> = c.reviewCurrent
      ? { ...previous.metadata.decisions }
      : {};
    for (const item of input.decisions) {
      ensureSafeAiText(item.note);
      const record = c.records.find((r: any) => r.key === item.targetId),
        issue = c.issues.find((i: any) => i.key === item.targetId);
      if (!record && !issue)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Review targets must belong to the current exact candidate source.",
        });
      if (
        (item.disposition === "source_checked" &&
          (!record || !record.supported)) ||
        (item.disposition === "explained" &&
          (!issue ||
            ["unsupported", "date_order", "future_date"].includes(issue.kind)))
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This disposition cannot certify unsupported, reversed or future source facts. Correct the source or request clarification.",
        });
      decisions[item.targetId] = {
        disposition: item.disposition,
        note: item.note,
        actorId,
        reviewedAt: new Date().toISOString(),
        independentlyVerified: false,
      };
    }
    await appendWorkflowEvent(
      tx,
      ownerId,
      "candidate.career_reviewed",
      d.candidateId,
      c.revision + 1,
      {
        candidateId: d.candidateId,
        sourceSignature: c.sourceSignature,
        decisions,
        reason: input.reason,
        requestHash,
        actorId,
        independentlyVerified: false,
      }
    );
    await recordCandidateDocumentChange(tx, ownerId, d.candidateId, {
      candidateId: d.candidateId,
      reason: "Career evidence review changed",
      careerReviewRevision: c.revision + 1,
    });
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "candidate.career_reviewed",
        resourceType: "candidate",
        resourceId: d.candidateId,
        metadata: {
          revision: c.revision + 1,
          decisions: input.decisions.length,
          independentlyVerified: false,
        },
      },
      tx
    );
    return { revision: c.revision + 1, alreadySaved: false };
  });
}
export function careerClarificationQuestions(c: any) {
  return c.openIssues
    .filter((issue: any) => issue.question && issue.kind !== "gap")
    .slice(0, 6)
    .map((issue: any) => ({
      id: "career_" + careerTextHash(issue.key).slice(0, 16),
      prompt:
        issue.question +
        " Referenced CV entries: " +
        c.records
          .filter((r: any) =>
            issue.recordKeys
              ? issue.recordKeys.includes(r.key)
              : r.documentId === issue.documentId &&
                issue.recordIds.includes(r.id)
          )
          .map((r: any) => r.title)
          .join("; "),
    }));
}

/** Compact only grounded current statements for inference; original owner view preserves every source. */
export function careerMatchDocument(doc: any, career: any) {
  const evidence = doc.parsedData.careerEvidence;
  if (!evidence) return doc.parsedData;
  const eligible = career.records.filter(
    (r: any) =>
      r.documentId === doc.documentId &&
      r.supported &&
      r.review?.disposition !== "excluded"
  );
  return {
    skills: eligible
      .filter((r: any) => r.kind === "skill")
      .map((r: any) => r.title),
    totalExperienceYears: null,
    careerEvidence: {
      parserVersion: evidence.parserVersion,
      sourceTextHash: evidence.sourceTextHash,
      observedAt: evidence.observedAt,
      records: eligible.slice(0, 8).map((r: any) => ({
        kind: r.kind,
        title: r.title,
        organization: r.organization,
        startText: r.startText,
        endText: r.endText,
        current: r.current,
        quote: r.quote.slice(0, 160),
        independentlyVerified: false,
      })),
      omittedRecords: Math.max(0, eligible.length - 8),
      finalDisposition: false,
      coverageIsNotRelevantExperience: true,
    },
  };
}
