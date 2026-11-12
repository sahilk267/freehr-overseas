import {TRPCError} from '@trpc/server';
import {and,desc,eq,inArray} from 'drizzle-orm';
import {z} from 'zod';
import {approvals,automationQueue,contacts,conversations,emailDispatches,emailIdentities,followUpPlans,incidents,invoices,jobs,messages,placements,workflowEvents,workspaceSettings} from '../../drizzle/schema';
import {createId,recordAudit,requireDb} from '../db';
import {assertTransition} from '../workflow';
import {withWorkspaceTransaction} from './database';
import {commercialEvent} from './commercialAgreements';
import {commercialContext} from './commercialObligations';
import {hasCandidateCommunicationPermission,hasClientCommunicationPermission} from './communicationPermission';
import {enrollFollowUpInTransaction,stopRelatedFollowUps} from './followups';
import {appendWorkflowEvent,workflowHash} from './workflowStore';
import {lifecycleContext,lifecyclePlacement,lifecyclePlanId,placementCheckpointState,placementLifecycleFingerprint,prejoiningStates,retentionStates} from './placementLifecycleState';
const id=z.string().min(4).max(36),reason=z.string().trim().min(8).max(2000),fail=(message:string)=>new TRPCError({code:'PRECONDITION_FAILED',message});
export const lifecyclePlanInput=z.object({placementId:id,stage:z.enum(['prejoining','retention']),expectedRevision:z.number().int().min(0),enabled:z.boolean(),autoPrepare:z.boolean().default(false),anchorAt:z.date().optional(),responseWindowHours:z.number().int().min(1).max(168).default(48),checkpoints:z.array(z.object({dayOffset:z.number().int().min(-90).max(365),label:z.string().trim().min(3).max(160)}).strict()).min(1).max(20),recipients:z.array(z.object({party:z.enum(['candidate','client']),conversationId:id,senderIdentityId:id}).strict()).max(6),reason}).strict();
async function timer(tx:any,ownerId:number,c:any,kind:'due'|'expiry',at:Date){const key=`placement-checkpoint:${c.id}:${kind}`;if((await tx.select().from(automationQueue).where(eq(automationQueue.idempotencyKey,key)).limit(1))[0])return;await tx.insert(automationQueue).values({id:createId('que_'),ownerId,jobType:'placement_checkpoint',status:'queued',priority:20,maxAttempts:3,scheduledAt:at,idempotencyKey:key,payload:{checkpointId:c.id,candidateId:c.candidateId,placementId:c.placementId,kind}});}
async function checkpointEvents(tx:any,ownerId:number,placementId:string){const rows=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,'placement.lifecycle_checkpoint')));return rows.filter((r:any)=>r.metadata?.placementId===placementId);}
async function cancelOldCheckpoints(tx:any,ownerId:number,placementId:string,stage:string){for(const row of await checkpointEvents(tx,ownerId,placementId)){if(row.metadata.stage!==stage)continue;await stopRelatedFollowUps(tx,ownerId,{resourceType:'placement_checkpoint',resourceId:row.aggregateId},'Placement checkpoint plan changed.','cancelled');await tx.update(automationQueue).set({status:'cancelled',lockToken:null,lockedAt:null,lastError:'Placement checkpoint plan changed.'}).where(and(eq(automationQueue.ownerId,ownerId),inArray(automationQueue.idempotencyKey,[`placement-checkpoint:${row.aggregateId}:due`,`placement-checkpoint:${row.aggregateId}:expiry`]),inArray(automationQueue.status,['queued','retryable_failed','blocked'])));await resolveCheckpointIncident(tx,ownerId,row.aggregateId,'Checkpoint plan changed.');}}
async function validateRecipient(tx:any,ownerId:number,p:any,r:any,stage:string){
 const thread=(await tx.select().from(conversations).where(and(eq(conversations.ownerId,ownerId),eq(conversations.id,r.conversationId))).limit(1))[0],sender=(await tx.select().from(emailIdentities).where(and(eq(emailIdentities.ownerId,ownerId),eq(emailIdentities.id,r.senderIdentityId))).limit(1))[0];
 if(!thread||thread.channel!=='email'||thread.companyId!==p.companyId||thread.jobId&&thread.jobId!==p.jobId||['closed','archived','opted_out'].includes(thread.status)||!sender||sender.status!=='active'||sender.purpose!=='talent')throw fail('Choose a current placement email conversation and active talent sender.');
 if(r.party==='candidate'){if(thread.candidateId!==p.candidateId||thread.contactId||!await hasCandidateCommunicationPermission(tx,ownerId,p.candidateId,p.jobId,stage==='retention'?['post_placement_communication']:['recruitment_communication']))throw fail('Current purpose-specific candidate communication permission is required. Retention needs post-placement permission.');}
 else{const contact=(await tx.select().from(contacts).where(and(eq(contacts.ownerId,ownerId),eq(contacts.id,thread.contactId??''))).limit(1))[0];if(thread.candidateId||!contact||contact.companyId!==p.companyId||!await hasClientCommunicationPermission(tx,ownerId,contact.id))throw fail('Choose a permitted client contact from this placement’s company.');}
}
async function seedCheckpoints(tx:any,ownerId:number,p:any,plan:any){
 const m=plan.metadata;if(!m.enabled)return;
 const anchor=m.stage==='retention'?p.joiningConfirmedAt:m.anchorAt?new Date(m.anchorAt):null;
 if(m.stage==='retention'&&retentionStates.includes(p.status)&&!p.joiningConfirmedAt)throw fail('Confirmed joining evidence must include the actual joining date.');
 if(!anchor||m.stage==='retention'&&!retentionStates.includes(p.status))return;
 const anchorAt=new Date(anchor);if(!Number.isFinite(anchorAt.getTime()))throw fail('Placement anchor date is invalid.');
 for(const item of m.checkpoints)for(const recipient of m.recipients){
  const checkpointId=workflowHash([plan.aggregateId,plan.revision,anchorAt.toISOString(),item.dayOffset,recipient.conversationId]).slice(0,36);
  if(await commercialEvent(tx,ownerId,'placement.lifecycle_checkpoint',checkpointId))continue;
  const dueAt=new Date(anchorAt.getTime()+item.dayOffset*86400000),deadlineAt=new Date(dueAt.getTime()+m.responseWindowHours*3600000);
  const checkpoint={id:checkpointId,planId:plan.aggregateId,planRevision:plan.revision,placementId:p.id,candidateId:p.candidateId,jobId:p.jobId,stage:m.stage,placementFingerprint:placementLifecycleFingerprint(p),label:item.label,dayOffset:item.dayOffset,...recipient,dueAt:dueAt.toISOString(),deadlineAt:deadlineAt.toISOString(),autoPrepare:m.autoPrepare};
  await appendWorkflowEvent(tx,ownerId,'placement.lifecycle_checkpoint',checkpointId,1,checkpoint);
  await timer(tx,ownerId,checkpoint,'due',dueAt);await timer(tx,ownerId,checkpoint,'expiry',deadlineAt);
 }
}
export async function configurePlacementLifecycle(ownerId:number,actorId:number,raw:z.input<typeof lifecyclePlanInput>){const input=lifecyclePlanInput.parse(raw);return withWorkspaceTransaction(ownerId,async tx=>{
 const p=await lifecyclePlacement(tx,ownerId,input.placementId);await lifecycleContext(tx,ownerId,p);
 const planId=lifecyclePlanId(p.id,input.stage),old=await commercialEvent(tx,ownerId,'placement.lifecycle_plan',planId),hash=workflowHash(input);
 if(old?.revision===input.expectedRevision+1&&old.metadata.requestHash===hash)return {revision:old.revision,alreadySaved:true};
 if((old?.revision??0)!==input.expectedRevision)throw new TRPCError({code:'CONFLICT',message:'Placement plan changed. Reload its current version.'});
 if(input.enabled){if(input.stage==='prejoining'&&!prejoiningStates.includes(p.status)||input.stage==='retention'&&![...prejoiningStates,...retentionStates].includes(p.status))throw fail('This placement is not eligible for the requested lifecycle stage.');
  if(input.stage==='prejoining'&&(!input.anchorAt||input.anchorAt<=new Date()||input.anchorAt.getTime()>Date.now()+365*86400000))throw fail('Use a future intended joining date within one year.');
  if(input.stage==='retention'&&input.anchorAt)throw fail('Retention anchors to actual confirmed joining, never a planned date.');
  if(input.checkpoints.some(i=>(input.stage==='retention'&&i.dayOffset<0||input.stage==='prejoining'&&i.dayOffset>0))||new Set(input.checkpoints.map(i=>i.dayOffset)).size!==input.checkpoints.length)throw fail('Use unique checkpoint day offsets; retention offsets cannot be negative and prejoining offsets cannot be positive.');
  if(!input.recipients.length||new Set(input.recipients.map(r=>r.conversationId)).size!==input.recipients.length)throw fail('Choose at least one distinct recipient conversation.');
  for(const r of input.recipients)await validateRecipient(tx,ownerId,p,r,input.stage);
 }
 await cancelOldCheckpoints(tx,ownerId,p.id,input.stage);
 const revision=(old?.revision??0)+1,m={...input,anchorAt:input.anchorAt?.toISOString()??null,candidateId:p.candidateId,requestHash:hash,actorId,identityVerified:false};
 await appendWorkflowEvent(tx,ownerId,'placement.lifecycle_plan',planId,revision,m);
 await seedCheckpoints(tx,ownerId,p,{aggregateId:planId,revision,metadata:m});
 await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'placement.lifecycle_plan_saved',resourceType:'placement',resourceId:p.id,metadata:{stage:input.stage,revision,enabled:input.enabled,autoPrepare:input.autoPrepare}},tx);
 return {revision,alreadySaved:false};
});}
/** Called in the canonical confirmed-joining approval transaction. */
export async function activatePlacementRetention(tx:any,ownerId:number,p:any){await cancelOldCheckpoints(tx,ownerId,p.id,'prejoining');const plan=await commercialEvent(tx,ownerId,'placement.lifecycle_plan',lifecyclePlanId(p.id,'retention'));if(plan?.metadata?.enabled){await lifecycleContext(tx,ownerId,p);await seedCheckpoints(tx,ownerId,p,plan);}}
async function resolveCheckpointIncident(tx:any,ownerId:number,id:string,note:string){await tx.update(incidents).set({status:'resolved',resolvedAt:new Date(),containmentNotes:note}).where(and(eq(incidents.ownerId,ownerId),eq(incidents.affectedResourceType,'placement_checkpoint'),eq(incidents.affectedResourceId,id),eq(incidents.status,'detected'),inArray(incidents.incidentType,['placement_checkpoint_due','placement_checkin_review_overdue'])));}
async function escalate(tx:any,ownerId:number,c:any,kind:string,summary:string){const incidentId=workflowHash(['placement.lifecycle',ownerId,c.id,kind]).slice(0,36);if(!(await tx.select().from(incidents).where(and(eq(incidents.ownerId,ownerId),eq(incidents.id,incidentId))).limit(1))[0])await tx.insert(incidents).values({id:incidentId,ownerId,incidentType:kind,severity:kind==='placement_risk'?'high':'medium',status:'detected',affectedResourceType:'placement_checkpoint',affectedResourceId:c.id,summary});return incidentId;}
async function prepareCheckpoint(tx:any,ownerId:number,actorId:number,id:string){
 const state=await placementCheckpointState(tx,ownerId,id);if(state.state!=='eligible')throw fail(state.reason);if(state.dueAt>new Date())throw fail('This checkpoint is not due yet.');
 const c=state.checkpoint,p=await lifecyclePlacement(tx,ownerId,c.placementId);await validateRecipient(tx,ownerId,p,c,c.stage);
 const prior=await commercialEvent(tx,ownerId,'placement.lifecycle_followup',id);if(prior)return {planId:String(prior.metadata.followupPlanId),alreadyExists:true};
 const result=await enrollFollowUpInTransaction(tx,ownerId,{scenarioId:c.stage==='retention'?'FU24':'FU22',conversationId:c.conversationId,senderIdentityId:c.senderIdentityId,resourceType:'placement_checkpoint',resourceId:id,objective:c.label,timezone:(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0].businessTimezone,deadlineAt:new Date(c.deadlineAt),responseWindowMinutes:60,steps:[{delayMinutes:0,subject:c.stage==='retention'?'Placement check-in':'Prejoining check-in',body:`Please share an update for this recruitment checkpoint: ${c.label}. Let us know about any concerns or support you need. This check-in does not change employment or commercial terms. Reply STOP to opt out.`},{delayMinutes:60,subject:'Check-in reminder',body:`Following up on this recruitment checkpoint: ${c.label}. Please reply when convenient. Reply STOP to opt out.`}]},actorId);
 await appendWorkflowEvent(tx,ownerId,'placement.lifecycle_followup',id,1,{candidateId:c.candidateId,placementId:c.placementId,followupPlanId:result.id});
 return {planId:result.id,alreadyExists:false};
}
export async function preparePlacementCheckpoint(ownerId:number,actorId:number,id:string){return withWorkspaceTransaction(ownerId,tx=>prepareCheckpoint(tx,ownerId,actorId,id));}
export async function executePlacementCheckpoint(ownerId:number,payload:any){
 if(typeof payload?.checkpointId!=='string'||!['due','expiry'].includes(payload.kind))throw Error('Invalid placement checkpoint task.');
 return withWorkspaceTransaction(ownerId,async tx=>{
  const workspace=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0];if(!workspace?.backgroundEnabled||workspace.emergencyStop)return {status:'deferred',nextActionAt:new Date(Date.now()+60000)};
  const event=await commercialEvent(tx,ownerId,'placement.lifecycle_checkpoint',payload.checkpointId);if(!event||event.metadata?.redacted)return {status:'cancelled'};
  const c=event.metadata,state=await placementCheckpointState(tx,ownerId,event.aggregateId),done=await commercialEvent(tx,ownerId,'placement.lifecycle_processed_'+payload.kind,event.aggregateId);
  if(done)return {status:'completed'};
  if(state.state!=='eligible'&&(payload.kind!=='expiry'||state.reason!=='Placement checkpoint response window expired.')){await stopRelatedFollowUps(tx,ownerId,{resourceType:'placement_checkpoint',resourceId:event.aggregateId},state.reason??'Checkpoint closed.',state.state==='completed'?'completed':'cancelled');return {status:state.state};}
  const at=new Date(payload.kind==='expiry'?c.deadlineAt:c.dueAt);if(at>new Date())return {status:'deferred',nextActionAt:at};
  if(payload.kind==='due'&&new Date(c.deadlineAt)<=new Date())return {status:'expired'};
  let prepared:any=null;if(payload.kind==='due'&&c.autoPrepare){try{prepared=await prepareCheckpoint(tx,ownerId,ownerId,event.aggregateId);}catch(e){if(!(e instanceof TRPCError))throw e;prepared={blocked:true,reason:e.message};}}
  const incidentId=await escalate(tx,ownerId,{...c,id:event.aggregateId},payload.kind==='expiry'?'placement_checkin_review_overdue':'placement_checkpoint_due',payload.kind==='expiry'?'Placement check-in requires owner review. No employment outcome has been inferred.':prepared?.blocked?'Placement check-in outreach is blocked; review permission, sender and source.':'Placement check-in is due. Review the prepared outreach or record evidence.');
  if(payload.kind==='expiry')await stopRelatedFollowUps(tx,ownerId,{resourceType:'placement_checkpoint',resourceId:event.aggregateId},'Placement check-in response window ended.','cancelled');
  await appendWorkflowEvent(tx,ownerId,'placement.lifecycle_processed_'+payload.kind,event.aggregateId,1,{candidateId:c.candidateId,placementId:c.placementId,incidentId,prepared});
  await recordAudit({ownerId,actorType:'cron',action:'placement.lifecycle_checkpoint_processed',resourceType:'placement',resourceId:c.placementId,metadata:{checkpointId:event.aggregateId,kind:payload.kind,incidentId}},tx);
  return {status:'review_required',incidentId};
 });
}
export const checkpointResponseInput=z.object({checkpointId:id,outcome:z.enum(['on_track','concern','left','blocked','not_applicable']),satisfaction:z.number().int().min(1).max(5).optional(),evidence:reason,sourceParty:z.enum(['candidate','client','owner'])}).strict();
export async function recordPlacementCheckpoint(ownerId:number,actorId:number,raw:z.input<typeof checkpointResponseInput>){const input=checkpointResponseInput.parse(raw),hash=workflowHash(input);return withWorkspaceTransaction(ownerId,async tx=>{
 const event=await commercialEvent(tx,ownerId,'placement.lifecycle_checkpoint',input.checkpointId);if(!event||event.metadata?.redacted)throw new TRPCError({code:'NOT_FOUND',message:'Owned checkpoint was not found.'});const c=event.metadata,p=await lifecyclePlacement(tx,ownerId,c.placementId);await lifecycleContext(tx,ownerId,p);
 const old=await commercialEvent(tx,ownerId,'placement.lifecycle_response',input.checkpointId);if(old){if(old.metadata.requestHash!==hash)throw new TRPCError({code:'CONFLICT',message:'A different response is already recorded. Preserve the original evidence and open an owner exception for correction.'});return {alreadyRecorded:true};}
 if(new Date(c.dueAt)>new Date())throw fail('Do not record a checkpoint response before its due date.');
 const plan=await commercialEvent(tx,ownerId,'placement.lifecycle_plan',c.planId);if(!plan?.metadata.enabled||plan.revision!==c.planRevision||placementLifecycleFingerprint(p)!==c.placementFingerprint||!(c.stage==='prejoining'?prejoiningStates:retentionStates).includes(p.status))throw fail('Checkpoint source changed; do not attach a response to superseded employment facts.');
 await appendWorkflowEvent(tx,ownerId,'placement.lifecycle_response',input.checkpointId,1,{...input,candidateId:p.candidateId,placementId:p.id,requestHash:hash,actorId,recordedAt:new Date().toISOString(),method:'owner_recorded',identityVerified:false});
 await stopRelatedFollowUps(tx,ownerId,{resourceType:'placement_checkpoint',resourceId:input.checkpointId},'A placement checkpoint response was recorded.','completed');await resolveCheckpointIncident(tx,ownerId,input.checkpointId,'Owner recorded checkpoint evidence.');
 if(['concern','left','blocked'].includes(input.outcome)||input.satisfaction!==undefined&&input.satisfaction<=2)await escalate(tx,ownerId,{...c,id:input.checkpointId},'placement_risk','Owner-recorded placement concern requires review. No termination, replacement obligation or payment action was inferred.');
 await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'placement.lifecycle_response_recorded',resourceType:'placement',resourceId:p.id,metadata:{checkpointId:input.checkpointId,outcome:input.outcome,identityVerified:false}},tx);
 return {alreadyRecorded:false};
});}
export const departureInput=z.object({placementId:id,expectedPlacementFingerprint:z.string().length(64),expectedDepartureRevision:z.number().int().min(0),departedAt:z.date(),evidence:reason,reason:z.enum(['resigned','client_ended','did_not_continue','other'])}).strict();
export async function recordPlacementDeparture(ownerId:number,actorId:number,raw:z.input<typeof departureInput>){const input=departureInput.parse(raw),hash=workflowHash(input);return withWorkspaceTransaction(ownerId,async tx=>{
 const p=await lifecyclePlacement(tx,ownerId,input.placementId);await lifecycleContext(tx,ownerId,p,false);const old=await commercialEvent(tx,ownerId,'placement.lifecycle_departure',p.id);if(old?.metadata.requestHash===hash)return {revision:old.revision,alreadyRecorded:true};
 if((old?.revision??0)!==input.expectedDepartureRevision)throw new TRPCError({code:'CONFLICT',message:'Departure evidence changed. Reload the current evidence version.'});
 if(placementLifecycleFingerprint(p)!==input.expectedPlacementFingerprint)throw new TRPCError({code:'CONFLICT',message:'Placement facts changed. Reload before recording departure.'});
 if(!p.joiningConfirmedAt||input.departedAt<p.joiningConfirmedAt||input.departedAt>new Date()||!['joining_confirmed','invoice_eligible','guarantee_active','guarantee_ended'].includes(p.status))throw fail('Record an actual departure after confirmed joining; future or closed-placement departures are not accepted.');
 const revision=(old?.revision??0)+1;await appendWorkflowEvent(tx,ownerId,'placement.lifecycle_departure',p.id,revision,{...input,departedAt:input.departedAt.toISOString(),candidateId:p.candidateId,recordedAt:new Date().toISOString(),requestHash:hash,actorId,method:'owner_recorded',identityVerified:false});
 for(const c of await checkpointEvents(tx,ownerId,p.id))await stopRelatedFollowUps(tx,ownerId,{resourceType:'placement_checkpoint',resourceId:c.aggregateId},'Departure evidence recorded; stop routine placement check-ins.','cancelled');
 await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'placement.departure_recorded',resourceType:'placement',resourceId:p.id,metadata:{revision,reason:input.reason,identityVerified:false}},tx);return {revision,alreadyRecorded:false};
});}
const jobSnapshot=(j:any)=>({companyId:j.companyId,feeProposalId:j.feeProposalId,title:j.title,department:j.department,employmentType:j.employmentType,location:j.location,workModel:j.workModel,compensationMin:j.compensationMin,compensationMax:j.compensationMax,currency:j.currency,experienceMinYears:j.experienceMinYears,experienceMaxYears:j.experienceMaxYears,mustHaveSkills:j.mustHaveSkills,niceToHaveSkills:j.niceToHaveSkills,scorecard:j.scorecard,intake:j.intake,requirementQuality:j.requirementQuality,targetJoiningAt:j.targetJoiningAt?.toISOString()??null});
export async function replacementSource(tx:any,ownerId:number,p:any){
 const {job}=await lifecycleContext(tx,ownerId,p,false),departure=await commercialEvent(tx,ownerId,'placement.lifecycle_departure',p.id),commercial=await commercialContext(tx,ownerId,p),existing=await commercialEvent(tx,ownerId,'replacement.workflow_opened',p.id);
 const invoicesForPlacement=await tx.select().from(invoices).where(and(eq(invoices.ownerId,ownerId),eq(invoices.placementId,p.id)));
 const source={placement:placementLifecycleFingerprint(p),job:jobSnapshot(job),departure:departure?{revision:departure.revision,requestHash:departure.metadata.requestHash}:null,termsHash:commercial.enabled?commercial.binding.termsHash:null,invoices:invoicesForPlacement.map((i:any)=>i.id).sort()};
 const recorded=departure&&!departure.metadata.redacted,departed=recorded?new Date(departure.metadata.departedAt):null,reported=recorded?new Date(departure.metadata.recordedAt):null;
 const guaranteeConsistent=!commercial.enabled||p.joiningConfirmedAt&&p.guaranteeStartAt&&p.guaranteeEndAt&&p.guaranteeStartAt.getTime()===p.joiningConfirmedAt.getTime()&&p.guaranteeEndAt.getTime()-p.guaranteeStartAt.getTime()===commercial.terms.guaranteeDays*86400000;
 const eligible=guaranteeConsistent&&commercial.enabled&&!existing&&['joining_confirmed','invoice_eligible','guarantee_active'].includes(p.status)&&!!p.guaranteeStartAt&&!!p.guaranteeEndAt&&p.guaranteeEndAt>p.guaranteeStartAt&&departed&&departed>=p.guaranteeStartAt&&departed<p.guaranteeEndAt&&reported&&reported<=p.guaranteeEndAt;
 return {fingerprint:workflowHash(source),eligible:Boolean(eligible),existingJobId:existing?.metadata.jobId??null,reason:existing?'A replacement workflow already exists.':!eligible?'Use a frozen accepted placement agreement, record departure within its explicit guarantee and report before its end. Legacy placements require commercial-source review; exclusions still need owner review.':null,job,departure,termsHash:source.termsHash,invoiceIds:source.invoices};
}
export const replacementRequestInput=z.object({placementId:id,expectedSourceFingerprint:z.string().length(64),reason,guaranteePolicy:z.enum(['original_window','no_new_guarantee'])}).strict();
export async function requestReplacementWorkflow(ownerId:number,actorId:number,raw:z.input<typeof replacementRequestInput>){const input=replacementRequestInput.parse(raw),requestHash=workflowHash(input);return withWorkspaceTransaction(ownerId,async tx=>{
 const p=await lifecyclePlacement(tx,ownerId,input.placementId),s=await replacementSource(tx,ownerId,p),prior=await commercialEvent(tx,ownerId,'replacement.requested',p.id);
 if(prior?.metadata.requestHash===requestHash)return {approvalId:String(prior.metadata.approvalId),alreadyExists:true};
 if(s.fingerprint!==input.expectedSourceFingerprint)throw new TRPCError({code:'CONFLICT',message:'Replacement source changed. Reload the contract, departure and billing references.'});if(!s.eligible)throw fail(s.reason??'Replacement source is ineligible.');
 if(prior){const approval=(await tx.select().from(approvals).where(and(eq(approvals.ownerId,ownerId),eq(approvals.id,prior.metadata.approvalId))).limit(1))[0];if(approval&&['pending','approved'].includes(approval.status))throw new TRPCError({code:'CONFLICT',message:'A replacement request is already pending or approved.'});}
 const pending=(await tx.select().from(approvals).where(and(eq(approvals.ownerId,ownerId),eq(approvals.resourceId,p.id),eq(approvals.actionType,'replacement_case'),eq(approvals.status,'pending'))).limit(1))[0];if(pending)throw new TRPCError({code:'CONFLICT',message:'An existing replacement approval must be reviewed or rejected before a new case.'});
 const approvalId=createId('apr_');await tx.insert(approvals).values({id:approvalId,ownerId,requestedBy:'user',actionType:'replacement_case',resourceType:'placement',resourceId:p.id,status:'pending',reason:'Review actual departure, original engagement exclusions, invoice references and the explicitly selected replacement guarantee. No client signature or legal eligibility is inferred.',payload:{reason:input.reason,lifecycleReplacement:{sourceFingerprint:s.fingerprint,guaranteePolicy:input.guaranteePolicy}}});
 await appendWorkflowEvent(tx,ownerId,'replacement.requested',p.id,(prior?.revision??0)+1,{approvalId,requestHash,sourceFingerprint:s.fingerprint,candidateId:p.candidateId,actorId});
 await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'replacement.requested',resourceType:'placement',resourceId:p.id,metadata:{approvalId,sourceFingerprint:s.fingerprint}},tx);return {approvalId,alreadyExists:false};
});}
/** Runs inside the existing replacement_case owner-approval transaction. */
export async function applyReplacementWorkflow(tx:any,approval:any,at:Date,actorId?:number){
 const scope=approval.payload?.lifecycleReplacement;if(!scope)return false;
 const p=await lifecyclePlacement(tx,approval.ownerId,approval.resourceId),existing=await commercialEvent(tx,approval.ownerId,'replacement.workflow_opened',p.id);if(existing){if(existing.metadata.approvalId!==approval.id)throw fail('A different approved replacement already owns this obligation.');return true;}
 const s=await replacementSource(tx,approval.ownerId,p);if(!s.eligible||s.fingerprint!==scope.sourceFingerprint||!['original_window','no_new_guarantee'].includes(scope.guaranteePolicy))throw fail('Replacement approval is stale or its guarantee policy is missing. Review the current source before approval.');
 const jobId=createId('job_'),snapshot=jobSnapshot(s.job);await tx.insert(jobs).values({...snapshot,targetJoiningAt:snapshot.targetJoiningAt?new Date(snapshot.targetJoiningAt):null,id:jobId,ownerId:approval.ownerId,title:`Replacement: ${s.job.title}`.slice(0,200),pipelineState:'draft',clientConfirmedAt:null,clientConfirmedBy:null});
 const marker={sourcePlacementId:p.id,sourceJobId:p.jobId,excludedCandidateId:p.candidateId,candidateId:p.candidateId,originalInvoiceIds:s.invoiceIds,originalTermsHash:s.termsHash,originalGuaranteeEndAt:p.guaranteeEndAt.toISOString(),guaranteePolicy:scope.guaranteePolicy,noNewPlacementFee:true,approvalId:approval.id,sourceFingerprint:s.fingerprint,openedAt:at.toISOString()};
 await appendWorkflowEvent(tx,approval.ownerId,'replacement.job_opened',jobId,1,marker);await appendWorkflowEvent(tx,approval.ownerId,'replacement.workflow_opened',p.id,1,{...marker,jobId});
 if(['joining_confirmed','invoice_eligible'].includes(p.status))assertTransition('placement',p.status,'guarantee_active');assertTransition('placement','guarantee_active','replacement_requested');assertTransition('placement','replacement_requested','replacement_in_progress');
 await tx.update(placements).set({status:'replacement_in_progress',replacementRequestedAt:at}).where(and(eq(placements.ownerId,approval.ownerId),eq(placements.id,p.id)));
 for(const c of await checkpointEvents(tx,approval.ownerId,p.id))await stopRelatedFollowUps(tx,approval.ownerId,{resourceType:'placement_checkpoint',resourceId:c.aggregateId},'Replacement workflow opened; routine check-ins ended.','cancelled');
 await recordAudit({ownerId:approval.ownerId,actorType:'user',actorId:String(actorId??approval.decidedById??approval.ownerId),action:'replacement.workflow_opened',resourceType:'placement',resourceId:p.id,metadata:{jobId,approvalId:approval.id,noNewPlacementFee:true,originalInvoiceIds:s.invoiceIds,guaranteePolicy:scope.guaranteePolicy}},tx);return true;
}
export async function placementLifecycleDetail(ownerId:number,id:string){return withWorkspaceTransaction(ownerId,async tx=>{
 const p=await lifecyclePlacement(tx,ownerId,id),plans=[];for(const stage of ['prejoining','retention']){const v=await commercialEvent(tx,ownerId,'placement.lifecycle_plan',lifecyclePlanId(p.id,stage));plans.push({stage,revision:v?.revision??0,config:v?.metadata??null});}
 const checkpoints=[];for(const c of await checkpointEvents(tx,ownerId,id)){const response=await commercialEvent(tx,ownerId,'placement.lifecycle_response',c.aggregateId),state=await placementCheckpointState(tx,ownerId,c.aggregateId),followup=await commercialEvent(tx,ownerId,'placement.lifecycle_followup',c.aggregateId);checkpoints.push({id:c.aggregateId,...c.metadata,status:response?'recorded':state.state,response:response?.metadata??null,followupPlanId:followup?.metadata.followupPlanId??null});}
 let replacement:any;try{const s=await replacementSource(tx,ownerId,p);replacement={eligible:s.eligible,fingerprint:s.fingerprint,reason:s.reason,existingJobId:s.existingJobId};}catch(e){if(!(e instanceof TRPCError))throw e;replacement={eligible:false,fingerprint:null,reason:e.message,existingJobId:null};}
 const departure=await commercialEvent(tx,ownerId,'placement.lifecycle_departure',id);return {placementId:id,candidateId:p.candidateId,jobId:p.jobId,status:p.status,placementFingerprint:placementLifecycleFingerprint(p),joiningConfirmedAt:p.joiningConfirmedAt,plans,checkpoints,departure:departure?{...departure.metadata,revision:departure.revision}:null,replacement};
});}
export async function placementLifecycleOptions(ownerId:number,id:string){return withWorkspaceTransaction(ownerId,async tx=>{
 const p=await lifecyclePlacement(tx,ownerId,id),context=await lifecycleContext(tx,ownerId,p);const rows=await tx.select().from(conversations).where(and(eq(conversations.ownerId,ownerId),eq(conversations.companyId,p.companyId)));const recipients=[];
 for(const c of rows){if(c.channel!=='email'||c.jobId&&c.jobId!==p.jobId||['closed','archived','opted_out'].includes(c.status))continue;if(c.candidateId===p.candidateId&&!c.contactId)recipients.push({conversationId:c.id,party:'candidate' as const,label:`Candidate: ${context.candidate.fullName} · ${context.candidate.email??'No email'}`});else if(c.contactId&&!c.candidateId&&await hasClientCommunicationPermission(tx,ownerId,c.contactId)){const person=(await tx.select().from(contacts).where(and(eq(contacts.ownerId,ownerId),eq(contacts.id,c.contactId))).limit(1))[0];if(person?.email)recipients.push({conversationId:c.id,party:'client' as const,label:`Client: ${person.name} · ${person.email}`});}}
 const senders=await tx.select().from(emailIdentities).where(and(eq(emailIdentities.ownerId,ownerId),eq(emailIdentities.purpose,'talent'),eq(emailIdentities.status,'active')));return {recipients,senders:senders.map((s:any)=>({id:s.id,email:s.email})),retentionConsentRequired:'post_placement_communication'};
});}

