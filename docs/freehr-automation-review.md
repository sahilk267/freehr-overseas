# FreelanceHR automation and correctness review

Implementation has since started. See [current implementation progress](IMPLEMENTATION_PROGRESS.md) and the canonical registry for verified changes; baseline findings and planned scope below are historical/design records.

Reviewed 28 October 2026. Checkout: `/workspace/freehr-overseas`; HEAD: `2c4fd93c4b404a6614586ea86d4be7e6fc34c29b`.

## Verdict and scope

The current application is a recruitment operations application with manual CRUD/state transitions, a bounded AI task queue, approval controls, a real Hostinger mail adapter, private document handling, and accounting records. It is not an autonomous freelance recruitment business. Configuring API keys alone cannot close the implementation gaps below.

Reviewed application routes, UI callers, worker execution, AI payloads/prompts, authentication, policies, scheduler integration, database schema/mock implementation, document handling, finance, and tests. No application files were changed. No real messages, payments, provider-account changes, or external candidate sourcing were performed.

Evidence labels:
- **Reproduced locally:** exercised actual application/service code with synthetic records in its process-local mock database; HTTP routes used Fastify injection where stated. This does not establish real MySQL behavior or deployed-site exposure.
- **Code-confirmed:** reachable implementation/constraint directly establishes the issue; not reproduced against live providers/MySQL.
- **Missing in reviewed implementation:** no operational implementation found in the inspected routes/services/UI; not a claim about software outside this checkout.

## Validation evidence

- Existing unit suite rerun: 40 files; 37 passed, 2 failed, 1 skipped. 276 tests; 272 passed, 2 failed, 2 skipped.
- Failing tests: `server/releaseBlockers.test.ts:504` omits the talent mailbox resource ID in its mocked-send fixture; `server/services/runtimeAuth.test.ts:41` omits the CRON_SECRET now required by `configIssues()`.
- Previous onboarding run at this same unchanged checkout: TypeScript check and build passed; Hostinger verification 25 passed; development health/page/demo-login/authenticated dashboard requests passed. These are development checks, not production acceptance.
- Additional diagnostic script: `/workspace/freehr-audit-probe.ts`. Run from the checkout with `./node_modules/.bin/tsx /workspace/freehr-audit-probe.ts`. It forces a test-mode, process-local mock DB; it sends no email. Its top-level imports load application modules; use the prepared development environment, not a production process.
- Probe observations: negative decision still permits placement; shortlist can become shared without share consent/approval; pending share can become shared after withdrawal; email approval fails with unsupported `email_send`; recording 1 against a 100000 invoice marks paid; match payload omits the stored must-have skills/experience/pay; canonical auto-approvable action list is empty; unauthenticated calendar GET returns 200 and synthetic private notes.

## Capability matrix against an autonomous recruiter

| Business responsibility | Current implementation | What remains |
|---|---|---|
| Choose target market/client strategy | Manual prospect records and notes | ICP, niche strategy, demand intelligence, target selection, measurable acquisition plans |
| Discover clients and hiring demand | Manual create/addContact, source URLs | Approved data connectors, hiring-signal collection, enrichment, dedupe, validation, recurring discovery |
| Acquire clients | AI draft task, conversation records, email adapter | Complete outreach UI and execution, bounded follow-up campaigns, reply-to-next-action workflow, discovery bookings |
| Negotiate fees and agreement | Draft proposal and manually record acceptance | Negotiation limits, objections handling, authenticated acceptance/e-sign, contract versioning and fee enforcement |
| Understand hiring need | Structured job form, manual confirmation | Client intake portal/conversation, JD ingestion, clarification loop, independently verifiable sign-off |
| Source candidates | Manual candidate creation, existing-pool keyword/skill search | External sources, referrals/applications, bulk ingestion, identity dedupe, recurring sourcing/re-engagement |
| Parse and assess CV | PDF/DOCX/text extraction, queue, validated AI JSON | OCR, clean-scan prerequisite, normalized skill/experience data, evidence provenance, robust retry/reparse |
| Match candidates to jobs | Manual evidence scores or per-pair AI queue | Complete input context, deterministic hard filters, ranking across pool, re-evaluation, evidence verification |
| Screen candidates | Owner-entered answers and evidence | Candidate-facing adaptive screening, follow-up questions, verifiable assessments, scheduling/consent integration |
| Submit to clients | Shortlist rows/status, consent checks on one path | Actual authorized delivery/access links, client review portal, expiry enforcement, revocation, feedback capture |
| Coordinate interviews | Manual datetime entry, ICS export/feed, reminder queue | Availability negotiation, conflict detection, Google/Microsoft calendar integration, meeting provisioning, response handling |
| Manage offers/joining | State records and owner-entered decisions/evidence | Offer document delivery/signature, negotiation, acceptance verification, notice-period/prejoining/dropout follow-up |
| Invoice and collect fees | Manual amount, HTML invoice, payment ledger | Contract-derived amounts/terms/tax, genuine checkout/provider webhooks, partial balances, reconciliation and dunning |
| Replacement and retention | Guarantee-date calculation and replacement status | Scheduled check-ins, contract-specific guarantees, attrition detection, replacement sourcing loop |
| Run independently and improve | Bounded job worker, audits, exceptions, quotas | Reliable scheduler, event orchestration, stale-job recovery, outcome evaluation, runbooks, monitoring and backup/restore proof |

