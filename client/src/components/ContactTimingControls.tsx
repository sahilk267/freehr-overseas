import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatZonedDateTime, zonedDateTimeToUtc } from "@shared/dateTime";
export function ContactTimingControls({ planId }: { planId: string }) {
  const utils = trpc.useUtils(),
    q = trpc.contactTiming.read.useQuery({ planId }, { retry: false }),
    [reviewedRevision, setReviewedRevision] = useState<number | null>(null),
    [messageId, setMessageId] = useState(""),
    [quote, setQuote] = useState(""),
    [timezone, setTimezone] = useState("Asia/Kolkata"),
    [notBefore, setNotBefore] = useState(""),
    [until, setUntil] = useState(() =>
      formatZonedDateTime(new Date(Date.now() + 30 * 86400000), "Asia/Kolkata")
    ),
    [windowEnabled, setWindowEnabled] = useState(false),
    [start, setStart] = useState("09:00"),
    [end, setEnd] = useState("17:00"),
    [businessDaysOnly, setBusinessDaysOnly] = useState(true),
    [preferredChannel, setChannel] = useState<
      "email" | "phone" | "sms" | "whatsapp"
    >("email"),
    [language, setLanguage] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  const load = () => {
    if (!q.data) return;
    const record = q.data.record,
      f = record?.active ? record.fields : null,
      tz = f?.timezone ?? "Asia/Kolkata";
    setReviewedRevision(q.data.revision);
    setMessageId(record?.messageId ?? "");
    setQuote(record?.sourceQuote ?? "");
    setTimezone(tz);
    setNotBefore(
      f?.notBefore ? formatZonedDateTime(new Date(f.notBefore), tz) : ""
    );
    setUntil(
      formatZonedDateTime(
        f?.validUntil && new Date(f.validUntil) > new Date()
          ? new Date(f.validUntil)
          : new Date(Date.now() + 30 * 86400000),
        tz
      )
    );
    setWindowEnabled(Boolean(f?.window));
    setStart(f?.window?.start ?? "09:00");
    setEnd(f?.window?.end ?? "17:00");
    setBusinessDaysOnly(f?.window?.businessDaysOnly ?? true);
    setChannel(f?.preferredChannel ?? "email");
    setLanguage(f?.preferredLanguage ?? "");
    setError("");
  };
  useEffect(() => {
    if (q.data && reviewedRevision === null) load();
  }, [q.data]);
  const refresh = () => {
      utils.contactTiming.read.invalidate({ planId });
      utils.followups.invalidate();
    },
    save = trpc.contactTiming.save.useMutation({
      onSuccess: r => {
        setReviewedRevision(r.revision);
        setSaved(
          "Recipient timing recorded. Inbound replies still pause sequences; explicit resume and any new bounded sending authority remain separate."
        );
        refresh();
      },
      onError:()=>{utils.contactTiming.read.invalidate({planId});},
    }),
    retire = trpc.contactTiming.retire.useMutation({
      onSuccess: r => {
        setReviewedRevision(r.revision);
        setSaved(
          "Restriction explicitly retired. This does not restore withdrawn consent, active sending grants or closed workflows."
        );
        refresh();
      },
      onError:()=>{utils.contactTiming.read.invalidate({planId});},
    }),
    stale =
      q.data &&
      reviewedRevision !== null &&
      q.data.revision !== reviewedRevision,
    source = q.data?.sources.find((s: any) => s.id === messageId);
  return (
    <section
      aria-label="Recipient contact timing"
      className="space-y-3 rounded border bg-slate-50 p-4"
    >
      <h3 className="text-lg font-semibold">Recipient contact timing</h3>
      <p className="text-sm">
        Record an exact inbound quotation and your reviewed interpretation of a
        return date or contact window. These restrictions apply to the same
        recipient email across this workspace. They do not grant contact
        permission, resume a paused plan, change templates or send through an
        unconfigured channel.
      </p>
      {q.error && <p role="alert">{q.error.message}</p>}
      {q.data && (
        <>
          <p className="text-sm">
            Timing status: {q.data.status} · revision {q.data.revision}.
          </p>
          <p className="text-sm">
            Timing-only preview:{" "}
            {q.data.timingIssue ??
              (q.data.nextPermittedAt
                ? new Date(q.data.nextPermittedAt).toLocaleString()
                : "Unavailable")}
            . Other consent, source, budget and workflow checks still apply.
          </p>
          <p className="text-xs">
            {q.data.authenticity} Already admitted or uncertain provider
            attempts cannot be recalled.
          </p>
          {stale && (
            <p role="alert" className="text-amber-800">
              Timing changed. Your draft remains intact. Load and review the
              current restriction before another save.
            </p>
          )}
          <Button type="button" variant="outline" onClick={load}>
            Review current timing revision
          </Button>
          <form
            aria-label="Record recipient timing"
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={e => {
              e.preventDefault();
              try {
                setError("");
                save.mutate({
                  planId,
                  expectedRevision: reviewedRevision ?? 0,
                  messageId,
                  sourceQuote: quote,
                  fields: {
                    timezone,
                    validUntil: zonedDateTimeToUtc(until, timezone),
                    ...(notBefore
                      ? { notBefore: zonedDateTimeToUtc(notBefore, timezone) }
                      : {}),
                    ...(windowEnabled
                      ? { window: { start, end, businessDaysOnly } }
                      : {}),
                    preferredChannel,
                    ...(language.trim()
                      ? { preferredLanguage: language.trim() }
                      : {}),
                  },
                  reason,
                });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <label>
              Received inbound source
              <select
                aria-label="Timing inbound source"
                className="block w-full rounded border bg-white p-2"
                required
                value={messageId}
                onChange={e => {
                  setMessageId(e.target.value);
                  setQuote("");
                }}
              >
                <option value="">Choose received inbound record</option>
                {messageId &&
                  !q.data.sources.some((m: any) => m.id === messageId) && (
                    <option value={messageId}>
                      Previously recorded source; choose a current received
                      record
                    </option>
                  )}
                {q.data.sources.map((m: any) => (
                  <option key={m.id} value={m.id}>
                    {new Date(m.createdAt).toLocaleString()} · {m.id.slice(-6)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Recipient timezone
              <Input
                aria-label="Recipient timing timezone"
                value={timezone}
                onChange={e => setTimezone(e.target.value)}
                required
              />
            </label>
            {source && (
              <p className="whitespace-pre-wrap break-words rounded border bg-white p-2 text-xs sm:col-span-2">
                {source.body}
                {source.truncated ? " [Preview truncated]" : ""}
              </p>
            )}
            <label className="sm:col-span-2">
              Exact supporting quotation
              <Textarea
                aria-label="Timing source quote"
                value={quote}
                onChange={e => setQuote(e.target.value)}
                minLength={4}
                maxLength={800}
                required
              />
            </label>
            <label>
              Do not contact before, in recipient timezone
              <Input
                aria-label="Recipient return time"
                type="datetime-local"
                value={notBefore}
                onChange={e => setNotBefore(e.target.value)}
              />
            </label>
            <label>
              Review expiry, in recipient timezone
              <Input
                aria-label="Recipient timing review expiry"
                type="datetime-local"
                value={until}
                onChange={e => setUntil(e.target.value)}
                required
              />
            </label>
            <label>
              Preferred channel
              <select
                aria-label="Recipient preferred channel"
                className="block w-full rounded border bg-white p-2"
                value={preferredChannel}
                onChange={e =>
                  setChannel(e.target.value as typeof preferredChannel)
                }
              >
                <option value="email">Email</option>
                <option value="phone">
                  Phone — withhold recruitment email
                </option>
                <option value="sms">SMS — withhold recruitment email</option>
                <option value="whatsapp">
                  WhatsApp — withhold recruitment email
                </option>
              </select>
            </label>
            <label>
              Recorded language preference
              <Input
                aria-label="Recipient preferred language"
                value={language}
                onChange={e => setLanguage(e.target.value)}
                maxLength={35}
              />
            </label>
            <label className="sm:col-span-2">
              <input
                type="checkbox"
                checked={windowEnabled}
                onChange={e => setWindowEnabled(e.target.checked)}
              />{" "}
              Restrict to a recipient contact window. It is intersected with
              existing quiet hours; overnight windows are supported.
            </label>
            {windowEnabled && (
              <>
                <label>
                  Window start
                  <Input
                    aria-label="Recipient window start"
                    type="time"
                    value={start}
                    onChange={e => setStart(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Window end, exclusive
                  <Input
                    aria-label="Recipient window end"
                    type="time"
                    value={end}
                    onChange={e => setEnd(e.target.value)}
                    required
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={businessDaysOnly}
                    onChange={e => setBusinessDaysOnly(e.target.checked)}
                  />{" "}
                  Monday to Friday in the recipient timezone
                </label>
              </>
            )}
            <label className="sm:col-span-2">
              Review reason
              <Textarea
                aria-label="Recipient timing review reason"
                value={reason}
                onChange={e => setReason(e.target.value)}
                minLength={8}
                maxLength={2000}
                required
              />
            </label>
            <Button
              disabled={save.isPending || stale || reviewedRevision === null}
            >
              Record timing restriction
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={
                retire.isPending ||
                stale ||
                !q.data.record?.active ||
                reason.trim().length < 8
              }
              onClick={() =>
                retire.mutate({
                  planId,
                  expectedRevision: reviewedRevision ?? 0,
                  reason,
                })
              }
            >
              Explicitly retire restriction
            </Button>
          </form>
          {q.data.moreSources && (
            <p className="text-xs">
              The latest 20 received source records are shown. Older source
              selection is not available here.
            </p>
          )}
        </>
      )}
      {(error || save.error || retire.error) && (
        <p role="alert" className="text-red-700">
          {error || save.error?.message || retire.error?.message}
        </p>
      )}
      {saved && <p role="status">{saved}</p>}
    </section>
  );
}
