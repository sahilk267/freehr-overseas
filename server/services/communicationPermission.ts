import {and,eq} from 'drizzle-orm';
import {consents} from '../../drizzle/schema';
import {lockedSelect} from './database';
export async function hasCandidateCommunicationPermission(tx:any,ownerId:number,candidateId:string,jobId:string|null|undefined,allowedTypes:readonly string[],now=new Date()){
 const grants=await lockedSelect(tx.select().from(consents).where(and(eq(consents.ownerId,ownerId),eq(consents.candidateId,candidateId),eq(consents.status,'granted'))));
 return grants.some((consent:typeof consents.$inferSelect)=>allowedTypes.includes(consent.consentType)&&(!consent.expiresAt||consent.expiresAt>now)&&(!consent.jobId||consent.jobId===jobId));
}
