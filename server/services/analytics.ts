import { TRPCError } from "@trpc/server";
import { asc, eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../../drizzle/schema";
import { requireDb } from "../db";
import { analyticsInput, analyticsCsvCell } from "../../shared/analytics";
import {
  buildAnalyticsReport,
  ANALYTICS_EVENTS,
  type AnalyticsData,
} from "./analyticsModel";
export const ANALYTICS_SOURCE_LIMIT = 10000;
const definitions = {
  companies: {
    table: schema.companies,
    fields: ["id", "ownerId", "pipelineState", "sourceType", "createdAt"],
  },
  jobs: {
    table: schema.jobs,
    fields: ["id", "ownerId", "companyId", "pipelineState", "createdAt"],
  },
  candidates: {
    table: schema.candidates,
    fields: ["id", "ownerId", "profileState", "sourceType", "createdAt"],
  },
  matches: {
    table: schema.matches,
    fields: ["id", "ownerId", "candidateId", "jobId", "status", "createdAt"],
  },
  shortlists: {
    table: schema.shortlists,
    fields: [
      "id",
      "ownerId",
      "candidateId",
      "companyId",
      "jobId",
      "status",
      "sharedAt",
      "viewedAt",
      "createdAt",
    ],
  },
  interviews: {
    table: schema.interviews,
    fields: [
      "id",
      "ownerId",
      "candidateId",
      "companyId",
      "jobId",
      "status",
      "scheduledAt",
      "completedAt",
      "createdAt",
    ],
  },
  placements: {
    table: schema.placements,
    fields: [
      "id",
      "ownerId",
      "candidateId",
      "companyId",
      "jobId",
      "status",
      "offerAcceptedAt",
      "joiningConfirmedAt",
      "replacementRequestedAt",
      "createdAt",
    ],
  },
  invoices: {
    table: schema.invoices,
    fields: [
      "id",
      "ownerId",
      "companyId",
      "placementId",
      "status",
      "currency",
      "amount",
      "taxAmount",
      "issuedAt",
      "dueAt",
      "createdAt",
    ],
  },
  payments: {
    table: schema.payments,
    fields: [
      "id",
      "ownerId",
      "invoiceId",
      "provider",
      "providerEventId",
      "amount",
      "currency",
      "status",
      "createdAt",
    ],
  },
  conversations: {
    table: schema.conversations,
    fields: [
      "id",
      "ownerId",
      "candidateId",
      "companyId",
      "jobId",
      "channel",
      "status",
      "createdAt",
    ],
  },
  messages: {
    table: schema.messages,
    fields: [
      "id",
      "ownerId",
      "conversationId",
      "direction",
      "status",
      "sentAt",
      "deliveredAt",
      "messageId",
      "inReplyTo",
      "references",
      "createdAt",
    ],
  },
  plans: {
    table: schema.followUpPlans,
    fields: [
      "id",
      "ownerId",
      "conversationId",
      "scenarioId",
      "status",
      "revision",
      "stepIndex",
      "createdAt",
    ],
  },
  dispatches: {
    table: schema.emailDispatches,
    fields: [
      "id",
      "ownerId",
      "messageId",
      "planId",
      "planRevision",
      "stepIndex",
      "recipientHash",
      "status",
      "claimedAt",
      "createdAt",
    ],
  },
  queue: {
    table: schema.automationQueue,
    fields: [
      "id",
      "ownerId",
      "jobType",
      "status",
      "payload",
      "attempts",
      "scheduledAt",
      "lockedAt",
      "createdAt",
    ],
  },
  usage: {
    table: schema.aiUsage,
    fields: [
      "id",
      "ownerId",
      "queueJobId",
      "taskType",
      "selectedModel",
      "status",
      "latencyMs",
      "createdAt",
    ],
  },
  approvals: {
    table: schema.approvals,
    fields: [
      "id",
      "ownerId",
      "resourceId",
      "resourceType",
      "actionType",
      "status",
      "payload",
      "actionedAt",
      "createdAt",
    ],
  },
  incidents: {
    table: schema.incidents,
    fields: ["id", "ownerId", "affectedResourceId", "status", "createdAt"],
  },
  audits: {
    table: schema.auditEvents,
    fields: [
      "id",
      "ownerId",
      "resourceId",
      "resourceType",
      "previousState",
      "nextState",
      "createdAt",
    ],
  },
  events: {
    table: schema.workflowEvents,
    fields: [
      "id",
      "ownerId",
      "aggregateId",
      "eventType",
      "revision",
      "metadata",
      "createdAt",
    ],
  },
} as const;
const selectedMetadata = (m: any) =>
  m && typeof m === "object"
    ? Object.fromEntries(
        [
          "invoiceId",
          "paymentId",
          "paymentIntentId",
          "mode",
          "amount",
          "currency",
          "status",
          "placementId",
          "candidateId",
          "jobId",
          "messageId",
          "emailPossessionVerified",
          "termsHash",
          "joinedAt",
          "approvalId",
          "source",
          "conversationId",
          "sourcePlacementId",
          "redacted",
        ]
          .filter(k => m[k] !== undefined)
          .map(k => [k, m[k]])
      )
    : null;
export async function analyticsInTransaction(
  tx: any,
  ownerId: number,
  raw: z.input<typeof analyticsInput>,
  asOf = new Date()
) {
  const input = analyticsInput.parse(raw),
    data: AnalyticsData = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const table = definition.table as any,
      columns = Object.fromEntries(
        definition.fields.map(key => [key, table[key]])
      );
    const limit =
      name === "events" || name === "audits" ? 30000 : ANALYTICS_SOURCE_LIMIT;
    const rows = await tx
      .select(columns)
      .from(table)
      .where(
        and(
          eq(table.ownerId, ownerId),
          ...(name === "events"
            ? [inArray(schema.workflowEvents.eventType, [...ANALYTICS_EVENTS])]
            : [])
        )
      )
      .orderBy(asc(table.id))
      .limit(limit + 1);
    if (rows.length > limit)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `The ${name} source exceeds the bounded report limit (${limit}). Use an indexed analytical read model before trusting totals; no partial report was returned.`,
      });
    data[name] = rows.map((row: any) =>
      name === "queue" || name === "approvals"
        ? {
            ...row,
            payload:
              row.payload && typeof row.payload === "object"
                ? Object.fromEntries(
                    [
                      "companyId",
                      "jobId",
                      "candidateId",
                      "placementId",
                      "sourcePlacementId",
                      "invoiceId",
                      "interviewId",
                      "planId",
                      "dispatchId",
                      "messageId",
                      "conversationId",
                    ]
                      .filter(k => typeof row.payload[k] === "string")
                      .map(k => [k, row.payload[k]])
                  )
                : {},
          }
        : name === "events"
          ? { ...row, metadata: selectedMetadata(row.metadata) }
          : row
    );
  }
  try {
    return buildAnalyticsReport(ownerId, input, data, asOf);
  } catch (error) {
    throw new TRPCError({
      code:
        error instanceof Error &&
        error.message === "Owned report scope was not found."
          ? "NOT_FOUND"
          : "BAD_REQUEST",
      message:
        error instanceof Error
          ? error.message
          : "Report sources could not be reconciled.",
    });
  }
}
export async function getAnalyticsReport(
  ownerId: number,
  input: z.input<typeof analyticsInput>
) {
  const db = await requireDb();
  return db.transaction((tx: any) =>
    analyticsInTransaction(tx, ownerId, input, new Date())
  );
}
export const analyticsExportInput = z
  .object({
    report: analyticsInput,
    expectedSourceDigest: z.string().length(64),
    section: z.enum(["finance", "receipts", "funnel", "followups", "workflow"]),
  })
  .strict();
