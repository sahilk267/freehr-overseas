import {and,desc,eq} from 'drizzle-orm';
import {consents,contacts,workflowEvents} from '../../drizzle/schema';
import {lockedSelect} from './database';
export async function hasCandidateCommunicationPermission(tx:any,ownerId:number,candidateId:string,jobId:string|null|undefined,allowedTypes:readonly string[],now=new Date()){
 const grants=await lockedSelect(tx.select().from(consents).where(and(eq(consents.ownerId,ownerId),eq(consents.candidateId,candidateId),eq(consents.status,'granted'))));
 return grants.some((consent:typeof consents.$inferSelect)=>allowedTypes.includes(consent.consentType)&&(!consent.expiresAt||consent.expiresAt>now)&&(!consent.jobId||consent.jobId===jobId));
}

/** Shared contact permission and latest recorded expiry gate for campaigns and transactional replies. */
export async function hasClientCommunicationPermission(tx: any, ownerId: number, contactId: string, now = new Date()) {
 const contact = (await tx.select().from(contacts).where(and(eq(contacts.ownerId, ownerId), eq(contacts.id, contactId))).limit(1))[0];
 if (!contact || contact.optedOutAt || !['granted', 'permitted', 'consented'].includes(contact.contactPermission)) return false;
 const permission = (await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.eventType, 'communication.permission_recorded'), eq(workflowEvents.aggregateId, contactId))).orderBy(desc(workflowEvents.revision)).limit(1))[0];
 const expiry = permission?.metadata?.expiresAt;
 return !expiry || (Number.isFinite(new Date(expiry).getTime()) && new Date(expiry) > now);
}
