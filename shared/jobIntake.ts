import {z} from 'zod';
import {formatZonedDateTime,isValidTimezone} from './dateTime';
const skills=z.array(z.string().trim().min(1).max(80)).max(40);
const money=z.number().int().min(0).max(2147483647);
export const jobIntakeFieldsSchema=z.object({
 title:z.string().trim().min(2).max(200),description:z.string().trim().max(16000).optional(),department:z.string().trim().max(120).optional(),
 location:z.string().trim().max(160).optional(),workModel:z.enum(['remote','hybrid','onsite']).optional(),
 compensationMin:money.optional(),compensationMax:money.optional(),currency:z.string().trim().regex(/^[A-Za-z]{3}$/,'Use a three-letter currency code.').transform(v=>v.toUpperCase()).optional(),compensationPeriod:z.enum(['hourly','daily','monthly','annual']).optional(),
 experienceMinYears:z.number().int().min(0).max(40).optional(),experienceMaxYears:z.number().int().min(0).max(40).optional(),
 mustHaveSkills:skills.default([]),niceToHaveSkills:skills.default([]),trainableSkills:skills.default([]),
 scorecard:z.array(z.object({criterion:z.string().trim().min(2).max(160),weight:z.number().int().min(1).max(100),required:z.boolean().default(false)})).max(12).default([]),
 responsibilities:z.array(z.string().trim().min(2).max(600)).max(20).default([]),hiringProcess:z.array(z.string().trim().min(2).max(160)).max(12).default([]),
 headcount:z.number().int().min(1).max(10000).optional(),employmentType:z.enum(['full_time','part_time','contract','temporary','internship']).optional(),
 noticePeriodDays:z.number().int().min(0).max(365).optional(),targetJoiningAt:z.coerce.date().optional(),timezone:z.string().refine(isValidTimezone,'Choose a valid timezone.').optional(),
});
export type JobIntakeFields=z.infer<typeof jobIntakeFieldsSchema>;
export const createJobIntakeSchema=jobIntakeFieldsSchema.extend({companyId:z.string().min(4).max(36),requestKey:z.string().trim().min(8).max(100).optional()});
const key=(s:string)=>s.trim().replace(/\s+/g,' ').toLowerCase();
const unique=(values:string[])=>{const found=new Map<string,string>();for(const value of values)if(!found.has(key(value)))found.set(key(value),value.trim().replace(/\s+/g,' '));return [...found.values()];};
export function normalizeJobIntake(input:JobIntakeFields):JobIntakeFields{
 const f=jobIntakeFieldsSchema.parse(input);
 for(const name of ['description','department','location'] as const)if(!f[name])delete f[name];
 for(const name of ['mustHaveSkills','niceToHaveSkills','trainableSkills','responsibilities','hiringProcess'] as const)f[name]=unique(f[name]);
 if(f.targetJoiningAt)f.targetJoiningAt=new Date(Math.floor(f.targetJoiningAt.getTime()/1000)*1000);
 if(f.compensationMin!==undefined&&f.compensationMax!==undefined&&f.compensationMin>f.compensationMax)throw Error('Minimum compensation cannot be above maximum compensation.');
 if(f.experienceMinYears!==undefined&&f.experienceMaxYears!==undefined&&f.experienceMinYears>f.experienceMaxYears)throw Error('Minimum experience cannot be above maximum experience.');
 if(f.scorecard.length&&f.scorecard.reduce((n,r)=>n+r.weight,0)!==100)throw Error('Weighted scorecard criteria must total 100%.');
 if(new Set(f.scorecard.map(r=>key(r.criterion))).size!==f.scorecard.length)throw Error('Scorecard criteria must be distinct.');
 const seen=new Set<string>();for(const group of [f.mustHaveSkills,f.niceToHaveSkills,f.trainableSkills])for(const skill of group){if(seen.has(key(skill)))throw Error('A skill cannot appear in more than one mandatory, optional or trainable category.');seen.add(key(skill));}
 return f;
}
export type IntakeIssue={code:string;field:string;severity:'blocking'|'advisory';question:string};
export function assessJobIntake(f:JobIntakeFields,now=new Date()){
 const issues:IntakeIssue[]=[];let quality=5;
 const today=formatZonedDateTime(now,isValidTimezone(f.timezone??'UTC')?(f.timezone??'UTC'):'UTC').slice(0,10),targetDate=f.targetJoiningAt?.toISOString().slice(0,10);
 const require=(ok:boolean,points:number,code:string,field:string,question:string)=>{if(ok)quality+=points;else issues.push({code,field,severity:'blocking',question});};
 require(Boolean((f.description?.length??0)>=40||f.responsibilities.length),15,'role_outcomes','description','What responsibilities and measurable outcomes define success in this role?');
 require(f.mustHaveSkills.length>0,20,'must_have_skills','mustHaveSkills','Which skills are essential, and which can be learned after joining?');
 require(Boolean(f.location),10,'location','location','Which work location or permitted remote locations apply?');
 require(Boolean(f.workModel),5,'work_model','workModel','Is this role remote, hybrid or onsite?');
 const range=f.compensationMin!==undefined&&f.compensationMax!==undefined&&f.compensationMin<=f.compensationMax;
 if(range)quality+=10;else issues.push({code:'compensation_range',field:'compensationMin',severity:'blocking',question:'What are the minimum and maximum approved compensation amounts?'});
 require(Boolean(range&&f.currency&&f.compensationPeriod),5,'compensation_units','compensationPeriod','Which currency and pay period apply to those compensation amounts?');
 require(f.experienceMinYears!==undefined&&f.experienceMaxYears!==undefined&&f.experienceMinYears<=f.experienceMaxYears,10,'experience_range','experienceMinYears','What relevant experience range or equivalent evidence is required?');
 const validScorecard=f.scorecard.length>0&&f.scorecard.every(r=>typeof r.criterion==='string'&&Number.isInteger(r.weight)&&r.weight>=1&&r.weight<=100)&&f.scorecard.reduce((sum,r)=>sum+r.weight,0)===100&&new Set(f.scorecard.map(r=>key(r.criterion))).size===f.scorecard.length;
 require(validScorecard,10,'assessment_scorecard','scorecard','Which job-relevant criteria and weights will the hiring panel assess?');
 require(f.headcount!==undefined,5,'headcount','headcount','How many approved openings are being recruited?');
 require(f.hiringProcess.length>0,5,'hiring_process','hiringProcess','What are the interview and decision stages?');
 const categories=[f.mustHaveSkills,f.niceToHaveSkills,f.trainableSkills].map(group=>new Set(group.map(key)));
 if(categories.some((set,index)=>categories.slice(index+1).some(other=>[...set].some(skill=>other.has(skill)))))issues.push({code:'skill_category_conflict',field:'mustHaveSkills',severity:'blocking',question:'Some skills are recorded in conflicting categories. Which are mandatory, optional or trainable?'});
 if(f.compensationMin===0||f.compensationMax===0)issues.push({code:'zero_compensation',field:'compensationMin',severity:'advisory',question:'The recorded compensation includes zero. Clarify whether this is an unpaid role and verify applicable requirements.'});
 if(targetDate&&targetDate<today)issues.push({code:'past_joining_target',field:'targetJoiningAt',severity:'blocking',question:'The joining target has passed. What is the current approved target?'});
 if(targetDate&&f.noticePeriodDays!==undefined&&new Date(targetDate+'T00:00:00Z').getTime()<new Date(today+'T00:00:00Z').getTime()+f.noticePeriodDays*86400000)issues.push({code:'notice_target_conflict',field:'noticePeriodDays',severity:'advisory',question:'The joining target is earlier than the stated notice period. Is there joining-date or notice flexibility?'});
 if(f.mustHaveSkills.length>12)issues.push({code:'long_mandatory_list',field:'mustHaveSkills',severity:'advisory',question:'Which mandatory skills are truly essential versus optional or trainable?'});
 if(!f.employmentType)issues.push({code:'employment_type',field:'employmentType',severity:'advisory',question:'Is the approved engagement full-time, part-time, contract, temporary or an internship?'});
 return {quality:Math.min(100,quality),readyForReview:!issues.some(i=>i.severity==='blocking'),issues,confirmationVerified:false as const};
}
