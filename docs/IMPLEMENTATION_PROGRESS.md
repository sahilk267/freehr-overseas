# Automation implementation progress

Updated 6 November 2026 (Asia/Calcutta). This record tracks implementation against [the approved master plan](freehr-module-master-plan.md) and [the code audit](freehr-automation-review.md). It does not declare the 25-module roadmap complete.

## Current increment: versioned job intake and requirement clarification

[Versioned job intake report](qa/2026-11-06-versioned-job-intake.md) records canonical create retries, immutable requirement history, draft-only optimistic edits and pipeline locking. Explicit compensation units and hiring facts feed one completeness/checklist evaluator used by list and detail views. Draft changes invalidate derived match confidence and stale queued result application; salary compatibility stays unverified without candidate pay-period evidence. Owner confirmation statements are version-bound and explicitly unauthenticated. Local validation: 745 tests passed (64 skips), all 490 real-MySQL regressions across 26 files passed, and types/build/four hosting entry smokes/tracker checks passed. Desktop/mobile creation, legacy adoption, historical snapshots, stale/no-op save guards and API permission/input checks passed live on `c75b9dc`, with cancelled synthetic drafts and a suppressed company. The pre-approval clarification return/reset control also passed live mobile checks on `a4b5dba`, including fresh-statement enforcement and synthetic cleanup. No full roadmap module is complete.

## Current increment: outcome-bound reply task completion

[Reply action completion report](qa/2026-11-06-reply-action-completion.md) records immutable task outcomes and explicit owner completion. Tentative discovery booking and provider acceptance of a matching prepare-response goal can close the exact reviewed task, its timer and SLA incident. Stale replies/actions/recipients cannot complete a newer goal; uncertain delivery remains in reconciliation. No attendance or recipient delivery claim is made. Local validation: 712 tests passed (57 skips), all 450 real-MySQL regressions passed, and types/build/four entry smokes/tracker checks passed. Live owner/browser completion and real-calendar-admitted tentative booking closure passed on `d67006d`, with no recipient send/invitation. Historical outcome reconciliation reuses the same worker and ledger; the final full suite passed 717 tests (60 skips) and all 458 real-MySQL regressions passed. Positive historical-production completion remains unverified; no production ledger was changed for QA. The advanced roadmap remains in progress.

## Current increment: discovery expiry and reviewed reply deadlines

[Client acquisition deadline report](qa/2026-11-06-client-acquisition-deadlines.md) records expiry containment through the shared worker and version-bound reply SLA jobs through the existing queue. One incident per current action/request, no-slot incident reuse, stale source checks, compatibility backfill, owner completion/revision and direct exception navigation are implemented. Booked meetings and uncertain dispatch reconciliation are preserved. The full suite passed 698 tests with 55 skips, and SQL verification passed 435 regressions; focused checks, types, build and hosting entry checks passed. Actual managed SLA escalation, desktop/mobile task completion and opt-out cancellation passed live on `a189538`, with synthetic cleanup and no recipient mail. Positive production request expiry was not run (minimum one-hour expiry); its SQL checks passed. A final booking fix also resolves an earlier no-slot exception when booking later succeeds. No complete module is claimed.

Earlier checkpoints below retain their original validation date and scope.

## Latest live checkpoint: scheduling controls and healthy AI credentials

[Recorded interview scheduling report](qa/2026-11-01-interview-scheduling.md) covers candidate overlap rejection, durable create-request retries, consistent reschedule/cancel/reminder versions and atomic old-follow-up invalidation. The schedule preview is live at desktop/mobile sizes; external calendar/participant availability remains unverified. Initial API/UI checks and the durable replay follow-up passed on deployed builds `52dbcef` and `b33f514`. All tentative QA appointments were cancelled and the queue is terminal. No email was sent.

Both distinct OpenRouter credentials authenticated successfully in the latest provider check, superseding the earlier rejected backup. Current validation: 450 tests pass, 19 skip; 164 real-MySQL regressions, TypeScript/build and four entry smokes pass. Three M18 feature records remain partial and no complete advanced module is claimed.

## Earlier credential and quality checkpoint

[Live AI health and pilot report](qa/2026-11-01-ai-credential-quality-checks.md): primary key verified, backup key rejected by the provider despite being configured. Owner correction in hPanel is still required. Synthetic CV text extraction, missing-evidence matching and the corrected outreach-draft retest passed; initial empty/schema-invalid outputs were rejected and retained in evidence. Control Plane now supports credential verification. No email or real business record was affected. Final validation: 436 passing tests, 16 skips, typecheck/build and four entry smokes passed.

## Earlier live AI checkpoint

[Free-only OpenRouter verification](qa/2026-11-01-free-ai-setup.md) confirms the hPanel key works: a synthetic queue job completed using `nvidia/nemotron-3.5-super-vl:free`, with validated JSON and no linked candidate/conversation or outgoing message. Code `6ded24b` blocks paid/built-in fallback routes. 423 tests pass, 16 skip; typecheck/build pass. Earlier missing-OpenRouter-key statements below are historical. Other task pilots, shared provider-request budgeting and the broader agency modules remain open.

## Earlier live Mail API checkpoint

The owner saved the real token in hPanel. [Live setup verification](qa/2026-11-01-mail-setup.md) resolved all six authorized mailbox IDs, verified and activated the matching senders. No email was sent. The older missing-Mail-token finding below is historical; Remaining business-module gaps remain open; see the newer AI checkpoint above.

## Earlier increment: W4 source intake, campaigns and managed processing

The [W4 implementation and validation report](qa/2026-11-01-w4-automation.md) records scoped source keys, reviewed CSV/JSON imports, conservative canonical identity reuse, four governed campaign scenarios and an observable production Node background worker. Campaigns reuse the existing follow-up plans, scoped grants, outbox and physical queue. Existing manual creation shares the same identity commands. No second delivery engine or fictional provider success was introduced.

Validation: 419 passing tests with 16 skips, 147 passing real-MySQL regressions, 15 passing browser assertions, TypeScript/build success, four Hostinger entry smokes and a concurrent/repeated reviewed 15-to-19 migration upgrade. Positive local browser execution used disposable synthetic sender data; no real email or funds were sent. The router now contains 158 procedures. npm is the canonical package manager and the production audit has zero critical/high findings, with nine moderate/low package findings remaining. Deployment/live observations are recorded in the dated W4 report.

Code `9a53318` was pushed to `main` and verified live on the exact domain. All 155 anonymous protected-procedure guards, 39 default session/owner reads, public health, synthetic source replay/deduplication/key revocation and campaign safety checks passed. Eight live browser assertions passed. Managed processing is enabled and actual fresh heartbeats advanced after the test browsers closed; safe mode and existing limits were preserved, with all sender identities disabled. Mail token/mailbox IDs and OpenRouter credentials remain absent. [Current procedure coverage](qa/2026-11-01-api-coverage.csv) distinguishes these checks from historical positive workflows.

Eight partial feature records were updated and the CSV backlog synchronized; no complete module is claimed. Real external sourcing, reply-to-booking, agreements, portals, adaptive screening, calendar negotiation, checkout/reconciliation and retention/replacement still need work and provider verification. Historical checkpoints below retain their original observations; current installation uses `npm ci` and the reviewed schema release through 0018.

## Previous live verification: personal owner login and recruitment-to-receipt QA

The deployed target is `https://freelancehr.overseasjob.in`, using personal owner-password authentication without Google login and a persistent MySQL database migrated through 0014. Earlier deployment/connector notes below describe their historical checkpoints, not the current live setup.

Code fixes `6037e15` and `cd0e315` were pushed to `main` and retested live: prospect progression, preserved failed form drafts, actual client confirmation, independent evidence matching, combined candidate search filters, selected-timezone interviews, placement controls, stable queue idempotency, hosting-compatible sender registration, truthful readiness/scheduler errors and mobile Finance/Control layout.

