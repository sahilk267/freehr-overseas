import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  candidateDocuments,
  automationQueue,
  candidates,
  consents,
  matches,
  placements,
  rightsRequests,
  workflowEvents,
  workspaceSettings,
} from "../../drizzle/schema";
import * as dbModule from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import {
  groundCareerRecords,
  careerDocumentSourceHash,
  careerEvidenceIntegrity,
} from "./careerExtraction";
import {
  analyzeCareerRecords,
  parseCareerDate,
  type CareerRecord,
} from "../../shared/careerEvidence";
import { getCareerEvidence, reviewCareerEvidence } from "./careerEvidence";
import { recordCareerSource } from "./careerSource";
import { getCandidateEvidence } from "./candidateEvidence";
import { handleAiTaskResult, processOneQueuedJob } from "./queue";
import * as aiRouting from "./aiRouting";
import { buildMatchContext } from "./matchContext";
import {
  createCandidateReview,
  publicCandidateReview,
} from "./candidateReview";
import { supersedeCandidateDocument } from "./documentLifecycle";
const storage = vi.hoisted(() => ({
  read: vi.fn(),
  remove: vi.fn(async () => {}),
}));
vi.mock("./privateStorage", async original => ({
  ...(await original()),
  readPrivateDocument: storage.read,
  deletePrivateDocument: storage.remove,
}));
const observedAt = "2026-11-12T00:00:00.000Z";
const lines = [
  "Engineer at Alpha: Jan 2020 to Dec 2021",
  "Lead at Beta: Jul 2021 to Dec 2022",
  "Consultant at Gamma: Jan 2024 to Present",
  "BSc Computing, University Delta",
  "Cloud Certificate, Issuer Epsilon",
  "TypeScript skill",
];
const text = lines.join("\n");
const base = (patch: Partial<CareerRecord> = {}): CareerRecord => ({
  kind: "employment",
  title: "Engineer",
  organization: "Alpha",
  startText: "Jan 2020",
  endText: "Dec 2021",
  current: false,
  quote: lines[0],
  confidence: 80,
  ...patch,
});
const records = [
  base(),
  base({
    title: "Lead",
    organization: "Beta",
    startText: "Jul 2021",
    endText: "Dec 2022",
    quote: lines[1],
  }),
  base({
    title: "Consultant",
    organization: "Gamma",
    startText: "Jan 2024",
    endText: null,
    current: true,
    quote: lines[2],
  }),
  base({
    kind: "education",
    title: "BSc Computing",
    organization: "University Delta",
    startText: null,
    endText: null,
    quote: lines[3],
  }),
  base({
    kind: "certification",
    title: "Cloud Certificate",
    organization: "Issuer Epsilon",
    startText: null,
    endText: null,
    quote: lines[4],
  }),
  base({
    kind: "skill",
    title: "TypeScript",
    organization: null,
    startText: null,
    endText: null,
    quote: lines[5],
  }),
];
const owners: number[] = [];
beforeEach(() => {
  storage.read.mockReset();
  storage.read.mockResolvedValue(Buffer.from(text));
  storage.remove.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const ownerId of owners.splice(0))
    await (await dbModule.requireDb())
      .update(workspaceSettings)
      .set({ backgroundEnabled: false })
      .where(eq(workspaceSettings.ownerId, ownerId));
});
async function fixture() {
  const f = await followupFixture();
  owners.push(f.ownerId);
  await f.db
    .update(placements)
    .set({ status: "offer_pending" })
    .where(eq(placements.ownerId, f.ownerId));
  const documentId = dbModule.createId("doc_"),
    sha256 = createHash("sha256").update(text).digest("hex");
  await f.db.insert(candidateDocuments).values({
    id: documentId,
    ownerId: f.ownerId,
    candidateId: f.candidateId,
    documentType: "cv",
    originalName: "synthetic-career.txt",
    mimeType: "text/plain",
    storageKey: "synthetic/" + documentId,
    storageUrl: "private://synthetic/" + documentId,
    sizeBytes: Buffer.byteLength(text),
    sha256,
    scanState: "clean",
    parseState: "queued",
  });
  const doc = (
      await f.db
        .select()
        .from(candidateDocuments)
        .where(eq(candidateDocuments.id, documentId))
    )[0],
    source = {
      text,
      observedAt,
      documentSourceHash: careerDocumentSourceHash(doc),
    },
    job = {
      jobType: "parse_cv",
      payload: { documentId, candidateId: f.candidateId },
    } as any;
  await handleAiTaskResult(
    job,
    {
      headline: null,
      skills: ["TypeScript"],
      totalExperienceYears: null,
      recentRoles: [],
      education: [],
      careerRecords: records,
      confidence: 80,
      missingInformation: [],
    },
    "synthetic-free-model",
    f.ownerId,
    f.db,
    source
  );
  return {
    ...f,
    documentId,
    doc,
    source,
    job,
    detail: () => getCareerEvidence(f.ownerId, f.candidateId),
  };
}
const reviewInput = (
  d: any,
  targetId: string,
  disposition = "needs_clarification"
) => ({
  candidateId: d.candidateId,
  expectedFingerprint: d.fingerprint,
  expectedRevision: d.revision,
  sourceSignature: d.sourceSignature,
  decisions: [
    {
      targetId,
      disposition: disposition as "needs_clarification",
      note: "Synthetic owner evidence review, external authenticity unverified.",
    },
  ],
  reason: "Synthetic source chronology review for internal QA.",
});

