import { z } from "zod";
import { currencyPrecision } from "./money";
export const STRATEGY_VERSION = "recruitment-strategy-v1";
const minor = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,14})$/,
    "Use nonnegative integer minor units without separators."
  );
const positiveMinor = minor.refine(
  v => BigInt(v) > 0n,
  "A positive fee is required."
);
const bps = z.number().int().min(0).max(10000);
export const strategyDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(v => {
    const d = new Date(v + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Use a real calendar date.");
const tags = z
  .array(z.string().trim().min(1).max(120))
  .min(1)
  .max(20)
  .refine(
    a => new Set(a.map(v => v.toLowerCase())).size === a.length,
    "Remove duplicate entries."
  );
export const strategyFields = z
  .object({
    name: z.string().trim().min(3).max(160),
    niche: z.string().trim().min(3).max(500),
    industries: tags,
    regions: tags,
    roleFamilies: tags,
    idealClient: z.string().trim().min(8).max(2000),
    exclusions: z.string().trim().min(8).max(2000),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .refine(v => {
        try {
          currencyPrecision(v);
          return Intl.supportedValuesOf("currency").includes(v);
        } catch {
          return false;
        }
      }, "Use a supported currency code."),
    horizonWorkdays: z.number().int().min(1).max(90),
    availableMinutes: z.number().int().min(1).max(129600),
    maxConcurrentRoles: z.number().int().min(1).max(50),
    targetGrossMinor: minor,
    fee: z.discriminatedUnion("mode", [
      z
        .object({ mode: z.literal("fixed"), amountMinor: positiveMinor })
        .strict(),
      z
        .object({
          mode: z.literal("percentage"),
          rateBps: z.number().int().min(1).max(10000),
          annualSalaryMinor: positiveMinor,
        })
        .strict(),
    ]),
    minutesPerPlacement: z.number().int().min(1).max(129600),
    minutesPerProspect: z.number().int().min(1).max(480),
    plannedProspects: z.number().int().min(0).max(10000),
    replyBps: bps,
    replyToMandateBps: bps,
    mandateToPlacementBps: bps,
    collectionBps: bps,
    hourlyCostMinor: minor,
    fixedCostMinor: minor,
    variableCostPerPlacementMinor: minor,
    acquisitionBudgetMinor: minor,
    acquisitionCostPerProspectMinor: minor,
    sourcingBudgetMinor: minor,
    sourcingCostPerPlacementMinor: minor,
    reviewedOn: strategyDay,
    freshnessDays: z.number().int().min(1).max(90),
    assumptions: z.string().trim().min(8).max(4000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.availableMinutes > v.horizonWorkdays * 1440)
      ctx.addIssue({
        code: "custom",
        path: ["availableMinutes"],
        message: "Available minutes exceed the entire planning horizon.",
      });
  });
export type StrategyFields = z.infer<typeof strategyFields>;
export const strategySave = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    mode: z.enum(["draft", "active", "paused"]),
    fields: strategyFields,
    reason: z.string().trim().min(8).max(2000),
  })
  .strict();
export const strategyRoleFields = z
  .object({
    targetFit: z.enum(["within_strategy", "outside_strategy", "unreviewed"]),
    feeMinor: positiveMinor,
    currency: z.string().regex(/^[A-Z]{3}$/),
    availableCandidates: z.number().int().min(0).max(10000),
    feasibilityBps: bps,
    placementBps: bps,
    collectionBps: bps,
    deliveryMinutes: z.number().int().min(1).max(129600),
    variableCostMinor: minor,
    reviewedOn: strategyDay,
    freshnessDays: z.number().int().min(1).max(90),
    rationale: z.string().trim().min(8).max(2000),
  })
  .strict();
export const strategyRoleSave = z
  .object({
    jobId: z.string().min(1).max(64),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    strategyRevision: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    fields: strategyRoleFields,
    reason: z.string().trim().min(8).max(2000),
  })
  .strict();
export type StrategyRoleFields = z.infer<typeof strategyRoleFields>;
export const strategyDashboardQuery = z
  .object({
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict()
  .default({ offset: 0, limit: 25 });
