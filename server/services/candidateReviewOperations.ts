import {hasCandidateCommunicationPermission} from './communicationPermission';
import {invalidateCandidateMatches} from './candidateEvidenceLifecycle';
import {TRPCError} from '@trpc/server';
import {and,desc,eq} from 'drizzle-orm';
import {z} from 'zod';
import {conversations,followUpPlans,screenings,suppressionList,workflowEvents} from '../../drizzle/schema';
import {createId,hashContactValue,recordAudit} from '../db';
import {ensureSafeAiText} from '../workflow';
import {withWorkspaceTransaction} from './database';
import {appendWorkflowEvent,workflowHash} from './workflowStore';
import {reviewEvent,reviewRequest,reviewScope,candidateReviewFollowupState} from './candidateReviewState';
import {candidateReviewActivity,createCandidateReviewInTransaction,recordCandidateReviewActivity,revokeCandidateReviewInTransaction} from './candidateReview';
import {resolveCandidateReviewIncidents,stopCandidateReviewWork} from './candidateReviewLifecycle';
import {enrollFollowUpInTransaction} from './followups';
export const clarifyCandidateReviewInput=z.object({id:z.string().min(4).max(36),responseRevision:z.number().int().positive(),questionIds:z.array(z.string().min(1).max(40)).min(1).max(24),note:z.string().trim().min(8).max(1000),expiresHours:z.number().int().min(1).max(168).default(48)}).strict();
async function currentResponse(tx:any,ownerId:number,id:string,revision:number){
 const r=await reviewRequest(tx,ownerId,id);const {d}=await reviewScope(tx,ownerId,r,true);const response=await reviewEvent(tx,ownerId,'candidate.review_responded',id),activity=await candidateReviewActivity(tx,ownerId,d.candidateId,r.metadata.jobId);
 if(!response||response.revision!==revision||activity?.metadata.inviteId!==id||activity.metadata.responseRevision!==revision)throw new TRPCError({code:'CONFLICT',message:'A newer candidate response or case needs attention.'});
 if(await reviewEvent(tx,ownerId,'candidate.review_adopted',id)||await reviewEvent(tx,ownerId,'candidate.review_completed',id)||await reviewEvent(tx,ownerId,'candidate.review_clarified',id))throw new TRPCError({code:'PRECONDITION_FAILED',message:'This response was already reviewed or replaced by clarification.'});
 return {r,d,response};
}
export async function candidateReviewHistory(ownerId:number,id:string){return withWorkspaceTransaction(ownerId,async tx=>{
 const r=await reviewRequest(tx,ownerId,id),responses=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,id),eq(workflowEvents.eventType,'candidate.review_responded'))).orderBy(desc(workflowEvents.revision)).limit(5);
 return {parentId:r.metadata.parentId??null,parentResponseRevision:r.metadata.parentResponseRevision??null,clarificationDepth:Number(r.metadata.depth??0),questions:r.metadata.questions as {id:string;prompt:string}[],versions:responses.map((v:any)=>({revision:v.revision,fields:v.metadata.fields,answers:v.metadata.answers,receivedAt:v.metadata.receivedAt,identityVerified:false})),completion:(await reviewEvent(tx,ownerId,'candidate.review_completed',id))?.metadata??null,clarification:(await reviewEvent(tx,ownerId,'candidate.review_clarified',id))?.metadata??null};
});}
export async function clarifyCandidateReview(ownerId:number,actorId:number,raw:z.input<typeof clarifyCandidateReviewInput>){const input=clarifyCandidateReviewInput.parse(raw),requestHash=workflowHash({...input,questionIds:[...new Set(input.questionIds)].sort()});ensureSafeAiText(input.note);
 return withWorkspaceTransaction(ownerId,async tx=>{
  const previous=await reviewEvent(tx,ownerId,'candidate.review_clarified',input.id);
  if(previous){if(previous.metadata.requestHash!==requestHash)throw new TRPCError({code:'CONFLICT',message:'This response already has a different clarification request.'});return {id:String(previous.metadata.childId),alreadyExists:true,fragment:null};}
  const {r,response}=await currentResponse(tx,ownerId,input.id,input.responseRevision),depth=Number(r.metadata.depth??0)+1;
  if(depth>3)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Three targeted clarification rounds are the limit. Review the case before starting another independent request.'});
  const requested=new Set(input.questionIds),questions=(r.metadata.questions as {id:string;prompt:string}[]).filter(q=>requested.has(q.id)).map(q=>({id:q.id,prompt:q.prompt+' Clarification requested: '+input.note}));
  if(questions.length!==requested.size||questions.some(q=>q.prompt.length>5000))throw new TRPCError({code:'BAD_REQUEST',message:'Choose existing questions and a bounded job-related clarification.'});
  const created=await createCandidateReviewInTransaction(tx,ownerId,actorId,{candidateId:r.metadata.candidateId,jobId:r.metadata.jobId,requestKey:'clarify:'+input.id+':'+input.responseRevision,expiresHours:input.expiresHours},{parentId:input.id,responseRevision:response.revision,responseHash:response.metadata.responseHash,questions,depth});
  await revokeCandidateReviewInTransaction(tx,ownerId,input.id);await stopCandidateReviewWork(tx,ownerId,input.id,'A targeted clarification request replaced this round.',true,true);await resolveCandidateReviewIncidents(tx,ownerId,input.id,'Owner requested current targeted clarification.');
  await appendWorkflowEvent(tx,ownerId,'candidate.review_clarified',input.id,1,{candidateId:r.metadata.candidateId,childId:created.id,responseRevision:response.revision,requestHash,questionIds:[...requested],note:input.note,actorId});
  await recordCandidateReviewActivity(tx,ownerId,r.metadata.candidateId,r.metadata.jobId,{inviteId:created.id,responseRevision:0,status:'clarification_pending'});
  await invalidateCandidateMatches(tx,ownerId,r.metadata.candidateId,'Targeted candidate clarification is pending.',r.metadata.jobId);
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'candidate.review_clarification_requested',resourceType:'candidate_review',resourceId:input.id,metadata:{childId:created.id,responseRevision:response.revision}},tx);return created;
 });
}
export async function completeCandidateReview(ownerId:number,actorId:number,input:{id:string;responseRevision:number;reason:string}){const requestHash=workflowHash(input);
 return withWorkspaceTransaction(ownerId,async tx=>{
  const prior=await reviewEvent(tx,ownerId,'candidate.review_completed',input.id);if(prior){if(prior.metadata.requestHash!==requestHash)throw new TRPCError({code:'CONFLICT',message:'A different evidence-review completion is recorded.'});return {alreadyCompleted:true};}
  const {r,response}=await currentResponse(tx,ownerId,input.id,input.responseRevision);
  const existing=(await tx.select().from(screenings).where(and(eq(screenings.ownerId,ownerId),eq(screenings.candidateId,r.metadata.candidateId),eq(screenings.jobId,r.metadata.jobId))).limit(1))[0];
  if(!existing)await tx.insert(screenings).values({id:createId('scr_'),ownerId,candidateId:r.metadata.candidateId,jobId:r.metadata.jobId,status:'evidence_pending',answers:response.metadata.answers,evidence:['Owner reviewed private self-reported evidence; identity is unverified.'],confidence:0});
  await appendWorkflowEvent(tx,ownerId,'candidate.review_completed',input.id,1,{candidateId:r.metadata.candidateId,responseRevision:response.revision,reason:input.reason,requestHash,actorId,profileChanged:false,hiringDecision:false});
  await recordCandidateReviewActivity(tx,ownerId,r.metadata.candidateId,r.metadata.jobId,{inviteId:input.id,responseRevision:response.revision,status:'reviewed'});
  await invalidateCandidateMatches(tx,ownerId,r.metadata.candidateId,'Owner evidence review changed; assess the current source context.',r.metadata.jobId);
  await revokeCandidateReviewInTransaction(tx,ownerId,input.id);await stopCandidateReviewWork(tx,ownerId,input.id,'Owner completed evidence review without profile adoption.',true,true);await resolveCandidateReviewIncidents(tx,ownerId,input.id,'Owner completed evidence review.');
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'candidate.review_completed',resourceType:'candidate_review',resourceId:input.id,metadata:{responseRevision:response.revision,profileChanged:false,hiringDecision:false}},tx);return {alreadyCompleted:false};
 });
}
export const candidateReviewFollowupInput=z.object({id:z.string().min(4).max(36),conversationId:z.string().min(4).max(36),senderIdentityId:z.string().min(4).max(36),delayMinutes:z.number().int().min(15).max(10080),reminders:z.number().int().min(1).max(3),timezone:z.string().min(2).max(64),linkAlreadyShared:z.literal(true)}).strict();
export async function enrollCandidateReviewFollowup(ownerId:number,actorId:number,raw:z.input<typeof candidateReviewFollowupInput>){
 const input=candidateReviewFollowupInput.parse(raw);
 return withWorkspaceTransaction(ownerId,async tx=>{
  const requestHash=workflowHash(input),prior=await reviewEvent(tx,ownerId,'candidate.review_followup_requested',input.id);
  if(prior){if(prior.metadata.requestHash!==requestHash)throw new TRPCError({code:'CONFLICT',message:'This review already has a different reminder sequence. Replan its existing Follow-up instead.'});const plan=(await tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId,ownerId),eq(followUpPlans.id,String(prior.metadata.planId)))).limit(1))[0];if(!plan)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Recorded reminder sequence is unavailable.'});return {id:plan.id,alreadyEnrolled:true,status:plan.status};}
  const r=await reviewRequest(tx,ownerId,input.id),state=await candidateReviewFollowupState(tx,ownerId,input.id);
  if(state.state!=='eligible')throw new TRPCError({code:'PRECONDITION_FAILED',message:state.reason});
  const c=(await tx.select().from(conversations).where(and(eq(conversations.ownerId,ownerId),eq(conversations.id,input.conversationId))).limit(1))[0];
  if(!c||c.channel!=='email'||c.candidateId!==state.candidateId||c.jobId!==state.jobId||c.contactId)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Select this candidate’s email conversation for the exact role.'});
  if(Date.now()+input.delayMinutes*60000>=state.expiresAt.getTime())throw new TRPCError({code:'BAD_REQUEST',message:'The first reminder must be before the review link expires.'});
  await appendWorkflowEvent(tx,ownerId,'candidate.review_link_shared',input.id,1,{candidateId:r.metadata.candidateId,actorId,source:'owner_recorded_not_delivery_verified'});
  const result=await enrollFollowUpInTransaction(tx,ownerId,{scenarioId:r.metadata.parentId?'FU13':'FU11',objective:'Collect the current private candidate screening response',conversationId:c.id,senderIdentityId:input.senderIdentityId,resourceType:'candidate_review',resourceId:input.id,timezone:input.timezone,deadlineAt:state.expiresAt,responseWindowMinutes:input.delayMinutes,steps:Array.from({length:input.reminders},(_,i)=>({delayMinutes:input.delayMinutes,subject:i?'Reminder: private recruitment evidence review':'Your private recruitment evidence review',body:'Please complete the private job-related review previously shared with you before its expiry. Use your original private link; do not forward it. If the link is unavailable or you need an accessible alternative, reply to your recruiter. Unknown answers may be left blank. Reply STOP to stop recruitment messages.'}))},actorId);
  await appendWorkflowEvent(tx,ownerId,'candidate.review_followup_requested',input.id,1,{candidateId:r.metadata.candidateId,planId:result.id,requestHash});
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'candidate.review_followup_enrolled',resourceType:'candidate_review',resourceId:input.id,metadata:{planId:result.id,linkSharedStatement:'owner_recorded_not_delivery_verified'}},tx);return result;
 });
}

