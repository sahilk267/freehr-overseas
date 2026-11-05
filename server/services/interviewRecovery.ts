import {and,eq} from 'drizzle-orm';
import {TRPCError} from '@trpc/server';
import {interviews,workflowEvents} from '../../drizzle/schema';
import {confirmationScheduleFingerprint} from './interviewScheduleIdentity';
export function matchesRecovery(row:typeof interviews.$inferSelect|undefined,candidateId:string,jobId:string,fingerprint:unknown){return !!row&&row.status==='reschedule_requested'&&row.calendarStatus==='cancelled'&&row.candidateId===candidateId&&row.jobId===jobId&&confirmationScheduleFingerprint(row)===fingerprint;}
/** The existing event ledger binds a recovery pair to one declined occurrence. No second scheduler. */
export async function assertRecoveryCurrent(tx:any,ownerId:number,groupId:string,candidateId:string,jobId:string){
 const event=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.aggregateId,groupId),eq(workflowEvents.eventType,'interview.recovery_requested'))).limit(1))[0];
 if(!event)return undefined;
 const row=(await tx.select().from(interviews).where(and(eq(interviews.ownerId,ownerId),eq(interviews.id,String(event.metadata?.interviewId)))).limit(1))[0] as typeof interviews.$inferSelect;
 if(!matchesRecovery(row,candidateId,jobId,event.metadata?.scheduleFingerprint))throw new TRPCError({code:'CONFLICT',message:'This recovery request no longer matches the interview. Use the current schedule.'});
 return row;
}
