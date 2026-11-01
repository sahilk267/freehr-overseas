import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

export function MailboxDiscoveryPanel() {
  const utils = trpc.useUtils();
  const lookup = trpc.email.discoverMailboxes.useMutation({ onSuccess: async () => { await Promise.all([utils.email.status.invalidate(), utils.operations.settings.readiness.invalidate()]); } });
  return <section className="min-w-0 space-y-3 rounded-xl border bg-white p-5">
    <h2 className="text-lg font-semibold">Authorized mailbox discovery</h2>
    <p className="text-sm text-slate-600">Find mailbox IDs using the Mail API token saved in hosting. Exact configured addresses must match the provider account. Discovery does not activate senders or send messages.</p>
    <Button disabled={lookup.isPending} onClick={() => lookup.mutate()}>{lookup.isPending ? "Checking provider…" : "Discover authorized mailboxes"}</Button>
    {lookup.error && <p role="alert">{lookup.error.message}</p>}
    {lookup.data && <div role="status" className="space-y-2 text-sm"><p>{lookup.data.ok ? "All configured mailboxes verified." : `Mailbox setup needs attention: ${lookup.data.status.replaceAll("_", " ")}.`}</p>{lookup.data.mailboxes.map(m => <p key={m.purpose} className="break-all">{m.address} · {m.status.replaceAll("_", " ")}</p>)}</div>}
    <p className="text-xs text-slate-500">Verified missing IDs are bound for this server process and rediscovered on restart. Conflicting saved IDs require correction; they are never overwritten automatically.</p>
  </section>;
}
