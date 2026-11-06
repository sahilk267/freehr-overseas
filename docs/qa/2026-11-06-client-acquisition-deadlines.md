# Discovery expiry and reviewed client reply deadlines

Date: 6 November 2026 (Asia/Calcutta). Target: `https://freelancehr.overseasjob.in`.

## Behavior

The shared automation batch now closes overdue pending/responded discovery requests. The transaction revokes their capability, cancels unused prepared email approvals and queued slot selection, and creates one owner exception only while the original reply/action/contact permission is current. Existing no-slot incidents are reused. Stale sources close without a chase alert. Booked meetings and attempted/uncertain email delivery are preserved. Replacement requests, successful tentative booking and owner cancellation resolve the old exception. A replacement also closes its expired predecessor before a later poll can escalate obsolete work.

Saving a reviewed client reply action with a due date schedules one deterministic `client_reply_deadline` job in the existing queue. It binds message ID, reply revision, action revision and action hash. Its execution checks current reply evidence, permission, suppression, workspace pause and emergency stop. It raises an owner exception, without sending a message or accepting/booking anything. New replies and revised actions resolve the previous exception and cancel unused timers. Clearing the due date records completion of this deadline; closing no-interest/stop-contact actions creates no deadline job. Immutable action history retains the due date and notes.

A bounded one-time compatibility pass schedules reviewed overdue actions recorded before these jobs existed. It requires a current action and a matching conversation deadline; legacy dates alone cannot authorize an escalation. The pass uses the same job identity as new action saves, with transaction locks and a terminal ledger marker. Conversation timestamps have second precision. The subsequent reply-action completion increment fixes legacy MySQL rounding by accepting the sub-second projection difference and writing new conversation deadlines at an explicit whole second; job execution still uses the original exact reviewed due date. No new migration, timer loop, sender or incident store is introduced.

Exceptions link directly to the owned discovery request or client reply conversation. The reply panel explains deadline escalation and completion.

## Validation

Local verification: 435 real-MySQL regressions across 25 files passed, including duplicate expiry/SLA execution and expiry audit rollback. Final focused checks passed 67 tests (9 SQL-only skips). TypeScript, production build, hosting entry checks and tracker consistency passed. The final full suite passed 698 tests with 55 skips. [Sanitized live evidence](2026-11-06-client-acquisition-deadlines-evidence.json) records deployed code `a189538` on the exact domain. Personal owner login, one deterministic action save/retry, actual managed worker escalation without a manual run command, desktop Exceptions navigation, mobile due-date completion/resolution, future action versioning and opt-out timer cancellation passed. Browser runtime errors: zero. Synthetic contacts/campaigns were suppressed/cancelled, no deadline remained queued/open, and the persistent worker was enabled with a recent heartbeat and no error. No recipient mail or invitation was sent.

Positive production discovery expiry was not run: requests have a one-hour minimum lifetime. Expiry/reuse/mail containment, booked-meeting preservation, rollback and concurrency passed locally and on disposable MySQL. This does not claim actual recipient delivery. The post-review booking fix additionally closes a previous no-slot incident when a later fresh proposal succeeds; 30 focused tests (5 SQL-only skips), all 35 tests in that file on disposable MySQL, types, build and four hosting entry checks passed. The provider-backed booking transition was not repeated live.

## Remaining scope

This is scoped discovery request expiry and owner-reviewed reply task escalation. Configurable lead-stage SLA policies, attendance/identity confirmation, RSVP ingestion, stakeholder mapping and actual recipient mail delivery remain open. No complete roadmap module is claimed.
