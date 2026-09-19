import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { approvals, candidates, invoices, jobs, placements, screenings } from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { applyApprovalDecision, requestOrAutoDecide } from "../services/approvalEngine";

const consequentialActions = new Set(["candidate_final_decision", "replacement_case", "invoice_payment_status", "invoice_dispute", "invoice_credit"]);

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
  requestCandidateDecision: protectedProcedure.input(z.object({ candidateId: z.string().min(4), jobId: z.string().min(4), disposition: z.enum(["advance", "not_proceeding"]), evidence: z.array(z.string().trim().min(2).max(500)).min(1).max(12), rationale: z.string().trim().min(8).max(2000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const candidate = (await db.select().from(candidates).where(and(eq(candidates.id, input.candidateId), eq(candidates.ownerId, ctx.user.id))).limit(1))[0];
    const job = (await db.select().from(jobs).where(and(eq(jobs.id, input.jobId), eq(jobs.ownerId, ctx.user.id))).limit(1))[0];
    if (!candidate || !job) throw new TRPCError({ code: "NOT_FOUND", message: "Candidate or job was not found." });
    const screeningId = createId("scr_");
    await db.insert(screenings).values({ id: screeningId, ownerId: ctx.user.id, candidateId: candidate.id, jobId: job.id, status: "decision_pending", evidence: input.evidence, confidence: 0, recommendation: input.disposition });
    const approvalId = await requestApproval(ctx, "candidate_final_decision", "screening", screeningId, "Final candidate progression or non-progression requires owner approval; AI never finalizes this action.", { ...input });
    return { screeningId, approvalId };
  }),
  requestReplacement: protectedProcedure.input(z.object({ placementId: z.string().min(4), reason: z.string().trim().min(8).max(2000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const placement = (await db.select().from(placements).where(and(eq(placements.id, input.placementId), eq(placements.ownerId, ctx.user.id))).limit(1))[0];
    if (!placement) throw new TRPCError({ code: "NOT_FOUND", message: "Placement was not found." });
    return { approvalId: await requestApproval(ctx, "replacement_case", "placement", placement.id, "Replacement cases change commercial obligations and require owner approval.", { reason: input.reason }) };
  }),
  requestInvoiceAction: protectedProcedure.input(z.object({ invoiceId: z.string().min(4), action: z.enum(["payment_status", "dispute", "credit"]), status: z.enum(["payment_pending", "partially_paid", "paid", "overdue"]).optional(), evidence: z.string().trim().min(8).max(3000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const invoice = (await db.select().from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.ownerId, ctx.user.id))).limit(1))[0];
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice was not found." });
    if (input.action === "payment_status" && !input.status) throw new TRPCError({ code: "BAD_REQUEST", message: "A payment state is required." });
    const actionType = input.action === "payment_status" ? "invoice_payment_status" : input.action === "dispute" ? "invoice_dispute" : "invoice_credit";
    return { approvalId: await requestApproval(ctx, actionType, "invoice", invoice.id, "This revenue action requires owner approval and supporting evidence.", { status: input.status, evidence: input.evidence }) };
  }),
  decide: protectedProcedure.input(z.object({ approvalId: z.string().min(4), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const approval = (await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.ownerId, ctx.user.id))).limit(1))[0];
    if (!approval || !consequentialActions.has(approval.actionType)) throw new TRPCError({ code: "NOT_FOUND", message: "Consequential approval was not found." });
    if (approval.status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: "This approval has already been decided." });
    return applyApprovalDecision(db, approval, input.decision, ctx.user.id, input.note, "manual");
  }),
});
