import { useEffect, useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { zonedDateTimeToUtc } from "@shared/dateTime";
import { toast } from "sonner";

const field = "mt-1 w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2 text-sm";
export function InterviewSlotHolds() {
  const utils = trpc.useUtils();
  const candidates = trpc.recruitment.candidates.list.useQuery({ limit: 100 });
  const jobs = trpc.recruitment.jobs.list.useQuery({ limit: 100 });
  const holds = trpc.recruitment.interviews.holds.list.useQuery(undefined, { refetchInterval: 15000 });
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState(""), [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const refresh = async () => { await Promise.all([utils.recruitment.interviews.holds.list.invalidate(), utils.recruitment.interviews.list.invalidate()]); };
  const create = trpc.recruitment.interviews.holds.create.useMutation();
  const release = trpc.recruitment.interviews.holds.release.useMutation({ onSuccess: refresh });
  const book = trpc.recruitment.interviews.holds.book.useMutation({ onSuccess: async result => { await refresh(); toast.success(result.alreadyExists ? "Existing booking reused." : "Hold converted to a saved interview. Participant confirmation is still required."); } });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(""); const form = new FormData(event.currentTarget);
    try {
      const result = await create.mutateAsync({ requestKey, candidateId: String(form.get("candidateId")), scheduledAt: zonedDateTimeToUtc(String(form.get("scheduledAt")), String(form.get("timezone"))), timezone: String(form.get("timezone")), durationMinutes: Number(form.get("duration")), ttlMinutes: Number(form.get("ttl")) });
      await refresh(); setRequestKey(crypto.randomUUID());
      toast.success(result.status === "active" ? "Internal candidate slot held temporarily. No invitation sent." : `Previous hold is ${result.status}. Review before starting another request.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Hold could not be saved."); }
  };
  const bookSlot = async (event: FormEvent<HTMLFormElement>, id: string) => {
    event.preventDefault(); setError(""); const data = new FormData(event.currentTarget), job = jobs.data?.find(j => j.id === String(data.get("jobId")));
    if (!job) { setError("Choose a saved job before booking this hold."); return; }
    try { await book.mutateAsync({ id, companyId: job.companyId, jobId: job.id, meetingUrl: String(data.get("meetingUrl") || "") || undefined }); }
    catch (e) { setError(e instanceof Error ? e.message : "Booking failed."); await refresh(); }
  };
  const rows = holds.data ?? [];
  return <section className="min-w-0 space-y-3 rounded-xl border bg-white p-5"><h2 className="text-lg font-semibold">Temporary candidate slot holds</h2>
    <p className="text-sm text-slate-600">Reserve a candidate's time inside this workspace for up to 30 minutes while coordinating. Expiry releases it automatically, without a worker. This does not reserve Google calendars, interviewer time or participant availability, and sends no invitation.</p>
    <form onSubmit={submit} onChange={() => { setRequestKey(crypto.randomUUID()); setError(""); }}><fieldset disabled={create.isPending} className="grid min-w-0 gap-3 md:grid-cols-2">
      <label>Candidate<select required name="candidateId" aria-label="Hold candidate" className={field}><option value="">Choose a candidate</option>{candidates.data?.map(c => <option key={c.id} value={c.id}>{c.fullName}</option>)}</select></label>
      <label>Proposed date and time<input required aria-label="Hold date and time" name="scheduledAt" type="datetime-local" className={field} /></label>
      <label>Timezone<input required aria-label="Hold timezone" name="timezone" defaultValue="Asia/Kolkata" className={field} /></label>
      <label>Duration in minutes<input required aria-label="Hold duration" name="duration" type="number" min={15} max={240} defaultValue={45} className={field} /></label>
      <label>Hold lifetime in minutes<input required aria-label="Hold lifetime" name="ttl" type="number" min={1} max={30} defaultValue={10} className={field} /></label>
      <Button type="submit" className="self-end justify-self-start">{create.isPending ? "Holding…" : "Hold candidate slot"}</Button>
    </fieldset></form>
    {[holds.error, release.error].filter(Boolean).map((e, i) => <p key={i} role="alert" className="break-words text-sm text-red-700">{e?.message}</p>)}
    {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}
    {holds.isLoading ? <p className="text-sm">Loading slot holds…</p> : !rows.length && <p className="text-sm">No internal slot holds recorded.</p>}
    <div className="space-y-3">{rows.map(hold => {
      const remaining = Math.max(0, Math.ceil((new Date(hold.expiresAt).getTime() - now) / 1000)), active = hold.status === "active" && remaining > 0;
      const status = hold.status === "active" && !active ? "expired" : hold.status;
      return <div key={hold.id} className="min-w-0 space-y-2 rounded-lg border p-3 text-sm"><p className="break-words">{candidates.data?.find(c => c.id === hold.candidateId)?.fullName || `Candidate …${hold.candidateId.slice(-6)}`} · {new Date(hold.scheduledAt).toLocaleString("en-IN", { timeZone: hold.timezone })} ({hold.timezone}) · {hold.durationMinutes} minutes</p>
        <p role="status">Hold …{hold.id.slice(-6)} · {status}{active ? ` · ${remaining}s remaining` : ""}{hold.interviewId ? ` · Interview …${hold.interviewId.slice(-6)}` : ""}</p>
        {active && <><form onSubmit={event => bookSlot(event, hold.id)}><fieldset disabled={book.isPending || release.isPending} className="grid min-w-0 gap-3 md:grid-cols-2"><label>Job<select required name="jobId" className={field}><option value="">Choose a job</option>{jobs.data?.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}</select></label><label>Meeting URL (optional)<input name="meetingUrl" type="url" className={field} /></label><Button type="submit" className="justify-self-start">Book this held slot</Button></fieldset></form><Button variant="outline" disabled={release.isPending || book.isPending} onClick={() => release.mutate({ id: hold.id })}>Release hold</Button></>}
      </div>;
    })}</div>
  </section>;
}
