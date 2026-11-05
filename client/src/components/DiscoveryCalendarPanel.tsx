import {useState} from "react";
import {trpc} from "@/lib/trpc";
import {Button} from "@/components/ui/button";
import {toast} from "sonner";
export function DiscoveryCalendarPanel({meetingId}:{meetingId:string}){
 const utils=trpc.useUtils(),status=trpc.clientDiscovery.calendarStatus.useQuery({meetingId},{refetchInterval:15000});
 const preview=trpc.clientDiscovery.calendarPreview.useQuery({meetingId},{enabled:false,retry:false});
 const review=trpc.clientDiscovery.reviewCalendarConflict.useQuery({meetingId},{enabled:false,retry:false});
 const [message,setMessage]=useState("");
 const configure=trpc.clientDiscovery.configureCalendar.useMutation({onSuccess:async r=>{await utils.clientDiscovery.calendarStatus.invalidate({meetingId});toast.success(r.enabled?"Google sync enabled for this meeting.":"Future Google sync paused.");}});
 const sync=trpc.clientDiscovery.syncCalendar.useMutation({onSuccess:async()=>{setMessage("Reviewed Google sync completed. No guest invitations sent.");await utils.clientDiscovery.calendarStatus.invalidate({meetingId});await preview.refetch();}});
 const busy=configure.isPending||sync.isPending;
 return <section className="space-y-2 rounded-lg border p-3"><h4 className="font-medium">Discovery Google Calendar</h4><p className="text-xs text-slate-500">One private calendar event mirrors this tentative meeting and its cancellation. Sync does not confirm attendance or invite guests.</p>
  {status.data&&<><p className="text-xs">{status.data.enabled?"Automatic sync enabled for this meeting.":status.data.needsReenable?"Calendar changed; review and authorize sync again.":"Automatic sync is off for this meeting."}</p>{!status.data.workerEnabled&&<p className="text-xs">Enable the managed worker for automatic sync.</p>}{status.data.enabled&&<Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>configure.mutate({meetingId,enabled:false,expectedRevision:status.data!.revision})}>Pause discovery sync</Button>}</>}
  <Button type="button" size="sm" variant="outline" disabled={preview.isFetching} onClick={()=>preview.refetch()}>Review Google event</Button>
  {preview.error&&<p role="alert" className="break-words text-xs text-red-700">{preview.error.message}</p>}
  {preview.data&&<div className="space-y-2 text-xs"><p>{preview.data.event.summary}</p><p className="break-all">Calendar: {preview.data.calendarId}</p><p>{new Date(preview.data.event.start.dateTime).toLocaleString()} · {preview.data.event.status}</p><p>Times shown in your browser’s local timezone.</p>
   {!status.data?.enabled&&status.data&&<Button type="button" className="h-auto w-full whitespace-normal" size="sm" disabled={busy} onClick={()=>configure.mutate({meetingId,enabled:true,expectedRevision:status.data!.revision,previewHash:preview.data!.previewHash})}>Enable Google sync for this meeting</Button>}
   <Button type="button" className="h-auto w-full whitespace-normal" size="sm" variant="outline" disabled={busy} onClick={()=>sync.mutate({meetingId,previewHash:preview.data!.previewHash})}>Sync reviewed Google event</Button>
  </div>}
  <Button type="button" className="h-auto w-full whitespace-normal" size="sm" variant="outline" disabled={review.isFetching} onClick={()=>review.refetch()}>Review external calendar changes</Button>
  {review.error&&<p role="alert" className="break-words text-xs text-red-700">{review.error.message}</p>}
  {review.data&&<div className="space-y-2 text-xs"><p>External event: {review.data.remote.summary} · {review.data.remote.status}</p><p className="break-all">{review.data.remote.start} – {review.data.remote.end}</p><p>Visibility: {review.data.remote.visibility||"unknown"} · Guests: {review.data.remote.attendeeCount??"unknown"} · Calendar reminders: {review.data.remote.remindersEnabled?"on":"off"}</p><p>Applying the saved meeting replaces these externally edited fields. Review the change before continuing.</p><Button type="button" className="h-auto w-full whitespace-normal" size="sm" disabled={busy} onClick={()=>sync.mutate({meetingId,previewHash:review.data!.previewHash,approvedExternalReviewHash:review.data!.approvedExternalReviewHash})}>Apply reviewed discovery event</Button></div>}
  {message&&<p role="status" className="text-xs">{message}</p>}{status.error&&<p role="alert" className="text-xs">{status.error.message}</p>}
  {status.data?.jobs.length? <div className="space-y-1 text-xs"><p>Recent managed sync tasks</p>{status.data.jobs.slice(0,5).map(j=><p key={j.id} className="break-words">{j.status.replaceAll("_"," ")}{j.outcome?` · ${j.outcome}`:""}{j.lastError?` · ${j.lastError}`:""}</p>)}</div>:null}
 </section>;
}
