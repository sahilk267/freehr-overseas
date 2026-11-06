import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { workspaceSettings, workflowEvents } from "../../drizzle/schema";
import { requireDb, createId } from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { backgroundWorkerStatus, runManagedAutomationCycle, startWorkerPolling } from "./backgroundWorker";
import * as queue from "./queue";

const send = vi.hoisted(() => vi.fn(async () => ({ providerMessageId: "synthetic-background-acceptance" })));
vi.mock("./hostingerMail", async original => ({ ...await original(), isSenderIdentityConfigured: () => true, sendViaHostingerMailApi: send }));
const owners: number[] = [];
async function fixture() { const f = await followupFixture(); owners.push(f.ownerId); return f; }
async function observeOwnerCycle(ownerId: number, status: string, limit = 5) {
  for (let poll = 0; poll < 5; poll++) {
    if ((await runManagedAutomationCycle(limit)).some(r => r.ownerId === ownerId && r.status === status)) return;
  }
  throw new Error('Synthetic owner was not observed within the bounded managed polling window.');
}
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); send.mockClear();
  const db = await requireDb();
  for (const ownerId of owners.splice(0)) await db.update(workspaceSettings).set({ backgroundEnabled: false }).where(eq(workspaceSettings.ownerId, ownerId));
});

describe("managed runtime processing with observable persisted heartbeats", () => {
  it("defaults to disabled and does not fabricate runtime activity", async () => {
    const f = await fixture();
    expect(await backgroundWorkerStatus(f.ownerId)).toMatchObject({ enabled: false, runtimeLoopActive: false, lastHeartbeatAt: null, heartbeatRecent: false });
  });
  it("uses one controller for legacy enable routes and optimistic owner controls", async () => {
    const f = await fixture();
    expect(await f.caller.operations.queue.enableSchedule()).toMatchObject({ enabled: true, revision: 2, lastHeartbeatAt: null });
    expect(await f.caller.recruitment.interviews.enableReminderSchedule()).toMatchObject({ enabled: true, revision: 2 });
    const events = await f.db.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, f.ownerId), eq(workflowEvents.eventType, "automation.background_enabled")));
    expect(events).toHaveLength(1);
    await expect(f.caller.operations.queue.configureWorker({ enabled: false, expectedRevision: 1 })).rejects.toThrow(/changed/);
    expect(await f.caller.operations.queue.configureWorker({ enabled: false, expectedRevision: 2 })).toMatchObject({ enabled: false, revision: 3, lastHeartbeatAt: null });
  });
  it("records actual cycles, and disabling prevents later cycles from claiming work", async () => {
    const f = await fixture(); await f.caller.operations.queue.enableSchedule();
    // SQL suites retain other enabled fixtures. The worker intentionally polls
    // only 25 workspaces per cycle; wait for this owner without changing fairness.
    await observeOwnerCycle(f.ownerId, 'polled');
    expect(await backgroundWorkerStatus(f.ownerId)).toMatchObject({ enabled: true, heartbeatRecent: true, lastError: null });
    await f.caller.operations.queue.configureWorker({ enabled: false, expectedRevision: 2 });
    expect(await runManagedAutomationCycle()).not.toContainEqual({ ownerId: f.ownerId, status: "polled" });
  });
  it("records emergency stop without processing campaign or delivery work", async () => {
    const f = await fixture(); await f.caller.operations.queue.enableSchedule();
    await f.db.update(workspaceSettings).set({ emergencyStop: true }).where(eq(workspaceSettings.ownerId, f.ownerId));
    await observeOwnerCycle(f.ownerId, 'emergency_stopped');
    expect(send).not.toHaveBeenCalled();
    expect((await backgroundWorkerStatus(f.ownerId)).lastResult).toMatchObject({ status: "emergency_stopped", processed: 0 });
  });
  it("enrolls campaign intent and executes its authorized central outbox in a background cycle", async () => {
    const f = await fixture();
    const campaign = await f.caller.campaigns.draft({ requestKey: createId(), name: "Synthetic background campaign", scenarioId: "FU01", recipientIds: [f.contactId], senderIdentityId: f.senders.clients, executionMode: "delegated", timezone: "UTC", businessDaysOnly: false, deadlineAt: new Date(Date.now() + 86400000), steps: [{ delayMinutes: 0, subject: "Synthetic enquiry", body: "An owned-mailbox synthetic enquiry. {{opt_out}}" }] });
    const preview = await f.caller.campaigns.preview({ id: campaign.id });
    await f.caller.campaigns.launch({ id: campaign.id, expectedRevision: 1, previewHash: preview.previewHash, authorizeSending: true });
    await f.caller.operations.queue.enableSchedule(); await observeOwnerCycle(f.ownerId, 'polled');
    expect(send).toHaveBeenCalledTimes(1);
    const member = (await f.caller.campaigns.detail({ id: campaign.id })).recipients[0];
    expect(await f.getPlan(member.planId!)).toMatchObject({ stepIndex: 1, status: "waiting" });
  });
  it("retains a failed cycle as an actionable observation and recovers on the next poll", async () => {
    const f = await fixture(); await f.caller.operations.queue.enableSchedule();
    const original = queue.processDueAutomationBatch;
    const spy = vi.spyOn(queue, "processDueAutomationBatch").mockImplementation((ownerId, limit) => ownerId === f.ownerId ? Promise.reject(new Error("synthetic database outage")) : original(ownerId, limit));
    await observeOwnerCycle(f.ownerId, 'failed');
    expect((await backgroundWorkerStatus(f.ownerId)).lastError).toMatch(/Check migrations/);
    spy.mockRestore(); await observeOwnerCycle(f.ownerId, 'polled');
    expect((await backgroundWorkerStatus(f.ownerId)).lastError).toBeNull();
  });
  it("polls without overlapping cycles and drains an in-flight cycle at shutdown", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const stop = startWorkerPolling(run, 100);
    await vi.advanceTimersByTimeAsync(500); expect(run).toHaveBeenCalledTimes(1);
    finish(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); expect(run).toHaveBeenCalledTimes(2);
    const stopping = stop(); finish(); await stopping;
    await vi.advanceTimersByTimeAsync(500); expect(run).toHaveBeenCalledTimes(2);
  });
});
