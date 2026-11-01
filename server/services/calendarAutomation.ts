import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { automationQueue, googleCalendarConnections, workspaceSettings } from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
import { withWorkspaceTransaction } from "./database";
import { googleInterviewSnapshot, syncGoogleInterview } from "./googleCalendar";
import { workflowHash } from "./workflowStore";

type Settings = { enabled: boolean; revision: number; connectionRevision: number };
const settings = (row: any): Settings => row?.policyConfig?.calendarAutoSync ?? { enabled: false, revision: 0, connectionRevision: 0 };
async function context(tx: any, ownerId: number) {
  const workspace = (await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1))[0];
  const connection = (await tx.select().from(googleCalendarConnections).where(eq(googleCalendarConnections.ownerId, ownerId)).limit(1))[0];
  return { workspace, connection, policy: settings(workspace) };
}
export async function calendarAutomationStatus(ownerId: number) {
  const {workspace, connection, policy} = await context(await requireDb(), ownerId);
  const jobs = await (await requireDb()).select().from(automationQueue).where(and(eq(automationQueue.ownerId, ownerId),eq(automationQueue.jobType,"google_calendar_sync"))).orderBy(desc(automationQueue.createdAt),desc(automationQueue.id)).limit(100);
  return { enabled: policy.enabled && connection?.status === "active" && connection.revision === policy.connectionRevision,
    revision: policy.revision, workerEnabled: Boolean(workspace?.backgroundEnabled), emergencyStop: Boolean(workspace?.emergencyStop),
    needsReenable: policy.enabled && (connection?.status !== "active" || connection?.revision !== policy.connectionRevision),
    jobs: jobs.map(j=>({id:j.id,status:j.status,attempts:j.attempts,scheduledAt:j.scheduledAt,lastError:j.lastError,outcome:(j.result as {status?:string;synced?:boolean}|null)?.status === "cancelled" ? "cancelled" : (j.result as {synced?:boolean}|null)?.synced ? "synced" : null})),
    scope:"future_saved_interview_changes", invitationsSent:false };
}
export async function configureCalendarAutomation(ownerId:number, actorId:number, enabled:boolean, expectedRevision:number) {
  await withWorkspaceTransaction(ownerId,async tx=>{
    const {workspace,connection,policy}=await context(tx,ownerId);
    if(policy.revision!==expectedRevision) throw new TRPCError({code:"CONFLICT",message:"Calendar automation settings changed. Reload before saving."});
    if(enabled && (connection?.status!=="active" || !workspace?.backgroundEnabled)) throw new TRPCError({code:"PRECONDITION_FAILED",message:"Connect Google Calendar and enable the managed background worker first."});
    const value={enabled,revision:policy.revision+1,connectionRevision:connection?.revision??0};
    await tx.update(workspaceSettings).set({policyConfig:{...(workspace.policyConfig??{}),calendarAutoSync:value}}).where(eq(workspaceSettings.ownerId,ownerId));
    await recordAudit({ownerId,actorType:"user",actorId:String(actorId),action:enabled?"google_calendar.automation_enabled":"google_calendar.automation_paused",resourceType:"workspace",resourceId:String(ownerId),metadata:{scope:"future_saved_interview_changes",invitationsSent:false}},tx);
  });
  return calendarAutomationStatus(ownerId);
}
/** Called inside the canonical scheduling transaction, never a second scheduler or timer. */
export async function enqueueCalendarSync(tx:any,ownerId:number,interviewId:string) {
  const {workspace,connection,policy}=await context(tx,ownerId);
  if(!policy.enabled || connection?.status!=="active" || connection.revision!==policy.connectionRevision) return;
  const snapshot=await googleInterviewSnapshot(tx,ownerId,interviewId);
  const key="google-calendar:"+workflowHash([ownerId,policy.revision,snapshot.previewHash]);
  if((await tx.select().from(automationQueue).where(eq(automationQueue.idempotencyKey,key)).limit(1))[0]) return;
  await tx.insert(automationQueue).values({id:createId("que_"),ownerId,jobType:"google_calendar_sync",status:"queued",priority:15,attempts:0,maxAttempts:5,scheduledAt:new Date(),idempotencyKey:key,payload:{interviewId,previewHash:snapshot.previewHash,revision:policy.revision}});
}
export async function executeCalendarSync(ownerId:number,payload:any) {
  const guard=async()=>{
    const {workspace,connection,policy}=await context(await requireDb(),ownerId);
    if(!policy.enabled || policy.revision!==payload.revision || !workspace?.backgroundEnabled || workspace?.emergencyStop || connection?.status!=="active" || connection.revision!==policy.connectionRevision) throw new TRPCError({code:"PRECONDITION_FAILED",message:"Calendar automation authority changed; task cancelled."});
  };
  try { await guard(); } catch { return {status:"cancelled"}; }
  const snapshot=await withWorkspaceTransaction(ownerId,tx=>googleInterviewSnapshot(tx,ownerId,payload.interviewId));
  if(snapshot.previewHash!==payload.previewHash) return {status:"cancelled"};
  return syncGoogleInterview(ownerId,payload.interviewId,payload.previewHash,guard,"automatic");
}
