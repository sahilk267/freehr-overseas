import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { createId, requireDb } from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { ownerBriefFields } from "../../shared/ownerBrief";
import {
  briefOccurrence,
  briefSettings,
  getOwnerBriefSettings,
  configureOwnerBrief,
  ownerOverview,
  ownerOverviewInTransaction,
  recordOwnerBrief,
  ownerBriefHistory,
  scheduleOwnerBrief,
  executeOwnerBrief,
} from "./ownerBrief";
import { processOneQueuedJob } from "./queue";
import { runManagedAutomationCycle } from "./backgroundWorker";
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
  const stamp = new Date(Date.now() - 3 * 86400000);
  await f.db
    .update(schema.invoices)
    .set({ issuedAt: stamp, status: "payment_pending" })
    .where(eq(schema.invoices.id, f.invoiceId));
  const approvalId = createId("apr_"),
    queueId = createId("que_"),
    incidentId = createId("inc_");
  await f.db.insert(schema.approvals).values({
    id: approvalId,
    ownerId: f.ownerId,
    requestedBy: "user",
    actionType: "invoice_issue",
    resourceType: "invoice",
    resourceId: f.invoiceId,
    status: "pending",
    reason: "PRIVATE_REASON_MARKER",
    payload: { privateNote: "PRIVATE_PAYLOAD_MARKER" },
    createdAt: stamp,
  });
  await f.db.insert(schema.automationQueue).values({
    id: queueId,
    ownerId: f.ownerId,
    jobType: "score_match",
    status: "blocked",
    lastError: "PRIVATE_ERROR_MARKER",
    payload: { privateText: "PRIVATE_PAYLOAD_MARKER" },
    attempts: 1,
    idempotencyKey: "owner-brief-fixture:" + queueId,
    createdAt: stamp,
  });
  await f.db.insert(schema.incidents).values({
    id: incidentId,
    ownerId: f.ownerId,
    incidentType: "email_dispatch_reconciliation",
    severity: "critical",
    status: "detected",
    affectedResourceType: "message",
    affectedResourceId: "synthetic_message",
    summary: "PRIVATE_INCIDENT_MARKER",
    createdAt: stamp,
  });
  return { ...f, approvalId, queueId, incidentId };
}
const overviewInput = { kind: "all" as const, offset: 0, limit: 100 };
async function enabled(f: any, overrides: any = {}) {
  await f.db
    .update(schema.workspaceSettings)
    .set({ backgroundEnabled: true })
    .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
  const current = await getOwnerBriefSettings(f.ownerId),
    fields = ownerBriefFields.parse({
      ...current.fields,
      enabled: true,
      time: "00:00",
      timezone: "UTC",
      ...overrides,
    });
  await configureOwnerBrief(f.ownerId, f.ownerId, {
    expectedRevision: current.revision,
    fields,
    reason:
      "Enable a synthetic internal summary; no provider contact or hiring authority.",
  });
  return fields;
}
describe("owner operating priorities and aggregate-only summaries", () => {
  it("prioritizes canonical sources without copying private notes, bodies or raw failures", async () => {
    const f = await fixture(),
      r = await ownerOverview(f.ownerId, overviewInput);
    expect(r.cases[0].id).toBe(f.incidentId);
    expect(r.cases.find(c => c.id === f.approvalId)?.path).toBe("/finance");
    expect(r.cases.find(c => c.id === f.queueId)?.priority).toBe(50);
    const text = JSON.stringify(r);
    for (const privateText of [
      "PRIVATE_REASON_MARKER",
      "PRIVATE_PAYLOAD_MARKER",
      "PRIVATE_ERROR_MARKER",
      "PRIVATE_INCIDENT_MARKER",
      f.address,
      "Synthetic candidate",
    ])
      expect(text).not.toContain(privateText);
    expect(new Set(r.cases.map(c => c.key)).size).toBe(r.cases.length);
  });
  it("keeps currency book balances and unknown clearing/margin distinct", async () => {
    const f = await fixture(),
      r = await ownerOverview(f.ownerId, overviewInput);
    expect(r.summary.finance[0]).toMatchObject({
      currency: "INR",
      openReceivableMinor: "10000",
      providerVerifiedMinor: "0",
      bankClearedMinor: null,
      contributionMarginMinor: null,
    });
    expect(r.summary.limitations.join(" ")).toContain("not contractual SLA");
  });
  it("filters a complete source set before display pagination rather than manufacturing totals from one page", async () => {
    const f = await fixture(),
      all = await ownerOverview(f.ownerId, overviewInput),
      page = await ownerOverview(f.ownerId, {
        kind: "approval",
        offset: 0,
        limit: 1,
      });
    expect(page.total).toBe(
      all.cases.filter(c => c.kind === "approval").length
    );
    expect(page.cases).toHaveLength(1);
    expect(page.summary.attentionSources).toBe(all.summary.attentionSources);
  });
  it("never reads another owner’s priorities or history", async () => {
    const f = await fixture(),
      other = await fixture();
    const r = await ownerOverview(f.ownerId, overviewInput);
    expect(JSON.stringify(r.cases)).not.toContain(other.incidentId);
    await recordOwnerBrief(f.ownerId, f.ownerId, "synthetic-private-brief");
    expect((await ownerBriefHistory(other.ownerId)).items).toHaveLength(0);
  });
  it("deduplicates a manual record request and stores aggregate data without personal/source case identities", async () => {
    const f = await fixture(),
      a = await recordOwnerBrief(f.ownerId, f.ownerId, "synthetic-record-once"),
      b = await recordOwnerBrief(f.ownerId, f.ownerId, "synthetic-record-once"),
      h = await ownerBriefHistory(f.ownerId);
    expect(b.id).toBe(a.id);
    expect(b.alreadyGenerated).toBe(true);
    expect(h.items).toHaveLength(1);
    const text = JSON.stringify(h.items);
    for (const id of [
      f.candidateId,
      f.jobId,
      f.companyId,
      f.invoiceId,
      f.approvalId,
      f.queueId,
      f.incidentId,
      f.address,
    ])
      expect(text).not.toContain(id);
    expect(h.items[0].summary.attentionSources).toBeGreaterThan(0);
    expect(h.items[0].noPersonalSourceDetailsPersisted).toBe(true);
  });
  it("detects altered stored aggregate summaries while tolerating SQL JSON key ordering", async () => {
    const f = await fixture(),
      r = await recordOwnerBrief(
        f.ownerId,
        f.ownerId,
        "synthetic-summary-integrity"
      ),
      row = (
        await f.db
          .select()
          .from(schema.workflowEvents)
          .where(
            and(
              eq(schema.workflowEvents.ownerId, f.ownerId),
              eq(schema.workflowEvents.aggregateId, r.id),
              eq(schema.workflowEvents.eventType, "owner.brief_generated")
            )
          )
      )[0];
    await f.db
      .update(schema.workflowEvents)
      .set({
        metadata: {
          ...row.metadata,
          summary: { ...row.metadata.summary, attentionSources: 999999 },
        },
      })
      .where(eq(schema.workflowEvents.id, row.id));
    await expect(ownerBriefHistory(f.ownerId)).rejects.toThrow(/summary hash/);
  });
  it("redacts retained summaries after expiry and never restores them on exact request replay", async () => {
    const f = await fixture(),
      r = await recordOwnerBrief(f.ownerId, f.ownerId, "synthetic-retention"),
      row = (
        await f.db
          .select()
          .from(schema.workflowEvents)
          .where(
            and(
              eq(schema.workflowEvents.ownerId, f.ownerId),
              eq(schema.workflowEvents.aggregateId, r.id)
            )
          )
      )[0];
    await f.db
      .update(schema.workflowEvents)
      .set({ createdAt: new Date(Date.now() - 31 * 86400000) })
      .where(eq(schema.workflowEvents.id, row.id));
    const history = await ownerBriefHistory(f.ownerId);
    expect(history.items[0].redacted).toBe(true);
    expect(history.items[0]).not.toHaveProperty("summary");
    expect(
      (await recordOwnerBrief(f.ownerId, f.ownerId, "synthetic-retention"))
        .expired
    ).toBe(true);
  });
  it("turns future-created records into integrity review rather than pretending they have waited", async () => {
    const f = await fixture();
    await f.db
      .update(schema.approvals)
      .set({ createdAt: new Date(Date.now() + 86400000) })
      .where(eq(schema.approvals.id, f.approvalId));
    const r = await ownerOverview(f.ownerId, overviewInput);
    expect(
      r.cases.some(c => c.kind === "approval" && c.id === f.approvalId)
    ).toBe(false);
    expect(
      r.cases.some(c => c.kind === "integrity" && c.resourceId === f.approvalId)
    ).toBe(true);
  });
  it("fails closed before creating a partial aggregate when a canonical source exceeds its bound", async () => {
    const rows = Array.from({ length: 10001 }, (_, i) => ({
        id: String(i),
        ownerId: 1,
      })),
      tx = {
        select: () => ({
          from: () => ({
            where: () => ({ orderBy: () => ({ limit: async () => rows }) }),
          }),
        }),
      };
    await expect(
      ownerOverviewInTransaction(tx, 1, ownerBriefFields.parse({}), new Date())
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("denies anonymous settings, overview and record requests through the normal workspace barrier", async () => {
    const { appRouter } = await import("../routers"),
      anon = appRouter.createCaller({
        user: null,
        req: { headers: {} },
        res: {},
      } as any);
    await expect(anon.ownerBrief.settings()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(anon.ownerBrief.overview(overviewInput)).rejects.toMatchObject(
      { code: "UNAUTHORIZED" }
    );
    await expect(
      anon.ownerBrief.record({ requestKey: "synthetic-no-auth" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
describe("daily/weekly schedules on the existing managed queue", () => {
  it("defaults scheduling to disabled and does not enable the worker as a side effect", async () => {
    const f = await fixture(),
      s = await getOwnerBriefSettings(f.ownerId);
    expect(s.fields.enabled).toBe(false);
    expect(s.workerEnabled).toBe(false);
    expect((await scheduleOwnerBrief(f.ownerId)).status).toBe("disabled");
    expect(
      await f.db
        .select()
        .from(schema.automationQueue)
        .where(
          and(
            eq(schema.automationQueue.ownerId, f.ownerId),
            eq(schema.automationQueue.jobType, "owner_operating_brief")
          )
        )
    ).toHaveLength(0);
  });
  it("uses actual IANA offsets and weekly calendar days without assuming the browser timezone", () => {
    const f = ownerBriefFields.parse({
        enabled: true,
        timezone: "America/New_York",
        cadence: "weekly",
        weekday: 1,
        time: "09:00",
      }),
      r = briefOccurrence(new Date("2027-03-14T12:00:00Z"), f);
    expect(r.day).toBe("2027-03-15");
    expect(r.at.toISOString()).toBe("2027-03-15T13:00:00.000Z");
  });
  it("does not guess an ambiguous or unavailable daylight-saving local time", () => {
    expect(() =>
      briefOccurrence(
        new Date("2027-03-14T05:00:00Z"),
        ownerBriefFields.parse({ timezone: "America/New_York", time: "02:30" })
      )
    ).toThrow(/ambiguous|unavailable/);
  });
  it("creates one durable daily task and reuses its physical identity on repeated scheduling", async () => {
    const f = await fixture();
    await enabled(f);
    const a = await scheduleOwnerBrief(f.ownerId),
      b = await scheduleOwnerBrief(f.ownerId);
    expect(b.jobId).toBe(a.jobId);
    expect(
      await f.db
        .select()
        .from(schema.automationQueue)
        .where(
          and(
            eq(schema.automationQueue.ownerId, f.ownerId),
            eq(schema.automationQueue.jobType, "owner_operating_brief")
          )
        )
    ).toHaveLength(1);
  });
  it("checks the actual scheduled instant again and defers an early task instead of publishing it", async () => {
    const f = await fixture();
    await enabled(f, { time: "23:59" });
    const scheduled = await scheduleOwnerBrief(
        f.ownerId,
        new Date("2026-11-13T12:00:00Z")
      ),
      job = (
        await f.db
          .select()
          .from(schema.automationQueue)
          .where(eq(schema.automationQueue.id, scheduled.jobId))
      )[0],
      r = await executeOwnerBrief(
        f.ownerId,
        job.payload,
        new Date("2026-11-13T12:00:00Z")
      );
    expect(r.status).toBe("deferred");
    expect(new Date(r.nextActionAt).toISOString()).toBe(
      "2026-11-13T23:59:00.000Z"
    );
    expect((await ownerBriefHistory(f.ownerId)).items).toHaveLength(0);
  });
  it("does not backfill an old calendar period using current source outcomes", async () => {
    const f = await fixture();
    await enabled(f);
    const scheduled = await scheduleOwnerBrief(
        f.ownerId,
        new Date("2026-11-12T12:00:00Z")
      ),
      job = (
        await f.db
          .select()
          .from(schema.automationQueue)
          .where(eq(schema.automationQueue.id, scheduled.jobId))
      )[0];
    expect(
      (
        await executeOwnerBrief(
          f.ownerId,
          job.payload,
          new Date("2026-11-13T12:00:00Z")
        )
      ).status
    ).toBe("cancelled");
    expect((await ownerBriefHistory(f.ownerId)).items).toHaveLength(0);
  });
  it("does not rearm a manually cancelled task until a new owner configuration authorizes it", async () => {
    const f = await fixture();
    await enabled(f);
    const a = await scheduleOwnerBrief(f.ownerId);
    await f.db
      .update(schema.automationQueue)
      .set({ status: "cancelled" })
      .where(eq(schema.automationQueue.id, a.jobId));
    await scheduleOwnerBrief(f.ownerId);
    expect(
      (
        await f.db
          .select()
          .from(schema.automationQueue)
          .where(eq(schema.automationQueue.id, a.jobId))
      )[0].status
    ).toBe("cancelled");
    const current = await getOwnerBriefSettings(f.ownerId);
    await configureOwnerBrief(f.ownerId, f.ownerId, {
      expectedRevision: current.revision,
      fields: { ...current.fields, attentionHours: 12 },
      reason: "Explicit synthetic schedule replacement after cancellation.",
    });
    await scheduleOwnerBrief(f.ownerId);
    expect(
      (
        await f.db
          .select()
          .from(schema.automationQueue)
          .where(eq(schema.automationQueue.id, a.jobId))
      )[0].status
    ).toBe("queued");
  });
  it("rejects stale settings and invalidates unused tasks without reusing old authority", async () => {
    const f = await fixture();
    await enabled(f);
    const a = await scheduleOwnerBrief(f.ownerId),
      job = (
        await f.db
          .select()
          .from(schema.automationQueue)
          .where(eq(schema.automationQueue.id, a.jobId))
      )[0],
      s = await getOwnerBriefSettings(f.ownerId);
    await configureOwnerBrief(f.ownerId, f.ownerId, {
      expectedRevision: s.revision,
      fields: { ...s.fields, enabled: false },
      reason: "Disable the synthetic internal schedule.",
    });
    await expect(
      configureOwnerBrief(f.ownerId, f.ownerId, {
        expectedRevision: s.revision,
        fields: { ...s.fields, time: "10:00" },
        reason:
          "Stale synthetic owner settings must not replace current authority.",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await executeOwnerBrief(f.ownerId, job.payload)).status).toBe(
      "cancelled"
    );
    expect(
      (
        await f.db
          .select()
          .from(schema.automationQueue)
          .where(eq(schema.automationQueue.id, a.jobId))
      )[0].status
    ).toBe("cancelled");
  });
  it("respects emergency stop and worker disablement at both scheduling and execution", async () => {
    const f = await fixture();
    await enabled(f);
    const a = await scheduleOwnerBrief(f.ownerId),
      job = (
        await f.db
          .select()
          .from(schema.automationQueue)
          .where(eq(schema.automationQueue.id, a.jobId))
      )[0];
    await f.db
      .update(schema.workspaceSettings)
      .set({ emergencyStop: true })
      .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
    expect((await scheduleOwnerBrief(f.ownerId)).status).toBe("disabled");
    expect((await executeOwnerBrief(f.ownerId, job.payload)).status).toBe(
      "cancelled"
    );
    await f.db
      .update(schema.workspaceSettings)
      .set({ emergencyStop: false, backgroundEnabled: false })
      .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
    expect((await processOneQueuedJob(f.ownerId)).status).toBe("empty");
  });
  it("generates a deterministic scheduled summary through the existing queue without using the AI budget", async () => {
    const f = await fixture();
    await enabled(f);
    await f.db
      .update(schema.workspaceSettings)
      .set({ policyConfig: { aiDailyLimit: 0 } })
      .where(eq(schema.workspaceSettings.ownerId, f.ownerId));
    // A full first page of higher-priority AI work cannot starve internal work
    // after the AI quota is exhausted.
    await f.db.insert(schema.automationQueue).values(
      Array.from({ length: 26 }, (_, index) => ({
        id: createId("que_"),
        ownerId: f.ownerId,
        jobType: "score_match",
        status: "queued" as const,
        priority: 1,
        scheduledAt: new Date(Date.now() - 1000),
        payload: { jobId: f.jobId },
        idempotencyKey: `brief-budget:${f.ownerId}:${index}`,
      }))
    );
    const scheduled = await scheduleOwnerBrief(f.ownerId);
    expect((await processOneQueuedJob(f.ownerId)).status).toBe("completed");
    const h = await ownerBriefHistory(f.ownerId);
    expect(h.items).toHaveLength(1);
    expect(h.items[0].id).toBe(scheduled.id);
    expect(h.items[0].mode).toBe("scheduled");
    expect(
      await f.db
        .select()
        .from(schema.aiUsage)
        .where(eq(schema.aiUsage.ownerId, f.ownerId))
    ).toHaveLength(0);
    expect(
      await f.db
        .select()
        .from(schema.emailDispatches)
        .where(eq(schema.emailDispatches.ownerId, f.ownerId))
    ).toHaveLength(0);
    expect((await scheduleOwnerBrief(f.ownerId)).status).toBe(
      "already_generated"
    );
  });
  it("publishes an opted-in summary from the managed worker cycle without external notification authority", async () => {
    const f = await fixture();
    await f.db
      .update(schema.interviews)
      .set({ status: "cancelled", reminderAt: null })
      .where(eq(schema.interviews.ownerId, f.ownerId));
    await enabled(f);
    let found = false;
    for (let i = 0; i < 5; i++) {
      await runManagedAutomationCycle(5);
      if ((await ownerBriefHistory(f.ownerId)).items.length) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
    expect((await ownerBriefHistory(f.ownerId)).items[0].mode).toBe(
      "scheduled"
    );
    expect(
      await f.db
        .select()
        .from(schema.emailDispatches)
        .where(eq(schema.emailDispatches.ownerId, f.ownerId))
    ).toHaveLength(0);
  });
  it("persists observed decimal durations without MySQL binary-float round-trip hash drift", async () => {
    const f = await fixture(),
      id = createId("que_");
    await f.db.insert(schema.automationQueue).values({
      id,
      ownerId: f.ownerId,
      jobType: "score_match",
      status: "queued",
      idempotencyKey: "brief-decimal:" + id,
      payload: { jobId: f.jobId },
      scheduledAt: new Date(Date.now() - 45123),
      createdAt: new Date(Date.now() - 60000),
    });
    await recordOwnerBrief(f.ownerId, f.ownerId, "synthetic-decimal-duration");
    const h = await ownerBriefHistory(f.ownerId);
    expect(typeof h.items[0].summary.workflow.oldestDueHours).toBe("string");
    expect(h.items[0].summary.workflow.oldestDueHours).toMatch(/^\d+\.\d{6}$/);
    expect(
      h.items[0].summary.placementCohort.stages.every(
        (s: any) => s.percent === null || typeof s.percent === "string"
      )
    ).toBe(true);
  });
  it("surfaces due follow-ups and expired recorded deadlines without mutating their governing plan", async () => {
    const f = await fixture(),
      p = await f.enroll();
    await f.db
      .update(schema.followUpPlans)
      .set({
        nextActionAt: new Date(Date.now() - 60000),
        createdAt: new Date(Date.now() - 120000),
      })
      .where(eq(schema.followUpPlans.id, p.id));
    let r = await ownerOverview(f.ownerId, overviewInput);
    expect(
      r.cases.find(c => c.kind === "followup" && c.id === p.id)?.path
    ).toBe("/follow-ups");
    await f.db
      .update(schema.followUpPlans)
      .set({ deadlineAt: new Date(Date.now() - 60000) })
      .where(eq(schema.followUpPlans.id, p.id));
    r = await ownerOverview(f.ownerId, overviewInput);
    expect(
      r.cases.find(c => c.kind === "followup" && c.id === p.id)?.priority
    ).toBe(30);
    expect((await f.getPlan(p.id)).status).toBe("scheduled");
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")(
    "serializes two schedule pollers into one physical task and one generated summary",
    async () => {
      const f = await fixture();
      await enabled(f);
      const results = await Promise.all([
        scheduleOwnerBrief(f.ownerId),
        scheduleOwnerBrief(f.ownerId),
      ]);
      expect(results[0].jobId).toBe(results[1].jobId);
      const job = (
        await f.db
          .select()
          .from(schema.automationQueue)
          .where(eq(schema.automationQueue.id, results[0].jobId))
      )[0];
      await Promise.all([
        executeOwnerBrief(f.ownerId, job.payload),
        executeOwnerBrief(f.ownerId, job.payload),
      ]);
      expect((await ownerBriefHistory(f.ownerId)).items).toHaveLength(1);
    }
  );
});
