import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  marketBatch,
  marketKind,
  type MarketPermission,
} from "@shared/marketEvidence";
import { formatAnalyticsMoney } from "@shared/analytics";
const defaultPermission = (): MarketPermission => ({
  enabled: false,
  allowedKinds: ["hiring_demand"],
  authorizedUse: "internal_recruitment_planning",
  basis: "owned_data",
  reference: "",
  termsUrl: "",
  validFrom: new Date(Date.now() - 86400000).toISOString(),
  validUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
  maxAgeDays: 30,
});
const field = "block w-full min-w-0 rounded border bg-white p-2";
const panel = "space-y-3 rounded-xl border bg-white p-4";
const label = (s: string) => s.replaceAll("_", " ");
function ReportFields({ fields: f }: { fields: any }) {
  return (
    <div className="space-y-1 text-sm break-words min-w-0">
      <p>
        {f.companyDomain} · {f.roleFamily} · {f.region} · {f.industry}
      </p>
      <p>
        Observed {f.observedAt}.{" "}
        <a
          className="underline"
          href={f.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open source citation
        </a>
        .
      </p>
      {f.kind === "hiring_demand" && (
        <p>
          Reported openings: {f.openings}. This is a source snapshot, not a
          verified mandate.
        </p>
      )}
      {f.kind === "salary_benchmark" && (
        <p>
          Reported {label(f.statistic)}:{" "}
          {formatAnalyticsMoney(f.minMinor, f.currency)}–
          {formatAnalyticsMoney(f.maxMinor, f.currency)} · {f.period} · sample{" "}
          {f.sampleSize}. No currency conversion or compensation update is
          applied.
        </p>
      )}
      {f.kind === "competition" && (
        <p>
          Source reports {f.competingEmployers} competing employers and{" "}
          {f.unfilledRoles} unfilled roles.
        </p>
      )}
      {f.kind === "seasonality" && (
        <p>
          Reported demand index {f.demandIndexBps} basis points (10000 =
          baseline) for {f.periodStart} through {f.periodEnd}, relative to{" "}
          {label(f.relativeTo)}.
        </p>
      )}
    </div>
  );
}
export default function MarketEvidencePage() {
  const utils = trpc.useUtils(),
    sources = trpc.marketEvidence.permissions.useQuery(),
    batches = trpc.marketEvidence.batches.useQuery(),
    [kind, setKind] = useState<
      | "all"
      | "hiring_demand"
      | "salary_benchmark"
      | "competition"
      | "seasonality"
    >("all"),
    [offset, setOffset] = useState(0),
    overview = trpc.marketEvidence.overview.useQuery(
      { kind, offset, limit: 25 },
      { retry: false }
    );
  const [sourceId, setSource] = useState(""),
    source = sources.data?.find(s => s.source.id === sourceId),
    [permission, setPermission] = useState<MarketPermission>(defaultPermission),
    [reviewed, setReviewed] = useState<number | null>(null),
    [reason, setReason] = useState(""),
    [batchText, setBatchText] = useState(""),
    [notice, setNotice] = useState(""),
    [previewFor, setPreviewFor] = useState(""),
    [retiring, setRetiring] = useState<{ id: string; revision: number } | null>(
      null
    ),
    [retireReason, setRetireReason] = useState(""),
    [historyId, setHistoryId] = useState("");
  const history = trpc.marketEvidence.history.useQuery(
    { id: historyId },
    { enabled: !!historyId, retry: false }
  );
  const refresh = () => {
    utils.marketEvidence.invalidate();
    utils.recruitmentStrategy.invalidate();
    utils.ownerBrief.invalidate();
  };
  const configure = trpc.marketEvidence.configure.useMutation({
    onSuccess: r => {
      setReviewed(r.revision);
      setNotice(
        "Source declaration recorded as an owner assertion. Previous observations require this exact permission version before current use. No contact permission was granted."
      );
      refresh();
    },
    onError: () => utils.marketEvidence.permissions.invalidate(),
  });
  const preview = trpc.marketEvidence.preview.useMutation({
    onSuccess: (_, input) => setPreviewFor(JSON.stringify(input)),
  });
  const record = trpc.marketEvidence.record.useMutation({
    onSuccess: r => {
      setNotice(
        `Batch receipt recorded. Newly accepted observations: ${r.newlyAccepted}. Inspect each held/conflicting result; a receipt does not mean every record was accepted.`
      );
      preview.reset();
      setPreviewFor("");
      refresh();
    },
  });
  const retire = trpc.marketEvidence.retire.useMutation({
    onSuccess: () => {
      setRetiring(null);
      setRetireReason("");
      setNotice(
        "Observation permanently retired. Replays cannot restore this source record."
      );
      refresh();
    },
    onError: () => utils.marketEvidence.overview.invalidate(),
  });
  const load = (id: string, explicit = true) => {
    const row = sources.data?.find(s => s.source.id === id);
    setSource(id);
    setReviewed(row?.permission.revision ?? 0);
    setPermission(row?.permission.fields ?? defaultPermission());
    preview.reset();
    setPreviewFor("");
    configure.reset();
    if (explicit)
      setNotice(
        "Current permission declaration loaded. Previous preview cleared."
      );
  };
  useEffect(() => {
    if (reviewed === null && source) load(source.source.id, false);
  }, [source]);
  let batch: ReturnType<typeof marketBatch.parse> | null = null,
    parseIssue = "";
  if (batchText.trim())
    try {
      const parsed = marketBatch.safeParse(JSON.parse(batchText));
      if (parsed.success) batch = parsed.data;
      else
        parseIssue = parsed.error.issues
          .map(i => i.path.join(".") + ": " + i.message)
          .join(" · ");
    } catch {
      parseIssue = "Enter valid JSON for this structured batch.";
    }
  const previewInput = batch ? { sourceId, batch } : null,
    matches = previewInput && previewFor === JSON.stringify(previewInput),
    stale =
      reviewed !== null && source && reviewed !== source.permission.revision;
  const errors = [
    sources.error,
    overview.error,
    batches.error,
    history.error,
    configure.error,
    preview.error,
    record.error,
    retire.error,
  ].filter(Boolean);
  return (
    <main className="space-y-5 max-w-6xl min-w-0">
      <h1 className="text-3xl font-semibold">
        Market evidence and source permissions
      </h1>
      <p>
        Connect existing approved prospect sources to structured employer
        research. Source authentication, owner-declared rights and reported
        facts are separate evidence levels.{" "}
        <a className="underline" href="/intake">
          Manage intake sources and keys
        </a>{" "}
        ·{" "}
        <a className="underline" href="/strategy">
          Open strategy and capacity
        </a>
        .
      </p>
      {notice && <p role="status">{notice}</p>}
      {errors.map((e: any, i) => (
        <p
          key={i}
          role="alert"
          className="rounded border p-3 text-red-800 break-words"
        >
          {e.message}
        </p>
      ))}
      <section aria-label="Current market evidence summary" className={panel}>
        <h2 className="text-xl font-semibold">Current source reports</h2>
        <p>
          {overview.data?.summary.usableRecords ?? 0} usable source records ·{" "}
          {overview.data?.summary.heldRecords ?? 0} inactive, expired or retired
          records · {overview.data?.summary.accountsWithEvidence ?? 0} accounts
          with current evidence.
        </p>
        <p>
          Account review:{" "}
          {overview.data?.summary.accountsNeedingQualification ?? 0} with
          reported demand,{" "}
          {overview.data?.summary.accountsWithConflictingDemand ?? 0} with
          potentially conflicting same-scope reports. These counts do not
          establish unique vacancies, verified agency openness, payment
          reliability or permission to contact.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            sources.refetch();
            overview.refetch();
            batches.refetch();
          }}
          disabled={overview.isFetching}
        >
          Refresh market evidence
        </Button>
        <details>
          <summary>Evidence limits</summary>
          {overview.data?.limitations.map(l => (
            <p key={l}>{l}</p>
          ))}
        </details>
      </section>
      <section aria-label="Market source permission editor" className={panel}>
        <h2 className="text-xl font-semibold">Source permission declaration</h2>
        <label>
          Existing prospect intake source
          <select
            aria-label="Market intake source"
            className={field}
            value={sourceId}
            onChange={e => load(e.target.value)}
          >
            <option value="">Choose an existing prospect source</option>
            {sources.data?.map(s => (
              <option key={s.source.id} value={s.source.id}>
                {s.source.name} · {s.source.enabled ? "enabled" : "disabled"}
              </option>
            ))}
          </select>
        </label>
        {!sources.data?.length && (
          <p>
            Create an approved prospect source in Intake first. This page does
            not generate a second key or provider connection.
          </p>
        )}
        {source && (
          <>
            <p>
              Source access revision {source.source.revision} · permission
              version {source.permission.revision} ·{" "}
              {source.issue ? label(source.issue) : "current owner declaration"}
              . Legal rights have not been verified externally.
            </p>
            <p className="break-words">
              Authenticated feed endpoint:{" "}
              <code className="break-all">{source.endpoint}</code>. Reuse this
              source's bearer key from Intake. Every request must specify the
              current permission revision. Import the canonical account through
              existing Intake before sending its observations.
            </p>
            <Button variant="outline" onClick={() => load(sourceId)}>
              Review current market permission
            </Button>
            {stale && (
              <p role="alert">
                Market permission changed. Your draft is preserved; review the
                current declaration before saving.
              </p>
            )}
            <form
              aria-label="Configure market source permission"
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={e => {
                e.preventDefault();
                configure.mutate({
                  sourceId,
                  expectedRevision: reviewed ?? 0,
                  fields: permission,
                  reason,
                });
              }}
            >
              <label>
                <input
                  type="checkbox"
                  checked={permission.enabled}
                  onChange={e =>
                    setPermission({ ...permission, enabled: e.target.checked })
                  }
                />{" "}
                Enable internal market evidence use
              </label>
              <label>
                Declared basis
                <select
                  aria-label="Market permission basis"
                  className={field}
                  value={permission.basis}
                  onChange={e =>
                    setPermission({
                      ...permission,
                      basis: e.target.value as MarketPermission["basis"],
                    })
                  }
                >
                  <option value="owned_data">Owned business data</option>
                  <option value="provider_contract">Provider contract</option>
                  <option value="permitted_public_use">
                    Permitted public use
                  </option>
                </select>
              </label>
              <fieldset className="sm:col-span-2 flex flex-wrap gap-3">
                <legend>Permitted observation kinds</legend>
                {marketKind.options.map(k => (
                  <label key={k}>
                    <input
                      type="checkbox"
                      aria-label={"Permit " + label(k)}
                      checked={permission.allowedKinds.includes(k)}
                      onChange={e =>
                        setPermission({
                          ...permission,
                          allowedKinds: marketKind.options.filter(v =>
                            v === k
                              ? e.target.checked
                              : permission.allowedKinds.includes(v)
                          ),
                        })
                      }
                    />{" "}
                    {label(k)}
                  </label>
                ))}
              </fieldset>
              <label className="sm:col-span-2">
                Contract or permission reference
                <Textarea
                  aria-label="Market permission reference"
                  minLength={8}
                  maxLength={2000}
                  value={permission.reference}
                  onChange={e =>
                    setPermission({ ...permission, reference: e.target.value })
                  }
                  required
                />
              </label>
              <label>
                Terms or provenance URL
                <Input
                  aria-label="Market permission terms URL"
                  type="url"
                  value={permission.termsUrl}
                  onChange={e =>
                    setPermission({ ...permission, termsUrl: e.target.value })
                  }
                  required
                />
              </label>
              <label>
                Maximum observation age, days
                <Input
                  aria-label="Market observation age days"
                  type="number"
                  min={1}
                  max={180}
                  value={permission.maxAgeDays}
                  onChange={e =>
                    setPermission({
                      ...permission,
                      maxAgeDays: Number(e.target.value),
                    })
                  }
                  required
                />
              </label>
              {(["validFrom", "validUntil"] as const).map(k => (
                <label key={k}>
                  {k === "validFrom"
                    ? "Permission starts"
                    : "Permission expires"}
                  , UTC
                  <Input
                    aria-label={
                      k === "validFrom"
                        ? "Market permission start UTC"
                        : "Market permission expiry UTC"
                    }
                    type="datetime-local"
                    value={permission[k].slice(0, 16)}
                    onChange={e =>
                      setPermission({
                        ...permission,
                        [k]: e.target.value
                          ? new Date(e.target.value + "Z").toISOString()
                          : "",
                      })
                    }
                    required
                  />
                </label>
              ))}
              <label className="sm:col-span-2">
                Reason
                <Textarea
                  aria-label="Market permission reason"
                  minLength={8}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  required
                />
              </label>
              <p className="sm:col-span-2">
                Authorized use is internal recruitment planning only. A
                declaration does not verify the underlying facts, grant
                marketing permission or authorize scraping, spending or hiring
                decisions. Changing it invalidates old permission-bound
                observations until a new accepted source revision.
              </p>
              <Button
                disabled={configure.isPending || !!stale || reviewed === null}
              >
                Save market permission declaration
              </Button>
            </form>
          </>
        )}
      </section>
      <section
        aria-label="Structured market observation intake"
        className={panel}
      >
        <h2 className="text-xl font-semibold">
          Review structured observations
        </h2>
        <p>
          Approved integrations may submit batches of up to 50 observations to
          the authenticated endpoint. For a manual reviewed import, enter the
          same JSON, preview current account/permission checks, then record the
          exact reviewed batch. Corrected observations need the next revision
          and prior accepted digest. Retired external keys cannot be restored.
        </p>
        <Button
          variant="outline"
          disabled={!source}
          onClick={() => {
            preview.reset();
            setPreviewFor("");
            setBatchText(
              JSON.stringify(
                {
                  batchKey: crypto.randomUUID(),
                  permissionRevision: source?.permission.revision ?? 0,
                  records: [
                    {
                      externalKey: "replace-source-record-key",
                      revision: 1,
                      companyDomain: "replace-employer.example",
                      roleFamily: "Replace role family",
                      region: "Replace region",
                      industry: "Replace industry",
                      observedAt: new Date().toISOString(),
                      sourceUrl: "https://replace-source.example/research",
                      kind: "hiring_demand",
                      openings: 0,
                    },
                  ],
                },
                null,
                2
              )
            );
            setNotice(
              "Unsaved observation template loaded. Replace placeholders with authorized source data; no observation has been recorded."
            );
          }}
        >
          Load unsaved observation template
        </Button>
        <label>
          Structured batch JSON
          <Textarea
            aria-label="Market batch JSON"
            className="min-h-64 font-mono"
            value={batchText}
            onChange={e => setBatchText(e.target.value)}
            maxLength={240000}
          />
        </label>
        {parseIssue && (
          <p role="alert" className="break-words">
            {parseIssue}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!previewInput || !source || preview.isPending}
            onClick={() => previewInput && preview.mutate(previewInput)}
          >
            Preview market batch
          </Button>
          <Button
            disabled={
              !matches ||
              !preview.data ||
              preview.data.receiptOnly ||
              record.isPending
            }
            onClick={() =>
              previewInput &&
              preview.data &&
              record.mutate({
                ...previewInput,
                previewHash: preview.data.previewHash,
              })
            }
          >
            Record reviewed market batch
          </Button>
        </div>
        {preview.data && (
          <>
            <p role="status">
              {matches
                ? preview.data.receiptOnly
                  ? "Original receipt outcomes only. No new observation will be recorded. Use a new batch key to retry held records after correcting prerequisites."
                  : "Preview matches the current batch inputs."
                : "Inputs changed. Preview the current batch again before recording."}
            </p>
            {preview.data.results.map(r => (
              <p className="break-all" key={r.id}>
                {r.status} · revision {r.revision} ·{" "}
                {r.reason
                  ? label(r.reason)
                  : "source report still independently unverified"}{" "}
                · {r.id}
              </p>
            ))}
          </>
        )}
        <details>
          <summary>Structured observation formats</summary>
          <p>
            All rows need externalKey, revision, companyDomain, roleFamily,
            region, industry, observedAt (ISO UTC/offset), sourceUrl (public
            HTTPS without credentials/query/fragment), and kind. Corrections
            also require previousDigest.
          </p>
          <p>
            hiring_demand: openings (snapshot count). salary_benchmark:
            currency, minMinor, maxMinor, period (annual/monthly/hourly),
            sampleSize and statistic (advertised_range/survey_range).
            competition: competingEmployers and unfilledRoles. seasonality:
            periodStart, periodEnd, relativeTo
            (previous_period/same_period_previous_year), demandIndexBps (10000 =
            baseline). Salary amounts are nonnegative integer minor-unit
            strings. Do not include candidate profiles, contact details,
            credentials or unknown fields.
          </p>
          <p>
            HTTP 200 acknowledges a batch receipt; inspect each
            accepted/reused/held/conflict result. Newly accepted counts
            distinguish original receipts from replay. A source key
            authenticates submission only.
          </p>
        </details>
      </section>
      <section aria-label="Current market observations" className={panel}>
        <h2 className="text-xl font-semibold">Current observations</h2>
        <label>
          Observation kind
          <select
            aria-label="Market observation kind"
            className={field}
            value={kind}
            onChange={e => {
              setKind(e.target.value as typeof kind);
              setOffset(0);
            }}
          >
            <option value="all">All, including inactive records</option>
            {marketKind.options.map(k => (
              <option key={k} value={k}>
                {label(k)}
              </option>
            ))}
          </select>
        </label>
        <p>
          {overview.data?.total ?? 0} matching source records. Filtering and
          pagination follow full supported source calculation.
        </p>
        {overview.data?.records.map(r => (
          <article key={r.id} className="space-y-2 rounded border p-3">
            <h3 className="font-semibold">
              {r.usable ? label(r.kind!) : "Unavailable observation"} · version{" "}
              {r.revision}
            </h3>
            <p className="break-all text-xs">
              {r.id} · accepted digest {r.digest}
            </p>
            <p>
              {r.usable
                ? "Current source-reported observation; factual accuracy and licensing remain independently unverified."
                : label(r.issue ?? "unavailable")}{" "}
              · {r.admission ? label(r.admission) : "retained receipt"}.
            </p>
            {r.fields && <ReportFields fields={r.fields} />}{" "}
            {r.reportedOpeningsChange !== null && (
              <p>
                Same-source reported openings change: {r.reportedOpeningsChange}
                . This is not verified market growth.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                aria-label={"Review observation history: " + r.id}
                onClick={() => setHistoryId(r.id)}
              >
                Review revision receipts
              </Button>
              {r.issue !== "permanently_retired" && (
                <Button
                  variant="outline"
                  aria-label={"Retire observation: " + r.id}
                  onClick={() => {
                    setRetiring({ id: r.id, revision: r.revision });
                    setRetireReason("");
                  }}
                >
                  Retire observation
                </Button>
              )}
            </div>
          </article>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!offset || overview.isFetching}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            Previous observations
          </Button>
          <Button
            variant="outline"
            disabled={!overview.data?.hasMore || overview.isFetching}
            onClick={() => setOffset(offset + 25)}
          >
            Next observations
          </Button>
        </div>
        {retiring && (
          <form
            aria-label="Retire market observation"
            className="space-y-2"
            onSubmit={e => {
              e.preventDefault();
              retire.mutate({
                id: retiring.id,
                expectedRevision: retiring.revision,
                reason: retireReason,
              });
            }}
          >
            <p className="break-all">
              Permanently retire {retiring.id}, version {retiring.revision}.
              Future batches cannot restore this external record key.
            </p>
            <Textarea
              aria-label="Market retirement reason"
              value={retireReason}
              onChange={e => setRetireReason(e.target.value)}
              minLength={8}
              required
            />
            <Button disabled={retire.isPending}>
              Confirm permanent observation retirement
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => setRetiring(null)}
            >
              Keep observation
            </Button>
          </form>
        )}
        {historyId && (
          <section
            aria-label="Observation revision history"
            className="space-y-2"
          >
            <h3 className="font-semibold break-all">
              Revision receipts: {historyId}
            </h3>
            {history.data?.items.map(r => (
              <article className="rounded border p-2" key={r.revision}>
                <p>
                  Revision {r.revision} ·{" "}
                  {r.issue
                    ? label(r.issue)
                    : "currently permitted source report"}
                  .
                </p>
                <p className="break-all text-xs">{r.digest}</p>
                {r.fields && <ReportFields fields={r.fields} />}
              </article>
            ))}
            {history.data?.olderAvailable && (
              <p>Older receipts exist beyond this 20-version view.</p>
            )}
          </section>
        )}
      </section>
      <section aria-label="Evidence-linked account review" className={panel}>
        <h2 className="text-xl font-semibold">
          Accounts requiring qualification
        </h2>
        {overview.data?.opportunities.map(o => (
          <article key={o.companyId} className="rounded border p-3">
            <p className="break-all">
              {o.domain} · {label(o.state)} · {o.evidenceRecords} source
              records.
            </p>
            <p>
              Account verification state: {o.accountVerificationState}. Agency
              openness and payment reliability remain unverified. No contact
              permission is granted.{" "}
              <a className="underline" href="/prospects">
                Open governing accounts page
              </a>
              .
            </p>
          </article>
        ))}
        {overview.data?.moreOpportunitiesAvailable && (
          <p>
            More than 100 accounts have evidence; only the first 100 account
            summaries are displayed. Full aggregate counts remain unchanged.
          </p>
        )}
      </section>
      <section aria-label="Market batch receipts" className={panel}>
        <h2 className="text-xl font-semibold">Batch receipts</h2>
        {batches.data?.items.map(b => (
          <article key={b.id} className="rounded border p-3">
            <p className="break-all">
              {b.id} · source{" "}
              {sources.data?.find(s => s.source.id === b.sourceId)?.source
                .name ?? b.sourceId}{" "}
              · {b.origin} · permission version {b.permissionRevision}
            </p>
            <p>
              Receipt outcomes:{" "}
              {b.results.filter((r: any) => r.status === "accepted").length}{" "}
              accepted,{" "}
              {b.results.filter((r: any) => r.status === "reused").length}{" "}
              reused,{" "}
              {
                b.results.filter((r: any) =>
                  ["held", "conflict"].includes(r.status)
                ).length
              }{" "}
              held/conflict. These are original receipt outcomes; current
              usability is checked above.
            </p>
          </article>
        ))}
        {batches.data?.olderAvailable && (
          <p>Older batch receipts exist beyond this 50-receipt view.</p>
        )}
      </section>
    </main>
  );
}