## Reproduced correctness and access defects

### R1 — High: unauthenticated calendar feed exposes interview notes

`server/hostinger.ts:215` and `server/_core/index.ts:91` accept an enumerable user ID without authentication or a secret subscription token, select that owner's interviews, and serialize preparation notes/location. Synthetic unauthenticated GET `/api/calendar/feed/1` returned HTTP 200 and `AUDIT_PRIVATE_NOTES`. This is an access-control defect in the route; public deployment exposure was not tested. Replace numeric-only access with revocable, scoped subscription authorization and minimize exported fields.

### R2 — High: email approval cannot complete through the implemented approval route

`server/routers/email.ts:46` creates action `email_send`. The Exceptions UI calls `recruitment.approvals.decide` (`recruitment.ts:1531`), which invokes `applyApprovalDecision()`. `server/services/approvalEngine.ts:64` does not recognize `email_send`; approval throws `Unsupported consequential action side effect: "email_send"`. Reproduced without sending. Delivery requires approved status, so the supported request → approve → deliver chain is broken. Implement the authorization effect separately from actual delivery and wire a single tested chain.

### R3 — High: approved non-progression is treated as a positive placement decision

`consequential.ts:44` saves `recommendation: not_proceeding`; approval changes its screening status to `owner_decided` (`approvalEngine.ts:160`). `recruitment.ts:1148` accepts any `owner_decided` screening, irrespective of recommendation, as a positive decision. Reproduced placement creation after explicitly approving non-progression. The same predicate also accepts a completed interview or received feedback without a positive hiring decision. Use an explicit, authorized positive disposition for the exact candidate/job.

### R4 — High: partial payment closes the entire invoice

`services/invoicing.ts:253` computes the submitted amount but always sets invoice status `paid` at line 255. Reproduced amount 1 against total 100000 → `paid`. No cumulative paid/balance calculation or partial-payment transition occurs. This can hide receivables and distort revenue. Update payment ledger and balance atomically, with partial/overpayment/idempotency behavior.

### R5 — High: direct shortlist transition bypasses consent and approval

`routers/candidateWorkflows.ts:92` permits `approval_pending → shared` using only ownership plus FSM validation. No granted share consent, valid approval, suppression, expiry, or candidate eligibility is checked. Reproduced on a synthetic shortlist with no share consent or approval. This marks the record shared; it does not itself prove external disclosure because delivery is not implemented. Remove the alternate mutation path or enforce the same domain authorization.

### R6 — High: old approval resurrects a withdrawn shortlist

Request valid sharing approval → withdraw candidate → approve the old request. `approvalEngine.ts:105` unconditionally updates shortlist to `shared`. Reproduced. The execution step does not recheck current consent/expiry, withdrawn/deleted/DNC status, suppression, or current shortlist state. Cancel invalid pending decisions and revalidate at execution, including delayed execution.

### R7 — High capability gap: matching lacks the evidence it claims to compare

`recruitment.ts:645–681` loads candidate/job rows but queues only candidate name/headline/location and job title/description/location. It omits parsed CV skills/roles/experience, compensation, availability, must-have skills, weighted scorecard and work model. The create-job route does not accept/store `description`, even though the scorer references it. Reproduced payload for a job with stored skills/pay/experience lacked all three. This is insufficient for evidence-based expert matching.

## Code-confirmed automation and reliability gaps

### C1 — Autopilot controls do not implement an autonomous business loop

`operations.ts:79` stores automation mode, outbound limit, quiet hours and timezone. Searches across runtime code find no use of automationMode/dailyOutboundLimit/quietHours in execution gating. `queue.ts` checks emergency stop and AI daily count, but not those outbound boundaries. `workflow.ts:171` marks all canonical consequential actions `allowAutoApproval: false`; the local probe confirms an empty enabled list. `approvalEngine.ts` contains a rule engine, but the known business actions cannot use it. Turning the mode to autopilot does not source, screen, share or close a placement.