/** Redact checkpoint content even when its recipient is the client rather than the candidate. */
export async function erasePlacementLifecycleContent(ownerId:number,candidateId:string){return withWorkspaceTransaction(ownerId,async tx=>{
 const rows=await tx.select().from(workflowEvents).where(eq(workflowEvents.ownerId,ownerId));
 for(const event of rows){if(event.metadata?.candidateId!==candidateId)continue;
  if(event.eventType==='placement.lifecycle_checkpoint'){
   await stopRelatedFollowUps(tx,ownerId,{resourceType:'placement_checkpoint',resourceId:event.aggregateId},'Candidate erasure.','cancelled');
   const plans=await tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId,ownerId),eq(followUpPlans.resourceType,'placement_checkpoint'),eq(followUpPlans.resourceId,event.aggregateId)));
   for(const plan of plans){await tx.update(followUpPlans).set({objective:'Erased placement checkpoint',steps:[],reason:'Candidate erasure'}).where(eq(followUpPlans.id,plan.id));
    const dispatches=await tx.select().from(emailDispatches).where(and(eq(emailDispatches.ownerId,ownerId),eq(emailDispatches.planId,plan.id)));
    for(const d of dispatches){await tx.update(messages).set({body:'Candidate-related placement checkpoint content erased.',subject:'Erased placement checkpoint'}).where(and(eq(messages.ownerId,ownerId),eq(messages.id,d.messageId)));const approval=(await tx.select().from(approvals).where(and(eq(approvals.ownerId,ownerId),eq(approvals.id,d.approvalId))).limit(1))[0];if(approval)await tx.update(approvals).set({payload:{redacted:true},...(['pending','approved'].includes(approval.status)&&!approval.actionedAt?{status:'cancelled'}:{})}).where(eq(approvals.id,approval.id));}
   }
  }
  if(event.eventType==='replacement.requested'){const a=(await tx.select().from(approvals).where(and(eq(approvals.ownerId,ownerId),eq(approvals.id,event.metadata.approvalId))).limit(1))[0];if(a)await tx.update(approvals).set({payload:{reason:'Candidate evidence erased',lifecycleReplacement:{...a.payload?.lifecycleReplacement,redacted:true}},...(a.status==='pending'?{status:'cancelled'}:{})}).where(eq(approvals.id,a.id));}
 }
});}

