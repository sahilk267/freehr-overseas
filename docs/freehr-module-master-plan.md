# FreelanceHR — module-wise advanced automation master plan

Implementation has since started. See [current implementation progress](IMPLEMENTATION_PROGRESS.md) and the canonical registry for verified changes; baseline findings and planned scope below are historical/design records.
Version 1.0 · 28 October 2026 · Design baseline, not an implementation claim.

## 1. Outcome, scope and acceptance
Build an autonomous recruitment operator that can pursue a permitted business objective, acquire and service clients, find and engage candidates, coordinate authorized hiring steps and collect verified revenue. Its routine work should continue without an open browser. Owner intervention should focus on exceptions and actions outside explicit delegated authority.

Baseline: code audit at commit `2c4fd93c4b404a6614586ea86d4be7e6fc34c29b`; see [audit](freehr-automation-review.md). Existing unit suite: 272 passed, 2 failed, 2 skipped. New work is not assumed implemented or verified.

Business scope: solo freelance recruiter and small agency; contingency/retained/milestone recruitment; permanent and contract placements; domestic and overseas variants where configured; multi-client, multi-job and multiple candidate applications. The design supports approved connectors and regional operating packs. Employment payroll, attendance and full HRIS are integration scopes when contracted, not duplicate core recruitment engines.

Completion means an authorized real-world outcome with persisted evidence, a usable UI/API, monitored execution and recovery. A model response, saved status, feature name or mock-provider success does not satisfy it.

Each feature package below receives an identifier and acceptance ownership. Coverage is controlled through the module registry, follow-up catalog, audit-to-remediation matrix and launch gates. New requirements must be assigned to an existing owner before creating another module.

## 2. Architecture and implementation rules
1. Start with the existing Node/TypeScript, React/tRPC and MySQL codebase as a **modular monolith** with a separately runnable worker. These are 25 logical modules, not 25 microservices.
2. Reuse sound existing code; refactor duplicated routes behind one owning-domain command. Preserve public contracts through adapters until their consumers migrate.
3. MySQL is the authoritative transactional store. Use an event outbox/consumer inbox for durable propagation. Add Redis, vector search or a separate workflow product only when measured requirements justify it; do not deploy two authorities for the same workflow.
4. Provider infrastructure is replaceable behind M02. M05 owns durable execution; M06 owns follow-up business intent; M07 owns all outbound message lifecycle. No other module may implement its own sender or reminder cron.
5. M04 issues execution authority. Domain modules validate business truth and versions. M08 proposes structured actions; it does not write business records or fabricate outside-party decisions.
6. Every authoritative record has one write owner. Other modules use commands, references and rebuildable read models. Projection fields cannot be edited as alternate sources of truth.
7. Every executable action is bound to workspace, actor/delegation, resource version, purpose, expiry, budget and idempotency identity.
8. Process all provider interactions as potentially duplicated, delayed, failed or uncertain. Guarantee one logical effect through claims/idempotency/reconciliation, not an unsupported universal exactly-once promise.
9. Store UTC instants and explicit IANA business/recipient timezones. Store financial values with an explicit currency and integer minor units or approved decimal precision; never mix salary period or units.
10. Do not use fictional production success, fabricated approvals, hard-coded privileged identities, owner clicks as candidate/client consent or AI output as payment truth.
11. Integration activation and source/contact permissions are explicit. The plan does not authorize messages, scraping, signatures, charges or deployments by itself.
12. Dependencies in the registry are **build prerequisites**. Modules may exchange events in both directions without taking ownership of one another's records.

## 3. Canonical module inventory

| ID | Module | Canonical write ownership |
|---|---|---|
| M01 | Workspace, identity aur access | Workspaces, identities, sessions, memberships, role grants and service identities. |
| M02 | Integration aur provider hub | Provider connections, credentials metadata, adapter contracts, webhook inbox and normalized provider events. |
| M03 | Canonical data, identity resolution aur evidence | Cross-domain identity links, provenance/evidence references, merge history and schema/migration conventions; domain modules own their business records. |
| M04 | Policy, delegation, consent aur privacy | Policy versions, delegation grants, consent/evidence, action authorizations, suppression and privacy-rights cases. |
| M05 | Durable workflow, scheduler aur workers | Workflow instances, event outbox, consumer inbox, durable timers, task leases and execution attempts. |
| M06 | Universal follow-up aur next-action management | Follow-up plans, sequence versions, enrollments, stage objectives, contact arbitration and terminal outcomes. |
| M07 | Unified inbox, communication aur delivery | Conversations, canonical messages, approved content versions, dispatch intents and delivery attempts/status. |
| M08 | Recruiter AI, knowledge aur grounded reasoning | Model routes, prompt/schema versions, knowledge retrieval, recruiter memory policies, AI runs and evaluation artifacts. |
| M09 | Recruitment strategy aur market intelligence | Recruiting goals, ideal-client profiles, market signals, strategy versions and capacity plans. |
| M10 | Client acquisition aur account CRM | Organizations, business contacts, opportunities, account qualification, relationship timeline and account-health plans. |
| M11 | Client discovery, negotiation aur agreements | Commercial engagements, proposal/contract versions, authority limits, acceptance and amendments. |
| M12 | Job intake aur requirement control | Requisition versions, intake facts, hiring scorecards, openings, client confirmations and requisition lifecycle. |
| M13 | Candidate sourcing aur talent CRM | Candidate profiles, sourcing searches, source submissions, talent pools, availability and relationship preferences. |
| M14 | Document security aur evidence extraction | Immutable document objects, document versions, scan/extraction runs, parsed source spans and access receipts. |
| M15 | Evidence-based matching aur ranking | Match runs, eligibility assessments, score components, evidence explanations and ranked recommendation versions. |
| M16 | Adaptive screening, assessments aur decision cases | Screening cases, rounds, answers, assessment results, recommendations and authorized progression dispositions. |
| M17 | Shortlisting, client submission aur review | Submission packages, recipient-specific grants, actual release records, client review and submission outcomes. |
| M18 | Interview coordination, calendars aur feedback | Interview rounds, participant availability, slot reservations, calendar event mappings and interview feedback. |
| M19 | Offer negotiation aur acceptance | Offer versions, negotiation cases, authorized compensation terms, signatures and acceptance evidence. |
| M20 | Joining, placement, retention aur replacement | Joining cases, verified placements, guarantee obligations, retention check-ins and replacement cases. |
| M21 | Finance, verified collections aur recruiter earnings | Fee calculations, invoices/credits, payment ledger, allocations, reconciliation, disputes and agency/recruiter receivables/payables. |
| M22 | Owner command center, exceptions aur handoff | Business exception cases, human assignments, SLA escalations, manual interventions and operator action history. |
| M23 | Analytics, attribution aur controlled improvement | Metric definitions, analytical read models, attribution, experiments and business/evaluation reports. |
| M24 | Product experience: owner, client aur candidate portals | UI composition, route navigation, accessibility/localization, public-facing forms and notification preferences; no duplicate domain authority. |
| M25 | Security operations, reliability aur release quality | Runtime/deployment configuration, security controls, technical incidents, telemetry, backup/restore and release gates. |

## 4. Detailed module specifications
The following 163 feature packages are planned scope, not 163 implemented/verified features. Each module specifies the existing baseline, a single write owner, build prerequisites, advanced feature packages, events and an acceptance gate.

### M01 — Workspace, identity aur access
**Current baseline:** Existing auth/team code; hard-coded privileged identity and email verification defects.

**Owns:** Workspaces, identities, sessions, memberships, role grants and service identities.

**Build prerequisites:** None; shared foundation.

- **M01-F01:** Production OIDC with verified-email requirements, explicit owner bootstrap, MFA/passkey or IdP step-up for sensitive actions; remove hard-coded owner bypasses.
- **M01-F02:** Workspace isolation independent of user IDs; least-privilege owner/recruiter/coordinator/finance/viewer plus scoped automation identities.
- **M01-F03:** Client and candidate identities with record/purpose-scoped access; team invitation, revocation, session expiry, device/session history.
- **M01-F04:** Scoped integration service accounts, signed revocable share/calendar tokens, impersonation controls and audited break-glass access.
- **M01-F05:** Permission-aware UI and APIs using the same capability registry; authorization repeated on downloads, exports, webhooks and worker actions.

**Domain events:** identity.verified, membership.revoked, session.revoked

**Acceptance gate:** Another workspace cannot read/mutate/export a record; revoked users/tokens lose access; unverified email cannot grant owner privileges; calendar feed requires scoped authorization.

### M02 — Integration aur provider hub
**Current baseline:** Hostinger and managed-service helpers exist; most recruitment connectors missing.

**Owns:** Provider connections, credentials metadata, adapter contracts, webhook inbox and normalized provider events.

**Build prerequisites:** M01

- **M02-F01:** Versioned adapters for email, approved WhatsApp/SMS/voice, Google/Microsoft calendars, meeting providers, e-sign, payment/bank feeds, assessments, verification and approved talent/client sources.
- **M02-F02:** OAuth refresh, credential rotation, per-workspace scopes, destination restrictions, health probes, quota/cost limits and connection-specific kill switches.
- **M02-F03:** Signed webhook verification, replay protection, raw-event reference, deduplication, out-of-order reconciliation and deterministic event routing.
- **M02-F04:** Source licensing/permission and provenance declarations; API/CSV/ATS import/export with field mapping, backfill checkpoints and quarantine.
- **M02-F05:** Real scheduler registration checks through M05; no mock success in production. Provider sandbox/contract tests, schema-drift detection and reconnect workflows.
- **M02-F06:** All domains call these adapters instead of copying provider SDKs; actual message lifecycle belongs to M07 and financial truth to M21.

