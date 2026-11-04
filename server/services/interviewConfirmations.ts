import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {and,desc,eq} from 'drizzle-orm';
import {TRPCError} from '@trpc/server';
import {interviewConfirmations as links,interviews} from '../../drizzle/schema';
import {createId,recordAudit,requireDb} from '../db';
import {withWorkspaceTransaction} from './database';
import {changeInterviewStateInTransaction,requireSchedulableCandidate} from './interviewScheduling';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const denied=()=>new TRPCError({code:'UNAUTHORIZED',message:'Interview response link is invalid, expired or unavailable.'});
/** Reminder edits do not change the appointment. The monotonic counter prevents away/back revival. */
export function confirmationScheduleFingerprint(row:typeof interviews.$inferSelect){return digest([row.id,row.candidateId,row.companyId,row.jobId,row.scheduledAt?.toISOString(),row.durationMinutes,row.timezone,row.meetingUrl??null,row.rescheduleCount]);}
async function owned(tx:any,ownerId:number,id:string){const row=(await tx.select().from(interviews).where(and(eq(interviews.ownerId,ownerId),eq(interviews.id,id))).limit(1))[0] as typeof interviews.$inferSelect;if(!row)throw new TRPCError({code:'NOT_FOUND',message:'Interview not found.'});return row;}
const current=(r:typeof links.$inferSelect,i:typeof interviews.$inferSelect)=>!!i.scheduledAt&&i.scheduledAt.getTime()>Date.now()&&['scheduled','confirmed','reschedule_requested'].includes(i.status)&&(i.calendarStatus!=='cancelled'||i.status==='reschedule_requested')&&confirmationScheduleFingerprint(i)===r.scheduleFingerprint;
export async function listInterviewConfirmations(ownerId:number,interviewId:string){return withWorkspaceTransaction(ownerId,async tx=>{const i=await owned(tx,ownerId,interviewId),rows:typeof links.$inferSelect[]=await tx.select().from(links).where(and(eq(links.ownerId,ownerId),eq(links.interviewId,interviewId))).orderBy(desc(links.createdAt),desc(links.id)).limit(50);return rows.map(r=>({id:r.id,groupId:r.groupId,participant:r.participant,status:r.status==='revoked'?'revoked':!current(r,i)?'stale':r.expiresAt.getTime()<=Date.now()?'expired':r.status,expiresAt:r.expiresAt,respondedAt:r.respondedAt}));});}
export async function createInterviewConfirmations(ownerId:number,actorId:number,input:{interviewId:string;requestKey:string;expiresHours:number}){
 if(!Number.isInteger(input.expiresHours)||input.expiresHours<1||input.expiresHours>168)throw new TRPCError({code:'BAD_REQUEST',message:'Lifetime must be 1–168 hours.'});
 const groupId='icg_'+digest([ownerId,input.requestKey]).slice(0,32);
 return withWorkspaceTransaction(ownerId,async tx=>{
  const i=await owned(tx,ownerId,input.interviewId),fingerprint=confirmationScheduleFingerprint(i),requestHash=digest([input.interviewId,input.expiresHours,fingerprint]);
  const prior:typeof links.$inferSelect[]=await tx.select().from(links).where(and(eq(links.ownerId,ownerId),eq(links.groupId,groupId)));
  if(prior.length){if(prior.some(r=>r.requestHash!==requestHash))throw new TRPCError({code:'CONFLICT',message:'Request identity already belongs to a different schedule.'});return {groupId,links:[],alreadyExists:true};}
  await requireSchedulableCandidate(tx,ownerId,i.candidateId);
  if(i.status!=='scheduled'||!i.scheduledAt||i.scheduledAt.getTime()<=Date.now()||i.calendarStatus==='cancelled')throw new TRPCError({code:'PRECONDITION_FAILED',message:'A future tentative scheduled interview is required.'});
  // Replacement requests invalidate every earlier pair, including a partially confirmed pair.
  await tx.update(links).set({status:'revoked',tokenHash:''}).where(and(eq(links.ownerId,ownerId),eq(links.interviewId,i.id)));
  const result:Array<{id:string;participant:string;fragment:string}>=[],expiresAt=new Date(Math.min(Date.now()+input.expiresHours*3600000,i.scheduledAt.getTime()));
  for(const participant of ['candidate','interviewer']){const id=createId('icf_'),token=randomBytes(32).toString('base64url');await tx.insert(links).values({id,ownerId,groupId,interviewId:i.id,candidateId:i.candidateId,participant,requestHash,scheduleFingerprint:fingerprint,tokenHash:digest(token),status:'pending',expiresAt});result.push({id,participant,fragment:`${id}.${token}`});}
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'interview.confirmation_links_created',resourceType:'interview',resourceId:i.id,metadata:{groupId}},tx);return {groupId,links:result,alreadyExists:false};
 });
}
export async function revokeInterviewConfirmations(ownerId:number,actorId:number,groupId:string){return withWorkspaceTransaction(ownerId,async tx=>{const rows=await tx.select().from(links).where(and(eq(links.ownerId,ownerId),eq(links.groupId,groupId)));if(!rows.length)throw new TRPCError({code:'NOT_FOUND'});await tx.update(links).set({status:'revoked',tokenHash:''}).where(and(eq(links.ownerId,ownerId),eq(links.groupId,groupId)));await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'interview.confirmation_links_revoked',resourceType:'interview',resourceId:rows[0].interviewId,metadata:{groupId}},tx);return {success:true};});}
async function authenticate(tx:any,id:string,token:string){const r=(await tx.select().from(links).where(eq(links.id,id)).limit(1))[0] as typeof links.$inferSelect;if(!r||!['pending','confirmed','declined'].includes(r.status)||r.expiresAt.getTime()<=Date.now()||!/^[A-Za-z0-9_-]{43}$/.test(token)||!/^[a-f0-9]{64}$/.test(r.tokenHash)||!timingSafeEqual(Buffer.from(r.tokenHash,'hex'),Buffer.from(digest(token),'hex')))throw denied();return r;}
export async function publicInterviewConfirmation(input:{id:string;token:string;decision?:'confirmed'|'declined'}){
 const hint=await authenticate(await requireDb(),input.id,input.token);
 return withWorkspaceTransaction(hint.ownerId,async tx=>{
  const r=await authenticate(tx,input.id,input.token),i=await owned(tx,r.ownerId,r.interviewId);
  await requireSchedulableCandidate(tx,r.ownerId,i.candidateId);if(!current(r,i))throw denied();
  if(input.decision){
   if(r.status!=='pending'){if(r.status!==input.decision)throw new TRPCError({code:'CONFLICT',message:'Your answer is already recorded. Contact the recruiter to change it.'});}
   else {
    if(i.status!=='scheduled')throw denied();
    await tx.update(links).set({status:input.decision,respondedAt:new Date()}).where(eq(links.id,r.id));
    const pair:typeof links.$inferSelect[]=await tx.select().from(links).where(and(eq(links.ownerId,r.ownerId),eq(links.groupId,r.groupId)));
    if(input.decision==='declined'){
     await changeInterviewStateInTransaction(tx,r.ownerId,r.id,i.id,'reschedule_requested',undefined,'provider');
     for(const other of pair.filter(x=>x.status==='pending'))await tx.update(links).set({status:'revoked',tokenHash:''}).where(eq(links.id,other.id));
    }else if(pair.length===2&&pair.every(x=>x.status==='confirmed'&&x.scheduleFingerprint===r.scheduleFingerprint))await changeInterviewStateInTransaction(tx,r.ownerId,r.id,i.id,'confirmed',undefined,'provider');
    await recordAudit({ownerId:r.ownerId,actorType:'provider',actorId:r.id,action:'interview.participant_responded',resourceType:'interview',resourceId:i.id,metadata:{groupId:r.groupId,participant:r.participant,decision:input.decision,identityVerified:false}},tx);
    r.status=input.decision;
   }
  }
  return {participant:r.participant,status:r.status,scheduledAt:i.scheduledAt!,timezone:i.timezone,durationMinutes:i.durationMinutes,interviewStatus:(await owned(tx,r.ownerId,i.id)).status,identityVerified:false as const};
 });
}

/** Reused by the shared private-link outbox; no independent sending or authorization engine. */
export async function pendingConfirmationForMail(tx:any,ownerId:number,id:string,now:Date){
 const r=(await tx.select().from(links).where(and(eq(links.ownerId,ownerId),eq(links.id,id))).limit(1))[0] as typeof links.$inferSelect;
 if(!r)throw new TRPCError({code:'NOT_FOUND',message:'Owned interview confirmation is required.'});
 const i=await owned(tx,ownerId,r.interviewId);
 if(r.status!=='pending'||r.expiresAt<=now||!current(r,i)||i.status!=='scheduled')throw new TRPCError({code:'PRECONDITION_FAILED',message:'Interview confirmation is expired, answered, revoked or its schedule changed.'});
 await requireSchedulableCandidate(tx,ownerId,i.candidateId);
 return {...r,jobId:i.jobId,revision:1,submissionCount:0,scheduledAt:i.scheduledAt!,timezone:i.timezone,durationMinutes:i.durationMinutes};
}
