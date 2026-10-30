import { FOLLOW_UP_SCENARIOS } from "@shared/followups";
import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type Plan = inferRouterOutputs<AppRouter>["followups"]["detail"]["plan"];
const field = "w-full rounded-lg border border-slate-300 bg-white p-2 text-sm";
const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function DeliveryReconciliationForm({ dispatchId, approvalId, onSaved }: { dispatchId: string; approvalId: string; onSaved: () => Promise<void> }) {
  const [inspect, setInspect] = useState(false);
  const approved = trpc.email.outbound.approvalDetail.useQuery({ approvalId }, { enabled: inspect });
  const authorization = approved.data?.approval.payload as { recipient?: string; senderAddress?: string } | undefined;
  const [outcome, setOutcome] = useState<"accepted" | "not_accepted" | "unknown">("unknown");
  const [reference, setReference] = useState(""), [reason, setReason] = useState(""), [reviewed, setReviewed] = useState(false);
  const [acceptedAt, setAcceptedAt] = useState(localDate(new Date()));
  const save = trpc.followups.reconcileDispatch.useMutation({ onSuccess: async result => { toast.success(result.status === "reconciliation_required" ? "Evidence recorded; delivery remains unresolved" : "Owner evidence recorded; review the sequence before continuing"); await onSaved(); }, onError: e => toast.error(e.message) });
  return <details className="mt-3 border-t pt-3" onToggle={e => setInspect(e.currentTarget.open)}><summary className="cursor-pointer font-medium">Resolve uncertain delivery</summary>
    <p className="mt-2 text-sm text-slate-600">Check the provider’s delivery records for this exact attempt. Record the evidence below. An empty search or a timeout alone leaves the outcome unknown. This records your finding and keeps further sending in owner review.</p>
    {approved.isLoading && inspect && <p className="mt-3 text-sm">Loading original approved message…</p>}
    {approved.error && <p role="alert" className="mt-3 text-sm text-red-700">{approved.error.message}</p>}
    {approved.data?.message && <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm"><p>Approved recipient: {authorization?.recipient ?? "Unavailable"}</p><p>Recorded sender: {authorization?.senderAddress ?? "Unavailable"}</p><details className="mt-2"><summary className="cursor-pointer font-medium">Original approved content</summary><strong className="mt-2 block">{approved.data.message.subject}</strong><p className="mt-2 whitespace-pre-wrap">{approved.data.message.body}</p></details></div>}
    <form className="mt-3 space-y-3" onSubmit={e => { e.preventDefault(); save.mutate({ dispatchId, outcome, evidenceReference: reference, reason, reviewedProviderEvidence: true, acceptedAt: outcome === "accepted" ? new Date(acceptedAt) : undefined }); }}>
      <label className="block text-sm">Evidence outcome<select aria-label="Evidence outcome" className={field} value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)}><option value="unknown">Still unknown</option><option value="accepted">Provider acceptance confirmed by owner</option><option value="not_accepted">Provider confirmed this attempt was not accepted</option></select></label>
      <label className="block text-sm">Provider evidence reference<input aria-label="Provider evidence reference" required minLength={5} maxLength={500} className={field} value={reference} onChange={e => setReference(e.target.value)} /></label>
      <label className="block text-sm">Findings for this attempt<textarea aria-label="Findings for this attempt" required minLength={20} maxLength={1500} className={field} rows={3} value={reason} onChange={e => setReason(e.target.value)} /></label>
      {outcome === "accepted" && <label className="block text-sm">Actual acceptance time<input aria-label="Actual acceptance time" type="datetime-local" required className={field} value={acceptedAt} onChange={e => setAcceptedAt(e.target.value)} /></label>}
      <label className="flex items-start gap-2 text-sm"><input aria-label="Reviewed provider evidence" type="checkbox" required checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I reviewed provider evidence for this exact attempt and recipient.</label>
      <Button type="submit" disabled={save.isPending || !reviewed || !approved.data?.message}>Record delivery finding</Button>
    </form>
  </details>;
}

