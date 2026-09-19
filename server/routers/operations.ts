import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { parse as parseCookieHeader } from "cookie";
import { COOKIE_NAME } from "@shared/const";
import { z } from "zod";
import {
  aiUsage,
  approvals,
  auditEvents,
  automationQueue,
  candidates,
  companies,
  incidents,
  interviews,
  invoices,
  jobs,
  placements,
  policyVersions,
  rightsRequests,
  workspaceSettings,
} from "../../drizzle/schema";
import { createId, ensureWorkspace, getRecentAudits, recordAudit, requireDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { createHeartbeatJob } from "../_core/heartbeat";
import { processOneQueuedJob } from "../services/queue";
import { assertTransition } from "../workflow";
import { getProductionRuntimeStatus } from "../services/runtimeAuth";
import { getHostingerMailApiStatus } from "../services/hostingerMail";

const paginationInput = z.object({ limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 });

export const operationsRouter = router({
  dashboard: protectedProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const ownerId = ctx.user.id;
    const [prospects, activeJobs, candidateCount, pendingApprovals, pendingInvoices, queuedJobs, failedJobs, upcoming, recentAudits, workspace, todayAiUsage] = await Promise.all([
      db.select({ value: count() }).from(companies).where(and(eq(companies.ownerId, ownerId), eq(companies.companyType, "prospect"))),
      db.select({ value: count() }).from(jobs).where(and(eq(jobs.ownerId, ownerId), inArray(jobs.pipelineState, ["sourcing", "screening", "shortlist_ready", "interviewing"]))),
      db.select({ value: count() }).from(candidates).where(and(eq(candidates.ownerId, ownerId), sql`${candidates.deletedAt} is null`)),
      db.select({ value: count() }).from(approvals).where(and(eq(approvals.ownerId, ownerId), eq(approvals.status, "pending"))),
      db.select({ value: count() }).from(invoices).where(and(eq(invoices.ownerId, ownerId), inArray(invoices.status, ["payment_pending", "partially_paid", "overdue", "disputed"]))),
      db.select({ value: count() }).from(automationQueue).where(and(eq(automationQueue.ownerId, ownerId), inArray(automationQueue.status, ["queued", "retryable_failed", "approval_pending"]))),
      db.select({ value: count() }).from(automationQueue).where(and(eq(automationQueue.ownerId, ownerId), eq(automationQueue.status, "permanently_failed"))),
      db.select().from(interviews).where(and(eq(interviews.ownerId, ownerId), inArray(interviews.status, ["scheduled", "confirmed", "reminder_sent"]))).orderBy(interviews.scheduledAt).limit(5),
      getRecentAudits(ownerId, 8),
      ensureWorkspace(ownerId),
      db.select({ value: count() }).from(aiUsage).where(and(eq(aiUsage.ownerId, ownerId), sql`date(${aiUsage.createdAt}) = curdate()`)),
    ]);
    return {
      metrics: {
        prospects: prospects[0]?.value ?? 0,
        activeJobs: activeJobs[0]?.value ?? 0,
        candidates: candidateCount[0]?.value ?? 0,
        pendingApprovals: pendingApprovals[0]?.value ?? 0,
        pendingInvoices: pendingInvoices[0]?.value ?? 0,
        queuedJobs: queuedJobs[0]?.value ?? 0,
        failedJobs: failedJobs[0]?.value ?? 0,
        todayAiRequests: todayAiUsage[0]?.value ?? 0,
      },
      upcoming,
      recentAudits,
      workspace,
      aiQuota: { used: todayAiUsage[0]?.value ?? 0, limit: Number((workspace.policyConfig as { aiDailyLimit?: number } | null)?.aiDailyLimit ?? 45) },
    };
  }),
  settings: router({
    get: protectedProcedure.query(async ({ ctx }) => ensureWorkspace(ctx.user.id)),
    readiness: protectedProcedure.query(async ({ ctx }) => {
      await ensureWorkspace(ctx.user.id);
      const runtime = getProductionRuntimeStatus();
      const mail = getHostingerMailApiStatus();
      return {
        runtime: { configured: runtime.configured, oidcConfigured: runtime.oidcConfigured, oidcMissing: runtime.oidcMissing, privateStorage: runtime.privateStorage },
        mail: { configured: mail.configured, tokenConfigured: mail.tokenConfigured, webhookSecretConfigured: mail.webhookSecretConfigured, configuredMailboxCount: mail.configuredMailboxCount, configuredSenderAddressCount: mail.configuredSenderAddressCount },
        calendar: { provider: "ics", timezoneSafe: true, remindersOwnerApproved: true },
        ai: { structuredValidation: true, ownerReviewOnLowConfidence: true, openRouterFallback: true, autonomousFinalRejection: false },
      };
    }),
    update: protectedProcedure.input(z.object({ automationMode: z.enum(["safe", "controlled", "autopilot"]).optional(), dailyOutboundLimit: z.number().int().min(1).max(500).optional(), quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(), quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(), businessTimezone: z.string().min(2).max(64).optional() })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await ensureWorkspace(ctx.user.id);
      await db.update(workspaceSettings).set(input).where(eq(workspaceSettings.ownerId, ctx.user.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "workspace.settings_updated", resourceType: "workspace", resourceId: String(ctx.user.id), metadata: input });
      return { success: true };
    }),
    setEmergencyStop: protectedProcedure.input(z.object({ enabled: z.boolean(), reason: z.string().trim().min(3).max(500) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await ensureWorkspace(ctx.user.id);
      await db.update(workspaceSettings).set({ emergencyStop: input.enabled }).where(eq(workspaceSettings.ownerId, ctx.user.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: input.enabled ? "automation.emergency_stopped" : "automation.resumed", resourceType: "workspace", resourceId: String(ctx.user.id), metadata: { reason: input.reason } });
      return { success: true };
    }),
  }),
  policies: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const db = await requireDb();
      return db.select().from(policyVersions).where(eq(policyVersions.ownerId, ctx.user.id)).orderBy(desc(policyVersions.version));
    }),
    create: protectedProcedure.input(z.object({ name: z.string().trim().min(3).max(160), content: z.record(z.string(), z.unknown()) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const versions = await db.select({ latest: sql<number>`coalesce(max(${policyVersions.version}), 0)` }).from(policyVersions).where(eq(policyVersions.ownerId, ctx.user.id));
      const id = createId("pol_");
      await db.insert(policyVersions).values({ id, ownerId: ctx.user.id, version: (versions[0]?.latest ?? 0) + 1, name: input.name, content: input.content, createdById: ctx.user.id, status: "draft" });
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "policy.drafted", resourceType: "policy", resourceId: id, nextState: "draft" });
      return { id };
    }),
    activate: protectedProcedure.input(z.object({ id: z.string().min(4) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const policy = (await db.select().from(policyVersions).where(and(eq(policyVersions.id, input.id), eq(policyVersions.ownerId, ctx.user.id))).limit(1))[0];
      if (!policy) throw new Error("Policy was not found.");
      await db.update(policyVersions).set({ status: "archived" }).where(and(eq(policyVersions.ownerId, ctx.user.id), eq(policyVersions.status, "active")));
      await db.update(policyVersions).set({ status: "active", activatedAt: new Date() }).where(eq(policyVersions.id, policy.id));
      await db.update(workspaceSettings).set({ policyConfig: policy.content }).where(eq(workspaceSettings.ownerId, ctx.user.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "policy.activated", resourceType: "policy", resourceId: policy.id, previousState: policy.status, nextState: "active" });
      return { success: true };
    }),
  }),
  approvals: router({
    list: protectedProcedure.input(paginationInput).query(async ({ ctx, input }) => {
      const db = await requireDb();
      return db.select().from(approvals).where(eq(approvals.ownerId, ctx.user.id)).orderBy(desc(approvals.createdAt)).limit(input.limit);
    }),
  }),
  queue: router({
    list: protectedProcedure.input(paginationInput).query(async ({ ctx, input }) => {
      const db = await requireDb();
      return db.select().from(automationQueue).where(eq(automationQueue.ownerId, ctx.user.id)).orderBy(desc(automationQueue.updatedAt)).limit(input.limit);
    }),
    enqueue: protectedProcedure.input(z.object({ jobType: z.enum(["classify_reply", "draft_outreach", "parse_cv", "score_match", "send_reminder", "reconcile_invoice"]), payload: z.record(z.string(), z.unknown()), idempotencyKey: z.string().trim().min(6).max(160), scheduledAt: z.date().optional() })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const workspace = await ensureWorkspace(ctx.user.id);
      if (workspace.emergencyStop) throw new Error("Automation is paused by the emergency stop.");
      const id = createId("que_");
      await db.insert(automationQueue).values({ id, ownerId: ctx.user.id, jobType: input.jobType, payload: input.payload, idempotencyKey: input.idempotencyKey, scheduledAt: input.scheduledAt ?? new Date() }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "automation.queued", resourceType: "automation_job", resourceId: id, nextState: "queued", metadata: { jobType: input.jobType } });
      return { id };
    }),
    retry: protectedProcedure.input(z.object({ id: z.string().min(4) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const rows = await db.select().from(automationQueue).where(and(eq(automationQueue.id, input.id), eq(automationQueue.ownerId, ctx.user.id))).limit(1);
      const job = rows[0];
      if (!job) throw new Error("Automation job was not found.");
      assertTransition("automation_job", job.status, "queued");
      await db.update(automationQueue).set({ status: "queued", scheduledAt: new Date(), lastError: null, lockToken: null, lockedAt: null }).where(eq(automationQueue.id, input.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "automation.retried", resourceType: "automation_job", resourceId: input.id, previousState: job.status, nextState: "queued" });
      return { success: true };
    }),
    cancel: protectedProcedure.input(z.object({ id: z.string().min(4) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const rows = await db.select().from(automationQueue).where(and(eq(automationQueue.id, input.id), eq(automationQueue.ownerId, ctx.user.id))).limit(1);
      const job = rows[0];
      if (!job) throw new Error("Automation job was not found.");
      assertTransition("automation_job", job.status, "cancelled");
      await db.update(automationQueue).set({ status: "cancelled", lockToken: null, lockedAt: null, completedAt: new Date() }).where(eq(automationQueue.id, input.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "automation.cancelled", resourceType: "automation_job", resourceId: input.id, previousState: job.status, nextState: "cancelled" });

      if (job.jobType === "execute_policy_decision") {
        const payload = (job.payload ?? {}) as { approvalId?: string };
        if (payload.approvalId) {
          const approvalRows = await db
            .select()
            .from(approvals)
            .where(
              and(
                eq(approvals.id, payload.approvalId),
                eq(approvals.ownerId, ctx.user.id),
                eq(approvals.status, "approved"),
              ),
            )
            .limit(1);
          const approval = approvalRows[0];
          if (approval) {
            const newReason = `${approval.reason || ""} [Cancelled by owner during grace period]`.trim();
            await db
              .update(approvals)
              .set({
                status: "cancelled",
                reason: newReason,
              })
              .where(eq(approvals.id, approval.id));

            await recordAudit({
              ownerId: ctx.user.id,
              actorType: "user",
              actorId: String(ctx.user.id),
              action: "approval.cancelled",
              resourceType: "approval",
              resourceId: payload.approvalId,
              previousState: "approved",
              nextState: "cancelled",
              metadata: { queueJobId: input.id, reason: "Owner cancelled during grace period" },
            });
          }
        }
      }

      return { success: true };
    }),
    runNext: protectedProcedure.mutation(async ({ ctx }) => {
      return processOneQueuedJob(ctx.user.id);
    }),
    enableSchedule: protectedProcedure.mutation(async ({ ctx }) => {
      if (ctx.actor && ctx.actor.id !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Only the workspace owner can manage queue schedules." });
      const db = await requireDb();
      const cookie = parseCookieHeader(ctx.req.headers.cookie ?? "")[COOKIE_NAME] ?? "";
      if (!cookie) throw new TRPCError({ code: "UNAUTHORIZED", message: "A session cookie is required to create a schedule." });
      const job = await createHeartbeatJob({
        name: `automation-queue-${ctx.user.id}`,
        cron: "0 */2 * * * *",
        path: "/api/scheduled/automation-queue",
        description: "Process queued automation jobs on a scheduled interval.",
      }, cookie);
      await db.update(workspaceSettings).set({ automationCronTaskUid: job.taskUid }).where(eq(workspaceSettings.ownerId, ctx.user.id));
      await recordAudit({
        ownerId: ctx.user.id,
        actorType: "user",
        actorId: String(ctx.user.id),
        action: "automation.schedule_enabled",
        resourceType: "workspace",
        resourceId: String(ctx.user.id),
        metadata: { taskUid: job.taskUid, cron: "0 */2 * * * *" },
      });
      return job;
    }),
  }),
  exceptions: router({
    list: protectedProcedure.input(paginationInput).query(async ({ ctx, input }) => {
      const db = await requireDb();
      const [queueFailures, pendingApprovals, openIncidents, rights] = await Promise.all([
        db.select().from(automationQueue).where(and(eq(automationQueue.ownerId, ctx.user.id), inArray(automationQueue.status, ["blocked", "permanently_failed", "approval_pending"]))).orderBy(desc(automationQueue.updatedAt)).limit(input.limit),
        db.select().from(approvals).where(and(eq(approvals.ownerId, ctx.user.id), eq(approvals.status, "pending"))).orderBy(desc(approvals.createdAt)).limit(input.limit),
        db.select().from(incidents).where(and(eq(incidents.ownerId, ctx.user.id), inArray(incidents.status, ["detected", "triaged", "contained", "investigated"]))).orderBy(desc(incidents.detectedAt)).limit(input.limit),
        db.select().from(rightsRequests).where(and(eq(rightsRequests.ownerId, ctx.user.id), inArray(rightsRequests.status, ["received", "acknowledged", "investigation"]))).orderBy(desc(rightsRequests.receivedAt)).limit(input.limit),
      ]);
      return { queueFailures, pendingApprovals, openIncidents, rights };
    }),
    createIncident: protectedProcedure.input(z.object({ incidentType: z.string().trim().min(3).max(96), severity: z.enum(["low", "medium", "high", "critical"]), summary: z.string().trim().min(8).max(5000), affectedResourceType: z.string().trim().max(96).optional(), affectedResourceId: z.string().trim().max(64).optional() })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const id = createId("inc_");
      await db.insert(incidents).values({ id, ownerId: ctx.user.id, incidentType: input.incidentType, severity: input.severity, summary: input.summary, affectedResourceType: input.affectedResourceType ?? null, affectedResourceId: input.affectedResourceId ?? null });
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "incident.created", resourceType: "incident", resourceId: id, nextState: "detected", metadata: { severity: input.severity } });
      return { id };
    }),
    updateIncidentState: protectedProcedure.input(z.object({ id: z.string().min(4), status: z.enum(["triaged", "contained", "investigated", "resolved"]), containmentNotes: z.string().trim().max(4000).optional() })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const incident = (await db.select().from(incidents).where(and(eq(incidents.id, input.id), eq(incidents.ownerId, ctx.user.id))).limit(1))[0];
      if (!incident) throw new Error("Incident was not found.");
      assertTransition("incident", incident.status, input.status);
      await db.update(incidents).set({ status: input.status, containmentNotes: input.containmentNotes ?? incident.containmentNotes, resolvedAt: input.status === "resolved" ? new Date() : incident.resolvedAt }).where(eq(incidents.id, incident.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "incident.state_changed", resourceType: "incident", resourceId: incident.id, previousState: incident.status, nextState: input.status });
      return { success: true };
    }),
  }),
  audits: router({
    list: protectedProcedure.input(paginationInput).query(async ({ ctx, input }) => {
      const db = await requireDb();
      return db.select().from(auditEvents).where(eq(auditEvents.ownerId, ctx.user.id)).orderBy(desc(auditEvents.createdAt)).limit(input.limit);
    }),
  }),
});