describe("literal career extraction and date uncertainty", () => {
  it("parses explicit year/month/day precision without guessing ambiguous dates or invalid leap days", () => {
    expect(parseCareerDate("2020")).toMatchObject({
      precision: "year",
      firstMonth: 24240,
      lastMonth: 24251,
    });
    expect(parseCareerDate("Feb 2020")).toMatchObject({
      precision: "month",
      iso: "2020-02",
    });
    expect(parseCareerDate("29 February 2020")).toMatchObject({
      precision: "day",
      iso: "2020-02-29",
    });
    for (const date of [
      "29 February 2021",
      "2020-00",
      "2020-13",
      "01/02/2020",
      "20",
      "last year",
      "2020-02-30",
    ])
      expect(parseCareerDate(date)).toBeNull();
  });
  it("anchors literal UTF-16 source spans, retains model confidence and never fabricates PDF pages", () => {
    const r = groundCareerRecords("🧭\n" + text, records);
    expect(r.every(r => r.supported)).toBe(true);
    expect(r[0].citation).toEqual({
      start: 3,
      end: 3 + lines[0].length,
      unit: "utf16_code_unit",
      page: null,
    });
    expect(r[0].confidence).toBe(80);
  });
  it("rejects hallucinated values, absent/ambiguous quotes and unsupported current-role inference", () => {
    expect(
      groundCareerRecords(text, [base({ title: "Director" })])[0].supported
    ).toBe(false);
    expect(
      groundCareerRecords(text, [base({ quote: "Not in source" })])[0].supported
    ).toBe(false);
    expect(
      groundCareerRecords(text + "\n" + lines[0], [base()])[0].supported
    ).toBe(false);
    expect(
      groundCareerRecords(text, [base({ current: true, endText: null })])[0]
        .supported
    ).toBe(false);
  });
  it("does not certify protected recruitment content or duplicate repeated source entries", () => {
    const quote = "Engineer at Alpha: religion preference";
    expect(
      groundCareerRecords(quote, [
        base({ startText: null, endText: null, quote }),
      ])[0].supported
    ).toBe(false);
    expect(groundCareerRecords(text, [records[0], records[0]])).toHaveLength(1);
  });
  it("combines overlapping roles without double counting and flags only definite intermediate gaps", () => {
    const a = analyzeCareerRecords(
      groundCareerRecords(text, records),
      observedAt
    );
    expect(a.coverageMonths).toMatchObject({ minimum: 71, maximum: 71 });
    expect(a.issues.map(i => i.kind).sort()).toEqual(["gap", "overlap"]);
    expect(a.issues.find(i => i.kind === "gap")!.question).toContain(
      "Personal reasons are not required"
    );
    expect(a.finalDisposition).toBe(false);
  });
  it("preserves year-only uncertainty instead of inventing month/day precision or exact tenure", () => {
    const quote = "Engineer at Alpha: 2020 to 2022",
      a = analyzeCareerRecords(
        groundCareerRecords(quote, [
          base({ startText: "2020", endText: "2022", quote }),
        ]),
        observedAt
      );
    expect(a.coverageMonths).toMatchObject({ minimum: 14, maximum: 36 });
    expect(a.issues).toHaveLength(0);
  });
  it("treats unknown/reversed/future dates as clarification, without inferring age or rejection", () => {
    for (const [startText, endText, kind] of [
      ["2019-01", "2018-01", "date_order"],
      ["2040", "2041", "future_date"],
      ["Spring 2020", "2021", "date_unknown"],
    ]) {
      const quote = `Engineer at Alpha: ${startText} to ${endText}`,
        a = analyzeCareerRecords(
          groundCareerRecords(quote, [base({ startText, endText, quote })]),
          observedAt
        );
      expect(a.issues[0].kind).toBe(kind);
      expect(a.coverageMonths.maximum).toBe(0);
      expect(a.finalDisposition).toBe(false);
    }
  });
  it("does not infer education dates, certification validity or total relevant experience", () => {
    const a = analyzeCareerRecords(
      groundCareerRecords(text, records.slice(3)),
      observedAt
    );
    expect(a.employmentRecords).toBe(0);
    expect(a.coverageMonths.maximum).toBe(0);
    expect(a.issues).toHaveLength(0);
    expect(a.independentlyVerified).toBe(false);
  });
});

