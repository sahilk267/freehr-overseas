import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  strategyFields,
  type StrategyFields,
} from "@shared/recruitmentStrategy";
import { formatAnalyticsMoney } from "@shared/analytics";
const sample = (): StrategyFields => ({
  name: "Illustrative recruitment plan",
  niche: "Illustrative technology recruitment; replace before saving.",
  industries: ["Software"],
  regions: ["India"],
  roleFamilies: ["Backend engineering"],
  idealClient:
    "Illustrative established employers with approved hiring budgets.",
  exclusions:
    "Exclude unverified mandates, unavailable accounts and unauthorized sources.",
  currency: "INR",
  horizonWorkdays: 20,
  availableMinutes: 9600,
  maxConcurrentRoles: 3,
  targetGrossMinor: "5000000",
  fee: { mode: "fixed", amountMinor: "1000000" },
  minutesPerPlacement: 1200,
  minutesPerProspect: 10,
  plannedProspects: 100,
  replyBps: 2000,
  replyToMandateBps: 2000,
  mandateToPlacementBps: 5000,
  collectionBps: 9000,
  hourlyCostMinor: "50000",
  fixedCostMinor: "100000",
  variableCostPerPlacementMinor: "50000",
  acquisitionBudgetMinor: "50000",
  acquisitionCostPerProspectMinor: "100",
  sourcingBudgetMinor: "50000",
  sourcingCostPerPlacementMinor: "10000",
  reviewedOn: new Date().toISOString().slice(0, 10),
  freshnessDays: 14,
  assumptions:
    "Illustrative owner assumptions only. Replace every amount, rate, target and capacity with your reviewed planning inputs; no market evidence is claimed.",
});
const textLabels = {
  niche: "Recruitment niche",
  idealClient: "Ideal client criteria",
  exclusions: "Exclusions and stop conditions",
  assumptions: "Planning assumptions and evidence",
  industries: "Target industries",
  regions: "Target regions",
  roleFamilies: "Target role families",
};
const roleLabels = {
  feeMinor: "Role fee assumption, minor units",
  currency: "Role planning currency",
  availableCandidates: "Assumed available candidates",
  feasibilityBps: "Assumed mandate feasibility, basis points",
  placementBps: "Assumed placement likelihood, basis points",
  collectionBps: "Assumed collection likelihood, basis points",
  deliveryMinutes: "Assumed role delivery minutes",
  variableCostMinor: "Assumed role direct costs, minor units",
  reviewedOn: "Role assumptions reviewed on, UTC date",
  freshnessDays: "Role assumption freshness, days",
  rationale: "Role evidence and assumptions",
};
const numericFields: [keyof StrategyFields, string, number, number][] = [
  ["horizonWorkdays", "Planning workdays", 1, 90],
  ["availableMinutes", "Available recruiter minutes in horizon", 1, 129600],
  ["maxConcurrentRoles", "Concurrent role cap", 1, 50],
  ["minutesPerPlacement", "Delivery minutes per placement", 1, 129600],
  ["minutesPerProspect", "Minutes per prospect", 1, 480],
  ["plannedProspects", "Planned prospects in horizon", 0, 10000],
  ["replyBps", "Assumed reply rate, basis points", 0, 10000],
  ["replyToMandateBps", "Assumed reply to mandate, basis points", 0, 10000],
  [
    "mandateToPlacementBps",
    "Assumed mandate to placement, basis points",
    0,
    10000,
  ],
  ["collectionBps", "Assumed collection probability, basis points", 0, 10000],
  ["freshnessDays", "Assumption freshness, days", 1, 90],
];
const moneyFields: [keyof StrategyFields, string][] = [
  ["targetGrossMinor", "Gross revenue target"],
  ["hourlyCostMinor", "Recruiter cost per hour"],
  ["fixedCostMinor", "Fixed costs for horizon"],
  ["variableCostPerPlacementMinor", "Other direct costs per placement"],
  ["acquisitionBudgetMinor", "Acquisition budget for horizon"],
  ["acquisitionCostPerProspectMinor", "Acquisition cost per prospect"],
  ["sourcingBudgetMinor", "Sourcing budget for horizon"],
  ["sourcingCostPerPlacementMinor", "Sourcing cost per placement"],
];
function ScenarioView({ model }: { model: any }) {
  return (
    <section
      aria-label="Modeled recruitment scenarios"
      className="space-y-3 rounded-xl border bg-white p-4"
    >
      <h2 className="text-xl font-semibold">Modeled scenarios</h2>
      <p>
        Owner assumptions · model probabilities are not calibrated from market
        reports · freshness {model.freshness}. Hypothetical modeled fee{" "}
        {formatAnalyticsMoney(model.feeMinor, model.currency)}. These figures
        are not receipts or guaranteed earnings.
      </p>
      {model.scenarios.map((s: any) => (
        <article key={s.key} className="rounded border p-3 space-y-1">
          <h3 className="font-semibold">{s.key.replaceAll("_", " ")}</h3>
          <p>
            {s.prospects} modeled prospects · {s.expectedPlacements} expected
            placements · {s.deliveryCapacity} delivery capacity.
          </p>
          <p>
            Modeled gross {formatAnalyticsMoney(s.grossMinor, model.currency)} ·
            risk-adjusted collectible{" "}
            {formatAnalyticsMoney(s.collectibleMinor, model.currency)} · total
            modeled cost{" "}
            {formatAnalyticsMoney(s.costs.totalMinor, model.currency)} ·
            contribution{" "}
            {formatAnalyticsMoney(s.contributionMinor, model.currency)}.
          </p>
          <details>
            <summary>Cost and capacity explanation</summary>
            <p>
              Acquisition{" "}
              {formatAnalyticsMoney(s.costs.acquisitionMinor, model.currency)},
              sourcing{" "}
              {formatAnalyticsMoney(s.costs.sourcingMinor, model.currency)},
              other direct{" "}
              {formatAnalyticsMoney(s.costs.variableMinor, model.currency)},
              labor {formatAnalyticsMoney(s.costs.laborMinor, model.currency)},
              fixed {formatAnalyticsMoney(s.costs.fixedMinor, model.currency)}.
              Modeled work {s.modeledMinutes} minutes. Gross target needs{" "}
              {s.requiredPlacements ?? "unavailable"} placements; contribution
              break-even{" "}
              {s.breakEvenPlacements ??
                "unavailable because unit contribution is not positive"}
              . Daily prospect envelope {s.dailyProspectCeiling}.
            </p>
          </details>
          <p>
            Review:{" "}
            {s.reasons.length
              ? s.reasons.join(", ")
              : "No modeled constraint flagged; assumptions still need external evidence."}
          </p>
        </article>
      ))}
      <details>
        <summary>Model limitations</summary>
        {model.limitations.map((l: string) => (
          <p key={l}>{l}</p>
        ))}
      </details>
    </section>
  );
}
export default function RecruitmentStrategyPage() {
  const utils = trpc.useUtils(),
    [offset, setOffset] = useState(0),
    q = trpc.recruitmentStrategy.dashboard.useQuery(
      { offset, limit: 25 },
      { retry: false }
    ),
    d = q.data,
    history = trpc.recruitmentStrategy.history.useQuery();
  const [fields, setFields] = useState<StrategyFields | null>(null),
    [revision, setRevision] = useState<number | null>(null),
    [mode, setMode] = useState<"draft" | "active" | "paused">("draft"),
    [reason, setReason] = useState(""),
    [notice, setNotice] = useState(""),
    [previewFor, setPreviewFor] = useState(""),
    [roleDraft, setRoleDraft] = useState<any>(null);
  const load = (explicit = false) => {
    if (d) {
      setFields(d.strategy.fields ?? null);
      setRevision(d.strategy.revision);
      setMode(d.strategy.mode === "unconfigured" ? "draft" : d.strategy.mode);
      if (explicit) {
        preview.reset();
        setPreviewFor("");
        save.reset();
        setNotice(
          d.strategy.fields
            ? "Recorded assumptions loaded. Previous preview cleared."
            : "No strategy is configured. Unsaved assumptions and preview cleared."
        );
      }
    }
  };
  useEffect(() => {
    if (revision === null && d) load();
  }, [d]);
  const stale = revision !== null && d && revision !== d.strategy.revision;
  const save = trpc.recruitmentStrategy.save.useMutation({
    onSuccess: r => {
      setRevision(r.revision);
      setNotice(
        "Strategy version saved. It authorizes internal planning only. Role assumptions must be reviewed against this version."
      );
      utils.recruitmentStrategy.invalidate();
      utils.ownerBrief.invalidate();
    },
    onError: () => utils.recruitmentStrategy.dashboard.invalidate(),
  });
  const preview = trpc.recruitmentStrategy.preview.useMutation({
    onSuccess: (_, input) => setPreviewFor(JSON.stringify(input)),
  });
  const assess = trpc.recruitmentStrategy.assessRole.useMutation({
    onSuccess: () => {
      setRoleDraft(null);
      setNotice(
        "Role assumptions recorded as owner assertions. No workflow or contact was started."
      );
      utils.recruitmentStrategy.invalidate();
    },
    onError: () => utils.recruitmentStrategy.dashboard.invalidate(),
  });
  const change = (key: keyof StrategyFields, value: unknown) =>
    setFields(v => (v ? { ...v, [key]: value } : v));
  const errors = [
    q.error,
    history.error,
    save.error,
    preview.error,
    assess.error,
  ].filter(Boolean);
  return (
    <main className="space-y-5 max-w-6xl">
      <h1 className="text-3xl font-semibold">
        Recruitment strategy and capacity
      </h1>
      <p>
        Plan your niche, delivery capacity and economics using explicit
        assumptions. This page does not discover contacts, verify candidate
        supply, spend budgets or start recruiting workflows.{" "}
        <a className="underline" href="/briefs">
          Open operating brief
        </a>
        .
      </p>
      {notice && <p role="status">{notice}</p>}
      {errors.map((e: any, i) => (
        <p
          className="rounded border p-3 text-red-800 break-words"
          role="alert"
          key={i}
        >
          {e.message}
        </p>
      ))}
      <section
        aria-label="Current strategy status"
        className="rounded-xl border bg-white p-4 space-y-2"
      >
        <h2 className="text-xl font-semibold">Current strategy</h2>
        <p>
          Version {d?.strategy.revision ?? "loading"} ·{" "}
          {d?.strategy.mode ?? "loading"} · evidence: owner assumptions.{" "}
          {d?.model?.freshness ?? "No strategy configured"}. Source reports are
          shown separately and do not verify these assumptions.
        </p>
        {d?.plan && (
          <>
            <p>
              {d.plan.selectedRoles} roles fit this proposed allocation ·{" "}
              {d.plan.unallocatedMinutes} unallocated delivery minutes. Daily
              prospect planning ceiling {d.plan.dailyProspectPlanningCeiling},
              capped by current workspace limit {d.plan.policyCap}. This is not
              contact permission.
            </p>
            <p>
              Worker {d.workspace?.backgroundEnabled ? "enabled" : "disabled"} ·
              emergency stop {d.workspace?.emergencyStop ? "on" : "off"}.
              Planning{" "}
              {d.plan.planningEnabled ? "active" : "inactive, stale or stopped"}
              . No workflow execution is authorized.
            </p>
            <details>
              <summary>Allocation limitations</summary>
              {d.plan.limits.map((l: string) => (
                <p key={l}>{l}</p>
              ))}
            </details>
          </>
        )}
        <p>
          Current reported market observations:{" "}
          {d?.marketEvidence.usableRecords ?? 0} across{" "}
          {d?.marketEvidence.accountsWithEvidence ?? 0} accounts.{" "}
          {d?.matchingMarketRecords === null
            ? "Configure strategy criteria to count exact tag matches."
            : String(d?.matchingMarketRecords ?? 0) +
              " records match the configured industry/region/role-family tags exactly."}{" "}
          <a className="underline" href="/market-evidence">
            Review market evidence and source permissions
          </a>
          . Source authentication does not verify demand, legal rights,
          candidate supply or payment risk.
        </p>
        <Button
          variant="outline"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
        >
          Refresh strategy sources
        </Button>
      </section>
      <section
        aria-label="Strategy assumptions editor"
        className="rounded-xl border bg-white p-4 space-y-3"
      >
        <h2 className="text-xl font-semibold">
          Versioned planning assumptions
        </h2>
        <p>
          Money inputs use integer minor units: for INR, 100 means ₹1.00.
          Probability inputs use basis points: 10000 means 100%. Costs apply to
          the entire declared workday horizon unless labeled per unit. Review
          dates use UTC calendar days.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => load(true)}>
            Review current strategy version
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              preview.reset();
              setPreviewFor("");
              setFields(sample());
              setRevision(d?.strategy.revision ?? 0);
              setMode("draft");
              setNotice(
                "Illustrative values loaded into an unsaved draft. Replace them before activating."
              );
            }}
          >
            Load illustrative assumptions
          </Button>
        </div>
        {stale && (
          <p role="alert">
            Strategy changed. Your draft is preserved. Review the current
            version before saving.
          </p>
        )}
        {fields && (
          <form
            aria-label="Configure recruitment strategy"
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={e => {
              e.preventDefault();
              if (strategyFields.safeParse(fields).success)
                save.mutate({
                  expectedRevision: revision ?? 0,
                  mode,
                  fields,
                  reason,
                });
              else
                setNotice(
                  strategyFields
                    .safeParse(fields)
                    .error?.issues.map(i => i.path.join(".") + ": " + i.message)
                    .join(" · ") ?? "Review planning inputs."
                );
            }}
          >
            <label>
              Strategy name
              <Input
                aria-label="Strategy name"
                value={fields.name}
                onChange={e => change("name", e.target.value)}
                required
              />
            </label>
            <label>
              Planning mode
              <select
                aria-label="Strategy planning mode"
                className="block w-full rounded border p-2"
                value={mode}
                onChange={e => setMode(e.target.value as typeof mode)}
              >
                <option value="draft">Draft</option>
                <option value="active">Active internal planning</option>
                <option value="paused">Paused</option>
              </select>
            </label>
            {(
              ["niche", "idealClient", "exclusions", "assumptions"] as const
            ).map(k => (
              <label key={k}>
                {textLabels[k]}
                <Textarea
                  aria-label={textLabels[k]}
                  value={fields[k]}
                  onChange={e => change(k, e.target.value)}
                  required
                />
              </label>
            ))}
            {(["industries", "regions", "roleFamilies"] as const).map(k => (
              <label key={k}>
                {textLabels[k]}, one per line
                <Textarea
                  aria-label={textLabels[k]}
                  value={fields[k].join("\n")}
                  onChange={e => change(k, e.target.value.split("\n"))}
                  required
                />
              </label>
            ))}
            <label>
              Currency
              <Input
                aria-label="Strategy currency"
                value={fields.currency}
                maxLength={3}
                onChange={e => change("currency", e.target.value.toUpperCase())}
                required
              />
            </label>
            <label>
              Assumptions reviewed on, UTC date
              <Input
                aria-label="Strategy reviewed on"
                type="date"
                value={fields.reviewedOn}
                onChange={e => change("reviewedOn", e.target.value)}
                required
              />
            </label>
            {numericFields.map(([key, label, min, max]) => (
              <label key={key}>
                {label}
                <Input
                  aria-label={label}
                  type="number"
                  step={1}
                  min={min}
                  max={max}
                  value={fields[key] as number}
                  onChange={e => change(key, Number(e.target.value))}
                  required
                />
              </label>
            ))}
            {moneyFields.map(([key, label]) => (
              <label key={key}>
                {label}, minor units
                <Input
                  aria-label={label + " minor units"}
                  inputMode="numeric"
                  pattern="(0|[1-9][0-9]{0,14})"
                  value={fields[key] as string}
                  onChange={e => change(key, e.target.value)}
                  required
                />
              </label>
            ))}
            <label>
              Modeled fee type
              <select
                aria-label="Strategy fee type"
                className="block w-full rounded border p-2"
                value={fields.fee.mode}
                onChange={e =>
                  change(
                    "fee",
                    e.target.value === "fixed"
                      ? { mode: "fixed", amountMinor: "" }
                      : {
                          mode: "percentage",
                          rateBps: 0,
                          annualSalaryMinor: "",
                        }
                  )
                }
              >
                <option value="fixed">Fixed fee</option>
                <option value="percentage">
                  Percentage of annual salary assumption
                </option>
              </select>
            </label>
            {fields.fee.mode === "fixed" ? (
              <label>
                Modeled fee, minor units
                <Input
                  aria-label="Modeled fixed fee minor units"
                  value={fields.fee.amountMinor}
                  onChange={e =>
                    change("fee", {
                      mode: "fixed",
                      amountMinor: e.target.value,
                    })
                  }
                  required
                />
              </label>
            ) : (
              <>
                <label>
                  Annual salary assumption, minor units
                  <Input
                    aria-label="Annual salary assumption minor units"
                    value={fields.fee.annualSalaryMinor}
                    onChange={e =>
                      change("fee", {
                        ...fields.fee,
                        annualSalaryMinor: e.target.value,
                      })
                    }
                    required
                  />
                </label>
                <label>
                  Fee rate, basis points
                  <Input
                    aria-label="Fee rate basis points"
                    type="number"
                    min={1}
                    max={10000}
                    value={fields.fee.rateBps}
                    onChange={e =>
                      change("fee", {
                        ...fields.fee,
                        rateBps: Number(e.target.value),
                      })
                    }
                    required
                  />
                </label>
              </>
            )}
            <label className="sm:col-span-2">
              Reason for new strategy version
              <Textarea
                aria-label="Strategy version reason"
                minLength={8}
                value={reason}
                onChange={e => setReason(e.target.value)}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={preview.isPending}
              onClick={() => preview.mutate(fields)}
            >
              Preview unsaved scenarios
            </Button>
            <Button
              disabled={
                save.isPending ||
                !!stale ||
                revision === null ||
                reason.trim().length < 8
              }
            >
              Save strategy version
            </Button>
          </form>
        )}
      </section>
      {preview.data && (
        <>
          <p role="status">
            {previewFor === JSON.stringify(fields)
              ? "Preview matches the current unsaved inputs."
              : "Inputs changed after this preview. Recalculate before relying on it."}
          </p>
          <ScenarioView model={preview.data} />
        </>
      )}
      {d?.model && !preview.data && <ScenarioView model={d.model} />}
      <section
        aria-label="Role priority and capacity proposals"
        className="rounded-xl border bg-white p-4 space-y-3"
      >
        <h2 className="text-xl font-semibold">
          Role priorities and capacity proposals
        </h2>
        <p>
          These are internal role priorities, not candidate rankings or verified
          hiring demand. {d?.totalRoles ?? 0} source roles; proposals are
          calculated from the full supported source set before display
          pagination.
        </p>
        {d?.roles.map((r: any) => (
          <article key={r.jobId} className="rounded border p-3 space-y-2">
            <h3 className="font-semibold">{r.title}</h3>
            <p className="break-all text-xs">
              Role {r.jobId} · source {r.sourceDigest}
            </p>
            <p>
              {r.allocated ? "Included in proposed capacity" : "Not allocated"}{" "}
              · {r.allocationReason}. Review:{" "}
              {r.issues.length
                ? r.issues.join(", ")
                : "owner assumptions remain independently unverified"}
              . Reported market records for this account:{" "}
              {r.marketEvidenceRecords}. These do not change the owner-entered
              model probabilities.
            </p>
            {r.modeledContributionMinor !== null && (
              <p>
                Modeled contribution for a single attempted role:{" "}
                {formatAnalyticsMoney(
                  r.modeledContributionMinor,
                  d.strategy.fields!.currency
                )}
                . Not actual margin or a forecast to add to the acquisition
                scenarios.
              </p>
            )}
            <Button
              variant="outline"
              onClick={() =>
                setRoleDraft({
                  jobId: r.jobId,
                  sourceDigest: r.sourceDigest,
                  strategyRevision: d.strategy.revision,
                  expectedRevision: r.assessmentRevision,
                  fields: r.assessment ?? {
                    targetFit: "unreviewed",
                    feeMinor: "",
                    currency: d.strategy.fields!.currency,
                    availableCandidates: 0,
                    feasibilityBps: 0,
                    placementBps: 0,
                    collectionBps: 0,
                    deliveryMinutes: 60,
                    variableCostMinor: "0",
                    reviewedOn: new Date().toISOString().slice(0, 10),
                    freshnessDays: 7,
                    rationale: "",
                  },
                  reason: "",
                })
              }
            >
              Review role assumptions: {r.title}
            </Button>
          </article>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!offset || q.isFetching}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            Previous planning roles
          </Button>
          <Button
            variant="outline"
            disabled={!d?.hasMore || q.isFetching}
            onClick={() => setOffset(offset + 25)}
          >
            Next planning roles
          </Button>
        </div>
        {roleDraft && (
          <form
            aria-label="Assess role planning assumptions"
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={e => {
              e.preventDefault();
              assess.mutate(roleDraft);
            }}
          >
            <p className="sm:col-span-2 break-all">
              Reviewing exact role {roleDraft.jobId} against strategy version{" "}
              {roleDraft.strategyRevision}. Refreshes preserve this draft;
              changed sources require opening the current role assessment again.
            </p>
            <label>
              Reviewed target-client/niche fit
              <select
                aria-label="Role target fit"
                className="block w-full rounded border p-2"
                value={roleDraft.fields.targetFit}
                onChange={e =>
                  setRoleDraft({
                    ...roleDraft,
                    fields: { ...roleDraft.fields, targetFit: e.target.value },
                  })
                }
              >
                <option value="unreviewed">Unreviewed</option>
                <option value="within_strategy">
                  Within this strategy, owner assertion
                </option>
                <option value="outside_strategy">Outside this strategy</option>
              </select>
            </label>
            {(
              [
                "feeMinor",
                "currency",
                "availableCandidates",
                "feasibilityBps",
                "placementBps",
                "collectionBps",
                "deliveryMinutes",
                "variableCostMinor",
                "reviewedOn",
                "freshnessDays",
                "rationale",
              ] as const
            ).map(k => {
              const numeric = [
                "availableCandidates",
                "feasibilityBps",
                "placementBps",
                "collectionBps",
                "deliveryMinutes",
                "freshnessDays",
              ].includes(k);
              return (
                <label key={k}>
                  {roleLabels[k]} (owner assumption)
                  <Input
                    aria-label={roleLabels[k]}
                    type={
                      numeric ? "number" : k === "reviewedOn" ? "date" : "text"
                    }
                    value={roleDraft.fields[k]}
                    onChange={e =>
                      setRoleDraft({
                        ...roleDraft,
                        fields: {
                          ...roleDraft.fields,
                          [k]: numeric
                            ? Number(e.target.value)
                            : e.target.value,
                        },
                      })
                    }
                    required
                  />
                </label>
              );
            })}
            <label>
              Assessment reason
              <Textarea
                aria-label="Role assessment reason"
                value={roleDraft.reason}
                onChange={e =>
                  setRoleDraft({ ...roleDraft, reason: e.target.value })
                }
                minLength={8}
                required
              />
            </label>
            <Button disabled={assess.isPending}>
              Save role planning assumptions
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRoleDraft(null)}
            >
              Discard role planning draft
            </Button>
          </form>
        )}
      </section>
      <section
        aria-label="Strategy version history"
        className="space-y-3 rounded-xl border bg-white p-4"
      >
        <h2 className="text-xl font-semibold">Recorded strategy versions</h2>
        <p>
          Historical assumptions are retained for review. Current sources do not
          reconstruct historical outcomes.
        </p>
        {history.data?.items.map(v => (
          <details key={v.revision} className="rounded border p-3">
            <summary>
              Version {v.revision} · {v.fields.name} · {v.mode}
            </summary>
            <p>{v.reason}</p>
            <p>
              Reviewed {v.fields.reviewedOn}, freshness {v.fields.freshnessDays}{" "}
              days · {v.fields.currency} · {v.fields.horizonWorkdays} planning
              workdays · {v.fields.availableMinutes} available minutes.
            </p>
            <p>
              Target{" "}
              {formatAnalyticsMoney(
                v.fields.targetGrossMinor,
                v.fields.currency
              )}{" "}
              · fee{" "}
              {v.fields.fee.mode === "fixed"
                ? formatAnalyticsMoney(
                    v.fields.fee.amountMinor,
                    v.fields.currency
                  )
                : v.fields.fee.rateBps +
                  " basis points of " +
                  formatAnalyticsMoney(
                    v.fields.fee.annualSalaryMinor,
                    v.fields.currency
                  ) +
                  " annual salary assumption"}
              .
            </p>
            <p>
              {v.fields.niche} · {v.fields.industries.join(", ")} ·{" "}
              {v.fields.regions.join(", ")} · {v.fields.roleFamilies.join(", ")}
              .
            </p>
            <p>{v.fields.idealClient}</p>
            <p>{v.fields.exclusions}</p>
            <p>{v.fields.assumptions}</p>
          </details>
        ))}
        {history.data?.olderAvailable && (
          <p>
            Older versions exist beyond this 20-version view; no historical
            outcome is inferred.
          </p>
        )}
      </section>
    </main>
  );
}
