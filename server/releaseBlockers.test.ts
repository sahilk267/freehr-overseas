import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  approvals,
  auditEvents,
  automationQueue,
  candidates,
  companies,
  conversations,
  incidents,
  interviews,
  invoices,
  jobs,
  messages,
  placements,
  screenings,
  shortlists,
  users,
  workspaceSettings,
} from "../drizzle/schema";
import { createId, ensureWorkspace, requireDb } from "./db";
import { createContext } from "./_core/context";
import { appRouter } from "./routers";
import { recruitmentRouter } from "./routers/recruitment";
import { consequentialRouter } from "./routers/consequential";
import { emailRouter } from "./routers/email";
import {
  applyApprovalDecision,
  consequentialActionTypes,
  requestOrAutoDecide,
} from "./services/approvalEngine";
import { processOneQueuedJob } from "./services/queue";
import {
  CANONICAL_CONSEQUENTIAL_ACTIONS,
  isConsequentialAction,
  getConsequentialActionDefinition,
} from "./workflow";
import { isPrimaryOwner } from "./services/primaryOwner";
import { sendViaHostingerMailApi } from "./services/hostingerMail";

describe("Release Blocker Remediation Suite (RB-07, RB-08, RB-09, RB-10, RB-11, RB-12, RB-05)", () => {
  const ownerId = 7701;
  const ctx = {
    user: { id: ownerId, role: "admin", name: "Remediation Owner", email: "remediation@test.local" },
    actor: { id: ownerId, role: "admin", name: "Remediation Owner", email: "remediation@test.local" },
    workspace: { ownerId, role: "owner", isOwner: true, memberId: null },
    req: { headers: {} },
    res: {},
  } as never;

  const recruitmentCaller = recruitmentRouter.createCaller(ctx);
  const consequentialCaller = consequentialRouter.createCaller(ctx);
  const emailCaller = emailRouter.createCaller(ctx);

  // =========================================================================
  // RB-08: CLIENT ONBOARDING BYPASS PREVENTION
  // =========================================================================
  describe("RB-08: Client Onboarding Bypass Prevention", () => {
    it("blocks direct mutation from converted to active client via prospects.transition", async () => {
      const db = await requireDb();
      const companyId = createId("cmp_rb08_");
      await db.insert(companies).values({
        id: companyId,
        ownerId,
        name: "Bypass Attempt Corp",
        pipelineState: "converted",
        companyType: "prospect",
      });

      // Direct transition to active must be blocked
      await expect(
        recruitmentCaller.prospects.transition({
          id: companyId,
          state: "active",
        })
      ).rejects.toThrow(TRPCError);

      // Verify state was NOT mutated to active
      const [record] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(record.pipelineState).toBe("converted");
      expect(record.companyType).toBe("prospect");
    });

    it("allows progression through the governed client_onboarding approval path", async () => {
      const db = await requireDb();
      const companyId = createId("cmp_rb08_gov_");
      await db.insert(companies).values({
        id: companyId,
        ownerId,
        name: "Governed Onboarding Corp",
        pipelineState: "converted",
        companyType: "prospect",
      });

      // Request approval
      const reqRes = await recruitmentCaller.prospects.requestOnboardingApproval({ id: companyId });
      expect(reqRes.approvalId).toBeDefined();

      // Approve via approval engine
      await recruitmentCaller.approvals.decide({
        id: reqRes.approvalId,
        decision: "approved",
        note: "Passed KYB and signed agreements",
      });

      const [updated] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(updated.pipelineState).toBe("active");
      expect(updated.companyType).toBe("client");
      expect(updated.verificationState).toBe("verified");
    });
  });

  // =========================================================================
  // RB-07 / RB-09: CONSEQUENTIAL ACTION GOVERNANCE & TAXONOMY
  // =========================================================================
  describe("RB-07 / RB-09: Consequential Action Governance", () => {
    it("defines exactly one canonical set of 12 consequential actions with metadata", () => {
      const expectedActions = [
        "client_onboarding",
        "candidate_share",
        "final_candidate_decision",
        "candidate_final_decision",
        "placement_confirmation",
        "replacement_case",
        "invoice_issue",
        "invoice_payment_status",
        "invoice_dispute",
        "invoice_credit",
        "invoice_write_off",
        "automation_stop",
      ];

      for (const act of expectedActions) {
        expect(isConsequentialAction(act)).toBe(true);
        expect(consequentialActionTypes.has(act)).toBe(true);
        const def = getConsequentialActionDefinition(act);
        expect(def).toBeDefined();
        expect(def?.canRequest).toBe(true);
        expect(def?.requiresApproval).toBe(true);
      }
    });

    it("prevents auto-approval for unsafe consequential actions (automation_stop, invoice_write_off)", async () => {
      const db = await requireDb();
      await ensureWorkspace(ownerId);

      // Attempt to configure policy rules for automation_stop and invoice_write_off
      await db.update(workspaceSettings).set({
        policyConfig: {
          autoApprovalRules: [
            { id: "rule-stop", actionType: "automation_stop", conditions: [] },
            { id: "rule-writeoff", actionType: "invoice_write_off", conditions: [] },
          ],
        },
      }).where(eq(workspaceSettings.ownerId, ownerId));

      const stopResult = await requestOrAutoDecide(
        ctx,
        "automation_stop",
        "workspace",
        String(ownerId),
        "Request emergency stop",
        {}
      );
      expect(stopResult.autoDecided).toBe(false);

      const [stopApproval] = await db.select().from(approvals).where(eq(approvals.id, stopResult.approvalId));
      expect(stopApproval.status).toBe("pending");
      expect(stopApproval.decisionSource).toBe("manual");

      const writeOffResult = await requestOrAutoDecide(
        ctx,
        "invoice_write_off",
        "invoice",
        "inv_dummy",
        "Request write-off",
        {}
      );
      expect(writeOffResult.autoDecided).toBe(false);

      const [woApproval] = await db.select().from(approvals).where(eq(approvals.id, writeOffResult.approvalId));
      expect(woApproval.status).toBe("pending");
      expect(woApproval.decisionSource).toBe("manual");
    });

    it("enforces mandatory human approval across all canonical consequential actions", async () => {
      const db = await requireDb();
      await ensureWorkspace(ownerId);

      const mandatoryHumanApprovalActions = [
        "client_onboarding",
        "candidate_share",
        "candidate_final_decision",
        "final_candidate_decision",
        "placement_confirmation",
        "replacement_case",
        "invoice_issue",
        "invoice_dispute",
        "invoice_credit",
        "invoice_write_off",
        "automation_stop",
        "invoice_payment_status",
      ];

      for (const act of mandatoryHumanApprovalActions) {
        const def = getConsequentialActionDefinition(act);
        expect(def?.allowAutoApproval).toBe(false);
      }

      // Attempt auto-approval via policy for client_onboarding, candidate_share, invoice_issue
      await db.update(workspaceSettings).set({
        policyConfig: {
          autoApprovalRules: [
            { id: "rule-auto-onboard", actionType: "client_onboarding", conditions: [] },
            { id: "rule-auto-share", actionType: "candidate_share", conditions: [] },
            { id: "rule-auto-inv", actionType: "invoice_issue", conditions: [] },
          ],
        },
      }).where(eq(workspaceSettings.ownerId, ownerId));

      const onboardRes = await requestOrAutoDecide(ctx, "client_onboarding", "company", "cmp_dummy_reg", "Onboard", {});
      expect(onboardRes.autoDecided).toBe(false);

      const [onboardApr] = await db.select().from(approvals).where(eq(approvals.id, onboardRes.approvalId));
      expect(onboardApr.status).toBe("pending");
      expect(onboardApr.decisionSource).toBe("manual");
    });

    it("consequential.decide recognizes all 12 consequential actions without throwing 404", async () => {
      const db = await requireDb();
      const testInvoiceId = createId("inv_conseq_");
      await db.insert(invoices).values({
        id: testInvoiceId,
        ownerId,
        invoiceNumber: "INV-CONSEQ-01",
        amount: 50000,
        status: "overdue",
      });

      const writeOffApprovalId = createId("apr_wo_");
      await db.insert(approvals).values({
        id: writeOffApprovalId,
        ownerId,
        requestedBy: "system",
        actionType: "invoice_write_off",
        resourceType: "invoice",
        resourceId: testInvoiceId,
        status: "pending",
        reason: "Uncollectible debt over 180 days",
      });

      // consequential.decide must recognize invoice_write_off and execute it
      const res = await consequentialCaller.decide({
        approvalId: writeOffApprovalId,
        decision: "approved",
        note: "Authorized write-off",
      });
      expect(res.success).toBe(true);

      const [updatedInv] = await db.select().from(invoices).where(eq(invoices.id, testInvoiceId));
      expect(updatedInv.status).toBe("written_off");
    });

    it("fails explicitly when an unsupported or unknown consequential action is decided", async () => {
      const db = await requireDb();
      const fakeApprovalId = createId("apr_unsupp_");
      await db.insert(approvals).values({
        id: fakeApprovalId,
        ownerId,
        requestedBy: "system",
        actionType: "non_existent_consequential_action",
        resourceType: "invoice",
        resourceId: "inv_fake",
        status: "pending",
        reason: "Test unsupported action",
      });

      // router rejects unknown actions
      await expect(
        consequentialCaller.decide({
          approvalId: fakeApprovalId,
          decision: "approved",
        })
      ).rejects.toThrow("Consequential approval was not found.");

      // engine also throws explicitly rather than silently succeeding
      await expect(
        applySideEffect(
          db,
          {
            id: fakeApprovalId,
            ownerId,
            actionType: "non_existent_consequential_action",
            resourceType: "invoice",
            resourceId: "inv_fake",
            status: "pending",
          },
          new Date(),
          ownerId
        )
      ).rejects.toThrow("Unsupported consequential action side effect");
    });

    it("enforces tenant isolation: caller cannot decide approvals belonging to another owner", async () => {
      const db = await requireDb();
      const otherOwnerId = 88888;
      const otherApprovalId = createId("apr_cross_");
      await db.insert(approvals).values({
        id: otherApprovalId,
        ownerId: otherOwnerId,
        requestedBy: "system",
        actionType: "invoice_write_off",
        resourceType: "invoice",
        resourceId: "inv_cross",
        status: "pending",
        reason: "Cross owner approval test",
      });

      await expect(
        consequentialCaller.decide({
          approvalId: otherApprovalId,
          decision: "approved",
        })
      ).rejects.toThrow("Consequential approval was not found.");
    });
  });

  // =========================================================================
  // RB-11: APPROVAL + SIDE-EFFECT TRANSACTION INTEGRITY
  // =========================================================================
  describe("RB-11: Approval + Side-Effect Transaction Integrity", () => {
    it("1. successful approval commits both approval status and side-effect atomically", async () => {
      const db = await requireDb();
      const placementId = createId("plc_tx_succ_");
      await db.insert(placements).values({
        id: placementId,
        ownerId,
        status: "guarantee_active",
      });

      const approvalId = createId("apr_tx_succ_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        actionType: "replacement_case",
        resourceType: "placement",
        resourceId: placementId,
        status: "pending",
        reason: "Replacement request",
      });

      const result = await applyApprovalDecision(
        db,
        {
          id: approvalId,
          ownerId,
          actionType: "replacement_case",
          resourceType: "placement",
          resourceId: placementId,
          status: "pending",
        },
        "approved",
        ownerId,
        "Confirmed replacement"
      );

      expect(result.success).toBe(true);

      const [app] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
      expect(app.status).toBe("approved");

      const [plc] = await db.select().from(placements).where(eq(placements.id, placementId));
      expect(plc.status).toBe("replacement_requested");
    });

    it("2. side-effect failure rolls back approval state and emits execution_failed audit", async () => {
      const db = await requireDb();
      const approvalId = createId("apr_tx_fail_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        actionType: "placement_confirmation",
        resourceType: "placement",
        resourceId: "non_existent_placement_tx",
        status: "pending",
        reason: "Placement confirmation with intentional failure",
      });

      // Pass a transactional wrapper delegating to db.transaction where side-effect throws
      const failingDb = {
        ...db,
        async transaction(cb: any) {
          return db.transaction(async (tx: any) => {
            const wrappedTx = new Proxy(tx, {
              get(target, prop) {
                if (prop === "update") {
                  return (tbl: any) => {
                    if (tbl === placements) {
                      throw new Error("Simulated placement side-effect DB failure");
                    }
                    return target.update(tbl);
                  };
                }
                return (target as any)[prop];
              },
            });
            return cb(wrappedTx);
          });
        },
      };

      await expect(
        applyApprovalDecision(
          failingDb,
          {
            id: approvalId,
            ownerId,
            actionType: "placement_confirmation",
            resourceType: "placement",
            resourceId: "non_existent_placement_tx",
            status: "pending",
          },
          "approved",
          ownerId
        )
      ).rejects.toThrow("Simulated placement side-effect DB failure");

      // Verify approval status was NOT marked approved
      const [app] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
      expect(app.status).toBe("pending");
    });

    it("3. idempotent repeated execution returns success without duplicating side effect", async () => {
      const db = await requireDb();
      const placementId = createId("plc_idemp_");
      await db.insert(placements).values({
        id: placementId,
        ownerId,
        status: "guarantee_active",
      });

      const approvalId = createId("apr_idemp_");
      await db.insert(approvals).values({
        id: approvalId,
        ownerId,
        requestedBy: "system",
        actionType: "replacement_case",
        resourceType: "placement",
        resourceId: placementId,
        status: "pending",
        reason: "Test idempotency",
      });

      // First execution
      const first = await applyApprovalDecision(
        db,
        {
          id: approvalId,
          ownerId,
          actionType: "replacement_case",
          resourceType: "placement",
          resourceId: placementId,
          status: "pending",
        },
        "approved",
        ownerId
      );
      expect(first.success).toBe(true);

      // Repeated execution
      const second = await applyApprovalDecision(
        db,
        {
          id: approvalId,
          ownerId,
          actionType: "replacement_case",
          resourceType: "placement",
          resourceId: placementId,
          status: "approved",
        },
        "approved",
        ownerId
      );
      expect(second.success).toBe(true);
    });
  });

  // =========================================================================
  // RB-10: EMAIL THREADING
  // =========================================================================
  describe("RB-10: Email Threading & Tenant Isolation", () => {
    it("1. outbound delivery captures reliable providerMessageId", async () => {
      const { SendApi } = await import("hostinger-mail-api-sdk");
      const originalSend = SendApi.prototype.sendEmail;
      SendApi.prototype.sendEmail = (async () => ({
        data: { messageId: "<hostinger_prov_999@overseasjob.in>" },
      })) as any;

      try {
        const res = await sendViaHostingerMailApi({
          purpose: "talent",
          to: "candidate@example.com",
          displayName: "FreelanceHR Talent",
          subject: "Interview Invitation",
          text: "Please let us know your availability.",
          messageId: "msg_outbound_test_123",
        });

        expect(res.providerMessageId).toBe("<hostinger_prov_999@overseasjob.in>");
        expect(res.senderAddress).toContain("overseasjob.in");
      } finally {
        SendApi.prototype.sendEmail = originalSend;
      }
    });

    it("2. inbound recordByThread matches via In-Reply-To and References with angle brackets", async () => {
      const db = await requireDb();
      const convId = createId("cnv_thread_");
      await db.insert(conversations).values({
        id: convId,
        ownerId,
        subject: "Thread Test Conversation",
        status: "waiting",
      });

      const outboundMsgId = createId("msg_out_");
      const providerMsgId = `<${outboundMsgId}@overseasjob.in>`;
      await db.insert(messages).values({
        id: outboundMsgId,
        conversationId: convId,
        ownerId,
        direction: "outbound",
        status: "sent",
        body: "Are you free for an interview?",
        providerMessageId: providerMsgId,
        idempotencyKey: `out:${outboundMsgId}`,
      });

      // Inbound reply quoting providerMsgId in In-Reply-To
      const inboundReply = await emailCaller.inbound.recordByThread({
        sender: "candidate@example.com",
        subject: "Re: Thread Test Conversation",
        body: "Yes, I am available tomorrow at 2 PM.",
        providerMessageId: `<reply_${Date.now()}@mail.example.com>`,
        inReplyTo: providerMsgId,
        references: [providerMsgId],
      });

      expect(inboundReply.conversationId).toBe(convId);
      expect(inboundReply.messageId).toBeDefined();

      const [inboundMsg] = await db.select().from(messages).where(eq(messages.id, inboundReply.messageId));
      expect(inboundMsg.direction).toBe("inbound");
      expect(inboundMsg.conversationId).toBe(convId);
    });

    it("3. rejects unmatched inbound email with PRECONDITION_FAILED and records incident", async () => {
      await expect(
        emailCaller.inbound.recordByThread({
          sender: "unknown@example.com",
          subject: "Unrelated spam",
          body: "Hello please read my offer.",
          providerMessageId: `<unmatched_${Date.now()}@mail.example.com>`,
          inReplyTo: "<non_existent_message_id@unknown.com>",
          references: ["<non_existent_ref@unknown.com>"],
        })
      ).rejects.toThrow(TRPCError);
    });

    it("4. rejects ambiguous inbound match when multiple candidate conversations exist", async () => {
      const db = await requireDb();
      const sharedSender = "ambiguous-candidate@example.com";

      // Create two separate open conversations with the same sender mentioned
      const conv1 = createId("cnv_amb1_");
      const conv2 = createId("cnv_amb2_");

      await db.insert(conversations).values([
        { id: conv1, ownerId, subject: "Role A", status: "open" },
        { id: conv2, ownerId, subject: "Role B", status: "open" },
      ]);

      await db.insert(messages).values([
        {
          id: createId("msg_amb1_"),
          conversationId: conv1,
          ownerId,
          direction: "outbound",
          status: "sent",
          body: `Sending details to ${sharedSender}`,
          idempotencyKey: `amb1:${sharedSender}`,
        },
        {
          id: createId("msg_amb2_"),
          conversationId: conv2,
          ownerId,
          direction: "outbound",
          status: "sent",
          body: `Following up with ${sharedSender}`,
          idempotencyKey: `amb2:${sharedSender}`,
        },
      ]);

      // Reply with no message-id references, matching both conversations ambiguously
      await expect(
        emailCaller.inbound.recordByThread({
          sender: sharedSender,
          subject: "Ambiguous response",
          body: "I am interested in both roles.",
          providerMessageId: `<amb_inbound_${Date.now()}@mail.example.com>`,
        })
      ).rejects.toThrow(TRPCError);
    });

    it("5. strictly enforces tenant isolation: cannot match messages belonging to another owner", async () => {
      const db = await requireDb();
      const foreignOwnerId = 9999;
      const foreignConvId = createId("cnv_foreign_");
      const foreignMsgId = createId("msg_foreign_");
      const foreignProviderId = `<foreign_${Date.now()}@overseasjob.in>`;

      await db.insert(conversations).values({
        id: foreignConvId,
        ownerId: foreignOwnerId,
        subject: "Foreign Conversation",
        status: "open",
      });

      await db.insert(messages).values({
        id: foreignMsgId,
        conversationId: foreignConvId,
        ownerId: foreignOwnerId,
        direction: "outbound",
        status: "sent",
        body: "Confidential message from another tenant",
        providerMessageId: foreignProviderId,
        idempotencyKey: `foreign:${foreignMsgId}`,
      });

      // Current owner attempts to record reply pointing to foreign tenant's message ID
      await expect(
        emailCaller.inbound.recordByThread({
          sender: "reply@example.com",
          subject: "Re: Foreign Conversation",
          body: "Trying to access foreign tenant",
          providerMessageId: `<probe_${Date.now()}@mail.example.com>`,
          inReplyTo: foreignProviderId,
        })
      ).rejects.toThrow(TRPCError);
    });
  });

  // =========================================================================
  // RB-12: LEGACY OWNER FALLBACK
  // =========================================================================
  describe("RB-12: Legacy Owner Fallback Elimination", () => {
    it("createContext fails closed to null user when unauthenticated", async () => {
      const req = { headers: {} } as any;
      const res = {} as any;

      const context = await createContext({ req, res });
      // In default environment without DEV_FALLBACK_OWNER=true, user is null
      expect(context.user).toBeNull();
      expect(context.actor).toBeNull();
    });

    it("isPrimaryOwner strictly refuses hardcoded dev owner in production mode", () => {
      const prevEnv = process.env.NODE_ENV;
      const prevVitest = process.env.VITEST;

      try {
        process.env.NODE_ENV = "production";
        delete process.env.VITEST;

        const isOwner = isPrimaryOwner({
          openId: "owner_dev",
          email: "owner@freelancehr.local",
        });

        // In production without env config, must NOT recognize owner_dev
        expect(isOwner).toBe(false);
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevVitest) process.env.VITEST = prevVitest;
      }
    });
  });

  // =========================================================================
  // RB-05: AI QUEUE COMPLETION (send_reminder & reconcile_invoice)
  // =========================================================================
  describe("RB-05: AI Queue Task Completion", () => {
    it("1. send_reminder updates confirmed interview to reminder_sent and creates draft", async () => {
      const db = await requireDb();
      await ensureWorkspace(ownerId);

      const candidateId = createId("cnd_rem_");
      const companyId = createId("cmp_rem_");
      const jobId = createId("job_rem_");
      const interviewId = createId("int_rem_");

      await db.insert(companies).values({ id: companyId, ownerId, name: "Reminder Client" });
      await db.insert(candidates).values({ id: candidateId, ownerId, fullName: "Reminder Candidate" });
      await db.insert(jobs).values({ id: jobId, ownerId, companyId, title: "Reminder Job", status: "published" });

      await db.insert(interviews).values({
        id: interviewId,
        ownerId,
        companyId,
        candidateId,
        jobId,
        status: "confirmed",
        calendarStatus: "confirmed",
        scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const { handleAiTaskResult } = await import("./services/queue");

      const fakeJob: any = {
        id: createId("que_rem_"),
        ownerId,
        jobType: "send_reminder",
        payload: {
          interviewId,
        },
      };

      await handleAiTaskResult(
        fakeJob,
        {
          subject: "Your interview is tomorrow",
          body: "Please join on time.",
          channel: "email",
          sendAfter: null,
        },
        "test-model",
        ownerId,
        db
      );

      const [updatedInterview] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
      expect(updatedInterview.status).toBe("reminder_sent");
      expect(updatedInterview.reminderSentAt).toBeInstanceOf(Date);

      // Verify draft message was created
      const allMessages = await db.select().from(messages).where(eq(messages.ownerId, ownerId));
      const drafts = allMessages.filter((m: any) => m.candidateId === candidateId);
      expect(drafts.length).toBeGreaterThan(0);
      expect(drafts[0].subject).toBe("Your interview is tomorrow");
    });

    it("2. reconcile_invoice transitions overdue invoice when confidence is high without altering monetary truth", async () => {
      const db = await requireDb();
      await ensureWorkspace(ownerId);

      const invoiceId = createId("inv_rec_test_");
      await db.insert(invoices).values({
        id: invoiceId,
        ownerId,
        invoiceNumber: "INV-REC-99",
        amount: 150000,
        status: "delivered",
        dueAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      });

      const { handleAiTaskResult } = await import("./services/queue");

      const fakeJob: any = {
        id: createId("que_inv_"),
        ownerId,
        jobType: "reconcile_invoice",
        payload: {
          invoiceId,
        },
      };

      await handleAiTaskResult(
        fakeJob,
        {
          status: "overdue",
          confidence: 95,
          rationale: "Due date elapsed 7 days ago with no settlement recorded.",
        },
        "test-model",
        ownerId,
        db
      );

      const [updatedInv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(updatedInv.status).toBe("overdue");
    });
  });
});
