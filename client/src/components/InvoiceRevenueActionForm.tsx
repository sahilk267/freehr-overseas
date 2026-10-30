import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function InvoiceRevenueActionForm({ invoiceId, action, onSaved, onCancel }: { invoiceId: string; action: "dispute" | "credit"; onSaved: () => void; onCancel: () => void }) {
  const [evidence, setEvidence] = useState(""); const utils = trpc.useUtils();
  const save = trpc.recruitment.consequential.requestInvoiceAction.useMutation({ onSuccess: async () => { await Promise.all([utils.collections.invalidate(), utils.followups.invalidate()]); toast.success("Revenue action is awaiting owner approval; collections are frozen for review"); onSaved(); }, onError: e => toast.error(e.message) });
  return <form className="space-y-3 rounded-xl border bg-white p-5" onSubmit={e => { e.preventDefault(); save.mutate({ invoiceId, action, evidence }); }}><h3 className="font-semibold">Request invoice {action}</h3><label className="block text-sm">Dispute or adjustment evidence<textarea aria-label="Dispute or adjustment evidence" required minLength={8} maxLength={3000} className="mt-2 w-full rounded-lg border p-2" rows={4} value={evidence} onChange={e => setEvidence(e.target.value)} /></label><div className="flex gap-2"><Button type="submit" disabled={save.isPending}>Request owner review</Button><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button></div></form>;
}
