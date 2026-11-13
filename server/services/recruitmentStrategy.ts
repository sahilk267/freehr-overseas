import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  jobs,
  companies,
  workflowEvents,
  workspaceSettings,
} from "../../drizzle/schema";
import {
  strategySave,
  strategyFields,
  strategyRoleSave,
  strategyRoleFields,
  strategyDashboardQuery,
  type StrategyFields,
} from "../../shared/recruitmentStrategy";
import { requireDb, recordAudit } from "../db";
import { withWorkspaceTransaction } from "./database";
import { appendWorkflowEvent } from "./workflowStore";
import { canonicalHash } from "./canonicalHash";
import { modelRecruitmentStrategy, strategyFreshness } from "./strategyModel";
const latest = async (tx: any, ownerId: number, type: string, id: string) =>
  (
    await tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          eq(workflowEvents.eventType, type),
          eq(workflowEvents.aggregateId, id)
        )
      )
      .orderBy(desc(workflowEvents.revision))
      .limit(1)
  )[0];
async function current(tx: any, ownerId: number) {
  const row = await latest(tx, ownerId, "strategy.version", "owner:" + ownerId);
  if (!row)
    return {
      revision: 0,
      mode: "unconfigured" as const,
      fields: null,
      reason: null,
    };
  if (
    row.metadata.stateHash !==
      canonicalHash({
        fields: row.metadata.fields,
        mode: row.metadata.mode,
        reason: row.metadata.reason,
      }) ||
    row.metadata.fieldsHash !== canonicalHash(row.metadata.fields)
  )
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Stored strategy assumptions do not match their recorded hash.",
    });
  return {
    revision: row.revision,
    mode: row.metadata.mode as "draft" | "active" | "paused",
    fields: strategyFields.parse(row.metadata.fields),
    reason: row.metadata.reason as string,
  };
}
export async function strategyBriefInTransaction(
  tx: any,
  ownerId: number,
  now: Date
) {
  const s = await current(tx, ownerId);
  return {
    configured: s.fields !== null,
    revision: s.revision,
    mode: s.mode,
    freshness: s.fields
      ? strategyFreshness(s.fields.reviewedOn, s.fields.freshnessDays, now)
      : "unavailable",
    evidenceLevel: "owner_assumptions",
    workflowExecutionAuthorized: false,
  };
}
export async function saveRecruitmentStrategy(
  ownerId: number,
  actorId: number,
  raw: z.input<typeof strategySave>
) {
  const input = strategySave.parse(raw);
  return withWorkspaceTransaction(ownerId, async tx => {
    const s = await current(tx, ownerId),
      hash = canonicalHash(input.fields);
    if (
      s.revision === input.expectedRevision + 1 &&
      s.mode === input.mode &&
      s.fields &&
      canonicalHash(s.fields) === hash &&
      s.reason === input.reason
    )
      return { revision: s.revision, alreadySaved: true };
    if (s.revision !== input.expectedRevision)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Strategy changed. Review the current version before saving.",
      });
    const model = modelRecruitmentStrategy(input.fields);
    if (
      input.mode === "active" &&
      (model.freshness !== "current" || BigInt(model.feeMinor) <= 0n)
    )
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Active planning requires current dated assumptions and a positive modeled fee.",
      });
    const revision = s.revision + 1;
    await appendWorkflowEvent(
      tx,
      ownerId,
      "strategy.version",
      "owner:" + ownerId,
      revision,
      {
        mode: input.mode,
        fields: input.fields,
        fieldsHash: hash,
        stateHash: canonicalHash({
          fields: input.fields,
          mode: input.mode,
          reason: input.reason,
        }),
        reason: input.reason,
        actorId,
      }
    );
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "strategy.version_recorded",
        resourceType: "workspace",
        resourceId: String(ownerId),
        metadata: {
          revision,
          mode: input.mode,
          workflowExecutionAuthorized: false,
        },
      },
      tx
    );
    return { revision, alreadySaved: false };
  });
}
const sourceJobFields = {
  id: jobs.id,
  companyId: jobs.companyId,
  title: jobs.title,
  feeProposalId: jobs.feeProposalId,
  department: jobs.department,
  employmentType: jobs.employmentType,
  workModel: jobs.workModel,
  compensationMin: jobs.compensationMin,
  compensationMax: jobs.compensationMax,
  experienceMinYears: jobs.experienceMinYears,
  experienceMaxYears: jobs.experienceMaxYears,
  niceToHaveSkills: jobs.niceToHaveSkills,
  scorecard: jobs.scorecard,
  pipelineState: jobs.pipelineState,
  location: jobs.location,
  currency: jobs.currency,
  mustHaveSkills: jobs.mustHaveSkills,
  intake: jobs.intake,
  requirementQuality: jobs.requirementQuality,
  clientConfirmedAt: jobs.clientConfirmedAt,
  targetJoiningAt: jobs.targetJoiningAt,
};
const sourceCompanyFields = {
  id: companies.id,
  pipelineState: companies.pipelineState,
  verificationState: companies.verificationState,
  companyType: companies.companyType,
  sizeBand: companies.sizeBand,
  onboardingApprovedAt: companies.onboardingApprovedAt,
  sector: companies.sector,
  location: companies.location,
};
function sourceDigest(job: any, company: any) {
  return canonicalHash({ job, company: company ?? null });
}
async function roleSource(tx: any, ownerId: number, jobId: string) {
  const job = (
    await tx
      .select(sourceJobFields)
      .from(jobs)
      .where(and(eq(jobs.ownerId, ownerId), eq(jobs.id, jobId)))
      .limit(1)
  )[0];
  if (!job)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Planning role was not found in this workspace.",
    });
  const company = (
    await tx
      .select(sourceCompanyFields)
      .from(companies)
      .where(
        and(eq(companies.ownerId, ownerId), eq(companies.id, job.companyId))
      )
      .limit(1)
  )[0];
  return { job, company, sourceDigest: sourceDigest(job, company) };
}
export async function saveStrategyRole(
  ownerId: number,
  actorId: number,
  raw: z.input<typeof strategyRoleSave>
) {
  const input = strategyRoleSave.parse(raw);
  return withWorkspaceTransaction(ownerId, async tx => {
    const s = await current(tx, ownerId);
    if (!s.fields || s.revision !== input.strategyRevision)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Review the current strategy before assessing this role.",
      });
    const source = await roleSource(tx, ownerId, input.jobId);
    if (source.sourceDigest !== input.sourceDigest)
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Role or account source changed. Review it again before saving assumptions.",
      });
    if (
      source.job.pipelineState !== "open" ||
      !source.company ||
      ["suppressed", "do_not_contact"].includes(source.company.pipelineState)
    )
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Only open roles on available accounts can be planned.",
      });
    if (input.fields.currency !== s.fields.currency)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Role assumptions must use the strategy currency; no exchange rate is inferred.",
      });
    if (
      strategyFreshness(input.fields.reviewedOn, input.fields.freshnessDays) ===
      "future"
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Role assumptions cannot claim a future observation date.",
      });
    const old = await latest(
        tx,
        ownerId,
        "strategy.role_assessed",
        input.jobId
      ),
      revision = old?.revision ?? 0,
      identity = canonicalHash({
        fields: input.fields,
        sourceDigest: input.sourceDigest,
        strategyRevision: input.strategyRevision,
        reason: input.reason,
      });
    if (
      revision === input.expectedRevision + 1 &&
      old?.metadata.identity === identity
    )
      return { revision, alreadySaved: true };
    if (revision !== input.expectedRevision)
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Role assumptions changed. Review the current assessment before saving.",
      });
    await appendWorkflowEvent(
      tx,
      ownerId,
      "strategy.role_assessed",
      input.jobId,
      revision + 1,
      {
        fields: input.fields,
        sourceDigest: input.sourceDigest,
        strategyRevision: input.strategyRevision,
        identity,
        reason: input.reason,
        actorId,
      }
    );
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "strategy.role_assessed",
        resourceType: "job",
        resourceId: input.jobId,
        metadata: {
          revision: revision + 1,
          strategyRevision: s.revision,
          evidenceLevel: "owner_assumptions",
        },
      },
      tx
    );
    return { revision: revision + 1, alreadySaved: false };
  });
}
export async function strategyPlanInTransaction(
  tx: any,
  ownerId: number,
  now: Date
) {
  const s = await current(tx, ownerId),
    workspace = (
      await tx
        .select({
          dailyOutboundLimit: workspaceSettings.dailyOutboundLimit,
          emergencyStop: workspaceSettings.emergencyStop,
          backgroundEnabled: workspaceSettings.backgroundEnabled,
        })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.ownerId, ownerId))
        .limit(1)
    )[0];
  if (!s.fields)
    return {
      strategy: s,
      model: null,
      roles: [],
      plan: null,
      workspace: workspace ?? null,
    };
  const [jobRows, companyRows, assessmentRows] = await Promise.all([
    tx
      .select(sourceJobFields)
      .from(jobs)
      .where(eq(jobs.ownerId, ownerId))
      .orderBy(asc(jobs.id))
      .limit(10001),
    tx
      .select(sourceCompanyFields)
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
          eq(workflowEvents.eventType, "strategy.role_assessed")
        )
      )
      .orderBy(desc(workflowEvents.revision))
      .limit(10001),
  ]);
  if ([jobRows, companyRows, assessmentRows].some(rows => rows.length > 10000))
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Strategy sources exceed the supported bound. No partial plan was returned.",
    });
  const companyById = new Map<string, any>(
      companyRows.map((c: any) => [c.id, c])
    ),
    assessments = new Map<string, any>();
  for (const a of assessmentRows) {
    if (!assessments.has(a.aggregateId)) {
      if (
        a.metadata.identity !==
        canonicalHash({
          fields: a.metadata.fields,
          sourceDigest: a.metadata.sourceDigest,
          strategyRevision: a.metadata.strategyRevision,
          reason: a.metadata.reason,
        })
      )
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Stored role assumptions do not match their recorded hash.",
        });
      strategyRoleFields.parse(a.metadata.fields);
      assessments.set(a.aggregateId, a);
    }
  }
  const model = modelRecruitmentStrategy(s.fields, now),
    base = model.scenarios[0],
    f = s.fields,
    planningEnabled =
      s.mode === "active" &&
      model.freshness === "current" &&
      !workspace?.emergencyStop;
  const roles = jobRows.map((job: any) => {
    const company = companyById.get(job.companyId),
      digest = sourceDigest(job, company),
      a = assessments.get(job.id),
      fields = a?.metadata.fields,
      issues: string[] = [];
    if (job.pipelineState !== "open") issues.push("role_not_open");
    if (
      !company ||
      ["suppressed", "do_not_contact"].includes(company.pipelineState)
    )
      issues.push("account_unavailable");
    if (!fields) issues.push("assessment_missing");
    else {
      if (a.metadata.sourceDigest !== digest) issues.push("source_changed");
      if (a.metadata.strategyRevision !== s.revision)
        issues.push("strategy_changed");
      if (fields.currency !== f.currency) issues.push("currency_mismatch");
      if (
        strategyFreshness(fields.reviewedOn, fields.freshnessDays, now) !==
        "current"
      )
        issues.push("assessment_stale_or_future");
      if (fields.targetFit !== "within_strategy")
        issues.push("target_scope_outside_or_unreviewed");
      if (fields.availableCandidates === 0)
        issues.push("supply_not_demonstrated");
    }
    let contribution: bigint | null = null,
      expectedCollectible: bigint | null = null;
    if (fields) {
      expectedCollectible =
        (BigInt(fields.feeMinor) *
          BigInt(fields.feasibilityBps) *
          BigInt(fields.placementBps) *
          BigInt(fields.collectionBps)) /
        10000n ** 3n;
      const labor =
        (BigInt(f.hourlyCostMinor) * BigInt(fields.deliveryMinutes) + 59n) /
        60n;
      contribution =
        expectedCollectible -
        BigInt(fields.variableCostMinor) -
        BigInt(f.sourcingCostPerPlacementMinor) -
        labor;
      if (contribution <= 0n) issues.push("nonpositive_modeled_contribution");
    }
    return {
      jobId: job.id,
      title: job.title,
      companyId: job.companyId,
      sourceDigest: digest,
      assessmentRevision: a?.revision ?? 0,
      assessment: fields ?? null,
      issues,
      modeledContributionMinor: contribution?.toString() ?? null,
      modeledCollectibleMinor: expectedCollectible?.toString() ?? null,
      eligible: issues.length === 0,
      allocated: false,
      allocationReason: "not_selected",
      evidenceLevel: "owner_assumptions",
    };
  });
  roles.sort((a: any, b: any) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.eligible) {
      const av =
          BigInt(a.modeledContributionMinor) *
          BigInt(b.assessment.deliveryMinutes),
        bv =
          BigInt(b.modeledContributionMinor) *
          BigInt(a.assessment.deliveryMinutes);
      if (av !== bv) return av > bv ? -1 : 1;
    }
    return a.jobId.localeCompare(b.jobId);
  });
  let remainingMinutes =
      f.availableMinutes - base.prospects * f.minutesPerProspect,
    remainingSourcing = BigInt(f.sourcingBudgetMinor),
    selected = 0;
  for (const role of roles) {
    if (!planningEnabled)
      role.allocationReason = "planning_inactive_stale_or_stopped";
    else if (!role.eligible) role.allocationReason = "review_blockers";
    else if (selected >= f.maxConcurrentRoles)
      role.allocationReason = "concurrent_role_cap";
    else if (role.assessment.deliveryMinutes > remainingMinutes)
      role.allocationReason = "delivery_minutes_cap";
    else if (BigInt(f.sourcingCostPerPlacementMinor) > remainingSourcing)
      role.allocationReason = "sourcing_budget_cap";
    else {
      role.allocated = true;
      role.allocationReason = "modeled_capacity_allocated";
      selected++;
      remainingMinutes -= role.assessment.deliveryMinutes;
      remainingSourcing -= BigInt(f.sourcingCostPerPlacementMinor);
    }
  }
  return {
    strategy: s,
    model,
    roles,
    workspace: workspace ?? null,
    plan: {
      planningEnabled,
      selectedRoles: selected,
      unallocatedMinutes: remainingMinutes,
      unallocatedSourcingMinor: remainingSourcing.toString(),
      dailyProspectPlanningCeiling: planningEnabled
        ? Math.min(
            base.dailyProspectCeiling,
            Math.max(0, workspace?.dailyOutboundLimit ?? 0)
          )
        : 0,
      policyCap: workspace?.dailyOutboundLimit ?? 0,
      workflowExecutionAuthorized: false,
      limits: [
        "Role estimates are owner assertions, not verified supply, calibrated probabilities or client payment verification.",
        "Role allocation and the aggregate acquisition funnel are separate scenarios, not additive revenue forecasts.",
        "Allocation is a deterministic greedy capacity proposal ranked by modeled contribution per delivery minute, not an optimal schedule or a hired-candidate ranking.",
        "Only canonical open roles on available accounts are eligible. Exact role/account and strategy revisions must still match.",
        "No task, lead, message, approval, invoice, candidate decision or budget-spend authorization is created.",
      ],
    },
  };
}
export async function recruitmentStrategyDashboard(
  ownerId: number,
  raw?: z.input<typeof strategyDashboardQuery>
) {
  const input = strategyDashboardQuery.parse(raw);
  return (await requireDb()).transaction(async (tx: any) => {
    const result = await strategyPlanInTransaction(tx, ownerId, new Date());
    return {
      ...result,
      totalRoles: result.roles.length,
      roles: result.roles.slice(input.offset, input.offset + input.limit),
      offset: input.offset,
      hasMore: input.offset + input.limit < result.roles.length,
    };
  });
}
export async function recruitmentStrategyHistory(ownerId: number) {
  const rows = await (
    await requireDb()
  )
    .select()
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.ownerId, ownerId),
        eq(workflowEvents.eventType, "strategy.version"),
        eq(workflowEvents.aggregateId, "owner:" + ownerId)
      )
    )
    .orderBy(desc(workflowEvents.revision))
    .limit(21);
  return {
    items: rows.slice(0, 20).map((r: any) => {
      if (
        r.metadata.stateHash !==
          canonicalHash({
            fields: r.metadata.fields,
            mode: r.metadata.mode,
            reason: r.metadata.reason,
          }) ||
        r.metadata.fieldsHash !== canonicalHash(r.metadata.fields)
      )
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Historical strategy assumptions do not match their recorded hash.",
        });
      return {
        revision: r.revision,
        mode: r.metadata.mode,
        fields: strategyFields.parse(r.metadata.fields),
        reason: r.metadata.reason,
        recordedAt: r.createdAt,
      };
    }),
    olderAvailable: rows.length > 20,
  };
}
