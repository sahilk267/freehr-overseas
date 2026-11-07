import {candidateReviewActivity} from './candidateReview';
import {weightedScorecardInTransaction} from './weightedScorecard';
import {TRPCError} from '@trpc/server';
import {and,eq} from 'drizzle-orm';
import {consents,jobs,matches} from '../../drizzle/schema';
import {compareCompensation} from '../../shared/candidateEvidence';
import {candidateEvidenceInTransaction} from './candidateEvidence';
import {jobRequirementFingerprint} from './jobIntake';
import {workflowHash} from './workflowStore';

export const MATCH_POLICY='evidence-review-v1';
const norm=(s:string)=>s.trim().replace(/\s+/g,' ').toLowerCase();
export async function buildMatchContext(tx:any,ownerId:number,candidateId:string,jobId:string){
 const job=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,jobId))).limit(1))[0];
 if(!job)throw new TRPCError({code:'NOT_FOUND',message:'Job was not found.'});
 if(['cancelled','filled','archived'].includes(job.pipelineState))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Closed requirements cannot produce new matching work.'});
 const d=await candidateEvidenceInTransaction(tx,ownerId,candidateId);
 if(d.suppressed)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Suppressed candidates are excluded from matching.'});
 const previousMatch=(await tx.select().from(matches).where(and(eq(matches.ownerId,ownerId),eq(matches.candidateId,candidateId),eq(matches.jobId,jobId))).limit(1))[0];
 const grants=await tx.select().from(consents).where(and(eq(consents.ownerId,ownerId),eq(consents.candidateId,candidateId),eq(consents.status,'granted')));
 const processingConsent=grants.some((c:any)=>['platform_processing','recruitment_communication'].includes(c.consentType)&&(!c.jobId||c.jobId===jobId)&&(!c.companyId||c.companyId===job.companyId)&&(!c.expiresAt||new Date(c.expiresAt)>new Date()));
 const reviewActivity=await candidateReviewActivity(tx,ownerId,candidateId,jobId);
 const f=d.fresh?d.fields:null,intake=job.intake as any??{},missing:string[]=[],conflicts:string[]=[];
 if(['submitted','clarification_pending'].includes(reviewActivity?.metadata.status))missing.push('Current candidate questionnaire response or clarification awaits owner evidence review.');
 const closedPair=Boolean(previousMatch&&['closed','withdrawn'].includes(previousMatch.status));if(closedPair)conflicts.push('This candidate-job match is closed or withdrawn; automated rescoring cannot reopen it.');
 const clean=d.documents.filter((x:any)=>x.scanState==='clean'&&x.parseState==='parsed'&&!x.supersededBy&&x.parsedData);
 const parsedSkills=clean.flatMap((x:any)=>Array.isArray(x.parsedData.skills)?x.parsedData.skills.filter((s:any)=>typeof s==='string'):[]);
 const skills:string[]=f?f.skills:[...new Set<string>(parsedSkills)].slice(0,80);
 const experienceValues=[...new Set<number>(clean.map((x:any)=>x.parsedData.totalExperienceYears).filter((n:any)=>typeof n==='number'&&n>=0&&n<=60))];
 const experience=f?.totalExperienceYears??(experienceValues.length===1?experienceValues[0]:null);
 if(experienceValues.length>1||(f?.totalExperienceYears!==undefined&&experienceValues.some(n=>n!==f.totalExperienceYears)))conflicts.push('Experience statements differ across current profile and parsed documents; clarify the chronology.');
 if(!processingConsent)missing.push('Valid platform-processing or recruitment-communication consent is required before AI processing.');
 if(!d.fields||!d.fresh)missing.push('Current owner-recorded candidate statement is missing or expired.');
 if(d.documentsTruncated)missing.push('More than 20 candidate documents exist; this bounded context needs full evidence review.');
 const must=Array.isArray(job.mustHaveSkills)?job.mustHaveSkills.filter((s:any)=>typeof s==='string'):[];
 const skillSet=new Set(skills.map(norm)),matched=must.filter((s:string)=>skillSet.has(norm(s))),missingSkills=must.filter((s:string)=>!skillSet.has(norm(s)));
 if(!must.length)missing.push('Job mandatory skills are not recorded.');
 if(missingSkills.length)missing.push('Mandatory skill evidence is missing: '+missingSkills.join(', '));
 if(experience===null)missing.push('Relevant experience evidence is missing or conflicting.');
 if(typeof job.experienceMinYears!=='number')missing.push('Employer minimum relevant experience is not explicit.');
 if(experience!==null&&typeof job.experienceMinYears==='number'&&experience<job.experienceMinYears)conflicts.push('Recorded experience is below the stated minimum; review equivalent experience rather than reject automatically.');
 const compensation=compareCompensation({...job,compensationPeriod:intake.compensationPeriod,currencyExplicit:intake.currencyExplicit},f?.compensation);
 const hasBudget=job.compensationMin!==null&&job.compensationMin!==undefined||job.compensationMax!==null&&job.compensationMax!==undefined;
 if(hasBudget&&compensation.status==='unknown')missing.push('Compensation compatibility is unverified: '+compensation.reason);
 if(compensation.status==='above_budget')conflicts.push('Recorded compensation expectation exceeds the employer maximum; clarify budget flexibility.');
 if(!job.workModel||!f?.workModels.length)missing.push('Employer/candidate work model evidence is incomplete.');
 else if(!f.workModels.includes(job.workModel))conflicts.push('Recorded work-model preference differs from this requirement.');
 if(job.workModel!=='remote'){
  if(!job.location||!f?.locations.length)missing.push('Permitted work/relocation location evidence is incomplete.');
  else if(!f.locations.some(l=>norm(l)===norm(job.location)))conflicts.push('Recorded permitted locations differ; relocation flexibility needs clarification.');
 }
 if(job.targetJoiningAt){if(!f?.availableFrom)missing.push('Explicit candidate availability date is required for joining-target compatibility.');else if(new Date(f.availableFrom)>new Date(job.targetJoiningAt))conflicts.push('Candidate availability is later than the joining target.');}
 if(intake.noticePeriodDays!==null&&intake.noticePeriodDays!==undefined){if(f?.noticePeriodDays===undefined)missing.push('Candidate notice period has not been recorded.');else if(f.noticePeriodDays>intake.noticePeriodDays)conflicts.push('Candidate notice exceeds the employer target; review flexibility.');}
 // This priority is a retrieval aid, never a scorecard, eligibility decision or disposition.
 const components={skillEvidence:must.length?Math.round(70*matched.length/must.length):0,minimumExperience:experience!==null&&typeof job.experienceMinYears==='number'&&experience>=job.experienceMinYears?20:0,compensation:compensation.status==='within_budget'?10:0};
 const priority=d.fresh?Object.values(components).reduce((a,b)=>a+b,0):Math.min(50,Object.values(components).reduce((a,b)=>a+b,0));
 const employerScorecard=await weightedScorecardInTransaction(tx,ownerId,job,d);
 const scoringMissing=[...missing,...conflicts,...(employerScorecard.criteria.length&&(!employerScorecard.current||employerScorecard.result?.unknownWeight)?['Employer-weighted scorecard has unknown or stale source ratings.']:[]),...(employerScorecard.result?.reviewRequired?.length?['Required scorecard criteria need owner review; no automatic rejection is authorized.']:[])];
 const fingerprint=workflowHash({candidate:d.fingerprint,processingConsent,...(reviewActivity?{reviewActivity:reviewActivity.revision}:{}),...(employerScorecard.signature?{scorecard:employerScorecard.signature}:{})});
 return {job,candidate:d.candidate,evidence:d,processingConsent,canQueueAi:processingConsent&&!closedPair,candidateFingerprint:fingerprint,requirementFingerprint:jobRequirementFingerprint(job),policy:MATCH_POLICY,employerScorecard,
  assessment:{eligibility:conflicts.length?'conflict_review' as const:missing.length?'needs_evidence' as const:'review_ready' as const,reviewPriority:priority,components,matchedSkills:matched,missingSkills,missingEvidence:missing,conflicts,compensation,finalDisposition:false as const},
  payload:{candidateId,jobId,requirementFingerprint:jobRequirementFingerprint(job),candidateContextFingerprint:fingerprint,policy:MATCH_POLICY,
   compensationComparison:{...compensation,allowed:compensation.status!=='unknown'},employerScorecard:employerScorecard.current?{revision:employerScorecard.revision,...employerScorecard.result,independentlyVerified:false}:{status:'unassessed_or_stale'},requiredMissingEvidence:scoringMissing.map(s=>s.slice(0,500)),
   candidate:{headline:d.candidate.headline,location:d.candidate.location,availability:d.candidate.availability,recordedStatement:f,statementSource:d.source+'; not independently verified',skills,experienceYears:experience,evidence:clean.slice(0,3).map((x:any)=>({documentId:x.documentId,sha256:x.sha256,parsedData:x.parsedData})),documentsTruncated:d.documentsTruncated||clean.length>3},
   job:{title:job.title,description:intake.description,location:job.location,mustHaveSkills:must,niceToHaveSkills:job.niceToHaveSkills,scorecard:job.scorecard,experienceMinYears:job.experienceMinYears,experienceMaxYears:job.experienceMaxYears,compensationMin:job.compensationMin,compensationMax:job.compensationMax,currency:job.currency,currencyRecorded:Boolean(intake.currencyExplicit),compensationPeriod:intake.compensationPeriod??null,trainableSkills:intake.trainableSkills??[],responsibilities:intake.responsibilities??[],workModel:job.workModel}},
 };
}
