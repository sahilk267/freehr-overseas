import {JobDocumentImport} from './JobDocumentImport';
import {useState,type FormEvent} from 'react';
import type {inferRouterOutputs} from '@trpc/server';
import type {AppRouter} from '../../../server/routers';
import {trpc} from '@/lib/trpc';
import {Button} from '@/components/ui/button';
import {Label} from '@/components/ui/label';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {toast} from 'sonner';
type Extraction=inferRouterOutputs<AppRouter>['recruitment']['jobs']['extractions'][number];
function ExtractionResult({item,jobId}:{item:Extraction;jobId:string}){
 const utils=trpc.useUtils();const [selected,setSelected]=useState<number[]>([]);
 const apply=trpc.recruitment.jobs.applyExtraction.useMutation({onSuccess:async r=>{await utils.recruitment.jobs.intake.invalidate({id:jobId});await utils.recruitment.jobs.list.invalidate();await utils.recruitment.jobs.extractions.invalidate({jobId});toast.success(r.alreadyApplied?'This selection was already applied.':'Reviewed extraction saved as requirement version '+r.revision+'.');}});
 const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const form=new FormData(e.currentTarget);apply.mutate({extractionId:item.extractionId,selectedIndexes:selected,useSourceAsDescription:form.get('sourceDescription')==='on',replaceExisting:form.get('replace')==='on',reason:String(form.get('reason'))});};
 return <div className="space-y-3 rounded-lg border p-3 text-sm">
  <p className="font-medium">{item.sourceLabel} · {item.task.status?.replaceAll('_',' ')}</p>
  <p className="text-xs text-slate-500">Based on requirement version {item.baseRevision||'legacy'}.</p>
  {item.documentName&&<p className="break-words text-xs text-slate-500">Document: {item.documentName}</p>}
  <details><summary className="cursor-pointer">Read original source text</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{item.sourceText}</pre></details>
  {item.task.lastError&&<p role="alert" className="break-words text-red-700">{item.task.lastError}</p>}
  {item.applied?<p role="status">Applied to requirement version {item.applied.revision}. Further edits use the current intake.</p>:item.stale?<p role="status" className="text-amber-800">The intake changed. Review the current draft and request a fresh extraction.</p>:!item.result&&['cancelled','blocked','permanently_failed'].includes(item.task.status)?<p role="status">This extraction stopped. Resolve its error and submit the same source again to requeue this task.</p>:!item.result?<p role="status">Waiting for the existing AI worker. Extraction sends no client message and does not approve this role.</p>:<form onSubmit={submit} className="space-y-3">
   {item.result.staleAtCompletion&&<p role="status" className="text-xs text-amber-800">This result arrived during a different review stage. The current draft matches its original snapshot; review the source carefully before applying.</p>}
   <p className="text-xs text-slate-500">Quoted suggestions need your review. A matching excerpt does not verify the interpretation or client approval. Choose one reviewed selection; later changes use a fresh extraction or manual edit.</p>
   {item.result.facts.map(f=><div key={f.index} className="space-y-1 rounded-md bg-slate-50 p-2"><label className="flex items-start gap-2"><input type="checkbox" className="mt-1" disabled={!f.supported} checked={selected.includes(f.index)} onChange={e=>setSelected(prev=>e.target.checked?[...prev,f.index]:prev.filter(i=>i!==f.index))}/><span className="min-w-0 break-words"><strong>{f.field.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())}</strong>: {f.value}</span></label><blockquote className="whitespace-pre-wrap break-words pl-5 text-xs">“{f.quote}”</blockquote>{!f.supported&&<p className="text-xs text-amber-800">Not selectable: {f.reason}</p>}</div>)}
   {item.result.unresolved.length>0&&<div><p className="font-medium">AI questions to review</p><ul className="list-disc pl-5">{item.result.unresolved.map((q,i)=><li key={i}>{q}</li>)}</ul></div>}
   <label className="flex items-start gap-2"><input type="checkbox" name="sourceDescription" className="mt-1"/><span>Use the original source as the draft job description.</span></label>
   <label className="flex items-start gap-2"><input type="checkbox" name="replace" className="mt-1"/><span>Replace current values for selected fields, including selected skill lists. Unselected fields stay as recorded.</span></label>
   <div><Label htmlFor={`extraction-reason-${item.extractionId}`}>Reason for applying these facts</Label><Textarea id={`extraction-reason-${item.extractionId}`} name="reason" required minLength={8} maxLength={2000}/></div>
   <Button type="submit" size="sm" variant="outline" disabled={apply.isPending}>Apply reviewed extraction</Button>
  </form>}
 </div>;
}
export function JobExtractionPanel({jobId,revision,fingerprint,description,canExtract}:{jobId:string;revision:number;fingerprint:string;description?:string;canExtract:boolean}){
 const utils=trpc.useUtils();const [text,setText]=useState(description??'');const [sourceLabel,setSourceLabel]=useState('Client JD or requirement email');const [documentSource,setDocumentSource]=useState<{documentImportId:string;fileName:string}|null>(null);const list=trpc.recruitment.jobs.extractions.useQuery({jobId},{refetchInterval:15000});
 const request=trpc.recruitment.jobs.extractRequirements.useMutation({onSuccess:async r=>{await utils.recruitment.jobs.extractions.invalidate({jobId});toast.success(r.resumed?'Stopped extraction requeued.':r.alreadyExists?'Existing extraction reused.':'Requirement extraction queued for the AI worker.');}});
 const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const form=new FormData(e.currentTarget);request.mutate({jobId,expectedRevision:revision,expectedFingerprint:fingerprint,sourceText:String(form.get('sourceText')),sourceLabel:String(form.get('sourceLabel')),documentImportId:documentSource?.documentImportId});};
 return <section className="space-y-3 rounded-lg border p-3" aria-label="JD requirement extraction"><h4 className="text-sm font-semibold">Extract requirements from JD or email text</h4><p className="text-xs text-slate-500">Paste the source text. Quoted suggestions go through the existing free-model AI queue and require review before intake changes. Scanned-image OCR and client sign-off are separate.</p>
  <JobDocumentImport jobId={jobId} revision={revision} fingerprint={fingerprint} canImport={canExtract} onUse={doc=>{setText(doc.sourceText);setSourceLabel(doc.fileName.slice(0,120));setDocumentSource({documentImportId:doc.documentImportId,fileName:doc.fileName});}}/>
  {documentSource&&<div className="space-y-2 text-xs"><p className="break-words">Source linked to {documentSource.fileName}. Keep the text as an unchanged complete excerpt.</p><Button type="button" size="sm" variant="outline" className="h-auto max-w-full whitespace-normal text-left" onClick={()=>setDocumentSource(null)}>Clear document link and use manual text</Button></div>}
  {canExtract&&<form onSubmit={submit} className="space-y-3"><div><Label htmlFor={`jd-label-${jobId}`}>Source label</Label><Input id={`jd-label-${jobId}`} name="sourceLabel" required minLength={2} maxLength={120} value={sourceLabel} onChange={e=>setSourceLabel(e.target.value)}/></div><div><Label htmlFor={`jd-text-${jobId}`}>JD / requirement source text</Label><Textarea id={`jd-text-${jobId}`} name="sourceText" required minLength={40} value={text} onChange={e=>setText(e.target.value)} className="min-h-40"/><p className="mt-1 text-xs text-slate-500">{text.trim().length} / 8500 characters. Use a complete excerpt for longer sources; text is not silently truncated.</p></div><Button type="submit" variant="outline" size="sm" disabled={request.isPending||text.trim().length<40||text.trim().length>8500}>Extract source facts</Button></form>}
  {list.error&&<p role="alert">{list.error.message}</p>}{list.data?.map(item=><ExtractionResult key={item.extractionId} item={item} jobId={jobId}/>)}
 </section>;
}
