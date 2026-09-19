import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { useAuth } from "../_core/hooks/useAuth";
import { AlertTriangle, ArrowRight, BadgeCheck, Ban, BrainCircuit, Building2, CalendarClock, Check, CheckCircle2, ChevronRight, CircleDollarSign, Clock3, Download, FileCheck2, FileWarning, Gavel, LockKeyhole, Mail, Plus, RefreshCcw, Send, ShieldAlert, SlidersHorizontal, UserCheck, UsersRound, X } from "lucide-react";
import { FormEvent, ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";

const dateTime = (value: Date | null | undefined) => value ? new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";
const dateOnly = (value: Date | null | undefined) => value ? new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)) : "—";
const mailboxAddresses = { owner: "owner.fl@overseasjob.in", clients: "clients.fl@overseasjob.in", talent: "talent.fl@overseasjob.in", interviews: "interviews.fl@overseasjob.in", finance: "finance.fl@overseasjob.in", privacy: "privacy.fl@overseasjob.in" } as const;
const friendly = (value: string | null | undefined) => (value ?? "unknown").replaceAll("_", " ");

const stateTone = (state: string | null | undefined) => {
  const value = state ?? "";
  if (/(active|approved|qualified|paid|granted|confirmed|succeeded|joined|resolved|clean)/.test(value)) return "bg-[#dcefe8] text-[#174d3b]";
  if (/(pending|draft|queued|needs|proposed|validation|scheduled|received|accepted_pending_scan)/.test(value)) return "bg-[#fff2c8] text-[#75531b]";
  if (/(failed|blocked|overdue|withdrawn|rejected|disputed|critical|stop|flagged)/.test(value)) return "bg-[#ffe5e0] text-[#9f3323]";
  return "bg-slate-100 text-slate-600";
};

function StateBadge({ value }: { value: string | null | undefined }) {
  return <Badge className={`border-0 px-2.5 py-1 text-[11px] font-semibold capitalize ${stateTone(value)}`}>{friendly(value)}</Badge>;
}

function DecisionSourceBadge({ source }: { source: "manual" | "policy" | string | null | undefined }) {
  const isPolicy = source === "policy";
  return (
    <Badge
      className={`border-0 px-2 py-0.5 text-[10px] font-semibold ${
        isPolicy ? "bg-[#e0ecff] text-[#1c3d73]" : "bg-slate-100 text-slate-600"
      }`}
    >
      {isPolicy ? "Auto (Policy)" : "Manual"}
    </Badge>
  );
}

function PageShell({ eyebrow, title, description, children, action }: { eyebrow: string; title: string; description: string; children: ReactNode; action?: ReactNode }) {
  return <div className="mx-auto max-w-[1480px] space-y-6"><section className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#a47d2c]">{eyebrow}</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#10213d]">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{description}</p></div>{action}</section>{children}</div>;
}

function SectionTitle({ icon: Icon, title, detail, action }: { icon: typeof BrainCircuit; title: string; detail?: string; action?: ReactNode }) {
  return <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div className="flex gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#f7f5f0] text-[#a47d2c]"><Icon className="h-4 w-4" /></div><div><h2 className="text-base font-semibold text-[#10213d]">{title}</h2>{detail && <p className="mt-0.5 text-xs leading-5 text-slate-500">{detail}</p>}</div></div>{action}</div>;
}

function Empty({ title, detail, icon: Icon = FileWarning }: { title: string; detail: string; icon?: typeof FileWarning }) {
  return <div className="rounded-2xl border border-dashed border-slate-200 bg-[#fcfbf8] p-7 text-center"><Icon className="mx-auto h-5 w-5 text-[#a47d2c]" /><p className="mt-3 text-sm font-semibold text-[#10213d]">{title}</p><p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-slate-500">{detail}</p></div>;
}

function FormCard({ children, title, detail }: { children: ReactNode; title: string; detail: string }) {
  return <Card className="border-slate-200 bg-white shadow-[0_12px_35px_-28px_rgba(15,23,42,0.35)]"><CardContent className="p-5"><h3 className="text-sm font-semibold text-[#10213d]">{title}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p><div className="mt-4">{children}</div></CardContent></Card>;
}

function HeaderAction({ children }: { children: ReactNode }) { return <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{children}</div>; }

