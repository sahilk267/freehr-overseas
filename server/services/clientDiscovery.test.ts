import {processDueDiscoveryDeadlines} from "./clientDiscoveryDeadline";
import {runManagedAutomationCycle} from "./backgroundWorker";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { automationQueue, clientDiscoveryRequests as requests, clientDiscoveryMeetings as meetings, contacts, conversations, googleCalendarConnections as connections, incidents, interviews, workflowEvents, workspaceSettings } from "../../drizzle/schema";
import * as dbModule from "../db";
import { createId } from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { receiveReply } from "./replyTriage";
import { bookDiscovery, cancelDiscovery, createDiscoveryRequest, discoveryIcs, executeDiscoverySelection, listDiscoveryRequests, proposeDiscovery, publicDiscovery } from "./clientDiscovery";
import { holdInterviewSlot, previewInterviewSlot, scheduleInterview } from "./interviewScheduling";
import { processOneQueuedJob } from "./queue";
import { appendWorkflowEvent } from "./workflowStore";
const calendar=vi.hoisted(()=>vi.fn());
vi.mock("./googleCalendar",async original=>({...await original(),googleFreeBusyWithBuffers:calendar}));
const free=()=>({calendarId:"primary",connectionRevision:1,checkedAt:new Date(),busy:[]});
beforeEach(()=>calendar.mockReset().mockImplementation(async()=>free()));
const managedOwners:number[]=[];
afterEach(async()=>{vi.restoreAllMocks();const db=await dbModule.requireDb();for(const ownerId of managedOwners.splice(0))await db.update(workspaceSettings).set({backgroundEnabled:false}).where(eq(workspaceSettings.ownerId,ownerId));});
async function fixture(autoSelect=false){
 const f=await followupFixture();managedOwners.push(f.ownerId);
 await f.db.insert(connections).values({id:createId("gcal_"),ownerId:f.ownerId,status:"active",revision:1,calendarId:"primary"});
 await f.db.update(workspaceSettings).set({backgroundEnabled:true}).where(eq(workspaceSettings.ownerId,f.ownerId));
 const reply=await receiveReply(f.ownerId,{conversationId:f.clientConversationId,body:"Can we discuss hiring requirements next week?",source:"synthetic_test"});
 await f.db.update(automationQueue).set({status:"cancelled"}).where(and(eq(automationQueue.ownerId,f.ownerId),eq(automationQueue.jobType,"classify_reply")));
 const action={conversationId:f.clientConversationId,messageId:reply.messageId,replyRevision:1,expectedActionRevision:0,action:"arrange_discovery" as const,notes:"Synthetic client discovery request for review"};
 await f.caller.recruitment.outreach.recordReplyAction(action);
 const start=new Date(Math.ceil((Date.now()+86400000)/300000)*300000),end=new Date(start.getTime()+4*3600000);
 const input={conversationId:f.clientConversationId,replyRevision:1,actionRevision:1,requestKey:createId("request_"),ownerWindows:[{start,end}],timezone:"UTC",durationMinutes:30,bufferMinutes:15,expiresHours:48,autoSelect};
 const created=await createDiscoveryRequest(f.ownerId,f.ownerId,input),cap={id:created.request.id,token:created.token!};
 const respondInput={...cap,expectedRevision:1,timezone:"UTC",windows:[{start,end}]};
 const respond=()=>publicDiscovery(respondInput),propose=()=>proposeDiscovery(f.ownerId,cap.id);
 const row=async()=>(await f.db.select().from(requests).where(eq(requests.id,cap.id)))[0];
 const booked=()=>f.db.select().from(meetings).where(eq(meetings.ownerId,f.ownerId));
 return {...f,input,action,start,end,created,cap,respondInput,respond,propose,row,booked};
}
describe("client discovery using shared availability, calendar reads and queue authority",()=>{
 it("keeps only capability hashes, scopes owner lists and reuses exact create retries",async()=>{
  const f=await fixture(),again=await createDiscoveryRequest(f.ownerId,f.ownerId,f.input);
  expect(again).toMatchObject({alreadyExists:true,token:null,request:{id:f.cap.id}});
  expect(JSON.stringify(await f.row())).not.toContain(f.cap.token);
  const list=await listDiscoveryRequests(f.ownerId,f.clientConversationId);expect(JSON.stringify(list)).not.toContain("tokenHash");expect(JSON.stringify(list)).not.toContain(f.cap.token);
  await expect(createDiscoveryRequest(f.ownerId,f.ownerId,{...f.input,durationMinutes:45})).rejects.toThrow(/different discovery/);
  await expect(createDiscoveryRequest(f.ownerId,f.ownerId,{...f.input,requestKey:createId("another_")})).rejects.toThrow(/active discovery/);
  const other=await followupFixture();await expect(other.caller.clientDiscovery.list({conversationId:f.clientConversationId})).rejects.toThrow(/not found/);
 });
 it("only a current permitted reviewed discovery action may open a request",async()=>{
  const f=await fixture();await cancelDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,expectedRevision:1});
  await f.caller.recruitment.outreach.recordReplyAction({...f.action,expectedActionRevision:1,action:"clarify_requirement",notes:"Clarify client requirement before booking"});
  await expect(createDiscoveryRequest(f.ownerId,f.ownerId,{...f.input,requestKey:createId("fresh_"),actionRevision:2})).rejects.toThrow(/reviewed discovery/);
 });
 it("public response exposes no client email or workspace context and exact retries do not enqueue twice",async()=>{
  const f=await fixture(true),read=await publicDiscovery(f.cap);expect(JSON.stringify(read)).not.toContain(f.contactId);expect(read).toMatchObject({status:"pending",revision:1});
  expect(await f.respond()).toMatchObject({status:"responded",revision:2});expect(await f.respond()).toMatchObject({alreadySubmitted:true,revision:2});
  expect(await f.db.select().from(automationQueue).where(and(eq(automationQueue.ownerId,f.ownerId),eq(automationQueue.jobType,"discovery_select")))).toHaveLength(1);
  await expect(publicDiscovery({...f.respondInput,windows:[{start:new Date(f.start.getTime()+60000),end:f.end}]})).rejects.toMatchObject({code:"CONFLICT"});
 });
 it("rejects invalid, expired, revoked or differently scoped capability tokens",async()=>{
  const f=await fixture(),g=await fixture();await expect(publicDiscovery({...f.cap,token:g.cap.token})).rejects.toMatchObject({code:"UNAUTHORIZED"});
  await f.db.update(requests).set({expiresAt:new Date(Date.now()-1000)}).where(eq(requests.id,f.cap.id));await expect(f.respond()).rejects.toMatchObject({code:"UNAUTHORIZED"});
  await cancelDiscovery(g.ownerId,g.ownerId,{requestId:g.cap.id,expectedRevision:1});await expect(publicDiscovery(g.cap)).rejects.toMatchObject({code:"UNAUTHORIZED"});
 });
 it("validates client timezone, lead time and requested horizon",async()=>{
  const f=await fixture();await expect(publicDiscovery({...f.respondInput,timezone:"invalid/zone"})).rejects.toThrow(/timezone/);
  await expect(publicDiscovery({...f.respondInput,windows:[{start:new Date(Date.now()),end:f.end}]})).rejects.toThrow(/future availability/);
  await expect(publicDiscovery({...f.respondInput,windows:[{start:new Date(f.start.getTime()-3600000),end:f.end}]})).rejects.toThrow(/scheduling horizon/);
 });
 it("a newer reply or changed task invalidates old public links and selection",async()=>{
  const f=await fixture();await f.respond();await receiveReply(f.ownerId,{conversationId:f.clientConversationId,body:"Our requirements have changed; clarify these first",source:"test"});
  await expect(publicDiscovery(f.cap)).rejects.toMatchObject({code:"UNAUTHORIZED"});await expect(f.propose()).rejects.toThrow(/reviewed discovery/);
  expect((await listDiscoveryRequests(f.ownerId,f.clientConversationId))[0].stale).toBe(true);
  expect(await f.booked()).toHaveLength(0);
 });
 it("recipient changes, opt-out and expired permission stop proposals without provider reads",async()=>{
  const f=await fixture();await f.respond();await f.db.update(contacts).set({email:"changed@example.test"}).where(eq(contacts.id,f.contactId));await expect(f.propose()).rejects.toThrow(/recipient changed/);expect(calendar).not.toHaveBeenCalled();
  const g=await fixture();await g.respond();await appendWorkflowEvent(g.db,g.ownerId,"communication.permission_recorded",g.contactId,1,{expiresAt:new Date(Date.now()-60000).toISOString()});await expect(g.propose()).rejects.toThrow(/permitted/);
  const h=await fixture();await h.respond();await receiveReply(h.ownerId,{conversationId:h.clientConversationId,body:"Please stop contacting me",source:"test"});await expect(h.propose()).rejects.toThrow(/permitted/);
 });
 it("proposals reuse shared Google and internal owner reservations without a provider write",async()=>{
  const f=await fixture();await f.respond();await scheduleInterview(f.ownerId,f.ownerId,{candidateId:f.candidateId,companyId:f.companyId,jobId:f.jobId,scheduledAt:f.start,durationMinutes:45,timezone:"UTC",requestKey:createId("int_")});
  const p=await f.propose();expect(p.slots[0].start.getTime()).toBeGreaterThanOrEqual(f.start.getTime()+60*60000);expect(p.reservation).toBe(false);expect(p.participantAcceptance).toBe(false);expect(await f.booked()).toHaveLength(0);
 });
 it("records a dedicated tentative meeting, closes capability and publishes an ICS without guests",async()=>{
  const f=await fixture();await f.respond();const p=await f.propose(),input={requestId:f.cap.id,scheduledAt:p.slots[0].start,fingerprint:p.fingerprint};
  const result=await bookDiscovery(f.ownerId,f.ownerId,input);expect(result).toMatchObject({status:"tentative",participantAcceptance:false});expect(await f.booked()).toHaveLength(1);
  expect(await f.db.select().from(interviews).where(eq(interviews.ownerId,f.ownerId))).toHaveLength(1);
  await expect(publicDiscovery(f.cap)).rejects.toMatchObject({code:"UNAUTHORIZED"});
  const ics=await discoveryIcs(f.ownerId,result.id!);expect(ics.ics).toContain("STATUS:TENTATIVE");expect(ics.ics).not.toContain("ATTENDEE");
  expect(await bookDiscovery(f.ownerId,f.ownerId,input)).toMatchObject({alreadyExists:true,id:result.id});
  await expect(bookDiscovery(f.ownerId,f.ownerId,{...input,scheduledAt:new Date(input.scheduledAt.getTime()+60000)})).rejects.toThrow(/different meeting/);
  await cancelDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,expectedRevision:3});expect((await discoveryIcs(f.ownerId,result.id!)).ics).toContain("STATUS:CANCELLED");
  expect(await bookDiscovery(f.ownerId,f.ownerId,input)).toMatchObject({alreadyExists:true,status:"cancelled"});
 });
 it("discovery reservations block canonical interview scheduling and holds, and cancellation releases them",async()=>{
  const f=await fixture();await f.respond();const p=await f.propose(),slot={candidateId:f.candidateId,scheduledAt:p.slots[0].start,durationMinutes:30,timezone:"UTC"};
  await bookDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,scheduledAt:slot.scheduledAt,fingerprint:p.fingerprint});
  expect(await previewInterviewSlot(f.ownerId,slot)).toMatchObject({hasConflict:true,discoveryBusyCount:1});
  await expect(scheduleInterview(f.ownerId,f.ownerId,{...slot,companyId:f.companyId,jobId:f.jobId})).rejects.toThrow(/discovery reservation/);
  await expect(holdInterviewSlot(f.ownerId,f.ownerId,{...slot,requestKey:createId("hold_"),ttlMinutes:10})).rejects.toThrow(/discovery reservation/);
  await cancelDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,expectedRevision:3});expect(await scheduleInterview(f.ownerId,f.ownerId,{...slot,companyId:f.companyId,jobId:f.jobId})).toHaveProperty("id");
 });
 it("rechecks changed Google busy time and calendar connection before booking",async()=>{
  const f=await fixture();await f.respond();const p=await f.propose();calendar.mockResolvedValue({...free(),busy:[{start:f.start,end:f.end}]});await expect(bookDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,scheduledAt:p.slots[0].start,fingerprint:p.fingerprint})).rejects.toThrow(/Calendar or availability changed/);expect(await f.booked()).toHaveLength(0);
  calendar.mockImplementation(async()=>free());calendar.mockImplementationOnce(async()=>{await f.db.update(connections).set({revision:2}).where(eq(connections.ownerId,f.ownerId));return free();});await expect(bookDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,scheduledAt:p.slots[0].start,fingerprint:p.fingerprint})).rejects.toThrow(/Calendar connection/);
 });
 it("automatic selection uses the shared queue and leaves attendance unverified",async()=>{
  const f=await fixture(true);await f.respond();expect(await processOneQueuedJob(f.ownerId)).toMatchObject({status:"completed"});expect(await f.booked()).toHaveLength(1);expect((await f.row()).status).toBe("booked");
  expect(await executeDiscoverySelection(f.ownerId,{requestId:f.cap.id,revision:2})).toMatchObject({status:"stale"});expect(await f.booked()).toHaveLength(1);
 });
 it("default-off requests never enqueue automatic selection",async()=>{
  const f=await fixture(false);await f.respond();expect(await f.db.select().from(automationQueue).where(and(eq(automationQueue.ownerId,f.ownerId),eq(automationQueue.jobType,"discovery_select")))).toHaveLength(0);
 });
 it("worker pause and emergency stop preserve queued selection without provider reads",async()=>{
  const f=await fixture(true);await f.respond();await f.db.update(workspaceSettings).set({backgroundEnabled:false}).where(eq(workspaceSettings.ownerId,f.ownerId));expect(["empty","skipped"]).toContain((await processOneQueuedJob(f.ownerId)).status);expect(calendar).not.toHaveBeenCalled();expect(await f.booked()).toHaveLength(0);const jobs=await f.db.select().from(automationQueue).where(and(eq(automationQueue.ownerId,f.ownerId),eq(automationQueue.jobType,"discovery_select")));expect(jobs[0]).toMatchObject({status:"queued",attempts:0});await f.db.update(workspaceSettings).set({backgroundEnabled:true,emergencyStop:true}).where(eq(workspaceSettings.ownerId,f.ownerId));expect(await processOneQueuedJob(f.ownerId)).toMatchObject({status:"skipped"});expect(calendar).not.toHaveBeenCalled();
 });
 it("a pause during the final Google check defers automatic commit",async()=>{
  const f=await fixture(true);await f.respond();calendar.mockImplementationOnce(async()=>free()).mockImplementationOnce(async()=>{await f.db.update(workspaceSettings).set({backgroundEnabled:false}).where(eq(workspaceSettings.ownerId,f.ownerId));return free();});expect(await executeDiscoverySelection(f.ownerId,{requestId:f.cap.id,revision:2})).toMatchObject({status:"deferred"});expect(await f.booked()).toHaveLength(0);
 });
 it("no-slot automatic selection raises one owner exception without inventing a time",async()=>{
  const f=await fixture(true);await f.respond();calendar.mockResolvedValue({...free(),busy:[{start:f.start,end:f.end}]});const input={requestId:f.cap.id,revision:2};expect(await executeDiscoverySelection(f.ownerId,input)).toMatchObject({status:"owner_review"});expect(await executeDiscoverySelection(f.ownerId,input)).toMatchObject({status:"owner_review"});expect(await f.db.select().from(incidents).where(and(eq(incidents.ownerId,f.ownerId),eq(incidents.incidentType,"client_discovery_no_slots")))).toHaveLength(1);expect(await f.booked()).toHaveLength(0);await cancelDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,expectedRevision:2});expect((await f.db.select().from(incidents).where(eq(incidents.ownerId,f.ownerId)))[0].status).toBe("resolved");
 });
 it("cancellation revokes queued automatic selection and rejects a stale owner cancel",async()=>{
  const f=await fixture(true);await f.respond();await expect(cancelDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,expectedRevision:1})).rejects.toMatchObject({code:"CONFLICT"});await cancelDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,expectedRevision:2});expect(await executeDiscoverySelection(f.ownerId,{requestId:f.cap.id,revision:2})).toMatchObject({status:"stale"});expect(await f.booked()).toHaveLength(0);
 });
 it("redacts discovery capabilities before inbound storage and AI context",async()=>{
  const f=await fixture();const result=await receiveReply(f.ownerId,{conversationId:f.clientConversationId,body:`Quoted https://example.test/discovery-response#${f.cap.id}.${f.cap.token}`,source:"test"});const q=(await f.db.select().from(automationQueue).where(eq(automationQueue.id,result.queueId!)))[0];expect(JSON.stringify(q.payload)).not.toContain(f.cap.token);
 });
 it.skipIf(!process.env.FREEHR_TEST_MYSQL)("real SQL serializes two booking attempts to one meeting",async()=>{
  const f=await fixture();await f.respond();const p=await f.propose(),input={requestId:f.cap.id,scheduledAt:p.slots[0].start,fingerprint:p.fingerprint};const results=await Promise.allSettled([bookDiscovery(f.ownerId,f.ownerId,input),bookDiscovery(f.ownerId,f.ownerId,input)]);expect(results.some(r=>r.status==="fulfilled")).toBe(true);expect(await f.booked()).toHaveLength(1);expect((await f.row()).status).toBe("booked");
 });
 it.skipIf(!process.env.FREEHR_TEST_MYSQL)("real SQL rolls back booking and capability closure when audit persistence fails",async()=>{
  const f=await fixture();await f.respond();const p=await f.propose();vi.spyOn(dbModule,"recordAudit").mockRejectedValueOnce(Error("Synthetic audit failure"));await expect(bookDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,scheduledAt:p.slots[0].start,fingerprint:p.fingerprint})).rejects.toThrow(/audit failure/);expect(await f.booked()).toHaveLength(0);expect(await publicDiscovery(f.cap)).toMatchObject({status:"responded"});
 });
 it("past discovery history does not prevent a new future request",async()=>{
  const f=await fixture();await f.respond();const p=await f.propose();const m=await bookDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,scheduledAt:p.slots[0].start,fingerprint:p.fingerprint});
  await f.db.update(meetings).set({scheduledAt:new Date(Date.now()-86400000)}).where(eq(meetings.id,m.id!));
  const next=await createDiscoveryRequest(f.ownerId,f.ownerId,{...f.input,requestKey:createId("later_")});expect(next.request.id).not.toBe(f.cap.id);
 });
 it("exception lookup is owner-scoped and never returns capability material",async()=>{
  const f=await fixture(),other=await followupFixture();expect(JSON.stringify(await f.caller.clientDiscovery.get({requestId:f.cap.id}))).not.toContain(f.cap.token);await expect(other.caller.clientDiscovery.get({requestId:f.cap.id})).rejects.toThrow(/not found/);
 });
 it.skipIf(!process.env.FREEHR_TEST_MYSQL)("SQL fences different client requests competing for the same recruiter slot",async()=>{
  const f=await fixture();await f.respond();const p=await f.propose(),contactId=createId("ctc_"),conversationId=createId("cnv_");
  await f.db.insert(contacts).values({id:contactId,ownerId:f.ownerId,companyId:f.companyId,name:"Second synthetic client",email:`${contactId}@example.test`,contactPermission:"permitted"});
  await f.db.insert(conversations).values({id:conversationId,ownerId:f.ownerId,contactId,companyId:f.companyId,status:"active",channel:"email"});
  const reply=await receiveReply(f.ownerId,{conversationId,body:"Please arrange a discovery call",source:"test"});await f.caller.recruitment.outreach.recordReplyAction({...f.action,conversationId,messageId:reply.messageId});
  const second=await createDiscoveryRequest(f.ownerId,f.ownerId,{...f.input,conversationId,requestKey:createId("second_")});await publicDiscovery({id:second.request.id,token:second.token!,expectedRevision:1,timezone:"UTC",windows:[{start:f.start,end:f.end}]});const p2=await proposeDiscovery(f.ownerId,second.request.id);
  const results=await Promise.allSettled([bookDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,scheduledAt:p.slots[0].start,fingerprint:p.fingerprint}),bookDiscovery(f.ownerId,f.ownerId,{requestId:second.request.id,scheduledAt:p2.slots[0].start,fingerprint:p2.fingerprint})]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(await f.booked()).toHaveLength(1);
 });

});

