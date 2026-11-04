import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {and,desc,eq} from 'drizzle-orm';
import {TRPCError} from '@trpc/server';
import {availabilityInvites as invites,jobs} from '../../drizzle/schema';
import {createId,recordAudit,requireDb} from '../db';
import {withWorkspaceTransaction} from './database';
import {requireSchedulableCandidate} from './interviewScheduling';
import {isValidTimezone} from '../../shared/dateTime';
import {commonAvailability,type Window} from './availability';
import {googleFreeBusy} from './googleCalendar';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const denied=()=>new TRPCError({code:'UNAUTHORIZED',message:'Availability link is invalid, expired or revoked.'});
const safe=(row:typeof invites.$inferSelect)=>{const{tokenHash,requestHash,...value}=row;return {...value,status:row.status!=='revoked'&&new Date(row.expiresAt).getTime()<=Date.now()?'expired':row.status};};
export async function listAvailabilityInvites(ownerId:number){return (await(await requireDb()).select().from(invites).where(eq(invites.ownerId,ownerId)).orderBy(desc(invites.createdAt),desc(invites.id)).limit(100)).map(safe);}
export async function createAvailabilityInvites(ownerId:number,actorId:number,input:{candidateId:string;jobId:string;requestKey:string;expiresHours:number}){
 if(!Number.isInteger(input.expiresHours)||input.expiresHours<1||input.expiresHours>168)throw new TRPCError({code:'BAD_REQUEST',message:'Link lifetime must be 1–168 hours.'});
 const groupId='avl_'+digest([ownerId,input.requestKey]).slice(0,32),requestHash=digest([input.candidateId,input.jobId,input.expiresHours]);
 return withWorkspaceTransaction(ownerId,async tx=>{
  const old=await tx.select().from(invites).where(and(eq(invites.ownerId,ownerId),eq(invites.groupId,groupId)));
  if(old.length){if(old.some((r:any)=>r.requestHash!==requestHash))throw new TRPCError({code:'CONFLICT',message:'Request identity already has different availability details.'});return {groupId,links:[],alreadyExists:true};}
  await requireSchedulableCandidate(tx,ownerId,input.candidateId);
  if(!(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,input.jobId))).limit(1))[0])throw new TRPCError({code:'NOT_FOUND',message:'Owned job is required.'});
  const links:Array<{id:string;participant:string;fragment:string}>=[];
  for(const participant of ['candidate','interviewer']){const id=createId('avi_'),token=randomBytes(32).toString('base64url');await tx.insert(invites).values({id,ownerId,groupId,candidateId:input.candidateId,jobId:input.jobId,requestHash,participant,tokenHash:digest(token),status:'pending',revision:1,expiresAt:new Date(Date.now()+input.expiresHours*3600000),submissionCount:0});links.push({id,participant,fragment:`${id}.${token}`});}
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'availability.links_created',resourceType:'availability',resourceId:groupId},tx);return {groupId,links,alreadyExists:false};
 });
}
async function authenticate(tx:any,id:string,token:string){
 const row=(await tx.select().from(invites).where(eq(invites.id,id)).limit(1))[0] as typeof invites.$inferSelect;
 if(!row||!/^[A-Za-z0-9_-]{43}$/.test(token)||!/^[a-f0-9]{64}$/.test(row.tokenHash)||token.length!==43||row.status==='revoked'||new Date(row.expiresAt).getTime()<=Date.now()||!timingSafeEqual(Buffer.from(row.tokenHash,'hex'),Buffer.from(digest(token),'hex')))throw denied();
 await requireSchedulableCandidate(tx,row.ownerId,row.candidateId);return {...row};
}
export async function publicAvailability(input:{id:string;token:string;expectedRevision?:number;windows?:Window[];timezone?:string}){
 const found=await authenticate(await requireDb(),input.id,input.token);
 return withWorkspaceTransaction(found.ownerId,async tx=>{
  const row=await authenticate(tx,input.id,input.token);
  if(input.windows){
   const normalized=input.windows.map(w=>{const start=new Date(w.start),end=new Date(w.end);if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime()))throw new TRPCError({code:'BAD_REQUEST',message:'Invalid availability dates.'});return {start:start.toISOString(),end:end.toISOString()};});
   if(row.status==='submitted' && input.expectedRevision===row.revision-1 && input.timezone===row.timezone && digest(normalized.map(w=>[w.start,w.end]))===digest((row.windows??[]).map(w=>[w.start,w.end])))return {participant:row.participant,status:row.status,revision:row.revision,expiresAt:row.expiresAt};
   if(row.revision!==input.expectedRevision)throw new TRPCError({code:'CONFLICT',message:'This availability response changed. Reload before submitting.'});
   if(row.submissionCount>=5)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Correction limit reached. Ask the recruiter for a new request.'});
   if(!isValidTimezone(input.timezone||'')||!input.windows.length||input.windows.length>20||input.windows.some(w=>new Date(w.start).getTime()<=Date.now()||new Date(w.end).getTime()>Date.now()+90*86400000))throw new TRPCError({code:'BAD_REQUEST',message:'Choose future windows within 90 days and a valid timezone.'});
   commonAvailability({candidate:input.windows,interviewer:input.windows,durationMinutes:15,bufferMinutes:0});
   const windows=input.windows.map(w=>({start:new Date(w.start).toISOString(),end:new Date(w.end).toISOString()}));
   await tx.update(invites).set({windows,timezone:input.timezone,revision:row.revision+1,status:'submitted',submissionCount:row.submissionCount+1}).where(eq(invites.id,row.id));
   await recordAudit({ownerId:row.ownerId,actorType:'provider',action:'availability.submitted',resourceType:'availability_invite',resourceId:row.id,metadata:{participant:row.participant,revision:row.revision+1,identityVerified:false}},tx);
   return {participant:row.participant,status:'submitted',revision:row.revision+1,expiresAt:row.expiresAt};
  }
  return {participant:row.participant,status:row.status,revision:row.revision,expiresAt:row.expiresAt};
 });
}
export async function revokeAvailability(ownerId:number,actorId:number,groupId:string){return withWorkspaceTransaction(ownerId,async tx=>{const rows=await tx.select().from(invites).where(and(eq(invites.ownerId,ownerId),eq(invites.groupId,groupId)));if(!rows.length)throw new TRPCError({code:'NOT_FOUND'});if(rows.every((r:any)=>r.status==='revoked'))return {revoked:true};for(const row of rows)await tx.update(invites).set({status:'revoked',revision:row.revision+1}).where(eq(invites.id,row.id));await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'availability.revoked',resourceType:'availability',resourceId:groupId},tx);return {revoked:true};});}
export async function proposeCollectedAvailability(ownerId:number,groupId:string,durationMinutes:number,bufferMinutes:number){
 const get=async()=>withWorkspaceTransaction(ownerId,async tx=>{const rows=await tx.select().from(invites).where(and(eq(invites.ownerId,ownerId),eq(invites.groupId,groupId)));if(rows.length!==2||rows.some((r:any)=>r.status!=='submitted'||new Date(r.expiresAt).getTime()<=Date.now()))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Both valid participant responses are required.'});await requireSchedulableCandidate(tx,ownerId,rows[0].candidateId);return rows.map((r:any)=>({...r,windows:structuredClone(r.windows)}));});
 const rows=await get(),candidate=rows.find((r:any)=>r.participant==='candidate')!,interviewer=rows.find((r:any)=>r.participant==='interviewer')!;
 const windows=(r:any)=>r.windows.map((w:any)=>({start:new Date(w.start),end:new Date(w.end)})) as Window[];
 const input={candidate:windows(candidate),interviewer:windows(interviewer),durationMinutes,bufferMinutes},initial=commonAvailability(input);
 if(!initial.slots.length)return {...initial,googleChecked:false};
 const all=[...input.candidate,...input.interviewer],pad=bufferMinutes*60000,busy=await googleFreeBusy(ownerId,new Date(Math.min(...all.map(w=>w.start.getTime()))-pad),new Date(Math.max(...all.map(w=>w.end.getTime()))+pad));
 const latest=await get();if(digest(latest.map((r:any)=>[r.id,r.revision]).sort())!==digest(rows.map((r:any)=>[r.id,r.revision]).sort()))throw new TRPCError({code:'CONFLICT',message:'Participant availability changed during the check. Retry.'});
 return {...commonAvailability({...input,busy:busy.busy}),googleChecked:true};
}
