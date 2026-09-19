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
    it("enqueues execute_policy_decision with scheduledAt in the future without immediate side effect", async () => {
      const db = await requireDb();
      await ensureWorkspace(ownerId);

      // Configure policy: auto-approve invoice_issue with amount <= 50000 and 15 min delay
      await setPolicy({
        delayedActions: {
          invoice_issue: 15,
        },
        autoApprovalRules: [
          {
            id: "rule_invoice_issue_auto",
            name: "Auto-approve invoice issue under 50000",
            actionType: "invoice_issue",
            conditions: [{ field: "amount", op: "lte", value: 50000 }],
          },
        ],
      });

      const invoiceId = createId("inv_delay_");
      await db.insert(invoices).values({
        id: invoiceId,
        ownerId,
        invoiceNumber: "INV-DELAY-001",
        amount: 25000,
        taxAmount: 0,
        currency: "USD",
        status: "draft",
        dueDate: new Date(),
      });

      // Request approval: matches autoApprovalRule AND is delayed
      const res = await recruitmentCaller.invoices.requestIssueApproval({
        id: invoiceId,
      });

      expect(res.approvalId).toBeDefined();
      expect(res.autoDecided).toBe(true);

      const [approval] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId));
      expect(approval.status).toBe("approved");
      expect(approval.decisionSource).toBe("policy");

      // Verify side effect was NOT applied immediately (invoice status should still be "approval_pending" or "draft", not "issued")
      const [invBefore] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(invBefore.status).not.toBe("issued");

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

      // Simulate grace period passing by updating scheduledAt to now
      await db
        .update(automationQueue)
        .set({ scheduledAt: new Date(Date.now() - 1000) })
        .where(eq(automationQueue.id, job.id));

      // Process the queue job
      const processRes = await processOneQueuedJob(ownerId);
      expect(processRes.status).toBe("completed");

      // Verify queue job status is completed
      const [jobAfter] = await db.select().from(automationQueue).where(eq(automationQueue.id, job.id));
      expect(jobAfter.status).toBe("completed");

      // Verify side effect WAS applied (invoice is now "issued")
      const [invAfter] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(invAfter.status).toBe("issued");
    });

    it("allows the owner to cancel a delayed auto-decision within the grace period", async () => {
      const db = await requireDb();
      await ensureWorkspace(ownerId);

      // Configure policy with 10 min delay for invoice_issue
      await setPolicy({
        delayedActions: {
          invoice_issue: 10,
        },
        autoApprovalRules: [
          {
            id: "rule_invoice_cancel_test",
            name: "Auto-approve invoice issue under 50000",
            actionType: "invoice_issue",
            conditions: [{ field: "amount", op: "lte", value: 50000 }],
          },
        ],
      });

      const invoiceId = createId("inv_cancel_");
      await db.insert(invoices).values({
        id: invoiceId,
        ownerId,
        invoiceNumber: "INV-CANCEL-001",
        amount: 30000,
        taxAmount: 0,
        currency: "USD",
        status: "draft",
        dueDate: new Date(),
      });

      // Request approval
      const res = await recruitmentCaller.invoices.requestIssueApproval({
        id: invoiceId,
      });

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

      // Verify side effect was NEVER applied (invoice remains not issued)
      const [invRemaining] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(invRemaining.status).not.toBe("issued");
    });
  });
});
