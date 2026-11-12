import { createHash } from "node:crypto";
import {
  ANALYTICS_VERSION,
  ANALYTICS_DEFINITIONS,
} from "../../shared/analytics";
import { localClock } from "./workflowTiming";
export type AnalyticsData = Record<string, any[]>;
export const ANALYTICS_TABLES = [
  "companies",
  "jobs",
  "candidates",
  "matches",
  "shortlists",
  "interviews",
  "placements",
  "invoices",
  "payments",
  "conversations",
  "messages",
  "plans",
  "dispatches",
  "queue",
  "usage",
  "approvals",
  "incidents",
  "audits",
  "events",
] as const;
export const ANALYTICS_EVENTS = [
  "payment.checkout_requested",
  "payment.provider_observed",
  "payment.provider_verified",
  "payment.checkout_terminal",
  "payment.provider_adjustment_observed",
  "payment.review_required",
  "payment.review_resolved",
  "offer.accepted",
  "placement.lifecycle_joining_date",
  "replacement.job_opened",
  "followup.message_accepted",
  "followup.late_acceptance",
  "email.reconciled",
  "outreach.reply_received",
] as const;
export function stableAnalyticsHash(value: unknown): string {
  const canonical = (v: any): any =>
    v instanceof Date
      ? v.toISOString()
      : Array.isArray(v)
        ? v.map(canonical)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map(k => [k, canonical(v[k])])
            )
          : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
const time = (value: unknown) =>
  value == null ? NaN : new Date(value as any).getTime();
const valid = (v: unknown) => Number.isFinite(time(v));
const supportedCurrencies = new Set(Intl.supportedValuesOf("currency"));
const currency = (v: unknown) =>
  typeof v === "string" && supportedCurrencies.has(v);
const integer = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const countStates = (rows: any[], field: string) =>
  Object.entries(
    rows.reduce((out: any, r) => {
      const key = typeof r[field] === "string" ? r[field] : "unknown";
      out[key] = (out[key] ?? 0) + 1;
      return out;
    }, {})
  )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, count]) => ({ state, count: count as number }));
