import {careerEvidenceInTransaction,careerClarificationQuestions} from './careerEvidence';
import {invalidateCandidateMatches} from './candidateEvidenceLifecycle';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {TRPCError} from '@trpc/server';
import {and,desc,eq} from 'drizzle-orm';
import {consents,jobs,screenings,workflowEvents} from '../../drizzle/schema';
import {candidateReviewFields,candidateReviewResponseSchema} from '../../shared/candidateReview';
import {candidateEvidenceFieldsSchema} from '../../shared/candidateEvidence';
import {createId,recordAudit,requireDb} from '../db';
import {ensureSafeAiText} from '../workflow';
import {withWorkspaceTransaction} from './database';
import {candidateEvidenceInTransaction,saveCandidateEvidenceInTransaction} from './candidateEvidence';
import {jobRequirementFingerprint} from './jobIntake';
import {appendWorkflowEvent,workflowHash} from './workflowStore';
import {availabilityTokenHash} from './availabilityMailScope';
import {reviewDenied as denied,reviewEvent as event,reviewRequest as request,reviewScope as scope} from './candidateReviewState';
import {scheduleCandidateReviewDeadline,stopCandidateReviewWork,resolveCandidateReviewIncidents} from './candidateReviewLifecycle';
export async function candidateReviewOwnerRecords(tx:any,ownerId:number,id:string){const r=await request(tx,ownerId,id);return {request:r,response:await event(tx,ownerId,'candidate.review_responded',id),supersededBy:(await event(tx,ownerId,'candidate.review_clarified',id))?.metadata.childId??null};}
export async function candidateReviewActivity(tx:any,ownerId:number,candidateId:string,jobId:string){return event(tx,ownerId,'candidate.review_activity',workflowHash([candidateId,jobId]));}
export async function recordCandidateReviewActivity(tx:any,ownerId:number,candidateId:string,jobId:string,metadata:Record<string,unknown>){const id=workflowHash([candidateId,jobId]),prior=await candidateReviewActivity(tx,ownerId,candidateId,jobId);await appendWorkflowEvent(tx,ownerId,'candidate.review_activity',id,(prior?.revision??0)+1,{candidateId,jobId,...metadata});}
export async function createCandidateReview(ownerId:number,actorId:number,input:{candidateId:string;jobId:string;requestKey:string;expiresHours:number}){
 return withWorkspaceTransaction(ownerId,tx=>createCandidateReviewInTransaction(tx,ownerId,actorId,input));
}
export async function createCandidateReviewInTransaction(tx:any,ownerId:number,actorId:number,input:{candidateId:string;jobId:string;requestKey:string;expiresHours:number},clarification?:{parentId:string;responseRevision:number;responseHash:string;questions:{id:string;prompt:string}[];depth:number}){
 if(!Number.isInteger(input.expiresHours)||input.expiresHours<1||input.expiresHours>168)throw new TRPCError({code:'BAD_REQUEST',message:'Review lifetime must be 1–168 hours.'});
 const run=async()=>{
  const d=await candidateEvidenceInTransaction(tx,ownerId,input.candidateId),j=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,input.jobId))).limit(1))[0];
  if(!j)throw new TRPCError({code:'NOT_FOUND',message:'Requirement was not found.'});
  if(d.suppressed||['cancelled','filled','archived','paused'].includes(j.pipelineState))throw new TRPCError({code:'PRECONDITION_FAILED',message:'A current candidate and open owned role are required.'});
  const key=workflowHash([ownerId,input.requestKey]),requestHash=workflowHash({...input,...(clarification?{clarification}:{}),candidateFingerprint:d.fingerprint,requirementFingerprint:jobRequirementFingerprint(j)}),prior=await event(tx,ownerId,'candidate.review_identity',key);
  if(prior){if(prior.metadata.requestHash!==requestHash)throw new TRPCError({code:'CONFLICT',message:'Review request identity belongs to another evidence snapshot.'});return {id:prior.metadata.inviteId as string,alreadyExists:true,fragment:null};}
  if(!clarification){
   const requests=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'candidate.review_invited')));
   for(const existing of requests){
    const m=existing.metadata;
    if(m.candidateId!==d.candidateId||m.jobId!==j.id||m.candidateFingerprint!==d.fingerprint||m.requirementFingerprint!==jobRequirementFingerprint(j)||new Date(m.expiresAt)<=new Date())continue;
    const authority=await event(tx,ownerId,'candidate.review_authority',existing.aggregateId);
    if(authority?.metadata.tokenHash)throw new TRPCError({code:'CONFLICT',message:'A current screening request already exists for this candidate and role. Review, clarify or revoke it before creating another.'});
   }
  }
  const known=new Set((d.fresh?d.fields?.skills??[]:[]).map(s=>s.toLowerCase())),skills=(Array.isArray(j.mustHaveSkills)?j.mustHaveSkills:[]).filter((s:any)=>typeof s==='string'&&!known.has(s.toLowerCase()));
  const career=await careerEvidenceInTransaction(tx,ownerId,d);
  const all=clarification?.questions??[...careerClarificationQuestions(career),...(Array.isArray(j.scorecard)?j.scorecard:[]).map((c:any,i:number)=>({id:'criterion_'+i,prompt:'Describe job-related work or an accessible work sample demonstrating: '+c.criterion})),...skills.map((s:string,i:number)=>({id:'skill_'+i,prompt:'Give a concrete job-related example of your experience with '+s+'. If unknown, say what evidence is missing.'}))];
  for(const q of all)ensureSafeAiText(q.prompt);
  const id=createId('crv_'),token=randomBytes(32).toString('base64url'),expiresAt=new Date(Date.now()+input.expiresHours*3600000);
  await appendWorkflowEvent(tx,ownerId,'candidate.review_identity',key,1,{inviteId:id,candidateId:d.candidateId,requestHash});
  await appendWorkflowEvent(tx,ownerId,'candidate.review_invited',id,1,{candidateId:d.candidateId,jobId:j.id,roleTitle:j.title,questions:all.slice(0,24),omittedQuestions:Math.max(0,all.length-24),candidateFingerprint:d.fingerprint,requirementFingerprint:jobRequirementFingerprint(j),expiresAt:expiresAt.toISOString(),actorId,...(clarification?{parentId:clarification.parentId,parentResponseRevision:clarification.responseRevision,parentResponseHash:clarification.responseHash,depth:clarification.depth}:{depth:0})});
  await appendWorkflowEvent(tx,ownerId,'candidate.review_authority',id,1,{candidateId:d.candidateId,tokenHash:availabilityTokenHash(token)});
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'candidate.review_created',resourceType:'candidate',resourceId:d.candidateId,metadata:{inviteId:id,jobId:j.id,identityVerified:false}},tx);
  await scheduleCandidateReviewDeadline(tx,ownerId,id,'expiry',0,expiresAt);
  return {id,alreadyExists:false,fragment:id+'.'+token};
 };return run();
}
async function authenticate(tx:any,id:string,token:string,ownerId?:number){
 const row=ownerId?await event(tx,ownerId,'candidate.review_authority',id):(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.eventType,'candidate.review_authority'),eq(workflowEvents.aggregateId,id))).orderBy(desc(workflowEvents.revision)).limit(1))[0];
 const hash=row?.metadata?.tokenHash;
 if(!row||!/^[A-Za-z0-9_-]{43}$/.test(token)||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)||!timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(availabilityTokenHash(token),'hex')))throw denied();return row;
}
export async function publicCandidateReview(input:{id:string;token:string}){
 const hint=await authenticate(await requireDb(),input.id,input.token);
 return withWorkspaceTransaction(hint.ownerId,async tx=>{await authenticate(tx,input.id,input.token,hint.ownerId);const r=await request(tx,hint.ownerId,input.id);await scope(tx,hint.ownerId,r);const response=await event(tx,hint.ownerId,'candidate.review_responded',input.id);return {roleTitle:r.metadata.roleTitle as string,questions:r.metadata.questions as {id:string;prompt:string}[],omittedQuestions:Number(r.metadata.omittedQuestions??0),revision:response?.revision??0,expiresAt:r.metadata.expiresAt as string,identityVerified:false as const,noticeVersion:'candidate-review-v1' as const};});
}
export async function respondCandidateReview(raw:Parameters<typeof candidateReviewResponseSchema.parse>[0]){
 const input=candidateReviewResponseSchema.parse(raw),hint=await authenticate(await requireDb(),input.id,input.token);
 return withWorkspaceTransaction(hint.ownerId,async tx=>{
  await authenticate(tx,input.id,input.token,hint.ownerId);const r=await request(tx,hint.ownerId,input.id);await scope(tx,hint.ownerId,r);
  for(const v of [...input.fields.skills,...Object.values(input.answers)])ensureSafeAiText(v);
  const permitted=new Set(r.metadata.questions.map((q:any)=>q.id));if(Object.keys(input.answers).some(q=>!permitted.has(q)))throw new TRPCError({code:'BAD_REQUEST',message:'Only questions in this review request can be answered.'});
  const hash=workflowHash({fields:input.fields,answers:input.answers,noticeVersion:input.noticeVersion}),previous=await event(tx,hint.ownerId,'candidate.review_responded',input.id);
  if(previous?.revision===input.expectedRevision+1&&previous.metadata.responseHash===hash)return {revision:previous.revision,alreadySaved:true};
  if((previous?.revision??0)!==input.expectedRevision)throw new TRPCError({code:'CONFLICT',message:'Response changed. Reload the private review link.'});
  if(input.expectedRevision>=5)throw new TRPCError({code:'PRECONDITION_FAILED',message:'This request has reached its five-response correction limit. Ask for a new link.'});
  const revision=input.expectedRevision+1;await appendWorkflowEvent(tx,hint.ownerId,'candidate.review_responded',input.id,revision,{candidateId:r.metadata.candidateId,fields:input.fields,answers:input.answers,responseHash:hash,receivedAt:new Date().toISOString(),noticeVersion:input.noticeVersion,identityVerified:false});
  await recordCandidateReviewActivity(tx,hint.ownerId,r.metadata.candidateId,r.metadata.jobId,{inviteId:input.id,responseRevision:revision,status:'submitted'});
  await stopCandidateReviewWork(tx,hint.ownerId,input.id,'Candidate answered the private review.',true);
  await resolveCandidateReviewIncidents(tx,hint.ownerId,input.id,'A newer candidate response was received.');
  await scheduleCandidateReviewDeadline(tx,hint.ownerId,input.id,'review',revision,new Date(Date.now()+24*3600000));
  await invalidateCandidateMatches(tx,hint.ownerId,r.metadata.candidateId,'Candidate questionnaire response changed; review current self-reported evidence.',r.metadata.jobId);
  if(!previous)await tx.insert(consents).values({id:createId('cns_'),ownerId:hint.ownerId,candidateId:r.metadata.candidateId,jobId:r.metadata.jobId,consentType:'platform_processing',status:'granted',method:'capability_self_report',noticeVersion:input.noticeVersion,grantedAt:new Date(),expiresAt:new Date(r.metadata.expiresAt),dataScope:{purpose:'review_submitted_recruitment_evidence',identityVerified:false}});
  await recordAudit({ownerId:hint.ownerId,actorType:'provider',actorId:input.id,action:'candidate.review_responded',resourceType:'candidate',resourceId:r.metadata.candidateId,metadata:{inviteId:input.id,revision,identityVerified:false}},tx);
  return {revision,alreadySaved:false};
 });
}
export async function revokeCandidateReviewInTransaction(tx:any,ownerId:number,id:string){const r=await request(tx,ownerId,id),a=await event(tx,ownerId,'candidate.review_authority',id);if(a?.metadata.tokenHash)await appendWorkflowEvent(tx,ownerId,'candidate.review_authority',id,a.revision+1,{candidateId:r.metadata.candidateId,tokenHash:'',revoked:true});await stopCandidateReviewWork(tx,ownerId,id,'Private candidate review was revoked.');}
export async function revokeCandidateReview(ownerId:number,actorId:number,id:string){return withWorkspaceTransaction(ownerId,async tx=>{await revokeCandidateReviewInTransaction(tx,ownerId,id);await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'candidate.review_revoked',resourceType:'candidate_review',resourceId:id},tx);return {success:true};});}
export async function listCandidateReviews(ownerId:number,candidateId:string,reviewId?:string){return withWorkspaceTransaction(ownerId,async tx=>{await candidateEvidenceInTransaction(tx,ownerId,candidateId);const all=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'candidate.review_invited'))).orderBy(desc(workflowEvents.createdAt),desc(workflowEvents.id));const selected=all.filter((r:any)=>r.metadata.candidateId===candidateId&&(!reviewId||r.aggregateId===reviewId)).slice(0,10);return Promise.all(selected.map(async(r:any)=>{let stale=false;try{await scope(tx,ownerId,r);}catch{stale=true;}const response=await event(tx,ownerId,'candidate.review_responded',r.aggregateId),authority=await event(tx,ownerId,'candidate.review_authority',r.aggregateId),adopted=await event(tx,ownerId,'candidate.review_adopted',r.aggregateId),completed=await event(tx,ownerId,'candidate.review_completed',r.aggregateId),clarified=await event(tx,ownerId,'candidate.review_clarified',r.aggregateId);return {id:r.aggregateId as string,jobId:r.metadata.jobId as string,roleTitle:r.metadata.roleTitle as string,expiresAt:r.metadata.expiresAt as string,questions:r.metadata.questions as {id:string;prompt:string}[],status:clarified?'clarified':completed?'reviewed':adopted?'adopted':!authority?.metadata.tokenHash?'revoked':stale?'stale_or_expired':response?'submitted':'pending',canReview:Boolean(response&&!adopted&&!completed&&!clarified&&await scope(tx,ownerId,r,true).then(()=>true).catch(()=>false)),parentId:r.metadata.parentId??null,response:response?{revision:response.revision,fields:response.metadata.fields,answers:response.metadata.answers,receivedAt:response.metadata.receivedAt,identityVerified:false}:null,adopted:adopted?.metadata??null};}));});}
export async function adoptCandidateReview(ownerId:number,actorId:number,input:{id:string;responseRevision:number;selectedFields:typeof candidateReviewFields[number][];reason:string}){
 return withWorkspaceTransaction(ownerId,async tx=>{
  const r=await request(tx,ownerId,input.id),hash=workflowHash({...input,selectedFields:[...new Set(input.selectedFields)].sort()}),prior=await event(tx,ownerId,'candidate.review_adopted',input.id);
  if(prior){if(prior.metadata.selectionHash!==hash)throw new TRPCError({code:'CONFLICT',message:'A different review selection was already adopted.'});return {revision:Number(prior.metadata.evidenceRevision),alreadyAdopted:true};}
  if(await event(tx,ownerId,'candidate.review_completed',input.id)||await event(tx,ownerId,'candidate.review_clarified',input.id))throw new TRPCError({code:'PRECONDITION_FAILED',message:'This review was completed or replaced by clarification.'});
  const {d}=await scope(tx,ownerId,r,true),response=await event(tx,ownerId,'candidate.review_responded',input.id);
  const currentActivity=await candidateReviewActivity(tx,ownerId,d.candidateId,r.metadata.jobId);
  if(currentActivity?.metadata.inviteId!==input.id)throw new TRPCError({code:'CONFLICT',message:'A newer candidate review response needs attention.'});
  if(!response||response.revision!==input.responseRevision)throw new TRPCError({code:'CONFLICT',message:'Candidate response changed. Review the current response.'});
  if(!input.selectedFields.length)throw new TRPCError({code:'BAD_REQUEST',message:'Select fields to adopt.'});
  const next:any=d.fields?{...d.fields}:{skills:[],locations:[],workModels:[],observedAt:new Date(response.metadata.receivedAt),validUntil:new Date(new Date(response.metadata.receivedAt).getTime()+30*86400000)};
  for(const field of new Set(input.selectedFields)){if(response.metadata.fields[field]===undefined)throw new TRPCError({code:'BAD_REQUEST',message:'The selected '+field+' was not provided.'});next[field]=response.metadata.fields[field];}
  next.sourceNote='Owner-adopted private candidate response '+input.id+'. Unselected values and existing observation/expiry were retained.';
  const saved=await saveCandidateEvidenceInTransaction(tx,ownerId,actorId,{candidateId:d.candidateId,expectedRevision:d.revision,expectedFingerprint:d.fingerprint,fields:candidateEvidenceFieldsSchema.parse(next),reason:input.reason},{source:'candidate_self_report_adopted',reviewId:input.id,responseRevision:response.revision});
  let screening=(await tx.select().from(screenings).where(and(eq(screenings.ownerId,ownerId),eq(screenings.candidateId,d.candidateId),eq(screenings.jobId,r.metadata.jobId))).limit(1))[0];
  if(!screening){const id=createId('scr_');await tx.insert(screenings).values({id,ownerId,candidateId:d.candidateId,jobId:r.metadata.jobId,status:'evidence_pending',answers:response.metadata.answers,evidence:['Private candidate response '+input.id+'; identity not independently verified.'],confidence:0});screening={id};}
  await recordCandidateReviewActivity(tx,ownerId,d.candidateId,r.metadata.jobId,{inviteId:input.id,responseRevision:response.revision,status:'adopted'});
  await stopCandidateReviewWork(tx,ownerId,input.id,'Owner adopted the reviewed response.',true,true);
  await resolveCandidateReviewIncidents(tx,ownerId,input.id,'Owner adopted the reviewed response.');
  await appendWorkflowEvent(tx,ownerId,'candidate.review_adopted',input.id,1,{candidateId:d.candidateId,evidenceRevision:saved.revision,responseRevision:response.revision,selectedFields:input.selectedFields,selectionHash:hash,screeningId:screening.id,identityVerified:false});
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'candidate.review_adopted',resourceType:'candidate',resourceId:d.candidateId,metadata:{inviteId:input.id,responseRevision:response.revision,evidenceRevision:saved.revision}},tx);
  return {revision:saved.revision,alreadyAdopted:false};
 });
}
export async function pendingCandidateReviewForMail(tx:any,ownerId:number,id:string,now:Date){const r=await request(tx,ownerId,id);await scope(tx,ownerId,r);const a=await event(tx,ownerId,'candidate.review_authority',id);if(!a?.metadata.tokenHash||await event(tx,ownerId,'candidate.review_responded',id))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Review was answered or revoked.'});return {id,candidateId:r.metadata.candidateId,jobId:r.metadata.jobId,groupId:id,participant:'candidate',revision:a.revision,submissionCount:0,expiresAt:new Date(r.metadata.expiresAt),tokenHash:a.metadata.tokenHash};}
export async function rotateCandidateReviewToken(tx:any,ownerId:number,id:string,revision:number,tokenHash:string){const r=await request(tx,ownerId,id),a=await event(tx,ownerId,'candidate.review_authority',id);if(a.revision+1!==revision)throw new TRPCError({code:'CONFLICT',message:'Review link authority changed.'});await appendWorkflowEvent(tx,ownerId,'candidate.review_authority',id,revision,{candidateId:r.metadata.candidateId,tokenHash});}
