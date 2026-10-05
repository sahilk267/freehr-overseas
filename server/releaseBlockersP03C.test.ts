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
  // RB-10: REAL EMAIL THREADING
  // =========================================================================
  describe("RB-10: Real Email Threading", () => {
    it("1. providerMessageId is stored ONLY when provider returns one; never fabricated", async () => {
      // Simulate hostinger API call where provider does not return a messageId
      const previousEnv = { ...process.env };
      process.env.HOSTINGER_MAIL_API_TOKEN = "mock-token";
      process.env.HOSTINGER_MAIL_BOX_OWNER_ID = "mock-owner-id";
      process.env.HOSTINGER_MAILBOX_OWNER_ID = "mock-owner-id";
      process.env.HOSTINGER_MAIL_FROM_DOMAIN = "overseasjob.in";

      // Mock SendApi inside the test
      const { SendApi } = await import("hostinger-mail-api-sdk");
      const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockResolvedValueOnce({
        data: {}, // no messageId returned
        status: 200,
        statusText: "OK",
        headers: {},
        config: {} as any,
      });

      const res = await sendViaHostingerMailApi({
        purpose: "owner",
        to: "client@test.com",
        displayName: "FreelanceHR",
        subject: "Test Subject",
        text: "Test Body",
        messageId: "msg_local_123",
      });

      expect(res.providerMessageId).toBeNull();
      expect(res.messageId).toBe("<msg_local_123@overseasjob.in>");

      sendSpy.mockRestore();
      process.env = previousEnv;
    });

    it("2. providerMessageId is stored accurately when provider does return one", async () => {
      const previousEnv = { ...process.env };
      process.env.HOSTINGER_MAIL_API_TOKEN = "mock-token";
      process.env.HOSTINGER_MAILBOX_OWNER_ID = "mock-owner-id";
      process.env.HOSTINGER_MAIL_FROM_DOMAIN = "overseasjob.in";

      const { SendApi } = await import("hostinger-mail-api-sdk");
      const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockResolvedValueOnce({
        data: { id: "hostinger-prov-uuid-999" },
        status: 200,
        statusText: "OK",
        headers: {},
        config: {} as any,
      });

      const res = await sendViaHostingerMailApi({
        purpose: "owner",
        to: "client@test.com",
        displayName: "FreelanceHR",
        subject: "Test Subject",
        text: "Test Body",
        messageId: "msg_local_456",
      });

      expect(res.providerMessageId).toBe("hostinger-prov-uuid-999");
      expect(res.messageId).toBe("<msg_local_456@overseasjob.in>");

      sendSpy.mockRestore();
      process.env = previousEnv;
    });

    it("3. inReplyTo is passed to Hostinger SendApi when supported format is provided", async () => {
      const previousEnv = { ...process.env };
      process.env.HOSTINGER_MAIL_API_TOKEN = "mock-token";
      process.env.HOSTINGER_MAILBOX_OWNER_ID = "mock-owner-id";
      process.env.HOSTINGER_MAIL_FROM_DOMAIN = "overseasjob.in";

      const { SendApi } = await import("hostinger-mail-api-sdk");
      let capturedPayload: any = null;
      const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockImplementationOnce(async (_box, payload) => {
        capturedPayload = payload;
        return { data: { id: "prov-id-reply" } } as any;
      });

      await sendViaHostingerMailApi({
        purpose: "owner",
        to: "client@test.com",
        displayName: "FreelanceHR",
        subject: "Re: Hiring",
        text: "Reply body",
        inReplyTo: { uid: 4321, folder: "INBOX" },
      });

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload.inReplyTo).toEqual({ uid: 4321, folder: "INBOX" });

      sendSpy.mockRestore();
      process.env = previousEnv;
    });

    it("4. inbound matching priority: In-Reply-To match connects to correct conversation", async () => {
      const db = await requireDb();
      process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "wh-secret-test";
      process.env.PRIMARY_OWNER_EMAIL = "rb.owner@test.local";

      const convId = createId("cnv_wb_1_");
      const outMsgId = createId("msg_out_wb_1_");
      await db.insert(conversations).values({
        id: convId,
        ownerId,
        channel: "email",
        status: "waiting",
      });
      await db.insert(messages).values({
        id: outMsgId,
        conversationId: convId,
        ownerId,
        direction: "outbound",
        status: "sent",
        body: "Outbound question",
        providerMessageId: "prov_msg_parent_1",
        idempotencyKey: `out:${outMsgId}`,
      });

      const res = await processHostingerMailWebhook({
        authorization: "Bearer wh-secret-test",
        body: {
          event: "message.received",
          data: {
            messageId: "prov_in_1",
            from: "candidate@external.com",
            subject: "Re: Outbound question",
            text: "Here is my answer.",
            inReplyTo: "prov_msg_parent_1",
          },
        },
      });

      expect(res.statusCode).toBe(202);
      expect((res.body as any).status).toBe("classification_queued");
      expect((res.body as any).conversationId).toBe(convId);
    });

    it("5. inbound matching priority: References match connects to correct conversation", async () => {
      const db = await requireDb();
      process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "wh-secret-test";

      const convId = createId("cnv_wb_ref_");
      const outMsgId = createId("msg_out_wb_ref_");
      await db.insert(conversations).values({
        id: convId,
        ownerId,
        channel: "email",
        status: "waiting",
      });
      await db.insert(messages).values({
        id: outMsgId,
        conversationId: convId,
        ownerId,
        direction: "outbound",
        status: "sent",
        body: "Outbound ref question",
        providerMessageId: "prov_msg_ref_parent",
        idempotencyKey: `out:${outMsgId}`,
      });

      const res = await processHostingerMailWebhook({
        authorization: "Bearer wh-secret-test",
        body: {
          event: "message.received",
          data: {
            messageId: "prov_in_ref_1",
            from: "candidate@external.com",
            subject: "Re: Question",
            text: "References answer.",
            references: ["<prov_msg_ref_parent>"],
          },
        },
      });

      expect(res.statusCode).toBe(202);
      expect((res.body as any).conversationId).toBe(convId);
    });

    it("6. unmatched inbound email remains unmatched and routes to exception center", async () => {
      process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "wh-secret-test";

      const res = await processHostingerMailWebhook({
        authorization: "Bearer wh-secret-test",
        body: {
          event: "message.received",
          data: {
            messageId: "prov_in_unmatched_99",
            from: "completely_unknown_person@nowhere.com",
            subject: "Spam or unknown",
            text: "Hello there.",
            inReplyTo: "non_existent_ref_9999",
          },
        },
      });

      expect(res.statusCode).toBe(202);
      expect((res.body as any).status).toBe("routed_to_exception");
      expect((res.body as any).reason).toBe("unmatched");
    });

    it("7. ambiguous match across multiple conversations is rejected and routed to exception", async () => {
      const db = await requireDb();
      process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "wh-secret-test";

      const sharedRef = "shared_ambiguous_ref_123";
      const convA = createId("cnv_amb_a_");
      const convB = createId("cnv_amb_b_");

      await db.insert(conversations).values({ id: convA, ownerId, channel: "email", status: "open" });
      await db.insert(conversations).values({ id: convB, ownerId, channel: "email", status: "open" });

      const msgA = createId("msg_amb_a_");
      const msgB = createId("msg_amb_b_");
      await db.insert(messages).values({
        id: msgA,
        conversationId: convA,
        ownerId,
        direction: "outbound",
        status: "sent",
        body: "Conversation A message",
        providerMessageId: sharedRef,
        idempotencyKey: `amb:${msgA}`,
      });
      await db.insert(messages).values({
        id: msgB,
        conversationId: convB,
        ownerId,
        direction: "outbound",
        status: "sent",
        body: "Conversation B message",
        providerMessageId: sharedRef,
        idempotencyKey: `amb:${msgB}`,
      });

      const res = await processHostingerMailWebhook({
        authorization: "Bearer wh-secret-test",
        body: {
          event: "message.received",
          data: {
            messageId: "prov_amb_incoming",
            from: "applicant@test.com",
            subject: "Re: Two matches",
            text: "Ambiguous response",
            inReplyTo: sharedRef,
          },
        },
      });

      expect(res.statusCode).toBe(202);
      expect((res.body as any).status).toBe("routed_to_exception");
      expect((res.body as any).reason).toBe("ambiguous_match");
    });

    it("8. tenant isolation: inbound email cannot match messages belonging to another owner", async () => {
      const db = await requireDb();
      process.env.HOSTINGER_MAIL_WEBHOOK_SECRET = "wh-secret-test";

      const otherConv = createId("cnv_other_own_");
      const otherMsg = createId("msg_other_own_");
      const foreignRef = "foreign_owner_ref_999";

      await db.insert(conversations).values({
        id: otherConv,
        ownerId: otherOwnerId, // DIFFERENT OWNER
        channel: "email",
        status: "open",
      });
      await db.insert(messages).values({
        id: otherMsg,
        conversationId: otherConv,
        ownerId: otherOwnerId,
        direction: "outbound",
        status: "sent",
        body: "Cross tenant outbound",
        providerMessageId: foreignRef,
        idempotencyKey: `cross:${otherMsg}`,
      });

      // Inbound event processed under current owner (resolved primary owner)
      const res = await processHostingerMailWebhook({
        authorization: "Bearer wh-secret-test",
        body: {
          event: "message.received",
          data: {
            messageId: "prov_in_cross_tenant",
            from: "someone@somewhere.com",
            subject: "Re: Foreign",
            text: "Attempt cross tenant match",
            inReplyTo: foreignRef,
          },
        },
      });

      // Must NOT match other owner's message!
      expect(res.statusCode).toBe(202);
      expect((res.body as any).status).toBe("routed_to_exception");
      expect((res.body as any).reason).toBe("unmatched");
    });
  });

  // =========================================================================
  // RB-05: ACTUAL INTERVIEW REMINDER DISPATCH
  // =========================================================================
  describe("RB-05: Actual Interview Reminder Dispatch", () => {
    it("1. successful reminder actually calls existing Hostinger mail service, marks message sent and interview reminder_sent", async () => {
      const db = await requireDb();
      const candId = createId("cnd_rem_ok_");
      const compId = createId("cmp_rem_ok_");
      const jobId = createId("job_rem_ok_");
      const intId = createId("int_rem_ok_");

      await db.insert(candidates).values({
        id: candId,
        ownerId,
        fullName: "Sarah Connor",
        email: "sarah.connor@test.com",
        profileState: "available",
      });
      await db.insert(companies).values({ id: compId, ownerId, name: "Cyberdyne Systems" });
      await db.insert(jobs).values({ id: jobId, ownerId, companyId: compId, title: "Security Specialist" });
      await db.insert(interviews).values({
        id: intId,
        ownerId,
        companyId: compId,
        candidateId: candId,
        jobId,
        status: "confirmed",
        calendarStatus: "confirmed",
        scheduledAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

      const { SendApi } = await import("hostinger-mail-api-sdk");
      let calledPayload: any = null;
      const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockImplementationOnce(async (_box, p) => {
        calledPayload = p;
        return { data: { messageId: "hostinger_rem_sent_1" } } as any;
      });

      const previousEnv = { ...process.env };
      process.env.HOSTINGER_MAIL_API_TOKEN = "mock-token";
      process.env.HOSTINGER_MAILBOX_INTERVIEWS_ID = "box-interviews-id";
      process.env.HOSTINGER_MAIL_FROM_DOMAIN = "overseasjob.in";

      const job: any = {
        id: createId("que_rem_run_"),
        ownerId,
        jobType: "send_reminder",
        payload: { interviewId: intId },
      };

      await handleAiTaskResult(
        job,
        {
          subject: "Upcoming Interview Reminder",
          body: "Hello Sarah, your interview is scheduled for tomorrow.",
          channel: "email",
        },
        "ai-model-test",
        ownerId,
        db
      );

      // Verify Hostinger was called
      expect(sendSpy).toHaveBeenCalled();
      expect(calledPayload.to).toEqual(["sarah.connor@test.com"]);
      expect(calledPayload.subject).toBe("Upcoming Interview Reminder");

      // Verify interview status is reminder_sent
      const [updatedInt] = await db.select().from(interviews).where(eq(interviews.id, intId));
      expect(updatedInt.status).toBe("reminder_sent");
      expect(updatedInt.reminderSentAt).toBeInstanceOf(Date);

      // Verify message row is created with status = sent
      const msgs = await db.select().from(messages).where(and(eq(messages.ownerId, ownerId), eq(messages.status, "sent")));
      const sentMsg = msgs.find(m => m.body.includes("Hello Sarah"));
      expect(sentMsg).toBeDefined();
      expect(sentMsg?.providerMessageId).toBe("hostinger_rem_sent_1");

      // Verify audit is interview.reminder_sent
      const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.ownerId, ownerId), eq(auditEvents.action, "interview.reminder_sent")));
      expect(audits.some(a => a.resourceId === intId)).toBe(true);

      sendSpy.mockRestore();
      process.env = previousEnv;
    });

    it("2. provider failure does NOT mark interview reminder_sent or message sent", async () => {
      const db = await requireDb();
      const candId = createId("cnd_rem_fail_");
      const intId = createId("int_rem_fail_");

      await db.insert(candidates).values({
        id: candId,
        ownerId,
        fullName: "Failing Dispatch Candidate",
        email: "fail.dispatch@test.com",
        profileState: "available",
      });
      await db.insert(interviews).values({
        id: intId,
        ownerId,
        companyId: "cmp_fail",
        candidateId: candId,
        jobId: "job_fail",
        status: "confirmed",
        calendarStatus: "confirmed",
        scheduledAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

      const { SendApi } = await import("hostinger-mail-api-sdk");
      const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockRejectedValueOnce(
        new Error("Hostinger API 503 Service Unavailable")
      );

      const previousEnv = { ...process.env };
      process.env.HOSTINGER_MAIL_API_TOKEN = "mock-token";
      process.env.HOSTINGER_MAILBOX_INTERVIEWS_ID = "box-interviews-id";

      const job: any = {
        id: createId("que_rem_fail_"),
        ownerId,
        jobType: "send_reminder",
        payload: { interviewId: intId },
      };

      await expect(
        handleAiTaskResult(
          job,
          { subject: "Reminder", body: "Please attend.", channel: "email" },
          "ai-model",
          ownerId,
          db
        )
      ).rejects.toThrow("Hostinger API 503 Service Unavailable");

      // Interview must NOT be marked reminder_sent
      const [intRow] = await db.select().from(interviews).where(eq(interviews.id, intId));
      expect(intRow.status).toBe("confirmed");

      // No sent message
      const msgs = await db.select().from(messages).where(and(eq(messages.ownerId, ownerId), eq(messages.status, "sent")));
      expect(msgs.find(m => m.body === "Please attend.")).toBeUndefined();

      sendSpy.mockRestore();
      process.env = previousEnv;
    });

    it("3. idempotent retry after successful send does NOT send duplicate email", async () => {
      const db = await requireDb();
      const candId = createId("cnd_rem_idem_");
      const intId = createId("int_rem_idem_");

      await db.insert(candidates).values({
        id: candId,
        ownerId,
        fullName: "Idempotent Candidate",
        email: "idem.cand@test.com",
        profileState: "available",
      });
      await db.insert(interviews).values({
        id: intId,
        ownerId,
        companyId: "cmp_idem",
        candidateId: candId,
        jobId: "job_idem",
        status: "confirmed",
        calendarStatus: "confirmed",
        scheduledAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

      const { SendApi } = await import("hostinger-mail-api-sdk");
      let callCount = 0;
      const sendSpy = vi.spyOn(SendApi.prototype, "sendEmail").mockImplementation(async () => {
        callCount++;
        return { data: { messageId: "hostinger_idem_1" } } as any;
      });

      const previousEnv = { ...process.env };
      process.env.HOSTINGER_MAIL_API_TOKEN = "mock-token";
      process.env.HOSTINGER_MAILBOX_INTERVIEWS_ID = "box-interviews-id";

      const job: any = {
        id: createId("que_rem_idem_"),
        ownerId,
        jobType: "send_reminder",
        payload: { interviewId: intId },
      };

      // First run succeeds
      await handleAiTaskResult(
        job,
        { subject: "Reminder", body: "First call body", channel: "email" },
        "ai-model",
        ownerId,
        db
      );
      expect(callCount).toBe(1);

      // Second run with same job / idempotency key returns idempotent no-op without sending again
      const res = await handleAiTaskResult(
        job,
        { subject: "Reminder", body: "First call body", channel: "email" },
        "ai-model",
        ownerId,
        db
      );

      expect((res as any).alreadySent).toBe(true);
      expect(callCount).toBe(1); // STILL 1, no duplicate email sent!

      sendSpy.mockRestore();
      process.env = previousEnv;
    });

    it("4. suppressed recipient is NOT contacted and does not mark interview reminder_sent", async () => {
      const db = await requireDb();
      const candId = createId("cnd_rem_supp_");
      const intId = createId("int_rem_supp_");
      const suppEmail = "suppressed.candidate@test.com";

      await db.insert(candidates).values({
        id: candId,
        ownerId,
        fullName: "Suppressed Candidate",
        email: suppEmail,
      });
      await db.insert(interviews).values({
        id: intId,
        ownerId,
        companyId: "cmp_supp",
        candidateId: candId,
        jobId: "job_supp",
        status: "confirmed",
        calendarStatus: "confirmed",
      });

      // Add to suppression list
      await db.insert(suppressionList).values({
        id: createId("sup_t_"),
        ownerId,
        channel: "email",
        valueHash: hashContactValue(suppEmail),
        reason: "Opt-out requested",
        source: "test",
        active: true,
      });

      const job: any = {
        id: createId("que_rem_supp_"),
        ownerId,
        jobType: "send_reminder",
        payload: { interviewId: intId },
      };

      await expect(
        handleAiTaskResult(
          job,
          { subject: "Reminder", body: "Do not send", channel: "email" },
          "ai-model",
          ownerId,
          db
        )
      ).rejects.toThrow("is on the suppression list. Reminder dispatch blocked.");

      const [intRow] = await db.select().from(interviews).where(eq(interviews.id, intId));
      expect(intRow.status).toBe("confirmed"); // Not reminder_sent
    });

    it("5. unsupported channel (sms/whatsapp) fails safely without faking dispatch", async () => {
      const db = await requireDb();
      const candId = createId("cnd_rem_chan_");
      const intId = createId("int_rem_chan_");

      await db.insert(candidates).values({
        id: candId,
        ownerId,
        fullName: "Channel Candidate",
        email: "chan.cand@test.com",
      });
      await db.insert(interviews).values({
        id: intId,
        ownerId,
        companyId: "cmp_chan",
        candidateId: candId,
        jobId: "job_chan",
        status: "confirmed",
        calendarStatus: "confirmed",
      });

      const job: any = {
        id: createId("que_rem_chan_"),
        ownerId,
        jobType: "send_reminder",
        payload: { interviewId: intId },
      };

      await expect(
        handleAiTaskResult(
          job,
          { subject: "Reminder", body: "WhatsApp text", channel: "whatsapp" as any },
          "ai-model",
          ownerId,
          db
        )
      ).rejects.toThrow('Channel "whatsapp" is unsupported.');

      const [intRow] = await db.select().from(interviews).where(eq(interviews.id, intId));
      expect(intRow.status).toBe("confirmed");
    });
  });
});
