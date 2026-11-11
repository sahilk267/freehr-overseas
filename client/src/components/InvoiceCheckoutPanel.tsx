import {trpc} from '@/lib/trpc';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {formatMoney} from '@shared/money';
import {toast} from 'sonner';
export function InvoiceCheckoutPanel({id,status}:{id:string;status:string}) {
  const q=trpc.recruitment.invoices.checkoutStatus.useQuery({id}),utils=trpc.useUtils();
  const refresh=async()=>{await q.refetch();await utils.recruitment.invoices.invalidate();};
  const create=trpc.recruitment.invoices.createPaymentLink.useMutation({onSuccess:refresh});
  const reconcile=trpc.recruitment.invoices.reconcileCheckout.useMutation({onSuccess:async result=>{await refresh();toast.success(`Provider check: ${result.status}`);}});
  if(!q.data)return null;
  const eligible=['issued','delivered','payment_pending','partially_paid','overdue'].includes(status);
  if(!eligible&&!q.data.checkouts.length)return null;
  return <div className="mt-3 max-w-lg space-y-2 rounded border p-3 text-sm" aria-label="Invoice provider checkout">
    <p>{q.data.configured?`Stripe ${q.data.mode} checkout`:'Stripe checkout is not configured.'}</p>
    {q.data.mode==='test'&&<p>Sandbox payments do not settle this invoice.</p>}
    {q.data.reviews.map(r=><p key={r.reviewId} role="status" className="text-amber-800">{r.reason} {formatMoney(r.amount,r.currency)}</p>)}
    {q.data.configured&&eligible&&<Button size="sm" variant="outline" disabled={create.isPending} onClick={()=>create.mutate({id,provider:'stripe'})}>Create or reuse checkout</Button>}
    <p>Returning from checkout does not mark an invoice paid. Provider payment confirmation and bank settlement are separate.</p>
    {(q.data.recoveryTasks??[]).map(t=><p key={t.intentId}>Automatic provider check: {t.status}{t.lastError?` · ${t.lastError}`:''}</p>)}
    {q.data.checkouts.map(c=><div key={c.intentId} className="space-y-2 border-t pt-2">
      <p>{formatMoney(c.amount,c.currency)} · {c.mode} · {c.status}</p>
      {c.url&&c.status==='pending'&&<a className="underline" href={c.url} target="_blank" rel="noopener noreferrer">Open Stripe checkout</a>}
      {c.status!=='provider_paid'&&c.status!=='sandbox_paid'&&<form onSubmit={e=>{e.preventDefault();const s=String(new FormData(e.currentTarget).get('sessionId')||'');reconcile.mutate({id,intentId:c.intentId,...(s?{sessionId:s}:{})});}}>
        {!c.sessionId&&<label>Original Stripe session ID (for an unconfirmed request)<Input name="sessionId" required pattern="cs_[A-Za-z0-9_]+" maxLength={255}/></label>}
        <Button size="sm" variant="outline" disabled={reconcile.isPending}>Reconcile provider status</Button>
      </form>}
    </div>)}
    {(create.error||reconcile.error)&&<p role="alert">{create.error?.message||reconcile.error?.message}</p>}
  </div>;
}

export function PaymentGatewayReadiness(){
 const q=trpc.recruitment.invoices.checkoutReadiness.useQuery();
 if(!q.data)return null;
 return <div aria-label="Online payment readiness" className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600"><p className="font-semibold">Stripe checkout · {q.data.configured?`${q.data.mode} mode`:'Account setup required'}</p><p>Checkout links become available on collectible invoices after provider setup. {q.data.mode==='test'?'Sandbox payments do not settle invoices.':'Verified provider receipts and bank settlement are tracked separately.'}</p></div>;
}
