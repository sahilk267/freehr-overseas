import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { formatMoney, parseMoney } from "@shared/money";
import { toast } from "sonner";

type Detail = inferRouterOutputs<AppRouter>["collections"]["detail"];
const field = "w-full rounded-lg border border-slate-300 bg-white p-2 text-sm";
const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const when = (date: Date | string | null) => date ? new Date(date).toLocaleString() : "—";

export function InvoiceCollectionsPanel({ owner }: { owner: boolean }) {
  const utils = trpc.useUtils(), [selected, setSelected] = useState("");
  const ledger = trpc.collections.ledger.useInfiniteQuery({ limit: 25 }, { getNextPageParam: page => page.nextCursor });
  const detail = trpc.collections.detail.useQuery({ invoiceId: selected }, { enabled: owner && Boolean(selected) });
  const refresh = async () => { await Promise.all([utils.collections.invalidate(), utils.followups.invalidate(), utils.recruitment.invoices.invalidate()]); };
  const process = trpc.collections.processDue.useMutation({ onSuccess: async r => { if (r.failed) toast.error(`${r.failed} collection evaluation(s) failed. Review invoice diagnostics.`); else toast.success(`${r.enrolled} collection sequence(s) created for review; ${r.held} held.`); await refresh(); }, onError: e => toast.error(e.message) });
  const rows = ledger.data?.pages.flatMap(p => p.items) ?? [];
  const balances = new Map<string, number>();
  for (const row of rows) if (row.remaining !== null && ["issued", "delivered", "payment_pending", "partially_paid", "overdue", "disputed"].includes(row.status)) balances.set(row.currency, (balances.get(row.currency) ?? 0) + row.remaining);
  return <section className="rounded-xl border border-slate-200 bg-white p-5 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-semibold">Receivables & collection automation</h2><p className="mt-2 max-w-3xl text-sm text-slate-600">Balances come from recorded receipts. Client promises remain separate. Collection sequences use the central Follow-ups review and sending controls.</p></div>{owner && <Button disabled={process.isPending} onClick={() => process.mutate()}>Evaluate collections</Button>}</div>
    {ledger.error && <p role="alert" className="mt-3 text-red-700">{ledger.error.message}</p>}
    <p className="mt-3 text-sm text-slate-600">Receivable balance in loaded issued invoices: {[...balances].map(([currency, balance]) => formatMoney(balance, currency)).join(" · ") || "—"}</p>
    <p className="mt-1 text-xs text-slate-500">Aging timezone: {ledger.data?.pages[0]?.timezone ?? "…"}. {rows.length} invoices loaded; currencies are kept separate.</p>
    <div className="mt-4 space-y-3">{rows.map(row => <div key={row.id} className="rounded-lg border p-3 text-sm"><div className="flex flex-wrap justify-between gap-3"><div><strong>{row.invoiceNumber}</strong><span className="ml-2 text-xs text-slate-500">{row.status.replaceAll("_", " ")}</span><p className="mt-1">Received: {row.paid === null ? "Review required" : formatMoney(row.paid, row.currency)} · Outstanding: {row.remaining === null ? "Review required" : formatMoney(row.remaining, row.currency)}</p><p className="mt-1 text-xs text-slate-500">Due: {when(row.dueAt)} · Aging: {row.agingBucket} · Collections: {row.onHold ? "owner hold" : row.collectionsEnabled ? "enabled for review" : "disabled"}</p>{row.promise && <p className="mt-2">Promise: {row.promise.status.replaceAll("_", " ")} · {formatMoney(row.promise.remaining, row.currency)} remaining · {when(row.promise.dueAt)}</p>}{(row.holdReason || row.reconciliationIssue) && <p className="mt-2 text-xs text-amber-800">{row.reconciliationIssue ?? row.holdReason}</p>}</div>{owner && <Button variant="outline" onClick={() => setSelected(row.id)}>Manage {row.invoiceNumber}</Button>}</div></div>)}</div>
    {ledger.hasNextPage && <Button className="mt-3" variant="outline" disabled={ledger.isFetchingNextPage} onClick={() => ledger.fetchNextPage()}>Load more invoices</Button>}
    {owner && selected && detail.isLoading && <p className="mt-4">Loading collection controls…</p>}
    {owner && detail.error && <p role="alert" className="mt-4 text-red-700">{detail.error.message}</p>}
    {owner && detail.data && <CollectionControls key={selected} detail={detail.data} onSaved={refresh} />}
  </section>;
}

