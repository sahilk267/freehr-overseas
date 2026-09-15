import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { approvals, candidates, invoices, jobs, placements, screenings } from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";

const consequentialActions = new Set(["candidate_final_decision", "replacement_case", "invoice_payment_status", "invoice_dispute", "invoice_credit"]);

async function requestApproval(ownerId: number, actionType: string, resourceType: string, resourceId: string, reason: string, payload: Record<string, unknown>) {
  const db = await requireDb();
  const id = createId("apr_");
  await db.insert(approvals).values({ id, ownerId, requestedBy: "system", status: "pending", actionType, resourceType, resourceId, reason, payload });
  await recordAudit({ ownerId, actorType: "user", actorId: String(ownerId), action: "approval.requested", resourceType, resourceId, nextState: "pending", metadata: { actionType, reason } });
  return id;
}

export const consequentialRouter = router({
  requestCandidateDecision: protectedProcedure.input(z.object({ candidateId: z.string().min(4), jobId: z.string().min(4), disposition: z.enum(["advance", "not_proceeding"]), evidence: z.array(z.string().trim().min(2).max(500)).min(1).max(12), rationale: z.string().trim().min(8).max(2000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const candidate = (await db.select().from(candidates).where(and(eq(candidates.id, input.candidateId), eq(candidates.ownerId, ctx.user.id))).limit(1))[0];
    const job = (await db.select().from(jobs).where(and(eq(jobs.id, input.jobId), eq(jobs.ownerId, ctx.user.id))).limit(1))[0];
    if (!candidate || !job) throw new TRPCError({ code: "NOT_FOUND", message: "Candidate or job was not found." });
    const screeningId = createId("scr_");
    await db.insert(screenings).values({ id: screeningId, ownerId: ctx.user.id, candidateId: candidate.id, jobId: job.id, status: "decision_pending", evidence: input.evidence, confidence: 0, recommendation: input.disposition });
    const approvalId = await requestApproval(ctx.user.id, "candidate_final_decision", "screening", screeningId, "Final candidate progression or non-progression requires owner approval; AI never finalizes this action.", { ...input });
    return { screeningId, approvalId };
  }),
  requestReplacement: protectedProcedure.input(z.object({ placementId: z.string().min(4), reason: z.string().trim().min(8).max(2000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const placement = (await db.select().from(placements).where(and(eq(placements.id, input.placementId), eq(placements.ownerId, ctx.user.id))).limit(1))[0];
    if (!placement) throw new TRPCError({ code: "NOT_FOUND", message: "Placement was not found." });
    return { approvalId: await requestApproval(ctx.user.id, "replacement_case", "placement", placement.id, "Replacement cases change commercial obligations and require owner approval.", { reason: input.reason }) };
  }),
  requestInvoiceAction: protectedProcedure.input(z.object({ invoiceId: z.string().min(4), action: z.enum(["payment_status", "dispute", "credit"]), status: z.enum(["payment_pending", "partially_paid", "paid", "overdue"]).optional(), evidence: z.string().trim().min(8).max(3000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const invoice = (await db.select().from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.ownerId, ctx.user.id))).limit(1))[0];
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice was not found." });
    if (input.action === "payment_status" && !input.status) throw new TRPCError({ code: "BAD_REQUEST", message: "A payment state is required." });
    const actionType = input.action === "payment_status" ? "invoice_payment_status" : input.action === "dispute" ? "invoice_dispute" : "invoice_credit";
    return { approvalId: await requestApproval(ctx.user.id, actionType, "invoice", invoice.id, "This revenue action requires owner approval and supporting evidence.", { status: input.status, evidence: input.evidence }) };
  }),
  decide: protectedProcedure.input(z.object({ approvalId: z.string().min(4), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const approval = (await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.ownerId, ctx.user.id))).limit(1))[0];
    if (!approval || !consequentialActions.has(approval.actionType)) throw new TRPCError({ code: "NOT_FOUND", message: "Consequential approval was not found." });
    if (approval.status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: "This approval has already been decided." });
    await db.update(approvals).set({ status: input.decision, decidedById: ctx.user.id, decidedAt: new Date(), reason: input.note ?? approval.reason }).where(eq(approvals.id, approval.id));
    if (input.decision === "approved" && approval.actionType === "candidate_final_decision") await db.update(screenings).set({ status: "owner_decided" }).where(eq(screenings.id, approval.resourceId));
    if (input.decision === "approved" && approval.actionType === "replacement_case") await db.update(placements).set({ status: "replacement_requested", replacementRequestedAt: new Date() }).where(eq(placements.id, approval.resourceId));
    if (input.decision === "approved" && approval.actionType === "invoice_payment_status") { const payload = approval.payload as { status?: string } | null; await db.update(invoices).set({ status: payload?.status ?? "payment_pending", paidAt: payload?.status === "paid" ? new Date() : null }).where(eq(invoices.id, approval.resourceId)); }
    if (input.decision === "approved" && approval.actionType === "invoice_dispute") { const payload = approval.payload as { evidence?: string } | null; await db.update(invoices).set({ status: "disputed", disputeReason: payload?.evidence ?? null }).where(eq(invoices.id, approval.resourceId)); }
    if (input.decision === "approved" && approval.actionType === "invoice_credit") await db.update(invoices).set({ status: "credited" }).where(eq(invoices.id, approval.resourceId));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: `consequential.${input.decision}`, resourceType: approval.resourceType, resourceId: approval.resourceId, metadata: { approvalId: approval.id, actionType: approval.actionType } });
    return { success: true };
  }),
});
