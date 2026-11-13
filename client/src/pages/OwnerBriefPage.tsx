import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatAnalyticsMoney } from "@shared/analytics";
import { ownerBriefFields, type OwnerBriefFields } from "@shared/ownerBrief";
export default function OwnerBriefPage() {
  const utils = trpc.useUtils(),
    settings = trpc.ownerBrief.settings.useQuery(),
    history = trpc.ownerBrief.history.useQuery(),
    [kind, setKind] = useState<
      | "all"
      | "approval"
      | "queue"
      | "incident"
      | "finance"
      | "integrity"
      | "followup"
    >("all"),
    [offset, setOffset] = useState(0),
    q = trpc.ownerBrief.overview.useQuery(
      { kind, offset, limit: 25 },
      { retry: false }
    ),
    [fields, setFields] = useState<OwnerBriefFields>(() =>
      ownerBriefFields.parse({})
    ),
    [reviewed, setReviewed] = useState<number | null>(null),
    [reason, setReason] = useState(""),
    [requestKey, setKey] = useState(() => crypto.randomUUID()),
    [notice, setNotice] = useState("");
  const d = q.data,
    load = () => {
      if (settings.data) {
        setFields(settings.data.fields);
        setReviewed(settings.data.revision);
      }
    };
  useEffect(() => {
    if (reviewed === null && settings.data) load();
  }, [settings.data]);
  const refresh = () => {
      utils.ownerBrief.invalidate();
    },
    configure = trpc.ownerBrief.configure.useMutation({
      onSuccess: r => {
        setReviewed(r.revision);
        setNotice(
          "Internal brief settings recorded. This does not enable the background worker, authorize contact or change hiring policy."
        );
        refresh();
      },
      onError: () => utils.ownerBrief.settings.invalidate(),
    }),
    record = trpc.ownerBrief.record.useMutation({
      onSuccess: () => {
        setKey(crypto.randomUUID());
        setNotice(
          "Aggregate brief recorded. Source case IDs, people, message bodies and private notes are excluded from stored history."
        );
        refresh();
      },
    }),
    schedule = trpc.ownerBrief.schedule.useMutation({
      onSuccess: r => {
        setNotice(
          "Schedule result: " +
            r.status +
            ". The existing managed worker remains responsible for execution."
        );
        refresh();
      },
    }),
    stale =
      settings.data && reviewed !== null && reviewed !== settings.data.revision;
  const Summary = ({ summary: s }: { summary: any }) => (
    <div className="space-y-3">
      <p>
        As of{" "}
        {new Date(s.asOf).toLocaleString("en-IN", {
          timeZone: s.window.timezone,
        })}{" "}
        · period{" "}
        {new Date(s.window.from).toLocaleString("en-IN", {
          timeZone: s.window.timezone,
        })}{" "}
        to{" "}
        {new Date(s.window.to).toLocaleString("en-IN", {
          timeZone: s.window.timezone,
        })}{" "}
        · {s.window.timezone}.
      </p>
      <p>
        {s.attentionSources} attention source records ·{" "}
        {s.sourceIntegrityIssues} integrity issues · {s.workflow.dueTasks} due
        tasks · {s.workflow.pendingApprovals} pending approvals.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {s.finance.map((f: any) => (
          <div key={f.currency} className="rounded border p-3">
            <h3 className="font-semibold">{f.currency}</h3>
            <p>
              Current ledger recorded receipts:{" "}
              {formatAnalyticsMoney(f.recordedReceiptsMinor, f.currency)}
            </p>
            <p>
              Current live provider-verified subset:{" "}
              {formatAnalyticsMoney(f.providerVerifiedMinor, f.currency)}
            </p>
            <p>
              Receipts posted in this review period:{" "}
              {formatAnalyticsMoney(f.postedReceiptsMinor, f.currency)}
            </p>
            <p>
              Open receivable:{" "}
              {formatAnalyticsMoney(f.openReceivableMinor, f.currency)}
            </p>
            <p>Bank-cleared cash and measured margin: unavailable.</p>
          </div>
        ))}
      </div>
      <p className="text-sm">
        Balances describe the current invoice ledger; period-posted receipts are
        a separate flow. Observed inference attempts:{" "}
        {s.workflow.inferenceSucceeded}/{s.workflow.inferenceAttempts}{" "}
        succeeded. Measured model cost and effort saved are unavailable.
      </p>
      <details>
        <summary>
          Current outcomes for period-created placement records ·{" "}
          {s.placementCohort.placements}
        </summary>
        {s.placementCohort.stages.map((stage: any) => (
          <p key={stage.id} className="mt-2 text-sm">
            {stage.label}: {stage.numerator}/{stage.denominator} ·{" "}
            {stage.percent === null ? "Unavailable" : stage.percent + "%"}
          </p>
        ))}
      </details>
      <details>
        <summary>Evidence and review limits</summary>
        {s.limitations.map((text: string) => (
          <p key={text} className="mt-2 text-sm">
            {text}
          </p>
        ))}
      </details>
    </div>
  );
  return (
    <main className="min-w-0 space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Owner operating brief</h1>
        <p>
          Review blocked work, pending decisions and recorded collection
          balances. This page observes source records; decisions and recovery
          remain in their governing workflows.
        </p>
      </header>
      {(q.error ||
        configure.error ||
        record.error ||
        schedule.error ||
        settings.error ||
        history.error) && (
        <p role="alert" className="break-words text-red-700">
          {q.error?.message ||
            configure.error?.message ||
            record.error?.message ||
            schedule.error?.message ||
            settings.error?.message ||
            history.error?.message}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded border p-3">
          {notice}
        </p>
      )}
      {d && (
        <section
          aria-label="Current operating review"
          className="space-y-3 rounded-xl border bg-white p-4"
        >
          <h2 className="text-xl font-semibold">Current priorities</h2>
          <Summary summary={d.summary} />
          <p className="text-xs">
            Strategy status: {d.summary.strategy?.mode ?? "unavailable"} ·{" "}
            {d.summary.strategy?.freshness ?? "unavailable"}.{" "}
            <a className="underline" href="/strategy">
              Review strategy and modeled capacity
            </a>
            . Current reported market observations:{" "}
            {d.summary.strategy?.reportedMarket?.usableRecords ?? 0}.{" "}
            <a className="underline" href="/market-evidence">
              Review source-reported market evidence
            </a>
            . Attention thresholds are your review preferences. They do not
            establish contractual SLA breaches or count unique business
            problems.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={q.isFetching}
              onClick={() => q.refetch()}
            >
              Refresh current priorities
            </Button>
            <Button
              type="button"
              disabled={record.isPending}
              onClick={() => record.mutate({ requestKey })}
            >
              Record aggregate brief
            </Button>
            <a
              className="rounded border px-3 py-2 text-sm underline"
              href="/analytics"
            >
              Inspect source analytics
            </a>
          </div>
          <label>
            Attention category
            <select
              aria-label="Operating brief category"
              className="block w-full rounded border bg-white p-2"
              value={kind}
              onChange={e => {
                setKind(e.target.value as typeof kind);
                setOffset(0);
              }}
            >
              {[
                "all",
                "approval",
                "queue",
                "incident",
                "finance",
                "integrity",
                "followup",
              ].map(k => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <p>
            {d.total} source records in this category · showing {d.cases.length}
            .
          </p>
          {d.cases.map((c: any) => (
            <article key={c.key} className="space-y-1 rounded border p-3">
              <h3 className="font-semibold">{c.label}</h3>
              <p className="break-all text-xs">
                {c.resourceType} · {c.resourceId} · source {c.id}
              </p>
              <p className="text-sm">
                Source age:{" "}
                {c.sourceAgeHours === null
                  ? "unknown"
                  : c.sourceAgeHours.toFixed(1) + " hours"}
                . This is not audited time in stage.
              </p>
              <a href={c.path} className="text-sm text-blue-700 underline">
                Open governing workspace page
              </a>
            </article>
          ))}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!offset || q.isFetching}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              Previous priorities
            </Button>
            <Button
              variant="outline"
              disabled={!d.hasMore || q.isFetching}
              onClick={() => setOffset(offset + 25)}
            >
              Next priorities
            </Button>
          </div>
          <p className="break-all text-xs">
            Snapshot reference: {d.snapshotDigest}. Live pages may change as
            source work progresses; stored briefs contain aggregate summaries
            only.
          </p>
        </section>
      )}
      {settings.data && (
        <section
          aria-label="Internal brief schedule"
          className="space-y-3 rounded-xl border bg-white p-4"
        >
          <h2 className="text-xl font-semibold">
            Daily or weekly internal summary
          </h2>
          <p>
            Worker {settings.data.workerEnabled ? "enabled" : "disabled"} ·
            emergency stop {settings.data.emergencyStop ? "on" : "off"}.
            Internal summaries use no external email or LLM. Earlier calendar
            periods are not backfilled as historical outcomes.
          </p>
          {settings.data.scheduleIssue && (
            <p role="alert">{settings.data.scheduleIssue}</p>
          )}
          {stale && (
            <p role="alert">
              Settings changed. Your draft remains intact. Review the current
              schedule before saving.
            </p>
          )}
          <Button variant="outline" onClick={load}>
            Review current brief settings
          </Button>
          <form
            aria-label="Configure internal operating brief"
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={e => {
              e.preventDefault();
              configure.mutate({
                expectedRevision: reviewed ?? 0,
                fields,
                reason,
              });
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={fields.enabled}
                onChange={e =>
                  setFields({ ...fields, enabled: e.target.checked })
                }
              />{" "}
              Enable scheduled internal summaries
            </label>
            <label>
              Cadence
              <select
                aria-label="Brief cadence"
                className="block w-full rounded border p-2"
                value={fields.cadence}
                onChange={e =>
                  setFields({
                    ...fields,
                    cadence: e.target.value as "daily" | "weekly",
                  })
                }
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            <label>
              Local summary time
              <Input
                aria-label="Brief local time"
                type="time"
                value={fields.time}
                onChange={e => setFields({ ...fields, time: e.target.value })}
                required
              />
            </label>
            <label>
              Timezone
              <Input
                aria-label="Brief timezone"
                value={fields.timezone}
                onChange={e =>
                  setFields({ ...fields, timezone: e.target.value })
                }
                required
              />
            </label>
            {fields.cadence === "weekly" && (
              <label>
                Weekday
                <select
                  aria-label="Brief weekday"
                  className="block w-full rounded border p-2"
                  value={fields.weekday}
                  onChange={e =>
                    setFields({ ...fields, weekday: Number(e.target.value) })
                  }
                >
                  {[
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                    "Sunday",
                  ].map((day, i) => (
                    <option key={day} value={i + 1}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Rolling review period, days
              <Input
                aria-label="Brief lookback days"
                type="number"
                min={1}
                max={30}
                value={fields.lookbackDays}
                onChange={e =>
                  setFields({ ...fields, lookbackDays: Number(e.target.value) })
                }
                required
              />
            </label>
            <label>
              Attention threshold, hours
              <Input
                aria-label="Brief attention hours"
                type="number"
                min={1}
                max={168}
                value={fields.attentionHours}
                onChange={e =>
                  setFields({
                    ...fields,
                    attentionHours: Number(e.target.value),
                  })
                }
                required
              />
            </label>
            <label>
              Summary retention, days
              <Input
                aria-label="Brief retention days"
                type="number"
                min={7}
                max={90}
                value={fields.retentionDays}
                onChange={e =>
                  setFields({
                    ...fields,
                    retentionDays: Number(e.target.value),
                  })
                }
                required
              />
            </label>
            <label className="sm:col-span-2">
              Reason
              <Textarea
                aria-label="Brief settings reason"
                minLength={8}
                maxLength={2000}
                value={reason}
                onChange={e => setReason(e.target.value)}
                required
              />
            </label>
            <Button
              disabled={configure.isPending || stale || reviewed === null}
            >
              Save internal brief settings
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={schedule.isPending || !settings.data.fields.enabled}
              onClick={() => schedule.mutate()}
            >
              Ensure current scheduled summary
            </Button>
          </form>
        </section>
      )}
      <section
        aria-label="Recorded aggregate briefs"
        className="space-y-3 rounded-xl border bg-white p-4"
      >
        <h2 className="text-xl font-semibold">Recorded summaries</h2>
        <p>
          Only aggregate inventory, observed work and currency-separated
          balances are retained. People, source case IDs, message bodies and
          private notes are not copied into history.
        </p>
        {history.data?.items.map((h: any) => (
          <details key={h.id} className="rounded border p-3">
            <summary>
              {h.redacted
                ? "Expired summary"
                : new Date(h.generatedAt).toLocaleString("en-IN", {
                    timeZone: h.summary?.window?.timezone ?? "Asia/Kolkata",
                  }) +
                  " · " +
                  h.mode}
            </summary>
            {!h.redacted && h.summary && (
              <div className="mt-3">
                <Summary summary={h.summary} />
              </div>
            )}
          </details>
        ))}
        {history.data?.olderAvailable && (
          <p>
            Older summaries exist beyond the latest 50; retention still applies.
          </p>
        )}
      </section>
    </main>
  );
}
