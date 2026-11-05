import {and,eq,inArray} from 'drizzle-orm';
import {incidents} from '../../drizzle/schema';
import {workflowHash} from './workflowStore';
export const recoveryIncidentType='interview_recovery_deadline';
export const recoveryIncidentId=(ownerId:number,groupId:string)=>'inc_'+workflowHash([ownerId,recoveryIncidentType,groupId]).slice(0,32);
export async function resolveRecoveryDeadline(tx:any,ownerId:number,groupId:string,reason:string){
 await tx.update(incidents).set({status:'resolved',resolvedAt:new Date(),containmentNotes:reason}).where(and(eq(incidents.ownerId,ownerId),eq(incidents.id,recoveryIncidentId(ownerId,groupId)),inArray(incidents.status,['detected','triaged','contained','investigated'])));
}
export async function resolveInterviewRecoveryDeadlines(tx:any,ownerId:number,interviewId:string,reason:string){
 await tx.update(incidents).set({status:'resolved',resolvedAt:new Date(),containmentNotes:reason}).where(and(eq(incidents.ownerId,ownerId),eq(incidents.incidentType,recoveryIncidentType),eq(incidents.affectedResourceType,'interview'),eq(incidents.affectedResourceId,interviewId),inArray(incidents.status,['detected','triaged','contained','investigated'])));
}