describe("discovery request deadlines",()=>{
 const expire=async(f:Awaited<ReturnType<typeof fixture>>)=>f.db.update(requests).set({expiresAt:new Date(Date.now()-60000)}).where(eq(requests.id,f.cap.id));
 const alerts=async(f:Awaited<ReturnType<typeof fixture>>)=>f.db.select().from(incidents).where(eq(incidents.ownerId,f.ownerId));
 it("expires pending capability once, escalates owner review and rejects the old public link",async()=>{const f=await fixture();await expire(f);expect(await processDueDiscoveryDeadlines(f.ownerId)).toMatchObject({escalated:1});expect(await f.row()).toMatchObject({status:"expired",tokenHash:"",revision:2});expect(await alerts(f)).toHaveLength(1);expect((await alerts(f))[0].incidentType).toBe("client_discovery_expired");expect((await processDueDiscoveryDeadlines(f.ownerId)).escalated).toBe(0);await expect(publicDiscovery(f.cap)).rejects.toMatchObject({code:"UNAUTHORIZED"});expect(await f.booked()).toHaveLength(0);});
 it("cancels responded automatic selection without creating a meeting",async()=>{const f=await fixture(true);await f.respond();await expire(f);await processDueDiscoveryDeadlines(f.ownerId);expect((await f.db.select().from(automationQueue).where(and(eq(automationQueue.ownerId,f.ownerId),eq(automationQueue.jobType,"discovery_select"))))[0].status).toBe("cancelled");expect(await f.booked()).toHaveLength(0);});
 it("respects paused worker, emergency stop and workspace ownership",async()=>{for(const flag of ["paused","stopped"]){const f=await fixture(),g=await fixture();await expire(f);await f.db.update(workspaceSettings).set(flag==="paused"?{backgroundEnabled:false}:{emergencyStop:true}).where(eq(workspaceSettings.ownerId,f.ownerId));expect((await processDueDiscoveryDeadlines(f.ownerId)).escalated).toBe(0);expect((await f.row()).tokenHash).toHaveLength(64);expect((await processDueDiscoveryDeadlines(g.ownerId)).escalated).toBe(0);}});
 it("closes stale requests without chasing changed replies, actions or permission",async()=>{for(const change of ["reply","action","permission"]){const f=await fixture();if(change==="reply")await receiveReply(f.ownerId,{conversationId:f.clientConversationId,body:"Hiring requirements changed",source:"test"});if(change==="action")await f.caller.recruitment.outreach.recordReplyAction({...f.action,expectedActionRevision:1,action:"clarify_requirement"});if(change==="permission")await f.db.update(contacts).set({contactPermission:"opted_out"}).where(eq(contacts.id,f.contactId));await expire(f);expect((await processDueDiscoveryDeadlines(f.ownerId)).escalated).toBe(0);expect(await alerts(f)).toHaveLength(0);expect(await f.row()).toMatchObject({status:"expired",tokenHash:""});}});
 it("reuses a no-slot incident and resolves it on cancellation",async()=>{const f=await fixture(true);await f.respond();calendar.mockResolvedValue({...free(),busy:[{start:new Date(f.start.getTime()-3600000),end:new Date(f.end.getTime()+3600000)}]});expect(await executeDiscoverySelection(f.ownerId,{requestId:f.cap.id,revision:2})).toMatchObject({status:"owner_review"});const before=(await alerts(f))[0];await expire(f);await processDueDiscoveryDeadlines(f.ownerId);expect(await alerts(f)).toHaveLength(1);expect((await alerts(f))[0]).toMatchObject({id:before.id,incidentType:"client_discovery_expired"});await cancelDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,expectedRevision:3});expect((await alerts(f))[0].status).toBe("resolved");});
 it("replacement closes old authority and prevents a later obsolete incident",async()=>{const f=await fixture();await expire(f);await createDiscoveryRequest(f.ownerId,f.ownerId,{...f.input,requestKey:createId("replacement_")});expect((await processDueDiscoveryDeadlines(f.ownerId)).escalated).toBe(0);expect(await f.row()).toMatchObject({status:"expired",tokenHash:""});expect(await alerts(f)).toHaveLength(0);});
 it("replacement resolves the existing expiry incident",async()=>{const f=await fixture();await expire(f);await processDueDiscoveryDeadlines(f.ownerId);await createDiscoveryRequest(f.ownerId,f.ownerId,{...f.input,requestKey:createId("replacement_")});expect((await alerts(f))[0].status).toBe("resolved");});
 it("never expires a booked meeting or changes its reservation",async()=>{const f=await fixture();await f.respond();const p=await f.propose();await bookDiscovery(f.ownerId,f.ownerId,{requestId:f.cap.id,scheduledAt:p.slots[0].start,fingerprint:p.fingerprint});await expire(f);expect((await processDueDiscoveryDeadlines(f.ownerId)).escalated).toBe(0);expect((await f.booked())[0]).toMatchObject({status:"tentative",revision:1});expect((await f.row()).status).toBe("booked");});
 it("runs from the shared managed worker and reports its source outcome",async()=>{const f=await fixture();await expire(f);await runManagedAutomationCycle();const w=(await f.db.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId,f.ownerId)))[0];expect(w.backgroundLastResult).toMatchObject({batch:{sources:{discoveryDeadlines:{escalated:1}}}});expect(await alerts(f)).toHaveLength(1);});
 it.runIf(process.env.FREEHR_TEST_MYSQL==="1")("serializes concurrent expiry into one incident and ledger event",async()=>{const f=await fixture();await expire(f);await Promise.all([processDueDiscoveryDeadlines(f.ownerId),processDueDiscoveryDeadlines(f.ownerId)]);expect(await alerts(f)).toHaveLength(1);expect((await f.db.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,f.ownerId),eq(workflowEvents.eventType,"discovery.expired"))))).toHaveLength(1);});
 it.runIf(process.env.FREEHR_TEST_MYSQL==="1")("rolls back capability closure if incident audit persistence fails",async()=>{const f=await fixture();await expire(f);const original=dbModule.recordAudit;vi.spyOn(dbModule,"recordAudit").mockImplementation(async(input,tx)=>{if(input.action==="discovery.deadline_escalated")throw Error("Synthetic deadline audit failure");return original(input,tx);});await expect(processDueDiscoveryDeadlines(f.ownerId)).rejects.toThrow("Synthetic deadline audit failure");expect(await alerts(f)).toHaveLength(0);expect(await f.row()).toMatchObject({status:"pending",revision:1});expect((await f.row()).tokenHash).toHaveLength(64);});
});
