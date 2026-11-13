import {
  STRATEGY_VERSION,
  strategyFields,
  type StrategyFields,
} from "../../shared/recruitmentStrategy";
const SCALE = 1000000n;
const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const fixed = (micros: bigint) =>
  `${micros / SCALE}.${(micros % SCALE).toString().padStart(6, "0")}`;
export function strategyFreshness(
  reviewedOn: string,
  freshnessDays: number,
  now = new Date()
) {
  const day = now.toISOString().slice(0, 10),
    age =
      (new Date(day + "T00:00:00Z").getTime() -
        new Date(reviewedOn + "T00:00:00Z").getTime()) /
      86400000;
  return age < 0
    ? ("future" as const)
    : age > freshnessDays
      ? ("stale" as const)
      : ("current" as const);
}
export function strategyFee(f: StrategyFields) {
  return f.fee.mode === "fixed"
    ? BigInt(f.fee.amountMinor)
    : (BigInt(f.fee.annualSalaryMinor) * BigInt(f.fee.rateBps) + 5000n) /
        10000n;
}
export function modelRecruitmentStrategy(
  raw: StrategyFields,
  now = new Date()
) {
  const f = strategyFields.parse(raw),
    fee = strategyFee(f),
    freshness = strategyFreshness(f.reviewedOn, f.freshnessDays, now);
  const variants = [
    {
      key: "base",
      reply: 10000,
      placement: 10000,
      mandate: 10000,
      budget: 10000,
      effort: 10000,
    },
    {
      key: "low_response",
      reply: 5000,
      placement: 10000,
      mandate: 10000,
      budget: 10000,
      effort: 10000,
    },
    {
      key: "scarce_talent",
      reply: 10000,
      placement: 5000,
      mandate: 10000,
      budget: 10000,
      effort: 15000,
    },
    {
      key: "reduced_demand",
      reply: 10000,
      placement: 10000,
      mandate: 5000,
      budget: 10000,
      effort: 10000,
    },
    {
      key: "budget_cut",
      reply: 10000,
      placement: 10000,
      mandate: 10000,
      budget: 5000,
      effort: 10000,
    },
  ];
  const scenarios = variants.map(v => {
    const acquisitionBudget =
        (BigInt(f.acquisitionBudgetMinor) * BigInt(v.budget)) / 10000n,
      sourcingBudget =
        (BigInt(f.sourcingBudgetMinor) * BigInt(v.budget)) / 10000n;
    const perProspect = BigInt(f.acquisitionCostPerProspectMinor),
      perSource = BigInt(f.sourcingCostPerPlacementMinor);
    const budgetProspects =
      perProspect === 0n
        ? BigInt(f.plannedProspects)
        : acquisitionBudget / perProspect;
    const prospects = min(
      BigInt(f.plannedProspects),
      budgetProspects,
      BigInt(Math.floor(f.availableMinutes / f.minutesPerProspect))
    );
    const outreachMinutes = prospects * BigInt(f.minutesPerProspect),
      remainingMinutes = BigInt(f.availableMinutes) - outreachMinutes;
    const placementMinutes = ceil(
      BigInt(f.minutesPerPlacement) * BigInt(v.effort),
      10000n
    );
    const capacity = remainingMinutes / placementMinutes;
    const demandMicros =
      (prospects *
        BigInt(f.replyBps) *
        BigInt(v.reply) *
        BigInt(f.replyToMandateBps) *
        BigInt(v.mandate) *
        BigInt(f.mandateToPlacementBps) *
        BigInt(v.placement) *
        SCALE) /
      10000n ** 6n;
    const fundedMicros =
      perSource === 0n
        ? capacity * SCALE
        : (sourcingBudget * SCALE) / perSource;
    const placementMicros = min(demandMicros, capacity * SCALE, fundedMicros);
    const expectedGross = (fee * placementMicros) / SCALE,
      expectedCollectible = (expectedGross * BigInt(f.collectionBps)) / 10000n;
    const costAcquisition = prospects * perProspect,
      costSourcing = ceil(perSource * placementMicros, SCALE),
      costVariable = ceil(
        BigInt(f.variableCostPerPlacementMinor) * placementMicros,
        SCALE
      );
    const laborMinutes =
        outreachMinutes + ceil(placementMinutes * placementMicros, SCALE),
      costLabor = ceil(BigInt(f.hourlyCostMinor) * laborMinutes, 60n);
    const totalCost =
      BigInt(f.fixedCostMinor) +
      costAcquisition +
      costSourcing +
      costVariable +
      costLabor;
    const requiredPlacements =
      fee > 0n ? ceil(BigInt(f.targetGrossMinor), fee) : null;
    const unitContribution =
      (fee * BigInt(f.collectionBps)) / 10000n -
      BigInt(f.variableCostPerPlacementMinor) -
      perSource -
      ceil(BigInt(f.hourlyCostMinor) * placementMinutes, 60n);
    const breakEven =
      unitContribution > 0n
        ? ceil(
            BigInt(f.fixedCostMinor) +
              costAcquisition +
              ceil(BigInt(f.hourlyCostMinor) * outreachMinutes, 60n),
            unitContribution
          )
        : null;
    const reasons: string[] = [];
    if (freshness !== "current") reasons.push("assumptions_" + freshness);
    if (fee <= 0n) reasons.push("no_positive_modeled_fee");
    if (prospects < BigInt(f.plannedProspects))
      reasons.push("prospect_budget_or_time_cap");
    if (demandMicros > capacity * SCALE) reasons.push("delivery_capacity_cap");
    if (demandMicros > fundedMicros) reasons.push("sourcing_budget_cap");
    if (expectedGross < BigInt(f.targetGrossMinor))
      reasons.push("modeled_revenue_below_target");
    if (expectedCollectible < totalCost)
      reasons.push("negative_modeled_contribution");
    if (placementMicros === 0n) reasons.push("no_modeled_placements");
    return {
      key: v.key,
      prospects: Number(prospects),
      dailyProspectCeiling: Number(ceil(prospects, BigInt(f.horizonWorkdays))),
      deliveryCapacity: Number(capacity),
      expectedPlacements: fixed(placementMicros),
      grossMinor: expectedGross.toString(),
      collectibleMinor: expectedCollectible.toString(),
      costs: {
        acquisitionMinor: costAcquisition.toString(),
        sourcingMinor: costSourcing.toString(),
        variableMinor: costVariable.toString(),
        laborMinor: costLabor.toString(),
        fixedMinor: f.fixedCostMinor,
        totalMinor: totalCost.toString(),
      },
      contributionMinor: (expectedCollectible - totalCost).toString(),
      requiredPlacements: requiredPlacements?.toString() ?? null,
      breakEvenPlacements: breakEven?.toString() ?? null,
      modeledMinutes: Number(laborMinutes),
      reasons,
    };
  });
  return {
    version: STRATEGY_VERSION,
    currency: f.currency,
    freshness,
    feeMinor: fee.toString(),
    horizonWorkdays: f.horizonWorkdays,
    targetGrossMinor: f.targetGrossMinor,
    scenarios,
    evidenceLevel: "owner_assumptions" as const,
    marketEvidence: "unavailable" as const,
    workflowExecutionAuthorized: false as const,
    limitations: [
      "These are deterministic scenarios from owner-entered assumptions, not observed market probabilities, actual revenue, bank-cleared cash or guaranteed earnings.",
      "Planning workdays are a declared horizon, not a dated calendar or an authorization to contact anybody.",
      "Acquisition/sourcing budgets cap only the modeled category; fixed, variable and labor costs are additional. Zero unit costs are explicit owner assumptions.",
      "The daily prospect ceiling is a planning envelope, not a per-day contact authorization or a task distribution schedule.",
      "No tax, currency conversion, financing cost, payment timing or replacement loss is inferred. Use canonical contracts, invoices and receipts for actual obligations.",
    ],
  };
}
