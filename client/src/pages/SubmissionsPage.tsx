import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { submissionFields } from "@shared/submission";
const selectClass = "block w-full rounded border bg-white p-2";
export default function SubmissionsPage() {
  const [candidateId, setCandidateId] = useState(""),
    [jobId, setJobId] = useState(""),
    [contactId, setContactId] = useState(""),
    [senderIdentityId, setSenderIdentityId] = useState(""),
    [search, setSearch] = useState(""),
    [roleSearch, setRoleSearch] = useState(""),
    [hours, setHours] = useState(72),
    [fields, setFields] = useState<string[]>([...submissionFields]),
    [id, setId] = useState(""),
    [fragment, setFragment] = useState(""),
    [requestKey, setRequestKey] = useState(() => crypto.randomUUID()),
    [allowCodes, setAllowCodes] = useState(false),
    [notice, setNotice] = useState("");
  const utils = trpc.useUtils(),
    candidates = trpc.submissions.options.useQuery({
      kind: "candidate",
      search,
    }),
    jobs = trpc.submissions.options.useQuery({
      kind: "job",
      search: roleSearch,
    }),
    contacts = trpc.submissions.options.useQuery({
      kind: "contact",
      jobId: jobId || undefined,
    }),
    senders = trpc.submissions.options.useQuery({ kind: "sender" }),
    list = trpc.submissions.list.useQuery({
      candidateId: candidateId || undefined,
      jobId: jobId || undefined,
    }),
    detail = trpc.submissions.detail.useQuery(
      { id },
      { enabled: !!id, retry: false }
    ),
    d = detail.data;
  const refresh = () => {
    utils.submissions.invalidate();
  };
  const prepare = trpc.submissions.prepare.useMutation({
      onSuccess: r => {
        setId(r.id);
        setFragment("");
        setRequestKey(crypto.randomUUID());
        setNotice(
          "Pack prepared. Review the exact contents and owner sharing approval before release."
        );
        refresh();
      },
    }),
    decide = trpc.recruitment.approvals.decide.useMutation({
      onSuccess: () => {
        setNotice(
          "Sharing approval recorded. Private access has not yet been released."
        );
        refresh();
      },
    }),
    release = trpc.submissions.release.useMutation({
      onSuccess: r => {
        setFragment(r.fragment);
        setNotice(
          "Private access released. This does not establish recipient email delivery or client review."
        );
        refresh();
      },
    }),
    mail = trpc.submissions.prepareEmail.useMutation({
      onSuccess: r => {
        setNotice(
          "Invitation prepared in the existing email approval/outbox: " +
            r.approvalId +
            ". It has not been sent by this action."
        );
        refresh();
      },
    }),
    revoke = trpc.submissions.revoke.useMutation({
      onSuccess: () => {
        setFragment("");
        setNotice(
          "Access revoked; unused review mail and reminders were cancelled."
        );
        refresh();
      },
    }),
    follow = trpc.submissions.enrollFollowup.useMutation({
      onSuccess: () => {
        setNotice(
          "Review reminder enrolled in the shared follow-up engine in review mode."
        );
        refresh();
      },
    });
  const mutations = [prepare, decide, release, mail, revoke, follow],
    error = mutations.find(m => m.error)?.error?.message;
  const load = (row: any) => {
    setId(row.id);
    setCandidateId(row.candidateId);
    setJobId(row.jobId);
    setContactId("");
    setFragment("");
    setNotice("");
  };
  return (
    <div className="min-w-0 space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Client submissions</h1>
        <p>
          Prepare a minimized profile, obtain exact owner approval, then release
          private recipient review. Email possession is separate from
          authenticated employer authority or a hiring decision.
        </p>
      </header>
      <form
        aria-label="Submission profile preparation"
        className="grid gap-3 rounded-xl border bg-white p-4 sm:grid-cols-2"
        onSubmit={e => {
          e.preventDefault();
          prepare.mutate({
            candidateId,
            jobId,
            contactId,
            senderIdentityId,
            fields: fields as any,
            expectedVersion:
              d?.shortlist.candidateId === candidateId &&
              d.shortlist.jobId === jobId
                ? d.version
                : 0,
            expiresHours: hours,
            transactionalOtp: true,
            requestKey,
          });
        }}
      >
        <label>
          Find candidate
          <Input
            aria-label="Find submission candidate"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </label>
        <label>
          Find role
          <Input
            aria-label="Find submission role"
            value={roleSearch}
            onChange={e => setRoleSearch(e.target.value)}
          />
        </label>
        <label>
          Candidate
          <select
            aria-label="Submission candidate"
            required
            className={selectClass}
            value={candidateId}
            onChange={e => {
              setCandidateId(e.target.value);
              setId("");
            }}
          >
            <option value="">Choose candidate</option>
            {candidates.data?.rows.map(r => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role
          <select
            aria-label="Submission role"
            required
            className={selectClass}
            value={jobId}
            onChange={e => {
              setJobId(e.target.value);
              setContactId("");
              setId("");
            }}
          >
            <option value="">Choose role</option>
            {jobs.data?.rows.map(r => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Exact client contact
          <select
            aria-label="Submission client contact"
            required
            className={selectClass}
            value={contactId}
            onChange={e => setContactId(e.target.value)}
          >
            <option value="">Choose permitted contact</option>
            {contacts.data?.rows.map(r => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Client mailbox
          <select
            aria-label="Submission sender"
            required
            className={selectClass}
            value={senderIdentityId}
            onChange={e => setSenderIdentityId(e.target.value)}
          >
            <option value="">Choose configured client sender</option>
            {senders.data?.rows.map(r => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Access lifetime, hours
          <Input
            aria-label="Submission lifetime hours"
            type="number"
            min={1}
            max={336}
            value={hours}
            onChange={e => setHours(Number(e.target.value))}
            required
          />
        </label>
        <fieldset className="space-y-2">
          <legend>Minimized structured fields</legend>
          {submissionFields.map(f => (
            <label key={f} className="block">
              <input
                type="checkbox"
                checked={fields.includes(f)}
                onChange={e =>
                  setFields(
                    e.target.checked
                      ? [...fields, f]
                      : fields.filter(x => x !== f)
                  )
                }
              />{" "}
              {f}
            </label>
          ))}
        </fieldset>
        <label className="sm:col-span-2">
          <input
            type="checkbox"
            checked={allowCodes}
            onChange={e => setAllowCodes(e.target.checked)}
          />{" "}
          Authorize recipient-requested transactional verification emails within
          this exact sharing approval: three codes per recipient/day, one-minute
          spacing, ten-minute code expiry and existing agency outbound budget.
          This must be reviewed with the pack.
        </label>
        <p className="text-sm sm:col-span-2">
          Current structured candidate evidence and exact client/job sharing
          consent are required. Names, direct contact details, raw CVs,
          compensation and internal notes are excluded. Recorded sharing consent
          does not prove candidate approval of this exact pack.
        </p>
        {(candidates.data?.more || jobs.data?.more || contacts.data?.more) && (
          <p className="sm:col-span-2">
            Only the first 100 options are shown. Refine candidate/role search
            or use the exact role contact.
          </p>
        )}
        <Button disabled={prepare.isPending || !allowCodes || !fields.length}>
          Prepare exact submission pack
        </Button>
      </form>
      {(notice || error) && (
        <p
          role={error ? "alert" : "status"}
          className="break-words rounded border bg-white p-3"
        >
          {error || notice}
        </p>
      )}
      <section className="space-y-3 rounded-xl border bg-white p-4">
        <h2 className="text-xl font-semibold">Canonical shortlist records</h2>
        {list.error && <p role="alert">{list.error.message}</p>}
        {list.data?.rows.map((r: any) => (
          <Button
            key={r.id}
            variant="outline"
            className="mr-2 mb-2 h-auto max-w-full whitespace-normal break-all"
            onClick={() => load(r)}
          >
            Profile {r.candidateId.slice(-6)} · role {r.jobId.slice(-6)} ·{" "}
            {r.status}
          </Button>
        ))}
        {list.data?.more && (
          <p>
            First 100 records shown; filter candidate/role to narrow the scope.
          </p>
        )}
      </section>
      {detail.error && (
        <p role="alert">
          {detail.error.message} Legacy approval alone is not a released
          profile. Prepare a new exact pack for the selected candidate and role.
        </p>
      )}
      {d && (
        <section
          aria-label="Current submission pack"
          className="space-y-3 rounded-xl border bg-white p-4"
        >
          <h2 className="text-xl font-semibold">
            {d.pack.profileLabel} · version {d.version}
          </h2>
          <p>
            {d.pack.roleTitle} · {d.shortlist.status} · approval{" "}
            {d.approvalStatus} · expires{" "}
            {new Date(d.expiresAt).toLocaleString()}
          </p>
          <p className="break-all text-xs">Exact pack hash: {d.packHash}</p>
          <div
            aria-label="Exact submission recipient and authority"
            className="space-y-1 rounded border p-3 text-sm"
          >
            <p>
              Assigned recipient: {d.recipient.name ?? "Unavailable"} ·{" "}
              {d.recipient.email ?? "Unavailable"}.
            </p>
            <p>
              Client sender: {d.sender.email ?? "Unavailable"} ·{" "}
              {d.sender.purpose ?? "Unavailable"}.
            </p>
            <p>
              Recipient matches prepared address:{" "}
              {d.recipient.matchesPreparedHash
                ? "yes"
                : "no — prepare a new version"}
              .
            </p>
            <p>
              Exact sharing consent: {d.consent.status}; expires{" "}
              {d.consent.expiresAt
                ? new Date(d.consent.expiresAt).toLocaleString()
                : "no recorded expiry"}
              .
            </p>
            <p>
              Current source matches this prepared pack:{" "}
              {d.sourceCurrent ? "yes" : "no — approval/release is blocked"}.
            </p>
          </div>
          <dl>
            {Object.entries(d.pack.fields).map(([key, value]) => (
              <div key={key}>
                <dt className="font-semibold">{key}</dt>
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
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                d.approvalStatus !== "pending" ||
                decide.isPending ||
                !d.sourceCurrent
              }
              onClick={() =>
                decide.mutate({
                  id: d.approvalId,
                  decision: "approved",
                  note: "Reviewed the exact minimized submission profile, recipient, source consent, expiry and bounded transactional code authority.",
                })
              }
            >
              Approve exact sharing pack
            </Button>
            <Button
              variant="outline"
              disabled={d.approvalStatus !== "pending" || decide.isPending}
              onClick={() =>
                decide.mutate({
                  id: d.approvalId,
                  decision: "rejected",
                  note: "This profile requires correction before client access release.",
                })
              }
            >
              Reject sharing pack
            </Button>
            <Button
              disabled={d.approvalStatus !== "approved" || release.isPending}
              onClick={() => release.mutate({ id: d.id, version: d.version })}
            >
              Release private profile access
            </Button>
            <Button
              variant="outline"
              disabled={!d.accessCurrent || mail.isPending}
              onClick={() => mail.mutate({ id: d.id })}
            >
              Prepare reviewed invitation email
            </Button>
            <Button
              variant="outline"
              disabled={
                !d.accessCurrent ||
                follow.isPending ||
                !d.delivery.some(
                  (m: any) =>
                    m.kind === "submission_link" && m.status === "sent"
                )
              }
              onClick={() => follow.mutate({ id: d.id })}
            >
              Enroll shared review reminder
            </Button>
            <Button
              variant="outline"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate({ id: d.id })}
            >
              Revoke profile access
            </Button>
          </div>
          {fragment && (
            <div className="break-all rounded border p-3">
              <p>
                Private link for the assigned recipient. Do not forward or place
                it in public notes.
              </p>
              <a
                className="text-blue-700 underline"
                referrerPolicy="no-referrer"
                target="_blank"
                rel="noreferrer"
                href={"/client-review#" + fragment}
              >
                Open private review entry
              </a>
            </div>
          )}
          <p>
            Access current: {d.accessCurrent ? "yes" : "no"}. Access release is
            separate from provider acceptance, recipient delivery and review.
          </p>
          <h3 className="font-semibold">Canonical email outcomes</h3>
          {d.delivery.map((m: any) => (
            <p key={m.dispatchId} className="break-words text-sm">
              {m.kind}: {m.status} · provider acceptance{" "}
              {m.providerAccepted ? "recorded" : "unconfirmed"} · recipient
              delivery unverified · approval {m.approvalId}
            </p>
          ))}
          <h3 className="font-semibold">Review and correction history</h3>
          {!d.feedback.length && <p>No client feedback has been recorded.</p>}
          {d.feedback.map((f: any) => (
            <article key={f.revision} className="rounded border p-3">
              <p>
                Feedback {f.revision} · pack {f.version} · {f.outcome}
              </p>
              <p className="whitespace-pre-wrap break-words">{f.note}</p>
              <p className="text-xs">
                Email possession verified; employer decision authority is
                unverified. No hiring disposition or interview booking was
                applied.
              </p>
            </article>
          ))}
          {d.olderFeedbackAvailable && (
            <p>Older feedback exists beyond the first 50 observations.</p>
          )}
        </section>
      )}
    </div>
  );
}
