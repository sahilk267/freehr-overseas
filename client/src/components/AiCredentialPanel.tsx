import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

export function AiCredentialPanel() {
  const check = trpc.operations.settings.verifyAiCredentials.useMutation();
  return <section className="min-w-0 space-y-3 rounded-xl border bg-white p-5">
    <h2 className="text-lg font-semibold">Free AI credential health</h2>
    <p className="text-sm text-slate-600">Check primary and backup OpenRouter authentication without submitting a CV, generating content or sending a message. All recruitment AI routes remain free-only.</p>
    <Button disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? "Checking keys…" : "Verify AI credentials"}</Button>
    {check.error && <p role="alert">{check.error.message}</p>}
    {check.data && <div role="status" className="space-y-2 text-sm">{check.data.results.map(row => <p key={row.slot}>{row.slot === "primary" ? "Primary key" : "Backup key"}: {row.status.replaceAll("_", " ")}</p>)}</div>}
    <p className="text-xs text-slate-500">This is a point-in-time authentication check. Keys may share account limits; successful authentication does not guarantee model availability. Repeated identical keys are checked once.</p>
  </section>;
}
