import { beforeAll, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import {
  approvals,
  auditEvents,
  automationQueue,
  candidates,
  companies,
  consents,
  conversations,
  incidents,
  interviews,
  invoices,
  jobs,
  messages,
  placements,
  shortlists,
  suppressionList,
  users,
} from "../drizzle/schema";
import { createId, hashContactValue, requireDb } from "./db";
import { consequentialRouter } from "./routers/consequential";
import { emailRouter } from "./routers/email";
import { applyApprovalDecision } from "./services/approvalEngine";
import {
  sendViaHostingerMailApi,
  getSenderAddress,
} from "./services/hostingerMail";
import { processHostingerMailWebhook } from "./services/hostingerWebhook";
import { processDueInterviewReminders } from "./services/interviewReminders";
import { handleAiTaskResult, processOneQueuedJob } from "./services/queue";

describe("P0.3-C Release Blockers Remediation Suite (RB-09, RB-10, RB-05)", () => {
  const ownerId = 9101;
  const otherOwnerId = 9102;
  const ctx = {
    user: { id: ownerId, role: "admin", name: "RB Owner", email: "rb.owner@test.local" },
    workspace: { ownerId, role: "owner", isOwner: true },
  } as any;
  const otherCtx = {
    user: { id: otherOwnerId, role: "admin", name: "Other Owner", email: "other@test.local" },
    workspace: { ownerId: otherOwnerId, role: "owner", isOwner: true },
  } as any;

  const consequentialCaller = consequentialRouter.createCaller(ctx);
  const otherConsequentialCaller = consequentialRouter.createCaller(otherCtx);

  beforeAll(async () => {
    const db = await requireDb();
    const existing = (await db.select().from(users).where(eq(users.id, ownerId)).limit(1))[0];
    if (!existing) {
      await db.insert(users).values({
        id: ownerId,
        openId: "rb_owner_openid",
        email: "rb.owner@test.local",
        role: "admin",
        name: "RB Owner",
      });
    }
    process.env.PRIMARY_OWNER_OPEN_ID = "rb_owner_openid";
    process.env.PRIMARY_OWNER_EMAIL = "rb.owner@test.local";
  });

  // =========================================================================
  // RB-09: CONSEQUENTIAL ACTION ROUTING
  // =========================================================================
  describe("RB-09: Consequential Action Routing", () => {
    describe("client_onboarding", () => {
      it("valid converted company creates pending approval without immediate activation", async () => {
        const db = await requireDb();
        const companyId = createId("cmp_onb_1_");
        await db.insert(companies).values({
          id: companyId,
          ownerId,
          name: "Converted Prospect Ltd",
          pipelineState: "converted",
          companyType: "prospect",
        });

        const res = await consequentialCaller.requestClientOnboarding({
          companyId,
          reason: "Completed onboarding checklist",
        });

        expect(res.companyId).toBe(companyId);
        expect(res.approvalId).toBeDefined();

        // Must NOT activate immediately
        const [cmp] = await db.select().from(companies).where(eq(companies.id, companyId));
        expect(cmp.pipelineState).toBe("converted");
        expect(cmp.companyType).toBe("prospect");

        // Approval is pending with decisionSource manual
        const [apr] = await db.select().from(approvals).where(eq(approvals.id, res.approvalId));
        expect(apr.status).toBe("pending");
        expect(apr.actionType).toBe("client_onboarding");

        // Approved request activates it via the existing side effect
        const dec = await consequentialCaller.decide({
          approvalId: res.approvalId,
          decision: "approved",
          note: "Authorized client conversion",
        });
        expect(dec.success).toBe(true);

        const [activated] = await db.select().from(companies).where(eq(companies.id, companyId));
        expect(activated.pipelineState).toBe("active");
        expect(activated.companyType).toBe("client");
      });

      it("unauthorized company cannot be requested", async () => {
        const db = await requireDb();
        const companyId = createId("cmp_onb_unauth_");
        await db.insert(companies).values({
          id: companyId,
          ownerId: otherOwnerId,
          name: "Other Company",
          pipelineState: "converted",
        });

        await expect(
          consequentialCaller.requestClientOnboarding({ companyId })
        ).rejects.toThrow("Company was not found.");
      });

      it("duplicate client_onboarding request is rejected", async () => {
        const db = await requireDb();
        const companyId = createId("cmp_onb_dup_");
        await db.insert(companies).values({
          id: companyId,
          ownerId,
          name: "Duplicate Test Co",
          pipelineState: "converted",
        });

        const res = await consequentialCaller.requestClientOnboarding({ companyId });
        expect(res.approvalId).toBeDefined();

        await expect(
          consequentialCaller.requestClientOnboarding({ companyId })
        ).rejects.toThrow("A client onboarding approval is already pending for this company.");
      });

      it("company in non-converted or suppressed state is rejected", async () => {
        const db = await requireDb();
        const suppressedId = createId("cmp_onb_supp_");
        await db.insert(companies).values({
          id: suppressedId,
          ownerId,
          name: "Suppressed Co",
          pipelineState: "suppressed",
        });

        await expect(
          consequentialCaller.requestClientOnboarding({ companyId: suppressedId })
        ).rejects.toThrow("Company must be in converted state");
      });
    });

    describe("candidate_share", () => {
      it("valid shortlist moves prepared → approval_pending, and approved decision transitions to shared", async () => {
        const db = await requireDb();
        const candId = createId("cnd_sh_1_");
        const compId = createId("cmp_sh_1_");
        const jobId = createId("job_sh_1_");
        const shortlistId = createId("shl_sh_1_");
        const consentId = createId("cns_sh_1_");

        await db.insert(candidates).values({ id: candId, ownerId, fullName: "Share Candidate" });
        await db.insert(companies).values({ id: compId, ownerId, name: "Share Client" });
        await db.insert(jobs).values({ id: jobId, ownerId, companyId: compId, title: "Share Job" });
        await db.insert(consents).values({
          id: consentId,
          ownerId,
          candidateId: candId,
          companyId: compId,
          jobId,
          consentType: "client_sharing",
          status: "granted",
          noticeVersion: "v1",
        });
        await db.insert(shortlists).values({
          id: shortlistId,
          ownerId,
          companyId: compId,
          candidateId: candId,
          jobId,
          status: "prepared",
          consentId,
        });

        const res = await consequentialCaller.requestCandidateShare({ shortlistId });
        expect(res.shortlistId).toBe(shortlistId);
        expect(res.approvalId).toBeDefined();

        // Status moved to approval_pending, NOT directly shared
        const [shlPending] = await db.select().from(shortlists).where(eq(shortlists.id, shortlistId));
        expect(shlPending.status).toBe("approval_pending");
        expect(shlPending.sharedAt).toBeFalsy();

        // Decide approval
        const dec = await consequentialCaller.decide({
          approvalId: res.approvalId,
          decision: "approved",
          note: "Approved for sharing",
        });
        expect(dec.success).toBe(true);

        const [shlShared] = await db.select().from(shortlists).where(eq(shortlists.id, shortlistId));
        expect(shlShared.status).toBe("shared");
        expect(shlShared.sharedAt).toBeInstanceOf(Date);
        expect(shlShared.shareExpiresAt).toBeInstanceOf(Date);
      });

      it("rejects candidate_share if explicit candidate client-sharing consent is missing", async () => {
        const db = await requireDb();
        const candId = createId("cnd_sh_nocns_");
        const compId = createId("cmp_sh_nocns_");
        const jobId = createId("job_sh_nocns_");
        const shortlistId = createId("shl_sh_nocns_");

        await db.insert(candidates).values({ id: candId, ownerId, fullName: "No Consent Candidate" });
        await db.insert(companies).values({ id: compId, ownerId, name: "No Consent Client" });
        await db.insert(jobs).values({ id: jobId, ownerId, companyId: compId, title: "No Consent Job" });
        await db.insert(shortlists).values({
          id: shortlistId,
          ownerId,
          companyId: compId,
          candidateId: candId,
          jobId,
          status: "prepared",
        });

        await expect(
          consequentialCaller.requestCandidateShare({ shortlistId })
        ).rejects.toThrow("Explicit candidate client-sharing consent is required");
      });

      it("rejects duplicate or invalid state candidate_share request", async () => {
        const db = await requireDb();
        const candId = createId("cnd_sh_dup_");
        const compId = createId("cmp_sh_dup_");
        const jobId = createId("job_sh_dup_");
        const shortlistId = createId("shl_sh_dup_");
        const consentId = createId("cns_sh_dup_");

        await db.insert(candidates).values({ id: candId, ownerId, fullName: "Dup Candidate" });
        await db.insert(companies).values({ id: compId, ownerId, name: "Dup Client" });
        await db.insert(jobs).values({ id: jobId, ownerId, companyId: compId, title: "Dup Job" });
        await db.insert(consents).values({
          id: consentId,
          ownerId,
          candidateId: candId,
          companyId: compId,
          jobId,
          consentType: "client_sharing",
          status: "granted",
          noticeVersion: "v1",
        });
        await db.insert(shortlists).values({
          id: shortlistId,
          ownerId,
          companyId: compId,
          candidateId: candId,
          jobId,
          status: "prepared",
          consentId,
        });

        await consequentialCaller.requestCandidateShare({ shortlistId });

        // Second request rejected because status is now approval_pending
        await expect(
          consequentialCaller.requestCandidateShare({ shortlistId })
        ).rejects.toThrow("Shortlist is not in a valid pre-share state");
      });
    });

    describe("placement_confirmation", () => {
      it("valid placement in joining_pending creates approval without immediate joining_confirmed state", async () => {
        const db = await requireDb();
        const compId = createId("cmp_plc_1_");
        const candId = createId("cnd_plc_1_");
        const jobId = createId("job_plc_1_");
        const placementId = createId("plc_conf_1_");

        await db.insert(companies).values({ id: compId, ownerId, name: "Placement Client" });
        await db.insert(candidates).values({ id: candId, ownerId, fullName: "Placed Candidate" });
        await db.insert(jobs).values({ id: jobId, ownerId, companyId: compId, title: "Placed Job" });
        await db.insert(placements).values({
          id: placementId,
          ownerId,
          companyId: compId,
          candidateId: candId,
          jobId,
          status: "joining_pending",
        });

        const res = await consequentialCaller.requestPlacementConfirmation({
          placementId,
          joiningEvidence: ["Offer Letter Signed", "Badge Issued", "First Day Attendance Verified"],
        });

        expect(res.placementId).toBe(placementId);
        expect(res.approvalId).toBeDefined();

        // Must NOT confirm immediately
        const [plc] = await db.select().from(placements).where(eq(placements.id, placementId));
        expect(plc.status).toBe("joining_pending");
        expect(plc.joiningConfirmedAt).toBeFalsy();

        // Approved request confirms joining via side effect
        const dec = await consequentialCaller.decide({
          approvalId: res.approvalId,
          decision: "approved",
          note: "Joining verified with HR",
        });
        expect(dec.success).toBe(true);

        const [confirmed] = await db.select().from(placements).where(eq(placements.id, placementId));
        expect(confirmed.status).toBe("joining_confirmed");
        expect(confirmed.joiningConfirmedAt).toBeInstanceOf(Date);
        expect(confirmed.joiningEvidence).toEqual([
          "Offer Letter Signed",
          "Badge Issued",
          "First Day Attendance Verified",
        ]);
      });

      it("rejects placement_confirmation for placement not in joining_pending state", async () => {
        const db = await requireDb();
        const placementId = createId("plc_conf_invalid_");
        await db.insert(placements).values({
          id: placementId,
          ownerId,
          companyId: "cmp_x",
          candidateId: "cnd_x",
          jobId: "job_x",
          status: "offer_pending",
        });

        await expect(
          consequentialCaller.requestPlacementConfirmation({
            placementId,
            joiningEvidence: ["Badge"],
          })
        ).rejects.toThrow("Placement must be in joining_pending state");
      });
    });

    describe("invoice_issue", () => {
      it("valid draft invoice moves to approval_pending, and approved decision sets status to issued", async () => {
        const db = await requireDb();
        const invoiceId = createId("inv_iss_1_");
        await db.insert(invoices).values({
          id: invoiceId,
          ownerId,
          companyId: "cmp_inv",
          placementId: "plc_inv",
          invoiceNumber: "INV-RB09-001",
          amount: 120000,
          status: "draft",
        });

        const res = await consequentialCaller.requestInvoiceIssue({ invoiceId });
        expect(res.invoiceId).toBe(invoiceId);
        expect(res.approvalId).toBeDefined();

        // Invoice status is approval_pending, NOT issued
        const [invPending] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
        expect(invPending.status).toBe("approval_pending");
        expect(invPending.issuedAt).toBeFalsy();

        // Decide approval
        const dec = await consequentialCaller.decide({
          approvalId: res.approvalId,
          decision: "approved",
          note: "Approved commercial issue",
        });
        expect(dec.success).toBe(true);

        const [invIssued] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
        expect(invIssued.status).toBe("issued");
        expect(invIssued.issuedAt).toBeInstanceOf(Date);
      });

      it("duplicate invoice_issue request is rejected", async () => {
        const db = await requireDb();
        const invoiceId = createId("inv_iss_dup_");
        await db.insert(invoices).values({
          id: invoiceId,
          ownerId,
          companyId: "cmp_inv",
          placementId: "plc_inv",
          invoiceNumber: "INV-RB09-DUP",
          amount: 50000,
          status: "draft",
        });

        await consequentialCaller.requestInvoiceIssue({ invoiceId });

        await expect(
          consequentialCaller.requestInvoiceIssue({ invoiceId })
        ).rejects.toThrow("An invoice issue approval is already pending for this invoice.");
      });
    });
  });

  // =========================================================================
  // RB-10: REAL HOSTINGER EMAIL THREADING
  // =========================================================================
  describe("RB-10: Real Hostinger Email Threading", () => {
    it("1. successful Hostinger send with empty/204 response succeeds without fabricated IDs", async () => {
      const previousEnv = { ...process.env };
      process.env.HOSTINGER_MAIL_API_TOKEN = "mock-token";
      process.env.HOSTINGER_MAILBOX_OWNER_ID = "mock-owner-id";
      process.env.HOSTINGER_MAIL_FROM_DOMAIN = "overseasjob.in";

      const { SendApi } = await import("hostinger-mail-api-sdk");
      const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockResolvedValueOnce({
        data: null, // Hostinger send returns void (204 No Content)
        status: 204,
        statusText: "No Content",
        headers: {},
        config: {} as any,
      } as any);

      const res = await sendViaHostingerMailApi({
        purpose: "owner",
        to: "client@test.com",
        displayName: "FreelanceHR",
        subject: "Contract Terms",
        text: "Please find the terms attached.",
      });

      expect(res.mailboxResourceId).toBe("mock-owner-id");
      expect(res.senderAddress).toBe("owner.fl@overseasjob.in");
      expect(res.providerMessageId).toBeNull(); // Never fabricated
      expect(res.providerUid).toBeNull();

      sendSpy.mockRestore();
      process.env = previousEnv;
    });

    it("2. no fabricated providerMessageId when send response is empty and sent resolution finds nothing", async () => {
      const previousEnv = { ...process.env };
      process.env.HOSTINGER_MAIL_API_TOKEN = "mock-token";
      process.env.HOSTINGER_MAILBOX_OWNER_ID = "mock-owner-id";
      process.env.HOSTINGER_MAIL_FROM_DOMAIN = "overseasjob.in";

      const { SendApi, MessagesApi } = await import("hostinger-mail-api-sdk");
      const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockResolvedValueOnce({
        data: null,
        status: 204,
      } as any);
      const searchSpy = vi.spyOn(MessagesApi.prototype, "searchMessages").mockResolvedValueOnce({
        data: { data: [], pagination: { total: 0, page: 1, perPage: 10 } },
        status: 200,
      } as any);

      const res = await sendViaHostingerMailApi({
        purpose: "owner",
        to: "unfound@test.com",
        displayName: "FreelanceHR",
        subject: "Unfound Sent Search",
        text: "Body text",
      });

      expect(res.providerMessageId).toBeNull();
      expect(res.providerUid).toBeNull();
      expect(res.messageId).toBeNull();

      sendSpy.mockRestore();
      searchSpy.mockRestore();
      process.env = previousEnv;
    });

    it("3. Sent-folder message resolution retrieves UID, folder, and RFC Message-ID", async () => {
      const previousEnv = { ...process.env };
      process.env.HOSTINGER_MAIL_API_TOKEN = "mock-token";
      process.env.HOSTINGER_MAILBOX_OWNER_ID = "mock-owner-id";
      process.env.HOSTINGER_MAIL_FROM_DOMAIN = "overseasjob.in";

      const { SendApi, MessagesApi } = await import("hostinger-mail-api-sdk");
      const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockResolvedValueOnce({
        data: null,
        status: 204,
      } as any);

      const mockSentMsg = {
        uid: 7891,
        path: "INBOX.Sent",
        date: new Date().toISOString(),
        subject: "Resolution Subject",
        to: [{ address: "resolve.target@test.com" }],
        messageId: "<rfc-sent-7891@overseasjob.in>",
        inReplyTo: null,
        flags: [],
        unseen: false,
        size: 1024,
        attachments: [],
      };

      const searchSpy = vi.spyOn(MessagesApi.prototype, "searchMessages").mockResolvedValueOnce({
        data: { data: [mockSentMsg], pagination: { total: 1, page: 1, perPage: 10 } },
        status: 200,
      } as any);

      const res = await sendViaHostingerMailApi({
        purpose: "owner",
        to: "resolve.target@test.com",
        displayName: "FreelanceHR",
        subject: "Resolution Subject",
        text: "Resolved message body",
      });

      expect(res.providerUid).toBe(7891);
      expect(res.providerFolder).toBe("INBOX.Sent");
      expect(res.messageId).toBe("<rfc-sent-7891@overseasjob.in>");
      expect(res.providerMessageId).toBe("<rfc-sent-7891@overseasjob.in>");

      sendSpy.mockRestore();
      searchSpy.mockRestore();
      process.env = previousEnv;
    });

    it("4. provider UID, provider folder, and RFC Message-ID are persisted into messages row upon delivery", async () => {
      const db = await requireDb();
      const previousEnv = { ...process.env };
      process.env.HOSTINGER_MAIL_API_TOKEN = "mock-token";
      process.env.HOSTINGER_MAILBOX_INTERVIEWS_ID = "box-int-123";
      process.env.HOSTINGER_MAIL_FROM_DOMAIN = "overseasjob.in";

      const convId = createId("cnv_persist_");
      const msgId = createId("msg_persist_");
      await db.insert(conversations).values({ id: convId, ownerId, channel: "email", status: "active" });
      await db.insert(messages).values({
        id: msgId,
        conversationId: convId,
        ownerId,
        direction: "outbound",
        status: "draft",
        subject: "Persist Test",
        body: "Persist Test Body",
        idempotencyKey: `persist:${msgId}`,
      });

      const { SendApi, MessagesApi } = await import("hostinger-mail-api-sdk");
      const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockResolvedValueOnce({
        data: null,
        status: 204,
      } as any);

      const mockSentMsg = {
        uid: 8842,
        path: "INBOX.Sent",
        date: new Date().toISOString(),
        subject: "Persist Test",
        to: [{ address: "candidate.persist@test.com" }],
        messageId: "<rfc-8842@overseasjob.in>",
        inReplyTo: null,
      };

      const searchSpy = vi.spyOn(MessagesApi.prototype, "searchMessages").mockResolvedValueOnce({
        data: { data: [mockSentMsg], pagination: { total: 1, page: 1, perPage: 10 } },
        status: 200,
      } as any);

      const sendResult = await sendViaHostingerMailApi({
        purpose: "interviews",
        to: "candidate.persist@test.com",
        displayName: "FreelanceHR Interviews",
        subject: "Persist Test",
        text: "Persist Test Body",
      });

      const now = new Date();
      await db.update(messages).set({
        status: "sent",
        providerMessageId: sendResult.providerMessageId,
        providerUid: sendResult.providerUid,
        providerFolder: sendResult.providerFolder,
        messageId: sendResult.messageId,
        inReplyTo: sendResult.inReplyTo,
        sentAt: now,
      }).where(eq(messages.id, msgId));

      const [stored] = await db.select().from(messages).where(eq(messages.id, msgId));
      expect(stored.status).toBe("sent");
      expect(stored.providerUid).toBe(8842);
      expect(stored.providerFolder).toBe("INBOX.Sent");
      expect(stored.messageId).toBe("<rfc-8842@overseasjob.in>");
      expect(stored.providerMessageId).toBe("<rfc-8842@overseasjob.in>");

      sendSpy.mockRestore();
      searchSpy.mockRestore();
      process.env = previousEnv;
    });

    it("5. reply uses provider UID + folder with Hostinger V1SendMessageRef", async () => {
      const previousEnv = { ...process.env };
      process.env.HOSTINGER_MAIL_API_TOKEN = "mock-token";
      process.env.HOSTINGER_MAILBOX_OWNER_ID = "mock-owner-id";
      process.env.HOSTINGER_MAIL_FROM_DOMAIN = "overseasjob.in";

      const { SendApi } = await import("hostinger-mail-api-sdk");
      let capturedPayload: any = null;
      const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockImplementationOnce(async (_box, payload) => {
        capturedPayload = payload;
        return { data: null, status: 204 } as any;
      });

      await sendViaHostingerMailApi({
        purpose: "owner",
        to: "client@test.com",
        displayName: "FreelanceHR",
        subject: "Re: Hiring Requirement",
        text: "We have candidates ready.",
        inReplyTo: { uid: 8842, folder: "INBOX.Sent" },
      });

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload.inReplyTo).toEqual({ uid: 8842, folder: "INBOX.Sent" });

      sendSpy.mockRestore();
      process.env = previousEnv;
    });

    it("6. inbound In-Reply-To matches correct outbound message via RFC messageId", async () => {
      const db = await requireDb();
      process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "wh-secret-test";
      process.env.PRIMARY_OWNER_EMAIL = "rb.owner@test.local";

      const convId = createId("cnv_wb_rfc_");
      const outMsgId = createId("msg_out_wb_rfc_");
      const rfcId = "<outbound-orig-999@overseasjob.in>";

      await db.insert(conversations).values({ id: convId, ownerId, channel: "email", status: "waiting" });
      await db.insert(messages).values({
        id: outMsgId,
        conversationId: convId,
        ownerId,
        direction: "outbound",
        status: "sent",
        body: "Initial outbound email",
        messageId: rfcId,
        providerMessageId: rfcId,
        idempotencyKey: `out:${outMsgId}`,
      });

      const res = await processHostingerMailWebhook({
        authorization: "Bearer wh-secret-test",
        body: {
          event: "message.received",
          data: {
            messageId: "<inbound-reply-101@external.com>",
            from: "candidate@external.com",
            subject: "Re: Initial outbound email",
            text: "Yes, I am available tomorrow.",
            inReplyTo: rfcId,
          },
        },
      });

      expect(res.statusCode).toBe(202);
      expect((res.body as any).status).toBe("classification_queued");
      expect((res.body as any).conversationId).toBe(convId);

      // Verify stored message has correct threading fields
      const msgs = await db.select().from(messages).where(eq(messages.conversationId, convId));
      const inboundMsg = msgs.find(m => m.direction === "inbound");
      expect(inboundMsg).toBeDefined();
      expect(inboundMsg?.inReplyTo).toBe(rfcId);
    });

    it("7. inbound References match correct conversation via RFC messageId", async () => {
      const db = await requireDb();
      process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "wh-secret-test";

      const convId = createId("cnv_wb_ref_rfc_");
      const outMsgId = createId("msg_out_wb_ref_rfc_");
      const rfcId = "<root-thread-msg-777@overseasjob.in>";

      await db.insert(conversations).values({ id: convId, ownerId, channel: "email", status: "waiting" });
      await db.insert(messages).values({
        id: outMsgId,
        conversationId: convId,
        ownerId,
        direction: "outbound",
        status: "sent",
        body: "Thread initiation",
        messageId: rfcId,
        idempotencyKey: `out:${outMsgId}`,
      });

      const res = await processHostingerMailWebhook({
        authorization: "Bearer wh-secret-test",
        body: {
          event: "message.received",
          data: {
            messageId: "<inbound-ref-reply@external.com>",
            from: "client@external.com",
            subject: "Re: Thread initiation",
            text: "Sounds great.",
            references: [rfcId],
          },
        },
      });

      expect(res.statusCode).toBe(202);
      expect((res.body as any).conversationId).toBe(convId);
    });

    it("8. ambiguous reference across multiple conversations does not auto-attach", async () => {
      const db = await requireDb();
      process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "wh-secret-test";

      const sharedRef = "<shared-conflict-ref@overseasjob.in>";
      const convA = createId("cnv_amb_1_");
      const convB = createId("cnv_amb_2_");

      await db.insert(conversations).values({ id: convA, ownerId, channel: "email", status: "open" });
      await db.insert(conversations).values({ id: convB, ownerId, channel: "email", status: "open" });

      const msgA = createId("msg_amb_1_");
      const msgB = createId("msg_amb_2_");
      await db.insert(messages).values({
        id: msgA,
        conversationId: convA,
        ownerId,
        direction: "outbound",
        status: "sent",
        body: "Thread 1 message",
        messageId: sharedRef,
        idempotencyKey: `amb:${msgA}`,
      });
      await db.insert(messages).values({
        id: msgB,
        conversationId: convB,
        ownerId,
        direction: "outbound",
        status: "sent",
        body: "Thread 2 message",
        messageId: sharedRef,
        idempotencyKey: `amb:${msgB}`,
      });

      const res = await processHostingerMailWebhook({
        authorization: "Bearer wh-secret-test",
        body: {
          event: "message.received",
          data: {
            messageId: "<inbound-amb-incoming>",
            from: "applicant@test.com",
            subject: "Re: Ambiguous",
            text: "Which thread?",
            inReplyTo: sharedRef,
          },
        },
      });

      expect(res.statusCode).toBe(202);
      expect((res.body as any).status).toBe("routed_to_exception");
      expect((res.body as any).reason).toBe("ambiguous_match");
    });

    it("9. unmatched inbound email remains unmatched and routes to exception center", async () => {
      process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "wh-secret-test";

      const res = await processHostingerMailWebhook({
        authorization: "Bearer wh-secret-test",
        body: {
          event: "message.received",
          data: {
            messageId: "<unknown-unmatched-msg-id>",
            from: "random.unknown@nowhere.com",
            subject: "Unsolicited Pitch",
            text: "Hello, buy our service.",
            inReplyTo: "<no-such-parent-exists>",
          },
        },
      });

      expect(res.statusCode).toBe(202);
      expect((res.body as any).status).toBe("routed_to_exception");
      expect((res.body as any).reason).toBe("unmatched");
    });

    it("10. tenant isolation: inbound email cannot match messages belonging to another owner", async () => {
      const db = await requireDb();
      process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "wh-secret-test";

      const otherConv = createId("cnv_other_tenant_");
      const otherMsg = createId("msg_other_tenant_");
      const foreignRfcId = "<other-tenant-secret-rfc@overseasjob.in>";

      await db.insert(conversations).values({
        id: otherConv,
        ownerId: otherOwnerId, // Foreign owner
        channel: "email",
        status: "open",
      });
      await db.insert(messages).values({
        id: otherMsg,
        conversationId: otherConv,
        ownerId: otherOwnerId,
        direction: "outbound",
        status: "sent",
        body: "Foreign owner message",
        messageId: foreignRfcId,
        idempotencyKey: `foreign:${otherMsg}`,
      });

      // Webhook inbound event received under primary owner (ownerId)
      const res = await processHostingerMailWebhook({
        authorization: "Bearer wh-secret-test",
        body: {
          event: "message.received",
          data: {
            messageId: "<foreign-reply-probe@test.com>",
            from: "probe@test.com",
            subject: "Re: Foreign",
            text: "Attacking across tenants",
            inReplyTo: foreignRfcId,
          },
        },
      });

      // Must NOT match other owner's conversation
      expect(res.statusCode).toBe(202);
      expect((res.body as any).status).toBe("routed_to_exception");
      expect((res.body as any).reason).toBe("unmatched");
    });
  });

  // =========================================================================
  // RB-05: INTERVIEW REMINDER RELIABILITY & DISPATCH
  // =========================================================================
  // Reminder reliability, receipt persistence, opt-out, retry quarantine and reschedule
  // are exercised through the real central workflow in services/followups.test.ts.
  describe("RB-05: Legacy reminder bypass prevention", () => {
    it("refuses AI reminder output without going through the central workflow", async () => {
      const db = await requireDb();
      await expect(handleAiTaskResult({ id: createId("que_"), ownerId, jobType: "send_reminder", payload: {} } as any, { subject: "Unapproved", body: "No direct provider call", channel: "email" }, "test-model", ownerId, db)).rejects.toThrow(/central follow-up/);
    });
  });
});
