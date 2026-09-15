import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { requireDb } from "../db";
import { invoices, placements } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { recruitmentRouter } from "./recruitment";
import { assertTransition } from "../workflow";

describe("invoice state machine and re-invoicing workflow", () => {
  const ownerCtx = {
    user: { id: 1, role: "admin", name: "Owner", email: "owner@freelancehr.local" },
    req: {},
    res: {},
  } as never;

  const caller = recruitmentRouter.createCaller(ownerCtx);

  it("progresses an invoice from draft to issued, disputes it, credits it via consequential.decide, and confirms valid terminal transitions", async () => {
    const db = await requireDb();

    // Create an invoice-eligible placement
    const placementId = `plc_test_${Date.now()}`;
    await db.insert(placements).values({
      id: placementId,
      ownerId: 1,
      companyId: "cmp_acme",
      jobId: "job_backend",
      candidateId: "cand_priya",
      status: "invoice_eligible",
      annualCompensation: 2400000,
    });

    // 1. Draft invoice
    const inv1Number = `INV-${Date.now()}-1`;
    const { id: invoiceId } = await caller.invoices.draft({
      placementId,
      companyId: "cmp_acme",
      invoiceNumber: inv1Number,
      amount: 200000,
      taxAmount: 36000,
    });
    expect(invoiceId).toBeTruthy();

    // Verify draft status
    let [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("draft");

    // Attempting to draft a second invoice for the same placement while first is non-terminal should fail
    await expect(
      caller.invoices.draft({
        placementId,
        companyId: "cmp_acme",
        invoiceNumber: `INV-${Date.now()}-2`,
        amount: 200000,
        taxAmount: 36000,
      })
    ).rejects.toThrow(/Only one non-terminal invoice is allowed per placement at a time/);

    // 2. Request issue approval
    const { approvalId: issueApprovalId } = await caller.invoices.requestIssueApproval({ id: invoiceId });
    [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("approval_pending");

    // Owner approves issuance
    await caller.approvals.decide({ id: issueApprovalId, decision: "approved" });
    [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("issued");

    // 3. Dispute the invoice
    const { approvalId: disputeApprovalId } = await caller.consequential.requestInvoiceAction({
      invoiceId,
      action: "dispute",
      evidence: "Client disputed placement fee due to early candidate withdrawal.",
    });

    // Owner approves dispute
    await caller.consequential.decide({ approvalId: disputeApprovalId, decision: "approved" });
    [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("disputed");
    expect(inv.disputeReason).toBe("Client disputed placement fee due to early candidate withdrawal.");

    // 4. Request credit on disputed invoice
    const { approvalId: creditApprovalId } = await caller.consequential.requestInvoiceAction({
      invoiceId,
      action: "credit",
      evidence: "Approving full credit note following confirmed candidate departure.",
    });

    // Owner approves credit
    await caller.consequential.decide({ approvalId: creditApprovalId, decision: "approved" });
    [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));

    // Must be "credited", NOT "credit_pending"
    expect(inv.status).toBe("credited");

    // Confirm that the resulting state is a valid, further-transitionable state per transitions.invoice
    // (i.e. assertTransition never throws for the terminal state going forward)
    expect(() => assertTransition("invoice", inv.status, "closed")).not.toThrow();

    // Terminal closed state self-transition succeeds
    expect(() => assertTransition("invoice", "closed", "closed")).not.toThrow();

    // Attempting an illegal transition from terminal state throws
    expect(() => assertTransition("invoice", "closed", "draft")).toThrow(TRPCError);

    // 5. Re-invoicing the placement should now SUCCEED because the previous invoice is credited (terminal)
    const reInvoiceNumber = `INV-${Date.now()}-REISSUED`;
    const { id: reInvoiceId } = await caller.invoices.draft({
      placementId,
      companyId: "cmp_acme",
      invoiceNumber: reInvoiceNumber,
      amount: 150000,
      taxAmount: 27000,
    });
    expect(reInvoiceId).toBeTruthy();

    const [reInv] = await db.select().from(invoices).where(eq(invoices.id, reInvoiceId));
    expect(reInv.status).toBe("draft");
    expect(reInv.placementId).toBe(placementId);

    // Attempting another invoice now fails because reInv is currently non-terminal ("draft")
    await expect(
      caller.invoices.draft({
        placementId,
        companyId: "cmp_acme",
        invoiceNumber: `INV-${Date.now()}-3`,
        amount: 150000,
      })
    ).rejects.toThrow(/Only one non-terminal invoice is allowed per placement at a time/);
  });
});
