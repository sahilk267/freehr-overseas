import {JobExtractionPanel} from "./JobExtractionPanel";
import {useState,type FormEvent} from 'react';
import {trpc} from '@/lib/trpc';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Textarea} from '@/components/ui/textarea';
import {toast} from 'sonner';
import type {JobIntakeFields} from '@shared/jobIntake';

export function readJobIntakeForm(form:FormData):JobIntakeFields{
 const text=(name:string)=>String(form.get(name)||'').trim()||undefined;
 const number=(name:string)=>text(name)===undefined?undefined:Number(text(name));
 const lines=(name:string)=>String(form.get(name)||'').split('\n').map(v=>v.trim()).filter(Boolean);
 const skills=(name:string)=>String(form.get(name)||'').split(',').map(v=>v.trim()).filter(Boolean);
 const scorecard=lines('scorecard').map(line=>{const parts=line.split('|').map(v=>v.trim());if(parts.length<2||parts.length>3||!parts[0]||!parts[1]||!Number.isFinite(Number(parts[1]))||parts[2]&&!['required','optional'].includes(parts[2].toLowerCase()))throw Error('Use criterion | weight | required or optional for each scorecard row.');return {criterion:parts[0],weight:Number(parts[1]),required:parts[2]?.toLowerCase()==='required'};});
 return {title:text('title')||'',description:text('description'),department:text('department'),location:text('location'),workModel:text('workModel') as JobIntakeFields['workModel'],compensationMin:number('compensationMin'),compensationMax:number('compensationMax'),currency:text('currency'),compensationPeriod:text('compensationPeriod') as JobIntakeFields['compensationPeriod'],experienceMinYears:number('experienceMinYears'),experienceMaxYears:number('experienceMaxYears'),mustHaveSkills:skills('mustHaveSkills'),niceToHaveSkills:skills('niceToHaveSkills'),trainableSkills:skills('trainableSkills'),scorecard,responsibilities:lines('responsibilities'),hiringProcess:lines('hiringProcess'),headcount:number('headcount'),employmentType:text('employmentType') as JobIntakeFields['employmentType'],noticePeriodDays:number('noticePeriodDays'),targetJoiningAt:text('targetJoiningAt')?new Date(text('targetJoiningAt')+'T00:00:00Z'):undefined,timezone:text('timezone')};
}
export function JobIntakeFieldsForm({prefix,fields}:{prefix:string;fields?:Omit<Partial<JobIntakeFields>,'targetJoiningAt'>&{targetJoiningAt?:Date|string}}){
 const f=fields;
 const input=(name:keyof JobIntakeFields,label:string,type='text',extra:Record<string,any>={})=><div><Label htmlFor={`${prefix}-${name}`}>{label}</Label><Input id={`${prefix}-${name}`} name={name} type={type} defaultValue={f?.[name] as string|number|undefined} {...extra}/></div>;
 const select=(name:keyof JobIntakeFields,label:string,options:string[])=><div><Label htmlFor={`${prefix}-${name}`}>{label}</Label><select id={`${prefix}-${name}`} name={name} defaultValue={f?.[name] as string??''} className="h-10 w-full rounded-md border px-3 text-sm"><option value="">Not recorded</option>{options.map(o=><option key={o} value={o}>{o.replaceAll('_',' ')}</option>)}</select></div>;
 const area=(name:'description'|'responsibilities'|'hiringProcess',label:string)=><div className="md:col-span-2"><Label htmlFor={`${prefix}-${name}`}>{label}</Label><Textarea id={`${prefix}-${name}`} name={name} defaultValue={Array.isArray(f?.[name])?(f[name] as string[]).join('\n'):f?.[name] as string|undefined}/></div>;
 const skill=(name:'mustHaveSkills'|'niceToHaveSkills'|'trainableSkills',label:string)=><div className="md:col-span-2"><Label htmlFor={`${prefix}-${name}`}>{label}</Label><Input id={`${prefix}-${name}`} name={name} defaultValue={f?.[name]?.join(', ')} placeholder="Separate skills with commas"/></div>;
 return <>
  {input('title','Role title','text',{required:true,maxLength:200})}{input('department','Department')}
  {area('description','Job description / client requirement text')}{area('responsibilities','Responsibilities and outcomes (one per line)')}
  {input('location','Work location / allowed remote locations')}{select('workModel','Work model',['remote','hybrid','onsite'])}
  {input('compensationMin','Minimum compensation','number',{min:0,max:2147483647})}{input('compensationMax','Maximum compensation','number',{min:0,max:2147483647})}
  {input('currency','Compensation currency (three-letter code)','text',{maxLength:3,placeholder:'e.g. INR, USD, AED'})}{select('compensationPeriod','Compensation pay period',['hourly','daily','monthly','annual'])}
  {input('experienceMinYears','Minimum relevant experience (years)','number',{min:0,max:40})}{input('experienceMaxYears','Maximum relevant experience (years)','number',{min:0,max:40})}
  {skill('mustHaveSkills','Must-have skills')}{skill('niceToHaveSkills','Optional skills')}{skill('trainableSkills','Trainable skills')}
  <div className="md:col-span-2"><Label htmlFor={`${prefix}-scorecard`}>Weighted scorecard (criterion | weight | required or optional)</Label><Textarea id={`${prefix}-scorecard`} name="scorecard" defaultValue={f?.scorecard?.map(r=>`${r.criterion} | ${r.weight} | ${r.required?'required':'optional'}`).join('\n')} placeholder={'Technical evidence | 70 | required\nRelevant delivery | 30 | optional'}/></div>
  {input('headcount','Approved openings','number',{min:1,max:10000})}{select('employmentType','Employment type',['full_time','part_time','contract','temporary','internship'])}
  {input('noticePeriodDays','Maximum expected notice (days)','number',{min:0,max:365})}
  <div><Label htmlFor={`${prefix}-targetJoiningAt`}>Target joining date</Label><Input id={`${prefix}-targetJoiningAt`} name="targetJoiningAt" type="date" defaultValue={f?.targetJoiningAt?new Date(f.targetJoiningAt).toISOString().slice(0,10):''}/></div>
  {input('timezone','Hiring timezone','text',{placeholder:'e.g. Asia/Kolkata'})}{area('hiringProcess','Interview and decision stages (one per line)')}
 </>;
}
export function JobIntakePanel({jobId}:{jobId:string}){
 const utils=trpc.useUtils(),query=trpc.recruitment.jobs.intake.useQuery({id:jobId});
 const [historyRevision,setHistoryRevision]=useState(0);
 const history=trpc.recruitment.jobs.intakeVersion.useQuery({id:jobId,revision:historyRevision},{enabled:historyRevision>0});
 const move=trpc.recruitment.jobs.transition.useMutation({onSuccess:async()=>{await utils.recruitment.jobs.intake.invalidate({id:jobId});await utils.recruitment.jobs.list.invalidate();toast.success('Requirement review stage updated.');}});
 const save=trpc.recruitment.jobs.updateIntake.useMutation({onSuccess:async result=>{await utils.recruitment.jobs.intake.invalidate({id:jobId});await utils.recruitment.jobs.list.invalidate();toast.success(result.unchanged?'Requirements unchanged; review recorded.':'Requirement version saved.');}});
 if(query.isLoading)return <p className="text-sm">Loading requirement history…</p>;
 if(query.error)return <p role="alert">{query.error.message}</p>;
 const d=query.data;if(!d)return null;
 const submit=async(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const form=new FormData(e.currentTarget);try{await save.mutateAsync({jobId,expectedRevision:d.revision,expectedFingerprint:d.editFingerprint,fields:readJobIntakeForm(form),reason:String(form.get('reason'))});}catch(error){if(error instanceof Error&&!('data' in error))toast.error(error.message);}};
 return <section className="mt-4 space-y-3 rounded-lg border p-4" aria-label="Requirement version and clarification">
  <p className="text-sm font-semibold">Requirement version {d.revision||'legacy'} · {d.assessment.quality}% recorded completeness</p>
  <p className="text-xs text-slate-500">This measures recorded fields. Client approval and the accuracy of the source require separate evidence.</p>
  {!d.integrity&&<p role="alert" className="text-sm text-amber-800">Fields changed outside the recorded version. Review the current draft and save a fresh version.</p>}
  {d.assessment.issues.length>0&&<div><h4 className="text-sm font-semibold">Clarification checklist</h4><ul className="list-disc space-y-1 pl-5 text-sm">{d.assessment.issues.map(i=><li key={i.code}>{i.question}{i.severity==='advisory'?' (review)':''}</li>)}</ul></div>}
  {['client_confirmation','needs_information'].includes(d.pipelineState)&&<Button type="button" size="sm" variant="outline" disabled={move.isPending} onClick={()=>move.mutate({id:jobId,state:d.pipelineState==='client_confirmation'?'needs_information':'draft',expectedRevision:d.revision,expectedFingerprint:d.editFingerprint})}>{d.pipelineState==='client_confirmation'?'Move to clarification':'Return to draft review'}</Button>}
  {d.pipelineState==='draft'?<form key={`${d.revision}:${d.editFingerprint}`} onSubmit={submit} className="grid min-w-0 gap-3 md:grid-cols-2"><JobIntakeFieldsForm prefix={`job-${jobId}`} fields={d.fields}/><div className="md:col-span-2"><Label htmlFor={`job-reason-${jobId}`}>Reason for this requirement version</Label><Textarea id={`job-reason-${jobId}`} name="reason" required minLength={8} maxLength={2000}/></div><Button type="submit" className="justify-self-start" disabled={save.isPending}>Save draft requirements</Button></form>:<p className="text-sm">This role has left draft. Active requirement amendments require a separate review.</p>}
  <JobExtractionPanel jobId={jobId} revision={d.revision} fingerprint={d.editFingerprint} description={d.fields.description} canExtract={d.pipelineState==='draft'&&d.integrity}/>
  <div><Label htmlFor={`job-history-${jobId}`}>Saved requirement history</Label><select id={`job-history-${jobId}`} value={historyRevision||''} onChange={e=>setHistoryRevision(Number(e.target.value))} className="mt-1 w-full rounded-md border p-2 text-sm"><option value="">Choose a version to read</option>{d.history.map(h=><option key={h.revision} value={h.revision}>Version {h.revision}: {h.reason}</option>)}</select>{history.data&&<pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-xs">{JSON.stringify(history.data.fields,null,2)}</pre>}{history.error&&<p role="alert">{history.error.message}</p>}</div>
  <Button type="button" size="sm" variant="outline" onClick={()=>query.refetch()}>Reload requirement version</Button>
 </section>;
}
