import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import {
  marketBatch,
  marketObservation,
  publicEvidenceUrl,
  type MarketPermission,
} from "../../shared/marketEvidence";
import {
  configureMarketPermission,
  marketPermissions,
  previewMarketBatch,
  recordMarketBatch,
  processMarketWebhook,
  marketOverview,
  marketContextInTransaction,
  marketBatchHistory,
  marketSignalHistory,
  retireMarketSignal,
} from "./marketEvidence";
import {
  createIntakeSource,
  controlIntakeSource,
  processIntakeWebhook,
} from "./sourceIntake";
import {
  saveRecruitmentStrategy,
  recruitmentStrategyDashboard,
} from "./recruitmentStrategy";
import { ownerOverview } from "./ownerBrief";
import { followupFixture } from "../testSupport/followupFixture";
import { createId, requireDb } from "../db";
const day = 86400000,
  owners: number[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const ownerId of owners.splice(0))
    await (await requireDb())
      .update(schema.workspaceSettings)
      .set({ backgroundEnabled: false })
      .where(eq(schema.workspaceSettings.ownerId, ownerId));
});
const permissionFields = (
  changes: Partial<MarketPermission> = {}
): MarketPermission => ({
  enabled: true,
  allowedKinds: [
    "hiring_demand",
    "salary_benchmark",
    "competition",
    "seasonality",
  ],
  authorizedUse: "internal_recruitment_planning",
  basis: "provider_contract",
  reference:
    "Synthetic owner-declared permission only, no external verification.",
  termsUrl: "https://source.example.test/terms",
  validFrom: new Date(Date.now() - 60 * day).toISOString(),
  validUntil: new Date(Date.now() + 60 * day).toISOString(),
  maxAgeDays: 30,
  ...changes,
});
async function fixture(
  configured = true,
  kind: "candidate" | "prospect" = "prospect"
) {
  const f = await followupFixture();
  owners.push(f.ownerId);
  await f.db
    .update(schema.workspaceSettings)
    .set({ backgroundEnabled: false })
    .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
  const domain = `market-${f.ownerId}.example.test`;
  await f.db
    .update(schema.companies)
    .set({ domain })
    .where(eq(schema.companies.id, f.companyId));
  const registered = await createIntakeSource(f.ownerId, f.ownerId, {
      requestKey: createId("mkreq_"),
      name: "Synthetic market research source",
      kind,
    }),
    sourceId = registered.source.id,
    token = registered.token!;
  const configure = async (
    fields: MarketPermission = permissionFields(),
    reason = "Record synthetic declared market-use rights."
  ) => {
    const p = (await marketPermissions(f.ownerId)).find(
      s => s.source.id === sourceId
    );
    return configureMarketPermission(f.ownerId, f.ownerId, {
      sourceId,
      expectedRevision: p?.permission.revision ?? 0,
      fields,
      reason,
    });
  };
  if (configured) await configure();
  const record = {
    externalKey: "record-A",
    revision: 1,
    companyDomain: domain,
    roleFamily: "Backend engineering",
    region: "India",
    industry: "Software",
    observedAt: new Date(Date.now() - 10000).toISOString(),
    sourceUrl: "https://source.example.test/research",
    kind: "hiring_demand" as const,
    openings: 2,
  };
  const batch = {
    batchKey: createId("mkbatch_"),
    permissionRevision: 1,
    records: [record],
  };
  const receive = (body: unknown = batch, key: string = token) =>
    processMarketWebhook({ sourceId, authorization: `Bearer ${key}`, body });
  return { ...f, domain, sourceId, token, record, batch, receive, configure };
}
async function ownerRecord(f: any, batch = f.batch) {
  const p = await previewMarketBatch(f.ownerId, f.sourceId, batch);
  return recordMarketBatch(f.ownerId, f.sourceId, batch, p.previewHash);
}
async function events(f: any, type: string) {
  return f.db
    .select()
    .from(schema.workflowEvents)
    .where(
      and(
        eq(schema.workflowEvents.ownerId, f.ownerId),
        eq(schema.workflowEvents.eventType, type)
      )
    );
}
describe("structured market observation schema and minimized provenance", () => {
  it.each([
    "http://source.example.test/research",
    "https://source.example.test/research?token=private",
    "https://user:pass@source.example.test/research",
    "https://source.example.test/research#credential",
    "https://127.0.0.1/research",
    "https://localhost./research",
    "https://a.internal./research",
    "https://source.example.test:8443/research",
  ])("rejects unsafe or credential-bearing citation %s", url => {
    expect(publicEvidenceUrl.safeParse(url).success).toBe(false);
  });
  it("rejects contact/profile fields, fake verification and invalid salary assumptions", async () => {
    const f = await fixture();
    for (const change of [
      { email: "person@example.test" },
      { verified: true },
      {
        kind: "salary_benchmark",
        currency: "ZZZ",
        minMinor: "100",
        maxMinor: "10",
        period: "monthly",
        sampleSize: 0,
        statistic: "survey_range",
      },
    ])
      expect(
        marketObservation.safeParse({ ...f.record, ...change }).success
      ).toBe(false);
  });
  it("requires honest revision ancestry and unique external keys within a bounded batch", async () => {
    const f = await fixture();
    expect(
      marketObservation.safeParse({
        ...f.record,
        previousDigest: "0".repeat(64),
      }).success
    ).toBe(false);
    expect(
      marketObservation.safeParse({ ...f.record, revision: 2 }).success
    ).toBe(false);
    expect(
      marketBatch.safeParse({ ...f.batch, records: [f.record, f.record] })
        .success
    ).toBe(false);
    expect(
      marketBatch.safeParse({ ...f.batch, records: Array(51).fill(f.record) })
        .success
    ).toBe(false);
  });
});
describe("existing intake identity with separately scoped market-use declarations", () => {
  it("rejects unsigned/unknown/wrong keys before exposing batch schema or source details", async () => {
    const f = await fixture();
    for (const authorization of [
      undefined,
      "Bearer wrong",
      "Basic private",
      "Bearer " + "a".repeat(43),
    ])
      expect(
        (
          await processMarketWebhook({
            sourceId: f.sourceId,
            authorization,
            body: { private: "not valid" },
          })
        ).statusCode
      ).toBe(401);
    expect(
      (
        await processMarketWebhook({
          sourceId: "unknown-source",
          authorization: "Bearer " + f.token,
          body: f.batch,
        })
      ).statusCode
    ).toBe(401);
  });
  it("requires a current explicit market-use declaration even with a valid existing source key", async () => {
    const f = await fixture(false);
    expect((await f.receive()).statusCode).toBe(412);
    expect(await events(f, "market.signal")).toHaveLength(0);
  });
  it("does not retrofit new permission gates onto the existing canonical intake route", async () => {
    const f = await fixture(false);
    const result = await processIntakeWebhook({
      sourceId: f.sourceId,
      authorization: "Bearer " + f.token,
      body: {
        batchKey: createId("legacy_"),
        kind: "prospect",
        records: [
          {
            externalKey: "legacy-company",
            name: "Existing canonical source path",
            domain: "legacy-" + f.ownerId + ".example.test",
          },
        ],
      },
    });
    expect(result.statusCode).toBe(200);
    expect((result.body as any).results[0].status).toBe("created");
  });
  it("cannot authorize a candidate source for employer market evidence", async () => {
    const f = await fixture(false, "candidate");
    await expect(
      configureMarketPermission(f.ownerId, f.ownerId, {
        sourceId: f.sourceId,
        expectedRevision: 0,
        fields: permissionFields(),
        reason: "Must not expand a candidate source's purpose.",
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await f.receive()).statusCode).toBe(412);
  });
  it("records exact permission retries once and protects competing stale edits", async () => {
    const f = await fixture(false),
      fields = permissionFields(),
      input = {
        sourceId: f.sourceId,
        expectedRevision: 0,
        fields,
        reason: "Exact synthetic source-use declaration.",
      };
    await configureMarketPermission(f.ownerId, f.ownerId, input);
    expect(
      await configureMarketPermission(f.ownerId, f.ownerId, input)
    ).toMatchObject({ alreadySaved: true, revision: 1 });
    await expect(
      configureMarketPermission(f.ownerId, f.ownerId, {
        ...input,
        fields: { ...fields, maxAgeDays: 5 },
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await events(f, "market.permission")).toHaveLength(1);
  });
  it("never returns a source bearer key/hash through permission or market read models", async () => {
    const f = await fixture();
    const text = JSON.stringify(await marketPermissions(f.ownerId));
    expect(text).not.toContain(f.token);
    expect(text).not.toContain("tokenHash");
    expect(
      (await marketPermissions(f.ownerId))[0].declarationVerifiedExternally
    ).toBe(false);
  });
  it("rechecks key rotation and disable while preserving the original observation's reported provenance", async () => {
    const f = await fixture();
    await f.receive();
    const rotated = await controlIntakeSource(f.ownerId, f.ownerId, {
      id: f.sourceId,
      expectedRevision: 1,
      action: "rotate_key",
    });
    expect((await f.receive()).statusCode).toBe(401);
    expect((await f.receive(f.batch, rotated.token!)).statusCode).toBe(200);
    expect((await marketOverview(f.ownerId)).summary.usableRecords).toBe(1);
    await controlIntakeSource(f.ownerId, f.ownerId, {
      id: f.sourceId,
      expectedRevision: 2,
      action: "disable",
    });
    expect((await f.receive(f.batch, rotated.token!)).statusCode).toBe(401);
    const c = await marketOverview(f.ownerId);
    expect(c.summary.usableRecords).toBe(0);
    expect(c.records[0].fields).toBeNull();
  });
  it("keeps source keys scoped to their actual workspace and source", async () => {
    const a = await fixture(),
      b = await fixture();
    expect(
      (
        await processMarketWebhook({
          sourceId: b.sourceId,
          authorization: "Bearer " + a.token,
          body: a.batch,
        })
      ).statusCode
    ).toBe(401);
    await expect(
      previewMarketBatch(b.ownerId, a.sourceId, a.batch)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
describe("automatic authenticated research intake, revision chains and truthful receipts", () => {
  it("accepts source reports against the canonical account without changing recruiting/contact/financial state", async () => {
    const f = await fixture(),
      before = (
        await f.db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, f.companyId))
      )[0],
      result = await f.receive();
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ newlyAccepted: 1, receiptOnly: false });
    const c = await marketOverview(f.ownerId);
    expect(c.summary).toMatchObject({
      usableRecords: 1,
      accountsWithEvidence: 1,
      accountsNeedingQualification: 1,
      licenseVerification: "owner_declaration_only",
      contactAuthorityGranted: false,
    });
    expect(c.records[0]).toMatchObject({
      companyId: f.companyId,
      admission: "authenticated_source",
      evidenceLevel: "source_reported",
      licenseVerifiedExternally: false,
    });
    expect(c.opportunities[0]).toMatchObject({
      agencyOpenness: "unverified",
      paymentReliability: "unverified",
      state: "reported_demand_needs_qualification",
    });
    expect(
      (
        await f.db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, f.companyId))
      )[0]
    ).toEqual(before);
    expect(
      await f.db
        .select()
        .from(schema.automationQueue)
        .where(eq(schema.automationQueue.ownerId, f.ownerId))
    ).toHaveLength(0);
    expect(
      await f.db
        .select()
        .from(schema.emailDispatches)
        .where(eq(schema.emailDispatches.ownerId, f.ownerId))
    ).toHaveLength(0);
  });
  it("distinguishes owner review from machine submission and binds the exact reviewed preview", async () => {
    const f = await fixture(),
      p = await previewMarketBatch(f.ownerId, f.sourceId, f.batch);
    await expect(
      recordMarketBatch(f.ownerId, f.sourceId, f.batch, "0".repeat(64))
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await recordMarketBatch(f.ownerId, f.sourceId, f.batch, p.previewHash);
    expect((await marketOverview(f.ownerId)).records[0].admission).toBe(
      "owner_review"
    );
  });
  it("deduplicates original receipts, reports newlyAccepted zero on replay, and reuses a record in a new batch", async () => {
    const f = await fixture(),
      one = await f.receive(),
      two = await f.receive();
    expect(two.body).toMatchObject({
      id: (one.body as any).id,
      alreadyProcessed: true,
      receiptOnly: true,
      newlyAccepted: 0,
    });
    const third = await f.receive({ ...f.batch, batchKey: createId("batch_") });
    expect((third.body as any).results[0].status).toBe("reused");
    expect((third.body as any).newlyAccepted).toBe(0);
    expect(await events(f, "market.signal")).toHaveLength(1);
    expect(await events(f, "market.batch_received")).toHaveLength(2);
    expect((await marketBatchHistory(f.ownerId)).items).toHaveLength(2);
  });
  it("rejects changed batch content and holds same-revision observation conflicts without overwriting facts", async () => {
    const f = await fixture();
    await f.receive();
    const records = [{ ...f.record, openings: 99 }];
    expect((await f.receive({ ...f.batch, records })).statusCode).toBe(409);
    const changed = await f.receive({
      ...f.batch,
      batchKey: createId("batch_"),
      records,
    });
    expect((changed.body as any).results[0]).toMatchObject({
      status: "conflict",
      reason: "same_revision_different_content",
    });
    expect((await marketOverview(f.ownerId)).records[0].fields.openings).toBe(
      2
    );
  });
  it("keeps raw external record identifiers out of all stored payloads", async () => {
    const f = await fixture();
    await f.receive({
      ...f.batch,
      records: [
        { ...f.record, externalKey: "DO_NOT_PERSIST_RAW_EXTERNAL_IDENTIFIER" },
      ],
    });
    const rows = await f.db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.ownerId, f.ownerId));
    expect(JSON.stringify(rows)).not.toContain(
      "DO_NOT_PERSIST_RAW_EXTERNAL_IDENTIFIER"
    );
  });
  it("preserves corrections and derives only same-source, same-scope, elapsed reported snapshot change", async () => {
    const f = await fixture(),
      first = await f.receive(),
      previousDigest = (first.body as any).results[0].digest;
    const record = {
      ...f.record,
      revision: 2,
      previousDigest,
      observedAt: new Date(
        new Date(f.record.observedAt).getTime() + 1000
      ).toISOString(),
      openings: 5,
    };
    const second = await f.receive({
      ...f.batch,
      batchKey: createId("batch_"),
      records: [record],
    });
    expect((second.body as any).newlyAccepted).toBe(1);
    const c = await marketOverview(f.ownerId);
    expect(c.records[0].reportedOpeningsChange).toBe(3);
    const h = await marketSignalHistory(f.ownerId, c.records[0].id);
    expect(h.items.map(i => i.revision)).toEqual([2, 1]);
    expect(h.items[1].fields.openings).toBe(2);
  });
  it("does not call same-instant corrections or changed scope a temporal market trend", async () => {
    const f = await fixture();
    const first = await f.receive();
    const corrected = {
      ...f.record,
      revision: 2,
      previousDigest: (first.body as any).results[0].digest,
      openings: 5,
    };
    await f.receive({
      ...f.batch,
      batchKey: createId("batch_"),
      records: [corrected],
    });
    expect(
      (await marketOverview(f.ownerId)).records[0].reportedOpeningsChange
    ).toBeNull();
  });
  it("holds revision gaps, wrong predecessor digests and backwards observation time", async () => {
    const f = await fixture(),
      first = await f.receive(),
      digest = (first.body as any).results[0].digest;
    for (const change of [
      { revision: 3, previousDigest: digest },
      { revision: 2, previousDigest: "0".repeat(64) },
      {
        revision: 2,
        previousDigest: digest,
        observedAt: new Date(
          new Date(f.record.observedAt).getTime() - 1000
        ).toISOString(),
      },
    ]) {
      const r = await f.receive({
        ...f.batch,
        batchKey: createId("batch_"),
        records: [{ ...f.record, ...change }],
      });
      expect((r.body as any).results[0].status).toBe("conflict");
    }
    expect(await events(f, "market.signal")).toHaveLength(1);
  });
  it("holds orphan correction revisions and rejects invented root ancestry", async () => {
    const f = await fixture();
    const r = await f.receive({
      ...f.batch,
      records: [{ ...f.record, revision: 2, previousDigest: "0".repeat(64) }],
    });
    expect((r.body as any).results[0]).toMatchObject({
      status: "conflict",
      reason: "initial_revision_must_be_one",
    });
    expect(
      (
        await f.receive({
          ...f.batch,
          batchKey: createId(),
          records: [{ ...f.record, previousDigest: "0".repeat(64) }],
        })
      ).statusCode
    ).toBe(400);
  });
  it("holds missing/ambiguous accounts without creating companies or retaining unlinked raw source facts", async () => {
    const f = await fixture();
    const r = await f.receive({
      ...f.batch,
      records: [
        {
          ...f.record,
          companyDomain: "not-imported.example.test",
          sourceUrl: "https://source.example.test/do-not-retain-unlinked-facts",
        },
      ],
    });
    expect((r.body as any).results[0]).toMatchObject({
      status: "held",
      reason: "company_not_imported",
    });
    expect(await events(f, "market.signal")).toHaveLength(0);
    expect(
      JSON.stringify(await events(f, "market.batch_received"))
    ).not.toContain("do-not-retain-unlinked-facts");
    expect(
      await f.db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.ownerId, f.ownerId))
    ).toHaveLength(1);
  });
  it("normalizes existing account domains and masks facts if a new legacy alias makes the identity ambiguous", async () => {
    const f = await fixture();
    await f.receive({
      ...f.batch,
      records: [
        {
          ...f.record,
          companyDomain: "https://www." + f.domain.toUpperCase() + "/careers",
        },
      ],
    });
    expect((await marketOverview(f.ownerId)).summary.usableRecords).toBe(1);
    await f.db.insert(schema.companies).values({
      id: createId("cmp_"),
      ownerId: f.ownerId,
      name: "Legacy ambiguous alias",
      domain: "https://www." + f.domain + "/",
    });
    const c = await marketOverview(f.ownerId);
    expect(c.records[0]).toMatchObject({
      usable: false,
      issue: "ambiguous_company_domain",
      fields: null,
    });
    expect(
      (await marketSignalHistory(f.ownerId, c.records[0].id)).items[0].fields
    ).toBeNull();
  });
  it("requires a fresh preview after account-state changes and hides prior source fields after suppression", async () => {
    const f = await fixture(),
      p = await previewMarketBatch(f.ownerId, f.sourceId, f.batch);
    await f.db
      .update(schema.companies)
      .set({ pipelineState: "suppressed" })
      .where(eq(schema.companies.id, f.companyId));
    await expect(
      recordMarketBatch(f.ownerId, f.sourceId, f.batch, p.previewHash)
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await events(f, "market.signal")).toHaveLength(0);
  });
  it("invalidates a canonical domain change and does not reassign the observation to a different account automatically", async () => {
    const f = await fixture();
    await f.receive();
    await f.db
      .update(schema.companies)
      .set({ domain: "changed-" + f.domain })
      .where(eq(schema.companies.id, f.companyId));
    const c = await marketOverview(f.ownerId);
    expect(c.records[0]).toMatchObject({
      usable: false,
      issue: "canonical_domain_changed",
      fields: null,
    });
    expect(c.opportunities).toHaveLength(0);
  });
  it("permanently retires exact source records; old and new-batch replays cannot restore usability", async () => {
    const f = await fixture();
    await f.receive();
    const row = (await marketOverview(f.ownerId)).records[0],
      input = {
        id: row.id,
        expectedRevision: row.revision,
        reason: "Retire this synthetic source observation permanently.",
      };
    await retireMarketSignal(f.ownerId, f.ownerId, input);
    expect(await retireMarketSignal(f.ownerId, f.ownerId, input)).toMatchObject(
      { alreadyRetired: true }
    );
    const replay = await f.receive({
      ...f.batch,
      batchKey: createId("batch_"),
    });
    expect((replay.body as any).results[0]).toMatchObject({
      status: "held",
      reason: "permanently_retired",
    });
    expect((await marketOverview(f.ownerId)).summary.usableRecords).toBe(0);
    expect(
      (await marketSignalHistory(f.ownerId, row.id)).items.every(
        i => i.fields === null
      )
    ).toBe(true);
  });
  it("revokes current use on permission changes and accepts a new permission-bound source revision only", async () => {
    const f = await fixture(),
      first = await f.receive(),
      digest = (first.body as any).results[0].digest;
    await f.configure(
      permissionFields(),
      "Refresh the explicit synthetic source-use declaration."
    );
    expect((await f.receive()).statusCode).toBe(409);
    let c = await marketOverview(f.ownerId);
    expect(c.records[0]).toMatchObject({
      issue: "permission_version_changed",
      fields: null,
    });
    await f.receive({
      ...f.batch,
      batchKey: createId("batch_"),
      permissionRevision: 2,
      records: [
        { ...f.record, revision: 2, previousDigest: digest, openings: 3 },
      ],
    });
    c = await marketOverview(f.ownerId);
    expect(c.summary.usableRecords).toBe(1);
    expect(c.records[0].reportedOpeningsChange).toBeNull();
    const h = await marketSignalHistory(f.ownerId, c.records[0].id);
    expect(h.items[1].fields).toBeNull();
  });
  it("holds stale/future observations and permissions that have not started or expired", async () => {
    const f = await fixture();
    for (const change of [
      { observedAt: new Date(Date.now() + 60000).toISOString() },
      { observedAt: new Date(Date.now() - 40 * day).toISOString() },
    ]) {
      const r = await f.receive({
        ...f.batch,
        batchKey: createId("batch_"),
        records: [{ ...f.record, ...change }],
      });
      expect((r.body as any).results[0].status).toBe("held");
    }
    await f.receive();
    const expired = await marketContextInTransaction(
      f.db,
      f.ownerId,
      new Date(Date.now() + 61 * day)
    );
    expect(expired.records[0]).toMatchObject({
      issue: "permission_expired",
      fields: null,
    });
    await f.configure(
      permissionFields({ validFrom: new Date(Date.now() + day).toISOString() })
    );
    expect(
      (await f.receive({ ...f.batch, permissionRevision: 2 })).statusCode
    ).toBe(412);
  });
  it("hides stale observations on current read even while their permission remains valid", async () => {
    const f = await fixture();
    await f.receive();
    const c = await marketContextInTransaction(
      f.db,
      f.ownerId,
      new Date(Date.now() + 31 * day)
    );
    expect(c.records[0]).toMatchObject({
      issue: "observation_stale",
      fields: null,
    });
  });
  it("only permits declared observation kinds and does not treat future seasonality as observed history", async () => {
    const f = await fixture();
    await f.configure(permissionFields({ allowedKinds: ["salary_benchmark"] }));
    let r = await f.receive({ ...f.batch, permissionRevision: 2 });
    expect((r.body as any).results[0].reason).toBe("kind_not_permitted");
    await f.configure();
    r = await f.receive({
      ...f.batch,
      batchKey: createId("batch_"),
      permissionRevision: 3,
      records: [
        {
          externalKey: "future-season",
          revision: 1,
          companyDomain: f.domain,
          roleFamily: f.record.roleFamily,
          region: f.record.region,
          industry: f.record.industry,
          observedAt: f.record.observedAt,
          sourceUrl: f.record.sourceUrl,
          kind: "seasonality",
          periodStart: f.record.observedAt.slice(0, 10),
          periodEnd: new Date(Date.now() + day).toISOString().slice(0, 10),
          relativeTo: "previous_period",
          demandIndexBps: 11000,
        },
      ],
    });
    expect((r.body as any).results[0].reason).toBe("unobserved_future_period");
  });
  it("retains large source salary values, periods, currencies and sample sizes without pooled or converted totals", async () => {
    const f = await fixture();
    const { openings: _open, ...base } = f.record;
    const r = await f.receive({
      ...f.batch,
      records: [
        {
          ...base,
          externalKey: "salary-INR",
          kind: "salary_benchmark",
          currency: "INR",
          minMinor: "999999999999998",
          maxMinor: "999999999999999",
          period: "annual",
          sampleSize: 5,
          statistic: "survey_range",
        },
        {
          ...base,
          externalKey: "salary-USD",
          kind: "salary_benchmark",
          currency: "USD",
          minMinor: "500000",
          maxMinor: "900000",
          period: "monthly",
          sampleSize: 1,
          statistic: "advertised_range",
        },
      ],
    });
    expect((r.body as any).newlyAccepted).toBe(2);
    const c = await marketOverview(f.ownerId);
    expect(c.summary.byKind.salary_benchmark).toBe(2);
    expect(c.records.map(r => r.fields.currency).sort()).toEqual([
      "INR",
      "USD",
    ]);
    expect(
      c.records.find(r => r.fields.currency === "INR")?.fields.maxMinor
    ).toBe("999999999999999");
    expect(c.opportunities[0].state).toBe("insufficient_hiring_evidence");
  });
  it("flags potentially conflicting same-scope reports without inventing a resolution or conflating different roles", async () => {
    const f = await fixture();
    await f.receive({
      ...f.batch,
      records: [
        f.record,
        {
          ...f.record,
          externalKey: "other-role",
          roleFamily: "Frontend engineering",
          openings: 0,
        },
      ],
    });
    expect((await marketOverview(f.ownerId)).opportunities[0].state).toBe(
      "reported_demand_needs_qualification"
    );
    await f.receive({
      ...f.batch,
      batchKey: createId("batch_"),
      records: [
        {
          ...f.record,
          externalKey: "same-scope-other-source-record",
          openings: 0,
        },
      ],
    });
    const c = await marketOverview(f.ownerId);
    expect(c.opportunities[0].state).toBe(
      "potentially_conflicting_reported_demand"
    );
    expect(c.summary.accountsWithConflictingDemand).toBe(1);
    expect(c.summary.accountsWithEvidence).toBe(1);
    expect(c.summary.usableRecords).toBe(3);
  });
  it("calculates aggregate account/source counts before display filtering and pagination", async () => {
    const f = await fixture();
    const { openings: _open, ...base } = f.record;
    await f.receive({
      ...f.batch,
      records: [
        f.record,
        {
          ...base,
          externalKey: "competition",
          kind: "competition",
          competingEmployers: 3,
          unfilledRoles: 8,
        },
      ],
    });
    const c = await marketOverview(f.ownerId, {
      kind: "competition",
      offset: 0,
      limit: 1,
    });
    expect(c.total).toBe(1);
    expect(c.records[0].kind).toBe("competition");
    expect(c.summary.usableRecords).toBe(2);
    expect(c.summary.accountsWithEvidence).toBe(1);
  });
  it("bounds new market batches per source, while exact receipt retries do not consume another admission", async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++)
      expect(
        (
          await f.receive({
            ...f.batch,
            batchKey: "rate-key-" + i,
            records: [
              {
                ...f.record,
                externalKey: "rate-" + i,
                companyDomain: "missing.example.test",
              },
            ],
          })
        ).statusCode
      ).toBe(200);
    const next = { ...f.batch, batchKey: "rate-key-10" };
    expect((await f.receive(next)).statusCode).toBe(429);
    expect(
      (
        await f.receive({
          ...f.batch,
          batchKey: "rate-key-0",
          records: [
            {
              ...f.record,
              externalKey: "rate-0",
              companyDomain: "missing.example.test",
            },
          ],
        })
      ).statusCode
    ).toBe(200);
  });
  it("emergency stop blocks new market commits without granting or changing worker authority", async () => {
    const f = await fixture();
    await f.db
      .update(schema.workspaceSettings)
      .set({ emergencyStop: true })
      .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
    expect((await f.receive()).statusCode).toBe(412);
    expect(await events(f, "market.signal")).toHaveLength(0);
    expect(
      (
        await f.db
          .select()
          .from(schema.workspaceSettings)
          .where(eq(schema.workspaceSettings.ownerId, f.ownerId))
      )[0].backgroundEnabled
    ).toBe(false);
  });
  it("rejects tampered stored observations rather than returning unverified modified content", async () => {
    const f = await fixture();
    await f.receive();
    const row = (await events(f, "market.signal"))[0];
    await f.db
      .update(schema.workflowEvents)
      .set({
        metadata: {
          ...(row.metadata as any),
          fields: { ...(row.metadata as any).fields, openings: 999 },
        },
      })
      .where(eq(schema.workflowEvents.id, row.id));
    await expect(marketOverview(f.ownerId)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
  it("rejects tampered permission authority and validates active expiry bounds", async () => {
    const f = await fixture();
    await expect(
      f.configure(
        permissionFields({
          validUntil: new Date(Date.now() + 400 * day).toISOString(),
        })
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const row = (await events(f, "market.permission"))[0];
    await f.db
      .update(schema.workflowEvents)
      .set({
        metadata: {
          ...(row.metadata as any),
          fields: { ...(row.metadata as any).fields, enabled: false },
        },
      })
      .where(eq(schema.workflowEvents.id, row.id));
    await expect(marketPermissions(f.ownerId)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
  it("keeps observations, history and permanent retirement scoped to their actual owner", async () => {
    const a = await fixture(),
      b = await fixture();
    await a.receive();
    const row = (await marketOverview(a.ownerId)).records[0];
    expect((await marketOverview(b.ownerId)).summary.usableRecords).toBe(0);
    await expect(marketSignalHistory(b.ownerId, row.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      retireMarketSignal(b.ownerId, b.ownerId, {
        id: row.id,
        expectedRevision: 1,
        reason: "Cross-owner retirement must not succeed.",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("fails closed on source bounds instead of publishing a truncated market or financial-looking total", async () => {
    const f = await fixture();
    const tx = {
      select: (projection?: any) => ({
        from: (table: any) =>
          table === schema.companies
            ? {
                where: () => ({
                  orderBy: () => ({ limit: async () => Array(10001).fill({}) }),
                }),
              }
            : f.db.select(projection).from(table),
      }),
    };
    await expect(
      marketContextInTransaction(tx, f.ownerId)
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("denies anonymous market reads, declaration, recording and retirement through the existing owner barrier", async () => {
    const f = await fixture(),
      { appRouter } = await import("../routers"),
      anon = appRouter.createCaller({
        user: null,
        req: { headers: {} },
        res: {},
      } as any);
    await expect(anon.marketEvidence.permissions()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(anon.marketEvidence.overview()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      anon.marketEvidence.configure({
        sourceId: f.sourceId,
        expectedRevision: 1,
        fields: permissionFields(),
        reason: "Anonymous changes must not succeed.",
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anon.marketEvidence.record({
        sourceId: f.sourceId,
        batch: f.batch,
        previewHash: "0".repeat(64),
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anon.marketEvidence.retire({
        id: "mkt_unknown",
        expectedRevision: 1,
        reason: "Anonymous retirement must not succeed.",
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("only joins minimized reported counts/commitments into briefs and leaves modeled revenue assumptions unchanged", async () => {
    const f = await fixture();
    const before = await ownerOverview(f.ownerId, {
      kind: "all",
      offset: 0,
      limit: 25,
    });
    await f.receive();
    const brief = await ownerOverview(f.ownerId, {
      kind: "all",
      offset: 0,
      limit: 25,
    });
    expect(brief.summary.strategy.reportedMarket.usableRecords).toBe(1);
    expect(brief.summary.strategy.reportedMarketSourceDigest).not.toBe(
      before.summary.strategy.reportedMarketSourceDigest
    );
    expect(brief.snapshotDigest).not.toBe(before.snapshotDigest);
    const text = JSON.stringify(brief.summary.strategy);
    for (const value of [f.domain, f.sourceId, f.record.sourceUrl, f.companyId])
      expect(text).not.toContain(value);
    expect(
      (await recruitmentStrategyDashboard(f.ownerId)).marketEvidence
        .usableRecords
    ).toBe(1);
    expect((await recruitmentStrategyDashboard(f.ownerId)).strategy.mode).toBe(
      "unconfigured"
    );
  });
  it("separates current market context from owner-entered modeled fees and probabilities", async () => {
    const f = await fixture();
    await saveRecruitmentStrategy(f.ownerId, f.ownerId, {
      expectedRevision: 0,
      mode: "active",
      reason:
        "Record synthetic planning inputs independently of source reports.",
      fields: {
        name: "Synthetic strategy",
        niche: "Technology recruitment",
        industries: ["Software"],
        regions: ["India"],
        roleFamilies: ["Backend engineering"],
        idealClient: "Established employers with budgeted mandates.",
        exclusions: "Unavailable accounts and unauthorized data sources.",
        currency: "INR",
        horizonWorkdays: 5,
        availableMinutes: 600,
        maxConcurrentRoles: 2,
        targetGrossMinor: "50000",
        fee: { mode: "fixed", amountMinor: "10000" },
        minutesPerPlacement: 100,
        minutesPerProspect: 5,
        plannedProspects: 10,
        replyBps: 10000,
        replyToMandateBps: 10000,
        mandateToPlacementBps: 5000,
        collectionBps: 8000,
        hourlyCostMinor: "600",
        fixedCostMinor: "500",
        variableCostPerPlacementMinor: "200",
        acquisitionBudgetMinor: "1000",
        acquisitionCostPerProspectMinor: "100",
        sourcingBudgetMinor: "1000",
        sourcingCostPerPlacementMinor: "100",
        reviewedOn: new Date().toISOString().slice(0, 10),
        freshnessDays: 14,
        assumptions:
          "Synthetic owner assumptions, not calibrated by market reports.",
      },
    });
    const before = await recruitmentStrategyDashboard(f.ownerId);
    await f.receive();
    const after = await recruitmentStrategyDashboard(f.ownerId);
    expect(after.model).toEqual(before.model);
    expect(after.marketEvidence.usableRecords).toBe(1);
    expect(after.matchingMarketRecords).toBe(1);
    expect(after.roles[0].marketEvidenceRecords).toBe(1);
    expect(after.model?.marketEvidence).toBe("unavailable");
  });
  it("serves the actual authenticated Hostinger route with private responses and a bounded request body", async () => {
    const f = await fixture(),
      { buildFastifyServer } = await import("../hostinger"),
      app = await buildFastifyServer({ logger: false });
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/api/integrations/market/" + f.sourceId,
        payload: f.batch,
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers["cache-control"]).toBe("no-store");
      const accepted = await app.inject({
        method: "POST",
        url: "/api/integrations/market/" + f.sourceId,
        headers: { authorization: "Bearer " + f.token },
        payload: f.batch,
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json().newlyAccepted).toBe(1);
      const oversized = await app.inject({
        method: "POST",
        url: "/api/integrations/market/" + f.sourceId,
        headers: {
          authorization: "Bearer " + f.token,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ oversized: "x".repeat(300000) }),
      });
      expect(oversized.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });
  it("returns only a normalized account domain even for legacy credential-bearing URL query data", async () => {
    const f = await fixture();
    await f.db
      .update(schema.companies)
      .set({
        domain:
          "https://www." +
          f.domain +
          "/careers?access_key=DO_NOT_RETURN_LEGACY_QUERY",
      })
      .where(eq(schema.companies.id, f.companyId));
    await f.receive();
    const c = await marketOverview(f.ownerId);
    expect(c.opportunities[0].domain).toBe(f.domain);
    expect(JSON.stringify(c)).not.toContain("DO_NOT_RETURN_LEGACY_QUERY");
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")(
    "serializes concurrent same-batch intake into one receipt and one physical observation",
    async () => {
      const f = await fixture();
      const result = await Promise.all([f.receive(), f.receive()]);
      expect(result.every(r => r.statusCode === 200)).toBe(true);
      expect(result.filter(r => (r.body as any).alreadyProcessed)).toHaveLength(
        1
      );
      expect(await events(f, "market.signal")).toHaveLength(1);
      expect(await events(f, "market.batch_received")).toHaveLength(1);
    }
  );
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")(
    "serializes competing corrections while preserving one accepted revision and a conflict receipt",
    async () => {
      const f = await fixture(),
        first = await f.receive(),
        previousDigest = (first.body as any).results[0].digest;
      const results = await Promise.all(
        [3, 4].map(openings =>
          f.receive({
            ...f.batch,
            batchKey: createId("batch_"),
            records: [{ ...f.record, revision: 2, previousDigest, openings }],
          })
        )
      );
      expect(
        results.map(r => (r.body as any).results[0].status).sort()
      ).toEqual(["accepted", "conflict"]);
      expect(await events(f, "market.signal")).toHaveLength(2);
    }
  );
});
