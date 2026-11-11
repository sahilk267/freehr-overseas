import { createHmac, timingSafeEqual } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { approvals, automationQueue, invoices, payments, workflowEvents, workspaceSettings } from '../../drizzle/schema';
import { createId, recordAudit, requireDb } from '../db';
import { withWorkspaceTransaction } from './database';
import { commercialEvent } from './commercialAgreements';
import { appendWorkflowEvent, workflowHash } from './workflowStore';
import { recordInvoicePaymentInTransaction } from './invoicing';
import { stopRelatedFollowUps } from './followups';

const collectible = ['issued','delivered','payment_pending','partially_paid','overdue'];
const fail = (message:string) => new TRPCError({code:'PRECONDITION_FAILED',message});
const requestType = 'payment.checkout_requested';
const accountFingerprint=()=>workflowHash(config().key);
export function stripeConfiguration() {
  const key = process.env.STRIPE_SECRET_KEY || '', secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const mode = process.env.STRIPE_MODE || 'test';
  let origin = '';
  try { const url = new URL(process.env.APP_BASE_URL || ''); if(url.protocol==='https:'&&!url.username&&!url.password) origin=url.origin; } catch {}
  const configured = ['test','live'].includes(mode) && key.startsWith(`sk_${mode}_`) && key.length>16 && secret.startsWith('whsec_') && secret.length>16 && !!origin && (mode!=='live'||process.env.STRIPE_LIVE_PAYMENTS_ENABLED==='true');
  return {configured, mode, key, secret, origin};
}
function config() { const c=stripeConfiguration(); if(!c.configured) throw fail('No payment gateway checkout adapter is configured. Configure Stripe keys, webhook and HTTPS application URL; live payments require explicit enablement.'); return c; }
class StripeRequestError extends Error {constructor(public status:number){super('Stripe request was not confirmed. Retry the same checkout or reconcile; no payment was recorded.');}}
async function stripe(path:string, body?:URLSearchParams, key?:string) {
  const c=config();
  // Fixed provider origin; owner input can never choose a credential destination.
  const response=await fetch(`https://api.stripe.com/v1/${path}`, {method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${c.key}`,'Stripe-Version':'2024-06-20',...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(key?{'Idempotency-Key':key}:{})},body});
  if(!response.ok) throw new StripeRequestError(response.status);
  return response.json();
}
async function owned(tx:any,ownerId:number,id:string) {const i=(await tx.select().from(invoices).where(and(eq(invoices.ownerId,ownerId),eq(invoices.id,id))).limit(1))[0];if(!i)throw new TRPCError({code:'NOT_FOUND',message:'Invoice not found.'});return i;}
async function balance(tx:any,ownerId:number,i:any){const rows=await tx.select().from(payments).where(and(eq(payments.ownerId,ownerId),eq(payments.invoiceId,i.id),eq(payments.status,'succeeded')));if(rows.some((p:any)=>p.currency!==i.currency))throw fail('Invoice currency requires reconciliation.');const remaining=i.amount+i.taxAmount-rows.reduce((n:number,p:any)=>n+p.amount,0);if(!Number.isSafeInteger(remaining)||remaining<0)throw fail('Invoice balance requires reconciliation.');return remaining;}
async function reviewOpen(tx:any,ownerId:number,id:string){const rows=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,id),eq(workflowEvents.eventType,'payment.review_required')));for(const row of rows)if(!await commercialEvent(tx,ownerId,'payment.review_resolved',row.metadata.intentId))return true;return false;}
async function eligible(tx:any,ownerId:number,i:any){if(!collectible.includes(i.status))throw fail('Invoice is not eligible for checkout.');if(await reviewOpen(tx,ownerId,i.id))throw fail('An unresolved provider payment requires reconciliation.');const pending=await tx.select().from(approvals).where(and(eq(approvals.ownerId,ownerId),eq(approvals.resourceId,i.id),eq(approvals.status,'pending')));if(pending.some((a:any)=>['invoice_dispute','invoice_credit','invoice_write_off'].includes(a.actionType)))throw fail('A financial adjustment is awaiting review.');const amount=await balance(tx,ownerId,i);if(amount<=0)throw fail('This invoice has already been marked as paid.');return amount;}

/** Persist the exact request before network I/O. Retries reuse its key and body. */
export async function createStripeCheckout(ownerId:number,invoiceId:string) {
  const c=config();
  const intent=await withWorkspaceTransaction(ownerId,async tx=>{
    const i=await owned(tx,ownerId,invoiceId), amount=await eligible(tx,ownerId,i);
    // Our canonical ledger uses two decimal places. Reject other exponents, rather than charge the wrong unit.
    if(!['INR','USD','EUR','GBP','AUD','CAD','SGD','AED'].includes(i.currency))throw fail('Checkout currency is not supported by this two-decimal ledger.');
    const history=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,requestType)));
    const previous=history.filter((e:any)=>e.metadata.invoiceId===invoiceId);
    for(const p of previous){const terminal=await commercialEvent(tx,ownerId,'payment.checkout_terminal',p.aggregateId);if(!terminal){if(p.metadata.amount!==amount||p.metadata.currency!==i.currency||p.metadata.mode!==c.mode||p.metadata.origin!==c.origin||p.metadata.accountFingerprint!==accountFingerprint())throw fail('Existing checkout must be reconciled or expired before changing its amount or account mode.');return {...p.metadata,intentId:p.aggregateId,createdAt:p.createdAt};}}
    const intentId=createId('chk_'), expiresAt=Math.floor(Date.now()/1000)+3600;
    const m={intentId,ownerId,invoiceId,amount,currency:i.currency,mode:c.mode,origin:c.origin,successUrl:`${c.origin}/payment-return`,cancelUrl:`${c.origin}/payment-return`,accountFingerprint:accountFingerprint(),expiresAt,invoiceNumber:i.invoiceNumber};
    await appendWorkflowEvent(tx,ownerId,requestType,intentId,1,m);
    await recordAudit({ownerId,actorType:'user',actorId:String(ownerId),action:'payment.checkout_requested',resourceType:'invoice',resourceId:invoiceId,metadata:{intentId,amount,currency:i.currency,mode:c.mode}},tx);
    return {...m,createdAt:new Date()};
  });
  const known=await withWorkspaceTransaction(ownerId,tx=>commercialEvent(tx,ownerId,'payment.checkout_created',intent.intentId));
  if(known) { await withWorkspaceTransaction(ownerId,tx=>enqueueStripeReconciliation(tx,ownerId,invoiceId,intent.intentId)); if(!known.metadata.url)throw fail('Recovered session has no reusable checkout URL; reconcile its status.'); if(known.metadata.expiresAt*1000<=Date.now())throw fail('Checkout has expired. Reconcile its provider status before creating another.'); return {intentId:intent.intentId,url:String(known.metadata.url),expiresAt:known.metadata.expiresAt,mode:c.mode}; }
  // Stripe may evict idempotency keys after 24 hours. Never reissue an uncertain older command.
  if(Date.now()-new Date(intent.createdAt).getTime()>23*3600000||intent.expiresAt*1000-Date.now()<31*60000)throw fail('Unconfirmed checkout requires provider reconciliation; its original request cannot be safely repeated.');
  const body=new URLSearchParams({mode:'payment',client_reference_id:intent.intentId,success_url:intent.successUrl??`${intent.origin}/finance?checkout=returned`,cancel_url:intent.cancelUrl??`${intent.origin}/finance?checkout=cancelled`,expires_at:String(intent.expiresAt),'line_items[0][quantity]':'1','line_items[0][price_data][currency]':intent.currency.toLowerCase(),'line_items[0][price_data][unit_amount]':String(intent.amount),'line_items[0][price_data][product_data][name]':`Invoice ${intent.invoiceNumber}`,'metadata[intentId]':intent.intentId,'payment_intent_data[metadata][intentId]':intent.intentId});
  let session:any;
  try {session=await stripe('checkout/sessions',body,`freehr-${intent.intentId}`);}catch(error){
    // Authentication/validation rejection confirms no session was created. Network,
    // throttling and server failures retain the original uncertain command.
    if(error instanceof StripeRequestError&&[400,401,403,404,422].includes(error.status))await withWorkspaceTransaction(ownerId,tx=>appendWorkflowEvent(tx,ownerId,'payment.checkout_terminal',intent.intentId,1,{invoiceId,status:'creation_rejected',httpStatus:error.status}));
    throw fail('Stripe checkout was not confirmed. Retry or reconcile the original request; no payment was recorded.');
  }
  validateSession(session,intent);
  let url:URL;try{url=new URL(session.url);}catch{throw fail('Provider returned no valid checkout URL. Reconcile before retrying.');}
  if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com'||url.username||url.password)throw fail('Provider checkout URL is invalid.');
  await withWorkspaceTransaction(ownerId,async tx=>{await appendWorkflowEvent(tx,ownerId,'payment.checkout_created',intent.intentId,1,{invoiceId,sessionId:session.id,url:url.href,expiresAt:session.expires_at});await enqueueStripeReconciliation(tx,ownerId,invoiceId,intent.intentId);});
  return {intentId:intent.intentId,url:url.href,expiresAt:session.expires_at,mode:c.mode};
}
function validateSession(s:any,i:any){if(!s||typeof s.id!=='string'||!/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(s.id)||s.object!=='checkout.session'||s.mode!=='payment'||s.client_reference_id!==i.intentId||s.metadata?.intentId!==i.intentId||s.amount_total!==i.amount||s.currency!==i.currency.toLowerCase()||s.livemode!==(i.mode==='live')||!Number.isSafeInteger(s.expires_at))throw fail('Provider session does not match the persisted invoice checkout.');}
export function verifyStripeSignature(raw:Buffer,header:string|undefined,secret:string,now=Date.now()) {
  if(!header||raw.length>256*1024)throw Error('Invalid webhook signature.');
  const fields=header.split(',').map(x=>x.split('=')), timestamps=fields.filter(x=>x[0]==='t');
  if(timestamps.length!==1||!/^\d+$/.test(timestamps[0][1]))throw Error('Invalid webhook signature.');
  const timestamp=Number(timestamps[0][1]);if(Math.abs(now/1000-timestamp)>300)throw Error('Expired webhook signature.');
  const expected=createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest();
  if(!fields.some(([k,v])=>k==='v1'&&/^[a-f0-9]{64}$/i.test(v||'')&&timingSafeEqual(expected,Buffer.from(v,'hex'))))throw Error('Invalid webhook signature.');
}
async function requestForIntent(intentId:string){if(!/^chk_[A-Za-z0-9_-]+$/.test(intentId))return null;const db=await requireDb();return (await db.select().from(workflowEvents).where(and(eq(workflowEvents.eventType,requestType),eq(workflowEvents.aggregateId,intentId))).limit(1))[0]??null;}

/** Provider receipt and canonical invoice allocation commit together under the owner lock. */
async function observeSession(ownerId:number,intentId:string,session:any,eventId:string,outcome?:string,automatic=false) {
  return withWorkspaceTransaction(ownerId,async tx=>{
    if(automatic){const workspace=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0];if(!workspace?.backgroundEnabled||workspace.emergencyStop)return {status:'paused'};}
    const req=await commercialEvent(tx,ownerId,requestType,intentId);if(!req)throw fail('Checkout request was not found.');const intent=req.metadata;if(intent.accountFingerprint!==accountFingerprint())throw fail('Provider credential changed; reconcile using the original account credential.');
    validateSession(session,intent);
    const known=await commercialEvent(tx,ownerId,'payment.checkout_created',intentId);
    if(known&&known.metadata.sessionId!==session.id)throw fail('Provider session differs from the original checkout.');
    const i=await owned(tx,ownerId,intent.invoiceId);
    if(outcome==='checkout.session.async_payment_failed'&&session.payment_status==='unpaid'){await appendWorkflowEvent(tx,ownerId,'payment.checkout_terminal',intentId,1,{invoiceId:i.id,status:'payment_failed',sessionId:session.id,eventId});return {status:'payment_failed'};}
    if(session.status==='expired'&&session.payment_status==='unpaid') {await appendWorkflowEvent(tx,ownerId,'payment.checkout_terminal',intentId,1,{invoiceId:i.id,status:'expired',sessionId:session.id,eventId});return {status:'expired'};}
    if(session.payment_status!=='paid'||session.status!=='complete')return {status:'pending'};
    if(typeof session.payment_intent!=='string'||!/^pi_[A-Za-z0-9_]+$/.test(session.payment_intent))throw fail('Paid session is missing its payment intent.');
    const verified=await commercialEvent(tx,ownerId,'payment.provider_verified',intentId);
    if(verified){if(verified.metadata.paymentIntentId!==session.payment_intent)throw fail('Checkout already has a different verified receipt.');return {status:'recorded',alreadyRecorded:true};}
    if(intent.mode==='test'){await appendWorkflowEvent(tx,ownerId,'payment.checkout_terminal',intentId,1,{invoiceId:i.id,status:'sandbox_paid',sessionId:session.id,eventId});return {status:'sandbox_paid',bankSettlementVerified:false};}
    const remaining=await balance(tx,ownerId,i);
    const adjustments=await tx.select().from(approvals).where(and(eq(approvals.ownerId,ownerId),eq(approvals.resourceId,i.id),eq(approvals.status,'pending')));
    const mismatch=!collectible.includes(i.status)||i.currency!==intent.currency||remaining<intent.amount||adjustments.some((a:any)=>['invoice_dispute','invoice_credit','invoice_write_off'].includes(a.actionType));
    await appendWorkflowEvent(tx,ownerId,'payment.provider_observed',intentId,1,{invoiceId:i.id,sessionId:session.id,paymentIntentId:session.payment_intent,amount:intent.amount,currency:intent.currency,eventId,mode:intent.mode,bankSettlementVerified:false});
    if(mismatch){await appendWorkflowEvent(tx,ownerId,'payment.review_required',i.id,1,{intentId,reason:'Verified provider receipt cannot be allocated to the current invoice balance.',amount:intent.amount,currency:intent.currency},intentId);await stopRelatedFollowUps(tx,ownerId,{resourceType:'invoice',resourceId:i.id},'Provider payment requires reconciliation.','paused');return {status:'review_required'};}
    const result=await recordInvoicePaymentInTransaction(tx,i.id,ownerId,{amount:intent.amount,provider:'stripe_verified',providerEventId:session.payment_intent});
    await appendWorkflowEvent(tx,ownerId,'payment.provider_verified',intentId,1,{invoiceId:i.id,paymentId:result.paymentId,paymentIntentId:session.payment_intent,sessionId:session.id,eventId,bankSettlementVerified:false,mode:intent.mode});
    await appendWorkflowEvent(tx,ownerId,'payment.review_resolved',intentId,1,{invoiceId:i.id,paymentId:result.paymentId});
    await appendWorkflowEvent(tx,ownerId,'payment.checkout_terminal',intentId,1,{invoiceId:i.id,status:'paid',sessionId:session.id});
    await recordAudit({ownerId,actorType:'system',action:'payment.provider_verified',resourceType:'invoice',resourceId:i.id,metadata:{intentId,paymentId:result.paymentId,amount:intent.amount,currency:intent.currency,mode:intent.mode,bankSettlementVerified:false}},tx);
    return {status:'recorded',alreadyRecorded:result.alreadyRecorded};
  });
}
export async function processStripeWebhook(raw:Buffer,signature:string|undefined){
  const c=stripeConfiguration();if(!c.configured)return {statusCode:503,body:{error:'Payment provider is not configured.'}};
  let e:any;try{verifyStripeSignature(raw,signature,c.secret);e=JSON.parse(raw.toString('utf8'));if(!e||typeof e.id!=='string'||!/^evt_[A-Za-z0-9_]+$/.test(e.id)||e.livemode!==(c.mode==='live')||typeof e.type!=='string')throw Error();}catch{return {statusCode:400,body:{error:'Invalid signed payment event.'}};}
  if(['charge.refunded','charge.dispute.created','charge.dispute.funds_withdrawn'].includes(e.type))return observeProviderAdjustment(e);
  if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'].includes(e.type))return {statusCode:200,body:{status:'ignored'}};
  try {const session=e.data?.object,req=await requestForIntent(session?.metadata?.intentId||'');if(!req)return {statusCode:422,body:{error:'Unknown checkout request.'}};const result=await observeSession(req.ownerId,req.aggregateId,session,e.id,e.type);return {statusCode:200,body:result};}catch{return {statusCode:503,body:{error:'Payment event requires retry or reconciliation.'}};}
}
export async function invoiceCheckoutStatus(ownerId:number,invoiceId:string){return withWorkspaceTransaction(ownerId,async tx=>{await owned(tx,ownerId,invoiceId);const rows=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,requestType)));const checkouts=[];for(const r of rows.filter((e:any)=>e.metadata.invoiceId===invoiceId)){const created=await commercialEvent(tx,ownerId,'payment.checkout_created',r.aggregateId),verified=await commercialEvent(tx,ownerId,'payment.provider_verified',r.aggregateId),terminal=await commercialEvent(tx,ownerId,'payment.checkout_terminal',r.aggregateId),observed=await commercialEvent(tx,ownerId,'payment.provider_observed',r.aggregateId);checkouts.push({intentId:r.aggregateId,amount:r.metadata.amount,currency:r.metadata.currency,mode:r.metadata.mode,sessionId:created?.metadata.sessionId??null,url:created?.metadata.url??null,status:verified?'provider_paid':observed?'review_required':terminal?.metadata.status??'pending',bankSettlementVerified:false});}const reviewRows=await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,invoiceId),eq(workflowEvents.eventType,'payment.review_required')));const reviews=[];for(const r of reviewRows)if(!await commercialEvent(tx,ownerId,'payment.review_resolved',r.metadata.intentId))reviews.push({reviewId:r.metadata.intentId,reason:String(r.metadata.reason),amount:r.metadata.amount,currency:r.metadata.currency});const recovery=await tx.select().from(automationQueue).where(and(eq(automationQueue.ownerId,ownerId),eq(automationQueue.jobType,'stripe_payment_reconcile')));const recoveryTasks=recovery.filter((j:any)=>j.payload?.invoiceId===invoiceId).map((j:any)=>({intentId:j.payload.intentId,status:j.status,scheduledAt:j.scheduledAt,attempts:j.attempts,lastError:j.lastError}));const c=stripeConfiguration();return {configured:c.configured,mode:c.mode,checkouts,reviews,recoveryTasks};});}
export async function reconcileStripeCheckout(ownerId:number,invoiceId:string,intentId:string,sessionId?:string,automatic=false){
  const req=await requestForIntent(intentId);if(!req||req.ownerId!==ownerId||req.metadata.invoiceId!==invoiceId)throw new TRPCError({code:'NOT_FOUND',message:'Owned checkout was not found.'});
  if(automatic){const workspace=(await (await requireDb()).select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,ownerId)).limit(1))[0];if(!workspace?.backgroundEnabled||workspace.emergencyStop)return {status:'paused'};}
  const c=config();if(req.metadata.mode!==c.mode)throw fail('Provider account mode differs from the original checkout.');
  const created=await withWorkspaceTransaction(ownerId,tx=>commercialEvent(tx,ownerId,'payment.checkout_created',intentId));
  const providerSession=created?.metadata.sessionId??sessionId;
  if(typeof providerSession!=='string'||!/^cs_[A-Za-z0-9_]+$/.test(providerSession))throw fail('Provide the session ID from the original Stripe idempotency request.');
  const session=await stripe(`checkout/sessions/${encodeURIComponent(providerSession)}`);
  validateSession(session,req.metadata);
  if(!created)await withWorkspaceTransaction(ownerId,tx=>appendWorkflowEvent(tx,ownerId,'payment.checkout_created',intentId,1,{invoiceId,sessionId:session.id,url:null,expiresAt:session.expires_at}));
  const result=await observeSession(ownerId,intentId,session,automatic?'managed_provider_reconciliation':'owner_provider_reconciliation',undefined,automatic);
  if(!automatic&&result.status==='pending')await withWorkspaceTransaction(ownerId,tx=>enqueueStripeReconciliation(tx,ownerId,invoiceId,intentId,true));
  return result;
}

async function observeProviderAdjustment(event:any){
 try {
  const object=event.data?.object,paymentIntentId=object?.payment_intent;
  if(typeof paymentIntentId!=='string'||!/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId))return {statusCode:200,body:{status:'unmatched_adjustment'}};
  const db=await requireDb(),verified=await db.select().from(workflowEvents).where(eq(workflowEvents.eventType,'payment.provider_verified'));
  const source=verified.find((r:any)=>r.metadata.paymentIntentId===paymentIntentId&&r.metadata.mode===(event.livemode?'live':'test'));
  if(!source)return {statusCode:200,body:{status:'unmatched_adjustment'}};
  await withWorkspaceTransaction(source.ownerId,async tx=>{
   const reviewId=workflowHash(['stripe_adjustment',event.id]),invoiceId=source.metadata.invoiceId;
   const previous=await commercialEvent(tx,source.ownerId,'payment.adjustment_observed',reviewId);if(previous)return;
   const req=await commercialEvent(tx,source.ownerId,requestType,source.aggregateId);
   if(req?.metadata.accountFingerprint!==accountFingerprint())throw fail('Provider credential changed.');
   const amount=event.type==='charge.refunded'?object.amount_refunded:object.amount;
   if(!Number.isSafeInteger(amount)||amount<=0||typeof object.currency!=='string')throw fail('Adjustment amount requires provider reconciliation.');
   await appendWorkflowEvent(tx,source.ownerId,'payment.adjustment_observed',reviewId,1,{invoiceId,eventId:event.id,type:event.type,paymentIntentId,amount,currency:object.currency.toUpperCase(),automaticallyAllocated:false});
   await appendWorkflowEvent(tx,source.ownerId,'payment.review_required',invoiceId,1,{intentId:reviewId,sourceCheckoutId:source.aggregateId,reason:'Provider refund or dispute requires financial adjustment review.',eventId:event.id,amount,currency:object.currency.toUpperCase()},reviewId);
   await stopRelatedFollowUps(tx,source.ownerId,{resourceType:'invoice',resourceId:invoiceId},'Provider refund or dispute requires financial review.','paused');
   await recordAudit({ownerId:source.ownerId,actorType:'system',action:'payment.adjustment_observed',resourceType:'invoice',resourceId:invoiceId,metadata:{eventId:event.id,type:event.type,reviewId,amount,currency:object.currency}},tx);
  });return {statusCode:200,body:{status:'review_required'}};
 }catch{return {statusCode:503,body:{error:'Payment adjustment requires retry or reconciliation.'}};}
}

/** One durable recovery task per checkout on the existing managed queue. */
async function enqueueStripeReconciliation(tx:any,ownerId:number,invoiceId:string,intentId:string,ownerRecovered=false){
 const key=`stripe-reconcile:${intentId}`;
 const existing=(await tx.select().from(automationQueue).where(eq(automationQueue.idempotencyKey,key)).limit(1))[0];
 if(existing){if(ownerRecovered&&existing.ownerId===ownerId&&existing.status==='blocked')await tx.update(automationQueue).set({status:'queued',attempts:0,scheduledAt:new Date(Date.now()+5*60000),lastError:null,lockedAt:null,lockToken:null}).where(eq(automationQueue.id,existing.id));return;}
 if(await commercialEvent(tx,ownerId,'payment.checkout_terminal',intentId))return;
 await tx.insert(automationQueue).values({id:createId('que_'),ownerId,jobType:'stripe_payment_reconcile',status:'queued',priority:25,attempts:0,maxAttempts:5,scheduledAt:new Date(Date.now()+5*60000),idempotencyKey:key,payload:{invoiceId,intentId}});
}
export async function executeStripeReconciliation(ownerId:number,payload:any){
 if(typeof payload?.invoiceId!=='string'||typeof payload?.intentId!=='string')throw new TRPCError({code:'BAD_REQUEST',message:'Invalid payment recovery source.'});
 const req=await requestForIntent(payload.intentId);
 if(!req||req.ownerId!==ownerId||req.metadata.invoiceId!==payload.invoiceId)throw new TRPCError({code:'NOT_FOUND',message:'Owned payment recovery source was not found.'});
 const terminal=await withWorkspaceTransaction(ownerId,tx=>commercialEvent(tx,ownerId,'payment.checkout_terminal',payload.intentId));
 if(terminal)return {status:'completed',providerStatus:terminal.metadata.status};
 if(Date.now()-new Date(req.createdAt).getTime()>7*86400000)throw fail('Automatic payment recovery reached its seven-day limit. Reconcile the original provider session.');
 try {
  const result=await reconcileStripeCheckout(ownerId,payload.invoiceId,payload.intentId,undefined,true);
  if(['pending','paused'].includes(result.status))return {status:'deferred',nextActionAt:new Date(Date.now()+15*60000),providerStatus:result.status};
  return result;
 }catch(error){if(error instanceof TRPCError)throw error;throw new TRPCError({code:'BAD_GATEWAY',message:'Provider payment recovery was not confirmed. The existing task will retry within its bounded attempt budget.'});}
}
