import {TRPCError} from '@trpc/server';
import {and,asc,eq,exists,inArray,lte} from 'drizzle-orm';
import {clientDiscoveryRequests as requests,incidents,workspaceSettings} from '../../drizzle/schema';
import {recordAudit,requireDb} from '../db';
import {withWorkspaceTransaction} from './database';
import {assertDiscoverySource,resolveDiscoveryIncidents,stopDiscoveryRequestWork} from './clientDiscovery';
import {appendWorkflowEvent,workflowHash} from './workflowStore';

/** Shared worker source: closes capabilities, never cancels a booked meeting or sends a chase. */
export async function processDueDiscoveryDeadlines(ownerId?:number,limit=10){
 const db=await requireDb(),conditions=[lte(requests.expiresAt,new Date()),inArray(requests.status,['pending','responded']),exists(db.select({id:workspaceSettings.ownerId}).from(workspaceSettings).where(and(eq(workspaceSettings.ownerId,requests.ownerId),eq(workspaceSettings.backgroundEnabled,true),eq(workspaceSettings.emergencyStop,false))))];
 if(ownerId!==undefined)conditions.push(eq(requests.ownerId,ownerId));
 const due=await db.select().from(requests).where(and(...conditions)).orderBy(asc(requests.expiresAt),asc(requests.id)).limit(Math.min(25,Math.max(1,limit)));let escalated=0,skipped=0;
 for(const item of due){const result=await withWorkspaceTransaction(item.ownerId,async tx=>{
  const settings=(await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,item.ownerId)).limit(1))[0];
  if(!settings?.backgroundEnabled||settings.emergencyStop)return 'skipped';
  const found=(await tx.select().from(requests).where(and(eq(requests.ownerId,item.ownerId),eq(requests.id,item.id))).limit(1))[0];
  if(!found||!['pending','responded'].includes(found.status)||new Date(found.expiresAt)>new Date())return 'skipped';
  const r={...found};let current=true;
  try{await assertDiscoverySource(tx,item.ownerId,r);}catch(e){if(!(e instanceof TRPCError)||!['NOT_FOUND','CONFLICT','PRECONDITION_FAILED'].includes(e.code))throw e;current=false;}
  await tx.update(requests).set({status:'expired',tokenHash:'',revision:r.revision+1}).where(and(eq(requests.ownerId,item.ownerId),eq(requests.id,r.id)));
  await stopDiscoveryRequestWork(tx,item.ownerId,r,'Client discovery request expired.');
  if(!current){await resolveDiscoveryIncidents(tx,item.ownerId,r.id,'Client reply, action or communication permission changed.');await appendWorkflowEvent(tx,item.ownerId,'discovery.expiry_skipped',r.id,r.revision+1,{reason:'stale_source'});return 'skipped';}
  // Reuse the request's no-slot incident so a single failed scheduling attempt has one case.
  const existing=(await tx.select().from(incidents).where(and(eq(incidents.ownerId,item.ownerId),eq(incidents.affectedResourceId,r.id),inArray(incidents.incidentType,['client_discovery_no_slots','client_discovery_expired']))).limit(1))[0];
  const id=existing?.id??workflowHash(['discovery.deadline',item.ownerId,r.id]).slice(0,36),summary='Client discovery request expired before a meeting was booked. Review the latest reply and create a fresh availability request.';
  if(existing)await tx.update(incidents).set({incidentType:'client_discovery_expired',status:'detected',resolvedAt:null,summary}).where(and(eq(incidents.ownerId,item.ownerId),eq(incidents.id,id)));
  else await tx.insert(incidents).values({id,ownerId:item.ownerId,incidentType:'client_discovery_expired',severity:'medium',status:'detected',affectedResourceType:'client_discovery',affectedResourceId:r.id,summary,detectedAt:new Date()});
  await appendWorkflowEvent(tx,item.ownerId,'discovery.expired',r.id,r.revision+1,{incidentId:id,clientResponded:r.status==='responded'});
  await recordAudit({ownerId:item.ownerId,actorType:'cron',action:'discovery.deadline_escalated',resourceType:'client_discovery',resourceId:r.id,metadata:{incidentId:id}},tx);return 'escalated';
 });if(result==='escalated')escalated++;else skipped++;}
 return {scanned:due.length,escalated,skipped};
}
