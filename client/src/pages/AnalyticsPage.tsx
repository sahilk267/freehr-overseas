import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatZonedDateTime, zonedDateTimeToUtc } from "@shared/dateTime";
import { formatAnalyticsMoney } from "@shared/analytics";
import {
  BarChart,
  Bar,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
const field = "block w-full rounded border bg-white p-2";
const when = (value: string) => new Date(value).toLocaleString();
const number = (value: number | null, unit = "") =>
  value === null
    ? "Unavailable"
    : value.toLocaleString("en-IN", { maximumFractionDigits: 2 }) + unit;
const money = (value: unknown, currency: string) =>
  value == null ? "Unavailable" : formatAnalyticsMoney(String(value), currency);
function useDebounced(value: string) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), 250);
    return () => clearTimeout(timer);
  }, [value]);
  return v;
}
export default function AnalyticsPage() {
  const [timezone, setTimezone] = useState("Asia/Kolkata"),
    [from, setFrom] = useState(() =>
      formatZonedDateTime(new Date(Date.now() - 30 * 86400000), "Asia/Kolkata")
    ),
    [to, setTo] = useState(() =>
      formatZonedDateTime(new Date(), "Asia/Kolkata")
    ),
    [companyId, setCompanyId] = useState(""),
    [jobId, setJobId] = useState(""),
    [companySearch, setCompanySearch] = useState(""),
    [jobSearch, setJobSearch] = useState(""),
    [replyHours, setReplyHours] = useState(72),
    [error, setError] = useState(""),
    [section, setSection] = useState<
      "finance" | "receipts" | "funnel" | "followups" | "workflow"
    >("finance");
  const [applied, setApplied] = useState(() => ({
    from: new Date(Date.now() - 30 * 86400000),
    to: new Date(),
    timezone: "Asia/Kolkata",
    replyWindowHours: 72,
    companyId: undefined as string | undefined,
    jobId: undefined as string | undefined,
  }));
  const companies = trpc.analytics.options.useQuery({
      kind: "company",
      search: useDebounced(companySearch),
    }),
    jobs = trpc.analytics.options.useQuery({
      kind: "job",
      search: useDebounced(jobSearch),
      companyId: companyId || undefined,
    }),
    q = trpc.analytics.report.useQuery(applied, { retry: false }),
    d = q.data;
  const download = trpc.analytics.export.useMutation({
    onSuccess: r => {
      const blob = new Blob(["\uFEFF" + r.csv], {
          type: "text/csv;charset=utf-8",
        }),
        url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = r.fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  const apply = () => {
    try {
      const next = {
        from: zonedDateTimeToUtc(from, timezone),
        to: zonedDateTimeToUtc(to, timezone),
        timezone,
        replyWindowHours: replyHours,
        companyId: companyId || undefined,
        jobId: jobId || undefined,
      };
      setError("");
      setApplied(next);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const chartData =
      d?.cohort.stages.map(s => ({ stage: s.label, records: s.numerator })) ??
      [],
    sourceRows = d ? d.sources[section] : [],
    visibleRows = sourceRows.slice(0, 50),
    headers = visibleRows.length ? Object.keys(visibleRows[0]) : [];
  return (
    <main className="space-y-6 p-4 text-slate-800 sm:p-7">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide">
          Evidence-based business review
        </p>
        <h1 className="text-3xl font-semibold">Recruiting analytics</h1>
        <p>
          Inspect recorded recruiting outcomes, collection balances, follow-up
          associations and workflow lag. This report proposes no hiring or
          policy change.
        </p>
      </header>
      <form
        aria-label="Analytics report filters"
        className="grid gap-3 rounded-xl border bg-white p-4 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={e => {
          e.preventDefault();
          apply();
        }}
      >
        <label>
          Report timezone
          <Input
            aria-label="Report timezone"
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            required
          />
        </label>
        <label>
          Period start in selected timezone
          <Input
            aria-label="Analytics period start"
            type="datetime-local"
            value={from}
            onChange={e => setFrom(e.target.value)}
            required
          />
        </label>
        <label>
          Period end, exclusive, in selected timezone
          <Input
            aria-label="Analytics period end"
            type="datetime-local"
            value={to}
            onChange={e => setTo(e.target.value)}
            required
          />
        </label>
        <div className="space-y-2">
          <label className="block">
            Find client
            <Input
              aria-label="Find analytics client"
              value={companySearch}
              onChange={e => setCompanySearch(e.target.value)}
              placeholder="Search client names"
            />
          </label>
          <label>
            Client scope
            <select
              className={field}
              aria-label="Analytics client scope"
              value={companyId}
              onChange={e => {
                setCompanyId(e.target.value);
                setJobId("");
              }}
            >
              <option value="">All owned clients</option>
              {companyId &&
                !companies.data?.rows.some(r => r.id === companyId) && (
                  <option value={companyId}>Selected client</option>
                )}
              {companies.data?.rows.map(r => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          {companies.data?.more && (
            <p className="text-xs">Refine the search to see more clients.</p>
          )}
        </div>
        <div className="space-y-2">
          <label className="block">
            Find role
            <Input
              aria-label="Find analytics role"
              value={jobSearch}
              onChange={e => setJobSearch(e.target.value)}
              placeholder="Search role titles"
            />
          </label>
          <label>
            Role scope
            <select
              className={field}
              aria-label="Analytics role scope"
              value={jobId}
              onChange={e => setJobId(e.target.value)}
            >
              <option value="">All roles in client scope</option>
              {jobId && !jobs.data?.rows.some(r => r.id === jobId) && (
                <option value={jobId}>Selected role</option>
              )}
              {jobs.data?.rows.map(r => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          {jobs.data?.more && (
            <p className="text-xs">Refine the search to see more roles.</p>
          )}
        </div>
        <label>
          Reply association window, hours
          <Input
            aria-label="Reply association hours"
            type="number"
            min={1}
            max={168}
            value={replyHours}
            onChange={e => setReplyHours(Number(e.target.value))}
            required
          />
        </label>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-3">
          <Button disabled={q.isFetching}>Apply report filters</Button>
          <Button
            type="button"
            variant="outline"
            disabled={q.isFetching}
            onClick={() => q.refetch()}
          >
            Refresh source snapshot
          </Button>
        </div>
        {(error || q.error) && (
          <p
            role="alert"
            className="break-words text-red-700 sm:col-span-2 lg:col-span-3"
          >
            {error || q.error?.message}
          </p>
        )}
        {(companies.error || jobs.error) && (
          <p role="alert">{companies.error?.message || jobs.error?.message}</p>
        )}
      </form>
      {q.isFetching && <p role="status">Reading the owned source ledgers…</p>}
      {d && (
        <>
          <section
            aria-label="Analytics evidence semantics"
            className="space-y-2 rounded-xl border bg-slate-50 p-4"
          >
            <p>
              Snapshot: {when(d.asOf)} · period {when(d.window.from)} to{" "}
              {when(d.window.to)} (exclusive) · grouping timezone{" "}
              {d.window.timezone}.
            </p>
            <p>
              Bank-cleared cash, model cost, margin and causal conversion are
              unavailable where their required evidence is absent. Recorded
              payments and provider receipts remain separate.
            </p>
            <p className="break-all text-xs">
              Metric version {d.version} · source digest {d.sourceDigest}
            </p>
            {Object.values(d.quality.missingCreatedTimestamps).some(
              n => typeof n === "number" && n > 0
            ) && (
              <p role="status">
                Some source records have no usable creation timestamp and are
                excluded from period-created counts. Snapshot counts remain
                separate.
              </p>
            )}
            {d.quality.issues.length > 0 && (
              <p role="alert" className="font-medium text-amber-800">
                {d.quality.issues.length} source integrity/reconciliation
                issue(s). Review source evidence before relying on totals.
              </p>
            )}
            <details>
              <summary className="cursor-pointer">
                Metric definitions and limitations
              </summary>
              <div className="mt-3 space-y-2">
                {d.definitions.map(def => (
                  <p key={def.id}>
                    <strong>{def.id}</strong> ({def.unit}): {def.basis}{" "}
                    {def.limitation}
                  </p>
                ))}
                {d.limitations.map((lim, i) => (
                  <p key={i}>{lim}</p>
                ))}
              </div>
            </details>
          </section>
          <section
            aria-label="Recorded recruiting inventory"
            className="space-y-3 rounded-xl border bg-white p-4"
          >
            <h2 className="text-xl font-semibold">
              Current inventory and period-created records
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {d.inventory.map(row => (
                <article key={row.resourceType} className="rounded border p-3">
                  <h3 className="font-semibold capitalize">
                    {row.resourceType}
                  </h3>
                  <p>
                    {row.snapshotRecords} current source records ·{" "}
                    {row.createdInPeriod} created in period
                  </p>
                  <p className="text-xs">
                    {row.states.map(s => s.state + ": " + s.count).join(" · ")}
                  </p>
                </article>
              ))}
            </div>
            <p className="text-xs">
              Current outcomes for a created-record cohort are not historical
              stage counts or a single lead-to-hire conversion funnel.
            </p>
          </section>
          <section
            aria-label="Placement cohort outcomes"
            className="space-y-3 rounded-xl border bg-white p-4"
          >
            <h2 className="text-xl font-semibold">
              Placement-record cohort · {d.cohort.placements}
            </h2>
            {d.cohort.placements ? (
              <>
                <div
                  className="h-72 w-full"
                  aria-label="Placement cohort outcome chart"
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={chartData}
                      margin={{ left: 0, right: 8, top: 10, bottom: 55 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="stage"
                        angle={-25}
                        textAnchor="end"
                        interval={0}
                        height={80}
                        tick={{ fontSize: 10 }}
                      />
                      <YAxis allowDecimals={false} />
                      <Tooltip />
                      <Bar
                        dataKey="records"
                        fill="#123b57"
                        onClick={() => setSection("funnel")}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {d.cohort.stages.map(s => (
                    <p key={s.id}>
                      {s.label}: {s.numerator}/{s.denominator} ·{" "}
                      {number(s.percent, "%")}
                    </p>
                  ))}
                </div>
              </>
            ) : (
              <p>
                No placement records were created in this scope/period.
                Conversion percentages remain unavailable.
              </p>
            )}
          </section>
          <section
            aria-label="Reconciled collection balances"
            className="space-y-3 rounded-xl border bg-white p-4"
          >
            <h2 className="text-xl font-semibold">
              Recorded collection balances
            </h2>
            {!d.finance.length && (
              <p>
                No valid owned financial source rows are available in this
                scope.
              </p>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              {d.finance.map((row: any) => (
                <article
                  key={row.currency}
                  className="space-y-2 rounded border p-3"
                >
                  <h3 className="font-semibold">
                    {row.currency} · {row.invoiceCount} invoices ·{" "}
                    {row.paymentCount} recorded receipts
                  </h3>
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {[
                      ["Issued invoice book total", "issuedBookMinor"],
                      ["Recorded succeeded receipts", "recordedReceiptsMinor"],
                      [
                        "Live provider-verified subset",
                        "providerVerifiedMinor",
                      ],
                      ["Posted receipts in period", "postedReceiptsMinor"],
                      [
                        "Verified subset of period receipts",
                        "periodProviderVerifiedMinor",
                      ],
                      ["Open receivable", "openReceivableMinor"],
                      ["Overdue receivable", "overdueReceivableMinor"],
                      ["Disputed receivable", "disputedReceivableMinor"],
                      ["Overpayment requiring review", "overpaymentMinor"],
                      [
                        "Noncollectible residual book balance",
                        "noncollectibleResidualMinor",
                      ],
                      ["Bank-cleared cash", "bankClearedMinor"],
                      [
                        "Measured contribution margin",
                        "contributionMarginMinor",
                      ],
                    ].map(([label, key]) => (
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd className="font-medium">
                          {money(row[key], row.currency)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>
            <p className="text-xs">
              Snapshot balances use all recorded receipts for each scoped
              invoice. Period-posted receipts are a separate flow. Overpayment
              is shown separately and never offsets another invoice silently.
            </p>
          </section>
          <section
            aria-label="Follow-up reply associations"
            className="space-y-3 rounded-xl border bg-white p-4"
          >
            <h2 className="text-xl font-semibold">
              Follow-up reply associations
            </h2>
            <p>
              {d.followups.logicalAcceptedSteps} logical accepted steps ·{" "}
              {d.followups.physicalAcceptedDispatches} recorded physical
              acceptances · {d.followups.replyAssociatedSteps} steps with an
              associated reply.
            </p>
            <p>
              Inbound records within {d.followups.windowHours} hours use
              explicit reply references first, then the latest preceding
              acceptance in the same thread. Timestamps measure record
              ingestion; arrival time is not independently verified and
              historical imports can affect this association. This does not
              establish causal credit or incremental conversion. Open windows
              stay separate.
            </p>
            {d.followups.groups.map((g: any, i: number) => (
              <p key={i}>
                {g.scenarioId} · step{" "}
                {g.stepIndex == null ? "unknown" : g.stepIndex + 1} ·{" "}
                {g.channel}: {g.replyAssociatedMaturedSteps}/{g.maturedSteps}{" "}
                mature steps reply-associated (
                {number(g.replyAssociationPercent, "%")}); {g.openWindows} open
                windows; median recorded ingestion lag{" "}
                {number(g.medianIngestionLagHours, " h")}.
              </p>
            ))}
            <p className="text-xs">
              Recipients with claim-stamped dispatch records:{" "}
              {d.followups.recipientFatigue.recipientsWithClaims}; repeated
              claim-stamped records:{" "}
              {d.followups.recipientFatigue.recipientsWithRepeatedClaims};
              largest per-recipient record count:{" "}
              {d.followups.recipientFatigue.maxClaimsPerRecipient}.
              Complaint/persona evidence is unavailable.
            </p>
          </section>
          <section
            aria-label="Workflow lag and inference observations"
            className="space-y-3 rounded-xl border bg-white p-4"
          >
            <h2 className="text-xl font-semibold">
              Workflow lag and inference observations
            </h2>
            <p>
              {d.workflow.dueTasks} due tasks · oldest{" "}
              {number(d.workflow.oldestDueHours, " h")} · p90{" "}
              {number(d.workflow.p90DueHours, " h")} ·{" "}
              {d.workflow.staleRunningLeases} stale running leases ·{" "}
              {d.workflow.retryAttempts} retry attempts recorded.
            </p>
            <p>
              {d.workflow.pendingApprovals} pending approvals ·{" "}
              {d.workflow.openIncidents} open incidents ·{" "}
              {d.workflow.inferenceSucceeded}/{d.workflow.inferenceAttempts}{" "}
              inference attempts succeeded in period.
            </p>
            <p>
              Observed latency: median{" "}
              {number(d.workflow.medianLatencyMs, " ms")}, p95{" "}
              {number(d.workflow.p95LatencyMs, " ms")}. Monetary cost, model
              factuality and effort saved are not inferred.
            </p>
            {d.workflow.models.map((m: any, i: number) => (
              <p key={i} className="break-words">
                {m.taskType} · {m.model}: {m.succeeded}/{m.attempts} succeeded.
              </p>
            ))}
            <h3 className="font-semibold">Audited time in stage</h3>
            <p>
              {d.stages.unknownCurrentStageAges} current stage ages unknown ·{" "}
              {d.stages.brokenTransitions} incomplete/ambiguous audit chains. No
              age is derived from updatedAt.
            </p>
            {d.stages.rows.map((s: any, i: number) => (
              <p key={i}>
                {s.resourceType} · {s.state}: {s.completedIntervals} completed
                observed intervals, median{" "}
                {number(s.medianCompletedHours, " h")}, p90{" "}
                {number(s.p90CompletedHours, " h")}; {s.knownCurrentAges} known
                current ages, oldest {number(s.oldestKnownCurrentHours, " h")}.
              </p>
            ))}
          </section>
          <section
            aria-label="Analytics source drilldown"
            className="space-y-3 rounded-xl border bg-white p-4"
          >
            <h2 className="text-xl font-semibold">
              Source drilldown and exact CSV
            </h2>
            <label>
              Source section
              <select
                className={field}
                aria-label="Analytics source section"
                value={section}
                onChange={e => setSection(e.target.value as typeof section)}
              >
                {["finance", "receipts", "funnel", "followups", "workflow"].map(
                  s => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  )
                )}
              </select>
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={download.isPending || q.isFetching}
              onClick={() =>
                download.mutate({
                  report: applied,
                  expectedSourceDigest: d.sourceDigest,
                  section,
                })
              }
            >
              Export current source rows
            </Button>
            <p>
              {sourceRows.length} source rows. The table previews the first 50;
              the CSV includes the complete bounded section. A changed source
              digest requires refresh before export.
            </p>
            {visibleRows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      {headers.map(h => (
                        <th key={h} className="border-b p-2">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r: any, i) => (
                      <tr key={i}>
                        {headers.map(h => (
                          <td
                            key={h}
                            className="max-w-xs break-words border-b p-2"
                          >
                            {r[h] == null ? "Unavailable" : String(r[h])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No source rows in this section.</p>
            )}
            {download.error && (
              <p role="alert" className="text-red-700">
                {download.error.message}
              </p>
            )}
          </section>
          {d.quality.issues.length > 0 && (
            <section
              aria-label="Analytics source issues"
              className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-4"
            >
              <h2 className="font-semibold">Source reconciliation issues</h2>
              {d.quality.issues.slice(0, 50).map((issue, i) => (
                <p className="break-words" key={i}>
                  {issue.code} · {issue.table} · {issue.id}
                </p>
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}