export async function ensurePlacementConversations(ownerId:number,actorId:number,id:string){return withWorkspaceTransaction(ownerId,async tx=>{
 const p=await lifecyclePlacement(tx,ownerId,id),context=await lifecycleContext(tx,ownerId,p);if(![...prejoiningStates,...retentionStates].includes(p.status))throw fail('Only an active prejoining or retention placement can prepare conversations.');
 const people:any[]=[];
 if(context.candidate.email)people.push({party:'candidate',candidateId:p.candidateId,contactId:null});
 const clients=await tx.select().from(contacts).where(and(eq(contacts.ownerId,ownerId),eq(contacts.companyId,p.companyId)));
 for(const c of clients){if(people.length>=7)break;if(c.email&&await hasClientCommunicationPermission(tx,ownerId,c.id))people.push({party:'client',candidateId:null,contactId:c.id});}
 const result=[];
 for(const person of people){const existing=(await tx.select().from(conversations).where(and(eq(conversations.ownerId,ownerId),eq(conversations.companyId,p.companyId),eq(conversations.jobId,p.jobId),person.candidateId?eq(conversations.candidateId,person.candidateId):eq(conversations.contactId,person.contactId)))).find((c:any)=>c.channel==='email'&&!['closed','archived','opted_out'].includes(c.status));
  if(existing){result.push({id:existing.id,party:person.party,created:false});continue;}
  const conversationId=createId('cnv_');await tx.insert(conversations).values({id:conversationId,ownerId,companyId:p.companyId,jobId:p.jobId,candidateId:person.candidateId,contactId:person.contactId,channel:'email',status:'active'});result.push({id:conversationId,party:person.party,created:true});
 }
 await recordAudit({ownerId,actorType:'user',actorId:String(actorId),action:'placement.conversations_prepared',resourceType:'placement',resourceId:p.id,metadata:{created:result.filter(r=>r.created).length,messagesSent:0}},tx);
 return {conversations:result,messagesSent:0};
});}
