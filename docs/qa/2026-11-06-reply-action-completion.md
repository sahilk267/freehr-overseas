# Outcome-bound reply action completion

Date: 6 November 2026 (Asia/Calcutta). Target: `https://freelancehr.overseasjob.in`.

## Implementation

A completed client task has one immutable `outreach.reply_action_completed` ledger event for its inbound message and action revision. The existing workspace transaction owns completion, timer cancellation, SLA incident resolution and conversation deadline clearing. The original reviewed action, due date and notes remain in history. No second task store, queue, sender, timer or migration is added.

Owner completion requires the current message/reply/action version and a completion note. Active discovery requests must be booked or cancelled first; unused prepared responses and uncertain delivery must be resolved first. Recording task completion alone does not establish client acceptance, delivery or attendance. Exact retries preserve the original outcome. A deliberate new next action gets a fresh revision and starts incomplete.

A newly booked tentative discovery completes only its current `arrange_discovery` goal. A successful provider receipt for a bound reply response completes only a current `prepare_response` goal. The receipt transaction uses the existing workspace lock and persists the provider acceptance and task outcome together. A changed reply, recipient, permission or action during the network call preserves the known provider receipt and skips stale completion. Unknown outcomes stay in reconciliation and never complete the task. Sending an availability email does not satisfy a discovery booking goal; sending a question does not establish that requirements were clarified.

The client reply panel shows the completion reason and time, supports explicit completion and saving a new action, and refreshes asynchronous outcomes. Completed task forms remount so an old due date cannot silently reappear on the next task. A completed goal cannot authorize another discovery request or reply draft without a fresh reviewed action.

MySQL verification also exposed a legacy deadline backfill edge: whole-second rounding could skip an otherwise matching reviewed due action. New conversation deadlines explicitly truncate to a whole second; compatibility matching allows the less-than-one-second storage projection difference. The scheduled job retains the original precise deadline. A deterministic rounded-date regression covers this case.

## Validation

The final full suite passed 712 tests (57 skipped), and all 450 disposable-MySQL regressions passed across 25 files. TypeScript, production build, all four hosting entry checks and tracker consistency passed. Tests cover completion/deadline races, transactional audit rollback, exact retries, workspace/role separation, pending workflow containment, task reopening, changed replies/recipients during provider calls, unknown outcomes and legacy rounded deadlines. Provider calls in delivery tests are synthetic mocks; actual recipient delivery is not claimed. Live acceptance on `d67006d`: desktop owner completion and idempotent retry, mobile fresh-action deadline reset and stale-version rejection, anonymous availability submission without premature completion, real-calendar admission and tentative booking completion, exact booking replay and completed-goal authority rejection passed. Calendar mirroring was disabled, no invitation/email was sent; cleanup is recorded in the [sanitized evidence](2026-11-06-reply-action-completion-evidence.json). The historical reconciliation increment passed the full 717-test suite (60 skipped) and all 458 disposable-MySQL regressions. Its duplicate scan, audit rollback, stale/cancelled source, unverified sent-state and SQL marker-correlation checks passed. The final worker-result integration check passed 59 focused tests (8 SQL-only skips), followed by typecheck, build, four hosting entry checks and tracker validation. Positive historical-production completion is not claimed; no production ledger was altered to simulate an old record. No actual recipient mail is authorized by this QA increment.

## Historical reconciliation increment

A second increment adds bounded historical reconciliation in the existing worker. It requires the canonical tentative booking and booking event plus unchanged request source, or an owned sent dispatch, stored provider acceptance, bound prepared response and unchanged approved content. Bare sent states, cancelled meetings, superseded goals, changed recipients/permission and uncertain outcomes cannot satisfy completion. Per-source ledger markers and workspace locks prevent duplicate processing; the receipt query uses a separate marker-table alias to preserve SQL correlation before applying its limit. No message is resent, no meeting is rebooked and no provider write is made. This source runs before deadline recovery and queue dispatch so matching historical outcomes can close their old timers before escalation. The heartbeat includes source counts even when no eligible historical outcome exists. Validation is recorded with this increment.

## Remaining scope

Actual recipient delivery, identity/attendance confirmation, broader lead-stage SLA policies, stakeholder mapping and the remaining advanced roadmap stay open.
