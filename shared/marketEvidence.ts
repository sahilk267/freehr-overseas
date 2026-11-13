import { z } from "zod";
import { strategyDay } from "./recruitmentStrategy";
export const MARKET_VERSION = "market-evidence-v1";
export const marketKind = z.enum([
  "hiring_demand",
  "salary_benchmark",
  "competition",
  "seasonality",
]);
export const publicEvidenceUrl = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine(v => {
    try {
      const u = new URL(v);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.port &&
        !u.search &&
        !u.hash &&
        u.hostname.replace(/\.$/, "").includes(".") &&
        !u.hostname.includes(":") &&
        !/^[\d.]+$/.test(u.hostname) &&
        !/(^|\.)(localhost|local|internal)$/.test(u.hostname.replace(/\.$/, ""))
      );
    } catch {
      return false;
    }
  }, "Use a public HTTPS citation without credentials, query, fragment or port.");
const timestamp = z
  .string()
  .datetime({ offset: true })
  .transform(v => new Date(v).toISOString());
const tag = z.string().trim().min(1).max(120);
export const marketPermissionFields = z
  .object({
    enabled: z.boolean(),
    allowedKinds: z
      .array(marketKind)
      .min(1)
      .max(4)
      .refine(a => new Set(a).size === a.length, "Remove duplicate kinds."),
    authorizedUse: z.literal("internal_recruitment_planning"),
    basis: z.enum(["owned_data", "provider_contract", "permitted_public_use"]),
    reference: z.string().trim().min(8).max(2000),
    termsUrl: publicEvidenceUrl,
    validFrom: timestamp,
    validUntil: timestamp,
    maxAgeDays: z.number().int().min(1).max(180),
  })
  .strict()
  .refine(
    v => v.validUntil > v.validFrom,
    "Permission expiry must follow its start."
  );
export const marketPermissionSave = z
  .object({
    sourceId: z.string().min(4).max(36),
    expectedRevision: z.number().int().nonnegative(),
    fields: marketPermissionFields,
    reason: z.string().trim().min(8).max(2000),
  })
  .strict();
const minor = z.string().regex(/^(0|[1-9]\d{0,14})$/);
const common = z.object({
  externalKey: z.string().trim().min(1).max(120),
  revision: z.number().int().min(1).max(1000000),
  previousDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  companyDomain: z.string().trim().min(3).max(255),
  roleFamily: tag,
  region: tag,
  industry: tag,
  observedAt: timestamp,
  sourceUrl: publicEvidenceUrl,
});
export const marketObservation = z
  .discriminatedUnion("kind", [
    common
      .extend({
        kind: z.literal("hiring_demand"),
        openings: z.number().int().min(0).max(1000000),
      })
      .strict(),
    common
      .extend({
        kind: z.literal("salary_benchmark"),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .refine(
            v => Intl.supportedValuesOf("currency").includes(v),
            "Use a supported currency."
          ),
        minMinor: minor,
        maxMinor: minor,
        period: z.enum(["annual", "monthly", "hourly"]),
        sampleSize: z.number().int().min(1).max(1000000),
        statistic: z.enum(["advertised_range", "survey_range"]),
      })
      .strict(),
    common
      .extend({
        kind: z.literal("competition"),
        competingEmployers: z.number().int().min(0).max(1000000),
        unfilledRoles: z.number().int().min(0).max(1000000),
      })
      .strict(),
    common
      .extend({
        kind: z.literal("seasonality"),
        periodStart: strategyDay,
        periodEnd: strategyDay,
        relativeTo: z.enum(["previous_period", "same_period_previous_year"]),
        demandIndexBps: z.number().int().min(0).max(100000),
      })
      .strict(),
  ])
  .superRefine((v, ctx) => {
    if (v.revision === 1 && v.previousDigest)
      ctx.addIssue({
        code: "custom",
        path: ["previousDigest"],
        message: "The first revision cannot claim an accepted predecessor.",
      });
    if (v.revision > 1 && !v.previousDigest)
      ctx.addIssue({
        code: "custom",
        path: ["previousDigest"],
        message: "Corrections require the prior accepted digest.",
      });
    if (
      v.kind === "salary_benchmark" &&
      BigInt(v.maxMinor) < BigInt(v.minMinor)
    )
      ctx.addIssue({
        code: "custom",
        path: ["maxMinor"],
        message: "Maximum salary must not be below minimum.",
      });
    if (v.kind === "seasonality" && v.periodEnd < v.periodStart)
      ctx.addIssue({
        code: "custom",
        path: ["periodEnd"],
        message: "Period end must follow start.",
      });
  });
export const marketBatch = z
  .object({
    batchKey: z.string().trim().min(8).max(80),
    permissionRevision: z.number().int().positive(),
    records: z.array(marketObservation).min(1).max(50),
  })
  .strict()
  .refine(
    v => new Set(v.records.map(r => r.externalKey)).size === v.records.length,
    "Each batch requires unique external record keys."
  );
export const marketPreviewInput = z
  .object({ sourceId: z.string().min(4).max(36), batch: marketBatch })
  .strict();
export const marketCommitInput = marketPreviewInput
  .extend({ previewHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const marketReadQuery = z
  .object({
    kind: z
      .enum([
        "all",
        "hiring_demand",
        "salary_benchmark",
        "competition",
        "seasonality",
      ])
      .default("all"),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict()
  .default({ kind: "all", offset: 0, limit: 25 });
export const marketRetire = z
  .object({
    id: z.string().min(4).max(64),
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(8).max(2000),
  })
  .strict();
export type MarketObservation = z.infer<typeof marketObservation>;
export type MarketPermission = z.infer<typeof marketPermissionFields>;