The [dated end-to-end report](qa/2026-10-31-e2e-report.md) maps all 25 planned modules and links every one of the 142 current API procedures. All 139 protected-procedure anonymous guards, 36 authenticated default reads and public health passed. The consolidated browser set has 46 passing assertions. Local validation recorded 370 passing tests with 14 skips, 91 passing targeted MySQL tests, an additional concurrent-receipt locking check, TypeScript/build success and four entry smokes.

The report explicitly distinguishes 120 representative live-verified procedures, five guard-only procedures and 17 with blocked provider/prerequisite-dependent positive flows. Mail credentials/mailbox IDs and OpenRouter credentials are absent; no unattended scheduler or real checkout adapter is proven. The pnpm lock graph also has unresolved dependency advisories and differs from Hostinger's npm resolution. These remain open; this QA does not certify a fully autonomous recruiter or a clean security audit. Synthetic data/audit history remains labelled, QA senders and memberships are disabled/revoked, and effective operating settings/policy content were restored. No actual email or funds were sent.

## Hostinger deployment follow-up: entry and empty-database handoff

The supplied Hostinger build for `cb8bf4a` successfully installed dependencies and compiled the application, then failed because its configured entry was root `server.js`. The release now supplies that stable entry and declares it in package metadata. It calls the same compiled Fastify startup as the existing direct artifact; it defaults to production mode and keeps missing database/OIDC configuration blocking. The frontend production build defaults to the matching OIDC login route.

A generated [phpMyAdmin import](../deploy/hostinger-empty-database.sql) derives migrations 0000–0014 and their exact hashes/timestamps from the canonical journal. Import it once only into a selected empty database. [The blank production environment template](../deploy/hostinger.env.example) and [owner steps](../OWNER_HOSTINGER_DEPLOYMENT_STEPS.md) distinguish build, schema import, real credentials, runtime startup and live login. Previous guidance to import only nine migration files or defer standalone production OIDC was corrected.

Verified locally: TypeScript and `npm run build` passed; 21 targeted Hostinger/runtime regressions and 25 route checks passed. The built-entry smoke verifies root entry/PORT/UI/protected dashboard, missing-database rejection and compatibility of direct `dist/hostinger.js`. SQL import created 38 tables whose column definitions match a fresh canonical migration run; the normal migration command then kept exactly 15 ledger entries without replaying schema. Root production startup also passed against that disposable MySQL database with synthetic OIDC configuration; missing OIDC credentials remained blocked. This does not verify a real OIDC login or alter the user's Hostinger database/environment.

The GitHub push makes the fix available to the connected deployment; live Hostinger build/startup confirmation remains separate. Local evidence is retained at `/workspace/freehr-hostinger-entry-validation`.

### Production environment preparation and connector access

The deployment template now carries 47 production settings, reusing the application URLs, intended owner, Google issuer and mailbox addresses from `.env.example`. `npm run env:hostinger` creates private, Git-ignored `.env.hostinger` with independent random 32-byte session, cron and webhook secrets. Existing real values survive repeat runs; explicit nonblank source values can update their corresponding key. Example passwords/client credentials/private paths and development-only settings are filtered out. The helper validates production URLs, preserves dotenv quoting, rejects public/template or symlink output, writes atomically with file permission 0600 and reports key names without secret values.

Six focused CLI tests passed, covering real file creation, source import, secret stability, provider-value preservation, quoting, permissions, placeholder filtering and rejected writes/values. The actual private file was generated and a second preparation was byte-for-byte unchanged. Its remaining initial setup keys are `DATABASE_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and the server's `PRIVATE_LOCAL_STORAGE_PATH`. Optional Mail API/OpenRouter credentials and mailbox IDs also remain provider-dependent. No completed private file or generated secret is committed.

Hostinger's [official remote MCP server](https://github.com/hostinger/api-mcp-server#quick-start-hosted-remote-server) is `https://mcp.hostinger.com`, using client OAuth authorization. Its account tools are not currently connected in this session. Account deployment, environment updates and database operations cannot be claimed performed; they require the authenticated connector and capability checks. Cloud-environment onboarding configuration does not provide Hostinger account authorization.

## Current increment: W3 invoice collections and payment promises

The increment labels in this record identify delivered code slices. They do not certify completion of the broader delivery waves with similar labels in the master plan.

Implemented in code:

- Finance now has a paginated receivables ledger with due-date aging, recorded receipts, remaining balance, payment promises and collection holds. Buckets use the workspace timezone. Loaded-page totals are separated by currency and labeled with their scope; they are not a consolidated accounting report. Inconsistent receipt currency/balance evidence is quarantined for review.
- Collection automation is an explicit owner opt-in for an issued, collectible invoice with an agreed due date, a contact from its actual company and a finance sender. Versioned settings include calendar-day grace, one to three messages, owner hold and a reason. Stale settings are rejected. The owner must review the latest client replies before establishing another cycle.
- The source adapter enrolls overdue balances as FU26 and missed recorded payment promises as FU27 in the existing M06 follow-up engine. Every new sequence starts in review. Exact amount/currency, receipts and due dates are used in deterministic messages; neither model confidence nor an AI quota is needed. The former AI reconciliation status writer is now advisory only, including for high-confidence overdue suggestions and already-paid invoices.
- Automatic sequences wait three and then four calendar days after the preceding accepted message, subject to weekdays, quiet hours, spacing and caps in the shared gateway. Configured per-invoice message limits also apply to owner enrollment/replan. One active sequence owns an invoice across FU26/FU27, recipients and revisions; manual enrollment and W2 edits cannot create a competing collection sequence.
- Payment promises are separate, owner-recorded client evidence with an amount, currency, agreed time and an explicit acknowledgment that the promise is not a receipt or cleared funds. Idempotency binds the full command; a repeated identical command returns its prior result, while changed evidence under that key conflicts. Concurrent replacements are serialized and require the expected active promise.
- A promise holds collection until its deadline. Only newly recorded successful receipts since its stored baseline can meet it. Partial coverage, met, met late, missed, superseded and cancelled states retain history. Replacing/cancelling a promise cancels its old queue deadline. Promise recording never inserts a payment or marks an invoice paid. Cumulative receipt baselines use BIGINT, independently of the single-payment integer limit.
- Partial receipts cancel stale collection authority/content and schedule evaluation of the remaining balance. Full receipts stop collection. A client reply, opt-out, suppression, owner hold, unexpired promise or unresolved dispatch independently blocks new preparation/dispatch. Changing collection settings cannot bypass unknown delivery. Pending dispute, credit or write-off requests freeze collection before the approval decision.
- Financial adjustment requests now collect actual owner-entered evidence instead of hard-coded claims. Approval execution validates the current invoice transition, so a stale approval cannot resurrect a paid invoice as disputed/overdue. Deterministic aging requires an elapsed due date and a positive receipt-backed balance; it does not infer payment or delivery.
- The source scan rotates through at most 25 enabled invoices per minute using a past-observation cursor, including held/future/failed sources. Due/grace/promise deadlines remain jobs in the one existing automation queue. There is no new sender, feature cron or second timer store. Source failures are visible in owner diagnostics, and manual evaluation reports failures explicitly.
- Owner-only settings/promise commands and a finance-role read-only ledger are wired into Finance. Failed forms preserve drafts; stale controls require explicit reload. UI distinguishes promise evidence, owner-recorded receipts and actual external settlement. Desktop and mobile flows were exercised.
- Migration 0013 adds collection intent and payment-promise records with ownership/uniqueness constraints. Migration 0014 widens cumulative receipt baselines. Both API and worker must use the same database migrated through 0014; the worker reports an actionable error when collection tables are absent.