This is a product-authority decision, not something a model key can fix. Define actions the owner may delegate, required evidence, reversible actions, limits, and exceptions. Candidate/client consent and hiring authority must remain explicitly represented. An experienced recruiter also cannot approve on behalf of an external candidate/client.

### C2 — Scheduler may report success without scheduling anything

`server/_core/heartbeat.ts:68–77` returns `mock_heartbeat_*` when Forge settings are absent, including production. `operations.queue.enableSchedule` and `interviews.enableReminderSchedule` persist that ID and report success. No local cron is installed by that fallback. Native-cron deployment instructions exist, but a real external scheduler must be provisioned and its callbacks tested. The UI does not call these enable endpoints.

### C3 — No event-driven recruitment orchestration

`queue.handleAiTaskResult()` saves parse results, draft content, classification or scores. Parsing does not launch a pool match; scoring does not request missing evidence, initiate screening or prepare a shortlist; a positive reply does not book discovery or generate the next follow-up. The `nextAction` field is only acted on for stop_contact. There is no durable prospect/job-level goal planner connecting these operations or timeout/escalation loops.

### C4 — Worker crash can strand running jobs

`queue.ts:575` claims with status running and lockToken/lockedAt. Selection only includes queued/retryable_failed. No expired-lease/stale-running recovery or worker heartbeat was found. A process restart during work can leave it running indefinitely. Multiple workers also contend for the same earliest job instead of a database-native locked selection.

### C5 — AI-result failures can break error recovery

`queue.ts:735` inserts aiUsage with a generated primary key before applying domain results. If handling or final persistence subsequently throws, catch inserts the same aiUsage ID again at line 756 before updating job failure status. Real MySQL rejects the duplicate primary key; the job may remain running. Mock DB inserts overwrite by ID and mask this failure. Use one lifecycle row/update or unique attempt records; isolate provider, domain and audit failures.

### C6 — Email replay protection is vulnerable to concurrent sends/crash

`email.ts:60–108` checks approved/unconsumed, calls the provider, then marks approval actioned/message sent. Two requests can pass the check together; provider success followed by DB failure permits another delivery. Reminder dispatch has a similar send-before-persist window. Sequential replay tests do not exercise this race. Use atomic claiming, durable send/outbox attempts and provider-supported idempotency/reconciliation.

### C7 — Quiet hours, budgets and reminders disagree with product claims

`queue.ts:438` sends reminder email directly without an email approval check, while UI text and reminder prompts describe drafts/owner-approved delivery. Reminder jobs depend on an AI call and AI budget even when a deterministic template could deliver a time-critical reminder. Payload only includes interview ID/time/timezone, not candidate/job/meeting details. AI `sendAfter` is not enforced. Rescheduling leaves old queued reminder jobs in place, and the handler does not validate their scheduledAt against the current interview time. A former-time reminder can be sent for a newly confirmed, rescheduled interview.

### C8 — Queue budget can block unrelated urgent work

Worker picks the first job, then returns skipped if its AI budget is exhausted, without searching that owner's later deterministic scans/policy jobs. Batch processing then breaks/skips the owner. Budget enforcement is also a count-then-call pattern, so concurrent workers can overshoot. Quota uses DB date rather than workspace business timezone. Reserve budget atomically and separate deterministic work lanes.

### C9 — Real-DB constraints conflict with the normal screening journey

`candidateWorkflows.screenings.create` inserts a screening for candidate/job. `consequential.requestCandidateDecision` always inserts another screening for that pair. `drizzle/schema.ts:321` has unique(candidateId,jobId). A pre-existing screening therefore conflicts on MySQL; mock inserts do not enforce that unique index. Similarly, placement duplicate checks allow a new record after an old one closes, but schema line 433 still forbids a second candidate/job placement. Validate intended history models against real MySQL.

### C10 — Approval atomicity/state validation remains incomplete

Manual approval SELECT does not lock the row or use a conditional pending-status update; a transaction alone does not prevent two decisions reading pending. Side effects update by ID/owner but do not assert current domain transitions. Policy auto-approval writes approved before effect/queue insertion without a shared transaction. Old approvals can overwrite later business state; decision retries and rejected-action recovery need dedicated tests.

## Missing or incomplete expert-recruiter capabilities

### M1 — Acquisition and sourcing have no operational external connectors

