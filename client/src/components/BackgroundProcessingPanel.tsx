import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function BackgroundProcessingPanel() {
  const utils = trpc.useUtils();
  const query = trpc.operations.queue.workerStatus.useQuery(undefined, { refetchInterval: 5000 });
  const change = trpc.operations.queue.configureWorker.useMutation({ onSuccess: async result => { await utils.operations.queue.workerStatus.invalidate(); toast.success(result.enabled ? "Automatic processing enabled. Check for a fresh heartbeat." : "Future managed processing cycles paused."); } });
  const status = query.data;
  const label = !status ? "Checking background processing…" : status.emergencyStop ? "Emergency stop enabled" : !status.enabled ? "Automatic processing paused" : status.lastError ? "Background processing needs attention" : status.heartbeatRecent ? "Recent background activity confirmed" : "Enabled; waiting for a fresh heartbeat";
  return <section className="min-w-0 space-y-3 rounded-xl border bg-white p-5"><h2 className="text-lg font-semibold">Automatic background processing</h2><p role="status" className="text-sm font-medium">{label}</p>{query.error && <p role="alert" className="text-sm text-red-700">{query.error.message}</p>}{status && <>
    <p className="text-sm text-slate-600">Processes due campaigns, interview reminders, collections and approved queue work while the application is running. Quiet hours, daily limits, consent and sending permissions still apply.</p>
    <p className="text-sm">Last observed activity: {status.lastHeartbeatAt ? new Date(status.lastHeartbeatAt).toLocaleString() : "No heartbeat recorded"}</p>
    {!status.persistentDatabase && <p className="text-sm text-amber-800">A persistent MySQL database is required for unattended processing.</p>}
    {status.lastError && <p role="alert" className="break-words text-sm text-red-700">{status.lastError}</p>}
    <div className="flex flex-wrap gap-3"><Button disabled={change.isPending || !status.persistentDatabase} variant={status.enabled ? "outline" : "default"} onClick={() => change.mutate({ enabled: !status.enabled, expectedRevision: status.revision })}>{status.enabled ? "Pause automatic processing" : "Enable automatic processing"}</Button><Link className="self-center text-sm text-emerald-800 underline" href="/exceptions">Review exceptions and approvals</Link></div>
    <p className="text-xs text-slate-500">Pausing stops future managed cycles. Already claimed work may finish. Emergency stop controls new delivery claims. Pending work persists across application restarts; processing resumes when the runtime is available.</p>
  </>}</section>;
}