### W3 validation

| Check | Observed outcome |
|---|---|
| Full Vitest suite | 355 passed, 13 skipped, 0 failed; 47 files (46 passed, 1 skipped) |
| Real MySQL 8.4 | 95 passed across W0 correctness, follow-up lifecycle, W2 recovery, W3 collections and email router |
| New collection scenarios | 24 passed on MySQL; 21 pass in the default suite and 3 SQL concurrency/fairness scenarios run separately |
| AI aging regression | High-confidence suggestions leave past-due, future-due and already-paid invoice state/amount/date unchanged and retain an unapplied audit suggestion |
| TypeScript | Passed |
| Production build | Passed, including dist/worker.js; existing bundle-size advisory remains |
| Hostinger verification | 25 passed, 0 failed |
| MySQL migrations | Fresh 0000–0014 install, existing-database upgrade and repeated no-op passed; BIGINT baseline verified |
| Persistent worker | Old schema rejected with migration guidance; empty migrated database and populated synthetic-fixture cycles passed; pending dispute remained held |
| Headless Chromium | Missing-due-date validation, preserved failed promise input, opt-in enrollment, exact partial receipts, promise met from receipts, remaining-balance review, hold/resume, pending-dispute freeze, reload persistence and desktop/mobile layout passed without runtime errors or horizontal overflow |

The default skips two live-credential checks and eleven database-only checks; all eleven database-only checks passed separately. Tests use a mocked email transport and browser fixtures use synthetic owner-recorded receipts. No real email, bank/gateway call or provider confirmation is claimed. Local logs/screenshots are retained at `/workspace/freehr-w3-validation`.

The latest API was restarted against the synthetic MySQL fixture database. Health, demo authentication, authenticated dashboard and persistent Finance state passed; the live email transport remains unconfigured. The cloud startup-instructions draft was saved with the current migration/test guidance; this does not apply or publish the environment.

On this shared development host, overlapping full-suite/build/SQL runs caused test timeouts. Final verification runs these workloads sequentially, with bounded workers and a 30-second per-test infrastructure timeout; assertions and global test configuration were not weakened. Reproduce the checks below against a disposable migrated database only.

## Previous increment: W2 versioned follow-up recovery

Implemented in code:

- Owner-only replan/restart commands edit an existing logical sequence. They infer the current owned recipient again, validate current permission/suppression, sender purpose, schedule and receipt evidence, and reject a collision with another canonical resource version. A completed conversation cycle can restart with a new reviewed revision. Context/resource IDs cannot be redirected through this editor.
- A new revision revokes old automatic-sending grants, cancels old pending messages/approvals/outbox tasks, resets the selected new sequence to owner review, and retains prior accepted messages as history. The editor initially includes remaining messages; it does not silently repeat previously accepted content.
- Immutable definition snapshots in the existing workflow ledger, with owner-scoped, revision-based pagination. Older W1 sequences receive their prior definition snapshot when first edited. There is no second workflow store or parallel sender.
- Explicit snooze preserves the current step, checks the deadline/current evidence, invalidates the old physical timer and creates the new revision's timer in the existing queue. Snooze returns sending authority to owner review.
- Public control, grant, replan and snooze commands require an expected revision. Stale browser tabs receive a conflict and preserve their draft; the owner can explicitly reload the latest definition. The browser-discovered editor reset during query refresh was fixed.
- An owner delivery-recovery queue includes uncertain completed attempts. The form loads the original approved recipient, recorded sender and exact message content before a finding can be saved. Owner findings retain an evidence reference, explanation, actor and acceptance time where relevant.
- Inconclusive findings keep the attempt blocked. Recorded acceptance advances the current step exactly once and leaves the sequence paused. Recorded non-acceptance preserves the current step; any later send requires explicit resume/replan and a new approval. The original authorization remains consumed and its cap reservation is retained.
- Owner findings use `accepted_recorded` / `not_accepted_recorded`, distinct from provider acceptance and delivery. No provider ID, `sentAt`, `deliveredAt`, or successful network response is invented. Conflicting final findings are rejected; identical replay is idempotent.
- In-flight and interrupted `dispatching` attempts cannot be adjudicated through this form or bypassed with an edit/snooze. Worker fencing and crash adjudication remain separate operational work. Empty Sent-folder results and timeouts never prove non-acceptance.
- Candidate erasure also redacts the new definition/history and owner-reconciliation evidence. Minimal outcome and resolution hashes remain for idempotency. An erased definition cannot be restarted. This does not complete the broader communications/provider retention inventory.
- Corrected ordering in the development database adapter so paginated history and priority ordering reflect actual column direction; the SQL behavior is separately exercised on MySQL.

### W2 validation

| Check | Observed outcome |
|---|---|
| Full Vitest suite | 334 passed, 10 skipped, 0 failed; 46 files (45 passed, 1 skipped) |
| Real MySQL 8.4 | 71 passed across W0 correctness, follow-up lifecycle, W2 recovery and email router; includes simultaneous edit/resolution commands |
| New recovery scenarios | 18 passed on MySQL; 16 pass in the default suite and 2 SQL concurrency scenarios run separately |
| TypeScript | Passed |
| Production build | Passed; existing bundle-size advisory remains |
| Hostinger verification | 25 passed, 0 failed |
| Headless Chromium | Version edit/history, failed-save preservation, stale-tab conflict/reload, snooze persistence, original approved-attempt context, inconclusive finding, acceptance-time validation and recorded acceptance passed; desktop/mobile had no runtime errors or horizontal overflow |

The default skips two live-credential checks and eight database-only checks; all eight database-only checks passed separately. Browser recovery entries and provider evidence are deliberately synthetic fixtures; no real email was sent and no real provider resolution is claimed. No new migration or external credentials are required for W2; the schema remains journaled through 0012. Local verification logs/screenshots are retained at `/workspace/freehr-w2-validation`.

## Previous increment: W1 follow-ups, scoped authority and durable delivery

Implemented in code:

- One central follow-up plan with a bounded sequence of up to six exact messages, recipient timezone, optional weekdays, first/next delay, response window and deadline. The 32-scenario catalog is shared with the UI. It is a catalog, not 32 completed event integrations.
- Conversation, confirmed-interview and collectible-invoice resource guards. Enrollment infers recipients from owned candidate/contact records. Candidate communication permission, current address, opt-out/suppression, job status, schedule/version and receipt balance are rechecked before preparation and dispatch.
- Owner review is the default. Optional per-plan automatic sending binds owner, plan/revision, sender, recipient, resource evidence, exact sequence, maximum remaining sends and expiry. Pause revokes the grant and cancels pending approvals, outbox records and physical timers; resume returns to owner review.
- A durable `emailDispatches` outbox and `workflowEvents` ledger. A workspace row lock serializes authorization claims, daily limits and recipient spacing before the network call. The provider call happens outside the transaction. Acceptance receipts do not fabricate delivery receipts.
- One email gateway for manual approved messages, follow-ups and reminders. Legacy AI reminder output cannot send directly. Hostinger is called only by the gateway in these paths. Sender identity/purpose/address and content bindings are revalidated.
- Quiet-hour scheduling uses actual UTC instants and recipient local time across DST transitions; weekdays, workspace daily cap, recipient daily cap and minimum recipient spacing defer without consuming authorization. Defaults are three sends per recipient per workspace day and sixty minutes of spacing; configured policy can tighten/change them within bounds.
- Replies pause before classification; opt-out, withdrawal and do-not-contact cancel. Interview reschedule/cancel invalidates old reminders. A partial receipt cancels stale collection content and a full receipt completes collection follow-ups. Dispatch guards independently catch changed evidence even if a source hook has not run.
- Duplicate enrollment/worker execution cannot create a second dispatch for the same active step. Superseded tasks do not block a resumed revision. A provider acceptance that arrives during a pause records the accepted step so explicit resume cannot send it again. An uncertain result requires reconciliation and cannot auto-retry.
- Due confirmed interviews now enroll FU18 in review mode. Source events let bounded MySQL scans advance past enrolled schedules; blocked sources have a fifteen-minute retry window instead of starving later interviews. `reminderSentAt` is written only after provider acceptance.
- A dedicated owner-only `/follow-ups` screen supports enrollment, exact-message review/approval/rejection, bounded delegation, pause/revoke, resume, cancel, completion, activity/outbox inspection and manual due processing. Existing communication permission can be recorded with evidence and expiry. Failed saves preserve form input. Navigation contrast was corrected for the existing sidebar theme.
- A standalone `pnpm worker` / built `pnpm start:worker` process requires a real MySQL adapter and refuses process-local memory. The queue remains the only physical timer store; plan/outbox next-action timestamps are projections. Migration 0011 adds the four workflow tables; 0012 preserves millisecond queue timing.

