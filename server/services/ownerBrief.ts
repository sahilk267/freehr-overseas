import { strategyBriefInTransaction } from "./recruitmentStrategy";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import {
  approvals,
  automationQueue,
  incidents,
  followUpPlans,
  workflowEvents,
  workspaceSettings,
} from "../../drizzle/schema";
import {
  ownerBriefFields,
  ownerBriefConfigure,
  ownerBriefQuery,
  OWNER_BRIEF_VERSION,
  type OwnerBriefFields,
} from "../../shared/ownerBrief";
import { zonedDateTimeToUtc } from "../../shared/dateTime";
import { createId, recordAudit, requireDb } from "../db";
import { withWorkspaceTransaction } from "./database";
import { analyticsInTransaction } from "./analytics";
import { canonicalHash } from "./canonicalHash";
import { appendWorkflowEvent } from "./workflowStore";
import { localClock } from "./workflowTiming";
const settingsId = (ownerId: number) => "owner:" + ownerId;
const event = async (tx: any, ownerId: number, type: string, id: string) =>
  (
    await tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          eq(workflowEvents.eventType, "owner.brief_" + type),
          eq(workflowEvents.aggregateId, id)
        )
      )
      .orderBy(desc(workflowEvents.revision))
      .limit(1)
  )[0];
export async function briefSettings(tx: any, ownerId: number) {
  const row = await event(tx, ownerId, "settings", settingsId(ownerId));
  return {
    revision: row?.revision ?? 0,
    fields: ownerBriefFields.parse(row?.metadata?.fields ?? {}),
    reason: row?.metadata?.reason ?? null,
  };
}
export function briefOccurrence(now: Date, fields: OwnerBriefFields) {
  let day = localClock(now, fields.timezone).day;
  if (fields.cadence === "weekly") {
    const base = new Date(day + "T12:00:00Z"),
      weekday = ((base.getUTCDay() + 6) % 7) + 1;
    base.setUTCDate(base.getUTCDate() + ((fields.weekday - weekday + 7) % 7));
    day = base.toISOString().slice(0, 10);
  }
  return {
    day,
    at: zonedDateTimeToUtc(day + "T" + fields.time, fields.timezone),
  };
}
export async function getOwnerBriefSettings(ownerId: number) {
  const db = await requireDb();
  return db.transaction(async (tx: any) => {
    const s = await briefSettings(tx, ownerId),
      w = (
        await tx
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.ownerId, ownerId))
          .limit(1)
      )[0];
    let occurrence: null | { day: string; at: Date } = null,
      scheduleIssue: null | string = null;
    try {
      occurrence = briefOccurrence(new Date(), s.fields);
    } catch {
      scheduleIssue =
        "The configured local time is ambiguous or unavailable today. Choose a different local time.";
    }
    return {
      ...s,
      workerEnabled: w?.backgroundEnabled === true,
      emergencyStop: w?.emergencyStop === true,
      occurrence,
      scheduleIssue,
    };
  });
}
export async function configureOwnerBrief(
  ownerId: number,
  actorId: number,
  raw: z.input<typeof ownerBriefConfigure>
) {
  const input = ownerBriefConfigure.parse(raw);
  return withWorkspaceTransaction(ownerId, async tx => {
    const previous = await briefSettings(tx, ownerId),
      hash = canonicalHash(input.fields),
      prior = await event(tx, ownerId, "settings", settingsId(ownerId));
    if (
      previous.revision === input.expectedRevision + 1 &&
      prior.metadata.fieldsHash === hash &&
      prior.metadata.reason === input.reason
    )
      return { revision: previous.revision, alreadySaved: true };
    if (previous.revision !== input.expectedRevision)
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Operating brief settings changed. Review the current version before saving.",
      });
    const revision = previous.revision + 1;
    await appendWorkflowEvent(
      tx,
      ownerId,
      "owner.brief_settings",
      settingsId(ownerId),
      revision,
      { fields: input.fields, fieldsHash: hash, reason: input.reason, actorId }
    );
    await tx
      .update(automationQueue)
      .set({
        status: "cancelled",
        lockToken: null,
        lockedAt: null,
        lastError: "Operating brief settings changed.",
      })
      .where(
        and(
          eq(automationQueue.ownerId, ownerId),
          eq(automationQueue.jobType, "owner_operating_brief"),
          inArray(automationQueue.status, [
            "queued",
            "retryable_failed",
            "blocked",
          ])
        )
      );
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "owner.brief_configured",
        resourceType: "workspace",
        resourceId: String(ownerId),
        metadata: { revision, enabled: input.fields.enabled },
      },
      tx
    );
    return { revision, alreadySaved: false };
  });
}
const validTime = (value: any) =>
  value != null && Number.isFinite(new Date(value).getTime());
