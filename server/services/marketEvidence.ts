import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  companies,
  intakeSources,
  workflowEvents,
  workspaceSettings,
} from "../../drizzle/schema";
import {
  MARKET_VERSION,
  marketBatch,
  marketObservation,
  marketPermissionFields,
  marketPermissionSave,
  marketReadQuery,
  marketRetire,
  type MarketObservation,
  type MarketPermission,
} from "../../shared/marketEvidence";
import { requireDb, recordAudit } from "../db";
import { withWorkspaceTransaction } from "./database";
import {
  requireIntakeSource,
  withAuthenticatedIntakeSource,
} from "./sourceIntake";
import { normalizeCompanyDomain } from "./canonicalIntake";
import { appendWorkflowEvent } from "./workflowStore";
import { canonicalHash } from "./canonicalHash";
const fail = (
  message: string,
  code:
    | "PRECONDITION_FAILED"
    | "CONFLICT"
    | "BAD_REQUEST"
    | "NOT_FOUND" = "PRECONDITION_FAILED"
) => new TRPCError({ code, message });
const seal = (data: Record<string, any>) => ({
  ...data,
  integrity: canonicalHash(data),
});
function unseal(row: any) {
  const { integrity, ...data } = row.metadata ?? {};
  if (integrity !== canonicalHash(data))
    throw fail(
      "Stored market evidence does not match its recorded integrity hash."
    );
  return data;
}
const sourceFields = {
  id: intakeSources.id,
  name: intakeSources.name,
  kind: intakeSources.kind,
  enabled: intakeSources.enabled,
  revision: intakeSources.revision,
};
const companyFields = {
  id: companies.id,
  domain: companies.domain,
  pipelineState: companies.pipelineState,
  verificationState: companies.verificationState,
};
const signalId = (ownerId: number, sourceId: string, keyHash: string) =>
  "mkt_" + canonicalHash([ownerId, sourceId, keyHash]).slice(0, 40);
const batchId = (ownerId: number, sourceId: string, key: string) =>
  "mkb_" + canonicalHash([ownerId, sourceId, canonicalHash(key)]).slice(0, 40);
