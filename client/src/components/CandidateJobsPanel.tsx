import {useState} from 'react';
import {trpc} from '@/lib/trpc';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {toast} from 'sonner';
export function CandidateJobsPanel({candidateId}:{candidateId:string}){
 const [open,setOpen]=useState(false),[offset,setOffset]=useState(0),[query,setQuery]=useState(''),[filter,setFilter]=useState(''),[selected,setSelected]=useState<string[]>([]);
 const input={candidateId,offset,limit:50,query:filter||undefined},q=trpc.recruitment.matching.candidateJobs.useQuery(input,{enabled:open});
 const act=trpc.recruitment.matching.actOnCandidateJobs.useMutation({onSuccess:r=>toast.success(r.queued.length?'Selected job scores queued through the shared worker.':'Candidate job-ranking snapshot saved.')});
 return <section aria-label="Candidate multi-job ranking" className="space-y-3 rounded-lg border p-3 text-sm"><h3 className="font-semibold">Rank jobs for this candidate</h3><p className="text-xs text-slate-500">All matching open owned requirements are ranked before display pagination, up to 500 requirements. Closed roles are excluded. Retrieval priority does not authorize sourcing, sharing or final hiring decisions.</p>
 <Button type="button" size="sm" variant="outline" onClick={()=>{setOpen(true);setSelected([]);if(open)q.refetch();}}>Refresh candidate job ranking</Button>
 {open&&<><form onSubmit={e=>{e.preventDefault();setFilter(query.trim());setOffset(0);setSelected([]);}} className="flex flex-wrap gap-2"><Input className="min-w-0 flex-1" aria-label="Filter ranked jobs by title" value={query} onChange={e=>setQuery(e.target.value)}/><Button size="sm" type="submit" variant="outline">Filter ranked jobs</Button></form>
 {q.isFetching&&<p role="status">Evaluating current requirements…</p>}{q.error&&<p role="alert">{q.error.message}</p>}
 {q.data&&<><p className="text-xs">All {q.data.coverage.scanned} matching open requirements inspected. Display offset {offset}.</p>{q.data.rows.map((r,index)=><article key={r.jobId} className="space-y-2 rounded-md bg-slate-50 p-3"><label className="flex items-start gap-2"><input type="checkbox" aria-label={'Select job '+r.title} disabled={!r.canQueueAi} checked={selected.includes(r.jobId)} onChange={e=>setSelected(prev=>e.target.checked?[...prev,r.jobId]:prev.filter(id=>id!==r.jobId))}/><span className="min-w-0 break-words"><strong>{offset+index+1}. {r.title}</strong> · {r.reviewPriority}/100 · {r.eligibility.replaceAll('_',' ')}</span></label><ul className="list-disc break-words pl-5 text-xs">{[...r.missingEvidence,...r.conflicts].map((s,i)=><li key={i}>{s}</li>)}</ul></article>)}
 {!q.data.rows.length&&<p>No matching open requirements.</p>}
 <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={act.isPending||q.isFetching} onClick={()=>act.mutate({...input,expectedPreviewHash:q.data!.previewHash,jobIds:[],queueAi:false})}>Save job-ranking snapshot</Button><Button type="button" size="sm" className="h-auto whitespace-normal" disabled={!selected.length||selected.length>20||act.isPending||q.isFetching} onClick={()=>act.mutate({...input,expectedPreviewHash:q.data!.previewHash,jobIds:selected,queueAi:true})}>Queue selected job scores ({selected.length}/20)</Button><Button type="button" size="sm" variant="outline" disabled={!offset} onClick={()=>{setOffset(Math.max(0,offset-50));setSelected([]);}}>Previous job page</Button><Button type="button" size="sm" variant="outline" disabled={!q.data.coverage.hasMore} onClick={()=>{setOffset(q.data!.coverage.nextOffset!);setSelected([]);}}>Next job page</Button></div></>}
 {act.error&&<p role="alert" className="break-words text-red-700">{act.error.message}</p>}</>}
 </section>;
}
