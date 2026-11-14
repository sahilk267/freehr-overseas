import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
const field = "block w-full min-w-0 rounded border bg-white p-2";
const panel = "space-y-3 rounded-xl border bg-white p-4 min-w-0";
const words = (s: string) => s.replaceAll("_", " ");
export default function PolicyLabPage() {
  const [status, setStatus] = useState<
      "all" | "pending" | "approved" | "rejected" | "cancelled"
    >("pending"),
    [offset, setOffset] = useState(0);
  const catalog = trpc.policyLab.catalog.useQuery(
    { status, offset, limit: 25 },
    { retry: false }
  );
  const [source, setSource] = useState<"current" | "saved" | "what_if">(
      "current"
    ),
    [policyId, setPolicy] = useState(""),
    [config, setConfig] = useState('{"autoApprovalRules": []}');
  const [subject, setSubject] = useState<"hypothetical" | "approval">(
      "hypothetical"
    ),
    [approvalId, setApproval] = useState(""),
    [action, setAction] = useState("email_send"),
    [payload, setPayload] = useState("{}"),
    [at, setAt] = useState("");
  const simulate = trpc.policyLab.simulate.useMutation();
  const input = {
    policySource: source,
    ...(source === "saved"
      ? { policyId }
      : source === "what_if"
        ? { configJson: config }
        : {}),
    subject,
    ...(subject === "approval"
      ? { approvalId }
      : { actionType: action, payloadJson: payload }),
    ...(at ? { at } : {}),
  };
  const signature = JSON.stringify(input),
    [submitted, setSubmitted] = useState<string | null>(null);
  const result = simulate.data,
    outdated =
      !!result &&
      (signature !== submitted ||
        (source === "current" &&
          catalog.data?.workspace.currentPolicyDigest !==
            result.policy.currentWorkspaceDigest));
  return (
    <div className="space-y-6 max-w-6xl min-w-0">
      <h1 className="text-2xl font-semibold">Policy lab</h1>
      <p>
        Explain policy rules and inspect recorded approvals and grace jobs. All
        simulations are read-only. A rule match never approves or executes an
        action.
      </p>
      <p>
        <a className="underline" href="/control">
          Open control centre for governed actions
        </a>
      </p>
      {catalog.error && <p role="alert">{catalog.error.message}</p>}
      {catalog.data && (
        <section className={panel}>
          <h2 className="font-semibold">Workspace context</h2>
          <p>
            Mode: {catalog.data.workspace.automationMode} · Emergency stop:{" "}
            {String(catalog.data.workspace.emergencyStop)} · Background enabled:{" "}
            {String(catalog.data.workspace.backgroundEnabled)}
          </p>
          <p>
            Quiet hours: {catalog.data.workspace.quietStart}–
            {catalog.data.workspace.quietEnd} ({catalog.data.workspace.timezone}
            ). Recipient restrictions and resource validity are checked by
            governing workflows.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              simulate.reset();
              setSubmitted(null);
              void catalog.refetch();
            }}
          >
            Refresh context and clear result
          </Button>
        </section>
      )}
      <form
        className={panel}
        onSubmit={e => {
          e.preventDefault();
          setSubmitted(signature);
          simulate.mutate(input);
        }}
      >
        <h2 className="font-semibold">Simulation inputs</h2>
        <label className="block">
          Policy source
          <select
            aria-label="Policy source"
            className={field}
            value={source}
            onChange={e => setSource(e.target.value as typeof source)}
          >
            <option value="current">Current workspace configuration</option>
            <option value="saved">Owned saved version (comparison only)</option>
            <option value="what_if">Unsaved what-if JSON</option>
          </select>
        </label>
        {source === "saved" && (
          <label className="block">
            Saved policy
            <select
              aria-label="Saved policy"
              required
              className={field}
              value={policyId}
              onChange={e => setPolicy(e.target.value)}
            >
              <option value="">Choose a saved policy</option>
              {catalog.data?.policies.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} · v{p.version} · {p.status}
                </option>
              ))}
            </select>
            {catalog.data?.olderPoliciesAvailable && (
              <span>Only the latest 50 saved versions are listed.</span>
            )}
          </label>
        )}
        {source === "what_if" && (
          <label className="block">
            Unsaved policy JSON
            <Textarea
              required
              aria-label="Unsaved policy JSON"
            value={config}
              onChange={e => setConfig(e.target.value)}
              rows={7}
              maxLength={64000}
            />
          </label>
        )}
        <label className="block">
          Subject
          <select
            aria-label="Subject"
            className={field}
            value={subject}
            onChange={e => setSubject(e.target.value as typeof subject)}
          >
            <option value="hypothetical">
              Hypothetical action and payload
            </option>
            <option value="approval">
              Owned stored approval (no overrides)
            </option>
          </select>
        </label>
        {subject === "hypothetical" ? (
          <>
            <label className="block">
              Action type
              <Input
                list="policy-actions"
                required
                maxLength={80}
                aria-label="Action type"
            value={action}
                onChange={e => setAction(e.target.value)}
              />
              <datalist id="policy-actions">
                {catalog.data?.actions.map(a => (
                  <option key={a.key} value={a.key} />
                ))}
                {catalog.data?.legacyActions.map(a => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </label>
            <label className="block">
              Hypothetical payload JSON
              <Textarea
                rows={5}
                maxLength={32000}
                required
                aria-label="Hypothetical payload JSON"
            value={payload}
                onChange={e => setPayload(e.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <label className="block">
              Approval status filter
              <select
                aria-label="Approval status filter"
                className={field}
                value={status}
                onChange={e => {
                  setStatus(e.target.value as typeof status);
                  setOffset(0);
                }}
              >
                {["pending", "approved", "rejected", "cancelled", "all"].map(
                  s => (
                    <option key={s}>{s}</option>
                  )
                )}
              </select>
            </label>
            <label className="block">
              Stored approval
              <select
                aria-label="Stored approval"
                required
                className={field}
                value={approvalId}
                onChange={e => setApproval(e.target.value)}
              >
                <option value="">Choose an owned approval</option>
                {catalog.data?.approvals.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.actionType} · {a.status} · {a.id}
                  </option>
                ))}
              </select>
            </label>
            <p>
              {catalog.data?.approvalTotal ?? 0} approvals in this filter.
              Stored payload values are withheld.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 25))}
              >
                Previous approvals
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!catalog.data?.hasMore}
                onClick={() => setOffset(offset + 25)}
              >
                Next approvals
              </Button>
            </div>
          </>
        )}
        <label className="block">
          Simulation time (optional ISO timestamp with timezone)
          <Input
            placeholder="Leave blank for current time"
            aria-label="Simulation time (optional ISO timestamp with timezone)"
            value={at}
            onChange={e => setAt(e.target.value)}
          />
        </label>
        <Button disabled={simulate.isPending || !catalog.data}>
          {simulate.isPending ? "Simulating…" : "Run read-only simulation"}
        </Button>
        {simulate.error && <p role="alert">{simulate.error.message}</p>}
      </form>
      {result && (
        <section className={panel} aria-label="Simulation result">
          <h2 className="font-semibold">Simulation result</h2>
          {outdated && (
            <p role="alert" className="font-semibold text-amber-800">
              Inputs or workspace context changed. This result is outdated; run
              the simulation again.
            </p>
          )}
          <p>
            Routing: {words(result.result.routing)} · Rule matched:{" "}
            {String(result.result.ruleMatched)} · Mandatory human review:{" "}
            {String(result.result.mandatoryHuman)}
          </p>
          <p>
            Supported executor action: {String(result.result.supportedEffect)} ·
            Execution authorized: false · Effects performed: false
          </p>
          <p>
            Registered intent:{" "}
            {result.result.registeredIntent ?? "No canonical intent registered"}
            . This does not verify the exact current domain effect.
          </p>
          <p>
            Rule grace: {result.result.matchingRuleGraceMinutes ?? "none"}{" "}
            minutes · Effective automatic grace:{" "}
            {result.result.effectiveAutomaticGraceMinutes ?? "none"} minutes.
          </p>
          <p>
            Policy: {result.policy.source}
            {result.policy.version !== null
              ? ` v${result.policy.version}`
              : ""}{" "}
            · Exact current stored content:{" "}
            {String(result.policy.isCurrentContent)} · At {result.simulatedAt}
          </p>
          <p className="break-all text-xs">
            Policy digest: {result.policy.digest}
            <br />
            Payload digest: {result.subject.payloadDigest}
            <br />
            Snapshot digest: {result.snapshotDigest}
          </p>
          {result.subject.approval && (
            <p>
              Stored approval: {result.subject.approval.id} ·{" "}
              {result.subject.approval.status} · Resource type matches registry:{" "}
              {String(result.result.storedResourceTypeMatchesRegistry)}
            </p>
          )}
          <h3 className="font-semibold">First-match trace</h3>
          <p>
            {words(result.trace.status)} · {result.trace.visitedRules}/
            {result.trace.ruleCount} rules visited ·{" "}
            {result.trace.notVisitedRules} unvisited · Trace truncated:{" "}
            {String(result.trace.traceTruncated)}
          </p>
          {result.trace.rules.map(r => (
            <div key={r.index} className="border rounded p-3 space-y-1">
              <p>
                Rule {r.index + 1}: {words(r.status)}
                {r.unconditional ? " · Unconditional (empty conditions)" : ""}
              </p>
              <p>
                {r.conditionsVisited} conditions evaluated,{" "}
                {r.conditionsNotVisited} unvisited, {r.conditionsOmitted}{" "}
                evaluated traces omitted.
              </p>
              {r.conditions.map((c, i) => (
                <p key={i} className="break-words text-sm">
                  {c.field ?? "Invalid field"} ·{" "}
                  {c.operator ?? "Invalid operator"} · {c.actualType}/
                  {c.expectedType} · {words(c.code)}
                </p>
              ))}
            </div>
          ))}
          <h3 className="font-semibold">Recorded policy jobs</h3>
          {!result.existingPolicyJobs.length && (
            <p>No recorded jobs found for this subject.</p>
          )}
          {result.existingPolicyJobs.map(j => (
            <p key={j.id} className="break-all">
              {j.id} · {j.status} · {String(j.scheduledAt)} · Attempts:{" "}
              {j.attempts} · Scope matches stored approval:{" "}
              {String(j.scopeMatchesStoredApproval)}
            </p>
          ))}
          {result.morePolicyJobsAvailable && (
            <p>Only the latest 20 matching jobs are shown.</p>
          )}
          <p>
            Next workspace contact window:{" "}
            {result.workspace.contactWindow.nextWorkspaceWindowAt ??
              result.workspace.contactWindow.issue}
            . No recipient rule or quiet-hour exception is evaluated.
          </p>
          <ul className="list-disc pl-5 space-y-2 text-sm">
            {result.limits.map(l => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
