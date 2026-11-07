import type {FormEvent} from 'react';
import {trpc} from '@/lib/trpc';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {toast} from 'sonner';
const localTime=(d:Date)=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
export function RankingRefreshPanel({jobId}:{jobId:string}){
 const q=trpc.recruitment.matching.refreshPlan.useQuery({jobId},{refetchInterval:15000});
 const save=trpc.recruitment.matching.configureRefresh.useMutation({onSuccess:async()=>{await q.refetch();toast.success('Ranking refresh authority saved.');}});
 if(!q.data)return <p role={q.error?'alert':undefined}>{q.error?.message??'Loading refresh authority…'}</p>;
 const d=q.data,s=d.settings;
 const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);save.mutate({jobId,expectedRevision:d.revision,enabled:f.get('enabled')==='on',query:String(f.get('query')).trim(),intervalMinutes:Number(f.get('interval')),maxRuns:Number(f.get('runs')),expiresAt:new Date(String(f.get('expires'))),queueAi:f.get('ai')==='on',maxPerRun:Number(f.get('perRun')),maxAiTasks:Number(f.get('budget')),minPriority:Number(f.get('priority'))});};
 return <section aria-label="Automatic ranking refresh" className="space-y-3 rounded-lg border p-3 text-sm"><h5 className="font-semibold">Automatic ranking refresh</h5><p className="text-xs text-slate-500">Uses the existing background worker. Authority is limited to this exact requirement version/state, filter, expiry and budgets. It saves global review snapshots. Optional AI scoring only considers current, consented, review-ready profiles. It does not contact candidates or change hiring decisions.</p>
 <p role="status">Plan revision {d.revision} · {d.effectiveEnabled?'Authority active':'Inactive'} · {d.runs.length} runs · {d.newAiTasks} new AI tasks.</p>
 {d.sourceChanged&&<p className="text-amber-800">Requirements changed. Review and authorize a new plan.</p>}{d.stopReason&&<p className="break-words">Stopped: {d.stopReason}</p>}{d.task&&<p className="break-words text-xs">Worker task: {d.task.status} · {new Date(d.task.scheduledAt).toLocaleString()}{d.task.lastError?' · '+d.task.lastError:''}</p>}
 <details><summary className="cursor-pointer">Configure owner refresh authority</summary><form key={d.revision} onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2">
  <label className="flex gap-2"><input type="checkbox" name="enabled" defaultChecked={s?.enabled??false}/>Enable bounded automatic refresh</label><label className="flex gap-2"><input type="checkbox" name="ai" defaultChecked={s?.queueAi??false}/>Allow bounded AI scoring</label>
  <div className="sm:col-span-2"><Label htmlFor={`refresh-filter-${jobId}`}>Candidate name filter (blank means all owned profiles)</Label><Input id={`refresh-filter-${jobId}`} name="query" maxLength={120} defaultValue={s?.query??''}/></div>
  <div><Label htmlFor={`refresh-interval-${jobId}`}>Refresh interval in minutes</Label><Input id={`refresh-interval-${jobId}`} name="interval" type="number" min={15} max={1440} required defaultValue={s?.intervalMinutes??60}/></div>
  <div><Label htmlFor={`refresh-runs-${jobId}`}>Maximum refresh runs</Label><Input id={`refresh-runs-${jobId}`} name="runs" type="number" min={1} max={100} required defaultValue={s?.maxRuns??10}/></div>
  <div className="sm:col-span-2"><Label htmlFor={`refresh-expiry-${jobId}`}>Authority expires at (local time, within 30 days)</Label><Input id={`refresh-expiry-${jobId}`} name="expires" type="datetime-local" required defaultValue={localTime(s?new Date(s.expiresAt):new Date(Date.now()+7*86400000))}/></div>
  <div><Label htmlFor={`refresh-per-run-${jobId}`}>Maximum selected AI tasks per run</Label><Input id={`refresh-per-run-${jobId}`} name="perRun" type="number" min={1} max={10} required defaultValue={s?.maxPerRun??3}/></div>
  <div><Label htmlFor={`refresh-budget-${jobId}`}>Total new AI-task budget</Label><Input id={`refresh-budget-${jobId}`} name="budget" type="number" min={0} max={100} required defaultValue={s?.maxAiTasks??0}/></div>
  <div><Label htmlFor={`refresh-priority-${jobId}`}>Minimum review priority for AI</Label><Input id={`refresh-priority-${jobId}`} name="priority" type="number" min={0} max={100} required defaultValue={s?.minPriority??80}/></div>
  <Button type="submit" className="h-auto whitespace-normal" disabled={save.isPending}>Save refresh plan</Button>
 </form></details>
 {s&&<Button type="button" size="sm" variant="outline" disabled={save.isPending||!s.enabled} onClick={()=>save.mutate({...s,jobId,expectedRevision:d.revision,enabled:false,expiresAt:new Date(s.expiresAt)})}>Stop refresh plan</Button>}
 {save.error&&<p role="alert" className="break-words text-red-700">{save.error.message}</p>}
 {d.history.length>0&&<details><summary>Recorded refresh runs</summary><ul className="space-y-1 text-xs">{d.history.map(r=><li key={r.planRevision+':'+r.cycle}>Plan {r.planRevision} · Run {r.cycle} · {r.scanned} profiles inspected · {r.newAiTasks} new AI tasks</li>)}</ul></details>}
 </section>;
}