export async function ensureCandidateReviewConversation(ownerId:number,actorId:number,id:string){return withWorkspaceTransaction(ownerId,async tx=>{
 const r=await reviewRequest(tx,ownerId,id),state=await candidateReviewFollowupState(tx,ownerId,id);if(state.state!=='eligible')throw new TRPCError({code:'PRECONDITION_FAILED',message:state.reason});
 const {d,j}=await reviewScope(tx,ownerId,r),address=d.candidate.email?.trim().toLowerCase();
 if(!address||!await hasCandidateCommunicationPermission(tx,ownerId,d.candidateId,j.id,['recruitment_communication']))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Candidate email and current recruitment communication permission are required.'});
 if((await tx.select().from(suppressionList).where(and(eq(suppressionList.ownerId,ownerId),eq(suppressionList.channel,'email'),eq(suppressionList.valueHash,hashContactValue(address)),eq(suppressionList.active,true)))).length)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Candidate email is suppressed.'});
 const rows=await tx.select().from(conversations).where(and(eq(conversations.ownerId,ownerId),eq(conversations.candidateId,d.candidateId),eq(conversations.jobId,j.id),eq(conversations.channel,'email'))).orderBy(desc(conversations.updatedAt)).limit(100),old=rows.find((c:any)=>!c.contactId&&(!c.companyId||c.companyId===j.companyId)&&!['closed','archived','opted_out'].includes(c.status));
 if(old)return {conversationId:old.id,alreadyExists:true};
 const conversationId=createId('cnv_');await tx.insert(conversations).values({id:conversationId,ownerId,candidateId:d.candidateId,companyId:j.companyId,jobId:j.id,channel:'email',status:'active'});
 await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'candidate.review_conversation_opened',resourceType:'candidate_review',resourceId:id,metadata:{conversationId}},tx);return {conversationId,alreadyExists:false};
});}
