# FreelanceHR Platform Source of Truth (Canonical Architecture Record)

**Document Phase**: P0.1-D Master Platform Source of Truth Reconstruction  
**Verification Level**: Strict Repository-Audited Evidence (Zero Hallucination / Zero Speculation)  
**Last Verified Date**: 2026-09-28  
**Repository Authority Rule**: The actual codebase, schemas, configuration files, and test files supersede all external, historical, or aspirational documentation claims.

---

## 0. Document Governance

### 0.1 Purpose & Authority
This document serves as the sole canonical master architectural record and operational source of truth for the FreelanceHR (FreeHR Overseas) platform. It defines the formal specification of the platform across two strictly separated realities:
1. **Layer A — Product / Target Truth**: The complete product vision, target operating loops, planned engines, and intended business capabilities.
2. **Layer B — Implementation / Repository Truth**: The exact, verified state of the current codebase, schemas, database tables, API routes, queue handlers, security policies, and test suites.

Under no circumstances may a target capability be described as implemented, verified, or operational without concrete repository citations (file path, line numbers, function signatures, or schema declarations).

### 0.2 Status Vocabulary
Every engine, subsystem, capability, lifecycle stage, state transition, and AI feature is assigned an explicit status token from the controlled vocabulary below:

| Status Token | Formal Definition |
| :--- | :--- |
| **CURRENT-VERIFIED** | Code exists, is wired into the runtime execution graph, and its implementation matches specification. |
| **VERIFIED-TEST** | Verified by an automated test in the repository suite that passes cleanly in Vitest. |
| **PARTIAL** | Core code exists and executes, but boundary cases, secondary paths, or integrations are incomplete. |
| **INCOMPLETE** | Partially drafted or scaffolded in code, but missing essential business logic or persistence. |
| **MISSING** | Required by target architecture, but has zero code, schema, or route presence in the repository. |
| **UNWIRED** | Code, schema, or prompt exists, but is disconnected from the operational event loop or state persistence. |
| **BLOCKED** | Implementation cannot proceed due to an internal architectural conflict or failing invariant. |
| **BLOCKED-EXTERNAL** | Requires third-party credentials, DNS records, external APIs, or SaaS provisioning to function. |
| **UNVERIFIED** | Present in code, but cannot be proven operational without live external infrastructure or mocks. |
| **TARGET** | Intended product roadmap capability; explicitly NOT implemented in the current repository. |
| **PLANNED** | Scheduled for implementation in an upcoming sprint or migration phase. |
| **DEPRECATED** | Obsolete code or legacy pattern slated for removal; must not be extended. |
| **RESOLVED** | Previously identified defect or blocker that has been fully mitigated and verified by tests. |
| **ACTIVE-DEFECT** | Code contains a proven bug, security bypass, or data integrity flaw requiring immediate remediation. |
| **RELEASE-BLOCKER** | Critical defect or unwired core capability that prohibits production release until remediated. |

---

## 1. Product Identity & Vision

### 1.1 What FreelanceHR Is
FreelanceHR is an enterprise-grade **Recruitment Operating System (ROS)** designed to empower independent recruiters, recruitment agencies, and cross-border placement firms. It unifies:
- **Recruitment CRM**: End-to-end client prospecting, company verification (KYB), contact tracking, and commercial terms.
- **Applicant Tracking System (ATS)**: Multi-channel candidate ingestion, CV parsing, evidence matching, and interview pipelines.
- **Freelance Recruiter Workspace**: Secure multi-tenant workspace with role-based access control (RBAC) and non-delegable owner authorities.
- **Placement & Replacement Engine**: Offer tracking, joining verification, guarantee period monitoring, and replacement case routing.
- **Recruitment Finance**: Fee proposals, automated invoice generation, payment reconciliation, and dispute governance.
- **Compliance & Privacy Plane**: GDPR/DPDP statutory rights fulfillment, fail-closed physical document erasure, and audit-grade consent ledgers.
- **Autonomous HR Intelligence**: Policy-governed AI evaluation, candidate-job matching, and automated email threading.

### 1.2 What FreelanceHR Is Not
To maintain absolute architectural clarity, FreelanceHR is explicitly NOT:
- **Not merely a CRM**: It does not stop at lead tracking; it enforces hiring quality scores, calendar scheduling, and statutory consent.
- **Not merely an ATS**: It encompasses commercial fee proposals, invoice PDF generation, credit/dispute governance, and team access.
- **Not a Job Board**: It is not a passive listings aggregator; it is an active, agentic candidate sourcing and matching engine.
- **Not an Unsupervised AI Chatbot**: AI models have zero autonomous decision authority; they score and draft, but cannot decide.
- **Not a Public Social Network**: It is an authenticated, auditable B2B operating environment.

### 1.3 Strategic Product Vision
To build the most resilient, autonomous, and audit-proof operating infrastructure for domestic and overseas recruitment, enabling solo recruiters and agency teams to operate with the operational rigor, compliance posture, and delivery velocity of a Tier-1 recruitment enterprise.

---

## 2. Product Operating Model & Governance Separation

### 2.1 The 5-Layer Governance Model
The fundamental invariant of FreelanceHR is that **AI intelligence is strictly separated from business authority**. The platform architecture enforces a strict division across five operational layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        HUMAN OWNER (AUTHORITY)                         │
│   Mandatory approval for all consequential, financial, and legal actions│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Decisions / Approvals
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    POLICY ENGINE (GUARDRAILS & RULES)                  │
│   Workspace limits, quiet hours, emergency stop, eligibility criteria  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Allowed Execution
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   DOMAIN ENGINES (STATE TRANSITIONS)                   │
│   assertTransition(), DB state mutation, placement & invoice lifecycles │
└───────────────────▲────────────────────────────────┬───────────────────┘
                    │                                │
    Evidence Scoring│                                │ Structured Events
                    │                                ▼