export async function exportAnalyticsReport(
  ownerId: number,
  raw: z.input<typeof analyticsExportInput>
) {
  const input = analyticsExportInput.parse(raw),
    report = await getAnalyticsReport(ownerId, input.report);
  if (report.sourceDigest !== input.expectedSourceDigest)
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Source ledgers changed. Refresh the report before exporting current source rows.",
    });
  const rows = report.sources[input.section] as Record<string, unknown>[],
    headers = rows.length ? Object.keys(rows[0]) : ["No source rows"];
  const preamble = [
    ["Metric version", report.version],
    ["As of", report.asOf],
    ["Period from", report.window.from],
    ["Period to (exclusive)", report.window.to],
    ["Timezone", report.window.timezone],
    ["Source digest", report.sourceDigest],
    [
      "Evidence semantics",
      "Recorded source rows; no bank-clearing, independent identity or causal effect is inferred.",
    ],
  ]
    .map(row => row.map(analyticsCsvCell).join(","))
    .join("\r\n");
  return {
    fileName: `recruiting-${input.section}-${report.window.from.slice(0, 10)}.csv`,
    csv:
      preamble +
      "\r\n\r\n" +
      headers.map(analyticsCsvCell).join(",") +
      "\r\n" +
      rows
        .map(row => headers.map(key => analyticsCsvCell(row[key])).join(","))
        .join("\r\n"),
    sourceDigest: report.sourceDigest,
    rowCount: rows.length,
  };
}
export const analyticsOptionsInput = z
  .object({
    kind: z.enum(["company", "job"]),
    search: z.string().trim().max(80).default(""),
    companyId: z.string().min(4).max(36).optional(),
  })
  .strict();
export async function analyticsScopeOptions(
  ownerId: number,
  raw: z.input<typeof analyticsOptionsInput>
) {
  const input = analyticsOptionsInput.parse(raw),
    db = await requireDb(),
    { like } = await import("drizzle-orm"),
    pattern = "%" + input.search.replace(/[\\%_]/g, "\\$&") + "%";
  if (
    input.companyId &&
    !(
      await db
        .select({ id: schema.companies.id })
        .from(schema.companies)
        .where(
          and(
            eq(schema.companies.ownerId, ownerId),
            eq(schema.companies.id, input.companyId)
          )
        )
        .limit(1)
    )[0]
  )
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Owned client scope was not found.",
    });
  const rows =
    input.kind === "company"
      ? await db
          .select({ id: schema.companies.id, label: schema.companies.name })
          .from(schema.companies)
          .where(
            and(
              eq(schema.companies.ownerId, ownerId),
              ...(input.search ? [like(schema.companies.name, pattern)] : [])
            )
          )
          .orderBy(asc(schema.companies.name), asc(schema.companies.id))
          .limit(51)
      : await db
          .select({ id: schema.jobs.id, label: schema.jobs.title })
          .from(schema.jobs)
          .where(
            and(
              eq(schema.jobs.ownerId, ownerId),
              ...(input.companyId
                ? [eq(schema.jobs.companyId, input.companyId)]
                : []),
              ...(input.search ? [like(schema.jobs.title, pattern)] : [])
            )
          )
          .orderBy(asc(schema.jobs.title), asc(schema.jobs.id))
          .limit(51);
  return { rows: rows.slice(0, 50), more: rows.length > 50 };
}