**Domain events:** connection.ready, connection.degraded, provider.event_received

**Acceptance gate:** Expired credentials recover or open a visible case; duplicate webhook produces one normalized event; an unconfigured provider cannot be marked live.

### M03 — Canonical data, identity resolution aur evidence
**Current baseline:** Shared schema exists; mock semantics, duplicate handling and constraints diverge.

**Owns:** Cross-domain identity links, provenance/evidence references, merge history and schema/migration conventions; domain modules own their business records.

**Build prerequisites:** M01

- **M03-F01:** Stable workspace-scoped IDs and canonical links for organization, contact, person, requisition, candidacy and commercial engagement.
- **M03-F02:** Person/candidate profile separated from candidate-job application so parallel jobs do not overwrite lifecycle or decisions.
- **M03-F03:** Normalized email/phone/domain matching, explainable duplicate suggestions, confidence-based merges, reversible merge lineage and collision review.
- **M03-F04:** Versioned source facts, timestamps, freshness, conflicting-claim handling, evidence access/retention labels and correction propagation.
- **M03-F05:** Document text is owned by M14, consent by M04 and payment records by M21; use references/read models rather than copying authoritative state.
- **M03-F06:** Real MySQL constraints, currency/time/amount types, optimistic versions, transactional migrations, bounded pagination and index/query plans.

**Domain events:** entity.merged, fact.corrected, evidence.superseded

**Acceptance gate:** One person can have separate active candidacies; source corrections invalidate stale derived scores; real DB uniqueness matches allowed histories and retries.

### M04 — Policy, delegation, consent aur privacy
**Current baseline:** Approval and consent code exists; inconsistent paths, stale approvals and erasure gaps.

**Owns:** Policy versions, delegation grants, consent/evidence, action authorizations, suppression and privacy-rights cases.

**Build prerequisites:** M01, M03

- **M04-F01:** Typed action catalog with authority, required evidence, budget, tenant scope, expiry, policy version and exact permitted side effect.
- **M04-F02:** Observe/recommend, draft/review and delegated-execution modes with explicit action grants; unknown/ungranted actions fail closed.
- **M04-F03:** Candidate-captured purpose/job/client-scoped consent; notices, authenticity, expiry, withdrawal, channel preference and contact restrictions.
- **M04-F04:** One suppression/eligibility API used by sourcing, AI, sharing, messaging, reminders, exports and workers; immediate withdrawal propagation.
- **M04-F05:** Approval binds resource version, content digest, recipient, purpose and expiry; revalidate at execution, cancel stale approvals, prevent concurrent consumption.
- **M04-F06:** Privacy inventory/retention, export/correction/deletion, legal-hold exceptions, deletion tombstones, queue/result redaction and restartable erasure.
- **M04-F07:** Jurisdiction/source rules, overseas recruitment and verification requirements, recording consent, sensitive-data minimization and documented agency/client/candidate authority.
- **M04-F08:** Action-policy simulator and explanation; quiet-hour exceptions require explicit scoped policy, not hidden bypasses.

**Domain events:** consent.granted, consent.revoked, authorization.issued, authorization.revoked, erasure.completed

**Acceptance gate:** Withdrawal blocks queued sends/shares and pending decisions; all alternate routes enforce the same rules; deletion cannot be undone by parsing/replay; approval retries cannot double-execute.

### M05 — Durable workflow, scheduler aur workers
**Current baseline:** Queue/retry code exists; stale locks, usage-write failures and mock schedules remain.

**Owns:** Workflow instances, event outbox, consumer inbox, durable timers, task leases and execution attempts.

**Build prerequisites:** M02, M03, M04

- **M05-F01:** Versioned workflow definitions, typed commands/events, transactional outbox/inbox, correlation IDs and per-candidacy/client/job/invoice process instances.
- **M05-F02:** Real external scheduler or managed worker timer service; persistent timers survive deploys, browser closure and restarts; health verifies actual callbacks.
- **M05-F03:** Atomic task claiming, leases/heartbeats, stale-running recovery, bounded concurrency, retry backoff/jitter, dead-letter queues and replay tools.
- **M05-F04:** Separate deterministic and AI work lanes; atomic quotas so AI exhaustion does not block consent revocation, scans or scheduled operational work.
- **M05-F05:** Idempotent domain commands, timeout/compensation paths, cancellation propagation, version checks and reconciliation after unknown provider outcomes.
- **M05-F06:** Fairness across workspaces, priority/deadline scheduling, rate limits, workflow migrations, pause/drain/resume and operation-level emergency stops.
- **M05-F07:** M06 declares business follow-up deadlines; M05 alone persists/fires physical timers. No per-feature cron loops or competing next-run columns.

**Domain events:** workflow.started, timer.due, task.completed, task.failed, workflow.stalled

**Acceptance gate:** Kill a worker after claim and recover the job; event replay does not repeat an effect; a failed provider call never silently completes; no real timer means schedule not ready.

### M06 — Universal follow-up aur next-action management
**Current baseline:** One nextActionAt field, one-message drafts and interview-specific reminders; no complete lifecycle engine.

**Owns:** Follow-up plans, sequence versions, enrollments, stage objectives, contact arbitration and terminal outcomes.

**Build prerequisites:** M03, M04, M05

- **M06-F01:** One engine for prospect, proposal, consent, candidate response, screening, client feedback, interview, offer, joining, guarantee and collection follow-ups.
- **M06-F02:** Event/condition-based enrollment with timezone, business-day calendar, holidays, quiet hours, relevance window, deadline and maximum attempts.
- **M06-F03:** Stop/pause/replan on reply, opt-out, bounce, withdrawal, accepted offer, paid invoice, role closure, reschedule, manual ownership or changed evidence.
- **M06-F04:** Recipient-wide frequency caps and collision arbitration across jobs, campaigns, workspaces/accounts as permitted; merge compatible requests without leaking unrelated context.
- **M06-F05:** Deterministic mandatory reminders plus optional grounded AI personalization; M07 sends, M04 authorizes, M05 runs timers.
- **M06-F06:** Adaptive cadence from explicit preference/outcome data; out-of-office return-date handling, preferred channel, language, contact windows and escalation ladder.
- **M06-F07:** Exactly one active logical follow-up per purpose/recipient/resource/version/step; retries preserve its identity; uncertain delivery enters reconciliation.
- **M06-F08:** Owner timeline: why due, goal, next action, expected stop condition, prior attempts, snooze/handoff, exhausted sequence and recovery options.

**Domain events:** followup.enrolled, followup.due, followup.paused, followup.stopped, followup.exhausted

**Acceptance gate:** Reply/withdrawal/payment arriving just before dispatch cancels the stale attempt; reschedule replaces old timers; two modules cannot create duplicate nudges for the same purpose.

### M07 — Unified inbox, communication aur delivery
**Current baseline:** Mail adapter/outbound records exist; approval chain and delivery concurrency are broken.

**Owns:** Conversations, canonical messages, approved content versions, dispatch intents and delivery attempts/status.

**Build prerequisites:** M02, M03, M04, M05

- **M07-F01:** Unified email/portal/approved messaging inbox with person-company-job linkage, threading, attachments, assignments and authenticated reply capture.
- **M07-F02:** One dispatch gateway for outreach, follow-ups, interview reminders, profile shares, offers and invoices; no direct provider sends in domain workers.
- **M07-F03:** Immutable approved sender/recipient/body/attachments digest, atomic dispatch claim, outbox, retries, provider idempotency where supported and uncertain-outcome reconciliation.
- **M07-F04:** Differentiate drafted, authorized, dispatching, provider_accepted, delivered, bounced, complained, replied and unknown; never infer delivered from send success.
- **M07-F05:** SPF/DKIM/DMARC readiness, sender/mailbox verification, throttling, per-recipient caps, opt-out handling and campaign deliverability feedback.
- **M07-F06:** Unknown inbound intake quarantine with retained authorized evidence, spoofing checks, attachment scan, conversation triage and route-specific minimization.
- **M07-F07:** Templates/localization, consent-aware attachments and voice recording/transcription only where authorized; internal alerts do not bypass external-contact rules.

**Domain events:** message.authorized, message.accepted, message.delivered, message.failed, message.replied, contact.opted_out

**Acceptance gate:** Complete request-approve-dispatch flow works; simultaneous delivery requests produce one logical send; duplicate receipts do not duplicate state; no leaked cross-tenant thread.

### M08 — Recruiter AI, knowledge aur grounded reasoning
**Current baseline:** Six structured AI tasks, short prompts and incomplete scoring inputs.

**Owns:** Model routes, prompt/schema versions, knowledge retrieval, recruiter memory policies, AI runs and evaluation artifacts.

**Build prerequisites:** M02, M03, M04

- **M08-F01:** Task-specific structured tools for discovery, intake, CV extraction, matching explanation, screening assistance, reply/objection handling and negotiation recommendations.
- **M08-F02:** Skill/domain ontology, salary and labor-market sources with region/date/licensing, career chronology, transferable skills and industry-specific evidence retrieval.
- **M08-F03:** Evidence-grounded reasoning with source citations, missing-info questions, conflicting-fact detection and fact-versus-hypothesis labeling.
- **M08-F04:** Full typed context builder; deterministic business/financial calculations outside LLM; calibrated uncertainty and no unsupported promises or fabricated credentials.
- **M08-F05:** Workspace-scoped relationship memory with consent, correction, freshness, retention and deletion; no uncontrolled cross-workspace candidate memory.
- **M08-F06:** Model capability registry, schema-constrained output, prompt injection defenses, tool allowlists, token/cost budgets, fallbacks and provider data-use settings.
- **M08-F07:** Offline recruiter-quality datasets, factuality/bias/error evaluation, adversarial CV/reply tests, version comparisons, shadow/canary rollout and rollback.
- **M08-F08:** AI recommends an authorized command; M04 and the domain validate it. No AI direct SQL, independent consent grant, payment truth or final hiring authority.