async function latest(tx: any, ownerId: number, types: string[], id: string) {
  return (
    await tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          inArray(workflowEvents.eventType, types),
          eq(workflowEvents.aggregateId, id)
        )
      )
      .orderBy(desc(workflowEvents.revision))
      .limit(1)
  )[0];
}
function permissionRow(row: any) {
  if (!row)
    return {
      revision: 0,
      fields: null as MarketPermission | null,
      reason: null as string | null,
    };
  const data = unseal(row);
  if (data.sourceId !== row.aggregateId)
    throw fail("Market permission scope is inconsistent.");
  return {
    revision: row.revision,
    fields: marketPermissionFields.parse(data.fields),
    reason: data.reason as string,
  };
}
async function permission(tx: any, ownerId: number, sourceId: string) {
  return permissionRow(
    await latest(tx, ownerId, ["market.permission"], sourceId)
  );
}
function permissionIssue(
  source: any,
  p: { revision: number; fields: MarketPermission | null },
  now: Date
) {
  if (!source || source.kind !== "prospect" || !source.enabled)
    return "source_unavailable";
  if (!p.fields?.enabled) return "permission_disabled_or_missing";
  if (new Date(p.fields.validFrom) > now) return "permission_not_started";
  if (new Date(p.fields.validUntil) <= now) return "permission_expired";
  return null;
}
export async function configureMarketPermission(
  ownerId: number,
  actorId: number,
  raw: z.input<typeof marketPermissionSave>
) {
  const input = marketPermissionSave.parse(raw);
  return withWorkspaceTransaction(ownerId, async tx => {
    const source = await requireIntakeSource(tx, ownerId, input.sourceId);
    if (source.kind !== "prospect")
      throw fail(
        "Market evidence requires an existing prospect intake source."
      );
    const prior = await permission(tx, ownerId, source.id);
    if (
      prior.revision === input.expectedRevision + 1 &&
      canonicalHash(prior.fields) === canonicalHash(input.fields) &&
      prior.reason === input.reason
    )
      return { revision: prior.revision, alreadySaved: true };
    if (prior.revision !== input.expectedRevision)
      throw fail(
        "Market permission changed. Review its current version.",
        "CONFLICT"
      );
    if (
      input.fields.enabled &&
      (new Date(input.fields.validUntil) <= new Date() ||
        new Date(input.fields.validUntil).getTime() >
          Date.now() + 366 * 86400000)
    )
      throw fail(
        "Enabled permissions need an expiry in the next 366 days.",
        "BAD_REQUEST"
      );
    const revision = prior.revision + 1;
    await appendWorkflowEvent(
      tx,
      ownerId,
      "market.permission",
      source.id,
      revision,
      seal({
        sourceId: source.id,
        fields: input.fields,
        reason: input.reason,
        actorId,
      })
    );
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "market.permission_recorded",
        resourceType: "intake_source",
        resourceId: source.id,
        metadata: {
          revision,
          enabled: input.fields.enabled,
          basis: "owner_declared",
          contactAuthorityGranted: false,
        },
      },
      tx
    );
    return { revision, alreadySaved: false };
  });
}
export async function marketPermissions(ownerId: number) {
  const db = await requireDb();
  return db.transaction(async (tx: any) => {
    const sources = await tx
      .select(sourceFields)
      .from(intakeSources)
      .where(eq(intakeSources.ownerId, ownerId))
      .orderBy(asc(intakeSources.id))
      .limit(10001);
    if (sources.length > 10000)
      throw fail("Market source registry exceeds its supported bound.");
    const rows = await tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          eq(workflowEvents.eventType, "market.permission")
        )
      )
      .orderBy(desc(workflowEvents.revision))
      .limit(10001);
    if (rows.length > 10000)
      throw fail(
        "Market permission history exceeds its supported bound; archive before continuing."
      );
    const bySource = new Map<string, any>();
    for (const row of rows)
      if (!bySource.has(row.aggregateId)) bySource.set(row.aggregateId, row);
    return sources
      .filter((s: any) => s.kind === "prospect")
      .map((s: any) => {
        const p = permissionRow(bySource.get(s.id));
        return {
          source: {
            id: s.id,
            name: s.name,
            kind: s.kind,
            enabled: s.enabled,
            revision: s.revision,
          },
          permission: p,
          issue: permissionIssue(s, p, new Date()),
          endpoint: "/api/integrations/market/" + s.id,
          declarationVerifiedExternally: false,
        };
      });
  });
}
function parseBatch(body: unknown) {
  const parsed = marketBatch.safeParse(body);
  if (!parsed.success)
    throw fail(
      "Invalid market batch fields. Use the documented structured schema.",
      "BAD_REQUEST"
    );
  return {
    ...parsed.data,
    records: parsed.data.records.map(record => ({
      ...record,
      companyDomain: normalizeCompanyDomain(record.companyDomain)!,
    })),
  };
}
type Batch = ReturnType<typeof parseBatch>;
type Outcome = {
  id: string;
  externalKeyHash: string;
  revision: number;
  status: "accepted" | "reused" | "held" | "conflict";
  reason?: string;
  digest?: string;
  companyId?: string;
};
async function requireMarketPermission(
  tx: any,
  source: any,
  batch: Batch,
  now: Date
) {
  const p = await permission(tx, source.ownerId, source.id),
    issue = permissionIssue(source, p, now);
  if (issue) throw fail("Market intake blocked: " + issue + ".");
  if (batch.permissionRevision !== p.revision)
    throw fail(
      "Market permission revision changed. Review the source declaration before retrying.",
      "CONFLICT"
    );
  return p;
}
async function existingMarketReceipt(tx: any, source: any, batch: Batch) {
  const id = batchId(source.ownerId, source.id, batch.batchKey),
    prior = await latest(tx, source.ownerId, ["market.batch_received"], id);
  if (!prior) return null;
  const data = unseal(prior);
  if (data.sourceId !== source.id)
    throw fail("Market receipt scope is inconsistent.");
  if (data.payloadHash !== canonicalHash(batch))
    throw fail(
      "This market batch key already belongs to different content.",
      "CONFLICT"
    );
  return {
    id,
    alreadyProcessed: true,
    results: data.results as Outcome[],
    receiptOnly: true,
    newlyAccepted: 0,
  };
}
async function assessBatch(tx: any, source: any, batch: Batch, now: Date) {
  const p = await requireMarketPermission(tx, source, batch, now);
  const rows = await tx
    .select(companyFields)
    .from(companies)
    .where(eq(companies.ownerId, source.ownerId))
    .orderBy(asc(companies.id))
    .limit(10001);
  if (rows.length > 10000)
    throw fail("Company sources exceed the bounded market intake limit.");
  const domainMap = new Map<string, any[]>();
  for (const row of rows) {
    let domain: string | null = null;
    try {
      domain = normalizeCompanyDomain(row.domain);
    } catch {}
    if (domain) domainMap.set(domain, [...(domainMap.get(domain) ?? []), row]);
  }
  const records: any[] = [];
  const outcomes: Outcome[] = [];
  for (const raw of batch.records) {
    const keyHash = canonicalHash(raw.externalKey),
      id = signalId(source.ownerId, source.id, keyHash);
    const { externalKey: _key, ...fields } = raw;
    const digest = canonicalHash({ fields, permissionRevision: p.revision });
    let status: Outcome["status"] = "accepted",
      reason: string | undefined;
    const candidates = domainMap.get(raw.companyDomain) ?? [],
      company = candidates.length === 1 ? candidates[0] : null;
    if (candidates.length !== 1)
      reason = candidates.length
        ? "ambiguous_company_domain"
        : "company_not_imported";
    else if (["suppressed", "do_not_contact"].includes(company.pipelineState))
      reason = "account_unavailable";
    if (!p.fields!.allowedKinds.includes(raw.kind))
      reason = "kind_not_permitted";
    const observed = new Date(raw.observedAt);
    if (observed > now) reason = "future_observation";
    else if (
      observed < new Date(p.fields!.validFrom) ||
      observed >= new Date(p.fields!.validUntil)
    )
      reason = "observation_outside_permission_period";
    else if (
      now.getTime() - observed.getTime() >
      p.fields!.maxAgeDays * 86400000
    )
      reason = "observation_stale";
    if (
      raw.kind === "seasonality" &&
      raw.periodEnd > raw.observedAt.slice(0, 10)
    )
      reason = "unobserved_future_period";
    const prior = await latest(
      tx,
      source.ownerId,
      ["market.signal", "market.retired"],
      id
    );
    let previous: any = null;
    if (prior) {
      previous = unseal(prior);
      if (
        previous.sourceId !== source.id ||
        previous.externalKeyHash !== keyHash
      )
        throw fail("Market observation scope is inconsistent.");
      if (prior.eventType === "market.retired") {
        status = "held";
        reason = "permanently_retired";
      } else if (prior.revision === raw.revision) {
        if (previous.digest === digest) {
          status = "reused";
        } else {
          status = "conflict";
          reason = "same_revision_different_content";
        }
      } else if (
        raw.revision !== prior.revision + 1 ||
        raw.previousDigest !== previous.digest
      ) {
        status = "conflict";
        reason = "previous_revision_or_digest_changed";
      } else if (
        new Date(raw.observedAt) < new Date(previous.fields.observedAt)
      ) {
        status = "conflict";
        reason = "observation_time_moved_backwards";
      }
    } else if (raw.revision !== 1) {
      status = "conflict";
      reason = "initial_revision_must_be_one";
    }
    if (status === "accepted" && reason) status = "held";
    // A replay cannot regain usability while account/permission/freshness gates fail.
    if (status === "reused" && reason) status = "held";
    const delta =
      previous?.permissionRevision === p.revision &&
      previous?.fields?.kind === "hiring_demand" &&
      raw.kind === "hiring_demand" &&
      new Date(raw.observedAt) > new Date(previous.fields.observedAt) &&
      now.getTime() - new Date(previous.fields.observedAt).getTime() <=
        p.fields!.maxAgeDays * 86400000 &&
      ["companyDomain", "roleFamily", "region", "industry"].every(
        k => previous.fields[k] === fields[k as keyof typeof fields]
      )
        ? raw.openings - previous.fields.openings
        : null;
    const outcome: Outcome = {
      id,
      externalKeyHash: keyHash,
      revision: raw.revision,
      status,
      ...(reason ? { reason } : {}),
      ...(status === "accepted" || status === "reused"
        ? { digest, companyId: company.id }
        : {}),
    };
    outcomes.push(outcome);
    records.push({
      outcome,
      fields,
      previous,
      data: seal({
        sourceId: source.id,
        externalKeyHash: keyHash,
        companyId: company?.id ?? null,
        fields,
        digest,
        permissionRevision: p.revision,
        sourceRevision: source.revision,
        reportedOpeningsChange: delta,
        origin: "source_reported",
      }),
    });
  }
  const previewHash = canonicalHash({
    source: {
      id: source.id,
      revision: source.revision,
      enabled: source.enabled,
    },
    permissionRevision: p.revision,
    batch,
    outcomes,
  });
  return { outcomes, records, previewHash };
}
async function commitBatch(
  tx: any,
  source: any,
  batch: Batch,
  origin: "owner_review" | "authenticated_source",
  previewHash?: string
) {
  const now = new Date(),
    p = await requireMarketPermission(tx, source, batch, now);
  const workspace = (
    await tx
      .select({ emergencyStop: workspaceSettings.emergencyStop })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.ownerId, source.ownerId))
      .limit(1)
  )[0];
  if (workspace?.emergencyStop)
    throw fail("Emergency stop blocks new market intake.");
  const existing = await existingMarketReceipt(tx, source, batch);
  if (existing) return existing;
  const id = batchId(source.ownerId, source.id, batch.batchKey),
    hash = canonicalHash(batch);
  const recent = await tx
    .select({ id: workflowEvents.id })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.ownerId, source.ownerId),
        eq(workflowEvents.eventType, "market.batch_rate"),
        eq(workflowEvents.aggregateId, "market-rate:" + source.id),
        gte(workflowEvents.createdAt, new Date(now.getTime() - 60000))
      )
    )
    .limit(10);
  // Rate receipts use a separate discriminator but the same existing event ledger.
  if (recent.length >= 10)
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message:
        "This market source accepts ten new batches per minute. Retry with the same batch key.",
    });
  const assessment = await assessBatch(tx, source, batch, now);
  if (previewHash && previewHash !== assessment.previewHash)
    throw fail(
      "Market preview changed. Review current sources, permission and record versions.",
      "CONFLICT"
    );
  for (const r of assessment.records)
    if (r.outcome.status === "accepted")
      await appendWorkflowEvent(
        tx,
        source.ownerId,
        "market.signal",
        r.outcome.id,
        r.outcome.revision,
        seal({ ...unseal({ metadata: r.data }), admission: origin })
      );
  const results = assessment.outcomes;
  await appendWorkflowEvent(
    tx,
    source.ownerId,
    "market.batch_received",
    id,
    1,
    seal({
      sourceId: source.id,
      payloadHash: hash,
      results,
      origin,
      permissionRevision: p.revision,
    })
  );
  await appendWorkflowEvent(
    tx,
    source.ownerId,
    "market.batch_rate",
    "market-rate:" + source.id,
    1,
    seal({ sourceId: source.id, receiptId: id }),
    id
  );
  await tx
    .update(intakeSources)
    .set({ lastReceivedAt: now })
    .where(eq(intakeSources.id, source.id));
  return {
    id,
    alreadyProcessed: false,
    results,
    receiptOnly: false,
    newlyAccepted: results.filter(r => r.status === "accepted").length,
  };
}
export async function previewMarketBatch(
  ownerId: number,
  sourceId: string,
  body: unknown
) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const source = await requireIntakeSource(tx, ownerId, sourceId),
      batch = parseBatch(body),
      now = new Date();
    await requireMarketPermission(tx, source, batch, now);
    const receipt = await existingMarketReceipt(tx, source, batch);
    if (receipt)
      return {
        results: receipt.results,
        previewHash: canonicalHash({
          id: receipt.id,
          payloadHash: canonicalHash(batch),
          receiptOnly: true,
        }),
        receiptOnly: true,
        contactAuthorityGranted: false,
      };
    const result = await assessBatch(tx, source, batch, now);
    return {
      results: result.outcomes,
      previewHash: result.previewHash,
      receiptOnly: false,
      contactAuthorityGranted: false,
    };
  });
}
export async function recordMarketBatch(
  ownerId: number,
  sourceId: string,
  body: unknown,
  previewHash: string
) {
  return withWorkspaceTransaction(ownerId, async tx =>
    commitBatch(
      tx,
      await requireIntakeSource(tx, ownerId, sourceId),
      parseBatch(body),
      "owner_review",
      previewHash
    )
  );
}
export async function processMarketWebhook(input: {
  sourceId: string;
  authorization?: string;
  body: unknown;
}) {
  try {
    const body = await withAuthenticatedIntakeSource(input, (tx, source) =>
      commitBatch(tx, source, parseBatch(input.body), "authenticated_source")
    );
    return { statusCode: 200, body };
  } catch (error) {
    if (error instanceof TRPCError)
      return {
        statusCode: getHTTPStatusCodeFromError(error),
        body: { error: error.message, code: error.code },
      };
    return {
      statusCode: 500,
      body: {
        error:
          "Market intake could not be committed. Retry with the same batch key.",
      },
    };
  }
}
export async function retireMarketSignal(
  ownerId: number,
  actorId: number,
  raw: z.input<typeof marketRetire>
) {
  const input = marketRetire.parse(raw);
  return withWorkspaceTransaction(ownerId, async tx => {
    const prior = await latest(
      tx,
      ownerId,
      ["market.signal", "market.retired"],
      input.id
    );
    if (!prior)
      throw fail(
        "Market observation was not found in this workspace.",
        "NOT_FOUND"
      );
    const data = unseal(prior);
    if (prior.eventType === "market.retired") {
      if (
        prior.revision === input.expectedRevision + 1 &&
        data.reason === input.reason
      )
        return { revision: prior.revision, alreadyRetired: true };
      throw fail("Observation is already retired.", "CONFLICT");
    }
    if (prior.revision !== input.expectedRevision)
      throw fail(
        "Market observation changed. Review its current revision.",
        "CONFLICT"
      );
    await appendWorkflowEvent(
      tx,
      ownerId,
      "market.retired",
      input.id,
      prior.revision + 1,
      seal({
        sourceId: data.sourceId,
        companyId: data.companyId,
        externalKeyHash: data.externalKeyHash,
        lastAcceptedDigest: data.digest,
        reason: input.reason,
        actorId,
      })
    );
    return { revision: prior.revision + 1, alreadyRetired: false };
  });
}
/** Full bounded source calculation; filters and display pagination are applied afterwards. */
export async function marketContextInTransaction(
  tx: any,
  ownerId: number,
  now = new Date()
) {
  const [sourceRows, companyRows, events] = await Promise.all([
    tx
      .select(sourceFields)
      .from(intakeSources)
      .where(eq(intakeSources.ownerId, ownerId))
      .orderBy(asc(intakeSources.id))
      .limit(10001),
    tx
      .select(companyFields)
      .from(companies)
      .where(eq(companies.ownerId, ownerId))
      .orderBy(asc(companies.id))
      .limit(10001),
    tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          inArray(workflowEvents.eventType, [
            "market.permission",
            "market.signal",
            "market.retired",
          ])
        )
      )
      .orderBy(desc(workflowEvents.revision), asc(workflowEvents.id))
      .limit(10001),
  ]);
  if ([sourceRows, companyRows, events].some(rows => rows.length > 10000))
    throw fail(
      "Market evidence sources exceed the supported bound. No partial summary was returned."
    );
  const sources = new Map<string, any>(sourceRows.map((s: any) => [s.id, s])),
    accounts = new Map<string, any>(companyRows.map((c: any) => [c.id, c])),
    permissions = new Map<string, ReturnType<typeof permissionRow>>(),
    signals = new Map<string, any>();
  for (const row of events) {
    if (row.eventType === "market.permission") {
      if (!permissions.has(row.aggregateId))
        permissions.set(row.aggregateId, permissionRow(row));
    } else if (!signals.has(row.aggregateId)) signals.set(row.aggregateId, row);
  }
  const domainCounts = new Map<string, number>();
  for (const company of companyRows) {
    try {
      const domain = normalizeCompanyDomain(company.domain);
      if (domain) domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    } catch {}
  }
  const records = [...signals.values()].map(row => {
    const data = unseal(row),
      source = sources.get(data.sourceId),
      company = accounts.get(data.companyId),
      p = permissions.get(data.sourceId) ?? {
        revision: 0,
        fields: null,
        reason: null,
      };
    if (
      row.aggregateId !== signalId(ownerId, data.sourceId, data.externalKeyHash)
    )
      throw fail("Market observation identity is inconsistent.");
    let issue =
      row.eventType === "market.retired"
        ? "permanently_retired"
        : permissionIssue(source, p, now);
    if (row.eventType !== "market.retired") {
      if (
        data.digest !==
          canonicalHash({
            fields: data.fields,
            permissionRevision: data.permissionRevision,
          }) ||
        data.fields.revision !== row.revision
      )
        throw fail("Market observation revision or digest is inconsistent.");
      if (!issue && data.permissionRevision !== p.revision)
        issue = "permission_version_changed";
      if (!issue && !p.fields!.allowedKinds.includes(data.fields.kind))
        issue = "kind_not_permitted";
      if (
        !issue &&
        (!company ||
          ["suppressed", "do_not_contact"].includes(company.pipelineState))
      )
        issue = "account_unavailable";
      let domain: null | string = null;
      try {
        domain = normalizeCompanyDomain(company?.domain);
      } catch {}
      if (!issue && domain && (domainCounts.get(domain) ?? 0) > 1)
        issue = "ambiguous_company_domain";
      if (!issue && domain !== data.fields.companyDomain)
        issue = "canonical_domain_changed";
      const observed = new Date(data.fields.observedAt);
      if (
        !issue &&
        (observed > now ||
          new Date(row.createdAt).getTime() > now.getTime() + 1000)
      )
        issue = "future_observation_or_receipt";
      if (
        !issue &&
        (observed < new Date(p.fields!.validFrom) ||
          observed >= new Date(p.fields!.validUntil))
      )
        issue = "observation_outside_permission_period";
      if (
        !issue &&
        now.getTime() - observed.getTime() > p.fields!.maxAgeDays * 86400000
      )
        issue = "observation_stale";
    }
    return {
      id: row.aggregateId,
      revision: row.revision,
      sourceId: data.sourceId,
      companyId: data.companyId,
      externalKeyHash: data.externalKeyHash,
      digest: data.digest ?? data.lastAcceptedDigest,
      permissionRevision: data.permissionRevision ?? null,
      usable: !issue,
      issue: issue ?? null,
      kind: issue ? null : (data.fields.kind as MarketObservation["kind"]),
      fields: issue ? null : data.fields,
      reportedOpeningsChange: issue
        ? null
        : (data.reportedOpeningsChange ?? null),
      admission: data.admission ?? null,
      evidenceLevel: "source_reported",
      licenseVerifiedExternally: false,
      contactAuthorityGranted: false,
    };
  });
  records.sort(
    (a, b) => Number(b.usable) - Number(a.usable) || a.id.localeCompare(b.id)
  );
  const usable = records.filter(r => r.usable),
    byKind = Object.fromEntries(
      ["hiring_demand", "salary_benchmark", "competition", "seasonality"].map(
        k => [k, usable.filter(r => r.kind === k).length]
      )
    );
  const companyIds = [...new Set(usable.map(r => r.companyId))];
  const opportunities = companyIds.map(id => {
    const account = accounts.get(id),
      evidence = usable.filter(r => r.companyId === id),
      demand = evidence.filter(r => r.kind === "hiring_demand"),
      positive = demand.some(r => r.fields.openings > 0),
      scopes = new Map<string, Set<number>>();
    for (const r of demand) {
      const key = canonicalHash([
        r.fields.roleFamily.toLowerCase(),
        r.fields.region.toLowerCase(),
        r.fields.industry.toLowerCase(),
        r.fields.observedAt.slice(0, 10),
      ]);
      if (!scopes.has(key)) scopes.set(key, new Set());
      scopes.get(key)!.add(r.fields.openings);
    }
    const conflict = [...scopes.values()].some(values => values.size > 1);
    return {
      companyId: id,
      domain: normalizeCompanyDomain(account.domain),
      state: conflict
        ? "potentially_conflicting_reported_demand"
        : positive
          ? "reported_demand_needs_qualification"
          : "insufficient_hiring_evidence",
      evidenceRecords: evidence.length,
      reportedDemandRecords: demand.length,
      accountVerificationState: account.verificationState,
      agencyOpenness: "unverified",
      paymentReliability: "unverified",
      contactAuthorityGranted: false,
    };
  });
  return {
    version: MARKET_VERSION,
    records,
    opportunities,
    summary: {
      usableRecords: usable.length,
      heldRecords: records.length - usable.length,
      accountsWithEvidence: companyIds.length,
      accountsNeedingQualification: opportunities.filter(
        o => o.state === "reported_demand_needs_qualification"
      ).length,
      accountsWithConflictingDemand: opportunities.filter(
        o => o.state === "potentially_conflicting_reported_demand"
      ).length,
      byKind,
      evidenceLevel: "source_reported",
      licenseVerification: "owner_declaration_only",
      contactAuthorityGranted: false,
    },
    sourceDigest: canonicalHash(
      records.map(r => ({
        id: r.id,
        revision: r.revision,
        digest: r.digest,
        usable: r.usable,
        issue: r.issue,
      }))
    ),
    limitations: [
      "Source authentication and owner-declared licensing do not independently verify the reported facts, legal rights, hiring authority, agency openness or payment risk.",
      "Counts represent source records, not distinct vacancies, unique opportunities, verified candidate supply or calibrated conversion probabilities. Conflicting reports are not silently resolved.",
      "Salary ranges retain their source currency, reporting period and sample size; no FX conversion, pooled salary average or actual compensation change is inferred.",
      "Only exact canonical account/domain links are used. Missing or ambiguous companies are held for existing intake/identity review. No company, contact, candidate, mandate or permission is created here.",
      "Disabled/expired/changed permission, paused sources, unavailable or changed account domains, stale/future observations and permanent retirement hide unusable fields. Historical receipts do not make them current facts.",
      "No external page is fetched, no scraping/enrichment/LLM is called, and no recipient contact, budget spend, invoice or hiring decision is authorized.",
    ],
  };
}
export async function marketOverview(
  ownerId: number,
  raw?: z.input<typeof marketReadQuery>
) {
  const input = marketReadQuery.parse(raw);
  return (await requireDb()).transaction(async (tx: any) => {
    const c = await marketContextInTransaction(tx, ownerId),
      records = c.records.filter(
        r => input.kind === "all" || r.kind === input.kind
      );
    return {
      ...c,
      records: records.slice(input.offset, input.offset + input.limit),
      total: records.length,
      hasMore: input.offset + input.limit < records.length,
      offset: input.offset,
      opportunities: c.opportunities.slice(0, 100),
      moreOpportunitiesAvailable: c.opportunities.length > 100,
    };
  });
}
export async function marketBatchHistory(ownerId: number) {
  const rows = await (
    await requireDb()
  )
    .select()
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.ownerId, ownerId),
        eq(workflowEvents.eventType, "market.batch_received")
      )
    )
    .orderBy(desc(workflowEvents.createdAt), desc(workflowEvents.id))
    .limit(51);
  return {
    items: rows.slice(0, 50).map((row: any) => ({
      id: row.aggregateId,
      receivedAt: row.createdAt,
      ...unseal(row),
    })),
    olderAvailable: rows.length > 50,
  };
}
export async function marketSignalHistory(ownerId: number, id: string) {
  return (await requireDb()).transaction(async (tx: any) => {
    const context = await marketContextInTransaction(tx, ownerId),
      current = context.records.find(r => r.id === id);
    if (!current)
      throw fail(
        "Market observation was not found in this workspace.",
        "NOT_FOUND"
      );
    const p = await permission(tx, ownerId, current.sourceId),
      now = new Date();
    const rows = await tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          eq(workflowEvents.aggregateId, id),
          inArray(workflowEvents.eventType, ["market.signal", "market.retired"])
        )
      )
      .orderBy(desc(workflowEvents.revision))
      .limit(21);
    return {
      items: rows.slice(0, 20).map((row: any) => {
        const d = unseal(row);
        if (
          d.sourceId !== current.sourceId ||
          d.externalKeyHash !== current.externalKeyHash
        )
          throw fail("Historical market observation scope is inconsistent.");
        let issue = current.issue;
        if (!issue && d.permissionRevision !== current.permissionRevision)
          issue = "permission_version_changed";
        if (
          !issue &&
          (d.companyId !== current.companyId ||
            d.fields.companyDomain !== current.fields.companyDomain)
        )
          issue = "historical_account_scope_changed";
        if (
          !issue &&
          (now.getTime() - new Date(d.fields.observedAt).getTime() >
            p.fields!.maxAgeDays * 86400000 ||
            new Date(d.fields.observedAt) > now)
        )
          issue = "observation_stale_or_future";
        return {
          revision: row.revision,
          recordedAt: row.createdAt,
          digest: d.digest ?? d.lastAcceptedDigest,
          fields: issue ? null : d.fields,
          issue: issue ?? null,
        };
      }),
      olderAvailable: rows.length > 20,
    };
  });
}