### W1 validation

| Check | Observed outcome |
|---|---|
| Full Vitest suite | 318 passed, 8 skipped, 0 failed; 45 files (44 passed, 1 skipped) |
| Real MySQL 8.4 regressions | 53 passed across W0 correctness, follow-up workflows and the email router; includes an older-snapshot/concurrent-withdrawal regression |
| TypeScript | Passed |
| Production build | Passed, including `dist/worker.js`; existing bundle-size advisory remains |
| Hostinger verification | 25 passed, 0 failed |
| MySQL journal | Fresh 0000–0012 install, incremental 0011/0012 upgrade and repeated no-op run passed |
| Persistent worker | Built worker completed an empty disposable-database cycle; absent persistent database was rejected |
| Headless Chromium | Login, failed-enrollment preservation, review draft, bounded grant, revoke, persisted pause/resume, rejection and desktop/mobile layout passed without browser runtime errors |

The default skips two credential-dependent checks and six database-only checks (W0 concurrent receipts plus five W1 SQL/concurrency checks). All six database-only checks passed separately on MySQL. Live credential-dependent checks were not run. Existing direct-send reminder tests were replaced by central-workflow regressions and legacy-bypass rejection tests; the old behavior is deliberately unsupported.

Provider tests use synthetic recipients and a mocked transport; no real email, bank transaction, sourcing operation or production deployment was performed. Local logs/screenshots are retained at `/workspace/freehr-w1-validation`. The separate browser database contains synthetic fixtures only.

### Run the persistent worker

Apply migrations to the intended database after reviewing its existing upgrade state, then run both processes with the same `DATABASE_URL`:

```sh
pnpm db:migrate
pnpm dev           # API/UI in development
pnpm worker        # separate supervised process in a real deployment
# One bounded diagnostic cycle:
pnpm worker --once
# After pnpm build:
pnpm start:worker
```

The in-memory development adapter supports manual UI demonstrations, not durable background operation, SQL locking or correlated source exclusion. Its outer owner/status predicates are preserved when a child SQL expression is unsupported. MySQL-only tests cover correlated source filtering, concurrent enrollment/workers, single-use authorization and final daily-cap reservation.

## Previous increment: W0 correctness and access controls

Implemented:

- Protected calendar feeds in both Express and Fastify. Owner sessions or signed, owner-scoped, seven-day subscription tokens are required. Numeric owner IDs alone grant no access. Feeds exclude internal preparation notes and use actual duration/status/meeting details. UTF-8 line folding is corrected.
- Removed hard-coded developer-email ownership and production fallback to arbitrary developer/admin identities. OIDC email identities must carry a boolean verified-email claim before provisioning.
- Centralized candidate-sharing eligibility for both request routes and execution. Exact current client/job consent, candidate state and suppression are rechecked; generic shared-state mutations and stale withdrawal approvals are rejected.
- Added the missing email approval handler. Approval authorizes content without sending. Sender/recipient/content are bound by digest; changed or legacy unbound content requires a fresh approval. Atomic consumption prevents concurrent/replayed delivery. Uncertain sends require reconciliation rather than blind retry.
- Required an approved positive screening disposition for placement. Reused the existing candidate/job screening row to avoid its real-MySQL unique constraint.
- Made receipt recording transactional and idempotent. Partial payments retain an outstanding balance; excessive amounts/conflicting event reuse are rejected. Generic approvals cannot invent settlement without corresponding receipts. Amount parsing/formatting respects currency precision.
- Replaced the Finance page's unsupported mark-paid action with a checked-bank-receipt form. Added a candidate progression request form. Both preserve failed input and await successful persistence. HTTP development login now uses a browser-compatible SameSite cookie.
- Supplied stored job requirements, compensation/experience/scorecard and clean parsed CV evidence to match scoring. Low/zero confidence and missing evidence cannot be labeled evidence_validated by a contradictory AI flag.
- Made candidate and KYB document object paths immutable. CV extraction now follows a clean scan, rather than running during upload. Raw extracted CV text is reconstructed for inference, not copied into newly queued parse tasks.
- Added deletion tombstones, cancellation/redaction of directly linked queue tasks and pending decisions, late-result guards, and restartable erasure after physical-deletion failure. Generic state transitions cannot pretend to erase a candidate.
- Prevented duplicate AI-usage insertion from stranding failed work. Lost worker leases become visible blocked reconciliation cases. A local work window can continue deterministic tasks after AI quota exhaustion.
- Removed fake scheduler registration and fake payment checkout success. Missing implementations/configuration now return actionable errors without creating fictional external outcomes.
- Corrected the two pre-existing failing test fixtures and updated historical fixtures that relied on missing consent or unapproved progression.
- Repaired the fresh-install migration chain: migration 0006 replaces its foreign-key-supporting index atomically; migration 0009 is journaled and has statement boundaries; migration 0010 adds the previously unjournaled approval-consumption column. Added `pnpm db:migrate`. Existing applied migrations are not rerun; validate deployment-specific upgrade state before production use.

## W0 validation

| Check | Observed outcome |
|---|---|
| Full Vitest suite | 296 passed, 3 skipped, 0 failed; 43 files |
| Disposable real MySQL 8.4 regression run | 12 passed, including simultaneous email delivery, concurrent partial receipts, screening reuse and failed AI-result recovery |
| Journaled MySQL migrations | Fresh install, recovery from the previously failing index migration, and repeated no-op migration passed |
| TypeScript | Passed |
| Frontend/backend production build | Passed; existing bundle-size advisory remains |
| Hostinger verification script | 25 passed, 0 failed |
| Headless Chromium | Demo login, UI decision request, failed-save input preservation, exact partial receipt and remaining settlement passed; no browser runtime errors |

The default suite skips two credential-dependent tests and the MySQL-only concurrency test. The latter was separately executed with real MySQL; the live credential-dependent tests were not run. Provider sends in regressions are mocked. Browser finance fixtures are synthetic owner-recorded receipts, not real bank/gateway transactions.

Reproduce local checks from the checkout:

```sh
/workspace/.onboarding-tools/node_modules/.bin/pnpm check
/workspace/.onboarding-tools/node_modules/.bin/pnpm test --maxWorkers=2 --testTimeout=30000
/workspace/.onboarding-tools/node_modules/.bin/pnpm build
/workspace/.onboarding-tools/node_modules/.bin/pnpm test:hostinger
```

For the database regression, use only a disposable database. Apply the journaled migrations using `pnpm db:migrate` with that database's DATABASE_URL, then run:

```sh
# DATABASE_URL must refer to the disposable test database, never production.
FREEHR_TEST_MYSQL=1 ./node_modules/.bin/vitest run server/w0Correctness.test.ts server/services/followups.test.ts server/services/followupRecovery.test.ts server/services/invoiceCollections.test.ts server/routers/email.test.ts --maxWorkers=1 --no-file-parallelism --testTimeout=30000
```

