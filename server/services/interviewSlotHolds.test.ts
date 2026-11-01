import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as dbModule from "../db";
import { createId } from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { candidates, interviews, interviewSlotHolds as holds } from "../../drizzle/schema";
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const f = await followupFixture();
  const input = { requestKey: createId("hold_request_"), candidateId: f.candidateId, scheduledAt: new Date(Math.floor((Date.now()+86400000)/1000)*1000), timezone: "UTC", durationMinutes: 45, ttlMinutes: 10 };
  const api = f.caller.recruitment.interviews;
  const booking = (id: string) => ({ id, companyId: f.companyId, jobId: f.jobId });
  const getHold = async (id: string) => (await f.db.select().from(holds).where(eq(holds.id,id)))[0];
  return { ...f, input, api, booking, getHold };
}
describe("expiring internal candidate slot holds", () => {
  it("creates an internal hold without creating an interview or reminder", async () => {
    const f=await fixture(),before=await f.api.list({limit:100});const hold=await f.api.holds.create(f.input);
    expect(hold).toMatchObject({status:"active",candidateId:f.candidateId,interviewId:null,alreadyExists:false});
    expect((await f.api.list({limit:100})).length).toBe(before.length);expect(hold.expiresAt.getTime()-Date.now()).toBeLessThanOrEqual(600000);
    expect((await f.api.checkSlot(f.input)).heldSlots).toHaveLength(1);
  });
  it("reuses retries without extending expiry or resurrecting a released hold",async()=>{
    const f=await fixture(),hold=await f.api.holds.create(f.input),again=await f.api.holds.create(f.input);expect(again.id).toBe(hold.id);expect(again.expiresAt).toEqual(hold.expiresAt);
    await f.api.holds.release({id:hold.id});expect((await f.api.holds.create(f.input)).status).toBe("released");
    await expect(f.api.holds.book(f.booking(hold.id))).rejects.toMatchObject({code:"PRECONDITION_FAILED"});
  });
  it("rejects reuse of a request identity with different details",async()=>{const f=await fixture();await f.api.holds.create(f.input);await expect(f.api.holds.create({...f.input,ttlMinutes:20})).rejects.toMatchObject({code:"CONFLICT"});});
  it("blocks overlaps across holds and direct booking while allowing adjacent holds",async()=>{
    const f=await fixture();await f.api.holds.create(f.input);
    await expect(f.api.holds.create({...f.input,requestKey:createId("request_"),scheduledAt:new Date(f.input.scheduledAt.getTime()+60000)})).rejects.toMatchObject({code:"CONFLICT"});
    await expect(f.api.create({...f.input,companyId:f.companyId,jobId:f.jobId})).rejects.toMatchObject({code:"CONFLICT"});
    await expect(f.api.holds.create({...f.input,requestKey:createId("request_"),scheduledAt:new Date(f.input.scheduledAt.getTime()+45*60000)})).resolves.toHaveProperty("id");
  });
  it("does not hold an already recorded interview time",async()=>{const f=await fixture();await f.api.create({...f.input,companyId:f.companyId,jobId:f.jobId});await expect(f.api.holds.create(f.input)).rejects.toMatchObject({code:"CONFLICT"});});
  it("blocks rescheduling an existing appointment into a held slot",async()=>{const f=await fixture();await f.api.holds.create(f.input);await expect(f.api.reschedule({id:f.interviewId,...f.input})).rejects.toMatchObject({code:"CONFLICT"});});
  it("expires without a worker and releases the time to a new booking",async()=>{
    const f=await fixture(),hold=await f.api.holds.create(f.input);await f.db.update(holds).set({expiresAt:new Date(Date.now()-1000)}).where(eq(holds.id,hold.id));
    expect((await f.api.holds.list()).find(h=>h.id===hold.id)?.status).toBe("expired");expect((await f.api.checkSlot(f.input)).hasConflict).toBe(false);
    expect((await f.api.holds.create(f.input)).status).toBe("expired");await expect(f.api.holds.book(f.booking(hold.id))).rejects.toMatchObject({code:"PRECONDITION_FAILED"});
    await expect(f.api.create({...f.input,companyId:f.companyId,jobId:f.jobId})).resolves.toHaveProperty("id");
  });
  it("caps expiry at the proposed start and rejects past or excessive windows",async()=>{
    const f=await fixture();const near={...f.input,scheduledAt:new Date(Math.floor((Date.now()+120000)/1000)*1000)};expect((await f.api.holds.create(near)).expiresAt).toEqual(near.scheduledAt);
    for(const scheduledAt of [new Date(Date.now()-60000),new Date(Date.now()+91*86400000)])await expect(f.api.holds.create({...f.input,requestKey:createId("request_"),scheduledAt})).rejects.toMatchObject({code:"BAD_REQUEST"});
    await expect(f.api.holds.create({...f.input,ttlMinutes:31})).rejects.toMatchObject({code:"BAD_REQUEST"});
  });
  it("consumes a hold atomically into the canonical interview and reuses booking retries",async()=>{
    const f=await fixture(),hold=await f.api.holds.create(f.input),booking=f.booking(hold.id),a=await f.api.holds.book(booking),b=await f.api.holds.book(booking);
    expect(b).toEqual({id:a.id,alreadyExists:true});expect(await f.getHold(hold.id)).toMatchObject({status:"consumed",interviewId:a.id});
    const saved=(await f.api.list({limit:100})).find(i=>i.id===a.id)!;expect(saved.scheduledAt).toEqual(f.input.scheduledAt);expect(saved.durationMinutes).toBe(45);expect(saved.calendarProvider).toBe("ics");expect(saved.reminderAt).toBeTruthy();
    await f.api.cancel({id:a.id});expect((await f.api.holds.book(booking)).id).toBe(a.id);expect((await f.api.list({limit:100})).find(i=>i.id===a.id)?.status).toBe("cancelled");
  });
  it("cannot release a consumed hold or change its booking content on retry",async()=>{
    const f=await fixture(),hold=await f.api.holds.create(f.input);await f.api.holds.book(f.booking(hold.id));
    await expect(f.api.holds.release({id:hold.id})).rejects.toMatchObject({code:"CONFLICT"});await expect(f.api.holds.book({...f.booking(hold.id),meetingUrl:"https://example.test/changed"})).rejects.toMatchObject({code:"CONFLICT"});
  });
  it("preserves an active hold after invalid job or withdrawn candidate booking",async()=>{
    const f=await fixture(),hold=await f.api.holds.create(f.input);await expect(f.api.holds.book({...f.booking(hold.id),jobId:"job_missing"})).rejects.toMatchObject({code:"NOT_FOUND"});expect((await f.getHold(hold.id)).status).toBe("active");
    await f.db.update(candidates).set({profileState:"withdrawn"}).where(eq(candidates.id,f.candidateId));await expect(f.api.holds.book(f.booking(hold.id))).rejects.toMatchObject({code:"PRECONDITION_FAILED"});expect((await f.getHold(hold.id)).status).toBe("active");
  });
  it("isolates hold reads and mutations across workspaces",async()=>{
    const f=await fixture(),other=await fixture(),hold=await f.api.holds.create(f.input);expect((await other.api.holds.list()).some(h=>h.id===hold.id)).toBe(false);
    await expect(other.api.holds.release({id:hold.id})).rejects.toMatchObject({code:"NOT_FOUND"});await expect(other.api.holds.book(f.booking(hold.id))).rejects.toMatchObject({code:"NOT_FOUND"});await expect(other.api.holds.create({...f.input,requestKey:createId("request_")})).rejects.toMatchObject({code:"NOT_FOUND"});
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL==="1")("serializes competing hold and direct booking requests",async()=>{
    const f=await fixture();const results=await Promise.allSettled([f.api.holds.create(f.input),f.api.create({...f.input,companyId:f.companyId,jobId:f.jobId})]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL==="1")("deduplicates simultaneous hold bookings",async()=>{
    const f=await fixture(),hold=await f.api.holds.create(f.input);const [a,b]=await Promise.all([f.api.holds.book(f.booking(hold.id)),f.api.holds.book(f.booking(hold.id))]);expect(a.id).toBe(b.id);expect([a.alreadyExists,b.alreadyExists].filter(Boolean)).toHaveLength(1);
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL==="1")("commits only booking or release in a competing claim",async()=>{
    const f=await fixture(),hold=await f.api.holds.create(f.input);const results=await Promise.allSettled([f.api.holds.book(f.booking(hold.id)),f.api.holds.release({id:hold.id})]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);const final=await f.getHold(hold.id);expect(["consumed","released"]).toContain(final.status);expect(Boolean(final.interviewId)).toBe(final.status==="consumed");
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL==="1")("rolls back interview creation and hold consumption when the final audit fails",async()=>{
    const f=await fixture(),hold=await f.api.holds.create(f.input),before=await f.api.list({limit:100}),original=dbModule.recordAudit;
    vi.spyOn(dbModule,"recordAudit").mockImplementation(async(input,tx)=>{if(input.action==="interview.slot_booked")throw Error("Synthetic audit failure");return original(input,tx);});
    await expect(f.api.holds.book(f.booking(hold.id))).rejects.toThrow("Synthetic audit failure");expect((await f.getHold(hold.id)).status).toBe("active");expect((await f.api.list({limit:100})).length).toBe(before.length);
  });
});
