import { and, eq } from "drizzle-orm";
import { companies, invoices, payments, placements } from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
import { assertTransition } from "../workflow";
import { TRPCError } from "@trpc/server";

export interface InvoiceDocumentData {
  invoiceNumber: string;
  currency: string;
  amount: number;
  taxAmount: number;
  totalAmount: number;
  status: string;
  dueAt: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  companyName: string;
  placementId: string;
  html: string;
}

export async function generateInvoiceDocument(
  invoiceId: string,
  ownerId: number
): Promise<InvoiceDocumentData> {
  const db = await requireDb();
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.ownerId, ownerId)))
    .limit(1);

  if (!invoice) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
  }

  const [company] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.id, invoice.companyId), eq(companies.ownerId, ownerId)))
    .limit(1);

  const [placement] = await db
    .select()
    .from(placements)
    .where(and(eq(placements.id, invoice.placementId), eq(placements.ownerId, ownerId)))
    .limit(1);

  const total = invoice.amount + (invoice.taxAmount || 0);
  const companyName = company?.name || "Client Enterprise";
  const dueFormatted = invoice.dueAt ? new Date(invoice.dueAt).toLocaleDateString("en-IN", { dateStyle: "long" }) : "Due on receipt";
  const issuedFormatted = invoice.issuedAt ? new Date(invoice.issuedAt).toLocaleDateString("en-IN", { dateStyle: "long" }) : new Date(invoice.createdAt).toLocaleDateString("en-IN", { dateStyle: "long" });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Invoice ${invoice.invoiceNumber}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 40px; color: #10213d; background: #fff; }
    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #10213d; padding-bottom: 20px; }
    .brand { font-size: 24px; font-weight: 800; letter-spacing: 0.1em; color: #10213d; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; background: #f0f4f8; }
    .meta { margin-top: 30px; display: flex; justify-content: space-between; }
    .details h3 { font-size: 14px; text-transform: uppercase; color: #718096; margin: 0 0 8px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 30px; }
    th { text-align: left; padding: 12px; background: #f7f9fa; border-bottom: 1px solid #e2e8f0; font-size: 12px; text-transform: uppercase; }
    td { padding: 14px 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
    .totals { margin-top: 20px; margin-left: auto; width: 300px; }
    .totals div { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
    .totals .grand-total { font-weight: bold; font-size: 18px; border-top: 2px solid #10213d; margin-top: 6px; padding-top: 8px; }
    .footer { margin-top: 60px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #718096; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">FREELANCEHR</div>
      <p style="margin: 4px 0 0; color: #718096; font-size: 13px;">Executive & Specialized Talent Operations</p>
    </div>
    <div style="text-align: right;">
      <h1 style="margin: 0; font-size: 20px;">INVOICE</h1>
      <p style="margin: 4px 0; font-weight: 600;">#${invoice.invoiceNumber}</p>
      <span class="badge">${invoice.status}</span>
    </div>
  </div>

  <div class="meta">
    <div class="details">
      <h3>Billed To:</h3>
      <strong>${companyName}</strong><br>
      Placement ID: ${invoice.placementId}
    </div>
    <div class="details" style="text-align: right;">
      <h3>Payment Details:</h3>
      <strong>Issued Date:</strong> ${issuedFormatted}<br>
      <strong>Payment Due:</strong> ${dueFormatted}<br>
      <strong>Currency:</strong> ${invoice.currency}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th style="text-align: right;">Amount</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>
          <strong>Executive Placement Fee</strong><br>
          <span style="font-size: 12px; color: #718096;">Placement reference: ${placement?.id || invoice.placementId}</span>
        </td>
        <td style="text-align: right;">${invoice.currency} ${(invoice.amount / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
      </tr>
      ${invoice.taxAmount ? `<tr>
        <td>GST / Applicable Taxes</td>
        <td style="text-align: right;">${invoice.currency} ${(invoice.taxAmount / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
      </tr>` : ""}
    </tbody>
  </table>

  <div class="totals">
    <div>
      <span>Subtotal:</span>
      <span>${invoice.currency} ${(invoice.amount / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
    </div>
    ${invoice.taxAmount ? `<div>
      <span>Taxes:</span>
      <span>${invoice.currency} ${(invoice.taxAmount / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
    </div>` : ""}
    <div class="grand-total">
      <span>Total Due:</span>
      <span>${invoice.currency} ${(total / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
    </div>
  </div>

  <div class="footer">
    <p>Thank you for partnering with FreelanceHR. For remittance confirmation, reference invoice number #${invoice.invoiceNumber}.</p>
  </div>
</body>
</html>`;

  return {
    invoiceNumber: invoice.invoiceNumber,
    currency: invoice.currency,
    amount: invoice.amount,
    taxAmount: invoice.taxAmount,
    totalAmount: total,
    status: invoice.status,
    dueAt: invoice.dueAt ? invoice.dueAt.toISOString() : null,
    issuedAt: invoice.issuedAt ? invoice.issuedAt.toISOString() : null,
    paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
    companyName,
    placementId: invoice.placementId,
    html,
  };
}

export async function createInvoicePaymentLink(
  invoiceId: string,
  ownerId: number,
  provider = "stripe"
) {
  const db = await requireDb();
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.ownerId, ownerId)))
    .limit(1);

  if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
  if (invoice.status === "paid") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This invoice has already been marked as paid." });
  }

  const paymentId = createId("pay_");
  const totalAmount = invoice.amount + (invoice.taxAmount || 0);

  // Transition invoice to payment_pending if currently issued or delivered
  if (["issued", "delivered"].includes(invoice.status)) {
    assertTransition("invoice", invoice.status, "payment_pending");
    await db.update(invoices).set({ status: "payment_pending" }).where(eq(invoices.id, invoice.id));
    await recordAudit({
      ownerId,
      actorType: "system",
      actorId: "billing_service",
      action: "invoice.state_changed",
      resourceType: "invoice",
      resourceId: invoice.id,
      previousState: invoice.status,
      nextState: "payment_pending",
      metadata: { paymentId, provider },
    });
  }

  const providerEventId = `link_${Date.now()}_${paymentId}`;
  await db.insert(payments).values({
    id: paymentId,
    ownerId,
    invoiceId: invoice.id,
    provider,
    providerEventId,
    amount: totalAmount,
    currency: invoice.currency,
    status: "pending",
  });

  const appBaseUrl = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
  const checkoutUrl = `${appBaseUrl}/finance?invoice=${invoice.id}&pay=${paymentId}`;

  return {
    paymentId,
    checkoutUrl,
    amount: totalAmount,
    currency: invoice.currency,
    provider,
  };
}

export async function recordInvoicePayment(
  invoiceId: string,
  ownerId: number,
  details: {
    amount?: number;
    provider: string;
    providerEventId: string;
    note?: string;
  }
) {
  const db = await requireDb();
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.ownerId, ownerId)))
    .limit(1);

  if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
  if (invoice.status === "paid") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Invoice is already paid." });

  // Valid previous states for paid: delivered, payment_pending, partially_paid, overdue
  // If invoice is in 'issued', transition through payment_pending first
  if (invoice.status === "issued") {
    assertTransition("invoice", "issued", "payment_pending");
    await db.update(invoices).set({ status: "payment_pending" }).where(eq(invoices.id, invoice.id));
    invoice.status = "payment_pending";
  }

  assertTransition("invoice", invoice.status, "paid");

  const now = new Date();
  const paidAmount = details.amount ?? (invoice.amount + (invoice.taxAmount || 0));

  await db.update(invoices).set({ status: "paid", paidAt: now }).where(eq(invoices.id, invoice.id));

  const paymentId = createId("pay_");
  await db.insert(payments).values({
    id: paymentId,
    ownerId,
    invoiceId: invoice.id,
    provider: details.provider,
    providerEventId: details.providerEventId,
    amount: paidAmount,
    currency: invoice.currency,
    status: "succeeded",
    paidAt: now,
  });

  await recordAudit({
    ownerId,
    actorType: "user",
    actorId: String(ownerId),
    action: "invoice.paid",
    resourceType: "invoice",
    resourceId: invoice.id,
    previousState: invoice.status,
    nextState: "paid",
    metadata: {
      paymentId,
      provider: details.provider,
      providerEventId: details.providerEventId,
      amount: paidAmount,
      note: details.note,
    },
  });

  return { success: true, paymentId, status: "paid" as const };
}