**Domain events:** ai.result_ready, ai.needs_evidence, ai.validation_failed, knowledge.updated

**Acceptance gate:** Every material claim links to allowed evidence; incompatible score/confidence is rejected; malicious CV cannot issue tools or expose secrets; model changes pass held-out evaluations.

### M09 — Recruitment strategy aur market intelligence
**Current baseline:** No operational strategy/demand planning engine found.

**Owns:** Recruiting goals, ideal-client profiles, market signals, strategy versions and capacity plans.

**Build prerequisites:** M02, M03, M08

- **M09-F01:** Niche/region/industry/role strategy, target client profile, fee model, revenue targets, recruiter capacity and delivery economics.
- **M09-F02:** Licensed hiring signals, employer demand changes, salary/competition intelligence, seasonality and opportunity qualification with freshness.
- **M09-F03:** Prioritize roles/accounts using feasibility, candidate supply, expected margin, payment risk and workload rather than raw lead volume.
- **M09-F04:** Generate bounded acquisition/sourcing objectives and measurable experiments; M05 starts the approved workflows.
- **M09-F05:** Scenario planning for low response, scarce talent, budget gaps and changing client demand; explain when to pause or escalate.
- **M09-F06:** Policy/cost-aware daily operating plan and exception-only owner brief with evidence and confidence.

**Domain events:** strategy.activated, opportunity.prioritized, capacity.constrained

**Acceptance gate:** A strategy produces a bounded, costed plan with success metrics; unavailable or stale market facts are visible; no workflow starts beyond delegated scope.

### M10 — Client acquisition aur account CRM
**Current baseline:** Manual prospect/contact CRUD and incomplete UI progression.

**Owns:** Organizations, business contacts, opportunities, account qualification, relationship timeline and account-health plans.

**Build prerequisites:** M02, M03, M04, M05, M06, M07, M08, M09

- **M10-F01:** Approved company discovery/enrichment, hiring-signal intake, contact role identification, contact verification, dedupe and conflict/source tracking.
- **M10-F02:** Lead fit, hiring intent, agency openness, credibility and payment-risk qualification; research evidence and disqualification reasons.
- **M10-F03:** Personalized acquisition campaigns and reply routing; M06 owns cadence, M07 delivery, M08 grounded drafting.
- **M10-F04:** Discovery booking, stakeholder map, buying process, objections, lead stage SLAs and automatic next-action requests.
- **M10-F05:** Existing client health, repeat requisitions, referrals, satisfaction/service recovery and renewal opportunities using one account record.
- **M10-F06:** Source attribution, acquisition cost, conversion funnel and do-not-pursue rules; honest observed external outcomes.
- **M10-F07:** Inbound acquisition through a branded service site, referral/partner programs, approved marketplace/RFP proposal channels and campaign landing forms; verified attribution and lead-to-discovery routing use the same CRM, consent and follow-up records.

**Domain events:** prospect.qualified, discovery.requested, account.at_risk, requisition.opportunity_detected

**Acceptance gate:** An approved source can create a deduped opportunity and discovery workflow; reply/opt-out stops its chase; account status cannot fake verified onboarding.

### M11 — Client discovery, negotiation aur agreements
**Current baseline:** Fee drafts and owner-recorded acceptance; commercial terms disconnected downstream.

**Owns:** Commercial engagements, proposal/contract versions, authority limits, acceptance and amendments.

**Build prerequisites:** M02, M03, M04, M05, M06, M07, M08, M10

- **M11-F01:** Structured discovery for hiring urgency, budget, hiring authority, fee expectations, payment reliability, exclusivity and delivery commitments.
- **M11-F02:** Contingency, retained, milestone and contract-placement fee models; guarantees, replacement/refund clauses, candidate ownership and non-circumvention.
- **M11-F03:** Negotiation within explicit fee/discount/credit/term boundaries; explainable counteroffers and escalation for ungranted concessions.
- **M11-F04:** Versioned documents with exact terms hash, authenticated client sign-off/e-sign, authorized signatory and amendment history.
- **M11-F05:** Contract-to-job binding and machine-readable billing/guarantee obligations; M21 owns calculations and money, M20 guarantee execution.
- **M11-F06:** KYB/registry/bank verification through approved adapters where required; separate owner authorization from external verification evidence.

**Domain events:** agreement.accepted, agreement.amended, commercial.exception

**Acceptance gate:** Downstream invoice/guarantee uses the accepted version; unsigned or superseded terms cannot be treated as accepted; unauthorized concessions are blocked.

### M12 — Job intake aur requirement control
**Current baseline:** Structured form/FSM exists; description and genuine client confirmation missing.

**Owns:** Requisition versions, intake facts, hiring scorecards, openings, client confirmations and requisition lifecycle.

**Build prerequisites:** M03, M04, M05, M06, M07, M08, M11

- **M12-F01:** JD/document/email intake, structured clarification conversation, responsibilities, outcomes and weighted assessment scorecard.
- **M12-F02:** Must-have versus trainable skills, equivalent experience, compensation/currency/pay-period, work model, location, notice period and target joining.
- **M12-F03:** Lawful job-relevant work authorization, credential/license, language and relocation requirements; configurable domestic/overseas intake packs.
- **M12-F04:** Requirement contradictions, unrealistic salary/skill combinations, incomplete hiring process and stale criteria flagged before sourcing.
- **M12-F05:** Client-authorized sign-off on an exact requirement version; headcount, replacements, hiring panel, SLAs and change impact.
- **M12-F06:** Amendment/hold/cancel/filled rules invalidate incompatible matches, follow-ups and submissions without erasing history.

**Domain events:** requisition.confirmed, requisition.changed, requisition.paused, requisition.closed

**Acceptance gate:** Sourcing uses a confirmed bound engagement and version; a local button cannot fabricate client sign-off; changed requirements trigger safe re-evaluation.

### M13 — Candidate sourcing aur talent CRM
**Current baseline:** Manual creation and pool search; external ingestion missing.

**Owns:** Candidate profiles, sourcing searches, source submissions, talent pools, availability and relationship preferences.

**Build prerequisites:** M02, M03, M04, M05, M06, M07, M08, M12

- **M13-F01:** Approved job-board/ATS APIs, candidate application portal, referrals, email imports and licensed talent pools with source permissions.
- **M13-F02:** Boolean/semantic talent search, saved searches, passive/active talent pools, previous-candidate rediscovery and schedule-aware sourcing plans.
- **M13-F03:** Identity dedupe/merge via M03, provenance, source freshness, contact validation, skill/experience/availability refresh and referral attribution.
- **M13-F04:** Candidate onboarding and self-service corrections; collect purpose-appropriate consent via M04 rather than manufacture it.
- **M13-F05:** Multi-job candidacies with preference-based contact arbitration; candidate ownership/conflict and agency/client submission history.
- **M13-F06:** Talent community re-engagement, relationship continuity and candidate experience tracking; M06 handles every chase cadence.
- **M13-F07:** Versioned job publishing to owned career pages and approved job boards, application screening intake, sponsored-post budgets, refresh/expiry and close-role depublication; all applicants enter the same dedupe/consent/candidacy pipeline.

**Domain events:** candidate.received, candidate.updated, availability.changed, candidacy.created

**Acceptance gate:** One candidate imported twice merges safely with provenance; opted-out people cannot be silently reactivated; parallel applications stay independent.

### M14 — Document security aur evidence extraction
**Current baseline:** Private storage/parsers/scanner exist; filename overwrite, pre-scan extraction and OCR gaps.

**Owns:** Immutable document objects, document versions, scan/extraction runs, parsed source spans and access receipts.

**Build prerequisites:** M02, M03, M04, M05, M08

- **M14-F01:** Unique immutable object keys, content hashes, versioning, upload limits, quarantine, MIME/signature checks and malware scanning.
- **M14-F02:** PDF/DOCX/text/image OCR with layout/language handling, decompression/parser bounds and clean-scan prerequisite.
- **M14-F03:** Structured CV timeline, employment gaps, overlapping roles, education, certifications and explicitly stated skills; no protected-trait inference.
- **M14-F04:** Each extracted fact links to document version/page/span, parser/model version and confidence; contradictions require clarification.
- **M14-F05:** Secure CV/portfolio/KYB/offer/credential access with expiry, tenant checks, encryption, retention and deletion-tombstone enforcement.
- **M14-F06:** Candidate corrections and document replacements invalidate stale profiles/matches; retryable extraction with visible failure reasons.

**Domain events:** document.clean, document.flagged, extraction.completed, document.superseded

**Acceptance gate:** Same filename never overwrites evidence; scan must complete before extraction/AI; deleted evidence cannot reappear after replay; scanned-image CV works.

### M15 — Evidence-based matching aur ranking
**Current baseline:** Manual evidence or thin per-pair AI payload; no comprehensive ranking.

**Owns:** Match runs, eligibility assessments, score components, evidence explanations and ranked recommendation versions.

**Build prerequisites:** M03, M04, M08, M12, M13, M14

