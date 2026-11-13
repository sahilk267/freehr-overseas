import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
export default function ClientReviewPage() {
  const [cap] = useState(() => {
      const fragment = location.hash.slice(1),
        [id, token] = fragment.split(".");
      history.replaceState(null, "", location.pathname);
      return id && /^[A-Za-z0-9_-]{43}$/.test(token ?? "")
        ? { id, token }
        : null;
    }),
    [challengeId, setChallengeId] = useState(""),
    [code, setCode] = useState(""),
    [session, setSession] = useState<{
      sessionId: string;
      sessionToken: string;
    } | null>(null),
    [outcome, setOutcome] = useState<
      | "reviewed"
      | "clarification_requested"
      | "interview_interest"
      | "not_progressing"
    >("reviewed"),
    [note, setNote] = useState(""),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [accepted, setAccepted] = useState(false),
    [saved, setSaved] = useState("");
  const entry = trpc.submissions.entry.useMutation(),
    request = trpc.submissions.requestCode.useMutation({
      onSuccess: r => setChallengeId(r.challengeId),
    }),
    read = trpc.submissions.read.useMutation(),
    verify = trpc.submissions.verifyCode.useMutation({
      onSuccess: r => {
        setSession({ sessionId: r.sessionId, sessionToken: r.sessionToken });
        if (cap)
          read.mutate({
            ...cap,
            sessionId: r.sessionId,
            sessionToken: r.sessionToken,
          });
        setCode("");
      },
    }),
    respond = trpc.submissions.respond.useMutation({
      onSuccess: r => {
        setSaved(
          "Feedback revision " +
            r.revision +
            " saved for recruiter review. No interview or hiring decision has been applied."
        );
        setKey(crypto.randomUUID());
        if (cap && session) read.mutate({ ...cap, ...session });
      },
    });
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.append(meta);
    if (cap) entry.mutate(cap);
    return () => meta.remove();
  }, []);
  const error = [entry, request, verify, read, respond].find(m => m.error)
      ?.error?.message,
    d = read.data;
  return (
    <main className="mx-auto max-w-3xl space-y-5 px-5 py-10 text-slate-800">
      <h1 className="text-3xl font-semibold">Private client profile review</h1>
      <p>
        This review belongs to one recipient and an exact profile version. Email
        possession does not verify employer decision authority. Feedback is
        recorded for the recruiter and does not schedule interviews or apply a
        hiring decision.
      </p>
      {!cap && (
        <p role="alert">
          Open the full private link supplied by the recruiter. Access details
          are never stored in browser storage.
        </p>
      )}
      {entry.data && cap && (
        <section className="space-y-3 rounded-xl border p-4">
          <p>
            Assigned recipient: {entry.data.maskedEmail} · expires{" "}
            {new Date(entry.data.expiresAt).toLocaleString()}.
          </p>
          <p>
            Request a verification code sent to the assigned email address.
            Codes expire in ten minutes. Requests are limited; use the latest
            code.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={request.isPending}
              onClick={() => request.mutate(cap)}
            >
              Request verification code
            </Button>
            {challengeId && (
              <Button
                variant="outline"
                disabled={request.isPending}
                onClick={() => request.mutate({ ...cap, resend: true })}
              >
                Resend verification code
              </Button>
            )}
          </div>
          {challengeId && (
            <form
              className="space-y-3"
              onSubmit={e => {
                e.preventDefault();
                verify.mutate({ ...cap, challengeId, code });
              }}
            >
              <label>
                Verification code
                <Input
                  aria-label="Client review verification code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  required
                />
              </label>
              <Button disabled={verify.isPending || code.length !== 6}>
                Verify email and open profile
              </Button>
            </form>
          )}
        </section>
      )}
      {error && (
        <p
          role="alert"
          className="break-words rounded border border-red-300 p-3"
        >
          {error}
        </p>
      )}
      {d && (
        <section
          aria-label="Verified recipient profile"
          className="space-y-4 rounded-xl border p-4"
        >
          <h2 className="text-2xl font-semibold">{d.pack.profileLabel}</h2>
          <p>
            {d.pack.roleTitle} · version {d.version}
          </p>
          <p>
            Observed {new Date(d.pack.observedAt).toLocaleDateString()} ·
            evidence valid until{" "}
            {new Date(d.pack.evidenceValidUntil).toLocaleDateString()}.
          </p>
          <dl className="space-y-2">
            {Object.entries(d.pack.fields).map(([field, value]) => (
              <div key={field}>
                <dt className="font-semibold">{field}</dt>
                <dd className="break-words">
                  {Array.isArray(value) ? value.join(", ") : String(value)}
                </dd>
              </div>
            ))}
          </dl>
          {d.pack.limitations.map((s: string) => (
            <p key={s} className="text-sm">
              {s}
            </p>
          ))}
          <form
            aria-label="Client profile feedback"
            className="space-y-4"
            onSubmit={e => {
              e.preventDefault();
              if (cap && session)
                respond.mutate({
                  ...cap,
                  ...session,
                  expectedRevision: d.revision,
                  requestKey: key,
                  outcome,
                  note,
                  noticeVersion: "client-submission-v1",
                });
            }}
          >
            <label>
              Recorded response
              <select
                aria-label="Client review outcome"
                className="block w-full rounded border p-2"
                value={outcome}
                onChange={e => setOutcome(e.target.value as typeof outcome)}
              >
                <option value="reviewed">Reviewed</option>
                <option value="clarification_requested">
                  Request clarification
                </option>
                <option value="interview_interest">
                  Express interview interest
                </option>
                <option value="not_progressing">
                  Not progressing for this requirement
                </option>
              </select>
            </label>
            <label>
              Job-related explanation
              <Textarea
                aria-label="Client review explanation"
                value={note}
                onChange={e => setNote(e.target.value)}
                minLength={8}
                maxLength={4000}
                required
              />
            </label>
            <label className="block">
              <input
                type="checkbox"
                checked={accepted}
                onChange={e => setAccepted(e.target.checked)}
              />{" "}
              Record this feedback for this exact profile and requirement.
              Corrections preserve earlier observations. This is not a binding
              employer decision or an interview booking.
            </label>
            <Button disabled={respond.isPending || !accepted}>
              {d.revision
                ? "Save feedback correction"
                : "Save feedback for recruiter review"}
            </Button>
          </form>
          {saved && <p role="status">{saved}</p>}
        </section>
      )}
    </main>
  );
}