┌───────────────────┴───────────────┐  ┌─────────────────────────────────┐
│     AI INTELLIGENCE (ANALYSIS)    │  │       AUDIT PLANE (EVIDENCE)    │
│ CV parsing, matching, drafting,   │  │ Immutable append-only audit log,│
│ reply classification (NO authority│  │ privacy logs, exception center  │
└───────────────────────────────────┘  └─────────────────────────────────┘
```

1. **AI Intelligence (`server/services/openrouter.ts`, `server/services/aiRouting.ts`)**:
   - Capabilities: Evidence extraction, semantic scoring, outreach drafting, inbound reply classification.
   - Boundaries: Strictly prohibited from autonomously rejecting candidates, altering invoice statuses, granting consent, executing payouts, or bypassing owner approvals (`openrouter.ts:51-58`, `workflow.ts:159-174`).
2. **Policy Engine (`server/services/policyEngine.ts`, `server/services/approvalEngine.ts`)**:
   - Enforces workspace constraints: daily outbound email budgets, quiet hours, emergency stop flags, and matching rules.
3. **Approval Engine (`server/services/approvalEngine.ts`, `server/routers/consequential.ts`)**:
   - Enforces mandatory human owner authorization for all irreversible or high-impact actions.
4. **Domain Engines (`server/workflow.ts`, `server/routers/*`)**:
   - The sole owners of business state. Enforce valid state machine transitions via `assertTransition()`.
5. **Audit Plane (`server/db.ts:recordAudit`, `incidents` table)**:
   - Records an immutable, append-only evidentiary trail for every state transition, authorization check, and delivery attempt.

---

## 3. Master Business Operating Loop

The platform is designed around a unified 13-stage autonomous recruitment loop:
```
DISCOVER → RESEARCH → QUALIFY → PRIORITIZE → CONTACT → CONVERSE → 
FOLLOW-UP → NURTURE → CONVERT → DELIVER → MEASURE → LEARN → NEXT ACTION
```

### 3.1 Entity-Specific Operating Loops & Repository Truth

| Entity Loop | Intended Target Operating Behavior | Current Repository Reality | Status | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **A. Clients** | Discover company → enrich domain → check hiring signal → KYB check → outreach → sign fee agreement → receive job. | Manual entry via `companies` table; KYB document upload verified; outreach via `outreachRouter`. | **PARTIAL** | `drizzle/schema.ts:73`, `server/routers/recruitment.ts:45` |
| **B. Recruiters** | Discover freelance recruiters → verify credentials → assign jobs → track sourcing → commission payout. | Handled only via `teamMembers` (roles: owner, recruiter, reviewer, viewer). No marketplace or payouts. | **PARTIAL** | `server/routers/team.ts`, `drizzle/schema.ts:641` |
| **C. Candidates** | Acquire CV → deduplicate by hash → parse skills → obtain consent → score match → interview → place. | Fully implemented: SHA-256 deduplication, AI CV parsing, consent gating, shortlist sharing, `.ics` calendar. | **CURRENT-VERIFIED** | `server/routers/recruitment.ts`, `server/services/queue.ts` |
| **D. Jobs** | Intake requirement → score quality (100-pt scorecard) → client confirmation → AI match → interview → fill. | Implemented: 100-point scorecard sum validation, client confirmation required before sourcing. | **CURRENT-VERIFIED** | `server/routers/recruitment.ts:180-260` |
| **E. Leads** | Ingest lead signals → scrape website → score hiring intent → cold outreach sequence → meeting booking. | Manual company creation with `hiringSignal` field; automated scraping and lead enrichment are absent. | **TARGET / MISSING** | `drizzle/schema.ts:88` |
| **F. Partners** | Cross-border recruitment agencies, employer of record (EOR), and visa processing partners. | No partner or agency tables exist in the schema. | **TARGET / MISSING** | Zero schema/code presence |
| **G. Marketing**| Keyword discovery → content generation → SEO blog publishing → social media distribution → inbound lead. | No marketing, social publishing, or SEO distribution code exists. | **TARGET / MISSING** | Zero schema/code presence |

---

## 4. Master Capability & Engine Registry

The platform architecture is decomposed into 14 distinct engine domains. Each is classified by current implementation state:

| Engine Domain | Subsystem / Capability | Current Status | Primary Code / Schema Sites | Operational Gaps |
| :--- | :--- | :--- | :--- | :--- |
| **1. Identity & Org** | Multi-tenant Workspace & RBAC | **CURRENT-VERIFIED** | `server/services/workspaceAccess.ts`, `server/routers/team.ts` | Production OIDC requires live identity provider. |
| **2. Client CRM** | Company, Contact & KYB Engine | **CURRENT-VERIFIED** | `drizzle/schema.ts:73,100`, `server/routers/recruitment.ts` | Automated web scraping/enrichment missing. |
| **3. Commercial** | Fee Proposals & Terms | **CURRENT-VERIFIED** | `drizzle/schema.ts:135`, `server/routers/outreach.ts:170` | Digital e-signature integration missing. |
| **4. Requirement** | Job Intake & Quality Scorecard | **CURRENT-VERIFIED** | `server/routers/recruitment.ts:180`, `jobs` table | Automated ATS sync/import missing. |
| **5. Candidate** | Ingestion, Deduplication, Parse | **CURRENT-VERIFIED** | `server/routers/recruitment.ts:270`, `server/services/queue.ts` | Public job application portal missing. |
| **6. Compliance** | GDPR/DPDP Consent & Deletion | **CURRENT-VERIFIED** | `server/routers/candidateWorkflows.ts:250`, `privateStorage.ts` | Heuristic scanner is not true antivirus. |
| **7. Matching** | Evidence-based Semantic Matching | **CURRENT-VERIFIED** | `server/services/queue.ts:178`, `matches` table | Feedback loop to retrain scoring is manual. |
| **8. Interview** | RFC 5545 Calendar & Reminders | **PARTIAL** | `server/services/calendar.ts`, `interviewReminders.ts` | Reminder side-effects unwired in queue (RB-05). |
| **9. Placement** | Placement & Guarantee Tracking | **CURRENT-VERIFIED** | `server/routers/recruitment.ts:650`, `placements` table | Background cron for guarantee expiration missing. |
| **10. Finance** | Invoicing, PDF & Stripe Links | **CURRENT-VERIFIED** | `server/services/invoicing.ts`, `invoices` table | Auto-reconciliation side-effect unwired (RB-05). |
| **11. Comm** | Hostinger Mail SDK & Threading | **CURRENT-VERIFIED** | `server/services/hostingerMail.ts`, `hostingerWebhook.ts` | Cold inbound mail cannot auto-thread (goes to exceptions). |
| **12. Queue** | Distributed Automation Queue | **PARTIAL** | `server/services/queue.ts`, `automationQueue` table | 2 of 6 job handlers unwired in queue (RB-05). |
| **13. Marketplace**| Freelance Recruiter Network | **TARGET / MISSING** | None (`teamMembers` role "recruiter" only) | Dedicated marketplace, ratings, payouts missing. |
| **14. Growth** | Content, SEO & Social Marketing| **TARGET / MISSING** | None | Social APIs, sitemaps, campaigns missing. |

---

## 5. Client Operating System

### 5.1 Intended Lifecycle
```
DISCOVERY → PROSPECT → LEAD → COMPANY → CONTACT → RESEARCH → QUALIFICATION → 
KYB / VERIFICATION → ENGAGEMENT → COMMERCIAL DISCUSSION → AGREEMENT → ONBOARDING → 
REQUIREMENT → JOB → CANDIDATE SUBMISSION → INTERVIEW → OFFER → PLACEMENT → 
INVOICE → PAYMENT → GUARANTEE → REPLACEMENT → RETENTION → EXPANSION → REACTIVATION
```

### 5.2 Implementation Reality & Code Trace
- **Company Ingestion**: `companies` table (`schema.ts:73`) supports fields: `name`, `domain`, `companyType` (`prospect` | `client`), `pipelineState`, `sector`, `sizeBand`, `location`, `hiringSignal`, `confidence`, `verificationState`.
- **Contact Ingestion**: `contacts` table (`schema.ts:100`) hashes email/phone with SHA-256 for privacy tracking (`emailHash`, `phoneHash`), enforcing uniqueness per owner.
- **Client KYB Verification**: `server/routers/recruitment.ts:prospects.uploadKybDocument` stores registration proofs, tax certificates, and PAN/GST documents in private storage.
- **Onboarding Approval**: Handled via `server/services/approvalEngine.ts:client_onboarding`. Updates `companyType = "client"` and `pipelineState = "converted"`.
- **Fee Proposals**: `feeProposals` table (`schema.ts:135`) records commercial terms (percentage fee, guarantee days, payment terms).

---

## 6. Recruiter Operating System

### 6.1 Intended Lifecycle
```
DISCOVER → VERIFY → PROFILE → QUALIFY → ENGAGE → ASSIGN → 
SOURCE → SUBMIT → COMMUNICATE → TRACK → PERFORMANCE → COMMISSION → PAYOUT → RETAIN
```

### 6.2 Implementation Reality & Code Trace
- **Team Workspace Roles**: Implemented in `server/routers/team.ts` and `server/services/workspaceAccess.ts`. Roles supported: `owner`, `recruiter`, `reviewer`, `viewer`.
- **Recruiter Invitations**: `teamInvitations` table (`schema.ts:659`) issues cryptographically secure invitation codes dispatched via Hostinger Mail. Accept page mounted at `/team/accept`.
- **Marketplace & Payout Reality**: **TARGET / MISSING**. The current repository does NOT contain a public recruiter marketplace, commission calculation ledger, recruiter rating engine, or automated payout gateway. Recruiter activity is managed as internal workspace team members.

---

## 7. Candidate Operating System

### 7.1 Intended Lifecycle
```
ACQUIRE → IDENTIFY → DEDUPLICATE → PROFILE → DOCUMENT → SCAN → 
PARSE → ENRICH → CONSENT → COMPLIANCE → SUPPRESS/DNC CHECK → MATCH → 
SCREEN → SHORTLIST → SHARE → INTERVIEW → FEEDBACK → OFFER → ACCEPT → 
JOIN → PLACEMENT → GUARANTEE → REPLACEMENT → CLOSE → RETAIN / NURTURE
```

### 7.2 Implementation Reality & Code Trace
- **Identification & Deduplication**: `candidates` table (`schema.ts:182`) requires `primaryEmailHash` and `primaryPhoneHash`. Collisions are rejected to prevent duplicate candidate profiles.
- **Document Storage**: `candidateDocuments` (`schema.ts:221`) stores CVs and certifications in private storage (`local`, `s3`, or `managed`).
- **CV Parsing**: `server/services/queue.ts:handleAiTaskResult` (`parse_cv`) extracts skills, experience years, education, and headline, updating `candidateDocuments.parseState = "parsed"`.
- **Consent Gating**: `consents` table (`schema.ts:251`) records explicit, versioned candidate consent (`platform_processing`, `client_sharing`, etc.).
- **Suppression & DNC**: `suppressionList` (`schema.ts:581`) enforces opt-out. Any candidate marked DNC or withdrawing consent cascades suppression.
- **Privacy Erasure (Fail-Closed)**: `candidateWorkflows.ts:250-295` mandates that physical document deletion from disk/S3 MUST succeed before database records are redacted. If storage fails, the deletion aborts, transitions to `investigation`, and logs an audit failure (`privacy.erasure_failed`).

---

## 8. Job / Requirement Operating System

### 8.1 Intended Lifecycle
```
JOB INTAKE → NORMALIZATION → QUALITY CHECK → VALIDATION → 
CLIENT CONFIRMATION → APPROVAL → SOURCING → PIPELINE → 
SHORTLIST → INTERVIEW → OFFER → PLACEMENT → CLOSE
```

### 8.2 Implementation Reality & Code Trace
- **Job Creation & Scorecard**: `server/routers/recruitment.ts:jobs.create` validates mandatory fields: `title`, `companyId`, `location`, `workplaceType`, `currency`, `salaryMin`, `salaryMax`, and `scorecardWeights`.
- **Quality Rule**: Enforces that scorecard criteria weights MUST sum exactly to 100 (`jobs.ts`).
- **Client Confirmation Gate**: Transitioning a job from `draft` to `approved` strictly requires `clientConfirmedBy` (valid email) in `jobs.transition`.

---

## 9. Recruitment, Placement & Replacement Engine

### 9.1 Intended Lifecycle
```
OFFER EXTENDED → OFFER ACCEPTED → JOINING CONFIRMED → 
PLACEMENT CONFIRMED → INVOICE ISSUED → GUARANTEE PERIOD ACTIVE → 
(REPLACEMENT TRIGGERED → REPLACEMENT SOURCING → REPLACEMENT CLOSED) OR (GUARANTEE EXPIRED)
```

### 9.2 Implementation Reality & Code Trace
- **Placement Creation**: `placements` table (`schema.ts:401`) records candidate, job, company, offer amount, fee percentage, joining date, guarantee start/end dates, and state.
- **Consequential Placement Confirmation**: `placementsRouter.confirm` submits an approval request. Applying the side effect updates placement state to `joining_confirmed` and `invoice_eligible`.
- **Replacement Governance**: `consequentialRouter.requestReplacement` creates an approval request for `replacement_case`. Deciding the approval updates placement state to `replacement_requested`.

---

## 10. Finance Operating System

### 10.1 Intended Architecture
- **Invoicing**: Commercial fee calculation, tax breakdown, PDF rendering, payment links.
- **Payment Lifecycle**: Bank transfer reconciliation, Stripe checkout, overdue tracking.
- **Dispute & Credit Governance**: Consequential approval required for credits, write-offs, or disputes.
- **AI Boundaries**: AI is strictly advisory. AI CANNOT alter invoice truth or issue write-offs.

### 10.2 Implementation Reality & Code Trace
- **Invoice Generation**: `invoices` table (`schema.ts:438`) and `server/services/invoicing.ts`. Generates complete HTML/PDF-ready invoice documents with tax calculation (`invoicing.ts:54-150`).
- **Payment Link Generation**: Supports provider integration stubs (`invoicing.ts:createInvoicePaymentLink`).
- **Payment Recording**: `payments` table (`schema.ts:474`) logs provider event IDs and timestamps.
- **Consequential Actions**: `invoice_payment_status`, `invoice_dispute`, and `invoice_credit` require consequential approval.
- **Queue Gap (RB-05)**: `reconcile_invoice` has prompt and schema in `openrouter.ts`, but its result handler is **UNWIRED** in `server/services/queue.ts`.

---

## 11. Compliance, Privacy & Risk Engine

### 11.1 Statutory Rights & Erasure Workflow
- Implements GDPR Article 17 and India DPDP Act right to erasure.
- Handled in `server/routers/candidateWorkflows.ts:privacy.fulfillDeletion`.
- **Atomic Fail-Closed Guarantee**:
  1. Identifies all documents in `candidateDocuments`.
  2. Executes physical deletion via `deletePrivateDocument(doc.storageKey)`.
  3. If storage returns non-true or throws: deletion aborts, status becomes `investigation`, and `TRPCError(INTERNAL_SERVER_ERROR)` is thrown.
  4. Only after all physical files are confirmed erased are database records redacted and `candidates.profileState` set to `deleted`.

### 11.2 Document Security Scanner Reality
- Located in `server/services/documentScanner.ts`.
- **Architecture Reality**: Uses static byte heuristics, NOT an active antivirus daemon (e.g. ClamAV).
- Evaluates:
  1. Size bounds (0 bytes flagged, > 5MB rejected).
  2. SHA-256 integrity against upload claims.
  3. EICAR malware test string signature.
  4. Executable magic headers (`MZ`, `ELF`, `Mach-O`, `#!`).
  5. Format magic signatures (`%PDF-`, `PK\x03\x04`).
  6. Suspicious strings (`<script`, `/JavaScript`, `vbaProject.bin`).

---

## 12. Communication & Email Subsystem

### 12.1 Outbound Email Dispatch
- Located in `server/services/hostingerMail.ts`.
- Uses official `hostinger-mail-api-sdk` (`package.json:73`).
- **Suppression Check**: Pre-flight SHA-256 hash lookup against `suppressionList` table. Throws `TRPCError(PRECONDITION_FAILED)` if recipient is suppressed.
- **Approval Gate**: Cold recruitment outreach requires approval before `deliverApproved` can dispatch.

### 12.2 Inbound Email Webhook & Threading Reality
- Located in `server/services/hostingerWebhook.ts` and `server/routers/email.ts`.
- **Authentication**: `isValidHostingerWebhookAuthorization` validates `HOSTINGER_MAIL_WEBHOOK_SECRET` with `timingSafeEqual`.
- **Threading Matching**: `chooseThreadReference` searches `In-Reply-To` and `References` headers against `messages.providerMessageId`.
- **Cold Inbound Limitation**: If an incoming email does not contain a recognized thread reference to an existing message, it CANNOT create a new conversation thread. It logs an audit event (`email.webhook_unmatched`), creates an incident in `incidents`, and returns 202 (`routed_to_exception`).

---

## 13. Follow-up, Reminder & Nurture Engine

### 13.1 Intended Lifecycle
```
CONTACT → RESPONSE → CLASSIFY → NEXT ACTION → FOLLOW-UP DATE → 
REMINDER → FOLLOW-UP → RESPONSE → NURTURE → CONVERT / CLOSED
```

### 13.2 Implementation Reality & Code Trace
- **Interview Reminders**: `server/services/interviewReminders.ts` queries confirmed interviews due for reminders (`reminderAt <= now`), marks `reminderSentAt`, and inserts a `send_reminder` job into `automationQueue`.
- **Queue Gap (RB-05)**: In `server/services/queue.ts`, `handleAiTaskResult` has **NO HANDLER** for `send_reminder`. The AI draft generated by OpenRouter is stored in `automationQueue.result` and abandoned. No notification is sent.
- **Client & Candidate Nurture**: **TARGET / MISSING**. Long-term automated drip campaigns and stale lead nurture workflows are not implemented in code.

---

## 14. Business Development Engine

### 14.1 Intended Capabilities
- Automated scraping of job boards and company career pages for hiring intent.
- AI enrichment of company headcount, funding, and key decision-maker emails.
- Multi-step outbound email sequences with automated reply sentiment tracking.

### 14.2 Current Repository Reality
- Manual company and contact entry via `prospectsRouter`.
- AI outreach drafting (`outreachRouter.draftSequence`) and AI reply classification (`classify_reply` job).
- **GAP**: Zero automated discovery, zero third-party web scraping, zero LinkedIn/Apollo API integrations. Status: **TARGET / MANUAL**.

---

## 15. Growth, Self-Marketing, SEO & Social Subsystem

### 15.1 Target Capability Model
```
MARKET RESEARCH → TOPIC DISCOVERY → CONTENT STRATEGY → 
CONTENT CREATION → SEO → SOCIAL PUBLISHING → SOCIAL ENGAGEMENT → 
LEAD CAPTURE → CRM → CONVERSION → ANALYTICS
```

### 15.2 Current Repository Reality
- **Status**: **TARGET / MISSING / BLOCKED-EXTERNAL**.
- **Audited Truth**: The repository contains NO social media OAuth flows (LinkedIn, Twitter/X), NO social post schedulers, NO automated blog/CMS publishers, and NO dynamic SEO sitemap generators.
- The marketing engine is entirely an architectural roadmap capability.

---

## 16. AI Architecture & AI Engine Registry

### 16.1 Architecture & Safety Rails
- **Gateway**: `server/services/aiRouting.ts` with built-in model preference (`manus-1.6-lite`) and failover to `server/services/openrouter.ts`.
- **Content Safety**: `server/workflow.ts:ensureSafeAiText` rejects inputs containing protected recruitment traits (`caste`, `religion`, `marital status`, `pregnant`, `disability`, `age preference`, `facial emotion`, `personality score`, `accent score`).
- **Input Cap**: `MAX_AI_INPUT_CHARS = 12_000` enforced on all payloads.

### 16.2 Master AI Capability Registry

| # | AI Capability | Target Purpose | Primary Model / System Prompt | Current Status | Code Site & Evidence | Operational Defect / Gap |
| :- | :--- | :--- | :--- | :--- | :--- | :--- |
| **01** | **CV Parsing** | Extract skills, roles, education, experience | `openrouter.ts:parse_cv` | **CURRENT-VERIFIED** | `queue.ts:22-73` | Fully updates `candidateDocuments` and `candidates.headline`. |
| **02** | **Outreach Drafting** | Generate personalized outreach with opt-out | `openrouter.ts:draft_outreach` | **CURRENT-VERIFIED** | `queue.ts:74-103` | Sets `messages.status = "draft_ready"`; requires human approval. |
| **03** | **Reply Classification**| Detect interest, meeting request, or opt-out | `openrouter.ts:classify_reply` | **CURRENT-VERIFIED** | `queue.ts:104-177` | Automatically sets `opted_out` and cascades to `suppressionList`. |
| **04** | **Evidence Matching** | Score candidate evidence against job criteria | `openrouter.ts:score_match` | **CURRENT-VERIFIED** | `queue.ts:178-239` | Inserts/updates `matches` table with ruleScore and semanticScore. |
| **05** | **Interview Reminder** | Draft polite reminder notification | `openrouter.ts:send_reminder` | **UNWIRED** | `queue.ts:240` | **RB-05**: Prompt/schema exists; handler missing in `queue.ts`. |
| **06** | **Invoice Reconciliation**| Reconcile payment discrepancies | `openrouter.ts:reconcile_invoice` | **UNWIRED** | `queue.ts:240` | **RB-05**: Prompt/schema exists; handler missing in `queue.ts`. |
| **07** | **Job Description Gen** | Generate standardized job requirement | Target Architecture | **TARGET** | None | Not implemented in current routers. |
| **08** | **Screening Scorecard** | Recommend screening scorecard weights | Target Architecture | **TARGET** | None | Manual scorecard creation only. |
| **09** | **Market Intelligence** | Salary benchmarking & demand index | Target Architecture | **TARGET** | None | No market intelligence engine in code. |
| **10** | **Lead Enrichment** | Infer company hiring signals from domain | Target Architecture | **TARGET** | None | `hiringSignal` is manual text. |
| **11** | **Follow-up Timing** | Optimize nurture reminder send times | Target Architecture | **TARGET** | None | Uses static 24h offset in `interviewReminders.ts`. |
| **12** | **Recruiter Matching** | Match freelance recruiters to open jobs | Target Architecture | **TARGET** | None | No recruiter marketplace engine. |
| **13** | **Dispute Risk Scoring**| Predict client payment dispute risk | Target Architecture | **TARGET** | None | No risk scoring algorithm in code. |
| **14** | **SEO Content Engine** | Generate recruitment blog articles | Target Architecture | **TARGET** | None | Zero marketing code presence. |
| **15** | **Social Post Drafter**| Create LinkedIn / X recruitment snippets | Target Architecture | **TARGET** | None | Zero social integration code. |
| **16** | **Visa Feasibility** | Check cross-border immigration eligibility | Target Architecture | **TARGET** | None | Zero international visa code. |

---

## 17. Automation Architecture & Queue Engine

### 17.1 Queue Mechanics (`server/services/queue.ts`)
- Backed by MySQL `automationQueue` table (`schema.ts:494`).
- **State Machine**: `queued` → `running` → `completed` | `retryable_failed` | `permanently_failed` | `blocked`.
- **Concurrency & Rate Controls**:
  - `workspaceSettings.emergencyStop`: If `true`, queue execution immediately halts (`queue.ts:245`).
  - `workspaceSettings.dailyOutboundLimit`: Enforces maximum messages per 24 hours.
  - Quiet hours check: Suppresses message dispatches between configured hours (`quietHoursStart` to `quietHoursEnd`).
- **Scheduled Endpoints (`server/hostinger.ts`)**:
  - `POST /api/scheduled/automation-queue`: Scans due jobs and processes them with retry backoff.
  - `POST /api/scheduled/interview-reminders`: Scans upcoming interviews and enqueues reminder jobs.
  - Strictly requires `CRON_SECRET` with timing-safe header verification (`timingSafeEqual`).

---

## 18. Workflow & State Machines

All business state transitions are governed by `server/workflow.ts:assertTransition()`.

### 18.1 Master State Machine Specifications

```
COMPANY:
  new ──────────► researched ─────► qualified ─────► contacted ─────► replied ─────► discovery ─────► proposal_pending ─────► converted ─────► active ◄────► suspended
   │                  │               │                │               │               │                      │                                 │
   ▼                  ▼               ▼                ▼               ▼               ▼                      ▼                                 ▼
[not_fit / suppressed]───────────────────────────────────────────────────────────────────────────────────────────────────────────────────► [closed]

JOB:
  draft ◄────────► needs_information ──────► client_confirmation ──────► approved ──────► sourcing ◄────► paused
    │                       │                       │                     │                │                │
    ▼                       ▼                       ▼                     ▼                ▼                │
[cancelled] ◄───────────────┴───────────────────────┴─────────────────────┴──────────► shortlist_ready     │
    │                                                                                      │                │
    ▼                                                                                      ▼                │
[archived] ◄──────────────────────────────── filled ◄─────── offer_stage ◄──────── interviewing ◄──────────┘

CANDIDATE:
  imported ──────► consent_pending ──────► consented ──────► available ──────► outreach_queued ──────► interested ──────► screening ──────► qualified ──────► shortlisted ──────► submitted ──────► interview ──────► offer ──────► joined
     │                    │                   │                  │                   │                    │                   │                  │                  │                  │               │             │         │
     ▼                    ▼                   ▼                  ▼                   ▼                    ▼                   ▼                  ▼                  ▼                  ▼               ▼             ▼         ▼
[do_not_contact / withdrawn / deletion_pending]─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────► [deleted]

PLACEMENT:
  offer_pending ──► offer_issued ──► offer_accepted ──► joining_pending ──► joining_confirmed ──► invoice_eligible ──► guarantee_active ──► guarantee_ended ──► closed
        │                │                 │                   │                                                              │
        ▼                ▼                 ▼                   ▼                                                              ▼
     [closed] ◄──────────┴─────────────────┴───────────────────┴──────────────────────────────────────────────────────► replacement_requested ──► replacement_in_progress ──► replacement_closed ──► closed

INVOICE:
  draft ◄────────► validation ──────► approval_pending ──────► issued ──────► delivered ──────► payment_pending ◄────► partially_paid ──────► paid ──────► closed
    │                  │                     │                   │               │                    │                                         │
    ▼                  ▼                     ▼                   ▼               ▼                    ▼                                         ▼
[cancelled] ◄──────────┴─────────────────────┴───────────────────┴──────────► overdue ──────────► disputed ───────────────────────────────► credited / written_off ──► closed
```

---

## 19. Database Ownership Model

The database schema (`drizzle/schema.ts`) declares 31 MySQL tables organized across 9 core ownership domains:

| Domain | Primary Tables | Ownership & Mutation Authority | Immutable / Audit Records |
| :--- | :--- | :--- | :--- |
| **Workspace & Auth** | `users`, `workspaceSettings`, `teamMembers`, `teamInvitations` | Workspace owner controls roles; system updates `lastSignedIn`. | User creation audit; team invitation revocations. |
| **Policy & Approval**| `policyVersions`, `approvals` | Owner activates policies; approval decisions mutate state. | Policy version history; decision timestamps & notes. |
| **Client & CRM** | `companies`, `contacts`, `feeProposals` | CRM procedures; verification requires KYB document evidence. | Company state transitions; verification audit. |
| **Requirements** | `jobs` | Job creator/recruiter; requires client confirmation email. | Quality scorecard sum validation logs. |
| **Candidate Plane** | `candidates`, `candidateDocuments`, `screenings`, `matches`, `shortlists` | Candidate procedures; CV parser writes `parsedData`. | SHA-256 deduplication hashes; matching evidence. |
| **Interviews** | `interviews`, `feedback` | Recruiter/scheduler; generates RFC 5545 `.ics` feeds. | Interview rescheduling logs; feedback records. |
| **Placements** | `placements` | Consequential router; owner approval required for confirm/replace. | Guarantee period timestamps; replacement triggers. |
| **Finance** | `invoices`, `payments` | Invoicing engine; owner approval required for issue/credit/dispute. | Payment provider event IDs; credit notes. |
| **Governance & Comm**| `conversations`, `messages`, `suppressionList`, `consents`, `rightsRequests`, `incidents`, `auditEvents`, `automationQueue` | Communication engine; fail-closed erasure; append-only audit. | `auditEvents` (strictly append-only); statutory erasure logs. |

---

## 20. API & Router Ownership

The tRPC API graph is defined in `server/routers.ts` and modularized across subrouters:

```
appRouter
├── auth (me, logout)
├── system (system health, runtime ping)
├── recruitment
│   ├── prospects (list, create, transition, uploadKyb, requestOnboarding)
│   ├── jobs (list, create, transition, qualityScore)
│   ├── candidates (list, search, create, transition, grantConsent, withdraw, doNotContact, requestRights)
│   │   └── documents (list, access, scan, upload)
│   ├── candidateWorkflows
│   │   ├── screenings (list, create, updateState)
│   │   ├── shortlists (list, updateNote)
│   │   └── privacy (fulfillDeletion [fail-closed])
│   ├── matching (listForJob, createEvidenceMatch, requestShareApproval)
│   ├── interviews (list, create, exportIcs, setReminder, reschedule, cancel)
│   ├── feedback (submit, listForInterview)
│   ├── consequential (decide, requestCandidateDecision, requestReplacement, requestInvoiceAction)
│   ├── placements (list, create, transition, confirm)
│   ├── invoices (list, create, transition, requestIssue, generateDocument, createPaymentLink, recordPayment)
│   ├── outreach (draftSequence, classifyInboundReply)
│   ├── agreements (proposeFee, acceptFee)
│   └── approvals (list, decide)
├── operations
│   ├── dashboard (KPI aggregations)
│   ├── settings (get, readiness, update, setEmergencyStop)
│   ├── policies (list, create, activate)
│   ├── queue (list, enqueue, retry, cancel, runNext, enableSchedule)
│   ├── exceptions (list, createIncident, updateIncidentState)
│   └── audits (list)
├── email
│   ├── status (Hostinger Mail API status)
│   ├── identities (list, save, setStatus, verify)
│   ├── outbound (approvalDetail, requestApproval, deliverApproved)
│   └── inbound (status, verify, record, recordByThread, messages, conversations)
└── team
    ├── permissions (role matrix)
    ├── overview (members & invitations)
    ├── invite (send email invite)
    ├── updateRole (assign role)
    ├── revoke (revoke member/invite)
    ├── accept (claim invitation)
    ├── myAccess (caller permissions)
    └── activity (audit trail)
```

---

## 21. Security, Authentication & Authorization

### 21.1 Dual Runtime Architecture
- **Development**: Runs `server.ts` on Express with Vite development middleware.
- **Production**: Compiles to `dist/hostinger.js` running **Fastify 5** (`package.json:71`) with `@fastify/static` serving the compiled SPA (`dist/public`).

### 21.2 Production Authentication Protocol
- **OIDC Discovery & PKCE**: `server/services/runtimeAuth.ts` initiates authorization code flow with PKCE (`S256`).
- **Session Security**: Session token is an encrypted JWT stored in `__Host-fh_session` cookie (`HttpOnly; Secure; SameSite=Lax`).
- **Cron Security**: Scheduled routes (`/api/scheduled/*`) strictly require `CRON_SECRET` verified via `timingSafeEqual`. Zero fallback to OAuth in production.
- **Webhook Security**: Hostinger inbound webhooks require `HOSTINGER_MAIL_WEBHOOK_SECRET` verified via `timingSafeEqual`.
- **Storage Security**: Document downloads enforce workspace ownership verification before piping bytes (`scripts/verify-hostinger.ts`).

### 21.3 Primary Owner & Dev Fallback Security Audit
- `server/services/primaryOwner.ts` checks:
  1. `PRIMARY_OWNER_OPEN_ID`
  2. `OWNER_OPEN_ID`
  3. `PRIMARY_OWNER_EMAIL`
- **Known Risk Fact**: In non-test environments when neither variable is set, code falls back to `mohd.aziz.sk@gmail.com` or `owner_dev`. Production deployments must explicitly provide `PRIMARY_OWNER_EMAIL` to prevent fallback.

---

## 22. Audit & Observability Engine

### 22.1 Append-Only Audit Trail
- Powered by `server/db.ts:recordAudit` writing to `auditEvents` table (`schema.ts:553`).
- Tracks: `ownerId`, `actorType` (`user`, `system`, `ai`, `provider`), `actorId`, `action`, `resourceType`, `resourceId`, `previousState`, `nextState`, `metadata`, `ipAddress`, `userAgent`.
- Audit rows are strictly immutable (no update or delete procedures exist).

### 22.2 Exception Center & Incident Management
- Powered by `incidents` table (`schema.ts:615`).
- Any unhandled delivery failure, unmatched inbound email, or malformed webhook payload is automatically trapped into an incident (`operationsRouter.exceptions`).

---

## 23. Canonical E2E Business Scenarios

| Scenario # | Canonical Business Scenario | Target Operational Flow | Current Code State | Current Status |
| :- | :--- | :--- | :--- | :--- |
| **01** | **New Client Acquisition to Invoice** | Prospect → KYB → Agreement → Job → Match → Place → Invoice | Fully wired via recruitment, consequential, and invoicing routers. | **CURRENT-VERIFIED** |
| **02** | **Existing Client New Job Requisition**| Company → Job (scorecard=100) → Client Confirmation → Pipeline | Enforced scorecard sum and mandatory client confirmation email. | **CURRENT-VERIFIED** |
| **03** | **Candidate Ingestion to Placement** | CV upload → Dedup → Scan → Parse → Consent → Match → Place | Verified deduplication, parsing, consent gating, and placement. | **CURRENT-VERIFIED** |
| **04** | **Recruiter Team Member Onboarding** | Owner invites → Email sent → Recruiter accepts at `/team/accept` | Dispatches email via Hostinger Mail; role enforced via RBAC. | **CURRENT-VERIFIED** |
| **05** | **Consent Withdrawal & DNC Cascade** | Candidate withdraws consent → Instant suppression list insertion | Pre-flight suppression check blocks outbound communications. | **CURRENT-VERIFIED** |
| **06** | **GDPR Right to Erasure (Fail-Closed)**| Deletion requested → Physical files deleted → DB redacted | Atomic fail-closed: fails if disk/S3 deletion fails; audits failure. | **VERIFIED-TEST** |
| **07** | **Interview Calendar Scheduling** | Interview created → RFC 5545 `.ics` generated → Feed subscribed | Calendar export verified; provider-free iCalendar format. | **CURRENT-VERIFIED** |
| **08** | **Interview Reminder Dispatch** | Cron triggers → Due interviews scanned → Reminder queued → Sent | **DEFECT (RB-05)**: Job queued, but result handler unwired in queue. | **PARTIAL / UNWIRED** |
| **09** | **Candidate Profile Sharing Approval** | Recruiter requests share → Owner approves → Shortlist marked shared | Implemented; can be auto-approved if policy rule configured. | **PARTIAL** |
| **10** | **Placement Confirmation & Guarantee** | Candidate joins → Owner approves placement → Guarantee starts | Consequential approval triggers `invoice_eligible` state. | **CURRENT-VERIFIED** |
| **11** | **Replacement Guarantee Activation** | Candidate leaves → Replacement case opened → Sourcing restarts | Consequential approval updates placement to `replacement_requested`. | **CURRENT-VERIFIED** |
| **12** | **Invoice Generation & Stripe Link** | Placement confirms → Invoice drafted → HTML rendered → Pay link | Verified invoice document generator and payment link stubs. | **CURRENT-VERIFIED** |
| **13** | **Invoice Auto-Reconciliation** | Bank event received → AI reconciles payment → Status updated | **DEFECT (RB-05)**: AI task schema exists; handler unwired in queue. | **UNWIRED** |
| **14** | **Invoice Dispute / Credit Governance**| Client disputes invoice → Consequential approval → Status credit | Managed via `consequentialRouter.requestInvoiceAction`. | **CURRENT-VERIFIED** |
| **15** | **Inbound Email Thread Matching** | Inbound webhook → Message headers matched to thread → Stored | Matches via `In-Reply-To`/`References`. Unmatched goes to incidents. | **CURRENT-VERIFIED** |
| **16** | **Inbound Email Opt-out Detection** | Candidate replies "STOP" → AI/regex detects → Suppressed | Automatically inserts into `suppressionList` and halts contact. | **CURRENT-VERIFIED** |
| **17** | **Cold Inbound Ingestion** | Unsolicited email arrives at mailbox → New lead created | **GAP**: Unmatched inbound emails cannot create leads; routed to exception. | **PARTIAL** |
| **18** | **AI CV Parsing Pipeline** | PDF uploaded → Text extracted → OpenRouter parses JSON → Saved | Full pipeline verified from storage to `candidateDocuments`. | **CURRENT-VERIFIED** |
| **19** | **AI Candidate-Job Match Scoring** | Job + Candidate → Semantic comparison → Evidence scored | Populates `matches` table with matched and missing evidence. | **CURRENT-VERIFIED** |
| **20** | **AI Cold Outreach Drafting** | Candidate profile → AI drafts email with opt-out clause | Stored as `draft_ready`; requires human delivery approval. | **CURRENT-VERIFIED** |
| **21** | **Automation Queue Execution** | Scheduler POSTs with `CRON_SECRET` → Queue processes next job | Verified timingSafeEqual cron authentication and retry backoff. | **CURRENT-VERIFIED** |
| **22** | **Workspace Emergency Stop** | Owner toggles emergency stop → Queue skips execution | Verified: `processOneQueuedJob` immediately halts when enabled. | **CURRENT-VERIFIED** |
| **23** | **Production Startup & DB Ping** | Fastify boots → `verifyDatabaseConnectivity()` executes `SELECT 1` | Verified: server aborts with exit code 1 if MySQL is unreachable. | **VERIFIED-TEST** |
| **24** | **Hostinger Deploy & Build Asset** | `pnpm build` bundles Vite SPA + Fastify server into `dist/` | Verified: `build-hostinger.mjs` outputs static files and server. | **CURRENT-VERIFIED** |
| **25** | **Recruiter Marketplace Assignment** | Open job broadcast to freelance recruiter network → Claimed | Target Architecture: No marketplace or commission ledger in code. | **TARGET / MISSING** |
| **26** | **International Visa Verification** | Candidate matched to overseas job → Visa rules evaluated | Target Architecture: No overseas visa/work permit rules in code. | **TARGET / MISSING** |
| **27** | **Social Media Job Auto-Publishing** | Approved job published to LinkedIn/Twitter with tracking link | Target Architecture: No social media integrations in code. | **TARGET / MISSING** |
| **28** | **Automated Stale Lead Nurture** | Inactive prospect triggered by drip sequence after 30 days | Target Architecture: Drip campaign engine not implemented. | **TARGET / MISSING** |

---

## 24. Production Readiness & Infrastructure

### 24.1 Verification Breakdown

| Subsystem | Readiness Category | Verification Method | Status | Notes / Prerequisites |
| :--- | :--- | :--- | :--- | :--- |
| **Node.js Runtime** | CODE-VERIFIED | `package.json` engines | **CURRENT-VERIFIED** | `node: ">=20.19.0"` |
| **Package Manager** | CODE-VERIFIED | `package.json` packageManager | **CURRENT-VERIFIED** | `pnpm@11.0.0` (canonical lockfile synchronized) |
| **Production Build** | CODE-VERIFIED | `scripts/build-hostinger.mjs` | **CURRENT-VERIFIED** | `pnpm build` bundles Fastify backend + Vite SPA |
| **Production Starter**| CODE-VERIFIED | `package.json` start script | **CURRENT-VERIFIED** | `node dist/hostinger.js` |
| **DB Startup Ping** | TEST-VERIFIED | `server/p02b.test.ts` | **VERIFIED-TEST** | Eager `SELECT 1` ping before port bind; fails closed |
| **Storage Security** | TEST-VERIFIED | `scripts/verify-hostinger.ts` | **VERIFIED-TEST** | 401 unauth, 404 cross-owner isolation, 10MB limit |
| **Cron Auth Guard** | TEST-VERIFIED | `server/hostinger.test.ts` | **VERIFIED-TEST** | `timingSafeEqual` with `CRON_SECRET`; no OAuth fallback |
| **Privacy Erasure** | TEST-VERIFIED | `server/routers/candidateDeletion.test.ts` | **VERIFIED-TEST** | Fail-closed: storage deletion failure halts erasure |
| **Hostinger Mail API**| EXTERNAL-DEPENDENCY | Hostinger Mail API SDK | **UNVERIFIED** | Requires active Hostinger Mail plan & API token |
| **Inbound Webhook** | EXTERNAL-DEPENDENCY | Fastify HTTP route | **UNVERIFIED** | Requires Hostinger mail server webhook configuration |
| **OpenRouter AI** | EXTERNAL-DEPENDENCY | `OPENROUTER_API_KEY` | **UNVERIFIED** | Requires valid API key and model account balance |
| **OIDC Provider** | EXTERNAL-DEPENDENCY | `OIDC_ISSUER_URL` | **UNVERIFIED** | Requires live production Identity Provider |
| **DNS / SSL / DMARC** | EXTERNAL-DEPENDENCY | Cloudflare / Hostinger DNS | **UNVERIFIED** | Requires DKIM, SPF, and DMARC DNS records |

---

## 25. Release Blocker Register

### 25.1 Active Release Blockers (Rebuilt from Code Audit)

| Blocker ID | Severity | Category | Description & Verified Code Fact | Code Site | Required Resolution | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **RB-05** | **P1** | **AI / Queue** | **Unwired Automation Queue Side Effects**: In `server/services/queue.ts`, `handleAiTaskResult` implements result handlers for `parse_cv`, `draft_outreach`, `classify_reply`, and `score_match`, but contains NO handler for `send_reminder` or `reconcile_invoice`. Completed task results remain trapped in `automationQueue.result` without updating domain records. | `server/services/queue.ts:13-240` | Implement side-effect handlers in `queue.ts` for `send_reminder` (updating interview reminder dispatch state) and `reconcile_invoice` (updating invoice ledger status). | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-07** | **P1** | **Approval / Safety** | **Consequential Actions Can Bypass Mandatory Human Approval**: `server/services/approvalEngine.ts:15-21` defines only 5 actions in `consequentialActionTypes`. Furthermore, `requestOrAutoDecide` and `findMatchingRule` do NOT prevent consequential actions from matching `autoApprovalRules`. Any action can be policy-auto-approved if a matching rule is configured. | `server/services/approvalEngine.ts:240-340`, `server/services/policyEngine.ts:120-173` | Enforce in code that consequential actions (`consequentialActionTypes`) MUST NEVER match policy auto-approval rules and strictly require human owner decision. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |

### 25.2 Resolved Release Blockers (Historical Audit Record)

| Blocker ID | Severity | Category | Resolution Summary | Resolved In | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **RB-01** | **P0** | **Runtime / Build** | Updated `package.json` to canonical `"start": "node dist/hostinger.js"` and `"build": "node scripts/build-hostinger.mjs"`. | P0.2-A | **RESOLVED** |
| **RB-02** | **P0** | **Privacy / Safety** | Made document erasure fail-closed in `server/routers/candidateWorkflows.ts` and `server/services/privateStorage.ts`: storage deletion verified before redaction; failures record audit and transition to `investigation`. | P0.2-B | **RESOLVED** |
| **RB-03** | **P0** | **Database / Safety** | Added synchronous `SELECT 1` ping (`verifyDatabaseConnectivity`) in `server/db.ts` called on production startup by Fastify before binding. | P0.2-B | **RESOLVED** |
| **RB-04** | **P1** | **Automation / Cron** | Enforced `CRON_SECRET` in `server/services/runtimeAuth.ts:configIssues` and removed dev OAuth fallback in `server/hostinger.ts` production routes with `timingSafeEqual`. | P0.2-B | **RESOLVED** |
| **RB-06** | **P1** | **Tooling / Config** | Declared `packageManager` and `engines` in `package.json`, removed `bun.lock`, and added `drizzle-kit` to `devDependencies`. | P0.2-A | **RESOLVED** |

---

## 26. Comprehensive Current vs Target Matrix

| Architectural Domain | Target Capability (Layer A) | Current Implementation (Layer B) | Status | Gap Analysis & Operational Impact |
| :--- | :--- | :--- | :--- | :--- |
| **1. Identity & Auth** | Enterprise SSO, multi-factor auth, OIDC, RBAC | OIDC discovery with PKCE, session cookie JWT, workspace RBAC | **CURRENT-VERIFIED** | Requires live production IdP configuration in `.env`. |
| **2. Client CRM** | Auto-enrichment from web, automated KYB lookup | Manual company creation, document upload for KYB | **PARTIAL** | Automated company web scraping is missing. |
| **3. Fee Proposals** | E-signature contract execution, dynamic fee terms | Database proposal creation, acceptance tracking in DB | **CURRENT-VERIFIED** | DocuSign/HelloSign integration is target roadmap. |
| **4. Requirements** | ATS sync, automated JD parsing, quality scorecard | Manual job entry, scorecard sum=100 rule, client confirmation | **CURRENT-VERIFIED** | Direct XML/API job board ingestion is missing. |
| **5. Candidate ATS** | Career portal, resume ingestion, parsing, dedup | SHA-256 dedup, private doc storage, OpenRouter CV parsing | **CURRENT-VERIFIED** | Public-facing career portal is missing. |
| **6. Compliance** | GDPR/DPDP consent, fail-closed erasure, AV scanning | Versioned consent, fail-closed erasure, static heuristic scan | **PARTIAL** | Document scanner is heuristic only (no live antivirus). |
| **7. Matching** | Vector search, semantic evidence scoring, feedback loop| OpenRouter `score_match` writing evidence to `matches` table | **CURRENT-VERIFIED** | Automated model retraining from recruiter feedback missing. |
| **8. Interviews** | Google/Outlook Calendar 2-way sync, reminders | RFC 5545 `.ics` export, reminder scanning in cron | **PARTIAL** | Unwired reminder side effect (RB-05); no Google OAuth. |
| **9. Placements** | Offer tracking, guarantee tracking, replacement pipeline| Complete placement state machine and replacement approvals | **CURRENT-VERIFIED** | Background cron to auto-expire guarantees missing. |
| **10. Finance** | Stripe/bank reconciliation, automated debt collection | HTML/PDF invoice generation, payment recording, disputes | **PARTIAL** | Unwired invoice reconciliation side effect (RB-05). |
| **11. Email / Comm**| Multi-mailbox Hostinger sync, auto-threading, cold leads| Hostinger SDK outbound, thread matching via In-Reply-To | **PARTIAL** | Unmatched inbound emails cannot create new leads. |
| **12. Queue Engine**| Distributed multi-worker queue with dead-letter queue| Single-table MySQL queue with priority, retry, backoff | **PARTIAL** | 2 of 6 job handlers unwired in `queue.ts` (RB-05). |
| **13. Approval Safety**| Non-bypassable human owner approval for high-risk acts| Approval engine supports manual and policy auto-approval | **ACTIVE-DEFECT** | Consequential actions can be policy-auto-approved (RB-07). |
| **14. Recruiter Network**| Marketplace with ratings, assignments, automated payouts | Team members with role `recruiter` only | **TARGET / MISSING** | Dedicated marketplace, commission ledger, payouts missing. |
| **15. Overseas Recr.**| Country-specific visa checklists, compliance guides | General country/location string fields | **TARGET / MISSING** | Immigration rules, work permit tracking missing. |
| **16. Growth / SEO** | Automated blog publisher, social post distributor | Zero marketing or social media code in repo | **TARGET / MISSING** | Entirely an aspirational roadmap engine. |

---

## 27. Environment & External Dependency Matrix

| Environment Variable | Required Runtime | Sensitive | Current Code Site | Operational Purpose & Invariants |
| :--- | :--- | :--- | :--- | :--- |
| `DATABASE_URL` | Production & Dev | **YES** | `server/db.ts:24` | MySQL connection string. In production, missing variable throws fatal error; startup executes `SELECT 1` ping. |
| `NODE_ENV` | All | NO | `server/db.ts:23` | `"production"` enables strict Fastify runtime, HTTPS checks, and disables mock store fallbacks. |
| `PORT` | Container | NO | `server/_core/index.ts:188` | Port to bind (default 3000). Fastify binds on `0.0.0.0`. |
| `APP_BASE_URL` | Production | NO | `server/services/runtimeAuth.ts:61` | Canonical application URL (must be HTTPS in production). |
| `PRIMARY_OWNER_EMAIL` | Production | NO | `server/services/primaryOwner.ts:9` | Resolves workspace owner authority. Prevents dev fallback. |
| `PRIMARY_OWNER_OPEN_ID`| Optional | NO | `server/services/primaryOwner.ts:8` | OpenID claim identifier for primary workspace owner. |
| `OWNER_ONLY_MODE` | Optional | NO | `server/services/workspaceAccess.ts:16`| When `"true"`, blocks all non-owner team members. |
| `OPENROUTER_API_KEY` | AI Queue | **YES** | `server/services/openrouter.ts:84` | Bearer token for OpenRouter model inference gateway. |
| `AUTH_MODE` | Production | NO | `server/services/runtimeAuth.ts:57` | Must be `"oidc"` in production runtime. |
| `OIDC_ISSUER_URL` | Production | NO | `server/services/runtimeAuth.ts:58` | Base URL for OIDC provider discovery (must be HTTPS). |
| `OIDC_CLIENT_ID` | Production | NO | `server/services/runtimeAuth.ts:59` | Client ID registered with production OIDC provider. |
| `OIDC_CLIENT_SECRET` | Production | **YES** | `server/services/runtimeAuth.ts:60` | Client secret registered with production OIDC provider. |
| `OIDC_REDIRECT_URI` | Production | NO | `server/services/runtimeAuth.ts:82` | Callback URL (`${APP_BASE_URL}/api/auth/oidc/callback`). |
| `SESSION_SECRET` | Production | **YES** | `server/services/runtimeAuth.ts:71` | Cryptographic secret for signing JWT cookies (>= 32 chars). |
| `CRON_SECRET` | Production Cron | **YES** | `server/hostinger.ts:124` | Secret for scheduled endpoint execution (>= 8 chars). Validated via `timingSafeEqual`. |
| `PRIVATE_STORAGE_MODE` | Storage | NO | `server/services/privateStorage.ts:10` | `"local"`, `"s3"`, or `"managed"`. (Note: `"managed"` mode fails closed on deletion). |
| `PRIVATE_LOCAL_STORAGE_PATH`| Hostinger Local| NO | `server/services/privateStorage.ts:25`| Directory path outside web root for document files. |
| `STORAGE_BUCKET` | S3 Mode | NO | `server/services/privateStorage.ts:37` | AWS S3 or compatible object bucket name. |
| `STORAGE_REGION` | S3 Mode | NO | `server/services/privateStorage.ts:38` | AWS S3 region identifier. |
| `STORAGE_ACCESS_KEY_ID`| S3 Mode | **YES** | `server/services/privateStorage.ts:39` | S3 access key ID. |
| `STORAGE_SECRET_ACCESS_KEY`| S3 Mode | **YES** | `server/services/privateStorage.ts:40` | S3 secret access key. |
| `STORAGE_ENDPOINT` | S3 Mode | NO | `server/services/privateStorage.ts:53` | Custom S3 endpoint URL (e.g. MinIO, Cloudflare R2). |
| `HOSTINGER_MAIL_API_TOKEN` | Hostinger Mail | **YES** | `server/services/hostingerMail.ts:28` | Hostinger Mail API Bearer token for outbound dispatch. |
| `HOSTINGER_MAIL_FROM_DOMAIN`| Hostinger Mail | NO | `server/services/hostingerMail.ts:6` | Domain for email dispatches (e.g. `overseasjob.in`). |
| `HOSTINGER_MAIL_WEBHOOK_SECRET`| Hostinger Mail | **YES** | `server/services/hostingerWebhook.ts:13`| Secret for inbound webhook verification via `timingSafeEqual`. |

---

## 28. Evidence Index

### 28.1 Codebase & Schema Files
- `package.json`: Dependencies, scripts, package manager (`pnpm@11.0.0`), engines (`>=20.19.0`).
- `drizzle/schema.ts`: 31 relational MySQL tables, foreign keys, unique indices, enums.
- `server.ts`: Express development server entry point with Vite middleware.
- `server/hostinger.ts`: Fastify production server entry point, static asset hosting, cron routes.
- `server/db.ts`: `getDb`, `requireDb`, `verifyDatabaseConnectivity`, `recordAudit`, `createId`.
- `server/workflow.ts`: `assertTransition`, `transitions` map, `isConsequentialAction`, `ensureSafeAiText`.
- `server/services/runtimeAuth.ts`: OIDC discovery, PKCE, signed session JWTs, `authenticateCronRequest`.
- `server/services/workspaceAccess.ts`: Multi-tenant workspace check, role hierarchy, route protection.
- `server/services/primaryOwner.ts`: Owner resolution, environment evaluation, fallback handling.
- `server/services/approvalEngine.ts`: Approval ledger, consequential action set, side-effect dispatcher.
- `server/services/policyEngine.ts`: Policy rules matching, quiet hours, limits, emergency stop.
- `server/services/queue.ts`: Queue processing, AI task execution, `handleAiTaskResult`.
- `server/services/openrouter.ts`: OpenRouter API client, 6 Zod task schemas, system prompts, error classes.
- `server/services/aiRouting.ts`: Model selector, built-in preference, OpenRouter fallback.
- `server/services/privateStorage.ts`: Document storage adapter (`local`, `s3`, `managed`), fail-closed deletion.
- `server/services/documentScanner.ts`: Static heuristic security scanner (magic bytes, headers, EICAR).
- `server/services/invoicing.ts`: Commercial fee calculations, HTML/PDF rendering, payment recording.
- `server/services/calendar.ts`: RFC 5545 iCalendar generation (`.ics` format), event UID creation.
- `server/services/interviewReminders.ts`: Due interview scanner, reminder queue dispatch.
- `server/services/hostingerMail.ts`: Hostinger Mail API SDK adapter, suppression validation, outbound delivery.
- `server/services/hostingerWebhook.ts`: Webhook normalization, timing-safe auth, threading, opt-out detection.
- `server/routers/recruitment.ts`: Master recruitment tRPC router (prospects, jobs, candidates, matching, etc.).
- `server/routers/candidateWorkflows.ts`: Screening, shortlist notes, fail-closed privacy erasure.
- `server/routers/consequential.ts`: Consequential approvals router (candidate decision, replacement, invoices).
- `server/routers/operations.ts`: Dashboard KPI, settings, policies, queue management, exception center, audits.
- `server/routers/email.ts`: Email identities, outbound approval dispatch, inbound thread recording.
- `server/routers/team.ts`: Team invitations, role management, invitation acceptance, access verification.
- `scripts/build-hostinger.mjs`: Production builder (Vite frontend build + esbuild Fastify backend bundle).
- `scripts/verify-hostinger.ts`: Standalone verification test for Fastify production routes and body limits.

### 28.2 Authoritative Test Files & Test Suite Execution
- **Full Repository Test Suite Execution**: `npx vitest run` verified clean pass across the entire codebase:
  - **Test Files**: **36 passed (36)**
  - **Tests**: **204 passed, 1 skipped (205 total)**
  - **Suite Duration**: **38.62s**
- `server/routers/candidateDeletion.test.ts`: FulfillDeletion fail-closed physical storage deletion test suite (5 passed).
- `server/hostinger.test.ts`: Fastify production server, CRON_SECRET auth, and storage security suite (4 passed).
- `server/p02b.test.ts`: Database startup safety, cron timing-safe auth, and privacy fail-closed suite (12 passed).
- `server/services/approvalEngine.test.ts`: Consequential action side effects and rejection suite.
- `server/services/autoApprovalCallSites.test.ts`: Policy auto-approval call sites and grace period suite.
- `server/services/workspaceAccess.test.ts`: RBAC permission matrix and route denial suite (14 passed).
- `server/services/privateStorage.test.ts`: Local, S3, and managed storage mode unit tests (5 passed).
- `server/services/documentScanner.test.ts`: Heuristic document scanner signature unit tests.
- `server/services/hostingerMail.test.ts`: Hostinger Mail SDK outbound delivery and suppression unit tests.
- `server/services/hostingerWebhook.test.ts`: Inbound email webhook normalization and auth unit tests.
- `server/routers/invoices.workflow.test.ts`: End-to-end invoice lifecycle (draft → issued → disputed → credited) (2 passed).
- `server/routers/safeAiText.test.ts`: Content safety filter blocking protected recruitment traits.
- `server/e2eHappyPath.workflow.test.ts`: End-to-end happy path recruitment workflow.
- `scripts/verify-hostinger.ts`: Standalone verification of Fastify production routes, storage auth, and payload size bounds (21 passed).

