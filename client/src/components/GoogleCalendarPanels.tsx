import { useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { zonedDateTimeToUtc } from "@shared/dateTime";
import { toast } from "sonner";
const field = "mt-1 w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2 text-sm";
const section = "min-w-0 space-y-3 rounded-xl border bg-white p-5";
export function GoogleCalendarConnectionPanel() {
  const utils = trpc.useUtils(), user = trpc.auth.me.useQuery(), owner = user.data?.role === "admin";
  const status = trpc.googleCalendar.status.useQuery(undefined, { enabled: owner });
  const [calendarId, setCalendarId] = useState("");
  const begin = trpc.googleCalendar.begin.useMutation({ onSuccess: data => window.location.assign(data.authorizationUrl) });
  const save = trpc.googleCalendar.configure.useMutation({ onSuccess: async () => { await utils.googleCalendar.status.invalidate(); toast.success("Calendar target saved. Previous calendar events were not moved or deleted."); } });
  const disconnect = trpc.googleCalendar.disconnect.useMutation({ onSuccess: async result => { await utils.googleCalendar.status.invalidate(); toast.success(result.revocationConfirmed ? "Calendar disconnected. Existing events were not deleted." : "Disconnected locally. Google revocation was not confirmed; review Google account permissions."); } });
  if (!owner) return null;
  const data = status.data;
  return <section className={section}><h2 className="text-lg font-semibold">Google Calendar connection</h2><p className="text-sm text-slate-600">Calendar permission is separate from platform sign-in. Your owner-password login stays unchanged. Private calendars require an OAuth Web client; an API key alone is insufficient.</p>
    {new URLSearchParams(window.location.search).get("googleCalendar") === "connection_failed" && <p role="alert" className="text-sm text-red-700">Calendar authorization did not complete. Review the missing settings or error below, then restart Connect Google Calendar.</p>}
    {[status.error, begin.error, save.error, disconnect.error].filter(Boolean).map((error, i) => <p key={i} role="alert" className="break-words text-sm text-red-700">{error?.message}</p>)}
    {data && <><p role="status" className="text-sm">{data.connected ? `Permission connected: ${data.accountEmail}` : "Calendar permission is not connected."}</p>
      {!data.configured && <div className="space-y-2 text-sm"><p>Configure the missing hosting values:</p>{data.missing.map(key => <p key={key} className="break-words font-mono text-xs">{key}</p>)}</div>}
      <label className="block text-sm">OAuth authorized redirect URI<input readOnly value={data.callbackUrl} className={field} /></label>
      {data.lastErrorCode && <p role="alert" className="text-sm">Last calendar error: {data.lastErrorCode.replaceAll("_", " ")}</p>}
      <div className="flex flex-wrap gap-3"><Button disabled={!data.configured || begin.isPending} onClick={() => begin.mutate()}>{data.connected ? "Reconnect Google Calendar" : "Connect Google Calendar"}</Button>{data.revision > 0 && <Button variant="outline" disabled={disconnect.isPending} onClick={() => { if (window.confirm("Disconnect calendar permission? Existing Google events will remain.")) disconnect.mutate(); }}>Disconnect calendar</Button>}</div>
      {data.connected && <form onSubmit={e => { e.preventDefault(); save.mutate({ calendarId: calendarId || data.calendarId, expectedRevision: data.revision }); }} className="space-y-2"><label className="block text-sm">Calendar ID<input required maxLength={320} value={calendarId || data.calendarId} onChange={e => setCalendarId(e.target.value)} className={field} /></label><Button type="submit" variant="outline" disabled={save.isPending}>Save calendar target</Button><p className="text-xs text-slate-500">Use primary or the calendar ID from Google Calendar settings. Changing the target leaves previous event copies in their original calendar.</p></form>}
      <CalendarAutomationPanel />
      <p className="text-xs text-slate-500">Access and refresh credentials are encrypted on the server. Session-secret rotation requires reconnection. Manual event sync is reviewed per interview. Optional automatic sync sends no guest invitations.</p>
    </>}
  </section>;
}
export function GoogleCalendarInterviewPanel() {
  const utils = trpc.useUtils(), user = trpc.auth.me.useQuery(), owner = user.data?.role === "admin";
  const status = trpc.googleCalendar.status.useQuery(undefined, { enabled: owner });
  const list = trpc.recruitment.interviews.list.useQuery({ limit: 100 }, { enabled: owner });
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [busyText, setBusyText] = useState<string | null>(null), [selected, setSelected] = useState("");
  const [conflict, setConflict] = useState<{previewHash:string; approvedExternalReviewHash:string; remote: {summary:string;status:string;start:string;end:string;location:string}; saved: {summary?:string;start?:{dateTime?:string};end?:{dateTime?:string};location?:string} } | null>(null);
  const [review, setReview] = useState<{ hash: string; summary: string; start: string; end: string; location: string; state: string; calendarId: string; accountEmail: string; zone: string } | null>(null);
  const sync = trpc.googleCalendar.sync.useMutation({ onSuccess: result => { setReview(null); toast.success(`Google event synchronized (${result.action}). No invitations sent.`); } });
  const checkBusy = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = new FormData(e.currentTarget); setPending(true); setBusyText(null); setError(""); try {
    const zone = String(form.get("timezone")), response = await utils.client.googleCalendar.freeBusy.query({ start: zonedDateTimeToUtc(String(form.get("start")), zone), end: zonedDateTimeToUtc(String(form.get("end")), zone) });
    if (!Array.isArray(response.busy)) throw Error("Provider availability could not be verified.");
    setBusyText(response.busy.length ? response.busy.map(b => { if (!b.start || !b.end) throw Error("Invalid provider interval."); return `${new Date(b.start).toLocaleString("en-IN", { timeZone: zone })} – ${new Date(b.end).toLocaleString("en-IN", { timeZone: zone })} (${zone})`; }).join("\n") : "No Google busy intervals returned. This is not a reservation or participant confirmation.");
  } catch (e) { setError(e instanceof Error ? e.message : "Calendar check failed."); } finally { setPending(false); } };
  const preview = async () => { setPending(true); setError(""); setReview(null); try { const r = await utils.client.googleCalendar.preview.query({ interviewId: selected }); if (!r.previewHash || !r.event?.start?.dateTime || !r.event?.end?.dateTime) throw Error("Event preview is unavailable."); setReview({ hash: r.previewHash, summary: r.event.summary || "FreelanceHR interview", start: r.event.start.dateTime, end: r.event.end.dateTime, location: r.event.location || "", state: r.event.status || "tentative", calendarId: r.calendarId || "", accountEmail: r.accountEmail || "", zone: r.event.start.timeZone || "UTC" }); } catch (e) { setError(e instanceof Error ? e.message : "Preview failed."); } finally { setPending(false); } };
  if (!owner) return null;
  return <section className={section}><h2 className="text-lg font-semibold">Google availability and event sync</h2><p className="text-sm text-slate-600">Check the connected calendar's busy window. Candidate availability still needs confirmation. After creating, rescheduling or cancelling an interview, review its current saved state before syncing it to Google.</p>
    {!status.data?.connected ? <p className="text-sm">Connect Google Calendar in Control Plane first. ICS exports and recorded candidate checks remain available.</p> : <>
      <form onSubmit={checkBusy} onChange={() => setBusyText(null)}><fieldset disabled={pending} className="grid gap-3 md:grid-cols-3"><label>Window start<input required name="start" type="datetime-local" className={field} /></label><label>Window end<input required name="end" type="datetime-local" className={field} /></label><label>Timezone<input required name="timezone" defaultValue="Asia/Kolkata" className={field} /></label><Button type="submit">Check Google busy window</Button></fieldset></form>
      {busyText !== null && <p role="status" className="whitespace-pre-wrap break-words text-sm">{busyText}</p>}
      <label className="block text-sm">Interview to mirror<select className={field} value={selected} onChange={e => { setSelected(e.target.value); setReview(null); setConflict(null); }}><option value="">Choose an interview</option>{list.data?.filter(i => i.scheduledAt).map(i => <option key={i.id} value={i.id}>Interview …{i.id.slice(-6)} · {new Date(i.scheduledAt!).toLocaleString()} · {i.status}</option>)}</select></label>
      <Button variant="outline" disabled={!selected || pending || sync.isPending} onClick={preview}>Review Google event sync</Button>
      <Button variant="outline" disabled={!selected || pending || sync.isPending} onClick={async()=>{setError("");setPending(true);setConflict(null);try{const result=await utils.client.googleCalendar.reviewConflict.query({interviewId:selected});setConflict(result as NonNullable<typeof conflict>);}catch(e){setError(e instanceof Error?e.message:"Conflict review failed.");}finally{setPending(false);}}}>Review Google changes</Button>
      {conflict && <div className="space-y-2 rounded-lg border p-3 text-sm"><p className="break-words">Google: {conflict.remote.summary} · {conflict.remote.status} · {conflict.remote.start} – {conflict.remote.end} · {conflict.remote.location}</p><p className="break-words">Saved interview: {conflict.saved.summary} · {conflict.saved.start?.dateTime} – {conflict.saved.end?.dateTime} · {conflict.saved.location}</p><p>Replace Google's app-managed fields with the saved interview above. This sends no invitations. A newer edit will require another review.</p><Button disabled={sync.isPending} onClick={()=>sync.mutate({interviewId:selected,previewHash:conflict.previewHash,approvedExternalReviewHash:conflict.approvedExternalReviewHash},{onSuccess:()=>setConflict(null)})}>Replace reviewed Google changes</Button></div>}
      {review && <div className="space-y-2 rounded-lg border p-3 text-sm"><p className="break-words">{review.accountEmail} · {review.calendarId}</p><p>{review.summary} · {review.state}</p><p>{new Date(review.start).toLocaleString("en-IN", { timeZone: review.zone })} – {new Date(review.end).toLocaleString("en-IN", { timeZone: review.zone })} ({review.zone})</p><p className="break-all">{review.location}</p><p>Saved interview fields replace app-managed Google fields. No attendee invitations are sent. Sync does not negotiate or reserve participant availability.</p><Button disabled={sync.isPending} onClick={() => sync.mutate({ interviewId: selected, previewHash: review.hash })}>{review.state === "cancelled" ? "Cancel mirrored Google event" : "Sync reviewed event to Google"}</Button></div>}
    </>}
    {sync.error && <p role="alert" className="break-words text-sm text-red-700">{sync.error.message}</p>}
    {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}
  </section>;
}

function CalendarAutomationPanel() {
  const utils=trpc.useUtils(),status=trpc.googleCalendar.automationStatus.useQuery(undefined,{refetchInterval:15000});
  const save=trpc.googleCalendar.configureAutomation.useMutation({onSuccess:()=>utils.googleCalendar.automationStatus.invalidate()});
  const data=status.data;
  return <div className="space-y-2 rounded-lg border p-3"><h3 className="font-semibold">Automatic Google event sync</h3><p className="text-sm">When enabled, future saved interview changes create, update or cancel a Google event through the managed worker. Existing records are not backfilled. Generic interview reference, time and meeting URL are shared; no attendees or invitations are sent. Google edits block sync for review.</p>
    {data && <><p role="status" className="text-sm">{data.enabled ? "Automatic sync enabled" : "Automatic sync paused"}{data.needsReenable ? " — reconnect or calendar changes require enabling again" : ""}</p>
      {!data.workerEnabled && <p className="text-sm">Enable the managed background worker before enabling calendar automation.</p>}
      {data.emergencyStop && <p className="text-sm">Emergency stop is active; provider writes are stopped.</p>}
      <Button variant="outline" disabled={save.isPending || (!data.enabled && (!data.workerEnabled || data.emergencyStop))} onClick={()=>{if(data.enabled || window.confirm("Enable Google event sync for future saved interview changes? Existing records are not backfilled. No invitations will be sent."))save.mutate({enabled:!data.enabled,expectedRevision:data.revision});}}>{data.enabled ? "Pause automatic calendar sync" : "Enable automatic calendar sync"}</Button>
      <div className="space-y-1 text-xs">{data.jobs.slice(0,10).map(job=><p className="break-words" key={job.id}>Task …{job.id.slice(-6)} · {job.outcome ?? job.status} · Attempts {job.attempts}{job.lastError ? ` · ${job.lastError}` : ""}</p>)}</div></>}
    {[status.error,save.error].filter(Boolean).map((error,i)=><p key={i} role="alert" className="break-words text-sm text-red-700">{error?.message}</p>)}
  </div>;
}
