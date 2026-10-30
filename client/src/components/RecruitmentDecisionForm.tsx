import { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export function RecruitmentDecisionForm({ candidates, jobs, onClose }: {
  candidates: Array<{ id: string; fullName: string }>;
  jobs: Array<{ id: string; title: string }>;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const request = trpc.recruitment.consequential.requestCandidateDecision.useMutation();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await request.mutateAsync({ candidateId: String(data.get("candidateId")), jobId: String(data.get("jobId")), disposition: String(data.get("disposition")) as "advance" | "not_proceeding", rationale: String(data.get("rationale")), evidence: String(data.get("evidence")).split("\n").map(line => line.trim()).filter(Boolean) });
      await utils.recruitment.candidateWorkflows.screenings.list.invalidate();
      await utils.operations.exceptions.list.invalidate();
      toast.success("Decision request saved. Review its evidence in Exceptions before approving.");
      onClose();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Decision could not be saved."); }
  };
  return <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
    <div><Label htmlFor="decision-candidate">Candidate</Label><select id="decision-candidate" name="candidateId" required className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.fullName}</option>)}</select></div>
    <div><Label htmlFor="decision-job">Job</Label><select id="decision-job" name="jobId" required className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{jobs.map(job => <option key={job.id} value={job.id}>{job.title}</option>)}</select></div>
    <div><Label htmlFor="decision-outcome">Proposed outcome</Label><select id="decision-outcome" name="disposition" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="advance">Advance</option><option value="not_proceeding">Not proceeding</option></select></div>
    <div><Label htmlFor="decision-rationale">Rationale</Label><Input id="decision-rationale" name="rationale" required minLength={8} maxLength={2000} /></div>
    <div className="md:col-span-2"><Label htmlFor="decision-evidence">Evidence (one item per line)</Label><Textarea id="decision-evidence" name="evidence" required minLength={2} /></div>
    <div className="md:col-span-2 flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={request.isPending}>Request decision review</Button></div>
  </form>;
}
