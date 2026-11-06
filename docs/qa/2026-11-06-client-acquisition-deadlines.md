# Discovery expiry and reviewed client reply deadlines

Date: 6 November 2026 (Asia/Calcutta). Target: `https://freelancehr.overseasjob.in`.

## Behavior

The shared automation batch now closes overdue pending/responded discovery requests. The transaction revokes their capability, cancels unused prepared email approvals and queued slot selection, and creates one owner exception only while the original reply/action/contact permission is current. Existing no-slot incidents are reused. Stale sources close without a chase alert. Booked meetings and attempted/uncertain email delivery are preserved. Replacement requests and owner cancellation resolve the old exception. A replacement also closes its expired predecessor before a later poll can escalate obsolete work.

Saving a reviewed client reply action with a due date schedules one deterministic `client_reply_deadline` job in the existing queue. It binds message ID, reply revision, action revision and action hash. Its execution checks current reply evidence, permission, suppression, workspace pause and emergency stop. It raises an owner exception, without sending a message or accepting/booking anything. New replies and revised actions resolve the previous exception and cancel unused timers. Clearing the due date records completion of this deadline; closing no-interest/stop-contact actions creates no deadline job. Immutable action history retains the due date and notes.

A bounded one-time compatibility pass schedules reviewed overdue actions recorded before these jobs existed. It requires a current action and a matching conversation deadline; legacy dates alone cannot authorize an escalation. The pass uses the same job identity as new action saves, with transaction locks and a terminal ledger marker. Conversation timestamps have second precision, so comparison deliberately normalizes both values to seconds. No new migration, timer loop, sender or incident store is introduced.

Exceptions link directly to the owned discovery request or client reply conversation. The reply panel explains deadline escalation and completion.

## Validation

Local verification: 435 real-MySQL regressions across 25 files passed, including duplicate expiry/SLA execution and expiry audit rollback. Final focused checks passed 67 tests (9 SQL-only skips). TypeScript, production build, hosting entry checks and tracker consistency passed. The final full suite passed 698 tests with 55 skips. Live acceptance is pending deployment; production expiry and actual recipient delivery are not yet claimed.

## Remaining scope

This is scoped discovery request expiry and owner-reviewed reply task escalation. Configurable lead-stage SLA policies, attendance/identity confirmation, RSVP ingestion, stakeholder mapping and actual recipient mail delivery remain open. No complete roadmap module is claimed.
