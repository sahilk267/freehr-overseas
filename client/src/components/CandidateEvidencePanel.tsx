import {CandidateReviewPanel} from './CandidateReviewPanel';
import {DocumentLifecyclePanel} from './DocumentLifecyclePanel';
import {CandidateJobsPanel} from './CandidateJobsPanel';
import {useEffect,useState,type FormEvent} from 'react';
import {trpc} from '@/lib/trpc';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Label} from '@/components/ui/label';
import {toast} from 'sonner';
const localTime=(d:Date)=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
function EvidenceForm({id}:{id:string}){
 const utils=trpc.useUtils(),q=trpc.recruitment.candidates.evidence.useQuery({id});
 const save=trpc.recruitment.candidates.saveEvidence.useMutation({onSuccess:async r=>{await q.refetch();await utils.recruitment.matching.invalidate();toast.success('Candidate evidence saved as version '+r.revision+'.');}});
 if(!q.data)return <p role={q.error?'alert':undefined}>{q.error?.message??'Loading candidate evidence…'}</p>;
 const d=q.data,f=d.fields;
 const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const data=new FormData(e.currentTarget),text=(name:string)=>String(data.get(name)??'').trim(),number=(name:string)=>text(name)===''?undefined:Number(text(name)),list=(name:string)=>text(name).split('\n').map(s=>s.trim()).filter(Boolean);save.mutate({candidateId:id,expectedRevision:d.revision,expectedFingerprint:d.fingerprint,fields:{skills:list('skills'),locations:list('locations'),workModels:data.getAll('workModels') as ('remote'|'hybrid'|'onsite')[],totalExperienceYears:number('experience'),noticePeriodDays:number('notice'),availableFrom:text('available')?new Date(text('available')):undefined,compensation:number('amount')===undefined?undefined:{amount:number('amount')!,currency:text('currency'),period:text('period') as 'monthly'},observedAt:new Date(text('observed')),validUntil:new Date(text('expires')),sourceNote:text('source')},reason:text('reason')});};
 return <div className="space-y-3"><p className="text-sm">Evidence version {d.revision} · {d.fresh?'Current statement':'Missing or expired statement'}. Recorded/adopted statements are not independently verified; saving does not grant consent.</p>
 <form key={d.revision+':'+d.fingerprint} onSubmit={submit} className="grid gap-3 md:grid-cols-2">
  <div><Label htmlFor={`skills-${id}`}>Explicitly stated skills (one per line)</Label><Textarea id={`skills-${id}`} name="skills" defaultValue={f?.skills.join('\n')??''}/></div>
  <div><Label htmlFor={`locations-${id}`}>Permitted work / relocation locations (one per line)</Label><Textarea id={`locations-${id}`} name="locations" defaultValue={f?.locations.join('\n')??''}/></div>
  <div><Label htmlFor={`experience-${id}`}>Relevant experience in years</Label><Input id={`experience-${id}`} name="experience" type="number" step="0.1" min="0" max="60" defaultValue={f?.totalExperienceYears??''}/></div>
  <fieldset><legend className="text-sm font-medium">Permitted work models</legend><div className="flex flex-wrap gap-3">{(['remote','hybrid','onsite'] as const).map(m=><label key={m} className="flex gap-2 text-sm"><input type="checkbox" name="workModels" value={m} defaultChecked={f?.workModels.includes(m)}/>{m}</label>)}</div></fieldset>
  <div><Label htmlFor={`amount-${id}`}>Expected gross compensation amount</Label><Input id={`amount-${id}`} name="amount" type="number" min="0" max="2147483647" defaultValue={f?.compensation?.amount??''}/></div>
  <div className="grid grid-cols-2 gap-2"><div><Label htmlFor={`currency-${id}`}>Currency code</Label><Input id={`currency-${id}`} name="currency" maxLength={3} defaultValue={f?.compensation?.currency??''}/></div><div><Label htmlFor={`period-${id}`}>Pay period</Label><select id={`period-${id}`} name="period" defaultValue={f?.compensation?.period??''} className="w-full rounded-md border p-2"><option value="">Unknown</option>{['hourly','daily','monthly','annual'].map(v=><option key={v}>{v}</option>)}</select></div></div>
  <div><Label htmlFor={`notice-${id}`}>Notice period in days</Label><Input id={`notice-${id}`} name="notice" type="number" min="0" max="365" defaultValue={f?.noticePeriodDays??''}/></div>
  <div><Label htmlFor={`available-${id}`}>Available from (local time)</Label><Input id={`available-${id}`} name="available" type="datetime-local" defaultValue={f?.availableFrom?localTime(new Date(f.availableFrom)):''}/></div>
  <div><Label htmlFor={`observed-${id}`}>Statement observed at (local time)</Label><Input id={`observed-${id}`} name="observed" required type="datetime-local" defaultValue={localTime(f?new Date(f.observedAt):new Date())}/></div>
  <div><Label htmlFor={`expires-${id}`}>Evidence valid until (local time)</Label><Input id={`expires-${id}`} name="expires" required type="datetime-local" defaultValue={localTime(f?new Date(f.validUntil):new Date(Date.now()+90*86400000))}/></div>
  <div><Label htmlFor={`source-${id}`}>Statement source / reference</Label><Textarea id={`source-${id}`} name="source" required minLength={8} maxLength={2000} defaultValue={f?.sourceNote??''}/></div>
  <div><Label htmlFor={`reason-${id}`}>Reason for this evidence version</Label><Textarea id={`reason-${id}`} name="reason" required minLength={8} maxLength={2000}/></div>
  {save.error&&<p role="alert" className="break-words text-sm text-red-700 md:col-span-2">{save.error.message}</p>}
  <Button disabled={save.isPending||d.suppressed} type="submit" className="md:col-span-2">Save candidate evidence</Button>
 </form></div>;
}
export function CandidateEvidenceWorkspace({candidates}:{candidates:{id:string;name:string}[]}){
 const [id,setId]=useState('');
 const requested=new URLSearchParams(window.location.search).get('review')??'',location=trpc.candidateReviews.locate.useQuery({id:requested||'none'},{enabled:Boolean(requested),retry:false});
 useEffect(()=>{if(location.data)setId(location.data.candidateId);},[location.data]);
 return <section id="candidate-evidence" aria-label="Candidate evidence profile" className="space-y-4 rounded-xl border bg-white p-5"><h2 className="font-semibold">Candidate evidence & compensation units</h2><Label htmlFor="evidence-candidate">Candidate for evidence review</Label><select id="evidence-candidate" value={id} onChange={e=>setId(e.target.value)} className="w-full rounded-md border p-2"><option value="">Choose candidate</option>{id&&!candidates.some(c=>c.id===id)&&<option value={id}>Candidate for selected review</option>}{candidates.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>{location.error&&<p role="alert">{location.error.message}</p>}{id&&<><EvidenceForm key={id} id={id}/><CandidateReviewPanel key={'review-'+id} candidateId={id}/><DocumentLifecyclePanel key={'docs-'+id} candidateId={id}/><CandidateJobsPanel key={'jobs-'+id} candidateId={id}/></>}</section>;
}
