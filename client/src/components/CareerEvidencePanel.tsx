import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import type { CareerRecord } from "@shared/careerEvidence";
const empty = (): CareerRecord => ({
  kind: "employment",
  title: "",
  organization: null,
  startText: null,
  endText: null,
  current: false,
  quote: "",
  confidence: 100,
});
export function CareerEvidencePanel({ candidateId }: { candidateId: string }) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<CareerRecord[]>([empty()]);
  const q = trpc.careerEvidence.detail.useQuery(
      { candidateId },
      { enabled: open }
    ),
    docs = trpc.recruitment.candidates.documents.list.useQuery(
      { candidateId },
      { enabled: open }
    ),
    utils = trpc.useUtils();
  const refresh = async () => {
    await q.refetch();
    await docs.refetch();
    await utils.recruitment.candidates.evidence.invalidate({ id: candidateId });
    await utils.recruitment.matching.invalidate();
    await utils.candidateReviews.invalidate();
  };
  const review = trpc.careerEvidence.review.useMutation({
      onSuccess: async () => {
        await refresh();
        toast.success(
          "Career evidence review saved; current matching needs reassessment."
        );
      },
    }),
    record = trpc.careerEvidence.recordSource.useMutation({
      onSuccess: async r => {
        await refresh();
        toast.success(
          `${r.supported} of ${r.records} source entries have literal supporting evidence.`
        );
      },
    });
  const d = q.data;
  const field = (i: number, patch: Partial<CareerRecord>) =>
    setDraft(old => old.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  const reviewForm = (
    targetId: string,
    isRecord: boolean,
    supported: boolean,
    kind: string,
    current: any
  ) => (
    <form
      aria-label="Review career evidence item"
      className="space-y-2"
      onSubmit={e => {
        e.preventDefault();
        if (!d) return;
        const f = new FormData(e.currentTarget);
        review.mutate({
          candidateId,
          expectedFingerprint: d.fingerprint,
          expectedRevision: d.revision,
          sourceSignature: d.sourceSignature,
          decisions: [
            {
              targetId,
              disposition: String(
                f.get("disposition")
              ) as "needs_clarification",
              note: String(f.get("note")),
            },
          ],
          reason: String(f.get("note")),
        });
      }}
    >
      <label className="block">
        Review outcome
        <select
          name="disposition"
          aria-label="Career evidence review outcome"
          className="block w-full rounded border p-2"
          defaultValue={current?.disposition ?? "needs_clarification"}
        >
          {isRecord && supported && (
            <option value="source_checked">
              Literal source statement checked (not independently verified)
            </option>
          )}
          <option value="needs_clarification">Needs clarification</option>
          <option value="excluded">Exclude from this evidence review</option>
          {!isRecord &&
            !["unsupported", "date_order", "future_date"].includes(kind) && (
              <option value="explained">
                Owner-recorded explanation reviewed
              </option>
            )}
        </select>
      </label>
      <label className="block">
        Evidence or explanation
        <Textarea
          name="note"
          aria-label="Evidence or explanation"
          required
          minLength={8}
          maxLength={2000}
          defaultValue={current?.note ?? ""}
        />
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={review.isPending || d?.suppressed}
      >
        Save evidence review
      </Button>
    </form>
  );
  return (
    <details
      id={"career-" + candidateId}
      className="space-y-3 rounded-lg border p-3 text-sm"
      onToggle={e => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer font-semibold">
        Career timeline & source evidence
      </summary>
      <p>
        Employment, education, credentials and stated skills stay linked to the
        current CV quotation. Source support does not verify employment or
        credentials. Date questions and gaps never authorize automatic
        rejection.
      </p>
      {q.isLoading && <p role="status">Loading career evidence…</p>}
      {q.error && <p role="alert">{q.error.message}</p>}
      {d && (
        <>
          <p>
            Review version {d.revision} · {d.documents.length} current
            source(s).{" "}
            {d.documentsTruncated
              ? "More than twenty documents exist; review the complete file set."
              : ""}
          </p>
          {d.history && !d.reviewCurrent && (
            <p role="status">
              The source changed after the previous review. Earlier decisions
              remain historical; review the current evidence again.
            </p>
          )}
          {!d.documents.length && (
            <p>
              No grounded career extraction is available yet. New CV parsing can
              extract literal entries automatically. Existing parsed CVs can be
              reviewed using the source-entry form below; missing data is not
              invented.
            </p>
          )}
          {d.documents.map((doc: any) => (
            <section
              key={doc.documentId}
              className="space-y-2 rounded border p-3"
            >
              <h4 className="font-semibold">
                Career source · {doc.documentId.slice(-6)}
              </h4>
              <p>
                Observed {new Date(doc.observedAt).toLocaleString()} · extractor{" "}
                {doc.model}
              </p>
              <p>
                Stated employment month coverage:{" "}
                {doc.analysis?.coverageMonths.minimum}–
                {doc.analysis?.coverageMonths.maximum} months, after combining
                overlaps. This is approximate source coverage, not verified
                tenure or relevant experience.
              </p>
              <p className="text-xs">
                PDF page mapping is unavailable for this text extraction;
                quotations refer to the extracted text.
              </p>
              {d.records
                .filter((r: any) => r.documentId === doc.documentId)
                .map((r: any) => (
                  <details key={r.key} className="space-y-2 rounded border p-2">
                    <summary className="cursor-pointer">
                      {r.kind}: {r.title}
                      {r.organization ? " · " + r.organization : ""} ·{" "}
                      {r.supported
                        ? "literal source supported"
                        : "source needs review"}
                      {r.review ? " · " + r.review.disposition : ""}
                    </summary>
                    <p>
                      Dates: {r.startText ?? "not stated"} to{" "}
                      {r.current
                        ? "current at observation"
                        : (r.endText ?? "not stated")}
                      . Extraction confidence {r.confidence}%; factual
                      authenticity unverified.
                    </p>
                    <blockquote className="whitespace-pre-wrap break-words rounded bg-slate-50 p-2">
                      {r.quote}
                    </blockquote>
                    {r.citation && (
                      <p className="text-xs">
                        Extracted-text character span {r.citation.start}–
                        {r.citation.end}.
                      </p>
                    )}
                    {r.reasons.map((reason: string, i: number) => (
                      <p key={i}>{reason}</p>
                    ))}
                    {reviewForm(r.key, true, r.supported, "record", r.review)}
                  </details>
                ))}
            </section>
          ))}
          <section
            aria-label="Career chronology questions"
            className="space-y-2"
          >
            <h4 className="font-semibold">
              Chronology questions · {d.openIssues.length} unresolved
            </h4>
            <p>
              New candidate questionnaires include bounded unresolved
              date/overlap questions. Gaps are optional context and do not
              request personal explanations.
            </p>
            {d.issues.map((issue: any) => (
              <details key={issue.key} className="space-y-2 rounded border p-2">
                <summary className="cursor-pointer">
                  {issue.kind.replaceAll("_", " ")}
                  {issue.review ? " · " + issue.review.disposition : ""}
                </summary>
                <p>{issue.explanation}</p>
                {issue.question && <p>{issue.question}</p>}
                {reviewForm(issue.key, false, false, issue.kind, issue.review)}
              </details>
            ))}
          </section>
          <details>
            <summary className="cursor-pointer">
              Add or correct literal source entries
            </summary>
            <p className="my-2">
              Use exact text from one current clean CV. This replaces that
              document’s career extraction, preserves its file, and invalidates
              older career reviews/matches. Unsupported or ambiguous quotations
              remain visible for review.
            </p>
            <form
              aria-label="Record literal career source"
              className="space-y-3"
              onSubmit={e => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                record.mutate({
                  candidateId,
                  documentId: String(f.get("document")),
                  expectedFingerprint: d.fingerprint,
                  records: draft,
                  reason: String(f.get("reason")),
                });
              }}
            >
              <label className="block">
                Current CV source
                <select
                  name="document"
                  aria-label="Current career CV source"
                  className="block w-full rounded border p-2"
                  required
                >
                  <option value="">Choose current clean CV</option>
                  {docs.data
                    ?.filter(
                      doc =>
                        doc.documentType === "cv" &&
                        doc.scanState === "clean" &&
                        ["parsed", "queued", "failed"].includes(
                          doc.parseState
                        ) &&
                        !(doc.provenance as any)?.supersededBy
                    )
                    .map(doc => (
                      <option key={doc.id} value={doc.id}>
                        {doc.originalName}
                      </option>
                    ))}
                </select>
              </label>
              {draft.map((r, i) => (
                <fieldset key={i} className="space-y-2 rounded border p-3">
                  <legend>Source entry {i + 1}</legend>
                  <label className="block">
                    Entry type
                    <select
                      aria-label={"Career entry type " + (i + 1)}
                      className="block w-full rounded border p-2"
                      value={r.kind}
                      onChange={e =>
                        field(i, {
                          kind: e.target.value as CareerRecord["kind"],
                          current: false,
                        })
                      }
                    >
                      {[
                        "employment",
                        "education",
                        "certification",
                        "skill",
                      ].map(k => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    Exact role, qualification, certificate or skill title
                    <Input
                      value={r.title}
                      onChange={e => field(i, { title: e.target.value })}
                      required
                      maxLength={200}
                    />
                  </label>
                  <label className="block">
                    Exact organization or issuer, if stated
                    <Input
                      value={r.organization ?? ""}
                      onChange={e =>
                        field(i, { organization: e.target.value || null })
                      }
                      maxLength={200}
                    />
                  </label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label>
                      Start date text, if stated
                      <Input
                        value={r.startText ?? ""}
                        onChange={e =>
                          field(i, { startText: e.target.value || null })
                        }
                        maxLength={80}
                      />
                    </label>
                    <label>
                      End date text, if stated
                      <Input
                        value={r.endText ?? ""}
                        onChange={e =>
                          field(i, {
                            endText: e.target.value || null,
                            current: false,
                          })
                        }
                        maxLength={80}
                      />
                    </label>
                  </div>
                  {r.kind === "employment" && (
                    <label className="flex gap-2">
                      <input
                        type="checkbox"
                        checked={r.current}
                        onChange={e =>
                          field(i, {
                            current: e.target.checked,
                            endText: e.target.checked ? null : r.endText,
                          })
                        }
                      />
                      Explicitly current employment in this quotation
                    </label>
                  )}
                  <label className="block">
                    One exact supporting quotation
                    <Textarea
                      value={r.quote}
                      onChange={e => field(i, { quote: e.target.value })}
                      required
                      minLength={3}
                      maxLength={1200}
                    />
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={draft.length === 1}
                    onClick={() =>
                      setDraft(old => old.filter((_, j) => i !== j))
                    }
                  >
                    Remove this source entry
                  </Button>
                </fieldset>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={draft.length >= 24}
                onClick={() => setDraft(old => [...old, empty()])}
              >
                Add source entry
              </Button>
              <label className="block">
                Reason for this extraction correction
                <Textarea
                  name="reason"
                  required
                  minLength={8}
                  maxLength={2000}
                />
              </label>
              <Button disabled={record.isPending || d.suppressed}>
                Check and save source entries
              </Button>
            </form>
          </details>
          {review.error && (
            <p role="alert" className="break-words text-red-700">
              {review.error.message}
            </p>
          )}
          {record.error && (
            <p role="alert" className="break-words text-red-700">
              {record.error.message}
            </p>
          )}
        </>
      )}
    </details>
  );
}