`prospects.create`, `addContact`, `candidates.create` accept manually supplied data. Search/searchSkills only search the owned pool. No implemented recurring hiring-demand scanner, approved job-board/ATS ingestion, candidate applications/referrals pipeline, bulk import/dedupe/merge, email validation, or source refresh engine was found. An autonomous recruiter cannot start from an empty database today.

### M2 — Outreach is one draft rather than a campaign engine

`outreach.draftSequence` creates one conversation/message/task, not a timed sequence. It instructs no automatic sending. There is no implemented bounded cadence, stop-on-reply handling across a campaign, deliverability/bounce/complaint feedback loop, mailbox warm-up tracking, or autonomous next-action execution. Webhook processes only message.received, ignoring other normalized event types. Unknown inbound senders are routed to exceptions without intake creation; unmatched body is not retained in the incident for later processing.

### M3 — Screening/negotiation/portals are absent

Screenings are owner-entered answers/evidence. No candidate-facing questionnaire/chat/voice interview, adaptive follow-up, skills-assessment integration, or client-facing requirement/feedback portal was found. Agreements are drafted and acceptance recorded by an owner; no authenticated acceptance/e-sign or fee-negotiation agent exists. Offer routes record internal state rather than generating/delivering/verifying an offer document.

### M4 — Candidate submission and client onboarding overstate external truth

`approvalEngine.ts:105` marks shared and sets an expiry but does not deliver a profile or create an authenticated client share page/token. No reader enforcing shareExpiresAt was found. `client_onboarding` sets verificationState verified without inspecting KYB evidence. `verifyKyb` can manually mark verified; no registry verification is implemented. Owner approval is a record of authorization, not independent proof that verification, delivery or acceptance occurred.

### M5 — Payment link is an internal URL, not a gateway checkout

`invoicing.ts:161–223` accepts provider=stripe but never calls Stripe or another gateway. It inserts a pending payment and returns `/finance?invoice=...&pay=...`. FinancePage does not implement a client checkout for those query parameters. No signed payment webhook/bank reconciliation/provider verification exists. Marking an invoice paid is an owner assertion, not evidence of received funds.

### M6 — Commercial terms do not drive financial calculations

Fee proposal fields include percentage/fixed fee, guarantee/payment/ownership days. Invoices accept a manually supplied amount/tax/date rather than derive them from the accepted contract, compensation and tax rules. Guarantee calculation defaults to 90 days at approval; agreed guaranteeDays is not loaded. No automated retention check-ins, guarantee expiry processing, replacement resourcing, aging/dunning or payment chasing loop was found. Invoice currency defaults to INR rather than consistently following placement/contract currency.

### M7 — Expert judgement and institutional memory are not implemented

No persistent recruiter strategy/memory, verified skills ontology, salary-market intelligence, evidence-linked experience reasoning, employer/candidate relationship history used for decisions, explainable trade-off engine, recruiter-outcome evaluation, or feedback-to-ranking improvement loop was found. Prompts are short task descriptions; structured JSON validation checks shape, not factual correctness. RuleScore is supplied by AI/manual input, not an independent deterministic rules engine. AI confidence and lowConfidence can disagree without server correction.

## Additional data, privacy, UI and operational defects

### D1 — Consent capture is an owner assertion; execution checks differ by route

`recruitment.ts:498` grants consent with method owner_recorded, without candidate-facing verification/evidence capture. One sharing route checks exact job/client and expiry; `consequential.ts:267` checks company/type/status but omits exact job, expiry, DNC and suppression. Any consent type can move a pending profile to consented. These paths must converge on a purpose-scoped consent service.

### D2 — Deletion does not cover all copies or stop queued repopulation

`candidateWorkflows.fulfillDeletion` deletes files/redacts candidate/documents, but does not scrub stored queue cvText/results, conversation bodies, screening answers or related PII audit payloads, nor cancel pending parsing/decisions. `handleAiTaskResult(parse_cv)` can repopulate document parsedData; parse execution blocks only flagged, not redacted/deleted/missing or pending-scan documents. Generic candidates.transition also allows deleted without physical deletion/redaction. After physical deletion fails, request becomes investigation, but fulfillDeletion accepts only received; straightforward retry is blocked. Design retention/legal-record exceptions explicitly rather than claim universal erasure.

### D3 — Uploaded filenames can overwrite existing evidence

`recruitment.ts:585` storage key is owner/candidate/sanitized original filename. Uploading the same filename replaces bytes under the same key but inserts a new document/hash row. Old records then reference different content; deleting one removes the shared file. Use immutable document IDs/versioned object keys. Same issue exists for KYB filename keys.

### D4 — Scan pipeline is heuristic and extraction occurs before scan completion