export function ProspectsPage() {
  const utils = trpc.useUtils();
  const { data: companies = [], isLoading } = trpc.recruitment.prospects.list.useQuery({ limit: 100 });
  const { data: emailConversations = [] } = trpc.email.inbound.conversations.useQuery({ limit: 8 });
  const { data: recentApprovals = [] } = trpc.operations.approvals.list.useQuery({ limit: 8 });
  const create = trpc.recruitment.prospects.create.useMutation({ onSuccess: () => { utils.recruitment.prospects.list.invalidate(); toast.success("Prospect added to controlled CRM."); } });
  const transition = trpc.recruitment.prospects.transition.useMutation({ onSuccess: () => utils.recruitment.prospects.list.invalidate() });
  const requestOnboarding = trpc.recruitment.prospects.requestOnboardingApproval.useMutation({ onSuccess: () => toast.success("Owner onboarding approval created.") });
  const [showForm, setShowForm] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const { data: messageHistory = [] } = trpc.email.inbound.messages.useQuery({ conversationId: selectedConversationId ?? "none" }, { enabled: Boolean(selectedConversationId) });
  const { data: approvalDetail } = trpc.email.outbound.approvalDetail.useQuery({ approvalId: selectedApprovalId ?? "none" }, { enabled: Boolean(selectedApprovalId) });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    create.mutate({ name: String(form.get("name")), domain: String(form.get("domain")) || undefined, sector: String(form.get("sector")) || undefined, location: String(form.get("location")) || undefined, sourceType: String(form.get("sourceType")) || "manual", sourceUrl: String(form.get("sourceUrl")) || undefined, hiringSignal: String(form.get("signal")) || undefined, confidence: Number(form.get("confidence") || 0), notes: String(form.get("notes")) || undefined });
    event.currentTarget.reset(); setShowForm(false);
  };
  return <PageShell eyebrow="Client acquisition" title="Prospects & client onboarding" description="Keep lead provenance, outreach status, hiring discovery, fee proposals, and controlled client activation in one auditable pipeline." action={<HeaderAction><Button onClick={() => setShowForm(v => !v)} className="bg-[#10213d] hover:bg-[#1a3156]"><Plus className="mr-2 h-4 w-4" />Add prospect</Button></HeaderAction>}>
    {showForm && <FormCard title="Create a source-linked prospect" detail="Only add leads from approved sources. Every record retains its collection route and confidence."><form onSubmit={submit} className="grid gap-3 sm:grid-cols-2"><div><Label>Company name</Label><Input name="name" required placeholder="Example Technologies" /></div><div><Label>Domain</Label><Input name="domain" placeholder="example.com" /></div><div><Label>Sector</Label><Input name="sector" placeholder="SaaS, healthcare, logistics…" /></div><div><Label>Location</Label><Input name="location" placeholder="Bengaluru, India" /></div><div><Label>Source type</Label><Input name="sourceType" defaultValue="manual" /></div><div><Label>Confidence (0–100)</Label><Input name="confidence" type="number" min="0" max="100" defaultValue="60" /></div><div className="sm:col-span-2"><Label>Source URL</Label><Input name="sourceUrl" type="url" placeholder="https://…" /></div><div className="sm:col-span-2"><Label>Hiring signal / notes</Label><Textarea name="signal" placeholder="Hiring activity, referral context, or discovery signal." /></div><div className="sm:col-span-2 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button><Button type="submit" disabled={create.isPending} className="bg-[#10213d]">Save prospect</Button></div></form></FormCard>}
    <Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={Building2} title="CRM pipeline" detail="Move qualified companies deliberately. Client activation creates an owner approval record." /><div className="mt-5 overflow-x-auto">{isLoading ? <p className="py-8 text-sm text-slate-500">Loading prospects…</p> : companies.length === 0 ? <Empty title="Your prospect pipeline is ready" detail="Add a source-linked company to begin controlled client acquisition." icon={Building2} /> : <table className="w-full min-w-[880px] text-left"><thead className="border-b border-slate-100 text-[11px] uppercase tracking-[0.1em] text-slate-400"><tr><th className="pb-3 font-semibold">Company</th><th className="pb-3 font-semibold">Pipeline</th><th className="pb-3 font-semibold">Provenance</th><th className="pb-3 font-semibold">Signal</th><th className="pb-3 font-semibold">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{companies.map(company => <tr key={company.id}><td className="py-4"><p className="font-semibold text-[#10213d]">{company.name}</p><p className="mt-1 text-xs text-slate-500">{company.domain || company.sector || "Domain to be verified"}</p></td><td className="py-4"><StateBadge value={company.pipelineState} /></td><td className="py-4 text-xs text-slate-500"><p className="capitalize">{company.sourceType}</p><p className="mt-1">Confidence {company.confidence}%</p></td><td className="max-w-[260px] py-4 text-xs text-slate-500">{company.hiringSignal || "No discovery signal recorded"}</td><td className="py-4"><div className="flex gap-2">{company.pipelineState === "new" && <Button size="sm" variant="outline" onClick={() => transition.mutate({ id: company.id, state: "researched" })}>Mark researched</Button>}{company.pipelineState === "converted" && <Button size="sm" onClick={() => requestOnboarding.mutate({ id: company.id })} className="bg-[#10213d]">Request approval</Button>}{company.pipelineState === "active" && <Badge className="bg-[#dcefe8] text-[#174d3b]">Client active</Badge>}</div></td></tr>)}</tbody></table>}</div></CardContent></Card>
    <div className="grid gap-6 xl:grid-cols-2"><Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={Mail} title="Hostinger Mail conversations" detail="Inbound API events remain linked to the existing client or candidate thread." /><div className="mt-4 space-y-2">{emailConversations.length === 0 ? <p className="text-xs text-slate-500">No inbound email conversations recorded yet.</p> : emailConversations.map(conversation => <div className="flex items-center justify-between rounded-xl bg-[#f7f5f0] px-3 py-2" key={conversation.id}><button className="min-w-0 text-left" onClick={() => setSelectedConversationId(conversation.id)}><p className="text-xs font-medium text-[#10213d]">Thread {conversation.id.slice(-6)} · {friendly(conversation.channel)}</p><p className="mt-1 text-[11px] text-slate-500">{dateTime(conversation.lastMessageAt)}</p></button><StateBadge value={conversation.status} /></div>)}</div>{selectedConversationId && <div className="mt-4 rounded-2xl border border-slate-100 p-3"><p className="text-xs font-semibold text-[#10213d]">Message history</p><div className="mt-2 space-y-2">{messageHistory.length === 0 ? <p className="text-xs text-slate-500">No message records for this thread.</p> : messageHistory.map(message => <div key={message.id} className="rounded-lg bg-slate-50 p-2 text-xs"><div className="flex justify-between gap-2"><span className="font-medium text-[#10213d]">{friendly(message.direction)} · {friendly(message.status)}</span><span className="text-slate-400">{dateTime(message.createdAt)}</span></div><p className="mt-1 truncate text-slate-600">{message.subject || "No subject"}</p><p className="mt-1 truncate text-[11px] text-slate-400">{message.providerMessageId || "Local controlled record"}</p></div>)}</div></div>}</CardContent></Card><Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={FileCheck2} title="Outbound approval queue" detail="No client or candidate email leaves the workspace until its owner approval is recorded." /><div className="mt-4 space-y-2">{recentApprovals.filter(item => item.actionType === "email_send").length === 0 ? <p className="text-xs text-slate-500">No email approvals pending or recently decided.</p> : recentApprovals.filter(item => item.actionType === "email_send").map(approval => <div className="flex items-center justify-between rounded-xl bg-[#f7f5f0] px-3 py-2" key={approval.id}><button className="min-w-0 text-left" onClick={() => setSelectedApprovalId(approval.id)}><p className="text-xs font-medium text-[#10213d]">Message {approval.resourceId.slice(-6)}</p><p className="mt-1 truncate text-[11px] text-slate-500">{approval.reason}</p></button><div className="flex items-center gap-1.5"><DecisionSourceBadge source={approval.decisionSource} /><StateBadge value={approval.status} /></div></div>)}</div>{approvalDetail && <div className="mt-4 rounded-2xl border border-slate-100 p-3 text-xs"><p className="font-semibold text-[#10213d]">Approval details</p><p className="mt-2 text-slate-500">Reason: {approvalDetail.approval.reason}</p><div className="mt-1 flex flex-wrap items-center gap-1.5 text-slate-500"><span>Status: {friendly(approvalDetail.approval.status)}</span><span>·</span><span>Source:</span><DecisionSourceBadge source={approvalDetail.approval.decisionSource} /><span>·</span><span>Message: {approvalDetail.message?.subject || "record unavailable"}</span></div><p className="mt-1 text-slate-500">Thread: {approvalDetail.conversation?.id.slice(-6) || "not linked"}</p><pre className="mt-2 max-h-24 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] text-slate-600">{JSON.stringify(approvalDetail.approval.payload ?? {}, null, 2)}</pre></div>}</CardContent></Card></div>
  </PageShell>;
}

export function JobsPage() {
  const utils = trpc.useUtils();
  const { data: jobsList = [], isLoading } = trpc.recruitment.jobs.list.useQuery({ limit: 100 });
  const { data: companies = [] } = trpc.recruitment.prospects.list.useQuery({ limit: 100 });
  const create = trpc.recruitment.jobs.create.useMutation({ onSuccess: () => { utils.recruitment.jobs.list.invalidate(); toast.success("Requisition created in draft mode."); } });
  const transition = trpc.recruitment.jobs.transition.useMutation({ onSuccess: () => utils.recruitment.jobs.list.invalidate() });
  const [showForm, setShowForm] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const f = new FormData(event.currentTarget); const scorecard = String(f.get("scorecard") || "").split("\n").map(line => line.trim()).filter(Boolean).map(line => { const [criterion, weight, required] = line.split("|").map(value => value.trim()); return { criterion, weight: Number(weight), required: required?.toLowerCase() === "required" }; }).filter(item => item.criterion && Number.isFinite(item.weight)); create.mutate({ companyId: String(f.get("companyId")), title: String(f.get("title")), location: String(f.get("location")) || undefined, workModel: (String(f.get("workModel")) || undefined) as "remote" | "hybrid" | "onsite" | undefined, compensationMin: f.get("min") ? Number(f.get("min")) : undefined, compensationMax: f.get("max") ? Number(f.get("max")) : undefined, experienceMinYears: f.get("minYears") ? Number(f.get("minYears")) : undefined, experienceMaxYears: f.get("maxYears") ? Number(f.get("maxYears")) : undefined, mustHaveSkills: String(f.get("must" ) || "").split(",").map(v => v.trim()).filter(Boolean), niceToHaveSkills: String(f.get("nice") || "").split(",").map(v => v.trim()).filter(Boolean), scorecard }); event.currentTarget.reset(); setShowForm(false); };
  return <PageShell eyebrow="Hiring intake" title="Job requisitions" description="Translate client needs into confirmed, quality-checked, scorecard-driven requisitions before sourcing begins." action={<Button onClick={() => setShowForm(v => !v)} disabled={companies.length === 0} className="bg-[#10213d] hover:bg-[#1a3156]"><Plus className="mr-2 h-4 w-4" />New requisition</Button>}>
    {companies.length === 0 && <div className="rounded-2xl border border-[#f5d77b] bg-[#fffaf0] p-4 text-sm text-[#745824]">Create or activate a prospect before opening a requisition. The client relationship stays linked to every requirement and shortlist.</div>}
    {showForm && <FormCard title="Structured client intake" detail="Mandatory skills, compensation, experience, weighted scorecard, and location contribute to a requirement quality score."><form onSubmit={submit} className="grid gap-3 md:grid-cols-2"><div><Label>Client</Label><select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" name="companyId" required>{companies.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></div><div><Label>Role title</Label><Input name="title" required placeholder="Senior Backend Engineer" /></div><div><Label>Location</Label><Input name="location" placeholder="Mumbai / remote" /></div><div><Label>Work model</Label><select name="workModel" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">Select</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">Onsite</option></select></div><div><Label>Minimum compensation</Label><Input name="min" type="number" min="0" /></div><div><Label>Maximum compensation</Label><Input name="max" type="number" min="0" /></div><div><Label>Minimum experience (years)</Label><Input name="minYears" type="number" min="0" max="40" /></div><div><Label>Maximum experience (years)</Label><Input name="maxYears" type="number" min="0" max="40" /></div><div className="md:col-span-2"><Label>Must-have skills</Label><Input name="must" placeholder="TypeScript, PostgreSQL, API design" /></div><div className="md:col-span-2"><Label>Weighted scorecard (one per line: criterion | weight | optional `required`; weights must total 100)</Label><Textarea name="scorecard" placeholder="Core technical evidence | 45 | required\nRelevant domain delivery | 30\nStakeholder communication | 25" /></div><div className="md:col-span-2"><Label>Nice-to-have skills</Label><Input name="nice" placeholder="Kafka, AWS, fintech" /></div><div className="md:col-span-2 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button><Button type="submit" disabled={create.isPending} className="bg-[#10213d]">Create draft</Button></div></form></FormCard>}
    <Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={FileCheck2} title="Requirement quality & pipeline" detail="Sourcing is only enabled after a client-confirmed requirement is recorded." /><div className="mt-5 space-y-3">{isLoading ? <p className="py-8 text-sm text-slate-500">Loading requisitions…</p> : jobsList.length === 0 ? <Empty title="No requisitions yet" detail="The structured intake workflow will create measurable job criteria and an auditable scorecard." icon={FileCheck2} /> : jobsList.map(job => <div key={job.id} className="rounded-2xl border border-slate-100 p-4 sm:p-5"><div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-[#10213d]">{job.title}</h3><StateBadge value={job.pipelineState} /></div><p className="mt-1 text-sm text-slate-500">{job.location || "Location not set"} · {friendly(job.workModel)}</p><div className="mt-3 flex items-center gap-3"><Progress value={job.requirementQuality} className="h-2 max-w-44" /><span className="text-xs font-medium text-slate-600">{job.requirementQuality}% requirement quality</span></div></div><div className="flex flex-wrap gap-2">{job.pipelineState === "draft" && <Button size="sm" variant="outline" onClick={() => transition.mutate({ id: job.id, state: "client_confirmation", clientConfirmedBy: "owner@freelancehr.local" })}>Confirm intake</Button>}{job.pipelineState === "client_confirmation" && <Button size="sm" className="bg-[#10213d]" onClick={() => transition.mutate({ id: job.id, state: "approved", clientConfirmedBy: "owner@freelancehr.local" })}>Approve role</Button>}{job.pipelineState === "approved" && <Button size="sm" className="bg-[#10213d]" onClick={() => transition.mutate({ id: job.id, state: "sourcing" })}>Start sourcing</Button>}</div></div></div>)}</div></CardContent></Card>
  </PageShell>;
}

export function CandidatesPage() {
  const utils = trpc.useUtils();
  const [profileFilter, setProfileFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [availabilityFilter, setAvailabilityFilter] = useState("");
  const { data: candidateList = [], isLoading } = trpc.recruitment.candidates.list.useQuery({ limit: 100, profileState: profileFilter || undefined, sourceType: sourceFilter || undefined, availability: availabilityFilter || undefined });
  const { data: jobsList = [] } = trpc.recruitment.jobs.list.useQuery({ limit: 100 });
  const { data: companies = [] } = trpc.recruitment.prospects.list.useQuery({ limit: 100 });
  const create = trpc.recruitment.candidates.create.useMutation({ onSuccess: () => { utils.recruitment.candidates.list.invalidate(); toast.success("Candidate added with consent pending."); } });
  const grant = trpc.recruitment.candidates.grantConsent.useMutation({ onSuccess: () => { utils.recruitment.candidates.list.invalidate(); toast.success("Purpose-specific consent recorded."); } });
  const dnc = trpc.recruitment.candidates.doNotContact.useMutation({ onSuccess: () => { utils.recruitment.candidates.list.invalidate(); toast.success("Candidate added to the do-not-contact suppression list."); } });
  const withdraw = trpc.recruitment.candidates.withdraw.useMutation({ onSuccess: () => { utils.recruitment.candidates.list.invalidate(); toast.success("Withdrawal processed and sharing suppressed."); } });
  const createMatch = trpc.recruitment.matching.createEvidenceMatch.useMutation({ onSuccess: () => toast.success("Evidence-based match recorded.") });
  const requestShare = trpc.recruitment.matching.requestShareApproval.useMutation({ onSuccess: () => toast.success("Controlled profile-share approval created.") });
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const { data: documentList = [], refetch: refetchDocs } = trpc.recruitment.candidates.documents.list.useQuery(
    selectedCandidateId ? { candidateId: selectedCandidateId } : undefined
  );
  const scanDoc = trpc.recruitment.candidates.documents.scan.useMutation({
    onSuccess: (data) => {
      utils.recruitment.candidates.documents.list.invalidate();
      if (data.status === "clean") {
        toast.success("Security scan completed: document is clean and verified.");
      } else {
        toast.error(`Security scan flagged document: ${data.findings.join(", ")}`);
      }
    },
    onError: (err) => {
      toast.error(err.message || "Security scan failed.");
    },
  });
  const handleAccessDoc = async (documentId: string) => {
    try {
      const result = await utils.recruitment.candidates.documents.access.fetch({ documentId });
      if (result?.url) {
        window.open(result.url, "_blank");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Access denied.";
      toast.error(msg);
    }
  };
  const uploadDocument = trpc.recruitment.candidates.documents.upload.useMutation({
    onSuccess: () => {
      utils.recruitment.candidates.documents.list.invalidate();
      toast.success("Document stored privately. Security scan queued.");
    },
  });
  const [searchText, setSearchText] = useState("");
  const { data: searchResults = [] } = trpc.recruitment.candidates.search.useQuery({ query: searchText, limit: 100 }, { enabled: searchText.trim().length > 0 });
  const displayedCandidates = searchText.trim() ? searchResults : candidateList;
  const { data: screeningRecords = [] } = trpc.recruitment.candidateWorkflows.screenings.list.useQuery({ limit: 20 });
  const { data: shortlistRecords = [] } = trpc.recruitment.candidateWorkflows.shortlists.list.useQuery({ limit: 20 });
  const [showForm, setShowForm] = useState(false);
  const [showMatch, setShowMatch] = useState(false);
  const [showDocument, setShowDocument] = useState(false);
  const submitCandidate = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const f = new FormData(event.currentTarget); create.mutate({ fullName: String(f.get("name")), email: String(f.get("email")) || undefined, phone: String(f.get("phone")) || undefined, headline: String(f.get("headline")) || undefined, location: String(f.get("location")) || undefined, availability: String(f.get("availability")) || undefined, sourceType: String(f.get("sourceType")) || "manual", sourceUrl: String(f.get("sourceUrl")) || undefined }); event.currentTarget.reset(); setShowForm(false); };
  const submitMatch = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const f = new FormData(event.currentTarget); const candidateId = String(f.get("candidateId")); const jobId = String(f.get("jobId")); const evidence = String(f.get("evidence")).split("\n").map(value => value.trim()).filter(Boolean); const missingEvidence = String(f.get("missing")).split("\n").map(value => value.trim()).filter(Boolean); createMatch.mutate({ candidateId, jobId, ruleScore: Number(f.get("ruleScore")), semanticScore: Number(f.get("semanticScore")), confidence: Number(f.get("confidence")), evidence, missingEvidence }, { onSuccess: () => { const job = jobsList.find(value => value.id === jobId); if (job) requestShare.mutate({ candidateId, jobId, companyId: job.companyId }); } }); event.currentTarget.reset(); setShowMatch(false); };
  const submitDocument = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const f = new FormData(event.currentTarget); const file = f.get("document") as File; if (!file || !file.size) return toast.error("Choose a CV, portfolio, offer, or identity document first."); if (file.size > 5 * 1024 * 1024) return toast.error("Documents must be 5 MB or smaller."); const supported = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"]; if (!supported.includes(file.type)) return toast.error("Only PDF, DOCX, or TXT documents are accepted."); const reader = new FileReader(); reader.onload = () => { const value = typeof reader.result === "string" ? reader.result.split(",")[1] : ""; if (!value) return toast.error("The file could not be encoded securely."); uploadDocument.mutate({ candidateId: String(f.get("candidateId")), documentType: String(f.get("documentType")) as "cv" | "portfolio" | "offer" | "identity" | "other", originalName: file.name, mimeType: file.type as "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "text/plain", dataBase64: value }); }; reader.onerror = () => toast.error("The selected file could not be read."); reader.readAsDataURL(file); event.currentTarget.reset(); setShowDocument(false); };
  return <PageShell eyebrow="Candidate operations" title="Candidates, consent & matching" description="Maintain profile provenance, purpose-specific consent, evidence-based screening signals, and controlled client sharing." action={<HeaderAction><Button variant="outline" onClick={() => setShowDocument(v => !v)} disabled={!candidateList.length}>Upload CV</Button><Button variant="outline" onClick={() => setShowMatch(v => !v)} disabled={!candidateList.length || !jobsList.length}>Record match</Button><Button onClick={() => setShowForm(v => !v)} className="bg-[#10213d] hover:bg-[#1a3156]"><Plus className="mr-2 h-4 w-4" />Add candidate</Button></HeaderAction>}>
    {showForm && <FormCard title="Candidate profile & provenance" detail="Profiles begin with consent pending. Do not send or share a profile until the appropriate consent is recorded."><form onSubmit={submitCandidate} className="grid gap-3 md:grid-cols-2"><div><Label>Full name</Label><Input name="name" required /></div><div><Label>Professional headline</Label><Input name="headline" placeholder="Frontend engineer · React & design systems" /></div><div><Label>Email</Label><Input name="email" type="email" /></div><div><Label>Phone</Label><Input name="phone" /></div><div><Label>Location</Label><Input name="location" /></div><div><Label>Availability</Label><Input name="availability" placeholder="30 days notice" /></div><div><Label>Source type</Label><Input name="sourceType" defaultValue="manual" /></div><div><Label>Source URL</Label><Input name="sourceUrl" type="url" placeholder="https://…" /></div><div className="md:col-span-2 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button><Button disabled={create.isPending} type="submit" className="bg-[#10213d]">Create candidate</Button></div></form></FormCard>}
    {showMatch && <FormCard title="Evidence-based match lab" detail="Record job-related evidence only. Low-confidence or missing-evidence matches route to review and client sharing always requires recorded consent plus owner approval."><form onSubmit={submitMatch} className="grid gap-3 md:grid-cols-2"><div><Label>Candidate</Label><select name="candidateId" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{candidateList.map(candidate => <option value={candidate.id} key={candidate.id}>{candidate.fullName}</option>)}</select></div><div><Label>Job</Label><select name="jobId" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{jobsList.map(job => <option value={job.id} key={job.id}>{job.title}</option>)}</select></div><div><Label>Rule score</Label><Input name="ruleScore" type="number" min="0" max="100" defaultValue="72" /></div><div><Label>Semantic score</Label><Input name="semanticScore" type="number" min="0" max="100" defaultValue="75" /></div><div><Label>Confidence</Label><Input name="confidence" type="number" min="0" max="100" defaultValue="70" /></div><div className="hidden md:block" /><div><Label>Evidence (one per line)</Label><Textarea name="evidence" required placeholder="5 years TypeScript delivery\nBuilt REST API platforms" /></div><div><Label>Missing evidence (one per line)</Label><Textarea name="missing" placeholder="No AWS evidence supplied" /></div><div className="md:col-span-2 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowMatch(false)}>Cancel</Button><Button type="submit" disabled={createMatch.isPending} className="bg-[#10213d]">Save evidence match</Button></div></form></FormCard>}
    {showDocument && <FormCard title="Private candidate document" detail="Files are stored with provenance metadata. A CV is marked for parsing only; this does not create a hiring decision or external sharing permission."><form onSubmit={submitDocument} className="grid gap-3 md:grid-cols-2"><div><Label>Candidate</Label><select name="candidateId" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{candidateList.map(candidate => <option value={candidate.id} key={candidate.id}>{candidate.fullName}</option>)}</select></div><div><Label>Document type</Label><select name="documentType" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="cv">CV / resume</option><option value="portfolio">Portfolio</option><option value="offer">Offer document</option><option value="identity">Identity document</option><option value="other">Other</option></select></div><div className="md:col-span-2"><Label>Private file (PDF, DOCX, or TXT; maximum 5 MB)</Label><Input name="document" type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" required /></div><div className="md:col-span-2 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowDocument(false)}>Cancel</Button><Button type="submit" disabled={uploadDocument.isPending} className="bg-[#10213d]">Upload securely</Button></div></form></FormCard>}
    <Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={UsersRound} title="Candidate directory" detail="Every candidate retains source, consent, status, and suppression controls." /><div className="mt-4 grid gap-2 md:grid-cols-4"><Input value={searchText} onChange={event => setSearchText(event.target.value)} placeholder="Search name, headline, or location" aria-label="Search candidate directory" /><select value={profileFilter} onChange={event => setProfileFilter(event.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm"><option value="">All states</option><option value="consent_pending">Consent pending</option><option value="consented">Consented</option><option value="available">Available</option><option value="withdrawn">Withdrawn</option><option value="do_not_contact">Do not contact</option></select><select value={sourceFilter} onChange={event => setSourceFilter(event.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm"><option value="">All sources</option><option value="manual">Manual</option><option value="referral">Referral</option><option value="sourced">Sourced</option></select><Input value={availabilityFilter} onChange={event => setAvailabilityFilter(event.target.value)} placeholder="Filter availability" aria-label="Filter candidate availability" /></div><div className="mt-5 overflow-x-auto">{isLoading ? <p className="py-8 text-sm text-slate-500">Loading candidates…</p> : displayedCandidates.length === 0 ? <Empty title={searchText ? "No candidates match this search" : "No candidate records yet"} detail={searchText ? "Try a different name, professional headline, or location." : "Add a candidate from an approved source. The platform will start them in consent-pending state."} icon={UsersRound} /> : <table className="w-full min-w-[990px] text-left"><thead className="border-b border-slate-100 text-[11px] uppercase tracking-[0.1em] text-slate-400"><tr><th className="pb-3">Candidate</th><th className="pb-3">Status</th><th className="pb-3">Provenance</th><th className="pb-3">Availability</th><th className="pb-3">Controlled actions</th></tr></thead><tbody className="divide-y divide-slate-100">{displayedCandidates.map(candidate => <tr key={candidate.id}><td className="py-4"><p className="font-semibold text-[#10213d]">{candidate.fullName}</p><p className="mt-1 text-xs text-slate-500">{candidate.headline || candidate.email || "Profile details pending"}</p></td><td className="py-4"><StateBadge value={candidate.profileState} /></td><td className="py-4 text-xs text-slate-500"><p className="capitalize">{candidate.sourceType}</p><p className="mt-1">{dateOnly(candidate.sourceCollectedAt)}</p></td><td className="py-4 text-xs text-slate-500">{candidate.availability || "Not confirmed"}</td><td className="py-4"><div className="flex flex-wrap gap-2">{candidate.profileState === "consent_pending" && <Button size="sm" className="bg-[#10213d]" onClick={() => grant.mutate({ candidateId: candidate.id, consentType: "platform_processing" })}>Record consent</Button>}{!candidate.doNotContactAt && <Button size="sm" variant="outline" onClick={() => dnc.mutate({ candidateId: candidate.id, reason: "Owner-controlled suppression" })}><Ban className="mr-1 h-3.5 w-3.5" />DNC</Button>}{!candidate.withdrawnAt && <Button size="sm" variant="ghost" className="text-slate-600" onClick={() => withdraw.mutate({ candidateId: candidate.id, reason: "Owner initiated withdrawal workflow" })}>Withdraw</Button>}<Button size="sm" variant={selectedCandidateId === candidate.id ? "default" : "outline"} onClick={() => setSelectedCandidateId(prev => prev === candidate.id ? null : candidate.id)}><FileCheck2 className="mr-1 h-3.5 w-3.5" />Docs</Button></div></td></tr>)}</tbody></table>}</div></CardContent></Card>
    <Card className="border-slate-200 bg-white"><CardContent className="p-5"><div className="flex items-center justify-between"><SectionTitle icon={FileCheck2} title={selectedCandidateId ? `Private documents · ${candidateList.find(c => c.id === selectedCandidateId)?.fullName || "Selected candidate"}` : "Candidate documents & security verification"} detail="Every uploaded file must pass automated signature and integrity checks before access or AI parsing is permitted." />{selectedCandidateId && <Button size="sm" variant="ghost" onClick={() => setSelectedCandidateId(null)}>Show all candidates' docs</Button>}</div><div className="mt-4 overflow-x-auto">{documentList.length === 0 ? <p className="py-4 text-xs text-slate-500">No candidate documents uploaded yet. Use 'Upload CV' above to upload candidate files securely.</p> : <table className="w-full min-w-[700px] text-left"><thead className="border-b border-slate-100 text-[11px] uppercase tracking-[0.1em] text-slate-400"><tr><th className="pb-3">Document</th><th className="pb-3">Type & Size</th><th className="pb-3">Scan Status</th><th className="pb-3">Parsing</th><th className="pb-3 text-right">Secure Access</th></tr></thead><tbody className="divide-y divide-slate-100">{documentList.map(doc => { const cand = candidateList.find(c => c.id === doc.candidateId); return <tr key={doc.id}><td className="py-3"><p className="font-medium text-[#10213d] text-sm">{doc.originalName}</p><p className="text-xs text-slate-400">{cand ? cand.fullName : `Candidate ${doc.candidateId.slice(-5)}`} · {dateOnly(doc.createdAt)}</p></td><td className="py-3 text-xs text-slate-600"><span className="uppercase font-semibold">{doc.documentType}</span><span className="text-slate-400 ml-2">({doc.sizeBytes ? `${Math.round(doc.sizeBytes / 1024)} KB` : "—"})</span></td><td className="py-3"><div className="flex items-center gap-2"><StateBadge value={doc.scanState} />{doc.scanState === "clean" && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}{doc.scanState === "flagged" && <ShieldAlert className="h-4 w-4 text-rose-600" />}{doc.scanState === "accepted_pending_scan" && <Clock3 className="h-4 w-4 text-amber-600" />}</div></td><td className="py-3"><StateBadge value={doc.parseState} /></td><td className="py-3 text-right"><div className="flex items-center justify-end gap-2">{doc.scanState === "clean" ? <Button size="sm" variant="outline" onClick={() => handleAccessDoc(doc.id)} className="text-xs"><Download className="mr-1 h-3.5 w-3.5" />Access</Button> : doc.scanState === "accepted_pending_scan" ? <><Button size="sm" variant="outline" disabled className="text-xs text-slate-400"><LockKeyhole className="mr-1 h-3.5 w-3.5" />Pending</Button><Button size="sm" className="bg-[#10213d] text-xs" onClick={() => scanDoc.mutate({ documentId: doc.id })} disabled={scanDoc.isPending}><RefreshCcw className="mr-1 h-3.5 w-3.5" />Scan</Button></> : <Button size="sm" variant="outline" disabled className="text-xs text-rose-600 border-rose-200 bg-rose-50"><ShieldAlert className="mr-1 h-3.5 w-3.5" />Blocked</Button>}</div></td></tr>; })}</tbody></table>}</div></CardContent></Card>
    <div className="grid gap-6 xl:grid-cols-2"><Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={BrainCircuit} title="Evidence screening" detail="Evidence and confidence are visible before an owner makes any final decision." /><div className="mt-4 space-y-2">{screeningRecords.length === 0 ? <p className="text-xs text-slate-500">No evidence-screening records yet.</p> : screeningRecords.map(record => <div key={record.id} className="flex items-center justify-between rounded-xl bg-[#f7f5f0] px-3 py-2"><span className="text-xs font-medium text-[#10213d]">Candidate {record.candidateId.slice(-5)} · confidence {record.confidence}%</span><StateBadge value={record.status} /></div>)}</div></CardContent></Card><Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={UserCheck} title="Controlled shortlists" detail="Sharing remains permissioned by explicit candidate consent and owner approval." /><div className="mt-4 space-y-2">{shortlistRecords.length === 0 ? <p className="text-xs text-slate-500">No prepared or shared shortlist records yet.</p> : shortlistRecords.map(record => <div key={record.id} className="flex items-center justify-between rounded-xl bg-[#f7f5f0] px-3 py-2"><span className="text-xs font-medium text-[#10213d]">Candidate {record.candidateId.slice(-5)} · job {record.jobId.slice(-5)}</span><StateBadge value={record.status} /></div>)}</div></CardContent></Card></div>
  </PageShell>;
}

export function InterviewsPage() {
  const utils = trpc.useUtils();
  const { data: list = [], isLoading } = trpc.recruitment.interviews.list.useQuery({ limit: 100 });
  const { data: candidatesList = [] } = trpc.recruitment.candidates.list.useQuery({ limit: 100 });
  const { data: jobsList = [] } = trpc.recruitment.jobs.list.useQuery({ limit: 100 });
  const create = trpc.recruitment.interviews.create.useMutation({ onSuccess: () => { utils.recruitment.interviews.list.invalidate(); toast.success("Interview scheduled with audit trail."); } });
  const transition = trpc.recruitment.interviews.transition.useMutation({ onSuccess: () => utils.recruitment.interviews.list.invalidate() });
  const setReminder = trpc.recruitment.interviews.setReminder.useMutation({ onSuccess: () => { utils.recruitment.interviews.list.invalidate(); toast.success("Reminder schedule updated."); } });
  const reschedule = trpc.recruitment.interviews.reschedule.useMutation({ onSuccess: () => { utils.recruitment.interviews.list.invalidate(); toast.success("Interview rescheduled and calendar version incremented."); } });
  const cancelInterview = trpc.recruitment.interviews.cancel.useMutation({ onSuccess: () => { utils.recruitment.interviews.list.invalidate(); toast.success("Interview cancelled; the ICS export now carries CANCELLED status."); } });
  const recordFeedback = trpc.recruitment.feedback.record.useMutation({ onSuccess: () => { utils.recruitment.interviews.list.invalidate(); toast.success("Raw feedback and scorecard saved to the interview record."); } });
  const [showForm, setShowForm] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const f = new FormData(event.currentTarget); const job = jobsList.find(item => item.id === String(f.get("jobId"))); if (!job) return; create.mutate({ candidateId: String(f.get("candidateId")), jobId: job.id, companyId: job.companyId, scheduledAt: new Date(String(f.get("scheduledAt"))), timezone: String(f.get("timezone")) || "Asia/Kolkata", durationMinutes: Number(f.get("duration") || 45), meetingUrl: String(f.get("meetingUrl")) || undefined }); event.currentTarget.reset(); setShowForm(false); };
  const submitFeedback = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const f = new FormData(event.currentTarget); recordFeedback.mutate({ interviewId: String(f.get("interviewId")), authorName: String(f.get("authorName")), rawFeedback: String(f.get("rawFeedback")), technicalScore: f.get("technicalScore") ? Number(f.get("technicalScore")) : undefined, communicationScore: f.get("communicationScore") ? Number(f.get("communicationScore")) : undefined, roleEvidence: String(f.get("roleEvidence") || "").split("\n").map(value => value.trim()).filter(Boolean) }); event.currentTarget.reset(); setShowFeedback(false); };
  const feedbackReady = list.filter(item => ["completed", "feedback_pending", "feedback_received"].includes(item.status));
  const downloadIcs = async (id: string) => { const calendar = await utils.recruitment.interviews.exportIcs.fetch({ id }); const blob = new Blob([calendar.content], { type: "text/calendar;charset=utf-8" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = calendar.filename; anchor.click(); URL.revokeObjectURL(url); };
  const promptReschedule = (item: (typeof list)[number]) => { if (!item.scheduledAt) return; const value = window.prompt("New date/time (ISO format, e.g. 2026-09-01T10:30:00)", new Date(item.scheduledAt).toISOString().slice(0, 16)); if (!value) return; const scheduledAt = new Date(value); if (Number.isNaN(scheduledAt.getTime())) { toast.error("Please enter a valid date/time."); return; } reschedule.mutate({ id: item.id, scheduledAt, timezone: item.timezone, durationMinutes: item.durationMinutes, meetingUrl: item.meetingUrl }); };
  return <PageShell eyebrow="Interview operations" title="Schedule, prepare & collect feedback" description="Maintain availability, rescheduling, reminder, completion, and feedback transitions with an immutable record." action={<HeaderAction><Button variant="outline" disabled={!feedbackReady.length} onClick={() => setShowFeedback(v => !v)}>Record feedback</Button><Button disabled={!candidatesList.length || !jobsList.length} onClick={() => setShowForm(v => !v)} className="bg-[#10213d]"><CalendarClock className="mr-2 h-4 w-4" />Schedule interview</Button></HeaderAction>}>
    {showForm && <FormCard title="Schedule an interview" detail="Time is stored as a UTC event and displayed with the selected candidate/client timezone."><form onSubmit={submit} className="grid gap-3 md:grid-cols-2"><div><Label>Candidate</Label><select name="candidateId" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{candidatesList.map(c => <option key={c.id} value={c.id}>{c.fullName}</option>)}</select></div><div><Label>Job</Label><select name="jobId" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{jobsList.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}</select></div><div><Label>Date & time</Label><Input name="scheduledAt" type="datetime-local" required /></div><div><Label>Timezone</Label><Input name="timezone" defaultValue="Asia/Kolkata" /></div><div><Label>Duration (minutes)</Label><Input name="duration" type="number" min="15" max="240" defaultValue="45" /></div><div><Label>Meeting URL</Label><Input name="meetingUrl" type="url" placeholder="https://meet…" /></div><div className="md:col-span-2 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button><Button type="submit" className="bg-[#10213d]">Create event</Button></div></form></FormCard>}
    {showFeedback && <FormCard title="Interview feedback scorecard" detail="Raw feedback is preserved as written. A scorecard supports comparison but does not trigger an autonomous candidate rejection."><form onSubmit={submitFeedback} className="grid gap-3 md:grid-cols-2"><div><Label>Interview</Label><select name="interviewId" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{feedbackReady.map(item => <option value={item.id} key={item.id}>Interview {item.id.slice(-5)} · {friendly(item.status)}</option>)}</select></div><div><Label>Feedback author</Label><Input name="authorName" required placeholder="Interviewer name" /></div><div><Label>Technical score (1–5)</Label><Input name="technicalScore" type="number" min="1" max="5" /></div><div><Label>Communication score (1–5)</Label><Input name="communicationScore" type="number" min="1" max="5" /></div><div className="md:col-span-2"><Label>Job-relevant evidence (one per line)</Label><Textarea name="roleEvidence" placeholder="Explained the API trade-off with evidence\nDemonstrated ownership in incident response" /></div><div className="md:col-span-2"><Label>Raw feedback</Label><Textarea name="rawFeedback" required placeholder="Capture unedited interview feedback and follow-up observations." /></div><div className="md:col-span-2 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowFeedback(false)}>Cancel</Button><Button type="submit" disabled={recordFeedback.isPending} className="bg-[#10213d]">Save scorecard</Button></div></form></FormCard>}
    <Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={CalendarClock} title="Interview timeline" detail="Complete an interview before feedback is requested. Recording is always a separate consent flow." /><div className="mt-5 space-y-3">{isLoading ? <p className="py-8 text-sm text-slate-500">Loading interviews…</p> : list.length === 0 ? <Empty title="No interview events" detail="Interview reminders and feedback SLA tracking will appear after you schedule a qualified candidate." icon={CalendarClock} /> : list.map(item => <div className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-100 p-4 sm:flex-row sm:items-center" key={item.id}><div><div className="flex items-center gap-2"><p className="font-semibold text-[#10213d]">Interview {item.id.slice(-5)}</p><StateBadge value={item.status} /></div><p className="mt-1 text-sm text-slate-500">{dateTime(item.scheduledAt)} · {item.timezone} · {item.durationMinutes} min</p></div><div className="flex flex-wrap gap-2">{item.status === "scheduled" && <><Button size="sm" onClick={() => transition.mutate({ id: item.id, state: "confirmed" })} className="bg-[#10213d]">Confirm</Button><Button size="sm" variant="outline" onClick={() => promptReschedule(item)}><RefreshCcw className="mr-1 h-3.5 w-3.5" />Reschedule</Button></>}{item.status === "reschedule_requested" && <Button size="sm" variant="outline" onClick={() => promptReschedule(item)}><RefreshCcw className="mr-1 h-3.5 w-3.5" />Set new time</Button>}{item.status === "confirmed" && <Button size="sm" variant="outline" onClick={() => transition.mutate({ id: item.id, state: "reminder_sent" })}>Mark reminder sent</Button>}{["confirmed", "reminder_sent"].includes(item.status) && <Button size="sm" variant="outline" onClick={() => setReminder.mutate({ id: item.id, reminderAt: item.reminderAt ? null : new Date(new Date(item.scheduledAt ?? Date.now()).getTime() - 24 * 60 * 60 * 1000) })}>{item.reminderAt ? "Disable reminder" : "Set 24h reminder"}</Button>}{["confirmed", "reminder_sent"].includes(item.status) && <Button size="sm" variant="outline" onClick={() => transition.mutate({ id: item.id, state: "completed" })}>Mark completed</Button>}{item.status === "completed" && <Button size="sm" variant="outline" onClick={() => transition.mutate({ id: item.id, state: "feedback_pending" })}>Request feedback</Button>}{!["completed", "closed", "cancelled"].includes(item.status) && <Button size="sm" variant="outline" onClick={() => downloadIcs(item.id)}><Download className="mr-1 h-3.5 w-3.5" />ICS</Button>}{!["completed", "closed", "cancelled"].includes(item.status) && <Button size="sm" variant="outline" onClick={() => { if (window.confirm("Cancel this interview and its reminder?")) cancelInterview.mutate({ id: item.id }); }}><X className="mr-1 h-3.5 w-3.5" />Cancel</Button>}</div></div>)}</div></CardContent></Card>
  </PageShell>;
}

export function PlacementsPage() {
  const utils = trpc.useUtils();
  const { data: list = [], isLoading } = trpc.recruitment.placements.list.useQuery({ limit: 100 });
  const { data: candidatesList = [] } = trpc.recruitment.candidates.list.useQuery({ limit: 100 });
  const { data: jobsList = [] } = trpc.recruitment.jobs.list.useQuery({ limit: 100 });
  const create = trpc.recruitment.placements.create.useMutation({ onSuccess: () => { utils.recruitment.placements.list.invalidate(); toast.success("Placement record opened at offer-pending stage."); } });
  const transition = trpc.recruitment.placements.transition.useMutation({ onSuccess: data => { utils.recruitment.placements.list.invalidate(); toast.success(data.approvalRequired ? "Owner placement approval is ready." : "Placement status updated."); } });
  const replacement = trpc.recruitment.consequential.requestReplacement.useMutation({ onSuccess: () => toast.success("Replacement case is awaiting owner approval.") });
  const [showForm, setShowForm] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const f = new FormData(event.currentTarget); const job = jobsList.find(item => item.id === String(f.get("jobId"))); if (!job) return; create.mutate({ candidateId: String(f.get("candidateId")), jobId: job.id, companyId: job.companyId, annualCompensation: f.get("comp") ? Number(f.get("comp")) : undefined }); event.currentTarget.reset(); setShowForm(false); };
  return <PageShell eyebrow="Placement control" title="Offers, joining & guarantee" description="Track every milestone from offer issuance to join confirmation, invoice eligibility, guarantee, and replacement cases." action={<Button disabled={!candidatesList.length || !jobsList.length} onClick={() => setShowForm(v => !v)} className="bg-[#10213d]"><Plus className="mr-2 h-4 w-4" />Open placement</Button>}>
    {showForm && <FormCard title="Open a placement record" detail="Placement starts at offer pending. Joining evidence is required before an invoice can be drafted."><form onSubmit={submit} className="grid gap-3 md:grid-cols-2"><div><Label>Candidate</Label><select name="candidateId" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{candidatesList.map(c => <option key={c.id} value={c.id}>{c.fullName}</option>)}</select></div><div><Label>Job</Label><select name="jobId" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{jobsList.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}</select></div><div><Label>Annual compensation</Label><Input name="comp" type="number" min="0" placeholder="e.g. 1800000" /></div><div className="flex items-end justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button><Button type="submit" className="bg-[#10213d]">Create placement</Button></div></form></FormCard>}
    <Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={ShieldAlert} title="Guarantee ledger" detail="Consequential joining confirmation creates an owner approval. This protects invoice and replacement workflows." /><div className="mt-5 space-y-3">{isLoading ? <p className="py-8 text-sm text-slate-500">Loading placements…</p> : list.length === 0 ? <Empty title="No placement records" detail="Open a record after a candidate enters offer stage. Every subsequent milestone will be audited." icon={ShieldAlert} /> : list.map(item => <div className="rounded-2xl border border-slate-100 p-4 sm:p-5" key={item.id}><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><div className="flex items-center gap-2"><p className="font-semibold text-[#10213d]">Placement {item.id.slice(-6)}</p><StateBadge value={item.status} /></div><p className="mt-1 text-xs text-slate-500">Annual comp: {item.annualCompensation ? `₹${item.annualCompensation.toLocaleString("en-IN")}` : "not recorded"} · Guarantee ends {dateOnly(item.guaranteeEndAt)}</p></div><div className="flex flex-wrap gap-2">{item.status === "offer_pending" && <Button size="sm" variant="outline" onClick={() => transition.mutate({ id: item.id, state: "offer_issued" })}>Offer issued</Button>}{item.status === "offer_issued" && <Button size="sm" variant="outline" onClick={() => transition.mutate({ id: item.id, state: "offer_accepted" })}>Offer accepted</Button>}{item.status === "offer_accepted" && <Button size="sm" onClick={() => transition.mutate({ id: item.id, state: "joining_pending" })} className="bg-[#10213d]">Joining pending</Button>}{item.status === "joining_pending" && <Button size="sm" className="bg-[#10213d]" onClick={() => transition.mutate({ id: item.id, state: "joining_confirmed", joiningEvidence: ["Owner-recorded joining confirmation"] })}>Confirm joining</Button>}{["guarantee_active", "replacement_requested"].includes(item.status) && <Button size="sm" variant="outline" onClick={() => replacement.mutate({ placementId: item.id, reason: "Owner-requested replacement review" })}>Request replacement</Button>}</div></div></div>)}</div></CardContent></Card>
  </PageShell>;
}

export function FinancePage() {
  const utils = trpc.useUtils();
  const { data: list = [], isLoading } = trpc.recruitment.invoices.list.useQuery({ limit: 100 });
  const { data: placementsList = [] } = trpc.recruitment.placements.list.useQuery({ limit: 100 });
  const create = trpc.recruitment.invoices.draft.useMutation({ onSuccess: () => { utils.recruitment.invoices.list.invalidate(); toast.success("Invoice draft created. Issue remains approval-controlled."); } });
  const issue = trpc.recruitment.invoices.requestIssueApproval.useMutation({ onSuccess: () => toast.success("Invoice issue approval requested.") });
  const revenueAction = trpc.recruitment.consequential.requestInvoiceAction.useMutation({ onSuccess: () => toast.success("Revenue action is awaiting owner approval.") });
  const [showForm, setShowForm] = useState(false);
  const eligible = placementsList.filter(item => ["invoice_eligible", "guarantee_active"].includes(item.status));
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const f = new FormData(event.currentTarget); const placement = placementsList.find(item => item.id === String(f.get("placementId"))); if (!placement) return; create.mutate({ placementId: placement.id, companyId: placement.companyId, invoiceNumber: String(f.get("invoiceNumber")), amount: Number(f.get("amount")), taxAmount: Number(f.get("tax") || 0), dueAt: f.get("dueAt") ? new Date(String(f.get("dueAt"))) : undefined }); event.currentTarget.reset(); setShowForm(false); };
  return <PageShell eyebrow="Revenue operations" title="Invoices & payment status" description="Issue fees from placement evidence, track settlement, and route every dispute or credit decision through owner control." action={<Button disabled={!eligible.length} onClick={() => setShowForm(v => !v)} className="bg-[#10213d]"><Plus className="mr-2 h-4 w-4" />Draft invoice</Button>}>
    {!eligible.length && <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">No invoice-eligible placements are available. Confirm joining, approve the placement, and set invoice eligibility before drafting an invoice.</div>}
    {showForm && <FormCard title="Evidence-linked invoice draft" detail="Tax treatment and final invoice issue are owner-controlled. Use a reviewed tax configuration before client delivery."><form onSubmit={submit} className="grid gap-3 md:grid-cols-2"><div><Label>Placement</Label><select name="placementId" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{eligible.map(p => <option key={p.id} value={p.id}>{p.id.slice(-6)} · {p.status}</option>)}</select></div><div><Label>Invoice number</Label><Input name="invoiceNumber" required placeholder="FH-2026-0001" /></div><div><Label>Fee amount</Label><Input name="amount" type="number" min="1" required /></div><div><Label>Tax amount</Label><Input name="tax" type="number" min="0" defaultValue="0" /></div><div><Label>Due date</Label><Input name="dueAt" type="date" /></div><div className="flex items-end justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button><Button type="submit" className="bg-[#10213d]">Save draft</Button></div></form></FormCard>}
    <Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={CircleDollarSign} title="Receivables ledger" detail="Invoices are not issued until the owner approves them; disputed records remain visibly separated." /><div className="mt-5 overflow-x-auto">{isLoading ? <p className="py-8 text-sm text-slate-500">Loading invoices…</p> : list.length === 0 ? <Empty title="No invoices issued" detail="Once a placement is eligible, draft an evidence-linked invoice and request owner approval before delivery." icon={CircleDollarSign} /> : <table className="w-full min-w-[800px] text-left"><thead className="border-b border-slate-100 text-[11px] uppercase tracking-[0.1em] text-slate-400"><tr><th className="pb-3">Invoice</th><th className="pb-3">Amount</th><th className="pb-3">Due</th><th className="pb-3">Status</th><th className="pb-3">Control</th></tr></thead><tbody className="divide-y divide-slate-100">{list.map(invoice => <tr key={invoice.id}><td className="py-4 font-semibold text-[#10213d]">{invoice.invoiceNumber}</td><td className="py-4 text-sm text-slate-600">₹{invoice.amount.toLocaleString("en-IN")}</td><td className="py-4 text-sm text-slate-500">{dateOnly(invoice.dueAt)}</td><td className="py-4"><StateBadge value={invoice.status} /></td><td className="py-4"><div className="flex flex-wrap gap-2">{["draft", "validation", "approval_pending"].includes(invoice.status) && <Button size="sm" onClick={() => issue.mutate({ id: invoice.id })} className="bg-[#10213d]">Request issue approval</Button>}{["issued", "delivered", "payment_pending", "partially_paid", "overdue"].includes(invoice.status) && <Button size="sm" variant="outline" onClick={() => revenueAction.mutate({ invoiceId: invoice.id, action: "payment_status", status: "paid", evidence: "Owner-recorded payment evidence" })}>Mark paid (approve)</Button>}{["issued", "delivered", "payment_pending", "partially_paid", "overdue"].includes(invoice.status) && <Button size="sm" variant="outline" onClick={() => revenueAction.mutate({ invoiceId: invoice.id, action: "dispute", evidence: "Owner-recorded dispute evidence" })}>Open dispute</Button>}{invoice.status === "disputed" && <Button size="sm" variant="outline" onClick={() => revenueAction.mutate({ invoiceId: invoice.id, action: "credit", evidence: "Owner-recorded credit rationale" })}>Request credit</Button>}</div></td></tr>)}</tbody></table>}</div></CardContent></Card>
  </PageShell>;
}

export function ExceptionsPage() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.operations.exceptions.list.useQuery({ limit: 100 });
  const { data: allApprovals = [] } = trpc.operations.approvals.list.useQuery({ limit: 50 });
  const decide = trpc.recruitment.approvals.decide.useMutation({
    onSuccess: () => {
      utils.operations.exceptions.list.invalidate();
      utils.operations.approvals.list.invalidate();
      toast.success("Owner decision recorded in audit trail.");
    },
  });
  const retry = trpc.operations.queue.retry.useMutation({
    onSuccess: () => {
      utils.operations.exceptions.list.invalidate();
      toast.success("Automation job returned to the queue.");
    },
  });
  return <PageShell eyebrow="Operational safety" title="Exception center" description="Resolve approval decisions, blocked automation, data-rights requests, and incidents before they become silent operational risk.">
    {isLoading || !data ? <p className="py-10 text-sm text-slate-500">Loading controlled exceptions…</p> : <>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="border-slate-200 bg-white">
          <CardContent className="p-5">
            <SectionTitle icon={Gavel} title="Owner approvals" detail="Consequential actions are held here until you approve or reject them." />
            <div className="mt-5 space-y-3">
              {data.pendingApprovals.length === 0 ? (
                <Empty title="No pending approvals" detail="The platform will hold consequential client, candidate, placement, and invoice actions here." icon={BadgeCheck} />
              ) : (
                data.pendingApprovals.map(item => (
                  <div className="rounded-2xl border border-[#f5d77b] bg-[#fffdf7] p-4" key={item.id}>
                    <div className="flex justify-between gap-3">
                      <div>
                        <p className="font-semibold text-[#10213d]">{friendly(item.actionType)}</p>
                        <p className="mt-1 text-xs text-slate-500">{item.resourceType} · {item.reason}</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <DecisionSourceBadge source={item.decisionSource} />
                        <StateBadge value={item.status} />
                      </div>
                    </div>
                    <div className="mt-4 flex gap-2">
                      <Button size="sm" className="bg-[#10213d]" onClick={() => decide.mutate({ id: item.id, decision: "approved" })}><Check className="mr-1 h-3.5 w-3.5" />Approve</Button>
                      <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: item.id, decision: "rejected" })}><X className="mr-1 h-3.5 w-3.5" />Reject</Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="border-slate-200 bg-white">
          <CardContent className="p-5">
            <SectionTitle icon={AlertTriangle} title="Automation & incident failures" detail="Retries remain explicit; the queue never repeats a side effect without an idempotency key." />
            <div className="mt-5 space-y-3">
              {data.queueFailures.length === 0 && data.openIncidents.length === 0 ? (
                <Empty title="No open queue failures" detail="Queue stalls, policy blocks, provider errors, and incidents become visible here." icon={CheckCircle2} />
              ) : (
                <>
                  {data.queueFailures.map(item => (
                    <div className="rounded-2xl border border-slate-100 p-4" key={item.id}>
                      <div className="flex justify-between gap-3">
                        <div>
                          <p className="font-semibold text-[#10213d]">{friendly(item.jobType)}</p>
                          <p className="mt-1 text-xs text-slate-500">{item.lastError || "Awaiting owner review"}</p>
                        </div>
                        <StateBadge value={item.status} />
                      </div>
                      <Button size="sm" variant="outline" className="mt-3" onClick={() => retry.mutate({ id: item.id })}><RefreshCcw className="mr-1 h-3.5 w-3.5" />Retry safely</Button>
                    </div>
                  ))}
                  {data.openIncidents.map(item => (
                    <div className="rounded-2xl border border-rose-100 bg-rose-50 p-4" key={item.id}>
                      <div className="flex justify-between gap-3">
                        <div>
                          <p className="font-semibold text-[#8f3021]">{friendly(item.incidentType)}</p>
                          <p className="mt-1 text-xs text-rose-700">{item.summary}</p>
                        </div>
                        <StateBadge value={item.severity} />
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6 border-slate-200 bg-white">
        <CardContent className="p-5">
          <SectionTitle
            icon={Gavel}
            title="Approvals audit & decision log"
            detail="Audit recent consequential approvals. Spot-check whether decisions were automatic via workspace policy or manual owner interventions."
          />
          <div className="mt-5 overflow-x-auto">
            {allApprovals.length === 0 ? (
              <Empty
                title="No approval history recorded"
                detail="Consequential actions and policy-decided approvals will be logged here for audit and spot-checking."
                icon={BadgeCheck}
              />
            ) : (
              <table className="w-full min-w-[760px] text-left">
                <thead className="border-b border-slate-100 text-[11px] uppercase tracking-[0.1em] text-slate-400">
                  <tr>
                    <th className="pb-3">Action</th>
                    <th className="pb-3">Resource</th>
                    <th className="pb-3">Decision source</th>
                    <th className="pb-3">Status</th>
                    <th className="pb-3">Reason</th>
                    <th className="pb-3">Decided / Requested</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {allApprovals.map((approval) => (
                    <tr key={approval.id} className="hover:bg-slate-50/50">
                      <td className="py-3 font-semibold text-[#10213d]">{friendly(approval.actionType)}</td>
                      <td className="py-3 text-slate-600">
                        <span className="font-mono text-[11px]">{approval.resourceType}</span>
                        <span className="ml-1 font-mono text-slate-400">({approval.resourceId.slice(-6)})</span>
                      </td>
                      <td className="py-3">
                        <DecisionSourceBadge source={approval.decisionSource} />
                      </td>
                      <td className="py-3">
                        <StateBadge value={approval.status} />
                      </td>
                      <td className="max-w-[280px] py-3 text-slate-500 truncate" title={approval.reason}>
                        {approval.reason}
                      </td>
                      <td className="py-3 text-slate-400 whitespace-nowrap">
                        {dateTime(approval.decidedAt || approval.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>
    </>}
  </PageShell>;
}

export function ControlPlanePage() {
  const utils = trpc.useUtils();
  const { data: settings } = trpc.operations.settings.get.useQuery();
  const { data: queue = [] } = trpc.operations.queue.list.useQuery({ limit: 10 });
  const { data: audits = [] } = trpc.operations.audits.list.useQuery({ limit: 15 });
  const { data: policies = [] } = trpc.operations.policies.list.useQuery();
  const { data: mailApiStatus } = trpc.email.status.useQuery();
  const { data: readiness } = trpc.operations.settings.readiness.useQuery();
  const { data: emailIdentities = [] } = trpc.email.identities.list.useQuery();
  const update = trpc.operations.settings.update.useMutation({ onSuccess: () => { utils.operations.settings.get.invalidate(); toast.success("Control settings saved."); } });
  const stop = trpc.operations.settings.setEmergencyStop.useMutation({ onSuccess: () => { utils.operations.settings.get.invalidate(); toast.success("Automation safety state updated."); } });
  const createPolicy = trpc.operations.policies.create.useMutation({ onSuccess: () => { utils.operations.policies.list.invalidate(); } });
  const activatePolicy = trpc.operations.policies.activate.useMutation({ onSuccess: () => { utils.operations.policies.list.invalidate(); } });
  const runNext = trpc.operations.queue.runNext.useMutation({ onSuccess: data => toast.success(data.status === "completed" ? "One controlled automation job completed." : data.status === "empty" ? "No queued automation jobs." : "Automation stopped safely: " + ("reason" in data ? data.reason : data.status)) });
  const cancelJob = trpc.operations.queue.cancel.useMutation({
    onSuccess: () => {
      utils.operations.settings.get.invalidate();
      utils.recruitment.approvals.list.invalidate();
      toast.success("Queued job cancelled.");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to cancel job.");
    },
  });
  const saveEmailIdentity = trpc.email.identities.save.useMutation({ onSuccess: () => { utils.email.identities.list.invalidate(); toast.success("Sender identity registered as unverified."); } });
  const verifyEmailIdentity = trpc.email.identities.verify.useMutation({ onSuccess: result => { utils.email.identities.list.invalidate(); result.ok ? toast.success("Hostinger Mail API verified and sender activated.") : toast.error(`Sender remains inactive: ${result.status.replaceAll("_", " ")}`); } });

  const [showPolicyForm, setShowPolicyForm] = useState(false);
  const [policyName, setPolicyName] = useState("");
  const [policyJson, setPolicyJson] = useState("");
  const [inspectedPolicyId, setInspectedPolicyId] = useState<string | null>(null);

  const defaultPolicyTemplate = JSON.stringify({
    aiDailyLimit: 45,
    outboundRequiresOwnerApproval: true,
    candidateSharingRequiresConsent: true,
    noAutonomousFinalRejection: true,
    delayedActions: {
      invoice_issue: 15,
      candidate_share: 10
    },
    autoApprovalRules: [
      {
        id: "rule_prospect_onboarding",
        name: "Auto-approve prospect onboarding (confidence >= 50)",
        actionType: "client_onboarding",
        conditions: [
          { field: "confidence", op: "gte", value: 50 }
        ]
      },
      {
        id: "rule_invoice_issue_small",
        name: "Auto-approve invoice issue under 100,000",
        actionType: "invoice_issue",
        conditions: [
          { field: "amount", op: "lte", value: 100000 }
        ]
      }
    ]
  }, null, 2);

  const openNewPolicyForm = () => {
    setPolicyName(`Operations policy v${policies.length + 1}`);
    setPolicyJson(defaultPolicyTemplate);
    setShowPolicyForm(true);
  };

  const handleSavePolicy = async (activateImmediately: boolean) => {
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(policyJson);
    } catch {
      toast.error("Invalid JSON format in policy configuration.");
      return;
    }
    const name = policyName.trim() || `Operations policy v${policies.length + 1}`;
    try {
      const created = await createPolicy.mutateAsync({ name, content });
      if (activateImmediately) {
        await activatePolicy.mutateAsync({ id: created.id });
        toast.success("Policy version created and activated with auto-approval rules.");
      } else {
        toast.success("Policy version saved as draft.");
      }
      setShowPolicyForm(false);
      setPolicyName("");
      setPolicyJson("");
    } catch (err: any) {
      toast.error(err?.message || "Failed to save policy version.");
    }
  };

  if (!settings) return <div className="py-10 text-sm text-slate-500">Loading control plane…</div>;
  return <PageShell eyebrow="Automation governance" title="Control plane & audit trail" description="Configure safe automation boundaries, monitor queued jobs, and retain a complete record of consequential workflow changes.">
    <div className="grid gap-6 xl:grid-cols-[0.78fr_1.22fr]"><div className="space-y-6"><Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={SlidersHorizontal} title="Operating boundaries" detail="Start in safe mode; enable controlled autopilot only after your policy, consent, and deliverability checks pass." /><div className="mt-5 space-y-4"><div><Label>Automation mode</Label><select value={settings.automationMode} onChange={event => update.mutate({ automationMode: event.target.value as "safe" | "controlled" | "autopilot" })} className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="safe">Safe — AI drafts, owner decides</option><option value="controlled">Controlled — routine actions within policy</option><option value="autopilot">Autopilot — restricted routine automation</option></select></div><div><Label>Daily outbound cap</Label><Input className="mt-2" type="number" min="1" max="500" value={settings.dailyOutboundLimit} onChange={event => update.mutate({ dailyOutboundLimit: Number(event.target.value) })} /></div><div><Label>Business timezone</Label><Input className="mt-2" value={settings.businessTimezone} onChange={event => update.mutate({ businessTimezone: event.target.value })} /></div><div className={`flex items-center justify-between rounded-2xl p-4 ${settings.emergencyStop ? "bg-rose-50" : "bg-[#f7f5f0]"}`}><div><p className="text-sm font-semibold text-[#10213d]">Emergency stop</p><p className="mt-1 text-xs leading-5 text-slate-500">Immediately blocks outbound and external automation actions.</p></div><Switch checked={settings.emergencyStop} onCheckedChange={enabled => stop.mutate({ enabled, reason: enabled ? "Owner activated emergency stop" : "Owner resumed controlled automation" })} /></div></div></CardContent></Card>
      <Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={BrainCircuit} title="OpenRouter readiness" detail="The backend keeps all API keys server-side and records selected model, errors, quota state, and validated result." /><div className="mt-4 rounded-2xl bg-[#10213d] p-4 text-white"><div className="flex items-center gap-2 text-sm font-semibold"><LockKeyhole className="h-4 w-4 text-[#f5d77b]" />Structured-output policy</div><p className="mt-2 text-xs leading-5 text-slate-300">Invalid JSON, low-confidence results, quota errors, and provider failures route to queue retry or owner review. They never trigger an unvalidated client-facing action.</p></div></CardContent></Card><Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={CheckCircle2} title="Platform readiness" detail="A non-secret view of what is ready locally and what still depends on deployment configuration." /><div className="mt-4 grid gap-2 sm:grid-cols-2">{readiness ? <><div className="rounded-xl bg-[#f7f5f0] p-3"><p className="text-xs font-semibold text-[#10213d]">Authentication</p><StateBadge value={readiness.runtime.oidcConfigured ? "ready" : "configuration needed"} /><p className="mt-1 text-[11px] text-slate-500">{readiness.runtime.oidcConfigured ? "OIDC boundary configured" : "Development login remains available"}</p></div><div className="rounded-xl bg-[#f7f5f0] p-3"><p className="text-xs font-semibold text-[#10213d]">Private documents</p><StateBadge value={readiness.runtime.privateStorage.configured ? readiness.runtime.privateStorage.mode : "configuration needed"} /><p className="mt-1 text-[11px] text-slate-500">Local storage is allowed before optional S3 backup.</p></div><div className="rounded-xl bg-[#f7f5f0] p-3"><p className="text-xs font-semibold text-[#10213d]">Mail operations</p><StateBadge value={readiness.mail.configured && readiness.mail.configuredMailboxCount === 6 ? "ready" : "configuration needed"} /><p className="mt-1 text-[11px] text-slate-500">{readiness.mail.configuredSenderAddressCount}/6 sender identities configured · webhook {readiness.mail.webhookSecretConfigured ? "ready" : "pending"}</p></div><div className="rounded-xl bg-[#f7f5f0] p-3"><p className="text-xs font-semibold text-[#10213d]">Controlled automation</p><StateBadge value="owner approval" /><p className="mt-1 text-[11px] text-slate-500">ICS calendar, structured AI, and no autonomous final rejection.</p></div></> : <p className="text-xs text-slate-500">Loading readiness status…</p>}</div></CardContent></Card></div>
      <div className="space-y-6"><Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={Clock3} title="Automation queue" detail="Idempotent work items remain visible with their processing status." /><div className="mt-5 space-y-3">{queue.length === 0 ? <Empty title="No queued work" detail="AI classification, draft outreach, CV parsing, matching, reminders, and reconciliation appear here after they are safely enqueued." icon={BrainCircuit} /> : queue.map(item => <div className="flex items-center justify-between gap-4 rounded-2xl border border-slate-100 p-4" key={item.id}><div><p className="text-sm font-semibold text-[#10213d]">{friendly(item.jobType)}</p><p className="mt-1 text-xs text-slate-500">Attempts {item.attempts}/{item.maxAttempts} · scheduled {dateTime(item.scheduledAt)}</p></div><div className="flex items-center gap-2"><StateBadge value={item.status} />{item.status === "queued" && <Button size="sm" variant="outline" className="h-7 text-xs border-rose-200 text-rose-700 hover:bg-rose-50" disabled={cancelJob.isPending} onClick={() => cancelJob.mutate({ id: item.id })}>Cancel</Button>}</div></div>)}</div></CardContent></Card>
      <Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={ShieldAlert} title="Policy versions & auto-approvals" detail="Policies control AI operating boundaries and automated approval rules. Activate only a reviewed version." action={<Button size="sm" variant="outline" onClick={() => showPolicyForm ? setShowPolicyForm(false) : openNewPolicyForm()}><Plus className="mr-1.5 h-3.5 w-3.5" />{showPolicyForm ? "Cancel" : "Define policy & rules"}</Button>} />
        {showPolicyForm && (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-[#fcfbf8] p-4 text-xs space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-[#10213d]">Define Auto-Approval Policy</p>
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setPolicyJson(defaultPolicyTemplate)}>Reset to template</Button>
              </div>
            </div>
            <div>
              <Label className="text-[11px]">Policy Name</Label>
              <Input className="mt-1 h-8 text-xs bg-white" value={policyName} onChange={e => setPolicyName(e.target.value)} placeholder="e.g. Operations auto-approval policy" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-[11px]">Policy & Auto-Approval Rules (JSON)</Label>
                <span className="text-[10px] text-slate-400">Contains autoApprovalRules array with actionType & conditions</span>
              </div>
              <Textarea className="h-44 font-mono text-[11px] bg-white leading-relaxed" value={policyJson} onChange={e => setPolicyJson(e.target.value)} />
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={() => setShowPolicyForm(false)}>Cancel</Button>
              <Button size="sm" variant="outline" disabled={createPolicy.isPending} onClick={() => handleSavePolicy(false)}>Save Draft</Button>
              <Button size="sm" className="bg-[#10213d]" disabled={createPolicy.isPending || activatePolicy.isPending} onClick={() => handleSavePolicy(true)}>Save & Activate</Button>
            </div>
          </div>
        )}
        <div className="mt-4 space-y-2">{policies.length === 0 ? <p className="text-xs text-slate-500">No policy version saved yet. Create a controlled baseline before leaving safe mode.</p> : policies.slice(0, 5).map(policy => {
          const ruleCount = Array.isArray((policy.content as any)?.autoApprovalRules) ? (policy.content as any).autoApprovalRules.length : 0;
          return <div key={policy.id} className="rounded-xl bg-[#f7f5f0] px-3 py-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-[#10213d]">v{policy.version} · {policy.name}</span>
                {ruleCount > 0 && <span className="rounded bg-[#e0ecff] px-1.5 py-0.5 text-[10px] font-medium text-[#1c3d73]">{ruleCount} auto-rule{ruleCount === 1 ? "" : "s"}</span>}
              </div>
              <div className="flex items-center gap-2">
                <StateBadge value={policy.status} />
                <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setInspectedPolicyId(inspectedPolicyId === policy.id ? null : policy.id)}>{inspectedPolicyId === policy.id ? "Hide rules" : "View rules"}</Button>
                {policy.status !== "active" && <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => activatePolicy.mutate({ id: policy.id })}>Activate</Button>}
              </div>
            </div>
            {inspectedPolicyId === policy.id && (
              <pre className="mt-2 max-h-36 overflow-auto rounded-lg bg-white p-2 text-[10px] font-mono text-slate-700 border border-slate-200">
                {JSON.stringify(policy.content, null, 2)}
              </pre>
            )}
          </div>;
        })}</div><Button className="mt-4 w-full bg-[#10213d]" disabled={runNext.isPending || settings.emergencyStop} onClick={() => runNext.mutate()}>Process next controlled job</Button></CardContent></Card>
      <Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={Mail} title="Domain sender identities" detail={mailApiStatus?.configured ? "Hostinger Mail API is configured; activate only verified mailboxes." : "Hostinger Mail API is not yet configured. You can register identities now, but live sending remains disabled."} /><div className="mt-4 grid gap-2 sm:grid-cols-2">{(["clients", "talent", "interviews", "finance", "privacy", "owner"] as const).map(purpose => { const address = mailboxAddresses[purpose]; const identity = emailIdentities.find(item => item.email === address); return <div className="flex items-center justify-between rounded-xl bg-[#f7f5f0] px-3 py-2" key={purpose}><div><p className="text-xs font-semibold text-[#10213d]">{address}</p><p className="text-[11px] text-slate-500">{identity ? `${friendly(identity.status)} · ${friendly(identity.lastHealthStatus)}` : "not registered"}</p></div>{identity ? <Button size="sm" variant="ghost" disabled={verifyEmailIdentity.isPending} onClick={() => verifyEmailIdentity.mutate({ id: identity.id })}>Verify</Button> : <Button size="sm" variant="ghost" onClick={() => saveEmailIdentity.mutate({ email: address, purpose, displayName: "FreelanceHR", replyTo: mailboxAddresses.owner })}>Register</Button>}</div>; })}</div></CardContent></Card>
        <Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={FileCheck2} title="Immutable audit history" detail="Every state change, approval, consent event, and operational decision leaves an evidence record." /><div className="mt-5 divide-y divide-slate-100">{audits.length === 0 ? <Empty title="Audit trail will grow automatically" detail="Start working through the pipelines and each controlled state change will appear here." icon={FileCheck2} /> : audits.map(item => <div className="flex items-center justify-between gap-4 py-3" key={item.id}><div><p className="text-sm font-medium text-[#10213d]">{item.action.replaceAll(".", " · ")}</p><p className="mt-1 text-xs text-slate-500">{item.resourceType} · {dateTime(item.createdAt)}</p></div><StateBadge value={item.actorType} /></div>)}</div></CardContent></Card></div>
    </div>
  </PageShell>;
}

function OwnerTeamPage() {
  const utils = trpc.useUtils();
  const { data: overview, isLoading, error } = trpc.team.overview.useQuery();
  const { data: activity = [] } = trpc.team.activity.useQuery({ limit: 30 }, { enabled: Boolean(overview) });
  const invite = trpc.team.invite.useMutation({
    onSuccess: result => {
      utils.team.overview.invalidate();
      utils.team.activity.invalidate();
      setIssuedInvite(result);
      toast.success("Invitation record created. Share the one-time code only through a secure channel.");
    },
  });
  const updateRole = trpc.team.updateRole.useMutation({ onSuccess: () => { utils.team.overview.invalidate(); utils.team.activity.invalidate(); toast.success("Team role updated with an audit record."); } });
  const revoke = trpc.team.revoke.useMutation({ onSuccess: () => { utils.team.overview.invalidate(); utils.team.activity.invalidate(); toast.success("Member access and pending invitations have been revoked."); } });
  const [issuedInvite, setIssuedInvite] = useState<any | null>(null);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    invite.mutate({
      email: String(form.get("email")),
      displayName: String(form.get("displayName")).trim() || undefined,
      role: String(form.get("role")) as "recruiter" | "coordinator" | "finance" | "viewer",
      expiresInHours: Number(form.get("expiresInHours") || 168),
    });
    event.currentTarget.reset();
    setShowInviteForm(false);
  };
  const copyCode = async () => {
    if (!issuedInvite) return;
    try { await navigator.clipboard.writeText(issuedInvite.invitationCode); toast.success("Invitation code copied. It is not retained after this view is dismissed."); }
    catch { toast.error("Copy is unavailable in this browser. Select the code manually and share it securely."); }
  };

  if (isLoading) return <div className="py-10 text-sm text-slate-500">Loading team access controls…</div>;
  if (error || !overview) return <PageShell eyebrow="Workspace security" title="Team & access" description="This area is available only to the workspace owner. Team members cannot administer membership, approvals, policies, or sending controls."><Empty title="Owner access required" detail="Sign in with the primary workspace owner account to manage team invitations and roles." icon={LockKeyhole} /></PageShell>;

  return <PageShell eyebrow="Workspace security" title="Team & access" description="Create traceable, least-privilege team memberships. Consequential approvals, final candidate decisions, client sharing, email sends, and policy controls remain owner-only." action={<Button onClick={() => setShowInviteForm(value => !value)} className="bg-[#10213d] hover:bg-[#1a3156]"><Plus className="mr-2 h-4 w-4" />Invite team member</Button>}>
    <div className="grid gap-4 md:grid-cols-3"><Card className="border-slate-200 bg-white"><CardContent className="p-5"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#a47d2c]">Active memberships</p><p className="mt-3 text-3xl font-semibold text-[#10213d]">{overview.activeMemberCount}</p><p className="mt-1 text-xs text-slate-500">Activated team accounts</p></CardContent></Card><Card className="border-slate-200 bg-white"><CardContent className="p-5"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#a47d2c]">Pending invitations</p><p className="mt-3 text-3xl font-semibold text-[#10213d]">{overview.pendingInvitations.length}</p><p className="mt-1 text-xs text-slate-500">Automatically marked expired after the deadline</p></CardContent></Card><Card className="border-[#f5d77b] bg-[#fffaf0]"><CardContent className="p-5"><div className="flex items-center gap-2 text-sm font-semibold text-[#10213d]"><Mail className="h-4 w-4 text-[#a47d2c]" />Invite delivery</div><p className="mt-3 text-xs leading-5 text-slate-600">Live invitation email is intentionally disabled until the Hostinger Mail API is activated. Share the one-time code manually through an approved secure channel.</p></CardContent></Card></div>

    {showInviteForm && <FormCard title="Create an auditable team invitation" detail="The invitation contains a one-time activation code. No email is sent automatically, and owner-only controls are never delegated."><form onSubmit={submit} className="grid gap-3 md:grid-cols-2"><div><Label>Team member name</Label><Input name="displayName" placeholder="Aman Sharma" /></div><div><Label>Work email</Label><Input name="email" type="email" required placeholder="aman@example.com" /></div><div><Label>Role</Label><select name="role" defaultValue="recruiter" className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="recruiter">Recruiter — prepares records and approval requests</option><option value="coordinator">Coordinator — interviews and operations</option><option value="finance">Finance — invoice evidence and approval requests</option><option value="viewer">Viewer — visibility only</option></select></div><div><Label>Expires in (hours)</Label><Input name="expiresInHours" type="number" min="12" max="720" defaultValue="168" /></div><div className="md:col-span-2 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowInviteForm(false)}>Cancel</Button><Button type="submit" disabled={invite.isPending} className="bg-[#10213d]">Create secure invitation</Button></div></form></FormCard>}

    {issuedInvite && <Card className="border-[#a47d2c]/40 bg-[#10213d] text-white"><CardContent className="p-5"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><div className="flex items-center gap-2 text-sm font-semibold text-[#f5d77b]"><LockKeyhole className="h-4 w-4" />One-time activation code</div><p className="mt-2 max-w-2xl text-xs leading-5 text-slate-300">Copy and share this code only via an approved secure channel. The stored record contains a hash, not the code itself. It expires {dateTime(issuedInvite.expiresAt)}.</p><code className="mt-4 block max-w-full overflow-x-auto rounded-lg bg-white/10 px-3 py-2 text-sm text-white">{issuedInvite.invitationCode}</code></div><div className="flex shrink-0 gap-2"><Button size="sm" variant="outline" className="border-white/25 text-white hover:bg-white/10 hover:text-white" onClick={copyCode}>Copy code</Button><Button size="sm" variant="ghost" className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => setIssuedInvite(null)}>Dismiss</Button></div></div></CardContent></Card>}

    <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]"><Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={UsersRound} title="Membership register" detail="Role changes and revocations are appended to the workspace audit trail. Revocation also invalidates all pending invitations for that member." /><div className="mt-5 overflow-x-auto">{overview.members.length === 0 ? <Empty title="No team members yet" detail="Create an invitation when you are ready to grant a limited operational role." icon={UsersRound} /> : <table className="w-full min-w-[760px] text-left"><thead className="border-b border-slate-100 text-[11px] uppercase tracking-[0.1em] text-slate-400"><tr><th className="pb-3">Member</th><th className="pb-3">Role</th><th className="pb-3">Status</th><th className="pb-3">Joined</th><th className="pb-3">Control</th></tr></thead><tbody className="divide-y divide-slate-100">{overview.members.map(member => <tr key={member.id}><td className="py-4"><p className="font-semibold text-[#10213d]">{member.displayName || "Pending team member"}</p><p className="mt-1 text-xs text-slate-500">{member.email}</p></td><td className="py-4">{member.role === "owner" ? <span className="text-xs font-semibold text-[#10213d]">Owner</span> : <select aria-label={`Role for ${member.email}`} value={member.role} disabled={member.status === "revoked" || updateRole.isPending} onChange={event => updateRole.mutate({ memberId: member.id, role: event.target.value as "recruiter" | "coordinator" | "finance" | "viewer" })} className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs"><option value="recruiter">Recruiter</option><option value="coordinator">Coordinator</option><option value="finance">Finance</option><option value="viewer">Viewer</option></select>}</td><td className="py-4"><StateBadge value={member.status} /></td><td className="py-4 text-xs text-slate-500">{dateTime(member.joinedAt)}</td><td className="py-4">{member.status !== "revoked" && member.role !== "owner" ? <Button size="sm" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate({ memberId: member.id, reason: "Owner revoked team workspace access" })}>Revoke</Button> : <span className="text-xs text-slate-400">—</span>}</td></tr>)}</tbody></table>}</div></CardContent></Card>
      <div className="space-y-6"><Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={ShieldAlert} title="Role boundaries" detail="Roles are designed for preparation and visibility. They cannot approve the actions that create employment, commercial, privacy, or external communication consequences." /><div className="mt-4 space-y-3">{Object.entries(overview.permissionSummary).map(([role, permissions]) => <div key={role} className="rounded-xl bg-[#f7f5f0] p-3"><p className="text-xs font-semibold capitalize text-[#10213d]">{role}</p><p className="mt-1 text-[11px] leading-5 text-slate-500">{permissions.join(" · ")}</p></div>)}</div></CardContent></Card><Card className="border-slate-200 bg-white"><CardContent className="p-5"><SectionTitle icon={FileCheck2} title="Team access audit" detail="Recent team invitation, role, activation, and revocation events." /><div className="mt-4 space-y-2">{activity.length === 0 ? <p className="text-xs text-slate-500">No team-access events have been recorded yet.</p> : activity.map(event => <div key={event.id} className="rounded-xl bg-[#f7f5f0] px-3 py-2"><p className="text-xs font-medium text-[#10213d]">{event.action.replaceAll(".", " · ")}</p><p className="mt-1 text-[11px] text-slate-500">{dateTime(event.createdAt)} · {event.resourceType}</p></div>)}</div></CardContent></Card></div>
    </div>
  </PageShell>;
}

function MemberTeamAccess() {
  const utils = trpc.useUtils();
  const { data: access, isLoading } = trpc.team.myAccess.useQuery();
  const accept = trpc.team.accept.useMutation({
    onSuccess: result => {
      try { sessionStorage.setItem("freelancehr-active-workspace", String(result.ownerId)); } catch { /* session storage is optional */ }
      utils.team.myAccess.invalidate();
      toast.success(`Workspace access activated as ${result.role}. Reloading your controlled workspace.`);
      window.setTimeout(() => window.location.reload(), 700);
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const code = String(new FormData(event.currentTarget).get("invitationCode") || ""); accept.mutate({ invitationCode: code }); };
  if (isLoading) return <div className="py-10 text-sm text-slate-500">Checking team workspace access…</div>;
  if (access) return <PageShell eyebrow="Workspace security" title="Team workspace activated" description={`You are assigned the ${access.role} role in a controlled FreelanceHR workspace. The server enforces your permitted routes; owner approvals, external delivery, privacy controls, and final candidate outcomes remain unavailable to team roles.`}><Card className="border-slate-200 bg-white"><CardContent className="p-6"><SectionTitle icon={ShieldAlert} title="Scoped operational access" detail="Use the workspace navigation for the operations that match your role. Attempts to access a restricted route are blocked and remain auditable." /><div className="mt-5 rounded-2xl bg-[#f7f5f0] p-4"><p className="text-sm font-semibold capitalize text-[#10213d]">{access.role} permissions</p><p className="mt-2 text-xs leading-5 text-slate-600">{access.permissions.join(" · ")}</p></div></CardContent></Card></PageShell>;
  return <PageShell eyebrow="Workspace security" title="Join a team workspace" description="Enter the one-time invitation code that the workspace owner shared through an approved secure channel. The code is bound to your signed-in email and expires automatically."><div className="mx-auto max-w-xl"><FormCard title="Activate invitation" detail="No invitation email is sent until Hostinger Mail API activation is complete. Never paste a code into email or an unapproved channel."><form onSubmit={submit} className="space-y-4"><div><Label>One-time invitation code</Label><Input name="invitationCode" required minLength={24} placeholder="Paste the code provided by the owner" autoComplete="off" /></div><Button type="submit" disabled={accept.isPending} className="bg-[#10213d]">Activate controlled workspace access</Button></form></FormCard></div></PageShell>;
}

export function TeamPage() {
  const { user } = useAuth();
  if (user?.role !== "admin") return <MemberTeamAccess />;
  return <OwnerTeamPage />;
}