- **M15-F01:** One full context builder for requirements, parsed evidence, current salary/expectations, notice, availability, work model and relevant authorization facts.
- **M15-F02:** Deterministic eligibility rules separated from semantic similarity; weighted explainable scorecards and skill equivalence.
- **M15-F03:** Candidate-to-many-jobs and job-to-many-candidates retrieval/ranking, freshness decay, duplicates and submission conflicts.
- **M15-F04:** Explicit unknown/missing/conflicting evidence, calibration, human-readable trade-offs and evidence-collection requests.
- **M15-F05:** No automatic final hiring rejection; a lawful eligibility flag is distinguishable from client disposition and can be corrected or reviewed.
- **M15-F06:** Outcome-versioned re-ranking, held-out quality metrics and approved A/B tests; no learning directly from biased historical decisions without evaluation.

**Domain events:** match.assessed, match.needs_evidence, ranking.updated

**Acceptance gate:** Missing skills/pay/experience cannot yield fabricated evidence; zero confidence cannot be evidence_validated; a JD/CV change supersedes old rankings.

### M16 — Adaptive screening, assessments aur decision cases
**Current baseline:** Owner-entered answers; final-decision and screening uniqueness defects.

**Owns:** Screening cases, rounds, answers, assessment results, recommendations and authorized progression dispositions.

**Build prerequisites:** M02, M03, M04, M05, M06, M07, M08, M12, M15

- **M16-F01:** Candidate-facing structured chat/forms and optional authorized voice; job-specific adaptive questions and missing-evidence follow-up.
- **M16-F02:** Experience verification, salary/notice/availability alignment, motivation and role-relevant work samples with accessible alternatives.
- **M16-F03:** Assessment integrations, evidence rubrics, fraud/anomaly flags with review, answer provenance and candidate correction.
- **M16-F04:** Multiple screening rounds under one candidacy; case history preserves unique constraints without duplicate-row collisions.
- **M16-F05:** Separate evidence score, recruiter recommendation, owner authorization and client's final hiring disposition.
- **M16-F06:** Non-progression feedback, candidate query/appeal route and permitted re-engagement; sensitive inference and autonomous final rejection are excluded.
- **M16-F07:** One consented reference/background/credential/license verification case lifecycle through approved providers, including candidate correction, discrepancies, expiry, client authorization and evidence receipts; offer/joining modules consume these outcomes instead of building duplicate verification systems.

**Domain events:** screening.completed, screening.needs_information, progression.authorized, disposition.recorded

**Acceptance gate:** Approved not_proceeding cannot authorize a placement; completed interview is not a hire; an existing screening can progress without unique-key failure.

### M17 — Shortlisting, client submission aur review
**Current baseline:** Consent/approval rows; status-only sharing and bypasses.

**Owns:** Submission packages, recipient-specific grants, actual release records, client review and submission outcomes.

**Build prerequisites:** M03, M04, M05, M06, M07, M12, M14, M15, M16

- **M17-F01:** Evidence-backed shortlist with candidate-approved profile, anonymization/redaction, job fit and transparent uncertainties.
- **M17-F02:** Exact job/client/purpose consent plus resource-version authorization; last-moment recheck of withdrawal/DNC/suppression.
- **M17-F03:** Authenticated client review portal and recipient-bound expiring access; download controls, watermarking where needed and revocation.
- **M17-F04:** Actual release/view/feedback evidence with precise semantics; shared means access released, not merely approved.
- **M17-F05:** Client compare/review, request clarification, select interview or record authorized disposition; ownership/exclusivity/submission-conflict rules.
- **M17-F06:** Central follow-ups for unviewed/awaiting-feedback/expired submissions; no parallel shortlist status endpoint can bypass release policy.

**Domain events:** submission.released, submission.viewed, submission.feedback_received, submission.revoked

**Acceptance gate:** Withdrawal between approval and release prevents access; expired links fail; duplicate release is idempotent; client sees only authorized candidates.

### M18 — Interview coordination, calendars aur feedback
**Current baseline:** Manual datetime/ICS/reminders exist; calendar auth, folding and reschedule issues.

**Owns:** Interview rounds, participant availability, slot reservations, calendar event mappings and interview feedback.

**Build prerequisites:** M02, M03, M04, M05, M06, M07, M08, M16, M17

- **M18-F01:** Two-sided availability collection, timezone/DST/business-hour handling, interviewer panels, buffers and conflict-aware slot proposals.
- **M18-F02:** Google/Microsoft free-busy/event sync, meeting creation, ICS fallback, scoped subscription tokens and revocation.
- **M18-F03:** Versioned schedule/RSVP lifecycle, temporary slot holds, reschedule/cancel reconciliation, no-show and alternative-slot recovery.
- **M18-F04:** Preparation packs, authorized reminders, joining instructions, accessibility requests and candidate/client confirmations.
- **M18-F05:** Structured evidence-based feedback, interviewer reminders, differing-feedback reconciliation and explicit next-round/client decision.
- **M18-F06:** All timer/reminder delivery goes through M06/M05/M07; old schedule version invalidates old reminder attempts.

**Domain events:** interview.confirmed, interview.rescheduled, interview.completed, feedback.received, interview.no_show

**Acceptance gate:** DST and duration exports are correct; reschedule cannot send old reminder; unauthenticated calendar cannot leak notes; concurrent slot claims do not double-book.

### M19 — Offer negotiation aur acceptance
**Current baseline:** Internal offer state endpoints; document/delivery/acceptance loop missing.

**Owns:** Offer versions, negotiation cases, authorized compensation terms, signatures and acceptance evidence.

**Build prerequisites:** M02, M03, M04, M05, M06, M07, M08, M11, M12, M16, M18

- **M19-F01:** Client-authorized offer terms, compensation breakdown/currency, benefits, role/location, conditions and intended joining date.
- **M19-F02:** Generate/review/deliver versioned offer packs; secure signatures, expiry, authenticated candidate acceptance or rejection.
- **M19-F03:** Negotiation within explicit client-approved bounds, counteroffer/competing-offer handling without invented facts or promises.
- **M19-F04:** Acceptance linked to exact immutable terms; revised offers supersede older grants and follow-up plans.
- **M19-F05:** Notice/buyout/relocation/credential contingencies, withdrawal/expiry paths and handoff to joining workflow.

**Domain events:** offer.released, offer.countered, offer.accepted, offer.declined, offer.expired

**Acceptance gate:** A status update cannot masquerade as candidate acceptance; unapproved salary concession fails; old-version acceptance is rejected or routed for reconciliation.

### M20 — Joining, placement, retention aur replacement
**Current baseline:** Placement states and default guarantee calculations; no autonomous retention loop.

**Owns:** Joining cases, verified placements, guarantee obligations, retention check-ins and replacement cases.

**Build prerequisites:** M03, M04, M05, M06, M07, M08, M11, M13, M19

- **M20-F01:** Prejoining checklist, notice period, counteroffer/ghosting risk, joining-date changes and candidate/client check-ins.
- **M20-F02:** Authenticated joining evidence from permitted parties; consume M16 identity/background/license verification outcomes and own overseas relocation/visa milestone evidence when applicable. Only the competent external authority can confirm visa/work authorization.
- **M20-F03:** Placement creation tied to an authorized positive disposition and accepted offer; correct candidacy history and rehire semantics.
- **M20-F04:** Guarantee windows, exclusions, replacement/refund eligibility and deadlines derived from accepted engagement, not hard-coded 90 days.
- **M20-F05:** Configurable day-1/7/30/60/90 retention touchpoints, client/candidate satisfaction, attrition signals and escalation.
- **M20-F06:** Replacement obligation creates a linked new recruiting workflow with original invoice/contract linkage and prevents double billing.
- **M20-F07:** Post-guarantee closure, referral/repeat-hiring opportunities and evidence-triggered invoice eligibility.

**Domain events:** joining.verified, placement.invoice_eligible, retention.at_risk, replacement.opened, guarantee.completed

**Acceptance gate:** No negative/unknown decision produces placement; guarantee matches contract version; replacement reuses workflow without duplicating person/financial obligation.

### M21 — Finance, verified collections aur recruiter earnings
**Current baseline:** Manual invoice/payment records; underpayment bug and fake checkout.

**Owns:** Fee calculations, invoices/credits, payment ledger, allocations, reconciliation, disputes and agency/recruiter receivables/payables.

**Build prerequisites:** M02, M03, M04, M05, M06, M07, M11, M20

- **M21-F01:** Contract-derived contingency/retainer/milestone billing, placement salary basis, currency/minor units, tax configuration and sequential invoice numbering.
- **M21-F02:** Versioned compliant invoice/credit documents with escaped output, legal entity/tax details, verified delivery and accounting exports.
- **M21-F03:** Genuine gateway checkout or bank instructions through configured providers; signed events, settlement proof and reconciliation.
- **M21-F04:** Append-only financial entries, atomic payment allocation, partial/overpayment/unallocated credit, refunds, chargebacks and duplicate-event protection.
- **M21-F05:** Separate client payment promises, manual evidence, verified receipts, cleared funds, fee splits and recruiter payout eligibility.
- **M21-F06:** Accounts receivable aging, promise-to-pay plans, dispute freezes and M06-controlled dunning; no AI-derived paid status.
- **M21-F07:** Commission splits/referral fees/subcontractor milestones, payout approvals and contribution margin; payroll/EOR only through a separately enabled adapter and contract scope.

**Domain events:** invoice.issued, payment.verified, balance.changed, invoice.disputed, payout.eligible

**Acceptance gate:** Paying 1 toward 100000 leaves 99999 outstanding; duplicate webhook adds zero; concurrent allocations preserve balance; checkout creates an actual provider session; currency/tax/guarantee terms match contract.

