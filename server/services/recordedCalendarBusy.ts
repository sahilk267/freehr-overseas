import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { clientDiscoveryMeetings, interviews, interviewSlotHolds } from "../../drizzle/schema";
import type { Window } from "./availability";
export async function recordedDiscoveryBusy(tx:any,ownerId:number,start:Date,end:Date):Promise<Window[]> {
 const rows=await tx.select().from(clientDiscoveryMeetings).where(and(eq(clientDiscoveryMeetings.ownerId,ownerId),eq(clientDiscoveryMeetings.status,"tentative"),lt(clientDiscoveryMeetings.scheduledAt,new Date(end.getTime()+3600000)),gt(clientDiscoveryMeetings.scheduledAt,new Date(start.getTime()-5*3600000))));
 return rows.map((r:any)=>({start:new Date(new Date(r.scheduledAt).getTime()-r.bufferMinutes*60000),end:new Date(new Date(r.scheduledAt).getTime()+(r.durationMinutes+r.bufferMinutes)*60000)})).filter((w:Window)=>w.start<end&&w.end>start);
}
export async function assertDiscoverySlotFree(tx:any,ownerId:number,start:Date,end:Date){
 if((await recordedDiscoveryBusy(tx,ownerId,start,end)).length)throw new TRPCError({code:"CONFLICT",message:"This time overlaps an active client discovery reservation."});
}
export async function recordedOwnerBusy(tx:any,ownerId:number,start:Date,end:Date):Promise<Window[]> {
 const meetings=await tx.select().from(interviews).where(and(eq(interviews.ownerId,ownerId),inArray(interviews.status,["proposed","scheduled","confirmed","reminder_sent","reschedule_requested"]),lt(interviews.scheduledAt,end),gt(interviews.scheduledAt,new Date(start.getTime()-240*60000))));
 const holds=await tx.select().from(interviewSlotHolds).where(and(eq(interviewSlotHolds.ownerId,ownerId),eq(interviewSlotHolds.status,"active"),gt(interviewSlotHolds.expiresAt,new Date()),lt(interviewSlotHolds.scheduledAt,end),gt(interviewSlotHolds.scheduledAt,new Date(start.getTime()-240*60000))));
 return [...await recordedDiscoveryBusy(tx,ownerId,start,end),...meetings.filter((r:any)=>r.calendarStatus!=="cancelled"),...holds].map((r:any)=>r.start?r:{start:new Date(r.scheduledAt),end:new Date(new Date(r.scheduledAt).getTime()+Math.max(1,r.durationMinutes??45)*60000)}).filter((w:Window)=>w.start<end&&w.end>start);
}