export function FollowUpRecoveryTools({ plan, onSaved }: { plan: Plan; onSaved: () => Promise<void> }) {
  const [opened, setOpened] = useState(false), [revision, setRevision] = useState(plan.revision);
  const [objective, setObjective] = useState(plan.objective), [sender, setSender] = useState(plan.senderIdentityId);
  const [timezone, setTimezone] = useState(plan.timezone), [weekdays, setWeekdays] = useState(plan.businessDaysOnly);
  const [deadline, setDeadline] = useState(localDate(new Date(Math.max(new Date(plan.deadlineAt).getTime(), Date.now() + 86400000))));
  const [startsAt, setStartsAt] = useState(localDate(new Date())), [responseWindow, setResponseWindow] = useState(plan.responseWindowMinutes);
  const [reason, setReason] = useState(""), [steps, setSteps] = useState(plan.steps.slice(plan.stepIndex));
  const [until, setUntil] = useState(localDate(new Date(Date.now() + 86400000))), [snoozeReason, setSnoozeReason] = useState("");
  const options = trpc.followups.options.useQuery();
  const versions = trpc.followups.versions.useInfiniteQuery({ id: plan.id, limit: 10 }, { getNextPageParam: page => page.nextCursor });
  const replan = trpc.followups.replan.useMutation({ onSuccess: async () => { toast.success("New revision saved for review; previous sending permissions revoked"); setOpened(false); await onSaved(); }, onError: e => toast.error(e.message) });
  const snooze = trpc.followups.snooze.useMutation({ onSuccess: async () => { toast.success("Sequence snoozed; sending returns to owner review"); setSnoozeReason(""); await onSaved(); }, onError: e => toast.error(e.message) });
  const load = () => { setRevision(plan.revision); setObjective(plan.objective); setSender(plan.senderIdentityId); setTimezone(plan.timezone); setWeekdays(plan.businessDaysOnly); setDeadline(localDate(new Date(Math.max(new Date(plan.deadlineAt).getTime(), Date.now() + 86400000)))); setStartsAt(localDate(new Date())); setResponseWindow(plan.responseWindowMinutes); setReason(""); const remaining = plan.steps.slice(plan.stepIndex); setSteps(remaining.length ? remaining.map(step => ({ ...step })) : [{ delayMinutes: 0, subject: "", body: "" }]); };
  const changeStep = (index: number, patch: Partial<Plan["steps"][number]>) => setSteps(previous => previous.map((step, i) => i === index ? { ...step, ...patch } : step));
  const purpose = FOLLOW_UP_SCENARIOS.find(s => s[0] === plan.scenarioId)?.[2];
  const erased = plan.recipient === "erased" || !plan.steps.length;
  return <div className="space-y-4 border-t pt-4">
    {!erased && <div><Button type="button" variant="outline" aria-expanded={opened} onClick={() => { if (!opened) load(); setOpened(!opened); }}>Edit / restart sequence</Button>{opened && <>
      <p className="mt-2 text-sm text-slate-600">Review the latest conversation and resource evidence. The messages below start a new sequence. Previously accepted messages stay in history; the editor begins with the remaining messages. Old approvals and automatic-sending permission are revoked.</p>
      <form className="mt-3 space-y-3" onSubmit={e => { e.preventDefault(); replan.mutate({ id: plan.id, expectedRevision: revision, reason, definition: { objective, senderIdentityId: sender, timezone, businessDaysOnly: weekdays, startsAt: new Date(startsAt), deadlineAt: new Date(deadline), responseWindowMinutes: responseWindow, steps } }); }}>
        <p className="text-xs text-slate-500">Editing revision {revision}. <button type="button" className="underline" onClick={load}>Reload latest definition</button></p>
        <label className="block text-sm">New objective<input aria-label="New objective" required minLength={3} maxLength={500} className={field} value={objective} onChange={e => setObjective(e.target.value)} /></label>
        <label className="block text-sm">Sender for new revision<select aria-label="Sender for new revision" required className={field} value={sender} onChange={e => setSender(e.target.value)}><option value="">Choose active sender</option>{options.data?.senders.filter(s => s.status === "active" && s.purpose === purpose).map(s => <option key={s.id} value={s.id}>{s.purpose} · {s.email}</option>)}</select></label>
        {steps.map((step, index) => <fieldset key={index} className="space-y-2 rounded-lg border p-3"><legend className="px-1 text-sm font-semibold">New message {index + 1}</legend>
          <label className="block text-sm">Subject<input aria-label={`New message ${index + 1} subject`} className={field} required maxLength={255} value={step.subject} onChange={e => changeStep(index, { subject: e.target.value })} /></label>
          <label className="block text-sm">Body<textarea aria-label={`New message ${index + 1} body`} className={field} required minLength={8} maxLength={12000} rows={4} value={step.body} onChange={e => changeStep(index, { body: e.target.value })} /></label>
          <label className="block text-sm">Delay (minutes)<input aria-label={`New message ${index + 1} delay`} type="number" min={0} max={43200} required className={field} value={step.delayMinutes} onChange={e => changeStep(index, { delayMinutes: Number(e.target.value) })} /></label>
          <Button type="button" variant="outline" disabled={steps.length === 1} onClick={() => setSteps(previous => previous.filter((_, i) => i !== index))}>Remove message {index + 1}</Button>
        </fieldset>)}
        <Button type="button" variant="outline" disabled={steps.length >= 6} onClick={() => setSteps(previous => [...previous, { subject: "", body: "", delayMinutes: 1440 }])}>Add message</Button>
        <p className="text-xs text-slate-500">Start and deadline use your local timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Contact windows use the recipient timezone below.</p>
        <label className="block text-sm">New start<input aria-label="New start" type="datetime-local" required className={field} value={startsAt} onChange={e => setStartsAt(e.target.value)} /></label>
        <label className="block text-sm">New deadline<input aria-label="New deadline" type="datetime-local" required className={field} value={deadline} onChange={e => setDeadline(e.target.value)} /></label>
        <label className="block text-sm">New timezone<input aria-label="New timezone" required className={field} value={timezone} onChange={e => setTimezone(e.target.value)} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={weekdays} onChange={e => setWeekdays(e.target.checked)} />Weekdays only</label>
        <label className="block text-sm">Final response window (minutes)<input aria-label="Final response window" type="number" required min={1} max={43200} className={field} value={responseWindow} onChange={e => setResponseWindow(Number(e.target.value))} /></label>
        <label className="block text-sm">Reason for new revision<textarea aria-label="Reason for new revision" className={field} required minLength={8} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <Button type="submit" disabled={replan.isPending}>Save new revision for review</Button>
      </form>
    </>}</div>}
    {!erased && !["cancelled", "completed", "exhausted"].includes(plan.status) && <details><summary className="cursor-pointer font-medium">Snooze next action</summary><form className="mt-3 space-y-3" onSubmit={e => { e.preventDefault(); snooze.mutate({ id: plan.id, expectedRevision: plan.revision, until: new Date(until), reason: snoozeReason }); }}><label className="block text-sm">Snooze until<input aria-label="Snooze until" type="datetime-local" required className={field} value={until} onChange={e => setUntil(e.target.value)} /></label><label className="block text-sm">Snooze reason<textarea aria-label="Snooze reason" required minLength={8} maxLength={500} className={field} value={snoozeReason} onChange={e => setSnoozeReason(e.target.value)} /></label><p className="text-xs text-slate-500">Confirm the latest replies have been reviewed. Sending will require fresh review after this time.</p><Button type="submit" disabled={snooze.isPending}>Save snooze</Button></form></details>}
    <details><summary className="cursor-pointer font-medium">Definition history</summary>{versions.error && <p role="alert">{versions.error.message}</p>}<div className="mt-3 space-y-3">{versions.data?.pages.flatMap(page => page.items).map(version => { const metadata = version.metadata as { redacted?: boolean; reason?: string; definition?: { objective?: string; recipient?: string; steps?: Plan["steps"]; deadlineAt?: string } }; return <details key={version.id} className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer">Revision {version.revision} · {new Date(version.createdAt).toLocaleString()}</summary>{metadata.redacted ? <p>Definition erased</p> : <><p className="mt-2">{metadata.definition?.objective} · {metadata.definition?.recipient}</p><p className="text-xs text-slate-500">{metadata.reason}</p>{metadata.definition?.steps?.map((step, i) => <div key={i} className="mt-3"><strong>{step.subject}</strong><p className="whitespace-pre-wrap">{step.body}</p></div>)}</>}</details>; })}</div>{versions.hasNextPage && <Button type="button" variant="outline" disabled={versions.isFetchingNextPage} onClick={() => versions.fetchNextPage()}>Older definitions</Button>}</details>
  </div>;
}