### M22 — Owner command center, exceptions aur handoff
**Current baseline:** Dashboard/approval/incident lists exist; incomplete action wiring.

**Owns:** Business exception cases, human assignments, SLA escalations, manual interventions and operator action history.

**Build prerequisites:** M01, M04, M05, M06, M07

- **M22-F01:** Exception-first cockpit showing business objectives, stalled processes, blocked prerequisites, due follow-ups, spend and last verified outcomes.
- **M22-F02:** Decision inbox with evidence, exact proposed effect, policy reason, resource version, approve/reject/delegate/cancel and grace-period visibility.
- **M22-F03:** Unified case taxonomy for provider failures, unmatched inbound, consent disputes, conflicting facts, deadlines and commercial exceptions.
- **M22-F04:** Manual takeover with automation pause for that scope, task ownership, notes and deliberate resume/reconciliation.
- **M22-F05:** Daily/weekly operating brief, SLA ladder and internal alert routing; one case links infrastructure incident IDs from M25 rather than duplicate incidents.
- **M22-F06:** Full-path actions from the UI instead of dead-end status badges; operational support/search and reviewable audit evidence.

**Domain events:** case.opened, case.assigned, case.resolved, manual_takeover.started

**Acceptance gate:** Every blocked workflow has reason, owner and recovery action; manual takeover stops automation in that scope; resolving a case safely resumes once.

### M23 — Analytics, attribution aur controlled improvement
**Current baseline:** Dashboard counts/basic quota reporting.

**Owns:** Metric definitions, analytical read models, attribution, experiments and business/evaluation reports.

**Build prerequisites:** M03, M05, M06, M07, M08

- **M23-F01:** Funnel metrics from sourced lead to cleared revenue; response/qualification/offer/joining/replacement conversion and time-in-stage.
- **M23-F02:** Follow-up effectiveness by step/channel/persona, fatigue/complaint signals, attribution and incremental conversion rather than just open rates.
- **M23-F03:** Source quality, candidate experience, client satisfaction, recruiter effort saved, cost-per-placement, margin and cash collection.
- **M23-F04:** Workflow lag, SLA misses, task retries, model cost/factuality, ranking calibration and observable automation coverage.
- **M23-F05:** Controlled cadence/prompt/ranking experiments with privacy, holdouts, minimum evidence, drift monitoring and rollback.
- **M23-F06:** Versioned metrics and reconciled finance totals; optimization proposes changes to M04/M08/M09 instead of silently rewriting policies or hiring criteria.

**Domain events:** metric.threshold_crossed, experiment.evaluated, improvement.proposed

**Acceptance gate:** Metric totals reconcile to source ledgers; a replay does not double-count; experiments cannot exceed consent/contact caps or become autonomous policy changes.

### M24 — Product experience: owner, client aur candidate portals
**Current baseline:** Owner pages exist; key APIs unwired and external portals missing.

**Owns:** UI composition, route navigation, accessibility/localization, public-facing forms and notification preferences; no duplicate domain authority.

**Build prerequisites:** M01, M04, M07, M22

- **M24-F01:** Owner workspaces for strategy, CRM, agreements, jobs, talent, matching, screening, submissions, interviews, offers, joining, finance, follow-ups and exceptions.
- **M24-F02:** Client portal for approved requirements/contracts, shortlisted profiles, availability, feedback, offers, joining confirmation and invoices.
- **M24-F03:** Candidate portal for profile/CV, consent, corrections/withdrawal, screening, availability, offer acceptance, joining updates and privacy requests.
- **M24-F04:** Responsive mobile, keyboard/screen-reader support, localized communications/timezones, accessible assessments and secure session transitions.
- **M24-F05:** One domain command per action; capability-based navigation, clear empty/loading/error/permission states and forms preserved on failed saves.
- **M24-F06:** Visible distinction between draft, authorized, sent, delivered, accepted and verified; no success toast before persisted success.
- **M24-F07:** Follow-up timeline showing intent, cadence, pause/stop reason and owner intervention for each relevant party.

**Domain events:** No separate business events; UI invokes owning-domain commands.

**Acceptance gate:** Every launch-critical backend journey is usable in UI; failed mutation preserves input; client/candidate views cannot expose internal notes or other participants' records.

### M25 — Security operations, reliability aur release quality
**Current baseline:** Build/typecheck and mock tests pass partly; no production evidence established.

**Owns:** Runtime/deployment configuration, security controls, technical incidents, telemetry, backup/restore and release gates.

**Build prerequisites:** M01, M02, M03, M04, M05

- **M25-F01:** Production secrets management, environment separation, hardened auth/session/CORS/CSRF boundaries, rate limits, dependency and upload security.
- **M25-F02:** Transactional migrations, restore drills, encrypted backups, retention/deletion propagation, capacity planning and tested rollback.
- **M25-F03:** Structured redacted logs, traces and metrics correlated to workflow/action/provider attempts; security events and tamper-evident audit exports.
- **M25-F04:** Real MySQL integration tests, provider sandboxes/contracts, browser owner/client/candidate journeys, concurrency/property tests and chaos/recovery tests.
- **M25-F05:** Environment startup/install reproducibility, readiness versus liveness versus provider capability; no mock-success acceptance in production.
- **M25-F06:** Feature flags, shadow execution, controlled canaries, kill switches, recovery runbooks, staged production verification and regression ownership.
- **M25-F07:** Set explicit scale, uptime/latency, recovery and cost targets from pilot measurements; alerts and release criteria enforce approved targets.

**Domain events:** runtime.degraded, security.incident, restore.verified, release.verified

**Acceptance gate:** Restore recovers authoritative records and revocations; kill-switch behavior verified; no tenant/PII/finance release blocker remains; live capability claims have current evidence.

## 5. Follow-up — one cross-platform engine, not a missing extra feature
M06 is a first-class module with dedicated UI, operational metrics and acceptance tests. Every domain specifies a business objective and stop conditions; it cannot implement an independent follow-up loop.

### 5.1 Follow-up lifecycle and contract
A versioned follow-up plan declares:
- workspace; person/contact; permitted channel; subject resource and version; business purpose; related conversation;
- trigger event; desired outcome; due rule; recipient timezone/business calendar; priority and deadline;
- sequence version; step index; maximum attempts; minimum spacing; per-person/per-sender caps; cost budget;
- required consent and action grant; content template/version; allowed personalization evidence;
- immediate stop, pause, escalation and resumption conditions; owning operator; evidence retention class.

State progression: proposed → eligibility_checked → scheduled → due → dispatch_pending → waiting_for_outcome → completed. Branches: paused, cancelled, exhausted, failed and reconciliation_required. Provider accepted/delivered/replied are message facts from M07, not alternate follow-up states.

Only M05 owns the durable due timer. A denormalized nextActionAt is a rebuildable projection. Only M07 can dispatch. M04 is rechecked at enrollment, due-time and immediately before provider dispatch.

A recipient reply pauses active chase steps before AI classification. Deterministic unsubscribe/withdrawal immediately stops contact; uncertain intent is reviewed while outreach remains paused. Reply events must have a canonical participant/conversation match; ambiguous events open a case.

### 5.2 Full follow-up catalog
Proposed cadences below are **configurable pilot templates**, not active settings or universally suitable limits. All require legal/purpose eligibility, explicit delegated scope and contact budgets. “Business day” uses the intended recipient's calendar. Delivery must not be claimed from a planned date.