function CollectionControls({ detail, onSaved }: { detail: Detail; onSaved: () => Promise<void> }) {
  const current = detail.promises.find(p => ["open", "missed"].includes(p.status));
  const [revision, setRevision] = useState(detail.settings?.revision ?? 0), [contactId, setContact] = useState(detail.settings?.contactId ?? ""), [senderIdentityId, setSender] = useState(detail.settings?.senderIdentityId ?? "");
  const [enabled, setEnabled] = useState(detail.settings?.enabled ?? false), [onHold, setHold] = useState(detail.settings?.onHold ?? false), [graceDays, setGrace] = useState(detail.settings?.graceDays ?? 1), [maxNudges, setNudges] = useState(detail.settings?.maxNudges ?? 3), [reason, setReason] = useState(""), [reviewed, setReviewed] = useState(false);
  const [amount, setAmount] = useState(""), [dueAt, setDue] = useState(localDate(new Date(Date.now() + 3 * 86400000))), [evidence, setEvidence] = useState(""), [acknowledge, setAcknowledge] = useState(false), [cancelReason, setCancelReason] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID()), [expectedPromiseId, setExpectedPromise] = useState(current?.id ?? null);
  const save = trpc.collections.saveSettings.useMutation({ onSuccess: async r => { setRevision(r.revision); setReason(""); setReviewed(false); toast.success("Collection settings saved; new sequences require review"); await onSaved(); }, onError: e => toast.error(e.message) });
  const promise = trpc.collections.recordPromise.useMutation({ onSuccess: async r => { setExpectedPromise(r.id); setRequestId(crypto.randomUUID()); setAmount(""); setEvidence(""); setAcknowledge(false); toast.success("Promise recorded; invoice balance is unchanged"); await onSaved(); }, onError: e => toast.error(e.message) });
  const cancel = trpc.collections.cancelPromise.useMutation({ onSuccess: async () => { setExpectedPromise(null); setCancelReason(""); toast.success("Promise cancelled; any collection still requires review"); await onSaved(); }, onError: e => toast.error(e.message) });
  const reload = () => { setRevision(detail.settings?.revision ?? 0); setContact(detail.settings?.contactId ?? ""); setSender(detail.settings?.senderIdentityId ?? ""); setEnabled(detail.settings?.enabled ?? false); setHold(detail.settings?.onHold ?? false); setGrace(detail.settings?.graceDays ?? 1); setNudges(detail.settings?.maxNudges ?? 3); setExpectedPromise(current?.id ?? null); setReviewed(false); };
  return <div className="mt-6 space-y-4 border-t pt-5"><div className="flex flex-wrap justify-between gap-3"><h3 className="font-semibold">Collection controls: {detail.invoice.invoiceNumber}</h3><Button type="button" variant="outline" onClick={reload}>Reload collection controls</Button></div>
    <p className="text-sm text-slate-600">Settings revision {revision}. Review the latest client replies before enabling or restarting a collection cycle. Contact permission is managed in <a className="underline" href="/follow-ups">Follow-ups</a>.</p>
    {(detail.settings?.revision ?? 0) !== revision && <p className="text-sm text-amber-800">Settings changed. Reload collection controls to review the current version.</p>}
    <form className="grid gap-3 md:grid-cols-2" onSubmit={e => { e.preventDefault(); save.mutate({ invoiceId: detail.invoice.id, expectedRevision: revision, contactId, senderIdentityId, enabled, onHold, graceDays, maxNudges, reason, reviewedReplies: true }); }}>
      <label className="text-sm">Invoice company contact<select aria-label="Invoice company contact" className={field} required value={contactId} onChange={e => setContact(e.target.value)}><option value="">Choose contact</option>{detail.contacts.filter(c => c.email).map(c => <option key={c.id} value={c.id}>{c.name} · {c.email} · {c.permission}</option>)}</select></label>
      <label className="text-sm">Finance sender<select aria-label="Finance sender" className={field} required value={senderIdentityId} onChange={e => setSender(e.target.value)}><option value="">Choose sender</option>{detail.senders.map(s => <option key={s.id} value={s.id}>{s.email} · {s.status}</option>)}</select></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="Enable collection follow-ups" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Enable collection follow-ups</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="Owner hold" checked={onHold} onChange={e => setHold(e.target.checked)} />Owner hold</label>
      <label className="text-sm">Grace days after due date<input aria-label="Grace days after due date" type="number" required min={0} max={30} className={field} value={graceDays} onChange={e => setGrace(Number(e.target.value))} /></label>
      <label className="text-sm">Maximum messages in this cycle<input aria-label="Maximum messages in this cycle" type="number" required min={1} max={3} className={field} value={maxNudges} onChange={e => setNudges(Number(e.target.value))} /></label>
      <p className="md:col-span-2 text-xs text-slate-500">Review sequence: first eligible contact, then waits of 3 and 4 calendar days after the previous accepted message, subject to weekdays, quiet hours and sending caps. Due/grace uses the workspace timezone. No message sends just by enabling this setting.</p>
      <label className="md:col-span-2 text-sm">Reason for collection change<textarea aria-label="Reason for collection change" className={field} required minLength={8} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <label className="md:col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" aria-label="Reviewed latest client replies" required checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I reviewed the latest client replies and this collection intent.</label>
      <div className="md:col-span-2"><Button disabled={save.isPending || !reviewed} type="submit">Save collection settings</Button></div>
    </form>
    <details className="border-t pt-4"><summary className="cursor-pointer font-medium">Record / replace payment promise</summary><p className="mt-2 text-sm text-slate-600">Record an actual client promise. It holds collection messages until the agreed time. Receipts must cover the promised amount before it is marked met. Time below uses your local timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
      {expectedPromiseId !== (current?.id ?? null) && <p className="mt-3 text-sm text-amber-800">The active promise changed. Reload collection controls before recording another promise.</p>}
      <form className="mt-3 grid gap-3 md:grid-cols-2" onSubmit={e => { e.preventDefault(); try { promise.mutate({ invoiceId: detail.invoice.id, expectedPromiseId, idempotencyKey: requestId, amount: parseMoney(amount, detail.invoice.currency), dueAt: new Date(dueAt), evidence, acknowledgeNotPayment: true }); } catch (error) { toast.error(error instanceof Error ? error.message : "Invalid promise amount"); } }}>
        <label className="text-sm">Promise amount ({detail.invoice.currency})<input aria-label="Promise amount" inputMode="decimal" className={field} required value={amount} onChange={e => setAmount(e.target.value)} /></label><label className="text-sm">Promised by<input aria-label="Promised by" type="datetime-local" className={field} required value={dueAt} onChange={e => setDue(e.target.value)} /></label>
        <label className="md:col-span-2 text-sm">Client promise evidence<textarea aria-label="Client promise evidence" className={field} required minLength={12} maxLength={1500} value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
        <label className="md:col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" aria-label="Promise is not payment" required checked={acknowledge} onChange={e => setAcknowledge(e.target.checked)} />This is a client promise, not a payment receipt or cleared funds.</label>
        <div className="md:col-span-2"><Button disabled={promise.isPending || !acknowledge || expectedPromiseId !== (current?.id ?? null)} type="submit">Record client promise</Button></div>
      </form>
    </details>
    {current && <div className="rounded-lg border p-3 text-sm"><p>Active promise: {formatMoney(current.amount, current.currency)} · {when(current.dueAt)} · {detail.promiseState ?? current.status}</p><label className="mt-3 block">Reason to cancel promise<input aria-label="Reason to cancel promise" className={field} value={cancelReason} onChange={e => setCancelReason(e.target.value)} /></label><Button className="mt-3" variant="outline" disabled={cancel.isPending || cancelReason.trim().length < 8 || expectedPromiseId !== current.id} onClick={() => cancel.mutate({ invoiceId: detail.invoice.id, promiseId: current.id, reason: cancelReason })}>Cancel active promise</Button></div>}
    <details><summary className="cursor-pointer text-sm font-medium">Recent collection diagnostics</summary><div className="mt-3 space-y-2">{detail.diagnostics.map(d => <p key={d.id} className="text-xs text-slate-600">{when(d.createdAt)} · {d.eventType.replaceAll("_", " ")} · {String((d.metadata as { reason?: string })?.reason ?? "Review sequence recorded")}</p>)}</div></details>
    <details><summary className="cursor-pointer text-sm font-medium">Promise history</summary><div className="mt-3 space-y-2">{detail.promises.map(p => <div key={p.id} className="rounded-lg border p-3 text-sm"><p>{formatMoney(p.amount, p.currency)} · {p.status.replaceAll("_", " ")} · {when(p.dueAt)}</p><p className="mt-1 text-xs text-slate-500">{p.evidence}</p></div>)}</div></details>
  </div>;
}