const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * p) - 1)];
};
export function buildAnalyticsReport(
  ownerId: number,
  input: {
    from: Date;
    to: Date;
    timezone: string;
    companyId?: string;
    jobId?: string;
    replyWindowHours: number;
  },
  raw: AnalyticsData,
  asOf: Date
) {
  const now = asOf.getTime(),
    from = input.from.getTime(),
    to = input.to.getTime();
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to ||
    to > now + 60000 ||
    to - from > 366 * 86400000
  )
    throw Error(
      "Use a valid half-open period of at most 366 days ending no later than the current time."
    );
  if (from >= Math.min(to, now))
    throw Error(
      "The effective report period must start before the current time."
    );
  const windowEnd = Math.min(to, now),
    inside = (v: unknown) => valid(v) && time(v) >= from && time(v) < windowEnd,
    issues: { code: string; table: string; id: string }[] = [];
  const data: AnalyticsData = {};
  for (const table of ANALYTICS_TABLES) {
    const seen = new Map<string, any>();
    for (const row of raw[table] ?? []) {
      if (row.ownerId !== ownerId) continue;
      if (!row.id) throw Error("Source row identity is missing.");
      if (seen.has(row.id)) {
        if (stableAnalyticsHash(seen.get(row.id)) !== stableAnalyticsHash(row))
          throw Error("Conflicting duplicate source identity.");
        continue;
      }
      if (valid(row.createdAt) && time(row.createdAt) > now) {
        issues.push({ code: "future_created_record", table, id: row.id });
        continue;
      }
      seen.set(row.id, row);
    }
    data[table] = [...seen.values()].sort((a, b) =>
      String(a.id).localeCompare(String(b.id))
    );
  }
  const allJobs = new Map(data.jobs.map(r => [r.id, r])),
    allCompanies = new Map(data.companies.map(r => [r.id, r]));
  if (
    (input.jobId && !allJobs.has(input.jobId)) ||
    (input.companyId && !allCompanies.has(input.companyId))
  )
    throw Error("Owned report scope was not found.");
  if (
    input.jobId &&
    input.companyId &&
    allJobs.get(input.jobId).companyId !== input.companyId
  )
    throw Error("Job and client filters do not describe the same scope.");
  const allCandidateIds = new Set(data.candidates.map(r => r.id));
  for (const row of data.jobs)
    if (!allCompanies.has(row.companyId))
      issues.push({
        code: "unowned_or_missing_company",
        table: "jobs",
        id: row.id,
      });
  const companyId =
      input.companyId ??
      (input.jobId ? allJobs.get(input.jobId).companyId : undefined),
    scoped = Boolean(companyId || input.jobId);
  data.companies = data.companies.filter(r => !companyId || r.id === companyId);
  const companyIds = new Set(data.companies.map(r => r.id));
  data.jobs = data.jobs.filter(
    r => companyIds.has(r.companyId) && (!input.jobId || r.id === input.jobId)
  );
  const jobIds = new Set(data.jobs.map(r => r.id));
  for (const table of ["matches", "shortlists", "interviews", "placements"]) {
    for (const row of data[table])
      if (!allCandidateIds.has(row.candidateId))
        issues.push({
          code: "unowned_or_missing_candidate",
          table,
          id: row.id,
        });
    data[table] = data[table].filter(
      r =>
        allCandidateIds.has(r.candidateId) &&
        jobIds.has(r.jobId) &&
        (!r.companyId || allJobs.get(r.jobId)?.companyId === r.companyId)
    );
  }
  const scopedPlacementMap = new Map(data.placements.map(r => [r.id, r])),
    placementIds = new Set(scopedPlacementMap.keys()),
    candidateIds = new Set(
      ["matches", "shortlists", "interviews", "placements"].flatMap(table =>
        data[table].map(r => r.candidateId)
      )
    );
  data.candidates = data.candidates.filter(
    r => !scoped || candidateIds.has(r.id)
  );
  for (const row of data.invoices)
    if (
      !scoped &&
      (!placementIds.has(row.placementId) ||
        scopedPlacementMap.get(row.placementId)?.companyId !== row.companyId)
    )
      issues.push({
        code: "unowned_or_missing_placement",
        table: "invoices",
        id: row.id,
      });
  data.invoices = data.invoices.filter(
    r =>
      placementIds.has(r.placementId) &&
      scopedPlacementMap.get(r.placementId)?.companyId === r.companyId
  );
  const invoiceMap = new Map(data.invoices.map(r => [r.id, r]));
  for (const p of data.payments)
    if (!invoiceMap.has(p.invoiceId) && !scoped)
      issues.push({
        code: "unowned_or_missing_invoice",
        table: "payments",
        id: p.id,
      });
  data.payments = data.payments.filter(r => invoiceMap.has(r.invoiceId));
  data.conversations = data.conversations.filter(
    r =>
      !scoped ||
      (r.jobId
        ? jobIds.has(r.jobId)
        : !input.jobId && companyIds.has(r.companyId))
  );
  const conversationMap = new Map(data.conversations.map(r => [r.id, r]));
  data.messages = data.messages.filter(r =>
    conversationMap.has(r.conversationId)
  );
  const messageMap = new Map(data.messages.map(r => [r.id, r]));
  data.plans = data.plans.filter(r => conversationMap.has(r.conversationId));
  const planMap = new Map(data.plans.map(r => [r.id, r]));
  data.dispatches = data.dispatches.filter(
    r => messageMap.has(r.messageId) && (!r.planId || planMap.has(r.planId))
  );
  const scopedIds = new Set([
    ...companyIds,
    ...jobIds,
    ...placementIds,
    ...candidateIds,
    ...data.invoices.map(r => r.id),
    ...data.interviews.map(r => r.id),
    ...data.matches.map(r => r.id),
    ...data.shortlists.map(r => r.id),
    ...data.plans.map(r => r.id),
    ...data.dispatches.map(r => r.id),
  ]);
  const explicitScope = (p: any) => {
    if (!p || typeof p !== "object") return null;
    if (typeof p.sourcePlacementId === "string")
      return placementIds.has(p.sourcePlacementId);
    if (typeof p.jobId === "string")
      return (
        jobIds.has(p.jobId) && (!p.companyId || companyIds.has(p.companyId))
      );
    if (typeof p.placementId === "string")
      return placementIds.has(p.placementId);
    if (typeof p.invoiceId === "string") return invoiceMap.has(p.invoiceId);
    if (typeof p.interviewId === "string")
      return data.interviews.some(i => i.id === p.interviewId);
    if (typeof p.planId === "string") return planMap.has(p.planId);
    if (typeof p.dispatchId === "string")
      return data.dispatches.some(d => d.id === p.dispatchId);
    if (typeof p.messageId === "string") return messageMap.has(p.messageId);
    if (typeof p.conversationId === "string")
      return conversationMap.has(p.conversationId);
    if (typeof p.companyId === "string")
      return !input.jobId && companyIds.has(p.companyId);
    return null;
  };
  const taskInScope = (r: any) => !scoped || explicitScope(r.payload) === true;
  data.queue = data.queue.filter(taskInScope);
  const queueIds = new Set(data.queue.map(r => r.id));
  data.usage = data.usage.filter(r => !scoped || queueIds.has(r.queueJobId));
  data.approvals = data.approvals.filter(
    r =>
      !scoped ||
      (explicitScope(r.payload) ??
        ((!["candidate", "company"].includes(r.resourceType) &&
          scopedIds.has(r.resourceId)) ||
          messageMap.has(r.resourceId)))
  );
  data.incidents = data.incidents.filter(
    r => !scoped || scopedIds.has(r.affectedResourceId)
  );
  data.audits = data.audits.filter(
    r => !scoped || scopedIds.has(r.resourceId) || messageMap.has(r.resourceId)
  );
  data.events = data.events.filter(
    r =>
      !r.metadata?.redacted &&
      (!scoped ||
        (explicitScope(r.metadata) ??
          (scopedIds.has(r.aggregateId) || messageMap.has(r.aggregateId))))
  );
  // Only calculation fields enter the digest; no recipient addresses, message bodies or personal feedback are loaded.
  const sourceLedgerDigest = stableAnalyticsHash({
    version: ANALYTICS_VERSION,
    scope: { companyId: companyId ?? null, jobId: input.jobId ?? null },
    data,
  });
  const eventsIndex = new Map<string, any[]>();
  for (const event of data.events)
    if (valid(event.createdAt) && time(event.createdAt) <= now) {
      let list = eventsIndex.get(event.eventType);
      if (!list) {
        list = [];
        eventsIndex.set(event.eventType, list);
      }
      list.push(event);
    }
  const eventsBy = (type: string) => eventsIndex.get(type) ?? [],
    byAggregate = (type: string) =>
      new Map(eventsBy(type).map(e => [e.aggregateId, e]));
  const observedIndex = byAggregate("payment.provider_observed"),
    requestIndex = byAggregate("payment.checkout_requested"),
    paymentMap = new Map(data.payments.map(r => [r.id, r]));
  const verifiedIds = new Set<string>();
  for (const e of eventsBy("payment.provider_verified")) {
    const p = paymentMap.get(e.metadata?.paymentId),
      m = e.metadata,
      observed = observedIndex.get(e.aggregateId),
      requested = requestIndex.get(e.aggregateId);
    if (
      p &&
      p.status === "succeeded" &&
      p.provider === "stripe_verified" &&
      m.mode === "live" &&
      p.providerEventId === m.paymentIntentId &&
      m.invoiceId === p.invoiceId &&
      observed?.metadata.mode === "live" &&
      observed.metadata.paymentIntentId === m.paymentIntentId &&
      observed.metadata.invoiceId === p.invoiceId &&
      observed.metadata.amount === p.amount &&
      observed.metadata.currency === p.currency &&
      requested?.metadata.mode === "live" &&
      requested.metadata.amount === p.amount &&
      requested.metadata.currency === p.currency &&
      requested.metadata.invoiceId === p.invoiceId
    )
      verifiedIds.add(p.id);
    else
      issues.push({
        code: "provider_receipt_evidence_mismatch",
        table: "events",
        id: e.id,
      });
  }
  const finances = new Map<string, any>(),
    invoiceRows: any[] = [],
    paymentRows: any[] = [],
    daily = new Map<string, any>();
  const finance = (c: string) => {
    if (!finances.has(c))
      finances.set(c, {
        currency: c,
        issuedBookMinor: 0n,
        recordedReceiptsMinor: 0n,
        providerVerifiedMinor: 0n,
        postedReceiptsMinor: 0n,
        periodProviderVerifiedMinor: 0n,
        openReceivableMinor: 0n,
        overdueReceivableMinor: 0n,
        disputedReceivableMinor: 0n,
        overpaymentMinor: 0n,
        noncollectibleResidualMinor: 0n,
        invoiceCount: 0,
        paymentCount: 0,
        bankClearedMinor: null,
        costMinor: null,
        contributionMarginMinor: null,
      });
    return finances.get(c);
  };
  const day = (at: any, c: string) => {
    const date = localClock(new Date(at), input.timezone).day,
      key = date + ":" + c;
    if (!daily.has(key))
      daily.set(key, {
        day: date,
        currency: c,
        issuedMinor: 0n,
        postedReceiptsMinor: 0n,
        providerVerifiedMinor: 0n,
      });
    return daily.get(key);
  };
  const receiptTotals = new Map<string, bigint>();
  for (const p of data.payments) {
    if (p.status !== "succeeded") continue;
    const invoice = invoiceMap.get(p.invoiceId);
    if (
      !integer(p.amount) ||
      p.amount === 0 ||
      !currency(p.currency) ||
      p.currency !== invoice.currency
    ) {
      issues.push({
        code: "invalid_or_cross_currency_receipt",
        table: "payments",
        id: p.id,
      });
      continue;
    }
    const value = BigInt(p.amount),
      f = finance(p.currency);
    f.recordedReceiptsMinor += value;
    f.paymentCount++;
    receiptTotals.set(
      p.invoiceId,
      (receiptTotals.get(p.invoiceId) ?? 0n) + value
    );
    if (verifiedIds.has(p.id)) f.providerVerifiedMinor += value;
    if (inside(p.createdAt)) {
      f.postedReceiptsMinor += value;
      day(p.createdAt, p.currency).postedReceiptsMinor += value;
      if (verifiedIds.has(p.id)) {
        f.periodProviderVerifiedMinor += value;
        day(p.createdAt, p.currency).providerVerifiedMinor += value;
      }
    }
    paymentRows.push({
      paymentId: p.id,
      invoiceId: p.invoiceId,
      currency: p.currency,
      amountMinor: String(p.amount),
      recordedAt: valid(p.createdAt)
        ? new Date(p.createdAt).toISOString()
        : null,
      providerEvidence: verifiedIds.has(p.id)
        ? "live_provider_verified"
        : "recorded_only",
      inPeriod: inside(p.createdAt),
      bankSettlementVerified: false,
    });
  }
  for (const invoice of data.invoices) {
    if (
      !integer(invoice.amount) ||
      !integer(invoice.taxAmount ?? 0) ||
      !currency(invoice.currency)
    ) {
      issues.push({
        code: "invalid_invoice_amount_or_currency",
        table: "invoices",
        id: invoice.id,
      });
      continue;
    }
    const total = BigInt(invoice.amount) + BigInt(invoice.taxAmount ?? 0),
      paid = receiptTotals.get(invoice.id) ?? 0n,
      balance = total - paid,
      issued = valid(invoice.issuedAt) && time(invoice.issuedAt) <= now,
      collectible =
        issued &&
        [
          "issued",
          "delivered",
          "payment_pending",
          "partially_paid",
          "overdue",
          "disputed",
          "paid",
        ].includes(invoice.status),
      f = finance(invoice.currency);
    f.invoiceCount++;
    if (issued) {
      f.issuedBookMinor += total;
      if (inside(invoice.issuedAt))
        day(invoice.issuedAt, invoice.currency).issuedMinor += total;
    }
    const remaining = balance > 0n ? balance : 0n;
    if (collectible) {
      f.openReceivableMinor += remaining;
      if (valid(invoice.dueAt) && time(invoice.dueAt) < now)
        f.overdueReceivableMinor += remaining;
      if (invoice.status === "disputed") f.disputedReceivableMinor += remaining;
    } else f.noncollectibleResidualMinor += remaining;
    if (balance < 0n) {
      f.overpaymentMinor -= balance;
      issues.push({
        code: "invoice_overpayment_requires_reconciliation",
        table: "invoices",
        id: invoice.id,
      });
    }
    if (invoice.status === "paid" && balance !== 0n)
      issues.push({
        code: "paid_status_does_not_reconcile",
        table: "invoices",
        id: invoice.id,
      });
    if (
      !issued &&
      !["draft", "validation", "approval_pending", "cancelled"].includes(
        invoice.status
      )
    )
      issues.push({
        code: "issued_state_without_issue_timestamp",
        table: "invoices",
        id: invoice.id,
      });
    invoiceRows.push({
      invoiceId: invoice.id,
      placementId: invoice.placementId,
      currency: invoice.currency,
      status: invoice.status,
      issuedAt: valid(invoice.issuedAt)
        ? new Date(invoice.issuedAt).toISOString()
        : null,
      totalMinor: String(total),
      recordedReceiptsMinor: String(paid),
      bookBalanceMinor: String(balance),
      collectible,
      bankSettlementVerified: false,
    });
  }
  const cohort = data.placements.filter(p => inside(p.createdAt)),
    placementMap = new Map(data.placements.map(p => [p.id, p])),
    offerPlacements = new Set<string>(),
    joinedPlacements = new Set<string>(),
    joiningApprovals = new Map(
      data.approvals
        .filter(
          a =>
            a.actionType === "placement_confirmation" &&
            a.status === "approved" &&
            valid(a.actionedAt) &&
            time(a.actionedAt) <= now
        )
        .map(a => [a.id, a])
    );
  for (const e of eventsBy("offer.accepted")) {
    const p = placementMap.get(e.metadata?.placementId);
    if (
      p &&
      e.metadata?.candidateId === p.candidateId &&
      e.metadata.emailPossessionVerified === true &&
      typeof e.metadata.termsHash === "string" &&
      e.metadata.termsHash.length === 64
    )
      offerPlacements.add(p.id);
  }
  for (const e of eventsBy("placement.lifecycle_joining_date")) {
    const p = placementMap.get(e.aggregateId);
    if (
      p &&
      e.metadata?.candidateId === p.candidateId &&
      valid(e.metadata?.joinedAt) &&
      time(e.metadata.joinedAt) <= now &&
      joiningApprovals.get(e.metadata.approvalId)?.resourceId === p.id
    )
      joinedPlacements.add(p.id);
  }
  const issuedPlacements = new Set(
      invoiceRows.filter(i => i.issuedAt).map(i => i.placementId)
    ),
    receiptPlacements = new Set<string>(),
    verifiedPlacements = new Set<string>();
  for (const r of paymentRows) {
    const p = invoiceMap.get(r.invoiceId)?.placementId;
    if (p) {
      receiptPlacements.add(p);
      if (r.providerEvidence === "live_provider_verified")
        verifiedPlacements.add(p);
    }
  }
  const funnelRows = cohort.map(p => ({
    placementId: p.id,
    jobId: p.jobId,
    status: p.status,
    createdAt: new Date(p.createdAt).toISOString(),
    recordedReplacementRequested:
      valid(p.replacementRequestedAt) && time(p.replacementRequestedAt) <= now,
    recordedOfferAccepted:
      valid(p.offerAcceptedAt) && time(p.offerAcceptedAt) <= now,
    emailPossessionAcceptance: offerPlacements.has(p.id),
    ownerApprovedJoining: joinedPlacements.has(p.id),
    issuedInvoice: issuedPlacements.has(p.id),
    recordedReceipt: receiptPlacements.has(p.id),
    providerVerifiedReceipt: verifiedPlacements.has(p.id),
    bankClearingVerified: false,
  }));
  const denominator = funnelRows.length,
    stage = (id: string, label: string, fn: (r: any) => boolean) => {
      const numerator = funnelRows.filter(fn).length;
      return {
        id,
        label,
        numerator,
        denominator,
        percent: denominator
          ? Math.round((numerator / denominator) * 10000) / 100
          : null,
      };
    };
  const cohortStages = [
    stage(
      "recorded_replacement",
      "Recorded replacement request",
      r => r.recordedReplacementRequested
    ),
    stage(
      "recorded_offer",
      "Recorded offer acceptance",
      r => r.recordedOfferAccepted
    ),
    stage(
      "email_acceptance",
      "Email-possession offer receipt",
      r => r.emailPossessionAcceptance
    ),
    stage(
      "joining",
      "Owner-approved joining record",
      r => r.ownerApprovedJoining
    ),
    stage("issued_invoice", "Issued invoice", r => r.issuedInvoice),
    stage(
      "recorded_receipt",
      "Recorded payment receipt",
      r => r.recordedReceipt
    ),
    stage(
      "provider_receipt",
      "Live provider-verified receipt",
      r => r.providerVerifiedReceipt
    ),
  ];
  const accepted = data.dispatches.flatMap(d => {
    const message = messageMap.get(d.messageId),
      plan = d.planId ? planMap.get(d.planId) : null;
    if (
      !plan ||
      d.status !== "sent" ||
      message?.direction !== "outbound" ||
      !valid(message.sentAt) ||
      time(message.sentAt) > now
    )
      return [];
    return [
      {
        dispatch: d,
        message,
        plan,
        key: [
          plan.id,
          d.planRevision ?? "unknown",
          d.stepIndex ?? "unknown",
        ].join(":"),
        at: time(message.sentAt),
      },
    ];
  });
  const periodAccepted = accepted.filter(a => inside(a.message.sentAt)),
    logical = new Map<string, (typeof accepted)[number]>();
  for (const a of [...periodAccepted].sort(
    (a, b) => a.at - b.at || a.dispatch.id.localeCompare(b.dispatch.id)
  )) {
    if (logical.has(a.key))
      issues.push({
        code: "duplicate_logical_acceptance",
        table: "dispatches",
        id: a.dispatch.id,
      });
    else logical.set(a.key, a);
  }
  const responseWindow = input.replyWindowHours * 3600000,
    associations: any[] = [],
    firstByStep = new Map<string, number>();
  const acceptedThreads = new Map<string, typeof accepted>();
  for (const a of accepted) {
    const key = a.message.conversationId;
    let list = acceptedThreads.get(key);
    if (!list) {
      list = [];
      acceptedThreads.set(key, list);
    }
    list.push(a);
  }
  for (const list of acceptedThreads.values())
    list.sort(
      (a, b) => a.at - b.at || a.dispatch.id.localeCompare(b.dispatch.id)
    );
  const referenceByStep = new Set<string>(),
    replySources = byAggregate("outreach.reply_received");
  let unmatchedReplyReferences = 0;
  for (const inbound of data.messages.filter(
    m =>
      m.direction === "inbound" &&
      valid(m.createdAt) &&
      time(m.createdAt) <= now
  )) {
    const list = acceptedThreads.get(inbound.conversationId) ?? [],
      at = time(inbound.createdAt),
      refs =
        typeof inbound.inReplyTo === "string" && inbound.inReplyTo.trim()
          ? [inbound.inReplyTo]
          : Array.isArray(inbound.references)
            ? inbound.references.filter((v: any) => typeof v === "string")
            : [];
    let chosen: (typeof accepted)[number] | undefined,
      method: "reference_linked" | "temporal_thread_only" =
        "temporal_thread_only";
    if (refs.length) {
      const matches = list.filter(
        a =>
          typeof a.message.messageId === "string" &&
          refs.includes(a.message.messageId) &&
          a.at <= at &&
          at - a.at <= responseWindow
      );
      if (!matches.length) {
        unmatchedReplyReferences++;
        continue;
      }
      chosen = matches[matches.length - 1];
      if (matches.some(a => a.at === chosen!.at && a.key !== chosen!.key)) {
        issues.push({
          code: "ambiguous_reply_references",
          table: "messages",
          id: inbound.id,
        });
        continue;
      }
      method = "reference_linked";
    } else {
      let low = 0,
        high = list.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (list[mid].at < at) low = mid + 1;
        else high = mid;
      }
      const index = low - 1;
      chosen = list[index];
      if (!chosen || at - chosen.at > responseWindow) continue;
      if (index > 0 && list[index - 1].at === chosen.at) {
        issues.push({
          code: "ambiguous_same_time_attribution",
          table: "messages",
          id: inbound.id,
        });
        continue;
      }
    }
    if (!chosen || !logical.has(chosen.key)) continue;
    const lag = (at - chosen.at) / 3600000;
    firstByStep.set(
      chosen.key,
      Math.min(firstByStep.get(chosen.key) ?? Infinity, lag)
    );
    if (method === "reference_linked") referenceByStep.add(chosen.key);
    associations.push({
      inboundId: inbound.id,
      dispatchId: chosen.dispatch.id,
      planId: chosen.plan.id,
      stepKey: chosen.key,
      recordedLagHours: lag,
      method,
      ingestionSource:
        replySources.get(inbound.id)?.metadata?.source ?? "unrecorded",
      arrivalTimingVerified: false,
    });
  }
  const followupGroups = new Map<string, any>();
  for (const a of logical.values()) {
    const groupKey = [
        a.plan.scenarioId,
        a.dispatch.stepIndex ?? "unknown",
        a.message.channel ??
          conversationMap.get(a.message.conversationId)?.channel ??
          "email",
      ].join(":"),
      g = followupGroups.get(groupKey) ?? {
        scenarioId: a.plan.scenarioId,
        stepIndex: a.dispatch.stepIndex ?? null,
        channel:
          conversationMap.get(a.message.conversationId)?.channel ?? "email",
        acceptedSteps: 0,
        maturedSteps: 0,
        replyAssociatedMaturedSteps: 0,
        referenceLinkedMaturedSteps: 0,
        openWindows: 0,
        observedReplyHours: [] as number[],
      };
    g.acceptedSteps++;
    const mature = a.at + responseWindow <= now;
    if (mature) {
      g.maturedSteps++;
      if (firstByStep.has(a.key)) g.replyAssociatedMaturedSteps++;
      if (referenceByStep.has(a.key)) g.referenceLinkedMaturedSteps++;
    } else g.openWindows++;
    if (firstByStep.has(a.key))
      g.observedReplyHours.push(firstByStep.get(a.key));
    followupGroups.set(groupKey, g);
  }
  const followups = [...followupGroups.values()].map(g => ({
    ...g,
    replyAssociationPercent: g.maturedSteps
      ? Math.round((g.replyAssociatedMaturedSteps / g.maturedSteps) * 10000) /
        100
      : null,
    medianIngestionLagHours: percentile(g.observedReplyHours, 0.5),
    observedReplyHours: undefined,
  }));
  const stateSources: Record<string, { rows: any[]; field: string }> = {
    company: { rows: data.companies, field: "pipelineState" },
    job: { rows: data.jobs, field: "pipelineState" },
    candidate: { rows: data.candidates, field: "profileState" },
    placement: { rows: data.placements, field: "status" },
    interview: { rows: data.interviews, field: "status" },
    match: { rows: data.matches, field: "status" },
    shortlist: { rows: data.shortlists, field: "status" },
    invoice: { rows: data.invoices, field: "status" },
  };
  const sourceResourceIds = Object.fromEntries(
    Object.entries(stateSources).map(([type, source]) => [
      type,
      new Set(source.rows.map(r => r.id)),
    ])
  );
  const transitions = new Map<string, any[]>();
  for (const a of data.audits) {
    if (
      !a.previousState ||
      !a.nextState ||
      a.previousState === a.nextState ||
      !sourceResourceIds[a.resourceType]?.has(a.resourceId) ||
      !valid(a.createdAt) ||
      time(a.createdAt) > now
    )
      continue;
    const key = a.resourceType + ":" + a.resourceId;
    let list = transitions.get(key);
    if (!list) {
      list = [];
      transitions.set(key, list);
    }
    list.push(a);
  }
  const stageMap = new Map<
    string,
    {
      resourceType: string;
      state: string;
      durations: number[];
      currentAges: number[];
    }
  >();
  let brokenTransitions = 0,
    unknownCurrentStageAges = 0;
  const stageGroup = (type: string, state: string) => {
    const key = type + ":" + state;
    if (!stageMap.has(key))
      stageMap.set(key, {
        resourceType: type,
        state,
        durations: [],
        currentAges: [],
      });
    return stageMap.get(key)!;
  };
  for (const [type, source] of Object.entries(stateSources))
    for (const row of source.rows) {
      const history = (transitions.get(type + ":" + row.id) ?? []).sort(
        (a, b) =>
          time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id)
      );
      let previous: any;
      for (const e of history) {
        if (previous) {
          if (
            previous.nextState === e.previousState &&
            time(e.createdAt) > time(previous.createdAt)
          ) {
            if (inside(e.createdAt))
              stageGroup(type, e.previousState).durations.push(
                (time(e.createdAt) - time(previous.createdAt)) / 3600000
              );
          } else brokenTransitions++;
        }
        previous = e;
      }
      if (
        previous &&
        previous.nextState === row[source.field] &&
        (history.length < 2 ||
          time(history[history.length - 2].createdAt) <
            time(previous.createdAt))
      )
        stageGroup(type, previous.nextState).currentAges.push(
          (now - time(previous.createdAt)) / 3600000
        );
      else unknownCurrentStageAges++;
    }
  const stages = [...stageMap.values()].map(g => ({
    resourceType: g.resourceType,
    state: g.state,
    completedIntervals: g.durations.length,
    medianCompletedHours: percentile(g.durations, 0.5),
    p90CompletedHours: percentile(g.durations, 0.9),
    knownCurrentAges: g.currentAges.length,
    oldestKnownCurrentHours: g.currentAges.length
      ? Math.max(...g.currentAges)
      : null,
  }));
  const due = data.queue.filter(
      q =>
        ["queued", "retryable_failed"].includes(q.status) &&
        valid(q.scheduledAt) &&
        time(q.scheduledAt) <= now
    ),
    queueLags = due.map(q => (now - time(q.scheduledAt)) / 3600000),
    usage = data.usage.filter(u => inside(u.createdAt)),
    latencies = usage
      .map(u => u.latencyMs)
      .filter(n => typeof n === "number" && Number.isFinite(n) && n >= 0),
    usageGroups = new Map<string, any>();
  for (const u of usage) {
    const key = u.taskType + ":" + (u.selectedModel ?? "unselected"),
      g = usageGroups.get(key) ?? {
        taskType: u.taskType,
        model: u.selectedModel ?? "unselected",
        attempts: 0,
        succeeded: 0,
      };
    g.attempts++;
    if (u.status === "succeeded") g.succeeded++;
    usageGroups.set(key, g);
  }
  const fatigueCounts = Object.values(
    data.dispatches
      .filter(d => inside(d.claimedAt) && typeof d.recipientHash === "string")
      .reduce((o: any, d) => {
        o[d.recipientHash] = (o[d.recipientHash] ?? 0) + 1;
        return o;
      }, {})
  ) as number[];
  const missingCreatedTimestamps = Object.fromEntries(
    ANALYTICS_TABLES.map(table => [
      table,
      data[table].filter(r => !valid(r.createdAt)).length,
    ])
  );
  const inventory = Object.entries(stateSources).map(([resourceType, s]) => ({
    resourceType,
    snapshotRecords: s.rows.length,
    createdInPeriod: s.rows.filter(r => inside(r.createdAt)).length,
    states: countStates(s.rows, s.field),
  }));
  const stringifyMoney = (row: any) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        typeof v === "bigint" ? v.toString() : v,
      ])
    );
  const dueIds = new Set(due.map(q => q.id));
  const sources = {
    finance: invoiceRows,
    receipts: paymentRows,
    funnel: funnelRows,
    followups: associations,
    workflow: data.queue
      .filter(
        q =>
          [
            "blocked",
            "retryable_failed",
            "permanently_failed",
            "running",
          ].includes(q.status) || dueIds.has(q.id)
      )
      .map(q => ({
        taskId: q.id,
        jobType: q.jobType,
        status: q.status,
        attempts: q.attempts,
        scheduledAt: valid(q.scheduledAt)
          ? new Date(q.scheduledAt).toISOString()
          : null,
      })),
  };
  // Time can change source drilldowns without a ledger write (for example, a queued task becoming due).
  // Fence the actual exported rows and effective period as well as the source projection.
  const sourceDigest = stableAnalyticsHash({
    sourceLedgerDigest,
    window: {
      from: input.from.toISOString(),
      to: new Date(windowEnd).toISOString(),
      timezone: input.timezone,
      replyWindowHours: input.replyWindowHours,
    },
    sources,
  });
  return {
    version: ANALYTICS_VERSION,
    asOf: asOf.toISOString(),
    window: {
      from: input.from.toISOString(),
      to: new Date(windowEnd).toISOString(),
      timezone: input.timezone,
      semantics:
        "Half-open [from,to); current outcome cohorts evaluated at report generation.",
    },
    scope: {
      companyId: companyId ?? null,
      jobId: input.jobId ?? null,
      operationalAttributionComplete: !scoped,
    },
    sourceDigest,
    definitions: ANALYTICS_DEFINITIONS,
    inventory,
    cohort: {
      placements: denominator,
      stages: cohortStages,
      causalConversionVerified: false,
    },
    finance: [...finances.values()]
      .sort((a, b) => a.currency.localeCompare(b.currency))
      .map(stringifyMoney),
    daily: [...daily.values()]
      .sort((a, b) => (a.day + a.currency).localeCompare(b.day + b.currency))
      .map(stringifyMoney),
    followups: {
      windowHours: input.replyWindowHours,
      logicalAcceptedSteps: logical.size,
      physicalAcceptedDispatches: periodAccepted.length,
      replyAssociatedSteps: firstByStep.size,
      associationIsCausal: false,
      arrivalTimingVerified: false,
      unmatchedReplyReferences,
      groups: followups,
      recipientFatigue: {
        recipientsWithClaims: fatigueCounts.length,
        recipientsWithRepeatedClaims: fatigueCounts.filter(n => n > 1).length,
        maxClaimsPerRecipient: fatigueCounts.length
          ? Math.max(...fatigueCounts)
          : 0,
        complaints: null,
        personaAttribution: null,
      },
    },
    stages: { rows: stages, brokenTransitions, unknownCurrentStageAges },
    workflow: {
      queueStates: countStates(data.queue, "status"),
      dueTasks: due.length,
      oldestDueHours: queueLags.length ? Math.max(...queueLags) : null,
      p90DueHours: percentile(queueLags, 0.9),
      staleRunningLeases: data.queue.filter(
        q =>
          q.status === "running" &&
          valid(q.lockedAt) &&
          time(q.lockedAt) < now - 30 * 60000
      ).length,
      retryAttempts: data.queue.reduce(
        (n, q) =>
          n +
          Math.max(0, (Number.isSafeInteger(q.attempts) ? q.attempts : 0) - 1),
        0
      ),
      pendingApprovals: data.approvals.filter(a => a.status === "pending")
        .length,
      openIncidents: data.incidents.filter(i =>
        ["detected", "triaged", "contained", "investigated"].includes(i.status)
      ).length,
      inferenceAttempts: usage.length,
      inferenceSucceeded: usage.filter(u => u.status === "succeeded").length,
      medianLatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      models: [...usageGroups.values()],
      modelCostMinor: null,
      factuality: null,
      effortSavedHours: null,
    },
    quality: {
      issues,
      missingCreatedTimestamps,
      sourceCounts: Object.fromEntries(
        ANALYTICS_TABLES.map(t => [t, data[t].length])
      ),
      financialCompleteness: !issues.some(
        i =>
          ["payments", "invoices"].includes(i.table) ||
          i.code === "provider_receipt_evidence_mismatch"
      ),
    },
    sources,
    limitations: [
      "No bank-clearing subledger is available; cleared cash is unknown, never inferred from paid status or a provider event.",
      "Source/persona satisfaction, causal incremental conversion, cost/margin and effort-saved metrics need additional measured evidence.",
      "Current-state inventory and period-created cohorts are not historical snapshots or a single cross-entity lead-to-cash conversion funnel.",
      "Filtered workflow counts include only explicit source links; generic candidate/workspace tasks and approvals cannot be attributed to a role.",
      "Inbound reply timestamps measure ingestion, not independently verified arrival; association is descriptive and can be affected by historical imports.",
      "Evidence erasure or supersession can remove proof from a later current snapshot; these are not immutable historical outcome counts.",
      "Candidate-job application attribution beyond current matches, shortlists, interviews and placements is unavailable.",
      "This bounded owner report is not a warehouse; source limits fail closed instead of silently returning partial financial totals.",
    ],
  };
}