| ID | Stage / trigger | Follow-up objective and example cadence | Stop / pause / escalate |
|---|---|---|---|
| FU01 | Approved prospect acquisition | Relevant first contact; optional +3/+7 business-day nudges, bounded sequence | Any reply pauses; opt-out/bounce stops; exhaustion closes or schedules permitted later review |
| FU02 | Discovery slot requested | Obtain stakeholder availability; +1/+3 business days | Booking/cancellation stops; missing authority opens case |
| FU03 | Discovery completed | Collect missing scope/budget/decision-maker facts; +2/+5 business days | Required facts received; explicit refusal stops |
| FU04 | Proposal sent | Confirm review, answer objections; +2/+5/+10 business days | Reply pauses; accepted/declined/superseded proposal cancels |
| FU05 | Agreement awaiting signature | Authenticate acceptance of current version before expiry | Signed/withdrawn/revised stops; expired signature link cannot continue |
| FU06 | Job intake incomplete | Collect mandatory skills, pay, process and deadlines | Requirement becomes complete, role paused/closed or client opts out |
| FU07 | Requirement awaiting confirmation | Obtain exact-version client sign-off | Sign-off/revision cancels old plan; no fabricated confirmation |
| FU08 | Candidate consent request permitted | Ask for required purpose/channel consent, at most bounded permitted reminders | Consent granted/refused/withdrawn/expired; refusal never treated as interest |
| FU09 | Candidate first contact | Determine interest and preferences; +2/+5 business days if eligible | Reply pauses; DNC/withdrawal/filled role stops |
| FU10 | Missing CV/profile facts | Request required evidence through secure portal | Upload/correction resolves; expiry escalates; avoid repeatedly requesting existing data |
| FU11 | Screening started/incomplete | Complete saved screening, accessible alternate route | Submitted/declined/job closed stops; maximum attempts escalates |
| FU12 | Assessment invited | Remind before agreed deadline; resolve access/accommodation issues | Completed/withdrawn/version changed; never penalize accessibility request |
| FU13 | Candidate clarification pending | Resolve contradictory or missing role evidence | Answer/correction received; unresolved becomes review-needed |
| FU14 | Consent for client submission | Obtain exact client/job/version sharing permission | Granted/declined/expired/withdrawn; never reuse another client's consent |
| FU15 | Client has not reviewed submission | Prompt review within contractual SLA | Viewed may switch to feedback plan; revoked/expired/role closed stops |
| FU16 | Client feedback missing | Request actionable feedback and next-step decision | Feedback/disposition received; job hold pauses |
| FU17 | Interview availability needed | Collect both parties' windows and confirm slot | Slot confirmed/cancelled; no duplicate candidate/interviewer chase |
| FU18 | Confirmed interview approaching | Deterministic eligible reminders, e.g. 24h/2h before; combine when too close | Cancel/reschedule/version mismatch invalidates; past event never sends a preparation reminder |
| FU19 | Interview no-show/reschedule | Establish reason and offer alternatives | New confirmed schedule, withdrawal or operator takeover |
| FU20 | Interview feedback pending | Request evidence-based scorecard, e.g. +1/+2 business days | Submitted; overdue escalates to account owner without invented decision |
| FU21 | Offer review/negotiation pending | Answer questions and track genuine response before expiry | Accepted/declined/revised/expired; old offer plan cancelled |
| FU22 | Notice period / prejoining | Check notice milestones, blockers and counteroffers at agreed intervals | Date change replans; withdrawal stops; heightened risk opens case |
| FU23 | Joining-day confirmation | Obtain candidate/client joining evidence and resolve mismatch | Verified joined/non-joined; conflicting evidence requires review |
| FU24 | Retention / guarantee | Contract-appropriate day-1/7/30/60/90 check-ins | Guarantee ends/placement closes; concern starts a service case, not automatic termination |
| FU25 | Replacement obligation | Collect issue evidence and progress linked replacement search | Resolved/contract ruling; dispute pauses automatic commercial changes |
| FU26 | Invoice approaching due / overdue | Deliver receipt, pre-due and bounded post-due reminders using actual remaining balance | Verified paid stops; dispute/promise-to-pay changes cadence; no threats or invented legal claims |
| FU27 | Promise to pay / partial payment | Acknowledge payment, chase only remaining agreed balance after promised date | Cleared balance/dispute/new verified agreement; allocation mismatch opens finance case |
| FU28 | Client renewal / repeat hiring | Request service feedback, upcoming roles and referrals where permitted | Opt-out/inactivity rule; account owner controls relationship strategy |
| FU29 | Candidate availability refresh / talent community | Preference-based availability/skill refresh at an agreed interval | DNC/withdrawal/changed preference; no reactivation without valid scope |
| FU30 | Rights request / complaint / critical exception | Internal SLA reminders and permitted acknowledgments | Resolved with evidence; missed SLA escalates; no sales follow-up overlaps |
| FU31 | Reference/background/credential verification pending | Collect authorized third-party responses or candidate corrections before the agreed deadline | Verified outcome/dispute/withdrawn authorization; unresolved discrepancy goes to review |
| FU32 | Overseas relocation/visa milestone pending | Request required document or official milestone update through the permitted party | Official status received/date changed/placement withdrawn; never invent an approval |

### 5.3 Collision and race resolution
Priority is configured by business purpose and obligation: rights/withdrawal > imminent confirmed interview or joining > explicit active conversation > overdue contractual commitment > ordinary acquisition/reactivation. Channel/country/purpose rules still apply; priority never creates missing consent.

- One contact can have several candidacies, but one recipient-level arbiter sees permitted pending intents within that workspace/account scope.
- Opt-out/withdrawal affects all applicable purposes; client/job closure affects that resource; accepted offer can pause competing campaign objectives according to candidate preference.
- Compatible intents may be combined only when recipients and authorized data scopes match. Never reveal another client/job to an unauthorized party.
- For cross-workspace contact caps, use only an approved sender-operator scope or privacy-preserving mechanism; do not expose one tenant's contact history to another.
- The send command performs a compare-and-set against current enrollment/resource versions. A cancellation that precedes the committed dispatch claim wins; a send already accepted by a provider cannot be unsent and must be recorded honestly.
- Provider timeout/unknown outcome is not a new campaign attempt. Reconcile before deciding a resend.
- Email open tracking is optional, consent-aware and unreliable; do not use it as proof of a human review or as the only trigger.
- Internal operational escalation is separate from contacting an external person. No infinite retries, repeated fresh conversations or channel-switching to bypass an opt-out.

### 5.4 Required follow-up tests
Test all 32 catalog scenarios with representative domain fixtures. Add reply-versus-send races, payment-versus-dunning races, offer revision, reschedule, DST/holiday boundaries, contact cap exhaustion, language preference, out-of-office, duplicate enrollment, duplicate provider event, crash recovery, opt-out across channels, conflicting job intents, consent expiry and manual handoff.

## 6. Non-duplication and conflict-resolution register
| Capability | Single owner | Other modules must do | Forbidden parallel implementation |
|---|---|---|---|
| User/workspace/portal identity | M01 | Ask for scoped access | Separate client/candidate auth bypasses |
| Provider SDK/auth/webhook transport | M02 | Use versioned adapters | Direct new provider clients in routers/workers |
| Identity merge/provenance conventions | M03 | Keep domain records and reference canonical identity | Multiple conflicting person/company copies |
| Consent/suppression/delegation | M04 | Check shared authorization APIs at execution | Router-specific permission/consent logic |
| Durable timers/worker attempts | M05 | Register typed tasks/timer requests | Module-local cron/sleep loops |
| Follow-up business cadence | M06 | Enroll/cancel/change objective | Separate interview, sales and finance cadence engines |
| External message lifecycle | M07 | Request dispatch of authorized content | Direct mail sends in reminder/approval/domain handlers |
| AI prompts/context/models/memory | M08 | Supply typed evidence and request bounded results | Page-specific prompts or direct AI business writes |
| Market/business strategy | M09 | Supply outcomes and capacity | AI planner mutating acquisition or financial truth |
| Account/contact relationship state | M10 | Link to organization/contact | New CRM for contracts, finance or retention |
| Contract terms/acceptance | M11 | Read accepted immutable version | Fee/guarantee copies editable elsewhere |
| Requisition requirements | M12 | Reference version | Scoring-specific or UI-only JD truth |
| Person's recruiting profile | M13 | Create candidacy links through canonical IDs | One global candidate pipeline for every job |
| Documents/extracted source spans | M14 | Reference grants/evidence | Copied CV text in unrelated long-lived job payloads |
| Match score/recommendation | M15 | Consume versioned assessment | Independent score calculations in UI or queue |
| Screening and progression case | M16 | Use explicit disposition | Treat owner_decided/completed as selected |
| Client submission release | M17 | Request authorized release | Generic setStatus(shared) mutation |
| Interview/calendar/feedback | M18 | Act on versioned schedule/events | Independent reminder sender or public numeric calendar feed |
| Offers and acceptance | M19 | Reference authenticated accepted version | Placement status pretending candidate acceptance |
| Joining/guarantee/replacement | M20 | Use verified obligation events | Hard-coded guarantees or second placement truth |
| Payment/balance/tax/collections truth | M21 | Read ledger-derived balance | AI or generic approval setting paid |
| Business exception/handoff | M22 | Open/link one case | Duplicate exception lists with separate state |
| Analytics | M23 | Publish domain facts | Dashboard counters becoming authoritative records |
| UI/portal presentation | M24 | Invoke canonical commands | Browser-only validation or duplicate business rules |
| Infrastructure/release/security operations | M25 | Supply health/evidence/runbooks | Mock-based production readiness claims |

### Conflict decisions already resolved by this plan
- **Full automation versus universal manual approval:** routine actions run under explicit, versioned delegation; ungranted actions go to exceptions. Candidate consent, client terms, offer acceptance and final hiring disposition remain genuine outside-party authority. Do not silently flip all existing allowAutoApproval flags.
- **AI scoring versus hiring decisions:** AI supplies evidence/uncertainty; deterministic rules enforce eligibility; authorized domain commands record decisions. Non-progression is never a positive placement authorization.
- **Follow-up versus workflow versus messaging:** M06 decides what needs chasing, M05 decides when a durable task runs, M07 controls delivery. They share identifiers rather than implement one another.
- **Emergency stop versus obligations:** global/scoped stop blocks applicable outbound/action execution; essential privacy/security processing and internal alerts remain possible. Any time-critical external exception requires an explicit preauthorized policy and is visible.
- **Immutable history versus correction/erasure:** retain permitted minimal metadata/financial legal records while removing/restricting PII as policy requires. Use tombstones/key destruction/redaction and legal-hold records; do not promise that every audit value is eternally immutable.
- **Multiple roles versus duplicate profiles:** one canonical person with separate candidacies; one organization with separate opportunities/contracts/jobs.
- **Provider send versus delivered:** preserve separate facts; provider acceptance is not delivery or client review.
- **Financial ledger versus status labels:** remaining balance and verified entries determine settlement; partial payment cannot become full payment through a generic status route.
- **International coverage versus assumed compliance:** jurisdiction packs and approved providers supply applicable requirements; unsupported regions/capabilities show blocked/unsupported rather than simulated success.
- **Advanced architecture versus maintainability:** logical boundaries now; extract services or add specialized stores only after load/ownership evidence warrants them.