## Current limits and remaining work

The W0, W1, W2 and W3 increments remain partial implementations of their advanced feature packages. No complete module or fully autonomous business is declared delivered.

- W1 adds the follow-up, scoped grant and email outbox foundations described above. It does not implement a generic event bus, all 32 lifecycle event adapters, or a full owner/client/candidate journey.
- Automatic source enrollment currently covers confirmed due interview reminders (FU18), opted-in overdue invoices (FU26), and missed owner-recorded payment promises (FU27). Other lifecycle adapters remain pending. FU26 pre-due delivery/acknowledgment and FU27 payment acknowledgment are not implemented by these sources. Opt-in and new source enrollment create review sequences; sending needs exact-message approval or a bounded per-plan grant.
- Holiday calendars, adaptive cadence, language/channel preferences, out-of-office parsing, bounce/complaint-triggered stopping, request merging, cross-workspace arbitration and handoff remain pending. Explicit owner snooze is implemented in W2. Weekdays are Saturday/Sunday exclusions, not regional holiday calendars.
- Same-context enrollment is idempotent. W2 adds explicit reviewed editing, restart and paginated definition history. Automatic repeat-cycle policies, live collaboration/merge editing and generic workflow-definition migrations remain pending.
- Delegation is scoped to one exact follow-up plan. There is no permission for unrestricted autonomous recruiting or consequential candidate, contract or financial decisions.
- The worker must run as a managed process beside the API using the same migrated MySQL database. Browser closure does not stop it. W3 adds bounded rotating collection scans; production supervision, heartbeat/lease renewal, broader cross-workspace fairness, source SLAs and deployment/recovery drills remain pending. Queue quarantine does not infer whether an interrupted external effect happened.
- Uncertain delivery is blocked for reconciliation. W2 provides owner evidence adjudication and an explicit reviewed recovery path for completed uncertain attempts. Automated provider reconciliation, stable provider-side request correlation and crash/lease fencing remain pending. A request already claimed by the provider cannot be unsent by pausing; late acceptance advances the recorded step without scheduling another action.
- Within a workspace, all gateway sends reserve its daily cap and recipient spacing under the workspace row lock. This is not a provider-wide or cross-workspace limiter. AI budget scheduling retains the bounded W0 scan rather than a full fair queue.
- Mailbox readiness now requires the sender identity to match the purpose-specific configured transport. Tests use a mocked transport; live mail delivery, delivery/bounce receipts, DNS reputation and provider outage drills remain unverified.
- Candidate sharing is still an internal state workflow, without actual client submission delivery/portal. Existing recorded permission is owner-documented evidence, not candidate-captured consent.
- Erasure stops/redacts the linked follow-up plan and protects the directly linked pipeline/queue. Cross-record PII inventory, retained communications/permission evidence/audits, provider/model copies, lawful holds and complete retention enforcement remain pending.
- W3 does not add automatic extraction of client promises, regional collection rules/holiday calendars, custom adaptive collection cadence, contract-derived billing/tax, verified invoice delivery, bank/gateway clearing, refunds/chargebacks/credit allocation, recruiter commission splits or payout eligibility. Owner-recorded receipts are evidence, not proof of external clearing.
- Calendar-provider sync, individually revocable subscriptions, candidate-job round history, rehire placements, sourcing connectors, e-sign, production OIDC, real payment checkout and bank/gateway reconciliation remain unvalidated or unimplemented as described in the master plan.
- The validation above covers local implementation checks. GitHub publication, any resulting Hostinger build, production application deployment and environment publication require separate confirmation.

## Next dependency-ordered work

1. Finish shared typed event contracts, provider-correlated reconciliation, lease fencing and remaining W0/W1/W2/W3 boundaries.
2. Add lifecycle event adapters to M06 with domain evidence/stop conditions, rather than interpreting scenario labels as complete modules.
3. Deliver the first complete owner/client/candidate recruitment journey across intake, permission, screening, submission, interview, offer, joining and actual invoice collection.
4. Expand advanced packages only when their complete acceptance gates are demonstrated; keep the registry/backlog synchronized.

## Mail configuration follow-up — 1 November 2026

The private, ignored `.env.hostinger` now contains an explicit `REPLACE_WITH_REAL_HOSTINGER_MAIL_API_TOKEN` entry for the owner to replace. Public templates show the same nonsecret marker. Real credentials belong only in the private file or hosting secret settings. Saved mailbox addresses remain intact; all six parsed resource-ID fields were empty, so no IDs were guessed from email addresses.

`npm run env:mailboxes` reads the real token from that private file and retrieves the token's authorized mailboxes through the official SDK. It matches each configured address exactly, requires all six unique mappings, preserves matching existing IDs and refuses conflicts, missing/ambiguous mailboxes or changed files. A lock and atomic private-file replacement protect the update; other secrets remain intact. It neither sends email nor imports/replaces the live hosting environment. The dummy-token dry run refused lookup without changing the file; actual provider lookup awaits the owner's real token.

Mail readiness and dispatch now reject template token/resource-ID values. Sender activation/verification checks that the token authorizes the exact configured resource ID and sender address; a successful account-level connection alone cannot activate another mailbox. Four offline mailbox-mapping tests cover order-independent matching, missing/ambiguous mappings, conflicting saved IDs and malformed/foreign values. Two additional mail regressions cover dummy credentials and exact mailbox verification. Broader W4/agency limitations remain as recorded above.

Validation for this follow-up: 421 Vitest passes, 16 skips, four standalone mapping tests passed, TypeScript and production build passed. No live Mail API request or hosting environment replacement was made with the placeholder.

## Live-token mailbox discovery — 1 November 2026

The owner saved the Mail API token in hPanel, confirmed by live readiness (`tokenConfigured=true`); the workspace's private env retains its dummy token. No live token was copied, printed or replaced. All six live resource-ID fields were still absent before this increment.

Production entry points and the standalone worker now resolve missing resource IDs through the token's authorized mailbox inventory, matching exact configured addresses in the approved domain. Only unique matches are bound in that process. Existing conflicting IDs are retained and reported; missing or ambiguous mailboxes cannot activate a sender. Discovery repeats on restart and can be retried from the owner-only Control Plane action. This uses the token already held on the server and does not rewrite the hosting environment or send messages. A provider outage leaves the app available and mail configuration blocked. The new authenticated `email.discoverMailboxes` route returns only configured-address mapping outcomes, not the token or unrelated mailboxes.

The control panel explains runtime-only bindings and provides visible discovery outcomes. A regression verifies exact matching, preserved conflicting IDs and refused missing mappings. Historical W4 API inventory predates this one added procedure.

## OpenRouter free-only routing — 1 November 2026

Live readiness confirms the owner added the OpenRouter key in hPanel. All controlled AI jobs now use `openrouter/free` or an explicit provider/model `:free` ID. Legacy built-in/paid preferences are mapped to the free router; paid fallback entries are removed. The lower-level OpenRouter adapter independently rejects paid primary/fallback requests before network access, so a default alone cannot be bypassed by a route setting. No built-in provider discovery or model execution occurs in controlled recruitment AI routing.

Requests explicitly ask for JSON and include the task's actual output schema; returned JSON is still validated before result application. Free-provider rate limits and outages continue through the existing durable queue/retry and owner-review paths. This does not establish a new account-wide rate limiter or an unlimited quota. The existing daily AI job budget remains; fallback attempts can consume multiple provider requests per job.

Local validation: 423 tests pass, 16 skipped, TypeScript and production build pass. Tests verify paid primary/fallback refusal before fetch, free route selection, JSON requests and output validation. Live synthetic AI execution is recorded separately after deployment; key presence alone is not a successful provider outcome.

