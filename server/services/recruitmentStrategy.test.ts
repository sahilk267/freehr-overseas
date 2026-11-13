import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import {
  strategyFields,
  strategyRoleFields,
  type StrategyFields,
} from "../../shared/recruitmentStrategy";
import { modelRecruitmentStrategy, strategyFreshness } from "./strategyModel";
import {
  recruitmentStrategyDashboard,
  recruitmentStrategyHistory,
  saveRecruitmentStrategy,
  saveStrategyRole,
  strategyPlanInTransaction,
} from "./recruitmentStrategy";
import { ownerOverview } from "./ownerBrief";
import { followupFixture } from "../testSupport/followupFixture";
import { createId, requireDb } from "../db";
const today = () => new Date().toISOString().slice(0, 10);
const fields = (overrides: Partial<StrategyFields> = {}): StrategyFields =>
  strategyFields.parse({
    name: "Test strategy",
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
    reviewedOn: today(),
    freshnessDays: 14,
    assumptions: "Synthetic owner-entered assumptions; no market verification.",
    ...overrides,
  });
const owners: number[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const ownerId of owners.splice(0))
    await (await requireDb())
      .update(schema.workspaceSettings)
      .set({ backgroundEnabled: false })
      .where(eq(schema.workspaceSettings.ownerId, ownerId));
});
async function fixture() {
  const f = await followupFixture();
  owners.push(f.ownerId);
  return f;
}
async function save(
  f: any,
  overrides: Partial<StrategyFields> = {},
  mode: "active" | "draft" | "paused" = "active"
) {
  const d = await recruitmentStrategyDashboard(f.ownerId);
  return saveRecruitmentStrategy(f.ownerId, f.ownerId, {
    expectedRevision: d.strategy.revision,
    fields: fields(overrides),
    mode,
    reason: "Record synthetic recruitment planning assumptions.",
  });
}
function assessment(currency = "INR") {
  return strategyRoleFields.parse({
    targetFit: "within_strategy",
    feeMinor: "10000",
    currency,
    availableCandidates: 3,
    feasibilityBps: 10000,
    placementBps: 10000,
    collectionBps: 10000,
    deliveryMinutes: 100,
    variableCostMinor: "300",
    reviewedOn: today(),
    freshnessDays: 7,
    rationale:
      "Owner-reported supply and economics; not independently verified.",
  });
}
async function roleInput(f: any, jobId = f.jobId) {
  const d = await recruitmentStrategyDashboard(f.ownerId);
  const r = d.roles.find((r: any) => r.jobId === jobId)!;
  return {
    jobId,
    sourceDigest: r.sourceDigest,
    strategyRevision: d.strategy.revision,
    expectedRevision: r.assessmentRevision,
    fields: assessment(),
    reason: "Record source-bound role assumptions for capacity review.",
  };
}
describe("exact recruitment economics and scenario constraints", () => {
  it("separates modeled gross, collection probability, category costs and contribution", () => {
    const m = modelRecruitmentStrategy(fields());
    expect(m.scenarios[0]).toMatchObject({
      prospects: 10,
      expectedPlacements: "5.000000",
      grossMinor: "50000",
      collectibleMinor: "40000",
      costs: {
        acquisitionMinor: "1000",
        sourcingMinor: "500",
        variableMinor: "1000",
        laborMinor: "5500",
        fixedMinor: "500",
        totalMinor: "8500",
      },
      contributionMinor: "31500",
      requiredPlacements: "5",
      breakEvenPlacements: "1",
      modeledMinutes: 550,
      deliveryCapacity: 5,
    });
    expect(m.workflowExecutionAuthorized).toBe(false);
    expect(m.marketEvidence).toBe("unavailable");
  });
  it("rounds percentage fees once in integer minor units, including a half-unit boundary", () => {
    expect(
      modelRecruitmentStrategy(
        fields({
          fee: { mode: "percentage", rateBps: 500, annualSalaryMinor: "10010" },
        })
      ).feeMinor
    ).toBe("501");
  });
  it("retains amounts beyond Number precision without floating-point money", () => {
    const m = modelRecruitmentStrategy(
      fields({
        fee: { mode: "fixed", amountMinor: "999999999999999" },
        plannedProspects: 1000,
        minutesPerProspect: 1,
        availableMinutes: 7200,
        minutesPerPlacement: 1,
        acquisitionCostPerProspectMinor: "0",
        sourcingCostPerPlacementMinor: "0",
        mandateToPlacementBps: 10000,
      })
    );
    expect(m.scenarios[0].grossMinor).toBe("999999999999999000");
  });
  it("models zero conversion without inventing placements or reducing fixed costs to zero", () => {
    const s = modelRecruitmentStrategy(fields({ replyBps: 0 })).scenarios[0];
    expect(s.expectedPlacements).toBe("0.000000");
    expect(s.grossMinor).toBe("0");
    expect(BigInt(s.contributionMinor)).toBeLessThan(0n);
    expect(s.reasons).toContain("no_modeled_placements");
  });
  it("caps acquisition by both budget and available time", () => {
    const s = modelRecruitmentStrategy(
      fields({ acquisitionBudgetMinor: "250", availableMinutes: 6 })
    ).scenarios[0];
    expect(s.prospects).toBe(1);
    expect(s.deliveryCapacity).toBe(0);
    expect(s.modeledMinutes).toBeLessThanOrEqual(6);
    expect(s.reasons).toContain("prospect_budget_or_time_cap");
  });
  it("caps sourcing without overspending the modeled source budget at fractional placements", () => {
    const s = modelRecruitmentStrategy(fields({ sourcingBudgetMinor: "150" }))
      .scenarios[0];
    expect(s.expectedPlacements).toBe("1.500000");
    expect(s.costs.sourcingMinor).toBe("150");
    expect(s.reasons).toContain("sourcing_budget_cap");
  });
  it("models explicit stress variants rather than labelling them observed market forecasts", () => {
    const m = modelRecruitmentStrategy(fields());
    expect(m.scenarios.map(s => s.key)).toEqual([
      "base",
      "low_response",
      "scarce_talent",
      "reduced_demand",
      "budget_cut",
    ]);
    expect(m.scenarios[1].expectedPlacements).toBe("2.500000");
    expect(m.scenarios[2].expectedPlacements).toBe("2.500000");
    expect(m.scenarios[3].expectedPlacements).toBe("2.500000");
    expect(m.scenarios[4].prospects).toBe(5);
  });
  it("makes contribution break-even unavailable when collection-adjusted unit economics are nonpositive", () => {
    expect(
      modelRecruitmentStrategy(fields({ collectionBps: 0 })).scenarios[0]
        .breakEvenPlacements
    ).toBeNull();
  });
  it("flags a fee that rounds to zero without a division error", () => {
    const m = modelRecruitmentStrategy(
      fields({
        fee: { mode: "percentage", rateBps: 1, annualSalaryMinor: "1" },
      })
    );
    expect(m.scenarios[0].requiredPlacements).toBeNull();
    expect(m.scenarios[0].reasons).toContain("no_positive_modeled_fee");
  });
  it("uses explicit UTC calendar-day freshness including future dates", () => {
    const now = new Date("2026-11-13T23:59:00Z");
    expect(strategyFreshness("2026-11-06", 7, now)).toBe("current");
    expect(strategyFreshness("2026-11-05", 7, now)).toBe("stale");
    expect(strategyFreshness("2026-11-14", 7, now)).toBe("future");
  });
  it.each(["-1", "1.5", "01", "1000000000000000"])(
    "rejects invalid integer money %s",
    value => {
      expect(
        strategyFields.safeParse({ ...fields(), fixedCostMinor: value }).success
      ).toBe(false);
    }
  );
  it("rejects duplicate niches, impossible work capacity, invalid dates and unknown currencies", () => {
    for (const change of [
      { industries: ["Software", "software"] },
      { horizonWorkdays: 1, availableMinutes: 1441 },
      { reviewedOn: "2026-02-30" },
      { currency: "ZZZ" },
    ])
      expect(strategyFields.safeParse({ ...fields(), ...change }).success).toBe(
        false
      );
  });
});
describe("versioned source-bound strategy and capacity proposals", () => {
  it("defaults to no configuration and records no new workflow or provider action on read", async () => {
    const f = await fixture(),
      d = await recruitmentStrategyDashboard(f.ownerId);
    expect(d.strategy.revision).toBe(0);
    expect(d.plan).toBeNull();
    expect(
      await f.db
        .select()
        .from(schema.automationQueue)
        .where(eq(schema.automationQueue.ownerId, f.ownerId))
    ).toHaveLength(0);
  });
  it("saves one version on exact retries and preserves historical assumptions", async () => {
    const f = await fixture(),
      input = {
        expectedRevision: 0,
        fields: fields(),
        mode: "draft" as const,
        reason: "First reviewed synthetic planning assumptions.",
      };
    const one = await saveRecruitmentStrategy(f.ownerId, f.ownerId, input);
    expect(
      await saveRecruitmentStrategy(f.ownerId, f.ownerId, input)
    ).toMatchObject({ revision: one.revision, alreadySaved: true });
    await save(f, { targetGrossMinor: "60000" }, "paused");
    const h = await recruitmentStrategyHistory(f.ownerId);
    expect(h.items.map(i => i.revision)).toEqual([2, 1]);
    expect(h.items[1].fields.targetGrossMinor).toBe("50000");
  });
  it("rejects stale strategy edits without changing the current version", async () => {
    const f = await fixture();
    await save(f);
    await expect(
      saveRecruitmentStrategy(f.ownerId, f.ownerId, {
        expectedRevision: 0,
        fields: fields({ name: "Conflicting strategy" }),
        mode: "active",
        reason: "Do not overwrite another planning version.",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await recruitmentStrategyDashboard(f.ownerId)).strategy.revision
    ).toBe(1);
  });
  it("rejects activation of stale/future assumptions and zero rounded fees", async () => {
    const f = await fixture();
    for (const changes of [
      { reviewedOn: "2000-01-01" },
      { reviewedOn: "2099-01-01" },
      {
        fee: {
          mode: "percentage" as const,
          rateBps: 1,
          annualSalaryMinor: "1",
        },
      },
    ])
      await expect(save(f, changes)).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    expect(
      (await recruitmentStrategyDashboard(f.ownerId)).strategy.revision
    ).toBe(0);
  });
  it("allocates a source-bound open role without creating contacts, queue tasks or financial state", async () => {
    const f = await fixture();
    await save(f);
    const input = await roleInput(f);
    await saveStrategyRole(f.ownerId, f.ownerId, input);
    const d = await recruitmentStrategyDashboard(f.ownerId);
    expect(d.plan?.selectedRoles).toBe(1);
    expect(d.roles[0]).toMatchObject({
      allocated: true,
      evidenceLevel: "owner_assumptions",
      modeledContributionMinor: "8600",
    });
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
  it("reuses an exact role assessment retry and rejects competing stale assumptions", async () => {
    const f = await fixture();
    await save(f);
    const input = await roleInput(f);
    await saveStrategyRole(f.ownerId, f.ownerId, input);
    expect(await saveStrategyRole(f.ownerId, f.ownerId, input)).toMatchObject({
      alreadySaved: true,
      revision: 1,
    });
    await expect(
      saveStrategyRole(f.ownerId, f.ownerId, {
        ...input,
        fields: { ...input.fields, availableCandidates: 4 },
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("invalidates proposals when current role/account source changes", async () => {
    const f = await fixture();
    await save(f);
    const input = await roleInput(f);
    await saveStrategyRole(f.ownerId, f.ownerId, input);
    await f.db
      .update(schema.jobs)
      .set({ requirementQuality: 90 })
      .where(eq(schema.jobs.id, f.jobId));
    const d = await recruitmentStrategyDashboard(f.ownerId);
    expect(d.roles[0].issues).toContain("source_changed");
    expect(d.roles[0].allocated).toBe(false);
    await expect(
      saveStrategyRole(f.ownerId, f.ownerId, { ...input, expectedRevision: 1 })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("invalidates assessments on any new strategy version until deliberate review", async () => {
    const f = await fixture();
    await save(f);
    await saveStrategyRole(f.ownerId, f.ownerId, await roleInput(f));
    await save(f, { maxConcurrentRoles: 1 });
    const d = await recruitmentStrategyDashboard(f.ownerId);
    expect(d.roles[0].issues).toContain("strategy_changed");
    expect(d.plan?.selectedRoles).toBe(0);
  });
  it("does not allocate missing, zero-supply, nonpositive or stale assessments", async () => {
    const f = await fixture();
    await save(f);
    expect(
      (await recruitmentStrategyDashboard(f.ownerId)).roles[0].issues
    ).toContain("assessment_missing");
    for (const changes of [
      { targetFit: "outside_strategy" as const },
      { availableCandidates: 0 },
      { feeMinor: "1" },
      { reviewedOn: "2000-01-01" },
    ]) {
      const input = await roleInput(f);
      await saveStrategyRole(f.ownerId, f.ownerId, {
        ...input,
        fields: { ...assessment(), ...changes },
      });
      expect(
        (await recruitmentStrategyDashboard(f.ownerId)).plan?.selectedRoles
      ).toBe(0);
    }
  });
  it("rejects cross-currency and future-dated role assertions", async () => {
    const f = await fixture();
    await save(f);
    const input = await roleInput(f);
    for (const changes of [{ currency: "USD" }, { reviewedOn: "2099-01-01" }])
      await expect(
        saveStrategyRole(f.ownerId, f.ownerId, {
          ...input,
          fields: { ...input.fields, ...changes },
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("keeps drafts, pauses and emergency stop from allocating roles or contact envelopes", async () => {
    const f = await fixture();
    await save(f, {}, "draft");
    await saveStrategyRole(f.ownerId, f.ownerId, await roleInput(f));
    expect(
      (await recruitmentStrategyDashboard(f.ownerId)).plan?.selectedRoles
    ).toBe(0);
    await save(f);
    await saveStrategyRole(f.ownerId, f.ownerId, await roleInput(f));
    await f.db
      .update(schema.workspaceSettings)
      .set({ emergencyStop: true })
      .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
    const d = await recruitmentStrategyDashboard(f.ownerId);
    expect(d.plan).toMatchObject({
      selectedRoles: 0,
      dailyProspectPlanningCeiling: 0,
      workflowExecutionAuthorized: false,
    });
  });
  it("caps proposed daily acquisition by the canonical workspace limit", async () => {
    const f = await fixture();
    await save(f);
    await f.db
      .update(schema.workspaceSettings)
      .set({ dailyOutboundLimit: 1 })
      .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
    expect(
      (await recruitmentStrategyDashboard(f.ownerId)).plan
        ?.dailyProspectPlanningCeiling
    ).toBe(1);
  });
  it("ranks by exact contribution per minute then applies the full capacity before pagination", async () => {
    const f = await fixture();
    await save(f, { maxConcurrentRoles: 1 });
    const second = createId("job_");
    await f.db.insert(schema.jobs).values({
      id: second,
      ownerId: f.ownerId,
      companyId: f.companyId,
      title: "Second synthetic role",
      pipelineState: "open",
    });
    await saveStrategyRole(f.ownerId, f.ownerId, await roleInput(f));
    const input = await roleInput(f, second);
    await saveStrategyRole(f.ownerId, f.ownerId, {
      ...input,
      fields: { ...input.fields, feeMinor: "15000", deliveryMinutes: 200 },
    });
    const all = await recruitmentStrategyDashboard(f.ownerId),
      page = await recruitmentStrategyDashboard(f.ownerId, {
        offset: 1,
        limit: 1,
      });
    expect(all.roles[0].jobId).toBe(f.jobId);
    expect(page.roles[0].allocated).toBe(false);
    expect(page.roles[0].allocationReason).toBe("concurrent_role_cap");
    expect(page.plan?.selectedRoles).toBe(1);
    expect(page.totalRoles).toBe(2);
  });
  it("excludes closed roles and unavailable accounts and denies saving into them", async () => {
    const f = await fixture();
    await save(f);
    const input = await roleInput(f);
    await f.db
      .update(schema.companies)
      .set({ pipelineState: "suppressed" })
      .where(eq(schema.companies.id, f.companyId));
    let d = await recruitmentStrategyDashboard(f.ownerId);
    expect(d.roles[0].issues).toContain("account_unavailable");
    await expect(
      saveStrategyRole(f.ownerId, f.ownerId, {
        ...input,
        sourceDigest: d.roles[0].sourceDigest,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await f.db
      .update(schema.jobs)
      .set({ pipelineState: "filled" })
      .where(eq(schema.jobs.id, f.jobId));
    d = await recruitmentStrategyDashboard(f.ownerId);
    expect(d.roles[0].issues).toContain("role_not_open");
  });
  it("isolates workspace strategies and source role access", async () => {
    const a = await fixture(),
      b = await fixture();
    await save(a);
    await save(b);
    const input = await roleInput(a);
    await expect(
      saveStrategyRole(b.ownerId, b.ownerId, input)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await recruitmentStrategyDashboard(b.ownerId)).roles.every(
        (r: any) => r.jobId !== a.jobId
      )
    ).toBe(true);
    expect((await recruitmentStrategyHistory(b.ownerId)).items).toHaveLength(1);
  });
  it("only adds nonfinancial status to existing operating briefs, without notes or forecast receipts", async () => {
    const f = await fixture();
    await save(f, {
      assumptions: "PRIVATE_STRATEGY_NOTE_MARKER owner assertions only.",
    });
    const brief = await ownerOverview(f.ownerId, {
      kind: "all",
      offset: 0,
      limit: 25,
    });
    expect(brief.summary.strategy).toMatchObject({
      mode: "active",
      evidenceLevel: "owner_assumptions",
      workflowExecutionAuthorized: false,
    });
    expect(JSON.stringify(brief.summary)).not.toContain(
      "PRIVATE_STRATEGY_NOTE_MARKER"
    );
    expect(JSON.stringify(brief.summary.strategy)).not.toContain("grossMinor");
  });
  it("fails closed on altered persisted strategy and role evidence", async () => {
    const f = await fixture();
    await save(f);
    await saveStrategyRole(f.ownerId, f.ownerId, await roleInput(f));
    const row = (
      await f.db
        .select()
        .from(schema.workflowEvents)
        .where(
          and(
            eq(schema.workflowEvents.ownerId, f.ownerId),
            eq(schema.workflowEvents.eventType, "strategy.role_assessed")
          )
        )
    )[0];
    await f.db
      .update(schema.workflowEvents)
      .set({
        metadata: {
          ...(row.metadata as any),
          fields: { ...(row.metadata as any).fields, feeMinor: "999999" },
        },
      })
      .where(eq(schema.workflowEvents.id, row.id));
    await expect(recruitmentStrategyDashboard(f.ownerId)).rejects.toMatchObject(
      { code: "PRECONDITION_FAILED" }
    );
  });
  it("fails closed rather than ranking a truncated role source", async () => {
    const f = await fixture();
    await save(f);
    const tx = {
      select: (projection?: any) => ({
        from: (table: any) =>
          table === schema.jobs
            ? {
                where: () => ({
                  orderBy: () => ({ limit: async () => Array(10001).fill({}) }),
                }),
              }
            : f.db.select(projection).from(table),
      }),
    };
    await expect(
      strategyPlanInTransaction(tx, f.ownerId, new Date())
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("applies delivery-minute and sourcing-budget limits across all proposed roles", async () => {
    const f = await fixture();
    await save(f, { plannedProspects: 0, availableMinutes: 150 });
    const second = createId("job_");
    await f.db
      .insert(schema.jobs)
      .values({
        id: second,
        ownerId: f.ownerId,
        companyId: f.companyId,
        title: "Capacity boundary role",
        pipelineState: "open",
      });
    for (const id of [f.jobId, second])
      await saveStrategyRole(f.ownerId, f.ownerId, await roleInput(f, id));
    let d = await recruitmentStrategyDashboard(f.ownerId);
    expect(d.plan?.selectedRoles).toBe(1);
    expect(
      d.roles.some((r: any) => r.allocationReason === "delivery_minutes_cap")
    ).toBe(true);
    await save(f, {
      plannedProspects: 0,
      availableMinutes: 300,
      sourcingBudgetMinor: "100",
    });
    for (const id of [f.jobId, second])
      await saveStrategyRole(f.ownerId, f.ownerId, await roleInput(f, id));
    d = await recruitmentStrategyDashboard(f.ownerId);
    expect(d.plan?.selectedRoles).toBe(1);
    expect(
      d.roles.some((r: any) => r.allocationReason === "sourcing_budget_cap")
    ).toBe(true);
    expect(d.plan?.unallocatedSourcingMinor).toBe("0");
  });
  it("invalidates role economics when the canonical compensation budget changes", async () => {
    const f = await fixture();
    await save(f);
    await saveStrategyRole(f.ownerId, f.ownerId, await roleInput(f));
    await f.db
      .update(schema.jobs)
      .set({ compensationMax: 900000 })
      .where(eq(schema.jobs.id, f.jobId));
    const d = await recruitmentStrategyDashboard(f.ownerId);
    expect(d.roles[0].issues).toContain("source_changed");
    expect(d.plan?.selectedRoles).toBe(0);
  });
  it("detects altered planning authority as well as changed financial assumptions", async () => {
    const f = await fixture();
    await save(f, {}, "draft");
    const row = (
      await f.db
        .select()
        .from(schema.workflowEvents)
        .where(
          and(
            eq(schema.workflowEvents.ownerId, f.ownerId),
            eq(schema.workflowEvents.eventType, "strategy.version")
          )
        )
    )[0];
    await f.db
      .update(schema.workflowEvents)
      .set({ metadata: { ...(row.metadata as any), mode: "active" } })
      .where(eq(schema.workflowEvents.id, row.id));
    await expect(recruitmentStrategyDashboard(f.ownerId)).rejects.toMatchObject(
      { code: "PRECONDITION_FAILED" }
    );
    await expect(recruitmentStrategyHistory(f.ownerId)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
  it("denies anonymous planning reads and mutations through the normal workspace guard", async () => {
    const { appRouter } = await import("../routers"),
      anon = appRouter.createCaller({
        user: null,
        req: { headers: {} },
        res: {},
      } as any);
    await expect(anon.recruitmentStrategy.dashboard()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      anon.recruitmentStrategy.preview(fields())
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anon.recruitmentStrategy.save({
        expectedRevision: 0,
        fields: fields(),
        mode: "draft",
        reason: "Anonymous writes must remain denied.",
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anon.recruitmentStrategy.assessRole({
        jobId: "not-owned",
        sourceDigest: "0".repeat(64),
        strategyRevision: 1,
        expectedRevision: 0,
        fields: assessment(),
        reason: "Anonymous assertions must be denied.",
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.recruitmentStrategy.history()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")(
    "serializes competing strategy versions using the existing SQL workspace lock",
    async () => {
      const f = await fixture();
      const results = await Promise.allSettled([
        saveRecruitmentStrategy(f.ownerId, f.ownerId, {
          expectedRevision: 0,
          fields: fields(),
          mode: "draft",
          reason: "Concurrent draft number one.",
        }),
        saveRecruitmentStrategy(f.ownerId, f.ownerId, {
          expectedRevision: 0,
          fields: fields({ name: "Competing strategy" }),
          mode: "draft",
          reason: "Concurrent draft number two.",
        }),
      ]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (results.find(r => r.status === "rejected") as PromiseRejectedResult)
          .reason.code
      ).toBe("CONFLICT");
      expect((await recruitmentStrategyHistory(f.ownerId)).items).toHaveLength(
        1
      );
    }
  );
});