## 7. Domain/event/API contracts
### 7.1 Record and write model
Refactor in compatible migrations rather than a destructive rewrite:
- Separate workspace membership from historical ownerId; backfill stable workspace linkage and enforce cross-entity workspace consistency.
- Introduce candidacy/application per candidate + requisition + engagement context, with screening rounds and attempt history beneath it.
- Split the current placements-based offer fields into a canonical offer aggregate and verified placement aggregate; preserve IDs/mapping for existing consumers.
- Keep canonical communications records with delivery attempts, separate authorizations and follow-up enrollments.
- Add outbox/inbox, timer/workflow/attempt tables, source/evidence versions, consent grants/tombstones and financial allocations.
- Current screening/placement unique indexes must be reconciled with round/rehire history before enabling those flows.
- Store large/sensitive evidence by authorized reference; do not scatter CV text across indefinite queue/result copies.
- Read models for dashboards/search may be eventually consistent; eligibility, authorization, slot claims and financial allocations use current authoritative state.

### 7.2 Minimum event envelope
Every durable event: eventId, eventType, schemaVersion, workspaceId, aggregateType, aggregateId, aggregateVersion, actor/service identity, occurredAtUTC, correlationId, causationId, policyVersion where relevant, payload/evidence references and data-classification/retention labels.

Event payloads contain minimal facts or authorized references, not secrets or an indiscriminate copy of a candidate dossier. Consumers deduplicate by eventId and track aggregate version/order. Event repair/backfill uses the same idempotent domain commands.

### 7.3 Command and authorization contract
Every mutating command: commandId/idempotencyKey, workspaceId, actor/delegationGrantId, resourceId, expectedVersion, requested effect, evidence references, purpose and correlationId.

Validate authentication → workspace/role → current consent/suppression → action grant/version/content → business preconditions → budget → transactional state claim/outbox. Worker revalidates dynamic prerequisites at dispatch. All UI, API, cron and worker entry points use the same command.

Logical idempotency includes workspace + action purpose + aggregate/version + step/attempt identity; retry is not a fresh business action. Never use only a random new ID to “prevent duplicates.”

### 7.4 Integration outcome model
Request recorded → atomic execution claim → provider call → accepted/delivered/failed/unknown evidence → reconcile → domain confirmation. Webhooks authenticate, persist/deduplicate, acknowledge safely and process asynchronously. Retries, refunds, cancellations and settlements are explicit events, not edits to historical receipts.

### 7.5 Core invariants
1. No negative/unknown hiring disposition authorizes a placement.
2. No share without valid exact-scope consent and release authorization at execution.
3. No revoked/erased data resurfaces from delayed tasks, model memory or replay.
4. No duplicate delivery/payment/allocation from concurrency, replay or worker restart.
5. No invoice is settled unless verified allocated receipts/credits satisfy the balance.
6. No schedule registration is ready without an actual persisted timer/provider callback.
7. No document extraction precedes required clean scan; same-name uploads never overwrite.
8. No old requirement/offer/schedule/policy approval executes against a newer version.
9. No data is read across tenants or external-party scopes through direct routes, downloads or reports.
10. No automated action occurs merely because AI emitted a suggested nextAction.

## 8. Audit-to-implementation traceability
All 34 findings in the code audit are assigned to registered feature packages. This is remediation ownership, not a claim that the issue has been fixed.

| Finding | Problem | Owning feature packages | Acceptance journeys |
|---|---|---|---|
| R1 | Calendar notes exposed | M01-F04 · M18-F02 | J12 |
| R2 | Unsupported email approval | M04-F01 · M07-F03 | J09 · J13 |
| R3 | Negative disposition permits placement | M16-F05 · M20-F03 | J03 · J05 |
| R4 | Partial payment marks paid | M21-F04 | J06 |
| R5 | Direct shared-state bypass | M04-F05 · M17-F06 | J04 · J07 |
| R6 | Stale approval revives withdrawn share | M04-F04 · M04-F05 · M17-F02 | J07 · J08 |
| R7 | Incomplete matching context | M08-F04 · M12-F01 · M15-F01 | J02 |
| C1 | Autopilot policy/mode contradiction | M04-F02 · M04-F08 · M05-F06 | J13 |
| C2 | Mock scheduler success | M02-F05 · M05-F02 | J09 · J13 |
| C3 | No business orchestration | M05-F01 · M06-F01 | J01 · J13 |
| C4 | Stranded running jobs | M05-F03 | J09 |
| C5 | Duplicate usage insert breaks recovery | M05-F05 · M08-F06 | J09 |
| C6 | Concurrent/crash duplicate sends | M07-F03 · M05-F05 | J09 |
| C7 | Reminder authority/context/reschedule mismatch | M06-F03 · M18-F06 | J08 |
| C8 | Quota blocks deterministic work | M05-F04 · M05-F06 | J09 · J13 |
| C9 | Real-DB screening/placement constraints | M03-F06 · M16-F04 · M20-F03 | J03 · J05 |
| C10 | Approval transaction/state race | M04-F05 · M05-F05 | J07 · J09 |
| M1 | Missing acquisition/sourcing connectors | M02-F04 · M10-F01 · M13-F01 | J01 · J02 |
| M2 | Outreach without campaign loop | M06-F01 · M07-F05 · M07-F06 · M10-F03 | J01 · J11 |
| M3 | Screening/negotiation/portals missing | M11-F03 · M16-F01 · M19-F02 · M24-F02 · M24-F03 | J01 · J03 · J05 |
| M4 | Submission/onboarding overstate truth | M11-F06 · M17-F03 · M17-F04 | J01 · J04 |
| M5 | Fake gateway checkout | M21-F03 | J06 |
| M6 | Contract not driving finance/guarantees | M11-F05 · M20-F04 · M21-F01 | J05 · J06 · J10 |
| M7 | Expert judgement/memory missing | M08-F02 · M08-F03 · M08-F05 · M08-F07 · M09-F04 | J02 · J13 |
| D1 | Consent paths conflict | M04-F03 · M04-F04 · M17-F02 | J04 · J07 |
| D2 | Incomplete deletion/repopulation | M04-F06 · M14-F05 | J07 · J14 |
| D3 | Filename overwrites | M14-F01 | J02 · J07 |
| D4 | Pre-scan extraction/heuristic scanner | M14-F01 · M14-F02 | J02 |
| D5 | Hard-coded privilege/unverified email | M01-F01 · M04-F07 | J12 |
| D6 | Unwired UI/error states | M22-F06 · M24-F01 · M24-F05 · M24-F06 | J01 · J02 · J03 · J04 · J05 · J06 |
| D7 | Fabricated job confirmation | M12-F05 · M24-F02 | J01 |
| D8 | Calendar and invoice presentation errors | M18-F02 · M18-F03 · M21-F02 | J04 · J06 |
| D9 | Readiness is mere config presence | M02-F02 · M25-F05 | J09 · J13 |
| D10 | Mock tests/acceptance overclaim | M03-F06 · M25-F04 · M25-F07 | J01 · J02 · J03 · J04 · J05 · J06 · J14 |

## 9. Delivery waves and exit gates
These waves are dependency-ordered deliverables, not date estimates or a claim that partially built modules are complete. Every feature package stays open until its implementation, UI, tests and operational proof are linked in the registry. The similarly labeled code increments in the implementation-progress record are smaller slices; a completed increment does not certify a delivery-wave exit gate.

| Wave | Required work | Exit gate |
|---|---|---|
| W0 — Correctness baseline | Freeze audit baseline; reproduce/fix critical defects; remove stale acceptance claims; real-MySQL fixtures; regression ownership | R1–R7 mitigated, urgent privacy/identity/document issues blocked or fixed; no unsupported success paths; recorded baseline distinguishes remaining gaps |
| W1 — Shared execution foundation | M01–M08 contracts/foundation plus M25; canonical actions, consent, inbox/outbox, reliable timers/workers, send gateway, follow-up enrollment, grounded context | Crash/replay/concurrency/tenant/withdrawal tests pass; timer and email sandbox outcome proven; manual takeover and kill switches work |
| W2 — Complete recruitment vertical slice | Minimal M09/M10 objective/account; M11–M21 through one supported engagement, source, channel and jurisdiction; functional M22/M24 owner/client/candidate journeys | A permitted real/sandbox source becomes a verified candidate journey through client feedback, accepted offer, joining evidence, contract invoice and verified payment, with pauses/restarts |
| W3 — Autonomous acquisition and all-stage follow-up | M09/M10 acquisition depth, M13 sourcing depth, every FU01–FU32 scenario, external portals, missing-info loops and delegated routine execution | An approved objective progresses without operator clicks except explicit authority/exception boundaries; contact collisions and stop events verified end-to-end |
| W4 — Advanced intelligence and commercial breadth | Remaining M08–M21 advanced packages, M23, multi-provider/channel capability packs, overseas/retainer/milestone/contract variants | Quality evaluations and selected provider/jurisdiction suites pass; all 163 packages have implementation/integration evidence; optional provider activation is tracked separately and cannot conceal an incomplete core capability |
| W5 — Production acceptance and controlled rollout | Full M22–M25 completion, performance/security/restore drills, staged live validations, runbooks and owner handover | All launch gates pass; every enabled external capability validated; open defects classified; no missing core path is relabeled configuration-only |

Within W2, respect this business order: agreement/account → confirmed requisition → candidate intake/evidence → eligibility/matching → screening → submission → interview/feedback → offer → joining → invoice/payment. M14 extraction can be built alongside candidate intake. Foundational M21 ledger tests should begin before live financial execution, not after funds are involved.

W0 remediation priority:
1. Calendar authorization, hard-coded privilege, share bypass/stale consent, erasure resurrection and immutable document keys.
2. Email approval/dispatch chain and send concurrency/unknown outcomes.
3. Positive-disposition validation and real-DB screening/placement constraints.
4. Partial payments/atomic allocations and verified checkout.
5. Complete matching context, honest readiness and consistent reminder authority.
6. Stale leases/usage-write failure handling, scheduler truth, then all remaining mapped defects.