const ownerPage = (type: string) =>
  type === "invoice"
    ? "/finance"
    : type === "shortlist"
      ? "/submissions"
      : type === "interview"
        ? "/interviews"
        : type === "candidate" || type === "screening"
          ? "/candidates"
          : type === "placement"
            ? "/placements"
            : type === "company"
              ? "/prospects"
              : "/control";
export async function ownerOverviewInTransaction(
  tx: any,
  ownerId: number,
  fields: OwnerBriefFields,
  now: Date
) {
  const report = await analyticsInTransaction(
      tx,
      ownerId,
      {
        from: new Date(now.getTime() - fields.lookbackDays * 86400000),
        to: now,
        timezone: fields.timezone,
        replyWindowHours: 72,
      },
      now
    ),
    cases: any[] = [];
  const age = (v: any) =>
    validTime(v) && new Date(v) <= now
      ? (now.getTime() - new Date(v).getTime()) / 3600000
      : null;
  const add = (
    kind: string,
    id: string,
    priority: number,
    label: string,
    resourceType: string,
    resourceId: string,
    hours: number | null,
    path: string
  ) =>
    cases.push({
      key: kind + ":" + id,
      kind,
      id,
      priority,
      label,
      resourceType,
      resourceId,
      sourceAgeHours: hours,
      path,
    });
  const approvalRows = await tx
    .select({
      id: approvals.id,
      actionType: approvals.actionType,
      resourceType: approvals.resourceType,
      resourceId: approvals.resourceId,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(and(eq(approvals.ownerId, ownerId), eq(approvals.status, "pending")))
    .orderBy(asc(approvals.id))
    .limit(10001);
  if (approvalRows.length > 10000)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Approval source exceeds the bounded brief limit; no partial brief was returned.",
    });
  for (const a of approvalRows) {
    if (validTime(a.createdAt) && new Date(a.createdAt) > now) continue;
    const hours = age(a.createdAt);
    add(
      "approval",
      a.id,
      hours !== null && hours >= fields.attentionHours ? 40 : 80,
      "Review pending " + a.actionType,
      a.resourceType,
      a.resourceId,
      hours,
      ownerPage(a.resourceType)
    );
  }
  const queueRows = await tx
    .select({
      id: automationQueue.id,
      jobType: automationQueue.jobType,
      status: automationQueue.status,
      scheduledAt: automationQueue.scheduledAt,
      lockedAt: automationQueue.lockedAt,
      createdAt: automationQueue.createdAt,
    })
    .from(automationQueue)
    .where(eq(automationQueue.ownerId, ownerId))
    .orderBy(asc(automationQueue.id))
    .limit(10001);
  if (queueRows.length > 10000)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Task source exceeds the bounded brief limit; no partial brief was returned.",
    });
  for (const q of queueRows) {
    if (validTime(q.createdAt) && new Date(q.createdAt) > now) continue;
    const stale =
        q.status === "running" &&
        validTime(q.lockedAt) &&
        new Date(q.lockedAt).getTime() < now.getTime() - 30 * 60000,
      due =
        ["queued", "retryable_failed"].includes(q.status) &&
        validTime(q.scheduledAt) &&
        now.getTime() - new Date(q.scheduledAt).getTime() >=
          fields.attentionHours * 3600000;
    if (["blocked", "permanently_failed"].includes(q.status) || stale || due)
      add(
        "queue",
        q.id,
        stale ? 20 : 50,
        stale
          ? "Reconcile an expired worker lease"
          : "Review " + q.jobType + " · " + q.status,
        "automation_job",
        q.id,
        age(q.createdAt),
        "/control"
      );
  }
  const incidentRows = await tx
    .select({
      id: incidents.id,
      incidentType: incidents.incidentType,
      severity: incidents.severity,
      status: incidents.status,
      affectedResourceType: incidents.affectedResourceType,
      affectedResourceId: incidents.affectedResourceId,
      createdAt: incidents.createdAt,
    })
    .from(incidents)
    .where(
      and(
        eq(incidents.ownerId, ownerId),
        inArray(incidents.status, [
          "detected",
          "triaged",
          "contained",
          "investigated",
        ])
      )
    )
    .orderBy(asc(incidents.id))
    .limit(10001);
  if (incidentRows.length > 10000)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Incident source exceeds the bounded brief limit; no partial brief was returned.",
    });
  for (const i of incidentRows.filter(
    (r: any) => !validTime(r.createdAt) || new Date(r.createdAt) <= now
  ))
    add(
      "incident",
      i.id,
      i.severity === "critical" ? 10 : i.severity === "high" ? 20 : 60,
      "Review existing " + i.incidentType,
      i.affectedResourceType ?? "incident",
      i.affectedResourceId ?? i.id,
      age(i.createdAt),
      "/exceptions"
    );
  const followupRows = await tx
    .select({
      id: followUpPlans.id,
      scenarioId: followUpPlans.scenarioId,
      status: followUpPlans.status,
      nextActionAt: followUpPlans.nextActionAt,
      deadlineAt: followUpPlans.deadlineAt,
      createdAt: followUpPlans.createdAt,
    })
    .from(followUpPlans)
    .where(
      and(
        eq(followUpPlans.ownerId, ownerId),
        inArray(followUpPlans.status, [
          "scheduled",
          "waiting",
          "approval_pending",
          "paused",
          "blocked",
        ])
      )
    )
    .orderBy(asc(followUpPlans.id))
    .limit(10001);
  if (followupRows.length > 10000)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Follow-up source exceeds the bounded brief limit; no partial brief was returned.",
    });
  for (const p of followupRows) {
    if (validTime(p.createdAt) && new Date(p.createdAt) > now) continue;
    const pastDeadline =
        validTime(p.deadlineAt) && new Date(p.deadlineAt) <= now,
      due = validTime(p.nextActionAt) && new Date(p.nextActionAt) <= now;
    if (pastDeadline || due || p.status === "blocked")
      add(
        "followup",
        p.id,
        pastDeadline ? 30 : p.status === "blocked" ? 45 : 75,
        pastDeadline
          ? "Review a follow-up past its recorded deadline"
          : "Review " + p.scenarioId + " follow-up · " + p.status,
        "followup_plan",
        p.id,
        age(p.createdAt),
        "/follow-ups"
      );
  }
  for (const i of report.sources.finance)
    if (i.collectible && BigInt(i.bookBalanceMinor) > 0n)
      add(
        "finance",
        i.invoiceId,
        i.status === "disputed" ? 30 : 70,
        "Review recorded " + i.currency + " receivable · " + i.status,
        "invoice",
        i.invoiceId,
        null,
        "/finance"
      );
  for (const i of report.quality.issues)
    add(
      "integrity",
      i.table + ":" + i.id,
      25,
      "Reconcile source integrity: " + i.code,
      i.table,
      i.id,
      null,
      "/analytics"
    );
  cases.sort(
    (a, b) =>
      a.priority - b.priority ||
      (b.sourceAgeHours ?? -1) - (a.sourceAgeHours ?? -1) ||
      a.key.localeCompare(b.key)
  );
  const unique = [...new Map(cases.map(c => [c.key, c])).values()],
    strategySnapshot = await strategyBriefInTransaction(tx, ownerId, now),
    snapshotDigest = canonicalHash({
      sourceDigest: report.sourceDigest,
      cases: unique,
      attentionHours: fields.attentionHours,
      strategyDigest: canonicalHash(strategySnapshot),
    });
  const summary = {
    version: OWNER_BRIEF_VERSION,
    strategy: strategySnapshot,
    asOf: report.asOf,
    window: report.window,
    inventory: report.inventory.map(r => ({
      resourceType: r.resourceType,
      snapshotRecords: r.snapshotRecords,
      createdInPeriod: r.createdInPeriod,
    })),
    placementCohort: {
      ...report.cohort,
      stages: report.cohort.stages.map(stage => ({
        ...stage,
        percent: stage.percent === null ? null : stage.percent.toFixed(2),
      })),
    },
    finance: report.finance,
    workflow: {
      dueTasks: report.workflow.dueTasks,
      oldestDueHours:
        report.workflow.oldestDueHours === null
          ? null
          : report.workflow.oldestDueHours.toFixed(6),
      p90DueHours:
        report.workflow.p90DueHours === null
          ? null
          : report.workflow.p90DueHours.toFixed(6),
      staleRunningLeases: report.workflow.staleRunningLeases,
      retryAttempts: report.workflow.retryAttempts,
      pendingApprovals: report.workflow.pendingApprovals,
      openIncidents: report.workflow.openIncidents,
      inferenceAttempts: report.workflow.inferenceAttempts,
      inferenceSucceeded: report.workflow.inferenceSucceeded,
      medianLatencyMs:
        report.workflow.medianLatencyMs === null
          ? null
          : report.workflow.medianLatencyMs.toFixed(6),
      p95LatencyMs:
        report.workflow.p95LatencyMs === null
          ? null
          : report.workflow.p95LatencyMs.toFixed(6),
      modelCostMinor: null,
      factuality: null,
      effortSavedHours: null,
    },
    sourceIntegrityIssues: report.quality.issues.length,
    attentionSources: unique.length,
    attentionByKind: Object.fromEntries(
      ["approval", "queue", "incident", "finance", "integrity", "followup"].map(
        kind => [kind, unique.filter(c => c.kind === kind).length]
      )
    ),
    unknownSourceAges: unique.filter(c => c.sourceAgeHours === null).length,
    thresholdHours: fields.attentionHours,
    sourceDigest: report.sourceDigest,
    limitations: [
      ...report.limitations,
      "Attention counts are source records, not unique underlying business problems. Several records can refer to one issue.",
      "Attention thresholds are owner review preferences, not contractual SLA breaches. Source age is not audited time in stage.",
      "This internal brief does not approve, retry, delegate, send, change policy or apply a hiring decision.",
      "Bank-cleared cash, measured costs/margins and effort saved remain unavailable without their required evidence.",
    ],
  };
  return { summary, cases: unique, snapshotDigest };
}
export async function ownerOverview(
  ownerId: number,
  raw: z.input<typeof ownerBriefQuery>
) {
  const input = ownerBriefQuery.parse(raw),
    db = await requireDb();
  return db.transaction(async (tx: any) => {
    const settings = await briefSettings(tx, ownerId),
      r = await ownerOverviewInTransaction(
        tx,
        ownerId,
        settings.fields,
        new Date()
      ),
      filtered = r.cases.filter(
        c => input.kind === "all" || c.kind === input.kind
      );
    return {
      ...r,
      cases: filtered.slice(input.offset, input.offset + input.limit),
      total: filtered.length,
      offset: input.offset,
      hasMore: input.offset + input.limit < filtered.length,
      settingsRevision: settings.revision,
    };
  });
}
async function pruneBriefs(tx: any, ownerId: number, days: number, now: Date) {
  const old = await tx
    .select({ id: workflowEvents.id, metadata: workflowEvents.metadata })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.ownerId, ownerId),
        eq(workflowEvents.eventType, "owner.brief_generated"),
        lt(workflowEvents.createdAt, new Date(now.getTime() - days * 86400000))
      )
    )
    .limit(10001);
  if (old.length > 10000)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Brief retention source exceeds its supported bound. Archive old brief records before continuing.",
    });
  for (const e of old.filter((r: any) => !r.metadata?.redacted).slice(0, 100))
    await tx
      .update(workflowEvents)
      .set({ metadata: { redacted: true, reason: "brief_retention_elapsed" } })
      .where(eq(workflowEvents.id, e.id));
}
async function generate(
  tx: any,
  ownerId: number,
  id: string,
  mode: "manual" | "scheduled",
  now: Date,
  revision?: number
) {
  const prior = await event(tx, ownerId, "generated", id);
  if (prior)
    return {
      id,
      alreadyGenerated: true,
      expired: prior.metadata.redacted === true,
    };
  const settings = await briefSettings(tx, ownerId);
  if (revision !== undefined && revision !== settings.revision)
    return {
      status: "cancelled",
      reason: "Operating brief configuration changed.",
    };
  const r = await ownerOverviewInTransaction(tx, ownerId, settings.fields, now);
  await appendWorkflowEvent(tx, ownerId, "owner.brief_generated", id, 1, {
    summary: r.summary,
    summaryHash: canonicalHash(r.summary),
    snapshotDigest: r.snapshotDigest,
    mode,
    settingsRevision: settings.revision,
    generatedAt: now.toISOString(),
    noPersonalSourceDetailsPersisted: true,
  });
  await pruneBriefs(tx, ownerId, settings.fields.retentionDays, now);
  return { id, alreadyGenerated: false, asOf: r.summary.asOf };
}
export async function recordOwnerBrief(
  ownerId: number,
  actorId: number,
  requestKey: string
) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const id = "brf_" + canonicalHash([ownerId, requestKey]).slice(0, 28),
      result = await generate(tx, ownerId, id, "manual", new Date());
    if (!result.alreadyGenerated)
      await recordAudit(
        {
          ownerId,
          actorType: "user",
          actorId: String(actorId),
          action: "owner.brief_recorded",
          resourceType: "workspace",
          resourceId: String(ownerId),
          metadata: { briefId: id },
        },
        tx
      );
    return result;
  });
}
export async function scheduleOwnerBrief(ownerId: number, now = new Date()) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const settings = await briefSettings(tx, ownerId),
      workspace = (
        await tx
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.ownerId, ownerId))
          .limit(1)
      )[0];
    if (
      !settings.fields.enabled ||
      !workspace.backgroundEnabled ||
      workspace.emergencyStop
    )
      return { status: "disabled" };
    let occurrence;
    try {
      occurrence = briefOccurrence(now, settings.fields);
    } catch {
      const day = localClock(now, settings.fields.timezone).day;
      await appendWorkflowEvent(
        tx,
        ownerId,
        "owner.brief_schedule_skipped",
        "schedule:" + ownerId + ":" + day,
        settings.revision,
        {
          day,
          settingsRevision: settings.revision,
          reason: "ambiguous_or_unavailable_local_time",
        }
      );
      return { status: "unavailable_local_time" };
    }
    const id = "scheduled:" + ownerId + ":" + occurrence.day;
    if (await event(tx, ownerId, "generated", id))
      return { status: "already_generated", id };
    const idempotencyKey = "owner_brief:" + ownerId + ":" + occurrence.day,
      existing = (
        await tx
          .select()
          .from(automationQueue)
          .where(eq(automationQueue.idempotencyKey, idempotencyKey))
          .limit(1)
      )[0],
      payload = {
        briefId: id,
        settingsRevision: settings.revision,
        periodDay: occurrence.day,
      };
    if (existing) {
      if (
        existing.status === "cancelled" &&
        existing.payload?.settingsRevision !== settings.revision
      )
        await tx
          .update(automationQueue)
          .set({
            status: "queued",
            payload,
            scheduledAt: occurrence.at,
            attempts: 0,
            lastError: null,
            lockToken: null,
            lockedAt: null,
            completedAt: null,
          })
          .where(eq(automationQueue.id, existing.id));
      return { status: "existing", id, jobId: existing.id };
    }
    const jobId = createId("que_");
    await tx.insert(automationQueue).values({
      id: jobId,
      ownerId,
      jobType: "owner_operating_brief",
      status: "queued",
      priority: 60,
      scheduledAt: occurrence.at,
      maxAttempts: 3,
      idempotencyKey,
      payload,
    });
    return { status: "scheduled", id, jobId };
  });
}
export async function executeOwnerBrief(
  ownerId: number,
  payload: any,
  now = new Date()
) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const settings = await briefSettings(tx, ownerId),
      workspace = (
        await tx
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.ownerId, ownerId))
          .limit(1)
      )[0];
    if (
      !settings.fields.enabled ||
      !workspace.backgroundEnabled ||
      workspace.emergencyStop ||
      settings.revision !== payload?.settingsRevision
    )
      return {
        status: "cancelled",
        reason: "Operating brief authority is disabled or changed.",
      };
    if (
      typeof payload.periodDay !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(payload.periodDay) ||
      typeof payload.briefId !== "string" ||
      payload.briefId !== "scheduled:" + ownerId + ":" + payload.periodDay
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Brief task scope is invalid.",
      });
    const today = localClock(now, settings.fields.timezone).day;
    if (payload.periodDay < today)
      return {
        status: "cancelled",
        reason:
          "The scheduled brief period elapsed; no historical outcome was invented.",
      };
    const at = zonedDateTimeToUtc(
        payload.periodDay + "T" + settings.fields.time,
        settings.fields.timezone
      ),
      weekday =
        ((new Date(payload.periodDay + "T12:00:00Z").getUTCDay() + 6) % 7) + 1;
    if (
      settings.fields.cadence === "weekly" &&
      weekday !== settings.fields.weekday
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Brief task weekday does not match its authority.",
      });
    if (at > now) return { status: "deferred", nextActionAt: at };
    return generate(
      tx,
      ownerId,
      payload.briefId,
      "scheduled",
      now,
      settings.revision
    );
  });
}
export async function ownerBriefHistory(ownerId: number) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const s = await briefSettings(tx, ownerId);
    await pruneBriefs(tx, ownerId, s.fields.retentionDays, new Date());
    const rows = await tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          eq(workflowEvents.eventType, "owner.brief_generated")
        )
      )
      .orderBy(desc(workflowEvents.createdAt), desc(workflowEvents.id))
      .limit(51);
    return {
      items: rows.slice(0, 50).map((r: any) =>
        new Date(r.createdAt).getTime() <
        Date.now() - s.fields.retentionDays * 86400000
          ? {
              id: r.aggregateId,
              redacted: true,
              reason: "brief_retention_elapsed",
            }
          : (() => {
              if (
                !r.metadata.redacted &&
                r.metadata.summaryHash !== canonicalHash(r.metadata.summary)
              )
                throw new TRPCError({
                  code: "PRECONDITION_FAILED",
                  message:
                    "Stored operating brief does not match its recorded summary hash.",
                });
              return { id: r.aggregateId, ...r.metadata };
            })()
      ),
      olderAvailable: rows.length > 50,
      retentionDays: s.fields.retentionDays,
    };
  });
}
