import { useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { zonedDateTimeToUtc } from "@shared/dateTime";

type Result = { hasConflict: boolean; conflicts: Array<{ id: string; scheduledAt: Date; durationMinutes: number; timezone: string; status: string }> };
export function InterviewScheduleCheck() {
  const { data: candidates = [] } = trpc.recruitment.candidates.list.useQuery({ limit: 100 });
  const utils = trpc.useUtils();
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null), [zone, setZone] = useState("Asia/Kolkata");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setResult(null); setError(""); setPending(true);
    try {
      const timezone = String(form.get("timezone"));
      const response = await utils.client.recruitment.interviews.checkSlot.query({ candidateId: String(form.get("candidateId")), scheduledAt: zonedDateTimeToUtc(String(form.get("scheduledAt")), timezone), timezone, durationMinutes: Number(form.get("duration")) });
      if (typeof response.hasConflict !== "boolean" || !Array.isArray(response.conflicts)) throw new Error("The schedule response could not be verified. Retry the check.");
      const conflicts = response.conflicts.map(row => {
        if (!row.id || !row.scheduledAt || typeof row.durationMinutes !== "number" || typeof row.timezone !== "string" || typeof row.status !== "string") throw new Error("A recorded schedule could not be read. Review the interview before scheduling.");
        const scheduledAt = new Date(row.scheduledAt);
        if (!Number.isFinite(scheduledAt.getTime())) throw new Error("A recorded interview has an invalid time.");
        return { id: row.id, scheduledAt, durationMinutes: row.durationMinutes, timezone: row.timezone, status: row.status };
      });
      setZone(timezone); setResult({ hasConflict: response.hasConflict, conflicts });
    } catch (e) { setError(e instanceof Error ? e.message : "Schedule check failed."); }
    finally { setPending(false); }
  };
  const field = "mt-1 w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2 text-sm";
  return <section className="min-w-0 space-y-3 rounded-xl border bg-white p-5"><h2 className="text-lg font-semibold">Check candidate schedule</h2>
    <p className="text-sm text-slate-600">Check recorded interviews before choosing a time. Participant confirmation and external calendar availability still need to be established. This check does not reserve a slot.</p>
    <form onSubmit={submit} onChange={() => { setResult(null); setError(""); }}><fieldset disabled={pending} className="grid min-w-0 gap-3 md:grid-cols-2">
      <label>Candidate<select aria-label="Schedule-check candidate" name="candidateId" required className={field}><option value="">Choose a candidate</option>{candidates.map(c => <option key={c.id} value={c.id}>{c.fullName}</option>)}</select></label>
      <label>Proposed date and time<input aria-label="Schedule-check date and time" name="scheduledAt" type="datetime-local" required className={field} /></label>
      <label>Timezone<input aria-label="Schedule-check timezone" name="timezone" required defaultValue="Asia/Kolkata" className={field} /></label>
      <label>Duration in minutes<input aria-label="Schedule-check duration" name="duration" type="number" min={15} max={240} defaultValue={45} required className={field} /></label>
      <Button type="submit" className="justify-self-start">{pending ? "Checking…" : "Check proposed time"}</Button>
    </fieldset></form>
    {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}
    {result && <div role="status" className="space-y-2 text-sm"><p>{result.hasConflict ? "This candidate has an overlapping recorded interview." : "No recorded candidate conflict found. Scheduling checks again when saved."}</p>{result.conflicts.map(c => <p key={c.id} className="break-words">Interview …{c.id.slice(-6)} · {new Date(c.scheduledAt).toLocaleString("en-IN", { timeZone: zone })} ({zone}) · {c.durationMinutes} minutes · {c.status}</p>)}</div>}
  </section>;
}