## Free-model and optional key fallback — 1 November 2026

The OpenRouter adapter now deduplicates a bounded free-model chain. It uses the requested free primary, route fallbacks, `OPENROUTER_FREE_FALLBACK_MODELS` and the free router, limited to four model candidates and four total HTTP attempts across credentials. The default explicit fallback is the previously live-verified `nvidia/nemotron-3.5-super-vl:free`; model availability can change and this is not a comparative quality ranking.

An optional `OPENROUTER_FALLBACK_API_KEY` is supported and has a dummy entry in private `.env.hostinger`; real values belong in hPanel or a private secret file. Keys are deduplicated. Credential rejection can retry the same free model with the second key; provider errors, timeouts and invalid output can move to another free model with the current key. HTTP 429 immediately returns to queue retry and HTTP 402 blocks for account review, without cycling keys/models to evade shared limits. No paid route is allowed. Readiness reports whether an optional fallback key is present without disclosing it. A second key may share account quotas and cannot guarantee provider-wide availability.

Validation: 430 tests passed, 16 skipped; TypeScript/build passed. Seven new regressions exercise credential failover, model failover, rate/quota refusal, global attempt limits, paid environment-model rejection and fallback-only credentials. Live use of a second real key is not claimed until the owner configures it. Existing quality/schema validation and owner authorization remain in place; model fallback alone does not prove better hiring outcomes.

Live follow-up: code `e68f61f` is deployed; readiness confirms primary AI configuration, free-only policy and paid fallback disabled. `fallbackKeyConfigured=false`: the owner still needs a real optional second key in hPanel. Forced credential/model failures were verified in isolated mocked tests, not fabricated as live provider events. Seven env-preparation checks passed. Sanitized deployment evidence: [free AI fallback](qa/2026-11-01-free-ai-fallback-evidence.json).

## Backup credential validation and synthetic task pilots — 1 November 2026

Live readiness confirms the owner added a backup OpenRouter key in hPanel. An owner-only `operations.settings.verifyAiCredentials` action and Control Plane panel now check each configured credential against the official read-only key metadata endpoint. Results contain slot/status only, never token values, labels or account usage details. Duplicate credentials are checked once; rate limiting defers further probes. Readiness exposes the number of distinct configured credentials, separating presence from redundancy. Authentication success remains a point-in-time result, not a guarantee of model availability or independent account quota.

Five new regressions cover two distinct keys without metadata leakage, duplicate keys, rejected primary/valid secondary, rate-limit deferral and absent/placeholder values. Forced inference-key/model failover remains covered by the earlier isolated tests. Live provider verification and synthetic extraction/matching/drafting outcomes are recorded after deployment; no emails or real business decisions are authorized by these pilots.

Live credential check: two distinct configured values were observed. The primary authenticated successfully; the backup was rejected by the provider. This supersedes key-presence-only readiness: backup failover is not declared healthy until a valid replacement is supplied. The owner was informed to replace the hPanel value without posting a key in chat.

The first synthetic text-only CV probe failed closed on empty assistant content; it did not produce a parsed candidate or modify a business record. The request now explicitly disables optional reasoning for these bounded structured tasks, and empty-response errors retain a sanitized finish reason without logging provider reasoning/account data. A regression checks empty-output fallback. A corrected pilot retest is recorded separately rather than treating that initial result as success.

## W5 recorded interview scheduling controls — 1 November 2026

[Implementation scope and validation](qa/2026-11-01-interview-scheduling.md): same-candidate overlaps are blocked under the shared workspace lock; exact create/reschedule retries do not duplicate calendar events or sequence updates. Rescheduling, cancellation/state and reminder edits use atomic audit/follow-up invalidation. Legacy disabled reminders are independently stopped at dispatch. A candidate schedule-check panel exposes recorded conflicts without claiming actual participant/calendar availability. Three M18 feature records remain partial; the advanced module and roadmap are not complete.

Validation: 450 tests pass with 19 skips, 164 real-MySQL regressions pass, TypeScript/build and four entry smokes pass. No new migration/provider credentials are required. Primary and backup OpenRouter keys both authenticated in the latest separate live check; earlier rejection records remain historical evidence.

Create request identities now persist in the shared workflow ledger, so an old retry cannot recreate a cancelled appointment. Each new UI scheduling intent gets a fresh key; key/content conflicts are rejected. Reminder re-enablement is separately tested to create a fresh source version without restoring old sending grants.

## W5 Google Calendar connection foundation — 1 November 2026

[Scope, setup and validation](qa/2026-11-01-google-calendar.md): owner-only OAuth, encrypted credentials, private free/busy and reviewed create/reschedule/cancel mirroring now reuse canonical interview records and workspace locking. Deterministic provider identities prevent duplicate creates on uncertain transport outcomes; ETags and generation/lease guards reject stale operations. No background sync or guest invitations are enabled. Google login for the platform remains unnecessary. Migration 0019 adds only connection/state/event-binding storage; no active connection is seeded. All advanced M18 completion gates remain open.

## W5 internal slot holds — 2 November 2026

[Scope and validation](qa/2026-11-02-interview-slot-holds.md): owner-managed expiring candidate holds share the workspace lock and canonical interview scheduler. Direct booking/reschedule/reactivation respect active holds; hold booking creates the interview and consumes the hold atomically. Retries preserve expiry and cannot recreate cancelled bookings. No new reminder engine, provider writes or external invitations are introduced. Migration 0020 adds only hold storage. M18 remains partial; participant negotiation, provider synchronization and stale-client edit control are still pending. Google OAuth fields are now configured live; account consent remains pending.

## W5 prospective Google automation — 2 November 2026

[Scope and verification](qa/2026-11-02-calendar-automation.md): future saved interview changes can mirror through the existing queue and managed worker under an owner-controlled, versioned policy. No backfill or invitations; calendar/reconnect changes require re-enabling. Stale tasks cancel and provider failures retry within a bounded budget; external edits remain protected. No new schema or external scheduler is introduced. The M18 advanced module remains partial.

## Phase batches and tracker checkpoint — 5 November 2026

[Three-batch checkpoint](qa/2026-11-05-phase-batches.md) adds owner-reviewed external conflict replacement, stale-browser scheduling guards and an executable registry/backlog consistency checker. [Scoped phase tracker](PHASE_IMPLEMENTATION_TRACKER.csv) separates validated slices from unpassed phase/module acceptance. 493 tests and 214 real-MySQL checks pass, with TypeScript/build/entry checks passing. Historical actual Google create/reschedule/cancel evidence is now archived; synthetic cleanup and enabled automation were rechecked. This supersedes earlier disconnected/no-provider-success statements as current status, while preserving those historical checkpoints. No advanced module or complete autonomous agency is certified.

A fourth batch moves the disposable SQL runner into the repository and adds GitHub Actions verification. `npm run test:mysql` passed 214 SQL regressions locally; `npm run tracker:check` passed. Hosted CI execution remains separately unverified.

Deployment verification remains open for the 5 November batches: main pushes succeeded, but the last observed production commit is `53f3070`; Hostinger management access returned 403. Tracker rows remain locally validated rather than live-verified. No assumed build failure/root cause or full-phase completion is recorded.

The application deployment delay subsequently resolved: `229a118` is live, with stale-edit rejection, access guards and desktop/mobile checks passing. Evidence captures the initial pending state and later successful application verification. Remaining open scope includes hosted CI execution, universal mandatory API revisions, two-sided participant coordination and all unpassed module/phase gates.

## W2 common availability proposals — 5 November 2026