describe("candidate career evidence in canonical workflows", () => {
  it("applies only source-bound structured records and leaves the existing candidate profile/disposition unchanged", async () => {
    const f = await fixture(),
      d = await f.detail();
    expect(d.records).toHaveLength(6);
    expect(d.documents[0].model).toBe("synthetic-free-model");
    expect(d.documents[0].analysis.coverageMonths.maximum).toBe(71);
    expect(d.independentlyVerified).toBe(false);
    expect(
      (
        await f.db
          .select()
          .from(candidates)
          .where(eq(candidates.id, f.candidateId))
      )[0].profileState
    ).toBe("consented");
  });
  it("does not accept provider-supplied server provenance or unsupported career records without source context", async () => {
    const f = await fixture();
    await handleAiTaskResult(
      f.job,
      {
        skills: ["TypeScript"],
        careerEvidence: {
          parserVersion: "literal-career-v1",
          records: records,
        },
        careerRecords: records,
      },
      "synthetic",
      f.ownerId,
      f.db
    );
    expect((await f.detail()).documents).toHaveLength(0);
  });
  it("rejects a mismatched candidate/document pair and changed source generation", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      handleAiTaskResult(
        {
          ...f.job,
          payload: { ...f.job.payload, candidateId: other.candidateId },
        },
        { careerRecords: records },
        "synthetic",
        f.ownerId,
        f.db,
        f.source
      )
    ).rejects.toThrow(/no longer eligible/);
    await f.db
      .update(candidateDocuments)
      .set({ sha256: "b".repeat(64) })
      .where(eq(candidateDocuments.id, f.documentId));
    await expect(
      handleAiTaskResult(
        f.job,
        { careerRecords: records },
        "synthetic",
        f.ownerId,
        f.db,
        f.source
      )
    ).rejects.toThrow(/source changed/);
  });
  it("rechecks general processing consent and suppression before accepting an AI result", async () => {
    const f = await fixture();
    await f.db
      .update(consents)
      .set({ status: "withdrawn" })
      .where(eq(consents.ownerId, f.ownerId));
    await expect(
      handleAiTaskResult(
        f.job,
        { careerRecords: records },
        "synthetic",
        f.ownerId,
        f.db,
        f.source
      )
    ).rejects.toThrow(/consent changed/);
  });
  it("isolates owner access and rejects tampering with source evidence", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      getCareerEvidence(other.ownerId, f.candidateId)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const doc = (
        await f.db
          .select()
          .from(candidateDocuments)
          .where(eq(candidateDocuments.id, f.documentId))
      )[0],
      parsed = doc.parsedData as any;
    await f.db
      .update(candidateDocuments)
      .set({
        parsedData: {
          ...parsed,
          careerEvidence: {
            ...parsed.careerEvidence,
            records: parsed.careerEvidence.records.map((r: any, i: number) =>
              i ? r : { ...r, title: "Tampered title" }
            ),
          },
        },
      })
      .where(eq(candidateDocuments.id, f.documentId));
    await expect(f.detail()).rejects.toThrow(/integrity/);
  });
  it("deduplicates a review retry and rejects a stale changed decision", async () => {
    const f = await fixture(),
      d = await f.detail(),
      input = reviewInput(d, d.records[0].key, "source_checked");
    await reviewCareerEvidence(f.ownerId, f.ownerId, input);
    expect(
      await reviewCareerEvidence(f.ownerId, f.ownerId, input)
    ).toMatchObject({ alreadySaved: true });
    await expect(
      reviewCareerEvidence(f.ownerId, f.ownerId, {
        ...input,
        reason: "Different stale review must fail.",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("invalidates current matches and queued matching fingerprints without changing their priority from a career gap", async () => {
    const f = await fixture(),
      before = await buildMatchContext(f.db, f.ownerId, f.candidateId, f.jobId),
      id = dbModule.createId("mat_");
    await f.db.insert(matches).values({
      id,
      ownerId: f.ownerId,
      candidateId: f.candidateId,
      jobId: f.jobId,
      status: "evidence_validated",
      lowConfidence: false,
    });
    const d = await f.detail();
    await reviewCareerEvidence(
      f.ownerId,
      f.ownerId,
      reviewInput(d, d.records[0].key, "source_checked")
    );
    const after = await buildMatchContext(
      f.db,
      f.ownerId,
      f.candidateId,
      f.jobId
    );
    expect(after.candidateFingerprint).not.toBe(before.candidateFingerprint);
    expect(after.assessment.reviewPriority).toBe(
      before.assessment.reviewPriority
    );
    expect(
      (await f.db.select().from(matches).where(eq(matches.id, id)))[0]
        .lowConfidence
    ).toBe(true);
    expect(after.assessment.finalDisposition).toBe(false);
  });
  it("excludes reviewed records from coverage and AI context, while preserving owner history", async () => {
    const f = await fixture(),
      d = await f.detail();
    await reviewCareerEvidence(
      f.ownerId,
      f.ownerId,
      reviewInput(d, d.records[2].key, "excluded")
    );
    const updated = await f.detail();
    expect(updated.records).toHaveLength(6);
    expect(updated.documents[0].analysis.coverageMonths.maximum).toBe(36);
    const context = await buildMatchContext(
      f.db,
      f.ownerId,
      f.candidateId,
      f.jobId
    );
    expect(JSON.stringify(context.payload.candidate.evidence)).not.toContain(
      "Consultant"
    );
  });
  it("allows owner explanation of a gap but cannot certify a reversed/future/unsupported fact", async () => {
    const f = await fixture(),
      d = await f.detail(),
      gap = d.issues.find((i: any) => i.kind === "gap");
    await reviewCareerEvidence(
      f.ownerId,
      f.ownerId,
      reviewInput(d, gap.key, "explained")
    );
    const next = await f.detail();
    expect(next.openIssues.some((i: any) => i.kind === "gap")).toBe(false);
    await expect(
      reviewCareerEvidence(
        f.ownerId,
        f.ownerId,
        reviewInput(next, next.issues[0].key, "source_checked")
      )
    ).rejects.toThrow(/cannot certify/);
  });
  it("adds bounded neutral date questions to the existing candidate-facing questionnaire without asking personal gap reasons", async () => {
    const f = await fixture(),
      created = await createCandidateReview(f.ownerId, f.ownerId, {
        candidateId: f.candidateId,
        jobId: f.jobId,
        requestKey: dbModule.createId("career_"),
        expiresHours: 24,
      }),
      [id, token] = created.fragment!.split("."),
      publicView = await publicCandidateReview({ id, token });
    expect(
      publicView.questions.some(
        q => q.id.startsWith("career_") && q.prompt.includes("concurrent")
      )
    ).toBe(true);
    expect(
      publicView.questions.some(q => q.prompt.includes("Personal reasons"))
    ).toBe(false);
    expect(publicView.identityVerified).toBe(false);
  });
  it("keeps explicit corrections source-grounded and rejects changed bytes", async () => {
    const f = await fixture(),
      before = await getCandidateEvidence(f.ownerId, f.candidateId),
      input = {
        candidateId: f.candidateId,
        documentId: f.documentId,
        expectedFingerprint: before.fingerprint,
        records: [records[0]],
        reason: "Synthetic literal source correction, no factual verification.",
      };
    await recordCareerSource(f.ownerId, f.ownerId, input);
    expect((await f.detail()).documents[0].model).toBe("owner_literal_source");
    const d = await getCandidateEvidence(f.ownerId, f.candidateId);
    storage.read.mockResolvedValue(Buffer.from("tampered"));
    await expect(
      recordCareerSource(f.ownerId, f.ownerId, {
        ...input,
        expectedFingerprint: d.fingerprint,
      })
    ).rejects.toThrow(/bytes differ/);
  });
  it("fences a correction when consent or candidate data changes while reading the private file", async () => {
    const f = await fixture(),
      d = await getCandidateEvidence(f.ownerId, f.candidateId);
    storage.read.mockImplementationOnce(async () => {
      await f.db
        .update(consents)
        .set({ status: "withdrawn" })
        .where(eq(consents.ownerId, f.ownerId));
      return Buffer.from(text);
    });
    await expect(
      recordCareerSource(f.ownerId, f.ownerId, {
        candidateId: f.candidateId,
        documentId: f.documentId,
        expectedFingerprint: d.fingerprint,
        records,
        reason: "Synthetic concurrent source/consent change.",
      })
    ).rejects.toThrow(/permission changed/);
  });
  it("superseding a source drops its career facts and prevents its old review from applying to a replacement", async () => {
    const f = await fixture(),
      d = await f.detail();
    await reviewCareerEvidence(
      f.ownerId,
      f.ownerId,
      reviewInput(d, d.records[0].key, "source_checked")
    );
    const newId = dbModule.createId("doc_");
    await f.db.insert(candidateDocuments).values({
      ...f.doc,
      id: newId,
      storageKey: "synthetic/" + newId,
      storageUrl: "private://synthetic/" + newId,
      parseState: "parsed",
      parsedData: { skills: ["TypeScript"] },
    });
    const p = await getCandidateEvidence(f.ownerId, f.candidateId);
    await supersedeCandidateDocument(f.ownerId, f.ownerId, {
      oldDocumentId: f.documentId,
      newDocumentId: newId,
      expectedFingerprint: p.fingerprint,
      reason: "Synthetic current replacement for career provenance QA.",
    });
    const current = await f.detail();
    expect(current.documents).toHaveLength(0);
    expect(current.reviewCurrent).toBe(false);
  });
  it("does not reuse unsupported model experience or uncited legacy skills when grounded records exist", async () => {
    const f = await fixture(),
      doc = (
        await f.db
          .select()
          .from(candidateDocuments)
          .where(eq(candidateDocuments.id, f.documentId))
      )[0];
    await f.db
      .update(candidateDocuments)
      .set({
        parsedData: {
          ...doc.parsedData,
          totalExperienceYears: 50,
          skills: ["InventedSkill"],
        },
      })
      .where(eq(candidateDocuments.id, f.documentId));
    const c = await buildMatchContext(f.db, f.ownerId, f.candidateId, f.jobId);
    expect(c.payload.candidate.experienceYears).toBe(null);
    expect(c.payload.candidate.skills).toEqual(["TypeScript"]);
    expect(JSON.stringify(c.payload)).not.toContain("InventedSkill");
  });
  it("reuses an identical literal correction without reading the file or creating duplicate source versions", async () => {
    const f = await fixture(),
      d = await getCandidateEvidence(f.ownerId, f.candidateId),
      input = {
        candidateId: f.candidateId,
        documentId: f.documentId,
        expectedFingerprint: d.fingerprint,
        records: [records[0]],
        reason: "Synthetic idempotent literal career correction.",
      };
    await recordCareerSource(f.ownerId, f.ownerId, input);
    storage.read.mockClear();
    expect(await recordCareerSource(f.ownerId, f.ownerId, input)).toMatchObject(
      { alreadySaved: true }
    );
    expect(storage.read).not.toHaveBeenCalled();
    const rows = await f.db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, f.ownerId),
          eq(workflowEvents.eventType, "candidate.career_source_recorded")
        )
      );
    expect(rows).toHaveLength(1);
  });
  it("fences a late AI result after an owner corrects the same CV source", async () => {
    const f = await fixture(),
      current = (
        await f.db
          .select()
          .from(candidateDocuments)
          .where(eq(candidateDocuments.id, f.documentId))
      )[0],
      source = {
        ...f.source,
        documentSourceHash: careerDocumentSourceHash(current),
      },
      d = await getCandidateEvidence(f.ownerId, f.candidateId);
    await recordCareerSource(f.ownerId, f.ownerId, {
      candidateId: f.candidateId,
      documentId: f.documentId,
      expectedFingerprint: d.fingerprint,
      records: [records[0]],
      reason: "Synthetic reviewed correction before queued AI completion.",
    });
    await expect(
      handleAiTaskResult(
        f.job,
        { careerRecords: records },
        "synthetic",
        f.ownerId,
        f.db,
        source
      )
    ).rejects.toThrow(/source changed/);
    expect((await f.detail()).records).toHaveLength(1);
  });
  it("shows conflicting dates from two current CVs without silently preferring one source", async () => {
    const f = await fixture(),
      id = dbModule.createId("doc_"),
      changedText = text.replace("Jan 2020", "Jan 2019"),
      changedRecords = records.map((r, i) =>
        i
          ? r
          : {
              ...r,
              startText: "Jan 2019",
              quote: lines[0].replace("Jan 2020", "Jan 2019"),
            }
      );
    await f.db.insert(candidateDocuments).values({
      ...f.doc,
      id,
      storageKey: "synthetic/" + id,
      storageUrl: "private://synthetic/" + id,
      sha256: createHash("sha256").update(changedText).digest("hex"),
    });
    const doc = (
      await f.db
        .select()
        .from(candidateDocuments)
        .where(eq(candidateDocuments.id, id))
    )[0];
    await handleAiTaskResult(
      { ...f.job, payload: { candidateId: f.candidateId, documentId: id } },
      { careerRecords: changedRecords },
      "synthetic",
      f.ownerId,
      f.db,
      {
        text: changedText,
        observedAt,
        documentSourceHash: careerDocumentSourceHash(doc),
      }
    );
    const d = await f.detail();
    expect(d.openIssues.some((i: any) => i.kind === "source_conflict")).toBe(
      true
    );
    expect(d.documents).toHaveLength(2);
  });
  it("recovers a clean failed CV without another provider request and cancels unused parsing work", async () => {
    const f = await fixture(),
      id = dbModule.createId("que_");
    await f.db
      .update(candidateDocuments)
      .set({ parseState: "failed" })
      .where(eq(candidateDocuments.id, f.documentId));
    await f.db
      .insert(automationQueue)
      .values({
        id,
        ownerId: f.ownerId,
        jobType: "parse_cv",
        status: "queued",
        payload: { candidateId: f.candidateId, documentId: f.documentId },
        idempotencyKey: "parse_cv:" + f.documentId,
      });
    const d = await getCandidateEvidence(f.ownerId, f.candidateId);
    await recordCareerSource(f.ownerId, f.ownerId, {
      candidateId: f.candidateId,
      documentId: f.documentId,
      expectedFingerprint: d.fingerprint,
      records,
      reason:
        "Synthetic literal recovery while provider extraction is unavailable.",
    });
    expect((await f.detail()).records).toHaveLength(6);
    expect(
      (
        await f.db
          .select()
          .from(candidateDocuments)
          .where(eq(candidateDocuments.id, f.documentId))
      )[0].parseState
    ).toBe("parsed");
    expect(
      (
        await f.db
          .select()
          .from(automationQueue)
          .where(eq(automationQueue.id, id))
      )[0].status
    ).toBe("cancelled");
  });
  it("does not downgrade a successful owner recovery when a stale in-flight AI task later fails", async () => {
    const f = await fixture(),
      id = dbModule.createId("que_");
    await f.db
      .update(candidateDocuments)
      .set({ parseState: "queued" })
      .where(eq(candidateDocuments.id, f.documentId));
    await f.db
      .insert(automationQueue)
      .values({
        id,
        ownerId: f.ownerId,
        jobType: "parse_cv",
        status: "queued",
        payload: { candidateId: f.candidateId, documentId: f.documentId },
        idempotencyKey: "parse_cv:" + f.documentId,
        scheduledAt: new Date(Date.now() - 1000),
        attempts: 0,
        maxAttempts: 3,
      });
    vi.spyOn(aiRouting, "runControlledAiTask").mockImplementation(async () => {
      const d = await getCandidateEvidence(f.ownerId, f.candidateId);
      await recordCareerSource(f.ownerId, f.ownerId, {
        candidateId: f.candidateId,
        documentId: f.documentId,
        expectedFingerprint: d.fingerprint,
        records: [records[0]],
        reason:
          "Synthetic owner recovery while previous provider request is in flight.",
      });
      return {
        result: { skills: [], careerRecords: records },
        selectedModel: "synthetic-free-model",
        latencyMs: 1,
      } as any;
    });
    expect((await processOneQueuedJob(f.ownerId)).status).toBe(
      "permanently_failed"
    );
    const doc = (
      await f.db
        .select()
        .from(candidateDocuments)
        .where(eq(candidateDocuments.id, f.documentId))
    )[0];
    expect(doc.parseState).toBe("parsed");
    expect((await f.detail()).records).toHaveLength(1);
    expect((doc.parsedData as any).careerEvidence.model).toBe(
      "owner_literal_source"
    );
  });
  it("does not call compatible year-only and month-specific dates a cross-source conflict", async () => {
    const f = await fixture(),
      id = dbModule.createId("doc_"),
      changedText = text.replace("Jan 2020", "2020"),
      changedRecords = records.map((r, i) =>
        i
          ? r
          : {
              ...r,
              startText: "2020",
              quote: lines[0].replace("Jan 2020", "2020"),
            }
      );
    await f.db
      .insert(candidateDocuments)
      .values({
        ...f.doc,
        id,
        storageKey: "synthetic/" + id,
        storageUrl: "private://synthetic/" + id,
        sha256: createHash("sha256").update(changedText).digest("hex"),
      });
    const doc = (
      await f.db
        .select()
        .from(candidateDocuments)
        .where(eq(candidateDocuments.id, id))
    )[0];
    await handleAiTaskResult(
      { ...f.job, payload: { candidateId: f.candidateId, documentId: id } },
      { careerRecords: changedRecords },
      "synthetic",
      f.ownerId,
      f.db,
      {
        text: changedText,
        observedAt,
        documentSourceHash: careerDocumentSourceHash(doc),
      }
    );
    expect(
      (await f.detail()).openIssues.some(
        (i: any) => i.kind === "source_conflict"
      )
    ).toBe(false);
  });
  it("redacts career quotations and review notes during candidate erasure", async () => {
    const f = await fixture(),
      d = await f.detail();
    await reviewCareerEvidence(
      f.ownerId,
      f.ownerId,
      reviewInput(d, d.records[0].key, "source_checked")
    );
    const requestId = dbModule.createId("rights_");
    await f.db.insert(rightsRequests).values({
      id: requestId,
      ownerId: f.ownerId,
      candidateId: f.candidateId,
      requestType: "deletion",
      status: "received",
    });
    await f.caller.recruitment.candidateWorkflows.privacy.fulfillDeletion({
      requestId,
      resolutionNote:
        "Erase synthetic career evidence source and owner review.",
    });
    expect(
      (
        await f.db
          .select()
          .from(candidateDocuments)
          .where(eq(candidateDocuments.id, f.documentId))
      )[0].parsedData
    ).toBeNull();
    const rows = await f.db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, f.ownerId),
          eq(workflowEvents.eventType, "candidate.career_reviewed")
        )
      );
    expect(rows.every(r => (r.metadata as any).redacted)).toBe(true);
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")(
    "serializes competing reviews and rolls back source review if audit fails",
    async () => {
      const f = await fixture(),
        d = await f.detail(),
        input = reviewInput(d, d.records[0].key, "source_checked"),
        results = await Promise.allSettled([
          reviewCareerEvidence(f.ownerId, f.ownerId, input),
          reviewCareerEvidence(f.ownerId, f.ownerId, {
            ...input,
            reason: "A competing different source decision.",
          }),
        ]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const next = await f.detail(),
        original = dbModule.recordAudit;
      vi.spyOn(dbModule, "recordAudit").mockImplementation(async (p, tx) => {
        if (p.action === "candidate.career_reviewed")
          throw Error("Synthetic career audit failure");
        return original(p, tx);
      });
      await expect(
        reviewCareerEvidence(
          f.ownerId,
          f.ownerId,
          reviewInput(next, next.records[1].key, "source_checked")
        )
      ).rejects.toThrow(/audit failure/);
      expect((await f.detail()).revision).toBe(next.revision);
    }
  );
});
