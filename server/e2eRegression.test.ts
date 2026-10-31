import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { requireDb, ensureWorkspace } from "./db";
import { users } from "../drizzle/schema";

async function fixture() {
  const id = 1000000 + Math.floor(Math.random() * 1000000000);
  const user = { id, openId: `qa_${id}`, email: `qa_${id}@example.test`, name: "Synthetic regression owner", role: "admin" };
  await (await requireDb()).insert(users).values(user);
  await ensureWorkspace(id);
  const caller = appRouter.createCaller({ user, req: { headers: {} }, res: {} } as never);
  const company = await caller.recruitment.prospects.create({ name: "Synthetic QA client" });
  const candidate = await caller.recruitment.candidates.create({ fullName: "Synthetic QA candidate" });
  const job = await caller.recruitment.jobs.create({ companyId: company.id, title: "Synthetic QA role" });
  return { caller, company, candidate, job };
}

describe("regressions found during live end-to-end testing", () => {
  it("rejects a compensation maximum of zero below a positive minimum", async () => {
    const f = await fixture();
    await expect(f.caller.recruitment.jobs.create({ companyId: f.company.id, title: "Invalid range", compensationMin: 100, compensationMax: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("lets an interview awaiting rescheduling receive its new time", async () => {
    const f = await fixture();
    const interview = await f.caller.recruitment.interviews.create({ companyId: f.company.id, candidateId: f.candidate.id, jobId: f.job.id, scheduledAt: new Date(Date.now() + 86400000) });
    await f.caller.recruitment.interviews.transition({ id: interview.id, state: "reschedule_requested" });
    await expect(f.caller.recruitment.interviews.reschedule({ id: interview.id, scheduledAt: new Date(Date.now() + 2 * 86400000), timezone: "Asia/Kolkata", durationMinutes: 45 })).resolves.toMatchObject({ success: true });
  });
  it("rejects invalid interview timezones and invalid quiet-hour settings", async () => {
    const f = await fixture();
    await expect(f.caller.recruitment.interviews.create({ companyId: f.company.id, candidateId: f.candidate.id, jobId: f.job.id, scheduledAt: new Date(Date.now() + 86400000), timezone: "Invalid/Timezone" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(f.caller.operations.settings.update({ quietHoursStart: "99:99" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(f.caller.operations.settings.update({ businessTimezone: "Invalid/Timezone" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("rejects nonnumeric, zero and excessive percentage agreement fees", async () => {
    const f = await fixture();
    for (const feeValue of ["invalid", "0", "101"]) await expect(f.caller.recruitment.agreements.draft({ companyId: f.company.id, feeType: "percentage", feeValue, termsText: "Synthetic terms for a validation-only agreement regression test." })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("returns the existing queue record for an idempotent enqueue retry", async () => {
    const f = await fixture();
    const input = { jobType: "classify_reply" as const, payload: { synthetic: true }, idempotencyKey: `regression-${f.company.id}` };
    const first = await f.caller.operations.queue.enqueue(input);
    expect(await f.caller.operations.queue.enqueue(input)).toMatchObject({ id: first.id });
    await expect(f.caller.operations.queue.enqueue({ ...input, payload: { synthetic: false } })).rejects.toMatchObject({ code: "CONFLICT" });
    const other = await fixture();
    const secondOwner = await other.caller.operations.queue.enqueue(input);
    expect(secondOwner.id).not.toBe(first.id);
  });
  it("reuses matching work when the same evidence is queued twice", async () => {
    const f = await fixture();
    const first = await f.caller.recruitment.matching.queueScoreMatch({ candidateId: f.candidate.id, jobId: f.job.id });
    const second = await f.caller.recruitment.matching.queueScoreMatch({ candidateId: f.candidate.id, jobId: f.job.id });
    expect(second.queueId).toBe(first.queueId);
  });
  it("applies candidate filters together with text search", async () => {
    const f = await fixture();
    const other = await f.caller.recruitment.candidates.create({ fullName: "Synthetic QA referral", sourceType: "referral", availability: "30 days" });
    expect((await f.caller.recruitment.candidates.search({ query: "Synthetic QA", sourceType: "manual" })).map(row => row.id)).toEqual([f.candidate.id]);
    expect(await f.caller.recruitment.candidates.search({ query: "Synthetic QA", profileState: "available" })).toEqual([]);
  });
  // The development adapter deliberately does not implement SQL LIKE.
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")("combines SQL text search with the availability filter", async () => {
    const f = await fixture();
    const other = await f.caller.recruitment.candidates.create({ fullName: "Synthetic QA referral", availability: "30 days" });
    expect((await f.caller.recruitment.candidates.search({ query: "Synthetic QA", availability: "30" })).map(row => row.id)).toEqual([other.id]);
  });
});
