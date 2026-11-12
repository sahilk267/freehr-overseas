import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
const local = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
function ReviewerObservation({
  d,
  reviewer,
  active,
  refresh,
}: {
  d: any;
  reviewer: any;
  active: any;
  refresh: () => Promise<void>;
}) {
  const [requestKey] = useState(() => crypto.randomUUID()),
    save = trpc.interviewFeedback.record.useMutation({
      onSuccess: async () => {
        await refresh();
        toast.success(
          "Reviewer observation saved. Identity and hiring outcome remain unverified."
        );
      },
    });
  return (
    <form
      aria-label={"Record reviewer observation " + reviewer.name}
      className="space-y-2 rounded border p-3"
      onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        save.mutate({
          interviewId: d.interviewId,
          expectedFingerprint: d.fingerprint,
          panelRevision: d.panel.revision,
          reviewerKey: reviewer.key,
          requestKey,
          ...(active ? { supersedesId: active.id } : {}),
          rawFeedback: String(f.get("raw")),
          ratings: d.panel.criteria.map((_: any, i: number) => ({
            criterionIndex: i,
            score:
              f.get("score_" + i) === "" ? null : Number(f.get("score_" + i)),
            ...(String(f.get("quote_" + i) || "")
              ? { quote: String(f.get("quote_" + i)) }
              : {}),
          })),
          limitations: String(f.get("limitations") || ""),
          reason: String(f.get("reason")),
        });
      }}
    >
      <h4 className="font-semibold">
        {reviewer.name} ·{" "}
        {active ? "Record an explicit correction" : "Awaiting observation"}
      </h4>
      <p>
        Recorded by the owner on behalf of the named reviewer. This does not
        authenticate the interviewer or client.
      </p>
      <label className="block">
        Recorded job-related feedback
        <Textarea
          name="raw"
          aria-label="Recorded job-related feedback"
          required
          minLength={12}
          maxLength={12000}
          defaultValue={active?.rawFeedback ?? ""}
        />
      </label>
      {d.panel.criteria.map((criterion: any, i: number) => (
        <fieldset key={i} className="space-y-2 rounded border p-2">
          <legend>
            {criterion.criterion} · weight {criterion.weight}%
          </legend>
          <label className="block">
            Observed rating
            <select
              name={"score_" + i}
              aria-label={"Observed rating for " + criterion.criterion}
              className="block w-full rounded border p-2"
              defaultValue={
                active?.scorecard.ratings.find(
                  (r: any) => r.criterionIndex === i
                )?.score ?? ""
              }
            >
              <option value="">Unknown / insufficient evidence</option>
              {[0, 1, 2, 3, 4, 5].map(n => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Exact supporting quote from the recorded feedback
            <Textarea
              name={"quote_" + i}
              aria-label={"Supporting feedback quote for "+criterion.criterion}
              maxLength={500}
              defaultValue={
                active?.scorecard.ratings.find(
                  (r: any) => r.criterionIndex === i
                )?.quote ?? ""
              }
            />
          </label>
        </fieldset>
      ))}
      <label className="block">
        Limitations or missing evidence
        <Textarea
          name="limitations"
          aria-label="Limitations or missing evidence"
          maxLength={2000}
          defaultValue={active?.scorecard.limitations ?? ""}
        />
      </label>
      <label className="block">
        Reason for this observation or correction
        <Textarea name="reason" required minLength={8} maxLength={2000} />
      </label>
      {save.error && (
        <p role="alert" className="break-words text-red-700">
          {save.error.message}
        </p>
      )}
      <Button size="sm" disabled={save.isPending || !d.current || !d.available}>
        {active ? "Save corrected observation" : "Save reviewer observation"}
      </Button>
    </form>
  );
}
function FeedbackResolution({
  d,
  refresh,
}: {
  d: any;
  refresh: () => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState({
      hash: d.responseHash,
      fingerprint: d.fingerprint,
    }),
    save = trpc.interviewFeedback.resolve.useMutation({
      onSuccess: async () => {
        await refresh();
        toast.success(
          "Panel next action recorded for owner review; no candidate disposition was applied."
        );
      },
    }),
    stale =
      snapshot.hash !== d.responseHash ||
      snapshot.fingerprint !== d.fingerprint;
  return (
    <form
      aria-label="Review panel next action"
      className="space-y-2 rounded border p-3"
      onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        save.mutate({
          interviewId: d.interviewId,
          expectedFingerprint: snapshot.fingerprint,
          panelRevision: d.panel.revision,
          expectedResponseHash: snapshot.hash,
          nextAction: String(f.get("action")) as "owner_review",
          evidence: String(f.get("evidence")),
        });
      }}
    >
      <h4 className="font-semibold">Explicit panel next action</h4>
      {stale && (
        <p role="alert">
          The observations changed while this review was open. Your explanation
          is preserved.{" "}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              setSnapshot({ hash: d.responseHash, fingerprint: d.fingerprint })
            }
          >
            Review current observations
          </Button>
        </p>
      )}
      <p>
        Differences and unknown ratings remain visible. This record does not
        book another round, declare client acceptance, or advance/reject the
        candidate.
      </p>
      <label className="block">
        Reviewed next action
        <select
          name="action"
          className="block w-full rounded border p-2"
          aria-label="Reviewed panel next action"
        >
          <option value="owner_review">Owner review required</option>
          <option value="request_clarification">Request clarification</option>
          <option value="consider_next_round">
            Consider a next round after all reviewers respond
          </option>
        </select>
      </label>
      <label className="block">
        Evidence and reason for this next action
        <Textarea name="evidence" minLength={8} maxLength={2000} required />
      </label>
      {save.error && (
        <p role="alert" className="text-red-700">
          {save.error.message}
        </p>
      )}
      <Button
        size="sm"
        disabled={
          save.isPending ||
          stale ||
          !d.current ||
          !d.available ||
          !d.responses.length
        }
      >
        Save reviewed next action
      </Button>
    </form>
  );
}
export function InterviewFeedbackPanel({
  interviewId,
}: {
  interviewId: string;
}) {
  const [open, setOpen] = useState(false),
    [reviewers, setReviewers] = useState<
      { key: string; name: string; contactId?: string }[]
    >([{ key: "reviewer_1", name: "" }]),
    q = trpc.interviewFeedback.detail.useQuery(
      { interviewId },
      { enabled: open }
    ),
    d = q.data,
    utils = trpc.useUtils();
  useEffect(() => {
    if (d?.panel) setReviewers(d.panel.reviewers);
  }, [d?.panel?.revision]);
  const refresh = async () => {
      await q.refetch();
      await utils.recruitment.interviews.invalidate();
      await utils.recruitment.feedback.invalidate();
      await utils.recruitment.matching.invalidate();
    },
    configure = trpc.interviewFeedback.configure.useMutation({
      onSuccess: async () => {
        await refresh();
        toast.success(
          "Versioned interviewer panel saved against the current role and schedule."
        );
      },
    }),
    thread = trpc.interviewFeedback.ensureConversation.useMutation({
      onSuccess: refresh,
    }),
    remind = trpc.interviewFeedback.enrollReminder.useMutation({
      onSuccess: async () => {
        await refresh();
        toast.success(
          "Reviewer reminders enrolled in the shared follow-up engine for review."
        );
      },
    });
  return (
    <details
      id={"feedback-" + interviewId}
      className="mt-3 space-y-3 rounded border p-3 text-sm"
      onToggle={e => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer font-semibold">
        Structured interviewer feedback & panel review
      </summary>
      {q.isLoading && <p role="status">Loading interview feedback…</p>}
      {q.error && <p role="alert">{q.error.message}</p>}
      {d && (
        <>
          <p>
            Use the exact employer rubric and separate reviewer observations.
            Owner-recorded feedback is not an authenticated client decision.
            Interview source: {d.interviewStatus}.
          </p>
          {d.panel && !d.current && (
            <p role="alert">
              The interview schedule or role rubric changed. Configure a fresh
              panel before recording feedback; older observations remain
              historical.
            </p>
          )}
          <details open={!d.panel}>
            <summary>Configure reviewer panel</summary>
            <form
              aria-label="Configure interviewer feedback panel"
              className="space-y-2"
              onSubmit={e => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                configure.mutate({
                  interviewId,
                  expectedFingerprint: d.fingerprint,
                  expectedRevision: d.panel?.revision ?? 0,
                  reviewers,
                  dueAt: new Date(String(f.get("due"))),
                  reason: String(f.get("reason")),
                });
              }}
            >
              {!d.criteria.length && (
                <p>
                  Record employer scorecard criteria totaling 100% in the job
                  requirement before configuring this panel.
                </p>
              )}
              {reviewers.map((r, i) => (
                <fieldset key={r.key} className="space-y-2 rounded border p-2">
                  <legend>Reviewer {i + 1}</legend>
                  <label className="block">
                    Reviewer name
                    <Input
                      value={r.name}
                      required
                      minLength={2}
                      maxLength={160}
                      onChange={e =>
                        setReviewers(old =>
                          old.map((v, j) =>
                            i === j ? { ...v, name: e.target.value } : v
                          )
                        )
                      }
                    />
                  </label>
                  <label className="block">
                    Client contact for permitted reminders, if applicable
                    <select
                      aria-label={"Reviewer client contact " + (i + 1)}
                      className="block w-full rounded border p-2"
                      value={r.contactId ?? ""}
                      onChange={e =>
                        setReviewers(old =>
                          old.map((v, j) =>
                            i === j
                              ? { ...v, contactId: e.target.value || undefined }
                              : v
                          )
                        )
                      }
                    >
                      <option value="">
                        No contact linked; owner records observations only
                      </option>
                      {d.contacts.map(c => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={reviewers.length === 1}
                    onClick={() =>
                      setReviewers(old => old.filter((_, j) => j !== i))
                    }
                  >
                    Remove reviewer
                  </Button>
                </fieldset>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={reviewers.length >= 12}
                onClick={() =>
                  setReviewers(old => [
                    ...old,
                    {
                      key: "reviewer_" + crypto.randomUUID().slice(0, 20),
                      name: "",
                    },
                  ])
                }
              >
                Add reviewer
              </Button>
              <label className="block">
                Feedback response deadline (browser timezone)
                <Input
                  name="due"
                  type="datetime-local"
                  required
                  defaultValue={local(
                    new Date(d.panel?.dueAt ?? Date.now() + 2 * 86400000)
                  )}
                />
              </label>
              <label className="block">
                Reason for this panel version
                <Textarea
                  name="reason"
                  minLength={8}
                  maxLength={2000}
                  required
                />
              </label>
              <Button
                size="sm"
                disabled={
                  configure.isPending || !d.available || !d.criteria.length
                }
              >
                Save feedback panel
              </Button>
            </form>
          </details>
          {d.panel && (
            <>
              <p>
                Panel version {d.panel.revision} · missing reviewers:{" "}
                {d.comparison.missingReviewers.length} · {d.history.length}{" "}
                historical observations.
              </p>
              {d.comparison.rows.map((row: any) => (
                <p key={row.criterionIndex}>
                  {row.criterion}:{" "}
                  {row.minimum === null
                    ? "Unknown"
                    : row.minimum + "–" + row.maximum}
                  {row.conflict ? " · differing ratings require review" : ""} ·
                  unknown reviewers {row.unknownReviewers.length}
                </p>
              ))}
              {d.panel.reviewers.map((r: any) => {
                const active = d.responses.find(
                  (f: any) => f.scorecard.reviewerKey === r.key
                );
                return (
                  <section key={r.key} className="space-y-2">
                    <ReviewerObservation
                      key={
                        r.key +
                        ":" +
                        d.panel.revision +
                        ":" +
                        (active?.id ?? "new")
                      }
                      d={d}
                      reviewer={r}
                      active={active}
                      refresh={refresh}
                    />
                    {r.contactId && !active && (
                      <>
                        <Button
                          size="sm"
                          type="button"
                          variant="outline"
                          disabled={
                            thread.isPending || !d.current || !d.available
                          }
                          onClick={() =>
                            thread.mutate({ interviewId, reviewerKey: r.key })
                          }
                        >
                          Prepare reviewer email thread
                        </Button>
                        <form
                          aria-label={"Enroll feedback reminder " + r.name}
                          className="space-y-2"
                          onSubmit={e => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            remind.mutate({
                              interviewId,
                              reviewerKey: r.key,
                              conversationId: String(f.get("conversation")),
                              senderIdentityId: String(f.get("sender")),
                            });
                          }}
                        >
                          <label className="block">
                            Reviewer thread
                            <select
                              name="conversation"
                              aria-label={"Feedback thread " + r.name}
                              required
                              className="block w-full rounded border p-2"
                            >
                              <option value="">
                                Choose the exact reviewer thread
                              </option>
                              {d.conversations
                                .filter((c: any) => c.contactId === r.contactId)
                                .map((c: any) => (
                                  <option key={c.id} value={c.id}>
                                    {c.id.slice(-6)}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <label className="block">
                            Interview sender
                            <select
                              name="sender"
                              aria-label={"Feedback sender " + r.name}
                              required
                              className="block w-full rounded border p-2"
                            >
                              <option value="">Choose sender</option>
                              {d.senders.map(s => (
                                <option key={s.id} value={s.id}>
                                  {s.email}
                                </option>
                              ))}
                            </select>
                          </label>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              remind.isPending || !d.current || !d.available
                            }
                          >
                            Enroll reviewer reminders
                          </Button>
                        </form>
                      </>
                    )}
                  </section>
                );
              })}
              <FeedbackResolution
                key={interviewId + ":" + d.panel.revision}
                d={d}
                refresh={refresh}
              />
              {d.resolution && (
                <p role="status">
                  Recorded next action: {d.resolution.nextAction} · final
                  candidate disposition not applied.
                </p>
              )}
              <details>
                <summary>Historical observations</summary>
                {d.history.map((f: any) => (
                  <div key={f.id} className="space-y-1 rounded border p-2">
                    <p>
                      {f.authorName} ·{" "}
                      {new Date(f.submittedAt).toLocaleString()}
                    </p>
                    <p className="whitespace-pre-wrap break-words">
                      {f.rawFeedback}
                    </p>
                  </div>
                ))}
              </details>
            </>
          )}
          {configure.error && (
            <p role="alert" className="text-red-700">
              {configure.error.message}
            </p>
          )}
          {thread.error && <p role="alert">{thread.error.message}</p>}
          {remind.error && <p role="alert">{remind.error.message}</p>}
        </>
      )}
    </details>
  );
}