## 10. Test and release strategy
### 10.1 Definition of done for every feature package
- One named module owner; schema/constraints and command/event contracts reviewed.
- Domain rule implemented once; UI/API/worker entry points use it.
- Permissions/consent/purpose/version/idempotency requirements specified.
- Normal, failed, duplicate, concurrent, stale and revoked paths tested where applicable.
- Real MySQL integration coverage for transactional behavior, not only the mock store.
- A usable owner/client/candidate experience for its intended actor; error states preserve work.
- Telemetry and recovery path; no secret/PII log dumps.
- Provider-dependent package includes sandbox/contract evidence and a separate activation check for the connected live capability.
- Evidence links: source, migration, tests, demo/observed result, deployment setting and known limitations.
- No duplicate owner, unresolved authority conflict or unregistered follow-up/timer/sender.

### 10.2 Mandatory cross-module journeys
J01: approved client source → qualified lead → discovery → signed terms → confirmed requirement.
J02: approved candidate intake → consent → clean document/OCR → evidence profile → full-context ranking.
J03: incomplete candidate → adaptive screening → clarify evidence → explicit authorized progression.
J04: correct client/job consent → actual submission → client review → interview scheduling/feedback.
J05: offer negotiation within limits → genuine acceptance → prejoining check-ins → verified joining.
J06: contract-derived invoice → actual provider checkout/bank evidence → partial receipt → full cleared balance.
J07: complaint/withdrawal/erasure during queued tasks → cancel/restrict/redact → no resurrection.
J08: reschedule/offer revision/role cancellation during queued follow-up → old version cannot act.
J09: provider timeout + duplicate webhook + worker crash → reconcile without duplicate delivery/payment.
J10: replacement within actual contract guarantee → linked new workflow → correct billing/credit.
J11: multiple jobs chasing one candidate → recipient arbitration respects preference and caps.
J12: client/candidate/team outsider attempts direct API/download/feed access → denied without disclosure.
J13: permitted delegated routine execution → exceptions only → manual takeover → controlled resume.
J14: production backup/restore → records, revocations, timers and ledgers remain consistent.
J15: inbound service lead or approved proposal → same CRM → discovery; no duplicate marketing-contact identity.
J16: confirmed job → approved publication → applicant intake/dedupe → closed role removes stale advertisement.
J17: authorized reference/credential case → corrected/verified evidence → offer/joining consumes the same outcome; overseas official milestone stays distinct.

### 10.3 Proposed initial operating objectives
Targets are design objectives to validate with representative pilot data, not current measured performance:
- Bounded non-AI API p95 below 500 ms on the agreed load profile; long-running provider/model work asynchronous with progress.
- Due-timer processing p95 within 60 seconds under that profile; prioritize imminent interview/joining obligations over background enrichment.
- No authorization-after-revocation, cross-workspace disclosure or incorrect financial-balance outcomes in release tests.
- Crash-recovery within the configured lease/reconciliation bound, visibly monitored.
- Initial recovery objectives: RPO at most 15 minutes and RTO at most 60 minutes, contingent on validated hosting/database backup capability.
- Provider/model cost caps and contact caps enforced atomically; alerts before exhaustion.
- Document the load profile (workspaces, jobs, candidates, concurrent workers, sends and provider limits) before declaring capacity.

Zero-defect statements concern verified invariants/test outcomes, not an assertion that arbitrary external providers can never fail.

### 10.4 Release blocking conditions
Unresolved cross-tenant access, fabricated external truth, bypassable consent, incorrect balances, unbounded outbound/retries, unrecoverable workflows, unsupported scheduler success, missing core portal path, erased-data resurrection or absent recovery evidence block release of the affected capability. Optional providers remain visibly inactive until connected and verified.

## 11. Existing-code migration map
| Existing surface | Target owner / change |
|---|---|
| server/_core/trpc.ts, context.ts, services/workspaceAccess.ts, primaryOwner.ts, runtimeAuth.ts | M01/M04: shared identity, verified privilege and purpose/action authorization |
| server/services/hostingerMail.ts, hostingerWebhook.ts and other provider helpers | M02 adapter boundary; M07 messages/inbox lifecycle; one normalized webhook route |
| drizzle/schema.ts and server/mockDb.ts | M03 conventions; authoritative domain migrations; real-MySQL test fixtures; mock remains a limited test utility |
| server/workflow.ts, services/policyEngine.ts, approvalEngine.ts | M04 canonical action registry; domain modules own effects; no generic status bypass |
| server/services/queue.ts, _core/heartbeat.ts | M05 durable worker/timer/outbox; move AI tasks to M08 contracts and domain handlers |
| server/services/interviewReminders.ts, conversations.nextActionAt | M06 enrollment/timer projection; M18 declares schedule intent; M07 dispatches |
| server/routers/outreach.ts, routers/email.ts | M06/M07: campaigns/inbox/dispatch; M10/M13 supply business context |
| routers/recruitment.ts prospects/jobs/candidates | Split logical ownership into M10/M12/M13 without creating competing state writers |
| candidateWorkflows.ts screening/shortlist/privacy routes | M16/M17/M04; compatibility routes invoke canonical commands |
| services/documentScanner.ts, documentText.ts, privateStorage.ts | M14 document lifecycle; M02 storage adapter; M04 erasure/retention |
| services/openrouter.ts, aiRouting.ts, _core/llm.ts | M08 shared context/prompts/evaluation and model adapter routing |
| matching routes | M15; complete source context, deterministic eligibility and versioned ranking |
| interviews/feedback routes, services/calendar.ts | M18 with central M06/M07 follow-up/delivery and M01 token protection |
| placements offer/joining fields | M19 offer aggregate + M20 verified placement/obligation, with ID compatibility |
| services/invoicing.ts, invoice/payment routes | M21 ledger/calculations/reconciliation; eliminate fake provider checkout |
| operations.ts exceptions/dashboard/control | M22 command center; M23 projections; M04 policy writes; M25 readiness |
| client/src/pages/WorkspaceViews.tsx | M24 role/domain journeys; replace unwired/false-success controls |
| PLATFORM_ACCEPTANCE.md and completion docs | M25 evidence-based release record; update only from observed current checks |

Migration discipline: inventory consumers → define canonical command → focused regression → schema backfill/constraint repair → compatibility adapter → migrate UI/workers → observe shadow/read comparisons → remove old write path. Never keep two live writers as a permanent transition state.

## 12. Provider and rollout decision register
- **Runtime/database:** retain current TypeScript/MySQL stack; explicitly verify Node/pnpm versions and migration tooling in reproducible setup.
- **Email:** retain Hostinger as the first adapter if real mailbox permissions/delivery/webhooks validate; no silent replacement.
- **Portals:** own client/candidate portals provide a provider-independent workflow for consent, evidence, feedback and signatures where supported.
- **Calendar:** implement shared Google/Microsoft contract; activate the connected account's provider and retain secure ICS fallback.
- **Payments:** actual gateway/bank route must support the business entity, region, currency and settlement; India and overseas provider packs are separate activation decisions. Do not assume provider=stripe means a valid checkout.
- **Sourcing:** start with an explicitly approved API, licensed feed or candidate-owned application/import path; unsupported platforms are not scraped through copied sessions.
- **AI:** route through current provider adapters with model/data-use/evaluation checks; no assumption that an absent managed-service credential is available.
- **Messaging/voice:** advanced roadmap includes approved WhatsApp/SMS/voice adapters, templates and recording rules; activation is optional and cannot bypass preference/consent.
- **Overseas recruitment:** enable a country/role pack only with appropriate credential/work-authorization/contract evidence and supported providers.
- **Delegation:** propose grants per action and scope; validate in shadow mode before live bounded execution. Business target is autonomy with exception handling, not all-actions-allowed.
- **Publication/deployment:** this plan changes no live system; implementation and release remain separate work.

## 13. Execution backlog policy
Each implementation work item must reference Mxx-Fxx package(s), FUxx/Jxx scenarios, owning command, affected audit finding, acceptance proof and dependency. Break a package into small reviewable increments when it spans multiple capabilities. Update the registry rather than inventing a second feature name.

Statuses: planned → contract_defined → implementing → tested_local → integrated → provider_validated (where needed) → production_verified. Also blocked, disabled_by_configuration and superseded, each with reason. “Code exists,” “UI exists,” “configured” and “production_verified” cannot be interchangeable.

The plan is complete against the current audited scope when all known audit findings and lifecycle responsibilities have owners, every follow-up type is cataloged, dependency/ownership conflicts are resolved and each enabled capability has an acceptance gate. Completion of implementation is measured separately through evidence, not a percentage.

## 14. Planning artifacts and consistency checks
- `freehr-module-registry.json`: machine-readable module ownership, build prerequisites, feature package IDs, baseline/status, follow-up catalog and audit traceability.
- `freehr-implementation-backlog.csv`: one row per feature package, its module acceptance gate, prerequisites, related audit findings and acceptance journeys. Package rows should be decomposed into reviewable implementation work before execution.
- Structural checks: 25 unique module IDs; 163 unique feature package IDs; 32 unique follow-up catalog IDs; 34 unique audited finding mappings; valid package/module references; acyclic build-prerequisite graph; one owner row per module.
- Semantic ownership decisions are stated in section 6. Structural checks do not prove future implementations cannot introduce duplicate logic; code review and canonical-command tests enforce that boundary.
