import { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { parseMoney } from "@shared/money";
import { toast } from "sonner";

export function PaymentReceiptForm({ invoice, onClose }: { invoice: { id: string; invoiceNumber: string; currency: string }; onClose: () => void }) {
  const utils = trpc.useUtils();
  const record = trpc.recruitment.invoices.recordPayment.useMutation();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await record.mutateAsync({ id: invoice.id, provider: "bank_transfer", providerEventId: String(data.get("reference")).trim(), amount: parseMoney(String(data.get("amount")), invoice.currency), note: String(data.get("note")) });
      await utils.recruitment.invoices.list.invalidate();
      await utils.collections.invalidate();
      toast.success(result.status === "paid" ? "Receipt recorded; invoice balance is settled." : "Partial receipt recorded; the remaining balance stays open.");
      onClose();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Receipt could not be recorded."); }
  };
  return <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
    <div><Label htmlFor="receipt-amount">Received amount ({invoice.currency})</Label><Input id="receipt-amount" name="amount" inputMode="decimal" required placeholder="1000.00" /></div>
    <div><Label htmlFor="receipt-reference">Bank transaction reference</Label><Input id="receipt-reference" name="reference" required minLength={3} maxLength={255} /></div>
    <div className="md:col-span-2"><Label htmlFor="receipt-note">Evidence and reconciliation note</Label><Textarea id="receipt-note" name="note" required minLength={8} maxLength={500} placeholder="Describe the bank statement or receipt you checked." /></div>
    <div className="md:col-span-2 flex justify-end gap-2"><Button variant="outline" type="button" onClick={onClose}>Cancel</Button><Button type="submit" disabled={record.isPending}>Record checked bank receipt</Button></div>
  </form>;
}
