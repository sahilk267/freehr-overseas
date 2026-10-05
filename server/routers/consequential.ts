import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  approvals,
  candidates,
  companies,
  consents,
  invoices,
  jobs,
  placements,
  screenings,
  shortlists,
} from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { applyApprovalDecision, requestOrAutoDecide } from "../services/approvalEngine";
import { assertTransition, isConsequentialAction } from "../workflow";

async function requestApproval(
  ctx: {
    user: { id: number };
    workspace?: { ownerId?: number } | null;
    [key: string]: unknown;
  },
  actionType: string,
  resourceType: string,
  resourceId: string,
  reason: string,
  payload: Record<string, unknown>,
) {
  const result = await requestOrAutoDecide(
    ctx,
    actionType,
    resourceType,
    resourceId,
    reason,
    payload,
  );
  return result.approvalId;
}

export const consequentialRouter = router({
  requestCandidateDecision: protectedProcedure
    .input(
      z.object({
        candidateId: z.string().min(4),
        jobId: z.string().min(4),
        disposition: z.enum(["advance", "not_proceeding"]),
        evidence: z.array(z.string().trim().min(2).max(500)).min(1).max(12),
        rationale: z.string().trim().min(8).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const ownerId = ctx.workspace?.ownerId ?? ctx.user.id;
      const candidate = (
        await db
          .select()
          .from(candidates)
          .where(and(eq(candidates.id, input.candidateId), eq(candidates.ownerId, ownerId)))
          .limit(1)
      )[0];
      const job = (
        await db
          .select()
          .from(jobs)
          .where(and(eq(jobs.id, input.jobId), eq(jobs.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!candidate || !job) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Candidate or job was not found." });
      }
      const screeningId = createId("scr_");
      await db.insert(screenings).values({
        id: screeningId,
        ownerId,
        candidateId: candidate.id,
        jobId: job.id,
        status: "decision_pending",
        evidence: input.evidence,
        confidence: 0,
        recommendation: input.disposition,
      });
      const approvalId = await requestApproval(
        ctx,
        "candidate_final_decision",
        "screening",
        screeningId,
        "Final candidate progression or non-progression requires owner approval; AI never finalizes this action.",
        { ...input },
      );
      return { screeningId, approvalId };
    }),

  requestReplacement: protectedProcedure
    .input(
      z.object({
        placementId: z.string().min(4),
        reason: z.string().trim().min(8).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const ownerId = ctx.workspace?.ownerId ?? ctx.user.id;
      const placement = (
        await db
          .select()
          .from(placements)
          .where(and(eq(placements.id, input.placementId), eq(placements.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!placement) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Placement was not found." });
      }
      return {
        approvalId: await requestApproval(
          ctx,
          "replacement_case",
          "placement",
          placement.id,
          "Replacement cases change commercial obligations and require owner approval.",
          { reason: input.reason },
        ),
      };
    }),

  requestInvoiceAction: protectedProcedure
    .input(
      z.object({
        invoiceId: z.string().min(4),
        action: z.enum(["payment_status", "dispute", "credit", "write_off"]),
        status: z.enum(["payment_pending", "partially_paid", "paid", "overdue"]).optional(),
        evidence: z.string().trim().min(8).max(3000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const ownerId = ctx.workspace?.ownerId ?? ctx.user.id;
      const invoice = (
        await db
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, input.invoiceId), eq(invoices.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invoice was not found." });
      }
      if (input.action === "payment_status" && !input.status) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A payment state is required." });
      }
      const actionType =
        input.action === "payment_status"
          ? "invoice_payment_status"
          : input.action === "dispute"
            ? "invoice_dispute"
            : input.action === "credit"
              ? "invoice_credit"
              : "invoice_write_off";
      return {
        approvalId: await requestApproval(
          ctx,
          actionType,
          "invoice",
          invoice.id,
          "This revenue action requires owner approval and supporting evidence.",
          { status: input.status, evidence: input.evidence },
        ),
      };
    }),

  requestAutomationStop: protectedProcedure
    .input(z.object({ reason: z.string().trim().min(4).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const ownerId = ctx.workspace?.ownerId ?? ctx.user.id;
      return {
        approvalId: await requestApproval(
          ctx,
          "automation_stop",
          "workspace",
          String(ownerId),
          "Emergency halt of background automation requires owner approval.",
          { reason: input.reason },
        ),
      };
    }),

  requestClientOnboarding: protectedProcedure
    .input(
      z.object({
        companyId: z.string().min(4),
        reason: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const ownerId = ctx.workspace?.ownerId ?? ctx.user.id;
      const company = (
        await db
          .select()
          .from(companies)
          .where(and(eq(companies.id, input.companyId), eq(companies.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!company) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Company was not found." });
      }
      if (company.pipelineState !== "converted") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Company must be in converted state for client onboarding (current: ${company.pipelineState}).`,
        });
      }
      if (["suppressed", "closed", "not_fit"].includes(company.pipelineState)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Suppressed, closed, or not fit companies cannot enter client onboarding.",
        });
      }
      const existingApproval = (
        await db
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.ownerId, ownerId),
              eq(approvals.actionType, "client_onboarding"),
              eq(approvals.resourceType, "company"),
              eq(approvals.resourceId, company.id),
              eq(approvals.status, "pending"),
            ),
          )
          .limit(1)
      )[0];
      if (existingApproval) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A client onboarding approval is already pending for this company.",
        });
      }

      const approvalId = await requestApproval(
        ctx,
        "client_onboarding",
        "company",
        company.id,
        input.reason ?? "Activate converted company into verified client status.",
        { companyId: company.id, name: company.name, companyType: company.companyType },
      );

      await recordAudit({
        ownerId,
        actorType: "user",
        actorId: String(ctx.user.id),
        action: "company.onboarding_approval_requested",
        resourceType: "company",
        resourceId: company.id,
        previousState: company.pipelineState,
        nextState: "converted",
        metadata: { approvalId },
      });

      return { companyId: company.id, approvalId };
    }),

  requestCandidateShare: protectedProcedure
    .input(
      z.object({
        shortlistId: z.string().min(4),
        reason: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const ownerId = ctx.workspace?.ownerId ?? ctx.user.id;
      const shortlist = (
        await db
          .select()
          .from(shortlists)
          .where(and(eq(shortlists.id, input.shortlistId), eq(shortlists.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!shortlist) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Shortlist was not found." });
      }
      if (shortlist.status !== "prepared") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Shortlist is not in a valid pre-share state (current: ${shortlist.status}).`,
        });
      }

      const candidate = (
        await db
          .select()
          .from(candidates)
          .where(and(eq(candidates.id, shortlist.candidateId), eq(candidates.ownerId, ownerId)))
          .limit(1)
      )[0];
      const company = (
        await db
          .select()
          .from(companies)
          .where(and(eq(companies.id, shortlist.companyId), eq(companies.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!candidate || !company) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Candidate or company relationship is invalid.",
        });
      }

      const consent = (
        await db
          .select()
          .from(consents)
          .where(
            and(
              eq(consents.ownerId, ownerId),
              eq(consents.candidateId, shortlist.candidateId),
              eq(consents.companyId, shortlist.companyId),
              eq(consents.consentType, "client_sharing"),
              eq(consents.status, "granted"),
            ),
          )
          .limit(1)
      )[0];
      if (!consent) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Explicit candidate client-sharing consent is required before shortlist can be shared.",
        });
      }

      const existingApproval = (
        await db
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.ownerId, ownerId),
              eq(approvals.actionType, "candidate_share"),
              eq(approvals.resourceType, "shortlist"),
              eq(approvals.resourceId, shortlist.id),
              eq(approvals.status, "pending"),
            ),
          )
          .limit(1)
      )[0];
      if (existingApproval) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A candidate share approval is already pending for this shortlist.",
        });
      }

      assertTransition("shortlist", shortlist.status, "approval_pending");
      await db.update(shortlists).set({ status: "approval_pending" }).where(eq(shortlists.id, shortlist.id));

      const approvalId = await requestApproval(
        ctx,
        "candidate_share",
        "shortlist",
        shortlist.id,
        input.reason ?? "Candidate profile sharing requires owner approval and verified consent.",
        {
          shortlistId: shortlist.id,
          candidateId: shortlist.candidateId,
          companyId: shortlist.companyId,
          jobId: shortlist.jobId,
        },
      );

      await recordAudit({
        ownerId,
        actorType: "user",
        actorId: String(ctx.user.id),
        action: "shortlist.share_approval_requested",
        resourceType: "shortlist",
        resourceId: shortlist.id,
        previousState: "prepared",
        nextState: "approval_pending",
        metadata: { approvalId },
      });

      return { shortlistId: shortlist.id, approvalId };
    }),

  requestPlacementConfirmation: protectedProcedure
    .input(
      z.object({
        placementId: z.string().min(4),
        joiningEvidence: z.array(z.string().trim().min(2).max(500)).min(1).max(10),
        reason: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const ownerId = ctx.workspace?.ownerId ?? ctx.user.id;
      const placement = (
        await db
          .select()
          .from(placements)
          .where(and(eq(placements.id, input.placementId), eq(placements.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!placement) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Placement was not found." });
      }
      if (placement.status !== "joining_pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Placement must be in joining_pending state for joining confirmation (current: ${placement.status}).`,
        });
      }

      const existingApproval = (
        await db
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.ownerId, ownerId),
              eq(approvals.actionType, "placement_confirmation"),
              eq(approvals.resourceType, "placement"),
              eq(approvals.resourceId, placement.id),
              eq(approvals.status, "pending"),
            ),
          )
          .limit(1)
      )[0];
      if (existingApproval) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A placement confirmation approval is already pending for this placement.",
        });
      }

      const approvalId = await requestApproval(
        ctx,
        "placement_confirmation",
        "placement",
        placement.id,
        input.reason ?? "Confirm candidate joining and activate placement guarantee.",
        {
          placementId: placement.id,
          joiningEvidence: input.joiningEvidence,
        },
      );

      await recordAudit({
        ownerId,
        actorType: "user",
        actorId: String(ctx.user.id),
        action: "placement.confirmation_approval_requested",
        resourceType: "placement",
        resourceId: placement.id,
        previousState: placement.status,
        nextState: "joining_pending",
        metadata: { approvalId, joiningEvidence: input.joiningEvidence },
      });

      return { placementId: placement.id, approvalId };
    }),

  requestInvoiceIssue: protectedProcedure
    .input(
      z.object({
        invoiceId: z.string().min(4),
        reason: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const ownerId = ctx.workspace?.ownerId ?? ctx.user.id;
      const invoice = (
        await db
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, input.invoiceId), eq(invoices.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invoice was not found." });
      }
      if (!["draft", "validation", "approval_pending"].includes(invoice.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invoice is not in a valid pre-issue state (current: ${invoice.status}).`,
        });
      }

      const existingApproval = (
        await db
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.ownerId, ownerId),
              eq(approvals.actionType, "invoice_issue"),
              eq(approvals.resourceType, "invoice"),
              eq(approvals.resourceId, invoice.id),
              eq(approvals.status, "pending"),
            ),
          )
          .limit(1)
      )[0];
      if (existingApproval) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "An invoice issue approval is already pending for this invoice.",
        });
      }

      if (invoice.status !== "approval_pending") {
        assertTransition("invoice", invoice.status, "approval_pending");
        await db.update(invoices).set({ status: "approval_pending" }).where(eq(invoices.id, invoice.id));
      }

      const approvalId = await requestApproval(
        ctx,
        "invoice_issue",
        "invoice",
        invoice.id,
        input.reason ?? "Issue commercial invoice to client for placement fees.",
        {
          invoiceId: invoice.id,
          amount: invoice.amount,
          taxAmount: invoice.taxAmount,
        },
      );

      await recordAudit({
        ownerId,
        actorType: "user",
        actorId: String(ctx.user.id),
        action: "invoice.issue_approval_requested",
        resourceType: "invoice",
        resourceId: invoice.id,
        previousState: invoice.status,
        nextState: "approval_pending",
        metadata: { approvalId },
      });

      return { invoiceId: invoice.id, approvalId };
    }),

  decide: protectedProcedure
    .input(
      z.object({
        approvalId: z.string().min(4),
        decision: z.enum(["approved", "rejected"]),
        note: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const ownerId = ctx.workspace?.ownerId ?? ctx.user.id;
      const approval = (
        await db
          .select()
          .from(approvals)
          .where(and(eq(approvals.id, input.approvalId), eq(approvals.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!approval || !isConsequentialAction(approval.actionType)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Consequential approval was not found." });
      }
      if (approval.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This approval has already been decided." });
      }
      return applyApprovalDecision(db, approval, input.decision, ctx.user.id, input.note, "manual", "consequential");
    }),
});