[Scope and checks](qa/2026-11-05-common-availability.md): owner-entered participant windows can produce common slots with separate timezones, bounded intervals, Google free/busy exclusion and buffers. Existing Calendar authorization/leases are reused; this neither reserves time nor records participant acceptance. Secure participant links and confirmed-booking orchestration remain pending. 503 tests, TypeScript/build and hosting entry checks pass; live results are recorded separately. M18 remains implementing.

Live follow-up: common availability application commit `9d447b5` passed real read-only Google proposal and access/input checks, plus mobile/desktop form and stale-result clearing. Disposable MySQL: 215 passing tests. Evidence is archived in `qa/2026-11-05-common-availability-evidence.json`; the scoped tracker now marks this read-only slice live-verified. Authenticated participant collection and binding acceptance remain pending.

## W2 participant availability collection — 5 November 2026

[Implementation and validation](qa/2026-11-05-participant-availability.md): separate capability links collect candidate/interviewer windows, then reuse existing Google-backed proposals. Links expire/revoke; exact retries are idempotent and differing stale responses reject. Withdrawal and erasure reuse the existing stop/redaction hook. Migration 0021 adds scoped storage; 21→22 upgrade checks pass. 514 tests and 227 SQL regressions pass, plus types/build/entry checks. Delivery, verified acceptance and automatic booking remain pending.

Live follow-up: `470eb33` passed one-time link creation/retry, anonymous browser response, token scoping/no disclosure, paired-response Google proposals, stale/replay checks and revocation. Mobile/desktop checks passed; synthetic links were revoked. Evidence is archived in `qa/2026-11-05-participant-availability-evidence.json`. No booking, mail or provider event was created.

## W2 reviewed booking from collected responses — 5 November 2026

[Booking implementation](qa/2026-11-05-collected-booking.md) binds response and calendar generations, rechecks Google availability and buffered internal conflicts/holds, then uses the canonical scheduler and existing workflow ledger. Interview creation and capability closure commit together. No new migration or second scheduler. 523 tests and 238 SQL regressions pass; tentative scheduling remains separate from verified acceptance, delivery and unattended confirmation.

Live follow-up: `d022933` passed the owner browser paired-response booking flow, token closure, immutable replay, changed-request denial, synthetic cancellation and managed Calendar reconciliation. Mobile/desktop checks passed. Evidence is archived in `qa/2026-11-05-collected-booking-evidence.json`. Synthetic booking is cancelled and links revoked. Participant acceptance/delivery remain open; no invitations or mail were sent.

## W2 approved availability-link email — 5 November 2026

[Shared outbox implementation](qa/2026-11-05-availability-email.md) prepares one owner approval per pending participant link, reusing the shared dispatch queue and gateway. Scoped HMAC envelopes avoid persisting plaintext tokens/URLs in drafts; recipient/permission/resource checks repeat at authorization and dispatch. Rejection cleans up the draft and pending capability. 535 tests and 251 SQL regressions pass. Actual recipient mail delivery is not claimed; confirmation/acceptance and unattended sending remain pending.

Live no-send follow-up: `b96fd7e` passed options/guards, desktop/mobile draft preparation, immutable retry, rejection and cleanup. Synthetic follow-up was cancelled, links revoked and candidate withdrawn; no email was approved or sent. A second privacy batch redacts recognized private capability quotes from incoming text/subjects and AI classification inputs. Current validation: 541 tests and 253 SQL regressions, types/build/entry checks passing. Actual provider recipient delivery remains unverified.

Final email/privacy checkpoint: 541 tests and 253 SQL regressions pass. Core `b96fd7e` passed no-send draft/rejection UI checks; privacy `8eaa0c9` passed live synthetic inbound quote redaction without false opt-out. Synthetic candidate is withdrawn, follow-up cancelled, links revoked and draft cancelled. Actual recipient delivery remains unverified. Evidence: `qa/2026-11-05-availability-email-evidence.json`.

## W2 schedule-bound attendance confirmation — 5 November 2026

[Implementation and validation](qa/2026-11-05-interview-confirmations.md): two scoped participant responses now reuse the canonical confirmed/reschedule transition under one workspace lock. Appointment-version binding, hash-only capabilities, response retries/replacement, withdrawal/erasure and inbound quote redaction are covered. The Calendar lifecycle also cancels an occurrence when another time is requested; reminder and status changes receive fresh calendar revisions. Migration 0022 has a successful disposable 22→23 upgrade rehearsal. Identity verification, automatic confirmation email and unattended recovery remain pending; M18 remains implementing. Final test/deployment results follow below.

Live confirmation checkpoint: `94833c3` passed owner/anonymous guards, paired desktop/mobile responses, canonical confirmation, stale/retry behavior, decline and cancelled ICS. Synthetic candidate is withdrawn, interview cancelled, links revoked and managed Calendar cancellation verified. No email or invitations were sent. The next batch reuses the approved outbox for purpose-bound confirmation email and fixes same-tab fragment navigation on public response pages; final verification follows.

Final confirmation/email checkpoint: core `94833c3` and outbox/navigation `1d2fbe4` are live-verified. 566 tests and 281 real-MySQL regressions pass, together with types/tracker/build/entry checks. Live QA covered paired attendance responses, reschedule/decline/cancellation, same-tab public links, owner-reviewed draft/rejection and full synthetic cleanup without sending mail or invitations. Evidence: `qa/2026-11-05-interview-confirmations-evidence.json`. Actual recipient delivery, identity verification, provider RSVP ingestion, unattended alternative-slot recovery and unpassed module/phase gates remain pending.

## W2 declined-interview recovery — 5 November 2026

[Recovery implementation](qa/2026-11-05-interview-recovery.md): explicit decline opens a fresh scoped availability pair automatically. Replacement remains bound to one interview occurrence; the shared booking path reschedules the same interview ID after fresh availability/conflict checks. The owner can replace expired/lost links without forking an active recovery chain. Stale requests and pending private-link emails cannot act on a newer schedule. Existing tables and canonical services are reused; no migration. Owner-reviewed selection, recipient delivery and unattended escalation remain pending. Final verification follows.

Recovery local checkpoint: 577 tests and 296 MySQL regressions pass, plus types/tracker/build and hosting entry checks. Application `2493cb0` is pushed to GitHub `main`. Production still served `7b733a4` with the new recovery route absent at the recorded check, so live recovery acceptance remains pending. No synthetic recovery records, mail or invitations were created during this pending deployment. Provider build logs are unavailable in the current tool session.

Recovery deployment follow-up: `896f133` is now live and the complete assisted recovery flow passed anonymous mobile collection, owner replacement, paired responses, Google proposals, same-interview rescheduling and fresh paired confirmation. Candidate/interview/link cleanup and managed Calendar cancellation passed; no email or invitations were sent. The earlier deployment-pending observation is preserved as historical evidence.

## W2 recovery deadline exceptions — 5 November 2026

[Deadline implementation](qa/2026-11-05-recovery-deadlines.md) adds expiry evaluation to the existing managed and supervised workers. Current expired recovery closes its links and creates one existing-format owner incident atomically; pause/stop, identity/version and bounded-scan filters apply. Replacement or schedule/state changes resolve the old incident. 584 tests and 306 SQL regressions pass. Positive production elapsed-deadline acceptance remains unverified; no new sender/timer is introduced.

Final deadline checkpoint: `ab3bf4d` is live. Managed heartbeat source results and synthetic incident navigation passed at desktop/mobile widths. The manual UI-only incident was resolved; positive production elapsed-deadline acceptance remains unverified. Full assisted recovery is separately live-verified under `896f133`. Current local validation is 584 tests and 306 MySQL regressions, with types/tracker/build/entry checks passing. No mail or invitations were sent; advanced module/phase gates remain open.

## W2 scoped automatic recovery selection — 5 November 2026

