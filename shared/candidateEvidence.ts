import {z} from 'zod';
export const candidateEvidenceFieldsSchema=z.object({
 skills:z.array(z.string().trim().min(1).max(80)).max(40).default([]),
 totalExperienceYears:z.number().min(0).max(60).optional(),
 workModels:z.array(z.enum(['remote','hybrid','onsite'])).max(3).default([]),
 locations:z.array(z.string().trim().min(2).max(160)).max(12).default([]),
 compensation:z.object({amount:z.number().int().min(0).max(2147483647),currency:z.string().trim().regex(/^[A-Za-z]{3}$/).transform(v=>v.toUpperCase()),period:z.enum(['hourly','daily','monthly','annual'])}).optional(),
 noticePeriodDays:z.number().int().min(0).max(365).optional(),
 availableFrom:z.coerce.date().optional(),
 observedAt:z.coerce.date(),validUntil:z.coerce.date(),sourceNote:z.string().trim().min(8).max(2000),
});
export type CandidateEvidenceFields=z.infer<typeof candidateEvidenceFieldsSchema>;
export const candidateEvidenceSaveSchema=z.object({candidateId:z.string().min(4).max(36),expectedRevision:z.number().int().nonnegative(),expectedFingerprint:z.string().length(64),fields:candidateEvidenceFieldsSchema,reason:z.string().trim().min(8).max(2000)});
export function compareCompensation(job:{compensationMax?:number|null;currency?:string;compensationPeriod?:string;currencyExplicit?:boolean},candidate?:CandidateEvidenceFields['compensation']){
 const unknown=(reason:string)=>({status:'unknown' as const,reason,jobMaximum:null as number|null,candidateExpectation:null as number|null,comparisonPeriod:null as string|null});
 if(job.compensationMax==null||!job.currencyExplicit||!job.currency||!job.compensationPeriod||!candidate)return unknown('Explicit employer maximum and both currencies/pay periods are required.');
 if(job.currency.toUpperCase()!==candidate.currency.toUpperCase())return unknown('Different currencies require verified FX evidence; no exchange rate was assumed.');
 const annual=(p:string)=>p==='monthly'||p==='annual';let maximum=job.compensationMax,expectation=candidate.amount,period=job.compensationPeriod;
 if(annual(period)&&annual(candidate.period)){maximum*=period==='monthly'?12:1;expectation*=candidate.period==='monthly'?12:1;period='annual';}
 else if(period!==candidate.period)return unknown('Hourly/daily comparisons need explicit working-time evidence; no hours or days were assumed.');
 return {status:expectation<=maximum?'within_budget' as const:'above_budget' as const,reason:'Compared explicitly recorded gross amounts in the same currency; monthly amounts multiply by 12 only. Benefits, tax and variable pay are not inferred.',jobMaximum:maximum,candidateExpectation:expectation,comparisonPeriod:period};
}
