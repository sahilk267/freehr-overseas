import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney, parseMoney, currencyPrecision } from "@shared/money";
import { formatZonedDateTime, zonedDateTimeToUtc } from "@shared/dateTime";
import type { OfferTerms } from "@shared/candidateOffer";
import { toast } from "sonner";
const local = (s: string) => {
  const d = new Date(s);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const amount = (n: number, c: string) => {
  const p = currencyPrecision(c),
    k = 10 ** p;
  return Math.floor(n / k) + (p ? "." + String(n % k).padStart(p, "0") : "");
};
const money = (s: string, c: string) =>
  /^0(?:\.0+)?$/.test(s.trim()) ? 0 : parseMoney(s, c);
export function CandidateOfferPanel({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [link, setLink] = useState(""),
    [conditions, setConditions] = useState<OfferTerms["conditions"]>([]),
    [zone, setZone] = useState("Asia/Kolkata");
  const q = trpc.candidateOffers.detail.useQuery(
      { placementId: id },
      { enabled: open }
    ),
    utils = trpc.useUtils(),
    d = q.data,
    o = d?.offer;
  useEffect(() => {
    setConditions(o?.terms.conditions ?? []);
    setZone(o?.terms.joiningTimezone ?? "Asia/Kolkata");
    setLink("");
  }, [o?.version]);
  const refresh = async () => {
    await q.refetch();
    await utils.recruitment.placements.invalidate();
    await utils.operations.approvals.invalidate();
  };
  const counter = trpc.candidateOffers.prepareCounterDraft.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success(
        "Counteroffer drafted within current client bounds; release still requires owner approval."
      );
    },
  });
  const authority = trpc.candidateOffers.recordAuthority.useMutation({
      onSuccess: async () => {
        await refresh();
        toast.success(
          "Client-evidenced offer bounds recorded; client identity remains unverified."
        );
      },
    }),
    draft = trpc.candidateOffers.saveDraft.useMutation({
      onSuccess: async () => {
        await refresh();
        toast.success("Exact versioned offer draft saved.");
      },
    }),
    release = trpc.candidateOffers.requestRelease.useMutation({
      onSuccess: async () => {
        await refresh();
        toast.success("Exact offer release awaits owner approval.");
      },
    }),
    reveal = trpc.candidateOffers.revealLink.useMutation({
      onSuccess: r =>
        setLink(location.origin + "/offer-response#" + r.fragment),
    }),
    email = trpc.candidateOffers.prepareEmail.useMutation({
      onSuccess: async () => {
        await refresh();
        toast.success(
          "Private offer email awaits its standard message approval."
        );
      },
    }),
    shared = trpc.candidateOffers.recordShared.useMutation({
      onSuccess: () => toast.success("Owner-evidenced sharing recorded."),
    }),
    followup = trpc.candidateOffers.enrollFollowup.useMutation({
      onSuccess: () =>
        toast.success(
          "Offer reminders enrolled in the shared follow-up engine."
        ),
    }),
    close = trpc.candidateOffers.close.useMutation({
      onSuccess: async () => {
        await refresh();
        toast.success("Unaccepted offer withdrawn.");
      },
    }),
    condition = trpc.candidateOffers.reviewCondition.useMutation({
      onSuccess: async () => {
        await refresh();
        toast.success(
          "Condition evidence recorded; independent authority verification is not inferred."
        );
      },
    });
  const canDraft =
    ["offer_pending", "offer_issued"].includes(status) && !o?.accepted;
  const busy =
    authority.isPending ||
    draft.isPending ||
    release.isPending ||
    email.isPending ||
    condition.isPending;
  return (
    <details
      className="mt-3 space-y-3 rounded border p-3 text-sm"
      onToggle={e => setOpen(e.currentTarget.open)}
      id={"offer-" + id}
    >
      <summary className="cursor-pointer font-semibold">
        Versioned offer & candidate response
      </summary>
      {open && !d && (
        <p role={q.error ? "alert" : undefined}>
          {q.error?.message ?? "Loading offer case…"}
        </p>
      )}
      {d && (
        <div className="space-y-4">
          <p>
            Release requires owner approval of exact terms and documented client
            bounds. The candidate verifies email possession before reading or
            responding. Qualified e-signature and independent legal identity
            verification are separate.
          </p>
          {canDraft && (
            <form
              aria-label="Client offer authorization"
              className="space-y-2 rounded border p-3"
              onSubmit={e => {
                e.preventDefault();
                try {
                  setError("");
                  const f = new FormData(e.currentTarget);
                  authority.mutate({
                    placementId: id,
                    expectedPlacementIdentity: d.placementIdentity,
                    expectedRevision: d.authority?.revision ?? 0,
                    clientContactId: String(f.get("contact")),
                    currency: d.currency,
                    minAnnualFixedMinor: parseMoney(
                      String(f.get("min")),
                      d.currency
                    ),
                    maxAnnualFixedMinor: parseMoney(
                      String(f.get("max")),
                      d.currency
                    ),
                    validUntil: new Date(String(f.get("validUntil"))),
                    evidence: String(f.get("evidence")),
                  });
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <h3 className="font-semibold">
                Client-evidenced bounds · version {d.authority?.revision ?? 0}
              </h3>
              <label className="block">
                Client contact
                <select
                  name="contact"
                  aria-label="Client contact"
                  className="block w-full rounded border p-2"
                  required
                  defaultValue={d.authority?.clientContactId ?? ""}
                >
                  <option value="">Choose a permitted client contact</option>
                  {d.contacts.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.email}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <label>
                  Minimum annual fixed amount ({d.currency})
                  <Input
                    name="min"
                    required
                    defaultValue={
                      d.authority
                        ? amount(d.authority.minAnnualFixedMinor, d.currency)
                        : ""
                    }
                  />
                </label>
                <label>
                  Maximum annual fixed amount ({d.currency})
                  <Input
                    name="max"
                    required
                    defaultValue={
                      d.authority
                        ? amount(d.authority.maxAnnualFixedMinor, d.currency)
                        : ""
                    }
                  />
                </label>
              </div>
              <label className="block">
                Authorization expiry (browser timezone)
                <Input
                  name="validUntil"
                  type="datetime-local"
                  required
                  defaultValue={
                    d.authority ? local(d.authority.validUntil) : ""
                  }
                />
              </label>
              <label className="block">
                Evidence of client authorization
                <Textarea
                  name="evidence"
                  minLength={8}
                  maxLength={2000}
                  required
                />
              </label>
              <Button size="sm" variant="outline" disabled={busy}>
                Record offer bounds
              </Button>
            </form>
          )}
          {canDraft && d.authority && (
            <form
              key={"draft-" + (o?.version ?? 0)}
              aria-label="Versioned offer draft"
              className="space-y-3 rounded border p-3"
              onSubmit={e => {
                e.preventDefault();
                try {
                  setError("");
                  const f = new FormData(e.currentTarget),
                    text = (n: string) => String(f.get(n) ?? ""),
                    lines = (n: string) =>
                      text(n)
                        .split("\n")
                        .map(s => s.trim())
                        .filter(Boolean),
                    parts = (n: string) =>
                      lines(n).map(s => {
                        const [label, value, ...extra] = s.split("|");
                        if (!label || !value || extra.length)
                          throw Error(
                            "Use one description | amount on each compensation line."
                          );
                        return {
                          label: label.trim(),
                          amountMinor: money(value.trim(), d.currency),
                        };
                      });
                  draft.mutate({
                    placementId: id,
                    expectedVersion: o?.version ?? 0,
                    feeBasis: String(f.get("feeBasis")) as "annual_fixed",
                    feeBasisEvidence: text("feeEvidence"),
                    ...(o ? { expectedTermsHash: o.termsHash } : {}),
                    reason: text("reason"),
                    terms: {
                      roleTitle: text("role"),
                      location: text("location"),
                      employmentType: text("type"),
                      currency: d.currency,
                      annualBaseMinor: parseMoney(text("base"), d.currency),
                      annualGuaranteedAllowancesMinor: money(
                        text("allowance"),
                        d.currency
                      ),
                      variableCompensation: parts("variable").map(p => ({
                        label: p.label,
                        annualTargetMinor: p.amountMinor,
                        guaranteed: false,
                      })),
                      oneTimePayments: parts("oneTime"),
                      benefits: lines("benefits"),
                      conditions,
                      joiningTimezone: zone,
                      intendedJoiningAt: zonedDateTimeToUtc(
                        text("joining"),
                        zone
                      ).toISOString(),
                      expiresAt: new Date(text("expiry")).toISOString(),
                      termsText: text("terms"),
                      ...(text("notice")
                        ? { noticeDays: Number(text("notice")) }
                        : {}),
                    },
                  });
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <h3 className="font-semibold">Exact offer terms</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                <label>
                  Role title
                  <Input
                    name="role"
                    required
                    maxLength={200}
                    defaultValue={o?.terms.roleTitle ?? d.jobTitle}
                  />
                </label>
                <label>
                  Work location
                  <Input
                    name="location"
                    required
                    maxLength={200}
                    defaultValue={o?.terms.location ?? d.jobLocation}
                  />
                </label>
                <label>
                  Employment type
                  <Input
                    name="type"
                    required
                    maxLength={64}
                    defaultValue={o?.terms.employmentType ?? d.employmentType}
                  />
                </label>
                <label>
                  Annual base ({d.currency})
                  <Input
                    name="base"
                    required
                    defaultValue={
                      o ? amount(o.terms.annualBaseMinor, d.currency) : ""
                    }
                  />
                </label>
                <label>
                  Annual guaranteed allowances ({d.currency})
                  <Input
                    name="allowance"
                    required
                    defaultValue={
                      o
                        ? amount(
                            o.terms.annualGuaranteedAllowancesMinor,
                            d.currency
                          )
                        : "0"
                    }
                  />
                </label>
                <label>
                  Notice days, if agreed
                  <Input
                    name="notice"
                    type="number"
                    min={0}
                    max={365}
                    defaultValue={o?.terms.noticeDays}
                  />
                </label>
              </div>
              <label className="block">
                Variable annual targets, not guaranteed (one description |
                amount per line)
                <Textarea
                  name="variable"
                  defaultValue={o?.terms.variableCompensation
                    .map(
                      v =>
                        v.label +
                        " | " +
                        amount(v.annualTargetMinor, d.currency)
                    )
                    .join("\n")}
                />
              </label>
              <label className="block">
                One-time payments (one description | amount per line)
                <Textarea
                  name="oneTime"
                  defaultValue={o?.terms.oneTimePayments
                    .map(
                      v => v.label + " | " + amount(v.amountMinor, d.currency)
                    )
                    .join("\n")}
                />
              </label>
              <label className="block">
                Benefits (one per line)
                <Textarea
                  name="benefits"
                  defaultValue={o?.terms.benefits.join("\n")}
                />
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <label>
                  Joining timezone
                  <Input
                    value={zone}
                    onChange={e => setZone(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Intended joining date/time in that timezone
                  <Input
                    name="joining"
                    type="datetime-local"
                    required
                    defaultValue={
                      o
                        ? formatZonedDateTime(
                            new Date(o.terms.intendedJoiningAt),
                            o.terms.joiningTimezone
                          )
                        : ""
                    }
                  />
                </label>
              </div>
              <label className="block">
                Response deadline (browser timezone)
                <Input
                  name="expiry"
                  type="datetime-local"
                  required
                  defaultValue={o ? local(o.terms.expiresAt) : ""}
                />
              </label>
              <fieldset className="space-y-2">
                <legend>Offer conditions</legend>
                {conditions.map((c, i) => (
                  <div key={c.id} className="space-y-2 rounded border p-2">
                    <label className="block">
                      Condition description
                      <Input
                        value={c.label}
                        onChange={e =>
                          setConditions(v =>
                            v.map((x, j) =>
                              j === i ? { ...x, label: e.target.value } : x
                            )
                          )
                        }
                        required
                        maxLength={2000}
                      />
                    </label>
                    <label className="block">
                      Condition category
                      <select
                        aria-label="Condition category"
                        className="block w-full rounded border p-2"
                        value={c.category}
                        onChange={e =>
                          setConditions(v =>
                            v.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    category: e.target
                                      .value as typeof c.category,
                                  }
                                : x
                            )
                          )
                        }
                      >
                        {[
                          "general",
                          "identity",
                          "license",
                          "work_authorization",
                          "visa",
                          "notice",
                          "relocation",
                        ].map(t => (
                          <option key={t} value={t}>
                            {t.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex gap-2">
                      <input
                        type="checkbox"
                        checked={c.required}
                        onChange={e =>
                          setConditions(v =>
                            v.map((x, j) =>
                              j === i ? { ...x, required: e.target.checked } : x
                            )
                          )
                        }
                      />
                      Required before joining confirmation
                    </label>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setConditions(v => v.filter((_, j) => j !== i))
                      }
                    >
                      Remove this condition
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={conditions.length >= 20}
                  onClick={() =>
                    setConditions(v => [
                      ...v,
                      {
                        id: "cond_" + crypto.randomUUID(),
                        label: "",
                        category: "general",
                        required: true,
                      },
                    ])
                  }
                >
                  Add offer condition
                </Button>
              </fieldset>
              <label className="block">
                Recruiter-fee salary basis from the agency agreement
                <select
                  name="feeBasis"
                  aria-label="Recruiter-fee salary basis"
                  required
                  className="block w-full rounded border p-2"
                  defaultValue={o?.feeBasis ?? ""}
                >
                  <option value="">
                    Choose the explicitly agreed fee basis
                  </option>
                  <option value="annual_base">Annual base only</option>
                  <option value="annual_fixed">
                    Annual base + guaranteed allowances
                  </option>
                  <option value="annual_target">
                    Annual fixed + variable annual targets, only if the agency
                    agreement permits
                  </option>
                </select>
              </label>
              <label className="block">
                Evidence for this agreed agency-fee basis
                <Textarea
                  name="feeEvidence"
                  required
                  minLength={8}
                  maxLength={2000}
                  defaultValue={o?.feeBasisEvidence}
                />
              </label>
              <label className="block">
                Full client-authorized terms
                <Textarea
                  name="terms"
                  minLength={30}
                  maxLength={16000}
                  required
                  defaultValue={o?.terms.termsText}
                />
              </label>
              <label className="block">
                Reason for this version
                <Textarea
                  name="reason"
                  minLength={8}
                  maxLength={2000}
                  required
                />
              </label>
              <Button size="sm" disabled={busy}>
                Save exact offer draft
              </Button>
            </form>
          )}
          {o && (
            <section
              className="space-y-3 rounded border p-3"
              aria-label="Current offer version"
            >
              <p className="font-semibold">
                Offer version {o.version} · annual fixed{" "}
                {formatMoney(
                  o.terms.annualBaseMinor +
                    o.terms.annualGuaranteedAllowancesMinor,
                  o.terms.currency
                )}
              </p>
              <p className="break-all text-xs">
                Terms reference: {o.termsHash}
              </p>
              <p>
                {o.accepted
                  ? "Email-confirmed acceptance recorded"
                  : o.closed
                    ? "Offer closed"
                    : o.response
                      ? "Candidate response recorded"
                      : o.release
                        ? "Released for candidate response"
                        : "Draft awaiting owner release"}
              </p>
              <details>
                <summary>Version history</summary>
                {d.versions.map(v => (
                  <p key={v.version}>
                    Version {v.version} ·{" "}
                    {formatMoney(
                      v.terms.annualBaseMinor +
                        v.terms.annualGuaranteedAllowancesMinor,
                      v.terms.currency
                    )}{" "}
                    · {v.termsHash.slice(0, 12)}
                  </p>
                ))}
              </details>
              {!o.release && !o.accepted && !o.closed && (
                <form
                  aria-label="Request exact offer release"
                  className="space-y-2"
                  onSubmit={e => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    release.mutate({
                      id: o.id,
                      expectedVersion: o.version,
                      expectedTermsHash: o.termsHash,
                      senderIdentityId: String(f.get("sender")),
                      allowOtpEmail: f.get("otp") === "on",
                      transactionalOtp: f.get("transactional") === "on",
                      reason: String(f.get("reason")),
                    });
                  }}
                >
                  <label className="block">
                    Talent sender
                    <select
                      name="sender"
                      aria-label="Talent sender"
                      className="block w-full rounded border p-2"
                      required
                    >
                      <option value="">Choose sender</option>
                      {d.senders.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.email}
                          {s.configured ? "" : " · transport setup required"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex gap-2">
                    <input name="otp" type="checkbox" />
                    Enable candidate email-code responses
                  </label>
                  <label className="flex items-start gap-2">
                    <input name="transactional" type="checkbox" />
                    <span>
                      Authorize transactional verification messages to this
                      candidate: up to three code requests per email/day, at
                      least sixty seconds apart, with ten-minute codes. Security
                      codes may bypass normal outreach quiet hours and recipient
                      spacing; workspace mail budget and emergency stop still
                      apply.
                    </span>
                  </label>
                  <label className="block">
                    Release review evidence
                    <Textarea
                      name="reason"
                      minLength={8}
                      maxLength={2000}
                      required
                    />
                  </label>
                  <Button size="sm" disabled={busy}>
                    Request offer release owner approval
                  </Button>
                </form>
              )}
              {o.release && !o.closed && !o.response && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => reveal.mutate({ id: o.id })}
                  >
                    Reveal private response link
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => email.mutate({ id: o.id })}
                  >
                    Prepare private offer email
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => followup.mutate({ id: o.id })}
                  >
                    Enroll current offer reminders
                  </Button>
                </div>
              )}
              {link && (
                <div className="space-y-2">
                  <p className="break-all">{link}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigator.clipboard.writeText(link)}
                  >
                    Copy private response link
                  </Button>
                  <form
                    className="space-y-2"
                    onSubmit={e => {
                      e.preventDefault();
                      shared.mutate({
                        id: o.id,
                        evidence: String(
                          new FormData(e.currentTarget).get("evidence")
                        ),
                      });
                    }}
                  >
                    <label className="block">
                      Evidence that this current link was shared with the
                      candidate
                      <Textarea
                        name="evidence"
                        minLength={8}
                        maxLength={2000}
                        required
                      />
                    </label>
                    <Button size="sm" variant="outline">
                      Record existing link sharing
                    </Button>
                  </form>
                </div>
              )}
              {o.response?.decision === "counter" && !o.accepted && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={counter.isPending}
                  onClick={() =>
                    counter.mutate({
                      id: o.id,
                      reason:
                        "Owner requests a draft from the email-confirmed counter within current client-authorized bounds.",
                    })
                  }
                >
                  Draft requested counter within client bounds
                </Button>
              )}
              {counter.error && <p role="alert">{counter.error.message}</p>}
              {o.response && (
                <p>
                  Candidate response: {o.response.decision}
                  {o.response.counterAnnualFixedMinor
                    ? ` · requested annual fixed ${formatMoney(o.response.counterAnnualFixedMinor, o.terms.currency)}`
                    : ""}
                  . Email possession verified; legal identity and qualified
                  signature unverified. {o.response.note}
                </p>
              )}
              {o.accepted &&
                o.terms.conditions.map(c => (
                  <form
                    key={c.id}
                    className="space-y-2 rounded border p-2"
                    aria-label={`Review ${c.label}`}
                    onSubmit={e => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      condition.mutate({
                        id: o.id,
                        version: o.version,
                        termsHash: o.termsHash,
                        conditionId: c.id,
                        state: String(f.get("state")) as "complete",
                        evidence: String(f.get("evidence")),
                        ...(String(f.get("issuer") || "")
                          ? { issuer: String(f.get("issuer")) }
                          : {}),
                        ...(String(f.get("reference") || "")
                          ? { reference: String(f.get("reference")) }
                          : {}),
                        ...(String(f.get("valid") || "")
                          ? { validUntil: new Date(String(f.get("valid"))) }
                          : {}),
                      });
                    }}
                  >
                    <p>
                      {c.label} · {c.required ? "required" : "optional"}
                    </p>
                    <label className="block">
                      Condition review state
                      <select
                        name="state"
                        aria-label="Condition review state"
                        className="block w-full rounded border p-2"
                      >
                        <option value="complete">
                          Evidence complete for owner review
                        </option>
                        <option value="blocked">
                          Blocked or evidence revoked
                        </option>
                      </select>
                    </label>
                    {c.category !== "general" && (
                      <>
                        <label className="block">
                          Evidence issuer
                          <Input name="issuer" minLength={2} maxLength={200} />
                        </label>
                        <label className="block">
                          Document/reference
                          <Input
                            name="reference"
                            minLength={2}
                            maxLength={500}
                          />
                        </label>
                        <label className="block">
                          Evidence valid until (browser timezone)
                          <Input name="valid" type="datetime-local" />
                        </label>
                        <p>
                          Recording reviewed evidence does not independently
                          confirm a license, visa or work authorization.
                        </p>
                      </>
                    )}
                    <label className="block">
                      Condition review evidence
                      <Textarea
                        name="evidence"
                        required
                        minLength={8}
                        maxLength={2000}
                      />
                    </label>
                    <Button size="sm" variant="outline" disabled={busy}>
                      Record condition review
                    </Button>
                  </form>
                ))}
              {!o.accepted && !o.closed && (
                <form
                  className="space-y-2"
                  onSubmit={e => {
                    e.preventDefault();
                    close.mutate({
                      id: o.id,
                      version: o.version,
                      reason: String(
                        new FormData(e.currentTarget).get("reason")
                      ),
                    });
                  }}
                >
                  <label className="block">
                    Reason to withdraw this unaccepted offer
                    <Textarea
                      name="reason"
                      required
                      minLength={8}
                      maxLength={2000}
                    />
                  </label>
                  <Button size="sm" variant="outline">
                    Withdraw unaccepted offer
                  </Button>
                </form>
              )}
            </section>
          )}
          {(error ||
            authority.error ||
            draft.error ||
            release.error ||
            reveal.error ||
            email.error ||
            shared.error ||
            followup.error ||
            close.error ||
            condition.error) && (
            <p role="alert" className="break-words text-red-700">
              {error ||
                authority.error?.message ||
                draft.error?.message ||
                release.error?.message ||
                reveal.error?.message ||
                email.error?.message ||
                shared.error?.message ||
                followup.error?.message ||
                close.error?.message ||
                condition.error?.message}
            </p>
          )}
        </div>
      )}
    </details>
  );
}