`recruitment.ts:605` parses/extracts the uploaded document synchronously after enqueueing a scan. `queue.ts:714` blocks only an already flagged document, not pending scan. documentScanner checks headers and a few string signatures; it is not a full malware scanning service. Compressed/obfuscated payloads and PDF-image OCR are not handled. The code should not advertise clean as comprehensive malware assurance.

### D5 — Hard-coded privileged email and unverified identity-email reliance

`primaryOwner.ts:52` permanently recognizes a specific email as owner even in production, independent of configured owner settings. `runtimeAuth.ts:181` uses claims.email for provisioning/owner matching without checking email_verified. ID token signature/issuer/audience/nonce are validated, but email-based privilege must depend on a trustworthy verified claim and explicit deployment configuration. The unverified-email impact depends on chosen IdP behavior; no attack against a provider was attempted.

### D6 — UI leaves important backend capabilities inaccessible

UI callers in `WorkspaceViews.tsx` do not wire contact creation, agreement drafting/acceptance, AI draft generation, email approval request/delivery, automated match scoring, skills search, schedule activation, full offer endpoints, invoice document/payment link/recordPayment, or rights fulfillment. Prospects show new→researched but no full progression controls; backend has more transitions. Forms often reset and close immediately after mutate, before successful persistence; most lack local error handlers. No browser automation was executed for this review; these are source-level call/handler observations.

### D7 — Job confirmation is fabricated from a fixed UI address

`WorkspaceViews.tsx:99` passes clientConfirmedBy=clients.fl@overseasjob.in when the operator clicks confirmation. `recruitment.ts:235` trusts that string and timestamps the confirmation. This is not authenticated client sign-off, and UI/backend do not require an active verified client plus accepted contract before sourcing.

### D8 — Calendar/export and billing presentation defects

Feed uses default 45 minutes/legacy scheduledEndAt rather than durationMinutes, location rather than meetingUrl, and emits every non-cancelled event as confirmed. `calendar.ts:25` increments 74 while first slice is 75, duplicating a character at the first fold; long Unicode lines are not folded by octet length. `invoicing.ts:91` interpolates unescaped companyName into invoice HTML; downstream rendering/printing should escape it. No browser exploit was attempted.

### D9 — Readiness is configuration presence, not operational proof

Mail status configured is true when a token exists; identity verification tests account access rather than each mailbox's send permission. Local/managed storage configured status does not verify writable storage or managed service access. AI readiness returns hard-coded capability booleans without validating credentials/model calls. `/api/health` is liveness, not database/worker/provider readiness. Treat these separately in the UI.

### D10 — Tests and acceptance overstate production assurance

The named E2E happy-path test is a direct appRouter caller with a manually provided user and mock DB, not a deployed browser/provider/MySQL journey. Mock filtering fails open on expression errors; inserts do not enforce normal unique indexes/defaults. Live mail test is skipped without credentials and only checks account status. PLATFORM_ACCEPTANCE says the complete suite passes, but the current baseline fails two tests. No real-MySQL migration journey, live OIDC browser journey, provider delivery/receipt loop, scheduler recovery, load/concurrent-payment/send tests or backup/restore validation was established.

## Recommended implementation order

1. **Correctness and authority first:** fix calendar authorization, email approval chain, decision/placement predicate, partial payments/atomic ledger, shared-state bypass, stale approval revalidation, privileged identity configuration, and immutable document keys. Add focused regressions and real-MySQL workflow tests.
2. **Durable execution:** real scheduler with fail-closed registration, worker leases/recovery, transactional state/outbox, bounded send attempts, delivery-event reconciliation, enforce quiet hours/budgets/emergency stop on every relevant path, observable alerts.
3. **One genuinely autonomous vertical slice:** a permitted candidate/job source → validated intake → candidate-controlled consent → full-evidence ranking → adaptive screening → authorized client delivery → availability coordination → signed/verified offer and joining → contract-derived invoicing → verified payment. Define human/client/candidate decisions separately from routine delegated work.
4. **Broaden acquisition and commercial operations:** demand discovery, client qualification/discovery, negotiation within approved bounds, authenticated agreements, multi-step reply-aware outreach, persistent relationship memory, repeat clients and referrals.
5. **Expert-level quality:** salary/skill/domain knowledge, grounded evidence, evaluation datasets, documented failure thresholds, outcome measurement and ranking improvements. Add retention/replacement, reconciliation/dunning and business performance optimization.

Do not equate a feature count, an autopilot switch, a queued job or a changed status with completed real-world work. Completion requires an observable external outcome, persisted evidence, authorized scope, and reliable recovery when any step fails.
