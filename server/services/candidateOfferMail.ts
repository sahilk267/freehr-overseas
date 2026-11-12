import {TRPCError} from '@trpc/server';
import {and,eq} from 'drizzle-orm';
import {emailDispatches,emailIdentities,messages,approvals,workflowEvents} from '../../drizzle/schema';
import {createId,hashContactValue,recordAudit} from '../db';
import {withWorkspaceTransaction} from './database';
import {commercialEvent} from './commercialAgreements';
import {releasedOffer} from './candidateOfferState';
import {emailContentHash} from './emailAuthorization';
import {OFFER_LINK_MARKER,OFFER_OTP_MARKER,offerLinkToken,offerOtp,offerOtpHash,type OfferMailScope} from './offerMailScope';
import {appendWorkflowEvent} from './workflowStore';
import {enqueueEmailDispatch} from './followups';
export async function materializeOfferEmail(tx:any,ownerId:number,payload:{recipient?:string;offerScope?:OfferMailScope},message:{conversationId:string;body:string},now=new Date()){
 const scope=payload.offerScope;if(!scope)return null;
 const r=await releasedOffer(tx,ownerId,scope.offerId,now,scope.kind==='offer_otp'),a=r.authority.metadata;
 if(scope.version!==r.offer.version||scope.termsHash!==r.offer.termsHash||scope.authorityRevision!==r.authority.revision||scope.recipientHash!==hashContactValue(r.context.candidate.email)||payload.recipient?.trim().toLowerCase()!==r.context.candidate.email.trim().toLowerCase()||message.conversationId!==r.offer.release.metadata.conversationId)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Offer mail source, version or recipient changed.'});
 if(scope.kind==='offer_link'){
  if(scope.nonce!==a.nonce||scope.keyId!==a.keyId||scope.origin!==a.origin||!message.body.includes(OFFER_LINK_MARKER))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Offer link authorization changed.'});
  return {body:message.body.replace(OFFER_LINK_MARKER,`${scope.origin}/offer-response#${scope.offerId}.${offerLinkToken(scope)}`),transactionalOtp:false};
 }
 const c=await commercialEvent(tx,ownerId,'offer.otp_created',scope.challengeId??''),current=await commercialEvent(tx,ownerId,'offer.otp_current',scope.offerId);
 if(!r.offer.release.metadata.allowOtpEmail||r.offer.release.metadata.transactionalOtp!==true||!c||current?.metadata.challengeId!==scope.challengeId||c.metadata.offerId!==scope.offerId||c.metadata.authorityRevision!==r.authority.revision||c.metadata.mailScopeHash!==emailContentHash({senderIdentityId:r.offer.release.metadata.senderIdentityId,recipient:payload.recipient!,subject:'Offer response verification code',body:OFFER_OTP_MARKER,offerScope:scope})||new Date(c.metadata.expiresAt).getTime()-now.getTime()<30000||!message.body.includes(OFFER_OTP_MARKER))throw new TRPCError({code:'PRECONDITION_FAILED',message:'Offer verification code is stale, expired or not explicitly authorized.'});
 const code=offerOtp(scope);if(offerOtpHash(scope.challengeId!,code)!==c.metadata.codeHash)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Offer verification configuration changed.'});
 return {body:message.body.replace(OFFER_OTP_MARKER,`Your offer response verification code is ${code}. It expires in 10 minutes. Use it only in the private offer page you opened. Do not share this code. If you did not request it, ignore this message.`),transactionalOtp:true};
}
export async function createOfferMail(tx:any,ownerId:number,actorId:number,r:any,scope:OfferMailScope,subject:string,body:string,automatic=false){
 const sender=(await tx.select().from(emailIdentities).where(and(eq(emailIdentities.ownerId,ownerId),eq(emailIdentities.id,r.offer.release.metadata.senderIdentityId))).limit(1))[0];
 if(!sender||sender.status!=='active'||sender.purpose!=='talent'||sender.email!==r.offer.release.metadata.senderAddress)throw new TRPCError({code:'PRECONDITION_FAILED',message:'The released offer’s talent sender changed.'});
 const recipient=r.context.candidate.email.trim().toLowerCase(),messageId=createId('msg_'),approvalId=createId('apr_'),dispatchId=createId('dsp_');
 const payload={senderIdentityId:sender.id,senderAddress:sender.email,senderPurpose:sender.purpose,recipient,offerScope:scope,contentHash:emailContentHash({senderIdentityId:sender.id,recipient,subject,body,offerScope:scope})};
 await tx.insert(messages).values({id:messageId,ownerId,conversationId:r.offer.release.metadata.conversationId,direction:'outbound',status:automatic?'authorized':'approval_pending',subject,body,deliveredAt:null,idempotencyKey:'email:'+messageId,aiGenerated:false});
 await tx.insert(approvals).values({id:approvalId,ownerId,requestedBy:automatic?'system':'user',actionType:'email_send',resourceType:'message',resourceId:messageId,status:automatic?'approved':'pending',actionedAt:null,reason:automatic?'Transactional one-time verification mail within the exact owner-approved offer release, recipient and bounded code policy.':'Review the current offer version, candidate recipient and private reply link.',payload,...(automatic?{decisionSource:'policy',decidedById:ownerId,decidedAt:new Date()}: {})});
 await tx.insert(emailDispatches).values({id:dispatchId,ownerId,messageId,approvalId,recipientHash:scope.recipientHash,status:'queued',scheduledAt:new Date(),planId:null,planRevision:null,stepIndex:null,grantId:null});
 if(automatic)await enqueueEmailDispatch(tx,ownerId,dispatchId,new Date());
 await appendWorkflowEvent(tx,ownerId,'offer.mail_prepared',scope.offerId,scope.version,{candidateId:r.p.candidateId,messageId,approvalId,dispatchId,kind:scope.kind,challengeId:scope.challengeId??null,authorityRevision:scope.authorityRevision},messageId);
 await recordAudit({ownerId,actorType:automatic?'system':'user',actorId:String(actorId),action:'offer.mail_prepared',resourceType:'placement',resourceId:r.p.id,metadata:{offerId:scope.offerId,kind:scope.kind,messageId,approvalId}},tx);
 return {messageId,approvalId,dispatchId};
}
export async function prepareOfferLinkEmail(ownerId:number,actorId:number,id:string){return withWorkspaceTransaction(ownerId,async tx=>{
 const r=await releasedOffer(tx,ownerId,id),rows=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'offer.mail_prepared'),eq(workflowEvents.aggregateId,id))),prior=rows.find((e:any)=>e.metadata.kind==='offer_link'&&e.revision===r.offer.version&&e.metadata.authorityRevision===r.authority.revision);
 if(prior)return {messageId:prior.metadata.messageId,approvalId:prior.metadata.approvalId,dispatchId:prior.metadata.dispatchId,alreadyExists:true};
 const scope:OfferMailScope={...r.authority.metadata,kind:'offer_link',offerId:id,version:r.offer.version,termsHash:r.offer.termsHash,authorityRevision:r.authority.revision,recipientHash:r.offer.release.metadata.recipientHash};
 return {...await createOfferMail(tx,ownerId,actorId,r,scope,'Review your offer and respond privately',`Please review the employer-provided offer terms using your private page:\n\n${OFFER_LINK_MARKER}\n\nYou will verify possession of your email address before viewing or responding. The portal records your exact-version response; it does not provide a qualified electronic signature. Do not forward the link. Reply STOP to opt out.`),alreadyExists:false};
});}
export async function recordOfferMailAccepted(tx:any,ownerId:number,scope:OfferMailScope|undefined,messageId:string){if(scope?.kind==='offer_link')await appendWorkflowEvent(tx,ownerId,'offer.link_shared',scope.offerId,scope.version,{messageId,authorityRevision:scope.authorityRevision,method:'provider_accepted',recipientHash:scope.recipientHash,actualDeliveryVerified:false},messageId);}
