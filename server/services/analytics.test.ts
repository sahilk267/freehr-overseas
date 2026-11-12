import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import * as dbModule from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import {
  buildAnalyticsReport,
  ANALYTICS_TABLES,
  type AnalyticsData,
} from "./analyticsModel";
import {
  getAnalyticsReport,
  exportAnalyticsReport,
  analyticsInTransaction,
  ANALYTICS_SOURCE_LIMIT,
  analyticsScopeOptions,
} from "./analytics";
import { formatAnalyticsMoney, analyticsCsvCell } from "../../shared/analytics";
const at = (s: string) => new Date("2026-11-" + s + "Z"),
  asOf = at("12T12:00:00"),
  input = {
    from: at("01T00:00:00"),
    to: asOf,
    timezone: "Asia/Kolkata",
    replyWindowHours: 72,
  };
const row = (id: string, rest: any = {}) => ({
  id,
  ownerId: 1,
  createdAt: at("02T12:00:00"),
  ...rest,
});
function data() {
  const d: AnalyticsData = Object.fromEntries(
    ANALYTICS_TABLES.map(t => [t, []])
  );
  d.companies = [row("company1", { pipelineState: "identified" })];
  d.jobs = [row("job001", { companyId: "company1", pipelineState: "open" })];
  d.candidates = [row("candidate1", { profileState: "consented" })];
  d.placements = [
    row("placement1", {
      candidateId: "candidate1",
      companyId: "company1",
      jobId: "job001",
      status: "offer_pending",
    }),
  ];
  d.invoices = [
    row("invoice1", {
      placementId: "placement1",
      companyId: "company1",
      status: "payment_pending",
      currency: "INR",
      amount: 10000,
      taxAmount: 1800,
      issuedAt: at("03T12:00:00"),
      dueAt: at("08T12:00:00"),
    }),
  ];
  d.payments = [
    row("payment1", {
      invoiceId: "invoice1",
      status: "succeeded",
      currency: "INR",
      amount: 2000,
      provider: "manual",
      providerEventId: "manual-reference",
      createdAt: at("05T12:00:00"),
    }),
  ];
  return d;
}
const report = (d = data(), overrides: any = {}) =>
  buildAnalyticsReport(1, { ...input, ...overrides }, d, asOf);
