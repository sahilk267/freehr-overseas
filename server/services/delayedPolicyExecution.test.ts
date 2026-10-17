import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  approvals,
  automationQueue,
  companies,
  invoices,
  workspaceSettings,
} from "../../drizzle/schema";
import { createId, ensureWorkspace, requireDb } from "../db";
import { operationsRouter } from "../routers/operations";
import { recruitmentRouter } from "../routers/recruitment";
import { getPolicyGraceMinutes } from "./policyEngine";
import { processOneQueuedJob } from "./queue";

describe("Delayed Policy Decision Execution", () => {
  const ownerId = 999;
  const ctx = {
    user: { id: ownerId, role: "admin", name: "Delayed Policy Owner", email: "delay@test.local" },
    workspace: { ownerId, role: "owner", isOwner: true, memberId: null },
    req: { headers: {} },
    res: {},
  } as never;

  const recruitmentCaller = recruitmentRouter.createCaller(ctx);
  const operationsCaller = operationsRouter.createCaller(ctx);

  async function setPolicy(policyConfig: Record<string, unknown> | null) {
    const db = await requireDb();
    await ensureWorkspace(ownerId);
    await db
      .update(workspaceSettings)
      .set({ policyConfig })
      .where(eq(workspaceSettings.ownerId, ownerId));
  }

  describe("getPolicyGraceMinutes unit tests", () => {
    it("returns null when no policy or rule configured", () => {
      expect(getPolicyGraceMinutes(null, "invoice_issue")).toBeNull();
      expect(getPolicyGraceMinutes({}, "invoice_issue")).toBeNull();
    });

    it("returns delay from delayedActions dictionary", () => {
      const config = {
        delayedActions: {
          invoice_issue: 15,
          candidate_share: 10,
        },
      };
      expect(getPolicyGraceMinutes(config, "invoice_issue")).toBe(15);
      expect(getPolicyGraceMinutes(config, "candidate_share")).toBe(10);
      expect(getPolicyGraceMinutes(config, "client_onboarding")).toBeNull();
    });

    it("returns default grace minutes when delayedActions is an array", () => {
      const config = {
        delayedActions: ["invoice_issue", "candidate_share"],
        defaultGraceMinutes: 20,
      };
      expect(getPolicyGraceMinutes(config, "invoice_issue")).toBe(20);
      expect(getPolicyGraceMinutes(config, "client_onboarding")).toBeNull();
    });

    it("returns delay configured on specific matched rule", () => {
      const rule = {
        id: "rule_inv",
        actionType: "invoice_issue",
        conditions: [],
        graceMinutes: 30,
      };
      expect(getPolicyGraceMinutes({}, "invoice_issue", rule)).toBe(30);
    });
  });

  describe("Full Workflow: Delayed Auto-Decision -> Scheduled Job -> Execution", () => {
    it("enqueues execute_policy_decision with scheduledAt in the future when auto-approved and delayed", async () => {
      const db = await requireDb();
      await ensureWorkspace(ownerId);

      const policyConfig = {
        delayedActions: {
          test_action: 15,
        },
        autoApprovalRules: [
          {
            id: "rule_test_auto",
            name: "Auto-approve test action",
            actionType: "test_action",
            conditions: [{ field: "amount", op: "lte", value: 50000 }],
          },
        ],
      };
      await setPolicy(policyConfig);

      const invoiceId = createId("inv_delay_");
      const { requestOrAutoDecide } = await import("./approvalEngine");
      const res = await requestOrAutoDecide(
        ctx,
        "test_action",
        "invoice",
        invoiceId,
        "Test auto approval with delay",
        { amount: 25000 },
      );

      expect(res.approvalId).toBeDefined();
      expect(res.autoDecided).toBe(true);

      const [approval] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId));
      expect(approval.status).toBe("approved");
      expect(approval.decisionSource).toBe("policy");

      // Verify execute_policy_decision job was enqueued with scheduledAt >= now + 14 minutes
      const queueJobs = await db
        .select()
        .from(automationQueue)
        .where(
          and(
            eq(automationQueue.ownerId, ownerId),
            eq(automationQueue.jobType, "execute_policy_decision"),
            eq(automationQueue.idempotencyKey, `exec_policy:${res.approvalId}`),
          ),
        );
      expect(queueJobs.length).toBe(1);
      const job = queueJobs[0];
      expect(job.status).toBe("queued");
      const scheduledTime = new Date(job.scheduledAt).getTime();
      const expectedTime = Date.now() + 14 * 60 * 1000;
      expect(scheduledTime).toBeGreaterThanOrEqual(expectedTime);
    });

    it("allows the owner to cancel a delayed auto-decision within the grace period", async () => {
      const db = await requireDb();
      await ensureWorkspace(ownerId);

      const policyConfig = {
        delayedActions: {
          test_cancellable_action: 10,
        },
        autoApprovalRules: [
          {
            id: "rule_cancel_test",
            name: "Auto-approve test action under 50000",
            actionType: "test_cancellable_action",
            conditions: [{ field: "amount", op: "lte", value: 50000 }],
          },
        ],
      };
      await setPolicy(policyConfig);

      const invoiceId = createId("inv_cancel_");
      const { requestOrAutoDecide } = await import("./approvalEngine");
      const res = await requestOrAutoDecide(
        ctx,
        "test_cancellable_action",
        "invoice",
        invoiceId,
        "Test cancellable delayed auto-approval",
        { amount: 30000 },
      );

      const [job] = await db
        .select()
        .from(automationQueue)
        .where(
          and(
            eq(automationQueue.ownerId, ownerId),
            eq(automationQueue.jobType, "execute_policy_decision"),
            eq(automationQueue.idempotencyKey, `exec_policy:${res.approvalId}`),
          ),
        );
      expect(job).toBeDefined();
      expect(job.status).toBe("queued");

      // Owner cancels the job via operations.queue.cancel
      const cancelRes = await operationsCaller.queue.cancel({ id: job.id });
      expect(cancelRes.success).toBe(true);

      // Verify queue job status is cancelled
      const [jobCancelled] = await db.select().from(automationQueue).where(eq(automationQueue.id, job.id));
      expect(jobCancelled.status).toBe("cancelled");

      // Verify approval record status is cancelled
      const [approvalCancelled] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId));
      expect(approvalCancelled.status).toBe("cancelled");
      expect(approvalCancelled.reason).toContain("Cancelled by owner during grace period");
    });
  });
});
