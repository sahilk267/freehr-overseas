import { z } from "zod";
import { isValidTimezone } from "./dateTime";
import { currencyPrecision } from "./money";
export const ANALYTICS_VERSION = "operational-ledgers-v1";
export const analyticsInput = z
  .object({
    from: z.date(),
    to: z.date(),
    timezone: z
      .string()
      .min(2)
      .max(64)
      .refine(isValidTimezone)
      .default("Asia/Kolkata"),
    companyId: z.string().min(4).max(36).optional(),
    jobId: z.string().min(4).max(36).optional(),
    replyWindowHours: z.number().int().min(1).max(168).default(72),
  })
  .strict();
export const ANALYTICS_DEFINITIONS = [
  {
    id: "inventory",
    unit: "distinct source records",
    basis:
      "Current snapshot at report generation; period-created records are separate cohorts.",
    limitation:
      "Statuses describe recorded internal state, not independent client/candidate acceptance.",
  },
  {
    id: "placement_cohort",
    unit: "distinct placements created in the selected period",
    basis:
      "Only exact placement-linked offer, joining and invoice/payment facts are compared.",
    limitation:
      "This is a placement-record cohort, not a lead-to-hire causal conversion rate.",
  },
  {
    id: "recorded_receipts",
    unit: "currency minor units",
    basis:
      "Succeeded canonical payment rows, joined to the exact owned invoice and currency.",
    limitation:
      "Recorded receipts are not verified bank clearing. Different currencies remain separate.",
  },
  {
    id: "provider_verified",
    unit: "currency minor units",
    basis:
      "Exact live provider receipt, observed amount/currency and canonical payment source agree.",
    limitation:
      "Sandbox, manual records and reconciliation observations do not establish live provider receipt or bank clearing.",
  },
  {
    id: "followup_reply_association",
    unit: "logical accepted steps",
    basis:
      "Explicit reply references take precedence; otherwise an inbound record associates once with the latest preceding accepted dispatch in the same thread and bounded ingestion window.",
    limitation:
      "Inbound createdAt is an ingestion timestamp, not verified message arrival; imported history can affect the association. Descriptive association only; no incremental conversion or causal credit is inferred. Immature windows remain separate.",
  },
  {
    id: "stage_duration",
    unit: "elapsed hours",
    basis:
      "Two consistent audited transitions bound a completed interval; current-state age requires a matching last transition.",
    limitation:
      "Unknown or broken history stays unknown; updatedAt is never treated as a stage-entry date.",
  },
  {
    id: "workflow_health",
    unit: "source tasks and observed inference attempts",
    basis: "Current queue due/blocked/lease states and period AI usage rows.",
    limitation:
      "Model factuality, actual monetary cost and effort saved need separate measured evidence; they are unavailable here.",
  },
] as const;
/** Integer totals may exceed Number.MAX_SAFE_INTEGER; never round them through floating point. */
export function formatAnalyticsMoney(value: string, currency: string) {
  if (!/^-?\d+$/.test(value)) throw Error("Invalid integer monetary total.");
  const amount = BigInt(value),
    negative = amount < 0n,
    absolute = negative ? -amount : amount,
    precision = currencyPrecision(currency),
    scale = 10n ** BigInt(precision),
    whole = absolute / scale,
    fraction = (absolute % scale).toString().padStart(precision, "0");
  const parts = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
  }).formatToParts(negative ? -whole : whole);
  const result = parts
    .map(p => (p.type === "fraction" ? fraction : p.value))
    .join("");
  return negative && whole === 0n ? "-" + result : result;
}
export const analyticsCsvCell = (value: unknown) => {
  let s = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(s) && !/^-[0-9]+(?:\.[0-9]+)?$/.test(s))
    s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};
