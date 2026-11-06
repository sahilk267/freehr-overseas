import {ClientDiscoveryPanel} from "./ClientDiscoveryPanel";
import { useState, useEffect, type FormEvent } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

const labels = { review_reply: "Review reply", arrange_discovery: "Arrange discovery call", clarify_requirement: "Clarify hiring requirements", prepare_response: "Prepare a response", close_no_interest: "Close: no current interest", stop_contact: "Stop contact" } as const;
function ReplyResponseForm({ conversationId, messageId, replyRevision, actionRevision }: { conversationId: string; messageId: string; replyRevision: number; actionRevision: number }) {
  const { data: identities = [] } = trpc.email.identities.list.useQuery();
  const [approvalId, setApprovalId] = useState("");
  const prepare = trpc.recruitment.outreach.prepareReplyEmail.useMutation({ onSuccess: async result => { setApprovalId(result.approvalId); toast.success(result.alreadyExists ? "Existing response reused." : "Response ready in the outbound approval queue."); } });
  const utils = trpc.useUtils();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      await prepare.mutateAsync({ conversationId, messageId, replyRevision, actionRevision, senderIdentityId: String(form.get("senderIdentityId")), subject: String(form.get("subject")), body: String(form.get("body")) });
      await utils.operations.approvals.list.invalidate();
      await utils.recruitment.outreach.replyCase.invalidate({ conversationId });
    } catch { /* Shared app mutation handler displays errors. */ }
  };
  return <form onSubmit={submit} className="grid gap-3 rounded-lg border p-3">
    <h3 className="text-sm font-semibold">Prepare client response</h3>
    <div><Label htmlFor="reply-sender">Send from</Label><select id="reply-sender" name="senderIdentityId" required className="mt-1 w-full rounded-md border p-2 text-sm"><option value="">Choose a client sender</option>{identities.filter(i => i.status === "active" && i.purpose === "clients").map(i => <option key={i.id} value={i.id}>{i.email}</option>)}</select></div>
    <div><Label htmlFor="reply-subject">Subject</Label><Input id="reply-subject" name="subject" required maxLength={255} defaultValue="Re: Hiring enquiry" /></div>
    <div><Label htmlFor="reply-body">Response</Label><Textarea id="reply-body" name="body" required minLength={8} maxLength={11500} placeholder="Respond to the client’s current question or request availability for a discovery call." /></div>
    <p className="text-xs text-slate-500">An opt-out line is added. Review and approve the exact response in the outbound queue before sending.</p>
    <Button type="submit" disabled={prepare.isPending} className="justify-self-start" variant="outline">Prepare response for approval</Button>
    {approvalId && <p role="status" className="break-all text-xs">Response approval: {approvalId}. Open it in the outbound approval queue.</p>}
  </form>;
}
function ReplyDetail({ conversationId }: { conversationId: string }) {
  const utils = trpc.useUtils();
  const query = trpc.recruitment.outreach.replyCase.useQuery({ conversationId }, {refetchInterval:15_000});
  const save = trpc.recruitment.outreach.recordReplyAction.useMutation({ onSuccess: async () => { await utils.recruitment.outreach.replyCase.invalidate({ conversationId }); toast.success("Next action recorded."); } });
  const complete = trpc.recruitment.outreach.completeReplyAction.useMutation({onSuccess:async()=>{await utils.recruitment.outreach.replyCase.invalidate({conversationId});await utils.operations.exceptions.list.invalidate();toast.success("Reply task completed.");}});
  const cancel = trpc.recruitment.outreach.cancelReplyEmail.useMutation({ onSuccess: async () => { await utils.recruitment.outreach.replyCase.invalidate({ conversationId }); await utils.operations.approvals.list.invalidate(); toast.success("Unused response cancelled."); } });
  const [action, setAction] = useState<keyof typeof labels | "">("");
  const detail = query.data;
  useEffect(() => setAction(""), [detail?.message?.id, detail?.action?.revision]);
  if (query.isLoading) return <p className="text-sm">Loading client reply…</p>;
  if (query.error) return <p role="alert" className="text-sm text-red-700">{query.error.message}</p>;
  if (!detail?.message) return <p className="text-sm text-slate-500">No reply recorded for this client thread yet. Older inbox records remain available in message history.</p>;
  const current = detail.action as { action?: keyof typeof labels; notes?: string; dueAt?: string; revision: number } | null;
  const selectedAction = detail.blocked ? "stop_contact" : action || current?.action || detail.recommendation;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget), due = String(form.get("dueAt") || "");
    try {
      await save.mutateAsync({ conversationId, messageId: detail.message!.id, replyRevision: detail.replyRevision, expectedActionRevision: current?.revision ?? 0, action: selectedAction, notes: String(form.get("notes")), ...(due ? { dueAt: new Date(due) } : {}) });
    } catch { /* Shared mutation errors are displayed by the app. */ }
  };
  return <div className="mt-4 space-y-3" key={detail.message.id}>
    <Button variant="outline" size="sm" type="button" onClick={() => query.refetch()}>Refresh latest reply</Button>
    <p className="text-sm font-semibold">{detail.companyName} · {detail.contactName}</p>
    <p className="text-xs font-medium">{detail.message.subject || "Client reply"}</p>
    <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-sm">{detail.message.body}</p>
    <p className="text-sm">Suggested next action: <strong>{labels[detail.recommendation]}</strong></p>
    {!detail.assessment && !detail.blocked && <p className="text-xs text-slate-500">Reply assessment is pending. You can review and record the next action now.</p>}
    {detail.blocked && <p role="status" className="text-sm text-red-700">Contact is blocked. A reply or task note does not restore contact permission.</p>}
    {detail.completion ? <p role="status" className="rounded-lg border p-3 text-sm">Task completed: {detail.completion.reason} <span className="block text-xs text-slate-500">{new Date(detail.completion.at).toLocaleString()}</span></p> : current && !detail.blocked && <form className="grid gap-2 rounded-lg border p-3" onSubmit={async e=>{e.preventDefault();try{const form=new FormData(e.currentTarget);await complete.mutateAsync({conversationId,messageId:detail.message!.id,replyRevision:detail.replyRevision,actionRevision:current.revision,reason:String(form.get("completionReason"))});}catch{/* Shared mutation handler displays errors. */}}}><Label htmlFor="reply-completion-reason">Completion note</Label><Input id="reply-completion-reason" name="completionReason" required minLength={8} maxLength={2000} placeholder="What was completed in this owner task?"/><Button type="submit" variant="outline" disabled={complete.isPending} className="justify-self-start">Complete task</Button><p className="text-xs text-slate-500">Records completion of your task. Client acceptance, delivery and attendance require their own evidence.</p></form>}
    <form onSubmit={submit} className="grid gap-3" key={`action:${detail.message.id}:${current?.revision ?? 0}:${detail.completion?.at ?? "open"}`}>
      <div><Label htmlFor="reply-next-action">Next action</Label><select id="reply-next-action" className="mt-1 w-full rounded-md border p-2 text-sm" value={selectedAction} disabled={detail.blocked} onChange={e => setAction(e.target.value as keyof typeof labels)}>{Object.entries(labels).filter(([key]) => detail.blocked || key !== "stop_contact").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      <div><Label htmlFor="reply-action-notes">Action notes</Label><Textarea id="reply-action-notes" name="notes" required minLength={8} maxLength={2000} defaultValue={current?.notes ?? ""} placeholder="Record what needs to happen and any client context." /></div>
      <div><Label htmlFor="reply-due-at">Due at (your local time, optional)</Label><Input id="reply-due-at" name="dueAt" type="datetime-local" defaultValue={!detail.completion && current?.dueAt ? new Date(new Date(current.dueAt).getTime() - new Date(current.dueAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""} /></div>
      <Button type="submit" disabled={save.isPending} className="justify-self-start">{detail.completion ? "Save new next action" : "Save next action"}</Button>
      <p className="text-xs text-slate-500">A due date creates one owner escalation in Exceptions if this action remains current. Clear the due date or revise the action when complete. Discovery booking and sending a response have their own workflows.</p>
    </form>
    <ClientDiscoveryPanel key={`discovery:${detail.message.id}:${current?.revision ?? 0}`} conversationId={conversationId} replyRevision={detail.replyRevision} actionRevision={current?.revision ?? 0} canCreate={!detail.blocked && !detail.completion && current?.action === "arrange_discovery"} />
    {detail.response && <div className="rounded-lg border p-3 text-sm"><p>Latest response: {detail.response.status.replaceAll("_", " ")}</p><p className="mt-1 break-all text-xs text-slate-500">Approval {detail.response.approvalId}</p>{detail.response.cancellable && <Button type="button" size="sm" variant="outline" disabled={cancel.isPending} className="mt-2" onClick={() => cancel.mutate({ approvalId: detail.response!.approvalId, reason: "Owner cancelled unused client response for revision." })}>Cancel unused response</Button>}</div>}
    {!detail.blocked && !detail.completion && current && ["arrange_discovery", "clarify_requirement", "prepare_response"].includes(current.action ?? "") && <ReplyResponseForm key={`response:${detail.message.id}:${current.revision}`} conversationId={conversationId} messageId={detail.message.id} replyRevision={detail.replyRevision} actionRevision={current.revision} />}
  </div>;
}
export function ClientReplyPanel() {
  const { data = [], error } = trpc.recruitment.outreach.list.useQuery({ limit: 100 });
  const [selected, setSelected] = useState(() => { const id=new URLSearchParams(location.search).get("conversation")||"";return /^[A-Za-z0-9_-]{4,36}$/.test(id)?id:""; });
  const requestId = new URLSearchParams(location.search).get("discovery") || "";
  const linkedRequest = trpc.clientDiscovery.get.useQuery({ requestId }, { enabled: /^[A-Za-z0-9_-]{4,36}$/.test(requestId), retry: false });
  useEffect(() => { if (linkedRequest.data) { setSelected(linkedRequest.data.conversationId); document.getElementById("client-reply-actions")?.scrollIntoView(); } }, [linkedRequest.data?.conversationId]);
  const clients = data.filter(c => c.contactId && c.companyId && !c.candidateId);
  return <Card id="client-reply-actions" className="border-slate-200 bg-white"><CardContent className="p-5">
    <h2 className="font-semibold text-[#10213d]">Client reply next actions</h2>
    <p className="mt-1 text-sm text-slate-500">Review the latest client response and keep a clear next step for acquisition.</p>
    {error && <p role="alert">{error.message}</p>}
    <Label htmlFor="client-reply-thread" className="mt-4 block">Client conversation</Label>
    <select id="client-reply-thread" className="mt-1 w-full rounded-md border p-2 text-sm" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose a client thread</option>{selected && !clients.some(c => c.id === selected) && <option value={selected}>Selected client thread</option>}{clients.map(c => <option key={c.id} value={c.id}>Thread {c.id.slice(-6)} · {c.classification?.replaceAll("_", " ") || c.status.replaceAll("_", " ")}</option>)}</select>
    {!clients.length && <p className="mt-3 text-sm text-slate-500">Client contact conversations will appear here when outreach starts.</p>}
    {selected && <ReplyDetail key={selected} conversationId={selected} />}
  </CardContent></Card>;
}