[Scoped selection implementation](qa/2026-11-05-recovery-auto-selection.md) authorizes earliest-slot choice for one recovery request with explicit duration/buffer/notice/horizon bounds. An immutable revision and the shared queue fence policy, resource and calendar changes. Both responses are required; the same canonical command reschedules the existing interview and leaves it tentative. Proposals also share internal conflict/hold exclusion and bounded padded Google reads. No-slot review and expiry reuse one recovery incident. No new table, timer or sender. Verification follows; cross-cycle delegation and automatic confirmation/delivery remain pending.

Automatic-selection local checkpoint: 600 tests, 325 real-MySQL regressions and types/tracker/build/entry checks pass. The committed production root entry and managed worker also booted with disposable persistent MySQL and synthetic owner-only configuration on local Node 24.19.0. Code `f8e8613` is on GitHub `main`; production still serves `ba3d204` with the new endpoint absent. Management read returns 403, so provider build status is unknown and live automatic selection remains pending. No synthetic production selection records, mail or invitations were created.

Automatic-selection live follow-up: the deployment delay resolved and `1e0196b` serves application code `f8e8613`. Owner UI authorization, both anonymous responses and actual managed-queue execution passed: one tentative reschedule on the same interview ID without a manual booking action or fabricated participant acceptance. The request policy is now disabled, candidate withdrawn, interview cancelled, four recovery links revoked and managed Calendar cancellation verified. No mail or invitations were sent. Evidence is archived in `qa/2026-11-05-recovery-auto-selection-evidence.json`; cross-cycle delegation and confirmation/delivery gates remain pending.

## W4 current client reply and reviewed response — 5 November 2026

[Implementation and evidence](qa/2026-11-05-client-reply-triage.md): all three inbox paths reuse one transactional receipt/cursor and the existing follow-up stop engine. Delayed model results cannot overwrite newer replies; opt-out is sticky. Client CRM next actions and response drafts are revision-bound; approval and shared dispatch recheck current reply, recipient and permission. Pending/rejected/unknown response handling reuses the existing outbox, with no migration or second sender. M10-F04 moves to implementing; advanced module gates remain open. Verification and production acceptance follow below.

Client-reply local checkpoint: 625 tests and 352 real-MySQL regressions pass, with types/tracker/build and all four hosting entry checks. Reply/task/recipient fences and exact retry/concurrency cases are covered; one provider send is mocked only. No actual recipient delivery or dedicated client discovery booking is claimed. Live no-send acceptance is pending deployment.

Live core `19847f2` passed receipt/replay, follow-up pause, task revisions and stale response authorization/rejection. The next batch adds cancellation for unused approved authority and a persistent response status, with 627 unit tests and 354 SQL regressions passing. Browser testing found duplicate sibling React keys and mobile approval badge overflow; fixes are included and await live retesting. Synthetic drafts remain unapproved; recipient delivery and complete discovery scheduling are still pending.

Client-reply final acceptance: `86e74ab` passed live owner desktop/mobile next actions, immutable response preparation, pending-response cancellation and repeated refetch with one task form. The actual managed worker assessed the current reply using a free OpenRouter model. Synthetic drafts are cancelled/rejected and unsent; contact opted out, chase/campaign cancelled and company suppressed. Health and persistent worker heartbeat pass. Evidence: `qa/2026-11-05-client-reply-triage-evidence.json`. No real recipient delivery or discovery booking is claimed. M10-F03/F04 remain implementing, with 60 implementing and 103 planned feature packages overall.

## W4 client discovery availability and scoped automatic booking — 6 November 2026

[Implementation and verification](qa/2026-11-06-client-discovery.md): reviewed current client replies can open private availability collection and optionally authorize earliest-slot selection for that request. Dedicated client request/meeting records reuse shared slot math, buffered Google reads, conflict readers, the persistent worker and canonical reservation transaction. Interviews/holds cannot overlap active discovery reservations. Tentative/cancelled ICS exports do not invite guests or assert attendance. Migration 0023 passes a disposable concurrent/repeated 23→24 upgrade rehearsal. 647 tests and 377 SQL regressions pass with types/build/entry checks. Live acceptance is pending deployment. Link mail delivery, provider event sync, attendance and SLA escalation remain open.

Client-discovery live follow-up: `864858a` passed owner desktop/mobile request creation, anonymous collection and actual managed automatic booking after fresh Google checks. Manual booking, exact retries, immutable cancelled replay, private-link closure, stale-reply denial and ICS cancellation also passed. All three synthetic requests and both local meetings are cancelled; chase/campaign cancelled, contact opted out and company suppressed. No recipient email, provider event or invitations were sent. Health and persistent worker heartbeat pass. Evidence: `qa/2026-11-06-client-discovery-evidence.json`. Discovery link mail, Google event sync, attendance/identity verification, reminders and SLA escalation remain pending; M10-F03/F04 remain implementing.

## W4 shared discovery link email — 6 November 2026

[Implementation and verification](qa/2026-11-06-discovery-link-email.md): discovery reuses the existing private-link envelope, owner approval and physical outbox. Preparation replaces the manual capability; current reply/action/recipient/permission/status guards repeat at approval and dispatch. Rejection and request cancellation revoke unused authority while preserving unknown delivery reconciliation. No migration or second sender. Full local and live no-send acceptance follow; real recipient delivery and delegated sending are not claimed.

Discovery-mail local checkpoint: 661 tests and 392 MySQL regressions pass with types/tracker/build/entry checks. Concurrent preparation and materialized-link dispatch are covered using a mocked provider; no actual recipient delivery is claimed. SQL test fixture teardown now disables synthetic workspaces so bounded global-worker tests remain isolated. Live owner no-send acceptance is pending deployment.

Discovery-mail live acceptance: `ce1f3af` passed desktop/mobile preparation, one immutable retry, replaced manual-link denial, canonical recipient binding, request cancellation, rejection and newer-reply approval denial. Three synthetic emails remain cancelled/rejected and unconsumed; requests cancelled, contact opted out, chase/campaign cancelled and company suppressed. No mail was sent. The final elapsed-recruiter-window guard brings validation to 662 tests and 393 SQL regressions; live positive elapsed-time acceptance remains unverified. Evidence: `qa/2026-11-06-discovery-link-email-evidence.json`. Actual delivery, delegated sending, provider calendar sync, attendance and SLA work remain pending.

## W4 scoped discovery Google Calendar lifecycle — 6 November 2026

[Implementation and validation](qa/2026-11-06-discovery-google-calendar.md): discovery meetings now adapt the same Google provider engine and persistent worker. Explicit request/meeting grants are default-off and connection/version-bound; canonical booking/cancellation enqueue one namespaced event intent. External changes need fresh owner review, unknown create responses reuse identity, and accepted creation observations support concurrent cancellation. Events stay private/tentative, with no attendees or Google reminder emails. No migration or second engine. 680 tests, 414 SQL regressions, types/build and entry checks pass. Live provider acceptance follows; RSVP, attendance, Meet/Microsoft, cross-calendar cleanup and reminder/SLA work remain pending.

Discovery Calendar live acceptance: `de422c3` passed actual managed booking→Google event creation, private/tentative/zero-guest/no-reminder inspection, stable retry identity, owner pause/reviewed re-enable, and managed cancellation verified by a later provider read. The per-meeting policy is disabled after cleanup; local request/meeting and synthetic contact/chase/campaign/company are closed. Interview policy was preserved. No recipient email or invitations were sent. Evidence: `qa/2026-11-06-discovery-google-calendar-evidence.json`. Full validation remains 680 tests and 414 SQL regressions; a privacy-review readout also passed 49 focused tests and types/build/entry checks. RSVP, attendance, Meet/Microsoft, cross-calendar cleanup, reminders/SLA and actual mail delivery remain open.
