import { describe, expect, it, vi, beforeEach } from "vitest";
import { automationQueue, aiUsage, workspaceSettings } from "../../drizzle/schema";
import { createId, requireDb } from "../db";
import { eq, inArray } from "drizzle-orm";

vi.mock("./aiRouting", () => ({
  runControlledAiTask: vi.fn().mockResolvedValue({
    result: { status: "processed" },
    selectedModel: "test-model",
    latencyMs: 12,
  }),
}));

import { processDueAutomationBatch, processOneQueuedJob, withinDailyAiBudget } from "./queue";

describe("automation queue processing", () => {
  const testOwnerId = 999;

  beforeEach(async () => {
    const db = await requireDb();
    // Ensure workspaceSettings exists for test owner
    await db.delete(automationQueue).where(eq(automationQueue.ownerId, testOwnerId));
    const existing = (await db.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, testOwnerId)).limit(1))[0];
    if (!existing) {
      await db.insert(workspaceSettings).values({
        id: 999,
        ownerId: testOwnerId,
        businessName: "Test Workspace",
        automationMode: "controlled",
        emergencyStop: false,
        policyConfig: { aiDailyLimit: 45 },
      });
    } else {
      await db.update(workspaceSettings).set({
        emergencyStop: false,
        policyConfig: { aiDailyLimit: 45 },
      }).where(eq(workspaceSettings.ownerId, testOwnerId));
    }
  });

  describe("daily AI budget guard", () => {
    it("allows a request below the configured daily limit and blocks it at the limit", () => {
      expect(withinDailyAiBudget(44, 45)).toBe(true);
      expect(withinDailyAiBudget(45, 45)).toBe(false);
    });
  });

  describe("processDueAutomationBatch", () => {
    it("processes multiple due jobs in a single invocation", async () => {
      const db = await requireDb();
      const jobIds = [createId("que_"), createId("que_"), createId("que_")];

      for (const [idx, id] of jobIds.entries()) {
        await db.insert(automationQueue).values({
          id,
          ownerId: testOwnerId,
          jobType: "parse_cv",
          status: "queued",
          payload: { text: `CV ${idx}` },
          priority: 10,
          scheduledAt: new Date(Date.now() - 5000),
          maxAttempts: 3,
          idempotencyKey: `batch-multi-${id}`,
        });
      }

      const result = await processDueAutomationBatch(testOwnerId, 10);
      expect(result.processed).toBe(3);
      expect(result.completed).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);

      // Verify jobs in database are marked completed
      for (const id of jobIds) {
        const row = (await db.select().from(automationQueue).where(eq(automationQueue.id, id)).limit(1))[0];
        expect(row?.status).toBe("completed");
      }
    });

    it("stops processing at the bounded batch limit when more jobs are due", async () => {
      const db = await requireDb();
      const jobIds = [createId("que_"), createId("que_"), createId("que_"), createId("que_"), createId("que_")];

      for (const [idx, id] of jobIds.entries()) {
        await db.insert(automationQueue).values({
          id,
          ownerId: testOwnerId,
          jobType: "draft_outreach",
          status: "queued",
          payload: { text: `Draft ${idx}` },
          priority: 10,
          scheduledAt: new Date(Date.now() - 5000),
          maxAttempts: 3,
          idempotencyKey: `batch-limit-${id}`,
        });
      }

      // Batch limit of 2
      const result = await processDueAutomationBatch(testOwnerId, 2);
      expect(result.processed).toBe(2);
      expect(result.completed).toBe(2);

      // The remaining 3 jobs should still be queued
      const remainingQueued = await db
        .select()
        .from(automationQueue)
        .where(eq(automationQueue.ownerId, testOwnerId));
      const stillQueued = remainingQueued.filter(j => jobIds.includes(j.id) && j.status === "queued");
      expect(stillQueued.length).toBe(3);

      // Second invocation processes the remaining jobs
      const nextBatch = await processDueAutomationBatch(testOwnerId, 5);
      expect(nextBatch.processed).toBe(3);
      expect(nextBatch.completed).toBe(3);
    });

    it("halts and skips processing when emergencyStop is enabled", async () => {
      const db = await requireDb();
      await db.update(workspaceSettings).set({ emergencyStop: true }).where(eq(workspaceSettings.ownerId, testOwnerId));

      const id = createId("que_");
      await db.insert(automationQueue).values({
        id,
        ownerId: testOwnerId,
        jobType: "classify_reply",
        status: "queued",
        payload: { text: "Hello" },
        priority: 10,
        scheduledAt: new Date(Date.now() - 1000),
        maxAttempts: 3,
        idempotencyKey: `batch-stop-${id}`,
      });

      const result = await processDueAutomationBatch(testOwnerId, 5);
      expect(result.processed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.results[0]?.status).toBe("skipped");
      expect(result.results[0]?.reason).toBe("Emergency stop is enabled.");

      // Job remains queued, never started
      const row = (await db.select().from(automationQueue).where(eq(automationQueue.id, id)).limit(1))[0];
      expect(row?.status).toBe("queued");
    });

    it("processes other owners' due jobs when one owner has emergencyStop enabled in global batch mode", async () => {
      const db = await requireDb();
      const ownerA = 991;
      const ownerB = 992;

      // Clean up test data for both owners
      await db.delete(automationQueue).where(inArray(automationQueue.ownerId, [ownerA, ownerB]));

      // Set up workspace settings: Owner A has emergencyStop: true, Owner B has emergencyStop: false
      const settingsA = (await db.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerA)).limit(1))[0];
      if (!settingsA) {
        await db.insert(workspaceSettings).values({
          id: 991,
          ownerId: ownerA,
          businessName: "Owner A Workspace",
          automationMode: "controlled",
          emergencyStop: true,
          policyConfig: { aiDailyLimit: 45 },
        });
      } else {
        await db.update(workspaceSettings).set({ emergencyStop: true }).where(eq(workspaceSettings.ownerId, ownerA));
      }

      const settingsB = (await db.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerB)).limit(1))[0];
      if (!settingsB) {
        await db.insert(workspaceSettings).values({
          id: 992,
          ownerId: ownerB,
          businessName: "Owner B Workspace",
          automationMode: "controlled",
          emergencyStop: false,
          policyConfig: { aiDailyLimit: 45 },
        });
      } else {
        await db.update(workspaceSettings).set({ emergencyStop: false }).where(eq(workspaceSettings.ownerId, ownerB));
      }

      // Insert due job for Owner A with priority 1 so candidate query picks it first
      const jobAId = createId("que_");
      await db.insert(automationQueue).values({
        id: jobAId,
        ownerId: ownerA,
        jobType: "classify_reply",
        status: "queued",
        payload: { text: "Reply for Owner A" },
        priority: 1,
        scheduledAt: new Date(Date.now() - 10000),
        maxAttempts: 3,
        idempotencyKey: `multi-owner-${jobAId}`,
      });

      // Insert due job for Owner B with priority 2
      const jobBId = createId("que_");
      await db.insert(automationQueue).values({
        id: jobBId,
        ownerId: ownerB,
        jobType: "draft_outreach",
        status: "queued",
        payload: { text: "Outreach for Owner B" },
        priority: 2,
        scheduledAt: new Date(Date.now() - 5000),
        maxAttempts: 3,
        idempotencyKey: `multi-owner-${jobBId}`,
      });

      // Execute global batch call (ownerId = undefined)
      const result = await processDueAutomationBatch(undefined, 5);

      // Verify that Owner A was skipped and Owner B was completed
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(result.completed).toBeGreaterThanOrEqual(1);

      const jobARow = (await db.select().from(automationQueue).where(eq(automationQueue.id, jobAId)).limit(1))[0];
      expect(jobARow?.status).toBe("queued");

      const jobBRow = (await db.select().from(automationQueue).where(eq(automationQueue.id, jobBId)).limit(1))[0];
      expect(jobBRow?.status).toBe("completed");

      // Cleanup
      await db.delete(automationQueue).where(inArray(automationQueue.ownerId, [ownerA, ownerB]));
    });
  });

  describe("manual on-demand processing (processOneQueuedJob)", () => {
    it("processes a single queued job on demand", async () => {
      const db = await requireDb();
      const id = createId("que_");
      await db.insert(automationQueue).values({
        id,
        ownerId: testOwnerId,
        jobType: "score_match",
        status: "queued",
        payload: { evidence: "skills match" },
        priority: 5,
        scheduledAt: new Date(Date.now() - 1000),
        maxAttempts: 3,
        idempotencyKey: `manual-run-${id}`,
      });

      const outcome = await processOneQueuedJob(testOwnerId);
      expect(outcome.status).toBe("completed");
      expect(outcome.jobId).toBe(id);

      // Once empty, subsequent call returns empty
      const emptyOutcome = await processOneQueuedJob(testOwnerId);
      expect(emptyOutcome.status).toBe("empty");
    });
  });
});