function verified(d: AnalyticsData, mode = "live") {
  const p = d.payments[0];
  p.provider = "stripe_verified";
  p.providerEventId = "pi_synthetic";
  d.events.push(
    row("request1", {
      eventType: "payment.checkout_requested",
      aggregateId: "intent1",
      revision: 1,
      metadata: {
        invoiceId: p.invoiceId,
        amount: p.amount,
        currency: p.currency,
        mode,
      },
    }),
    row("observed1", {
      eventType: "payment.provider_observed",
      aggregateId: "intent1",
      revision: 1,
      metadata: {
        invoiceId: p.invoiceId,
        amount: p.amount,
        currency: p.currency,
        mode,
        paymentIntentId: p.providerEventId,
      },
    }),
    row("verified1", {
      eventType: "payment.provider_verified",
      aggregateId: "intent1",
      revision: 1,
      metadata: {
        invoiceId: p.invoiceId,
        paymentId: p.id,
        paymentIntentId: p.providerEventId,
        mode,
      },
    })
  );
  return d;
}
function followups(d: AnalyticsData) {
  d.conversations = [
    row("thread1", {
      companyId: "company1",
      jobId: "job001",
      candidateId: "candidate1",
      channel: "email",
    }),
  ];
  d.plans = [
    row("plan001", {
      conversationId: "thread1",
      scenarioId: "FU09",
      revision: 1,
      status: "waiting",
      stepIndex: 1,
    }),
  ];
  d.messages = [
    row("out001", {
      conversationId: "thread1",
      direction: "outbound",
      status: "sent",
      sentAt: at("02T12:00:00"),
      messageId: "<first@synthetic.test>",
    }),
    row("in001", {
      conversationId: "thread1",
      direction: "inbound",
      status: "received",
      createdAt: at("03T12:00:00"),
    }),
  ];
  d.dispatches = [
    row("dispatch1", {
      messageId: "out001",
      planId: "plan001",
      planRevision: 1,
      stepIndex: 0,
      status: "sent",
      recipientHash: "a".repeat(64),
      claimedAt: at("02T12:00:00"),
    }),
  ];
  return d;
}
describe("versioned operational analytics and honest finance semantics", () => {
  it("reconciles invoice tax, recorded receipts and open/overdue book balance exactly", () => {
    const r = report();
    expect(r.finance[0]).toMatchObject({
      currency: "INR",
      issuedBookMinor: "11800",
      recordedReceiptsMinor: "2000",
      openReceivableMinor: "9800",
      overdueReceivableMinor: "9800",
      providerVerifiedMinor: "0",
      bankClearedMinor: null,
      contributionMarginMinor: null,
    });
    expect(r.quality.financialCompleteness).toBe(true);
  });
  it("does not turn manual paid status or a claimed provider name into verified bank cash", () => {
    const d = data();
    d.invoices[0].status = "paid";
    d.payments[0].provider = "stripe_verified";
    const r = report(d);
    expect(r.finance[0].providerVerifiedMinor).toBe("0");
    expect(r.finance[0].bankClearedMinor).toBeNull();
    expect(
      r.quality.issues.some(i => i.code === "paid_status_does_not_reconcile")
    ).toBe(true);
  });
  it("requires exact live request/observation/payment evidence and never promotes sandbox receipts", () => {
    expect(report(verified(data())).finance[0].providerVerifiedMinor).toBe(
      "2000"
    );
    expect(
      report(verified(data(), "test")).finance[0].providerVerifiedMinor
    ).toBe("0");
    const d = verified(data());
    d.events.find(e => e.id === "observed1")!.metadata.amount = 2001;
    expect(report(d).finance[0].providerVerifiedMinor).toBe("0");
    expect(report(d).quality.financialCompleteness).toBe(false);
  });
  it("deduplicates replayed rows and repeated provider receipt evidence", () => {
    const d = verified(data());
    d.payments.push({ ...d.payments[0] });
    d.events.push({ ...d.events[2], id: "verified_again" });
    const r = report(d);
    expect(r.finance[0].recordedReceiptsMinor).toBe("2000");
    expect(r.finance[0].providerVerifiedMinor).toBe("2000");
    expect(r.sources.receipts).toHaveLength(1);
  });
  it("rejects conflicting duplicate source identities instead of picking an arbitrary amount", () => {
    const d = data();
    d.payments.push({ ...d.payments[0], amount: 1 });
    expect(() => report(d)).toThrow(/Conflicting duplicate/);
  });
  it("quarantines wrong-currency and orphan receipts instead of offsetting invoice balances", () => {
    const d = data();
    d.payments[0].currency = "USD";
    d.payments.push(
      row("orphan", {
        invoiceId: "unowned-invoice",
        status: "succeeded",
        currency: "INR",
        amount: 500,
      })
    );
    const r = report(d);
    expect(r.finance[0].recordedReceiptsMinor).toBe("0");
    expect(r.finance[0].openReceivableMinor).toBe("11800");
    expect(r.quality.issues.map(i => i.code)).toContain(
      "invalid_or_cross_currency_receipt"
    );
    expect(r.quality.issues.map(i => i.code)).toContain(
      "unowned_or_missing_invoice"
    );
  });
  it("keeps currency totals independent, including zero/three-decimal currency presentation", () => {
    const d = data();
    d.invoices.push(
      row("invoiceJPY", {
        placementId: "placement1",
        companyId: "company1",
        status: "issued",
        currency: "JPY",
        amount: 500,
        taxAmount: 0,
        issuedAt: at("03T12:00:00"),
      })
    );
    const r = report(d);
    expect(r.finance.map(f => f.currency)).toEqual(["INR", "JPY"]);
    expect(r.finance[1].issuedBookMinor).toBe("500");
    expect(formatAnalyticsMoney("123", "JPY")).not.toMatch(/\.\d/);
    expect(formatAnalyticsMoney("1234", "KWD")).toContain("1.234");
  });
  it("sums and formats huge integer totals without floating-point rounding", () => {
    const d = data();
    d.payments = [];
    d.invoices[0].amount = Number.MAX_SAFE_INTEGER;
    d.invoices[0].taxAmount = 0;
    d.invoices.push({ ...d.invoices[0], id: "invoice2" });
    const value = (BigInt(Number.MAX_SAFE_INTEGER) * 2n).toString();
    expect(report(d).finance[0].issuedBookMinor).toBe(value);
    expect(
      formatAnalyticsMoney("900719925474099312345", "KWD").replace(/\D/g, "")
    ).toBe("900719925474099312345");
    expect(formatAnalyticsMoney("-1", "USD")).toMatch(/^-/);
  });
  it("does not net an overpayment against another invoice or count a cancelled residual as collectible", () => {
    const d = data();
    d.payments[0].amount = 12800;
    d.invoices.push({ ...d.invoices[0], id: "invoice2", status: "cancelled" });
    const r = report(d);
    expect(r.finance[0]).toMatchObject({
      openReceivableMinor: "0",
      overpaymentMinor: "1000",
      noncollectibleResidualMinor: "11800",
    });
    expect(
      r.quality.issues.some(
        i => i.code === "invoice_overpayment_requires_reconciliation"
      )
    ).toBe(true);
  });
  it("keeps snapshot receipts separate from receipts posted within the half-open period", () => {
    const d = data();
    d.payments[0].createdAt = at("05T12:00:00");
    const r = report(d, { from: at("06T00:00:00") });
    expect(r.finance[0].recordedReceiptsMinor).toBe("2000");
    expect(r.finance[0].postedReceiptsMinor).toBe("0");
    expect(r.sources.receipts[0].inPeriod).toBe(false);
  });
  it("uses explicit ownership for cohorts and never reads foreign records into totals", () => {
    const d = data();
    d.payments.push({
      ...d.payments[0],
      id: "foreign",
      ownerId: 2,
      amount: 200000,
    });
    d.companies.push(
      row("foreignCompany", { ownerId: 2, pipelineState: "active" })
    );
    expect(report(d).finance[0].recordedReceiptsMinor).toBe("2000");
    expect(
      report(d).inventory.find(i => i.resourceType === "company")
        ?.snapshotRecords
    ).toBe(1);
    expect(() => report(d, { companyId: "foreignCompany" })).toThrow(
      /Owned report scope/
    );
  });
  it("rejects a cross-client job filter and excludes other-job tasks even for a shared candidate", () => {
    const d = data();
    d.jobs.push(
      row("job002", { companyId: "company1", pipelineState: "open" })
    );
    d.companies.push(row("company2", { pipelineState: "identified" }));
    expect(() => report(d, { companyId: "company2", jobId: "job001" })).toThrow(
      /same scope/
    );
    d.queue = [
      row("task1", {
        jobType: "score_match",
        status: "queued",
        payload: { jobId: "job002", candidateId: "candidate1" },
        scheduledAt: at("11T00:00:00"),
        attempts: 1,
      }),
    ];
    expect(report(d, { jobId: "job001" }).workflow.dueTasks).toBe(0);
  });
  it("keeps workspace client threads without a job in unfiltered follow-up scope", () => {
    const d = followups(data());
    d.conversations[0].jobId = null;
    expect(report(d).followups.logicalAcceptedSteps).toBe(1);
    expect(report(d, { jobId: "job001" }).followups.logicalAcceptedSteps).toBe(
      0
    );
  });
  it("quarantines an invoice whose client disagrees with its exact owned placement", () => {
    const d = data();
    d.companies.push(row("company2", { pipelineState: "active" }));
    d.invoices[0].companyId = "company2";
    const r = report(d);
    expect(r.finance).toHaveLength(0);
    expect(r.sources.receipts).toHaveLength(0);
    expect(r.quality.financialCompleteness).toBe(false);
  });
  it("does not assign a current stage age from two conflicting transitions at the same timestamp", () => {
    const d = data();
    d.companies[0].pipelineState = "qualified";
    d.audits = [
      row("audit1", {
        resourceType: "company",
        resourceId: "company1",
        previousState: "identified",
        nextState: "contacted",
      }),
      row("audit2", {
        resourceType: "company",
        resourceId: "company1",
        previousState: "contacted",
        nextState: "qualified",
      }),
    ];
    const r = report(d);
    expect(r.stages.brokenTransitions).toBe(1);
    expect(r.stages.rows).toHaveLength(0);
  });
  it("shows no invented conversion percent for an empty placement cohort", () => {
    const d = data();
    d.placements[0].createdAt = at("01T00:00:00");
    const r = report(d, { from: at("02T00:00:00") });
    expect(r.cohort.placements).toBe(0);
    expect(r.cohort.stages.every(s => s.percent === null)).toBe(true);
  });
  it("distinguishes recorded acceptance from an exact email-possession receipt and approved joining", () => {
    const d = data();
    d.placements[0].offerAcceptedAt = at("05T12:00:00");
    d.placements[0].joiningConfirmedAt = at("06T12:00:00");
    let r = report(d);
    expect(
      r.cohort.stages.find(s => s.id === "recorded_offer")?.numerator
    ).toBe(1);
    expect(
      r.cohort.stages.find(s => s.id === "email_acceptance")?.numerator
    ).toBe(0);
    d.events.push(
      row("accept1", {
        eventType: "offer.accepted",
        aggregateId: "offer1",
        revision: 1,
        metadata: {
          placementId: "placement1",
          candidateId: "candidate1",
          emailPossessionVerified: true,
          termsHash: "a".repeat(64),
        },
      }),
      row("join1", {
        eventType: "placement.lifecycle_joining_date",
        aggregateId: "placement1",
        revision: 1,
        metadata: {
          candidateId: "candidate1",
          joinedAt: at("06T12:00:00").toISOString(),
          approvalId: "approval1",
        },
      })
    );
    d.approvals = [
      row("approval1", {
        resourceId: "placement1",
        actionType: "placement_confirmation",
        status: "approved",
        actionedAt: at("06T12:00:00"),
      }),
    ];
    r = report(d);
    expect(
      r.cohort.stages.find(s => s.id === "email_acceptance")?.numerator
    ).toBe(1);
    expect(r.cohort.stages.find(s => s.id === "joining")?.numerator).toBe(1);
    expect(r.sources.funnel[0].bankClearingVerified).toBe(false);
  });
  it("does not resurrect erased receipt/joining evidence in a current snapshot", () => {
    const d = data();
    d.events.push(
      row("redacted", {
        eventType: "offer.accepted",
        aggregateId: "offer1",
        revision: 1,
        metadata: {
          redacted: true,
          placementId: "placement1",
          candidateId: "candidate1",
          emailPossessionVerified: true,
          termsHash: "a".repeat(64),
        },
      })
    );
    expect(
      report(d).cohort.stages.find(s => s.id === "email_acceptance")?.numerator
    ).toBe(0);
  });
  it("associates each ingested reply once and separates immature windows from mature descriptive rates", () => {
    const d = followups(data());
    d.messages.push(
      row("in002", {
        conversationId: "thread1",
        direction: "inbound",
        status: "received",
        createdAt: at("03T13:00:00"),
      })
    );
    let r = report(d);
    expect(r.followups.groups[0]).toMatchObject({
      acceptedSteps: 1,
      maturedSteps: 1,
      replyAssociatedMaturedSteps: 1,
      replyAssociationPercent: 100,
    });
    expect(r.sources.followups).toHaveLength(2);
    expect(r.followups.replyAssociatedSteps).toBe(1);
    d.messages[0].sentAt = at("11T12:00:00");
    r = report(d);
    expect(r.followups.groups[0].openWindows).toBe(1);
    expect(r.followups.groups[0].replyAssociationPercent).toBeNull();
    expect(r.followups.arrivalTimingVerified).toBe(false);
  });
  it("assigns temporal association to the latest prior step in the same thread, without causal credit", () => {
    const d = followups(data());
    d.messages.push(
      row("out002", {
        conversationId: "thread1",
        direction: "outbound",
        status: "sent",
        sentAt: at("03T00:00:00"),
        messageId: "<second@synthetic.test>",
      })
    );
    d.dispatches.push(
      row("dispatch2", {
        ...d.dispatches[0],
        id: "dispatch2",
        messageId: "out002",
        stepIndex: 1,
      })
    );
    const r = report(d);
    expect(r.sources.followups[0].dispatchId).toBe("dispatch2");
    expect(r.sources.followups[0].method).toBe("temporal_thread_only");
    expect(r.followups.associationIsCausal).toBe(false);
  });
  it("prefers a real recorded reply reference to an older step over a newer unrelated acceptance", () => {
    const d = followups(data());
    d.messages[1].inReplyTo = "<first@synthetic.test>";
    d.messages.push(
      row("out002", {
        conversationId: "thread1",
        direction: "outbound",
        status: "sent",
        sentAt: at("03T00:00:00"),
        messageId: "<second@synthetic.test>",
      })
    );
    d.dispatches.push({
      ...d.dispatches[0],
      id: "dispatch2",
      messageId: "out002",
      stepIndex: 1,
    });
    const r = report(d);
    expect(r.sources.followups[0].dispatchId).toBe("dispatch1");
    expect(r.sources.followups[0].method).toBe("reference_linked");
    expect(r.followups.groups[0].referenceLinkedMaturedSteps).toBe(1);
  });
  it("does not credit an unmatched explicit reply, another conversation or an ambiguous same-time acceptance", () => {
    const d = followups(data());
    d.messages[1].inReplyTo = "<unmatched@synthetic.test>";
    expect(report(d).sources.followups).toHaveLength(0);
    d.messages[1].inReplyTo = null;
    d.messages.push({
      ...d.messages[0],
      id: "out002",
      messageId: "<second@synthetic.test>",
    });
    d.dispatches.push({
      ...d.dispatches[0],
      id: "dispatch2",
      messageId: "out002",
      stepIndex: 1,
    });
    const r = report(d);
    expect(r.sources.followups).toHaveLength(0);
    expect(
      r.quality.issues.some(i => i.code === "ambiguous_same_time_attribution")
    ).toBe(true);
  });
  it("keeps duplicate physical acceptance visible while deduplicating a logical step", () => {
    const d = followups(data());
    d.dispatches.push({ ...d.dispatches[0], id: "dispatch2" });
    const r = report(d);
    expect(r.followups.logicalAcceptedSteps).toBe(1);
    expect(r.followups.physicalAcceptedDispatches).toBe(2);
    expect(
      r.quality.issues.some(i => i.code === "duplicate_logical_acceptance")
    ).toBe(true);
    expect(JSON.stringify(r.followups.recipientFatigue)).not.toContain(
      "a".repeat(64)
    );
  });
  it("never infers stage entry from updatedAt or the entity creation date", () => {
    const d = data();
    d.companies[0].updatedAt = at("11T12:00:00");
    const r = report(d);
    expect(r.stages.rows).toHaveLength(0);
    expect(r.stages.unknownCurrentStageAges).toBeGreaterThan(0);
  });
  it("computes only consistent audited completed intervals and a matching last-state age", () => {
    const d = data();
    d.companies[0].pipelineState = "qualified";
    d.audits = [
      row("audit1", {
        resourceType: "company",
        resourceId: "company1",
        previousState: "identified",
        nextState: "contacted",
        createdAt: at("02T12:00:00"),
      }),
      row("audit2", {
        resourceType: "company",
        resourceId: "company1",
        previousState: "contacted",
        nextState: "qualified",
        createdAt: at("04T12:00:00"),
      }),
    ];
    let r = report(d);
    expect(r.stages.rows.find(s => s.state === "contacted")).toMatchObject({
      completedIntervals: 1,
      medianCompletedHours: 48,
    });
    expect(
      r.stages.rows.find(s => s.state === "qualified")?.oldestKnownCurrentHours
    ).toBe(192);
    d.audits[1].previousState = "different_manual_state";
    r = report(d);
    expect(r.stages.brokenTransitions).toBe(1);
    expect(r.stages.rows.some(s => s.state === "contacted")).toBe(false);
  });
  it("counts source tasks, retry attempts and stale leases without executing or recovering them", () => {
    const d = data();
    d.queue = [
      row("queue1", {
        jobType: "score_match",
        status: "retryable_failed",
        payload: { jobId: "job001" },
        attempts: 3,
        scheduledAt: at("11T12:00:00"),
      }),
      row("queue2", {
        jobType: "deliver_email",
        status: "running",
        payload: {},
        attempts: 1,
        lockedAt: at("12T11:00:00"),
        scheduledAt: at("12T11:00:00"),
      }),
    ];
    d.usage = [
      row("usage1", {
        taskType: "parse_cv",
        selectedModel: "synthetic:free",
        status: "succeeded",
        latencyMs: 250,
      }),
    ];
    const r = report(d);
    expect(r.workflow).toMatchObject({
      dueTasks: 1,
      retryAttempts: 2,
      staleRunningLeases: 1,
      inferenceAttempts: 1,
      inferenceSucceeded: 1,
      medianLatencyMs: 250,
      modelCostMinor: null,
      factuality: null,
      effortSavedHours: null,
    });
    expect(d.queue[0].status).toBe("retryable_failed");
  });
  it("groups daily posted receipts by selected timezone while keeping currencies separate", () => {
    const d = data();
    d.payments[0].createdAt = new Date("2026-11-05T23:30:00Z");
    expect(
      report(d).daily.find(r => r.postedReceiptsMinor === "2000")?.day
    ).toBe("2026-11-06");
    expect(
      report(d, { timezone: "UTC" }).daily.find(
        r => r.postedReceiptsMinor === "2000"
      )?.day
    ).toBe("2026-11-05");
  });
  it("keeps source digests stable across SQL-style key/row ordering, and changes them when the source ledger changes", () => {
    const d = verified(data()),
      digest = report(d).sourceDigest,
      copy = structuredClone(d);
    copy.events.reverse();
    copy.invoices[0] = Object.fromEntries(
      Object.entries(copy.invoices[0]).reverse()
    );
    expect(report(copy).sourceDigest).toBe(digest);
    copy.payments[0].amount = 2001;
    expect(report(copy).sourceDigest).not.toBe(digest);
  });
  it("changes the export digest when time alone changes a due-task drilldown", () => {
    const d = data();
    d.queue = [
      row("task1", {
        jobType: "score_match",
        status: "queued",
        payload: { jobId: "job001" },
        scheduledAt: at("12T12:01:00"),
        attempts: 0,
      }),
    ];
    const before = report(d),
      after = buildAnalyticsReport(1, input, d, at("12T12:02:00"));
    expect(before.sources.workflow).toHaveLength(0);
    expect(after.sources.workflow).toHaveLength(1);
    expect(after.sourceDigest).not.toBe(before.sourceDigest);
  });
  it("fails invalid/future/overlong periods and reports unknown source timestamp coverage", () => {
    for (const override of [
      { from: asOf, to: asOf },
      { from: at("11T12:00:00"), to: at("13T12:00:00") },
      { from: new Date("2024-01-01") },
    ])
      expect(() => report(data(), override)).toThrow(/period|time/);
    const d = data();
    d.candidates[0].createdAt = null;
    expect(report(d).quality.missingCreatedTimestamps.candidates).toBe(1);
  });
  it("quotes CSV syntax and neutralizes spreadsheet formulas without changing ordinary negative numeric text", () => {
    expect(analyticsCsvCell('=HYPERLINK("x")')).toContain("'=HYPERLINK");
    expect(analyticsCsvCell("\t+command")).toContain("'\t+command");
    expect(analyticsCsvCell('a,"b"')).toBe('"a,""b"""');
    expect(analyticsCsvCell("-12")).toBe('"-12"');
  });
});
const owners: number[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const ownerId of owners.splice(0))
    await (await dbModule.requireDb())
      .update(schema.workspaceSettings)
      .set({ backgroundEnabled: false })
      .where(eq(schema.workspaceSettings.ownerId, ownerId));
});
async function fixture() {
  const f = await followupFixture();
  owners.push(f.ownerId);
  const stamp = new Date(Date.now() - 2 * 3600000);
  for (const table of [
    schema.companies,
    schema.jobs,
    schema.candidates,
    schema.contacts,
    schema.conversations,
    schema.emailIdentities,
    schema.interviews,
    schema.placements,
    schema.invoices,
  ])
    await f.db
      .update(table)
      .set({ createdAt: stamp })
      .where(eq(table.ownerId, f.ownerId));
  await f.db
    .update(schema.invoices)
    .set({ issuedAt: stamp, dueAt: new Date(Date.now() - 3600000) })
    .where(eq(schema.invoices.id, f.invoiceId));
  return {
    ...f,
    input: {
      from: new Date(Date.now() - 86400000),
      to: new Date(),
      timezone: "Asia/Kolkata",
      replyWindowHours: 72,
    },
  };
}
describe("owner analytics read models and source-bound export", () => {
  it("reads exact owned SQL-compatible source projections and exports complete ledger rows", async () => {
    const f = await fixture(),
      r = await getAnalyticsReport(f.ownerId, f.input);
    expect(r.finance[0]).toMatchObject({
      issuedBookMinor: "10000",
      openReceivableMinor: "10000",
    });
    const exported = await exportAnalyticsReport(f.ownerId, {
      report: f.input,
      expectedSourceDigest: r.sourceDigest,
      section: "finance",
    });
    expect(exported.rowCount).toBe(1);
    expect(exported.csv).toContain(f.invoiceId);
    expect(exported.csv).toContain("Metric version");
    expect(exported.csv).not.toContain("owner@example.test");
  });
  it("does not load message bodies, profile names, recipient addresses, errors or arbitrary queue input into reports/CSV", async () => {
    const f = await fixture(),
      id = dbModule.createId("que_");
    await f.db.insert(schema.automationQueue).values({
      id,
      ownerId: f.ownerId,
      jobType: "score_match",
      status: "blocked",
      payload: { jobId: f.jobId, secret: "PRIVATE_MARKER" },
      lastError: "PRIVATE_MARKER",
      idempotencyKey: id,
    });
    const r = await getAnalyticsReport(f.ownerId, f.input),
      body = JSON.stringify(r);
    expect(body).not.toContain("PRIVATE_MARKER");
    expect(body).not.toContain("Synthetic candidate");
    expect(body).not.toContain(f.address);
  });
  it("denies another owner’s client/job scope and gives no anonymous access", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      getAnalyticsReport(f.ownerId, { ...f.input, companyId: other.companyId })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { appRouter } = await import("../routers");
    const caller = appRouter.createCaller({
      user: null,
      actor: null,
      req: { headers: {} },
      res: {},
    } as any);
    await expect(caller.analytics.report(f.input)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("rejects an export when ledger facts changed instead of silently exporting different totals", async () => {
    const f = await fixture(),
      r = await getAnalyticsReport(f.ownerId, f.input);
    await f.db
      .update(schema.invoices)
      .set({ amount: 11000 })
      .where(eq(schema.invoices.id, f.invoiceId));
    await expect(
      exportAnalyticsReport(f.ownerId, {
        report: f.input,
        expectedSourceDigest: r.sourceDigest,
        section: "finance",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("fails closed before presenting partial totals if a source exceeds the bounded read limit", async () => {
    const records = Array.from(
        { length: ANALYTICS_SOURCE_LIMIT + 1 },
        (_, i) => ({ id: String(i), ownerId: 1 })
      ),
      tx = {
        select: () => ({
          from: () => ({
            where: () => ({ orderBy: () => ({ limit: async () => records }) }),
          }),
        }),
      };
    await expect(
      analyticsInTransaction(tx, 1, input, asOf)
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("searches only owned client/role scope options and preserves selected client boundaries", async () => {
    const f = await fixture(),
      other = await fixture(),
      options = await analyticsScopeOptions(f.ownerId, {
        kind: "job",
        companyId: f.companyId,
        search: "Backend",
      });
    expect(options.rows.map(r => r.id)).toContain(f.jobId);
    expect(options.rows.map(r => r.id)).not.toContain(other.jobId);
    await expect(
      analyticsScopeOptions(f.ownerId, {
        kind: "job",
        companyId: other.companyId,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")(
    "reconciles report book balances to canonical receipt rows in an isolated real MySQL transaction",
    async () => {
      const f = await fixture(),
        id = dbModule.createId("pay_");
      await f.db.insert(schema.payments).values({
        id,
        ownerId: f.ownerId,
        invoiceId: f.invoiceId,
        amount: 1234,
        currency: "INR",
        status: "succeeded",
        provider: "synthetic_manual",
        providerEventId: id,
        createdAt: new Date(Date.now() - 3600000),
      });
      const r = await getAnalyticsReport(f.ownerId, f.input);
      expect(r.finance[0]).toMatchObject({
        recordedReceiptsMinor: "1234",
        openReceivableMinor: "8766",
        postedReceiptsMinor: "1234",
        providerVerifiedMinor: "0",
        bankClearedMinor: null,
      });
      const count = (
        await f.db
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.ownerId, f.ownerId))
      ).length;
      await getAnalyticsReport(f.ownerId, f.input);
      expect(
        (
          await f.db
            .select()
            .from(schema.payments)
            .where(eq(schema.payments.ownerId, f.ownerId))
        ).length
      ).toBe(count);
    }
  );
});
