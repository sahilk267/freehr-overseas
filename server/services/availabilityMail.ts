import {pendingConfirmationForMail} from "./interviewConfirmations";
import {randomBytes} from 'node:crypto';
import {and,desc,eq} from 'drizzle-orm';
import {TRPCError} from '@trpc/server';
import {interviewConfirmations,availabilityInvites as invites,approvals,candidates,contacts,conversations,emailDispatches,emailIdentities,jobs,messages,suppressionList,workflowEvents} from '../../drizzle/schema';
import {createId,hashContactValue,recordAudit,requireDb} from '../db';
import {withWorkspaceTransaction} from './database';
import {appendWorkflowEvent,workflowHash} from './workflowStore';
import {requireSchedulableCandidate} from './interviewScheduling';
import {hasCandidateCommunicationPermission} from './communicationPermission';
import {emailContentHash} from './emailAuthorization';
import {CONFIRMATION_LINK_MARKER,AVAILABILITY_LINK_MARKER,availabilityMailKeyId,availabilityMailOrigin,availabilityMailToken,availabilityTokenHash,type AvailabilityMailScope} from './availabilityMailScope';
type Purpose=AvailabilityMailScope["purpose"];
const fail=(message:string)=>new TRPCError({code:'PRECONDITION_FAILED',message});
async function invite(tx:any,ownerId:number,id:string,now:Date,purpose?:Purpose){if(purpose==='interview_confirmation')return pendingConfirmationForMail(tx,ownerId,id,now);if(purpose!==undefined)throw fail('Private link purpose is unsupported.');const row=(await tx.select().from(invites).where(and(eq(invites.ownerId,ownerId),eq(invites.id,id))).limit(1))[0];if(!row)throw new TRPCError({code:'NOT_FOUND',message:'Owned availability request is required.'});if(row.status!=='pending'||new Date(row.expiresAt)<=now||row.submissionCount)throw fail('Availability request is expired, revoked, submitted or booked. No link email can be sent.');await requireSchedulableCandidate(tx,ownerId,row.candidateId);return {...row};}
async function recipient(tx:any,ownerId:number,row:any,conversationId:string,now:Date){
 const c=(await tx.select().from(conversations).where(and(eq(conversations.ownerId,ownerId),eq(conversations.id,conversationId))).limit(1))[0],job=(await tx.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,row.jobId))).limit(1))[0];
 if(!c||c.channel!=='email'||['closed','archived','opted_out'].includes(c.status)||!job||['cancelled','archived','filled','paused'].includes(job.pipelineState)||(c.companyId&&c.companyId!==job.companyId)||(c.jobId&&c.jobId!==job.id))throw fail('Select an active email conversation for this job/client.');
 let address:string;
 if(row.participant==='candidate'){
  if(c.candidateId!==row.candidateId||c.contactId)throw fail('Candidate availability must use this candidate conversation.');
  const candidate=(await tx.select().from(candidates).where(and(eq(candidates.ownerId,ownerId),eq(candidates.id,row.candidateId))).limit(1))[0];
  if(!candidate?.email||!(await hasCandidateCommunicationPermission(tx,ownerId,row.candidateId,row.jobId,['recruitment_communication','interview_processing'],now)))throw fail('Current interview/recruitment communication permission and candidate email are required.');address=candidate.email;
 }else{
  const contact=c.contactId?(await tx.select().from(contacts).where(and(eq(contacts.ownerId,ownerId),eq(contacts.id,c.contactId))).limit(1))[0]:null;
  if(c.companyId!==job.companyId||c.candidateId||!contact?.email||contact.companyId!==job.companyId||contact.optedOutAt||!['permitted','granted','consented'].includes(contact.contactPermission))throw fail('Interviewer availability requires a permitted contact from this client.');address=contact.email;
 }
 address=address.trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))throw fail('Recipient address must be valid.');
 if((await tx.select().from(suppressionList).where(and(eq(suppressionList.ownerId,ownerId),eq(suppressionList.channel,'email'),eq(suppressionList.valueHash,hashContactValue(address)),eq(suppressionList.active,true)))).length)throw fail('Recipient is suppressed.');return address;
}
export async function availabilityMailOptions(ownerId:number,id:string,purpose?:Purpose){const db=await requireDb(),row=await invite(db,ownerId,id,new Date(),purpose),job=(await db.select().from(jobs).where(and(eq(jobs.ownerId,ownerId),eq(jobs.id,row.jobId))).limit(1))[0];if(!job)throw new TRPCError({code:'NOT_FOUND'});const all=await db.select().from(conversations).where(and(eq(conversations.ownerId,ownerId),row.participant==='candidate'?eq(conversations.candidateId,row.candidateId):eq(conversations.companyId,job.companyId))).orderBy(desc(conversations.updatedAt)).limit(100);const recipients:Array<{conversationId:string;recipient:string}>=[];for(const c of all){try{recipients.push({conversationId:c.id,recipient:await recipient(db,ownerId,row,c.id,new Date())});}catch(e){if(!(e instanceof TRPCError))throw e;}}const senders=(await db.select().from(emailIdentities).where(and(eq(emailIdentities.ownerId,ownerId),eq(emailIdentities.status,'active'),eq(emailIdentities.purpose,'interviews')))).map((s:any)=>({id:s.id,email:s.email}));return {recipients,senders};}
export async function prepareAvailabilityEmail(ownerId:number,actorId:number,input:{inviteId:string;conversationId:string;senderIdentityId:string},purpose?:Purpose){
 return withWorkspaceTransaction(ownerId,async tx=>{
  const eventType=purpose?'interview.confirmation_email_requested':'availability.email_requested';
  const requestHash=workflowHash([input.inviteId,input.conversationId,input.senderIdentityId,...(purpose?[purpose]:[])]);const old=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,input.inviteId),eq(workflowEvents.eventType,eventType))).limit(1))[0];
  if(old){if(old.metadata?.requestHash!==requestHash)throw new TRPCError({code:'CONFLICT',message:'A different link email is already prepared. Use its approval or revoke and recreate the request.'});return {messageId:String(old.metadata.messageId),approvalId:String(old.metadata.approvalId),alreadyExists:true};}
  const now=new Date(),row=await invite(tx,ownerId,input.inviteId,now,purpose),address=await recipient(tx,ownerId,row,input.conversationId,now),sender=(await tx.select().from(emailIdentities).where(and(eq(emailIdentities.ownerId,ownerId),eq(emailIdentities.id,input.senderIdentityId))).limit(1))[0];
  if(!sender||sender.status!=='active'||sender.purpose!=='interviews')throw fail('An active interview sender is required.');
  const scope:AvailabilityMailScope={...(purpose?{purpose}:{}),ownerId,inviteId:row.id,groupId:row.groupId,revision:purpose?1:row.revision+1,participant:row.participant,nonce:randomBytes(24).toString('base64url'),keyId:availabilityMailKeyId(),recipientHash:hashContactValue(address),appOrigin:availabilityMailOrigin()};
  const token=availabilityMailToken(scope),messageId=createId('msg_'),approvalId=createId('apr_'),dispatchId=createId('dsp_');
  let subject='Share interview availability',body=`Please share your interview availability using your private link:\n\n${AVAILABILITY_LINK_MARKER}\n\nThis collects availability only and does not confirm an interview. Do not forward this link. Your recruiter will confirm scheduling separately. Reply STOP to opt out.`;
  if(purpose){subject='Confirm your interview time';body=`Please review and respond to your scheduled interview using your private link:\n\n${CONFIRMATION_LINK_MARKER}\n\nBoth participants must confirm the exact time. If you need another time, select that option; your recruiter will arrange rescheduling. This is an attendance response, not an offer acceptance or identity verification. Do not forward this link. Reply STOP to opt out.`;}
  if(purpose)await tx.update(interviewConfirmations).set({tokenHash:availabilityTokenHash(token)}).where(eq(interviewConfirmations.id,row.id));
  else await tx.update(invites).set({tokenHash:availabilityTokenHash(token),revision:scope.revision}).where(eq(invites.id,row.id));
  await tx.insert(messages).values({id:messageId,ownerId,conversationId:input.conversationId,direction:'outbound',status:'approval_pending',subject,body,deliveredAt:null,idempotencyKey:'email:'+messageId,aiGenerated:false});
  await tx.insert(approvals).values({id:approvalId,ownerId,requestedBy:'user',actionType:'email_send',resourceType:'message',resourceId:messageId,status:'pending',actionedAt:null,reason:purpose?'Review recipient and the current interview schedule. Dispatch replaces this participant’s manual confirmation link. Only the participant response can confirm attendance.':'Review recipient and availability purpose. Dispatch generates the private link and replaces this participant’s earlier manual link. No interview is confirmed.',payload:{senderIdentityId:sender.id,senderAddress:sender.email,senderPurpose:sender.purpose,recipient:address,privateLink:scope,contentHash:emailContentHash({senderIdentityId:sender.id,recipient:address,subject,body,privateLink:scope})}});
  await tx.insert(emailDispatches).values({id:dispatchId,ownerId,messageId,approvalId,recipientHash:scope.recipientHash,status:'queued',scheduledAt:now,planId:null,planRevision:null,stepIndex:null,grantId:null});
  await appendWorkflowEvent(tx,ownerId,eventType,row.id,1,{requestHash,messageId,approvalId});
  await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:purpose?'interview.confirmation_email_prepared':'availability.email_prepared',resourceType:'availability_invite',resourceId:row.id,metadata:{approvalId,messageId,participant:row.participant}},tx);
  return {messageId,approvalId,alreadyExists:false};
 });
}
export async function materializeAvailabilityEmail(tx:any,ownerId:number,payload:{recipient?:string;privateLink?:AvailabilityMailScope},message:{conversationId:string;body:string},now=new Date()){
 const scope=payload.privateLink;if(!scope)return message.body;
 if(scope.ownerId!==ownerId||!payload.recipient||scope.recipientHash!==hashContactValue(payload.recipient))throw fail('Private link recipient binding changed.');
 const row=await invite(tx,ownerId,scope.inviteId,now,scope.purpose);if(row.groupId!==scope.groupId||row.revision!==scope.revision||row.participant!==scope.participant)throw fail('Availability link revision changed.');
 const address=await recipient(tx,ownerId,row,message.conversationId,now);if(address!==payload.recipient.trim().toLowerCase())throw fail('Conversation recipient changed.');
 const marker=scope.purpose?CONFIRMATION_LINK_MARKER:AVAILABILITY_LINK_MARKER;
 const token=availabilityMailToken(scope);if(availabilityTokenHash(token)!==row.tokenHash||message.body.split(marker).length!==2)throw fail('Private availability link authorization changed.');
 return message.body.replace(marker,`${scope.appOrigin}/${scope.purpose?"interview-response":"availability"}#${row.id}.${token}`);
}

export async function revokePreparedPrivateLink(tx:any,ownerId:number,scope:AvailabilityMailScope){
 const table=scope.purpose==='interview_confirmation'?interviewConfirmations:invites;
 const link=(await tx.select().from(table).where(and(eq(table.ownerId,ownerId),eq(table.id,scope.inviteId))).limit(1))[0];
 if(link?.status==='pending'&&link.groupId===scope.groupId&&link.participant===scope.participant&&(scope.purpose?scope.revision===1:link.revision===scope.revision))await tx.update(table).set({status:'revoked',tokenHash:'',...(scope.purpose?{}:{revision:link.revision+1})}).where(eq(table.id,link.id));
}
