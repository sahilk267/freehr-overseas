# FreelanceHR Platform Source of Truth (Canonical Architecture Record)

**Document Phase**: P0.1-F Final Source of Truth Normalization & Freeze  
**Verification Level**: Strict Repository-Audited Evidence (Zero Hallucination / Zero Speculation)  
**Last Verified Date**: 2026-09-28  
**Repository Authority Rule**: The actual codebase, schemas, configuration files, and test files supersede all external, historical, or aspirational documentation claims.

---

## 0. Document Governance & Baseline Status

### 0.0 Baseline Status
This document is the canonical platform Source of Truth baseline after P0.1-D reconstruction and P0.1-E repository reconciliation.

It defines the current documented product and implementation baseline. It strictly distinguishes verified implementation from target architecture.

Future implementation work MUST NOT silently modify the product truth. Material architecture, workflow, database, approval, security, or capability changes must update this Source of Truth and the relevant downstream contract documents.

- **Baseline Status**: **FROZEN BASELINE**
- **Last Verified**: 2026-09-28
- **Verification Phase**: P0.1-F — Final Source of Truth Normalization & Freeze
- **Operational Scope Note**: Declaring this document "FROZEN" signifies that the **DOCUMENT BASELINE IS FROZEN**. It does NOT mean the platform is production complete, free of defects, or ready for general deployment. Active release blockers (RB-05, RB-07 through RB-12) remain documented and unresolved in the codebase.

### 0.1 Purpose & Authority
This document serves as the sole canonical master architectural record and operational source of truth for the FreelanceHR (FreeHR Overseas) platform. It defines the formal specification of the platform across two strictly separated realities:
1. **Layer A — Product / Target Truth**: The complete product vision, target operating loops, planned engines, and intended business capabilities.
2. **Layer B — Implementation / Repository Truth**: The exact, verified state of the current codebase, schemas, database tables, API routes, queue handlers, security policies, and test suites.

Under no circumstances may a target capability be described as implemented, verified, or operational without concrete repository citations (file path, line numbers, function signatures, or schema declarations).

### 0.2 Status Vocabulary & Granularity Rule
Every engine, subsystem, capability, lifecycle stage, state transition, and AI feature is assigned an explicit status token from the controlled vocabulary below:

| Status Token | Formal Definition |
| :--- | :--- |
| **CURRENT-VERIFIED** | A specific capability is CURRENT-VERIFIED only when: (1) the capability exists in the current repository, (2) it is wired into the required execution path, (3) its relevant behavior is supported by repository evidence, (4) its implementation does not contradict a known mandatory business or security invariant, and (5) the claim refers specifically to the capability being evaluated, not merely to the existence of related tables, UI, or services. |
| **VERIFIED-TEST** | Verified by an automated test in the repository suite that passes cleanly in Vitest. |
| **PARTIAL** | Core code exists and executes, but boundary cases, secondary paths, safety invariants, or integrations are incomplete. |
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
| **RELEASE-BLOCKER** | Critical defect, security bypass, or unwired core capability that prohibits production release until remediated. |

**Domain Granularity Invariant**: A broad domain or subsystem MUST NOT be marked `CURRENT-VERIFIED` if material sub-capabilities remain missing, unsafe, unwired, or blocked. In all such cases, granular sub-capability statuses must be documented, and the aggregate domain status must reflect its weakest required invariant (e.g. `PARTIAL` or `ACTIVE-DEFECT`).

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

### 2.1 The 5-Layer Governance Model (Target vs Reality)
The target architecture of FreelanceHR strictly enforces that **AI intelligence is separated from business authority**. The platform architecture defines five operational layers:

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
   - Invariant: AI is strictly analysis and recommendation. AI is NOT authority. It is prohibited from autonomously rejecting candidates, altering invoice statuses, granting consent, executing payouts, or bypassing owner approvals (`openrouter.ts:51-58`, `workflow.ts:159-174`).
2. **Policy Engine (`server/services/policyEngine.ts`, `server/services/approvalEngine.ts`)**:
   - Enforces workspace guardrails: daily outbound email budgets, quiet hours, emergency stop flags, and non-consequential matching rules.
   - Invariant: Policy is NOT automatically approval. Policy rules must never silently grant authority over consequential actions.
3. **Approval Engine (`server/services/approvalEngine.ts`, `server/routers/consequential.ts`)**:
   - Represents human authority for consequential actions. Mandatory human owner authorization is required for all irreversible or high-impact actions.
4. **Domain Engines (`server/workflow.ts`, `server/routers/*`)**:
   - The sole owners of business state. Enforce valid state machine transitions via `assertTransition()`.
5. **Audit Plane (`server/db.ts:recordAudit`, `incidents` table)**:
   - Records an immutable, append-only evidentiary trail for every state transition, authorization check, and delivery attempt.

**Canonical Authority Invariants**:
- **AI ≠ Authority**: AI models draft and score; they never decide.
- **Policy ≠ Approval**: Policies set boundary limits; they cannot auto-approve consequential domain mutations.
- **Automation ≠ Authorization**: Scheduled workers execute approved tasks; they never self-authorize consequential state changes.
- **UI ≠ Authorization**: Frontend visibility toggles do not constitute authorization; backend RBAC and approval gates must enforce every action.

### 2.2 Forensic Governance Inconsistencies & Active Defects
Forensic repository audit reveals four critical divergence points between Layer A (Target) and Layer B (Repository Reality):
1. **Auto-Approval Rule Bypass of Consequential Actions (Active Defect RB-07)**:
   In `server/services/approvalEngine.ts:requestOrAutoDecide` (lines 265-276), `findMatchingRule` is executed against `policyConfig` without checking whether `actionType` belongs to `consequentialActionTypes`. If any rule matches the action type and conditions, `status: "approved"` is recorded immediately (or queued via delayed grace period) with `decisionSource: "policy"`. Consequential actions are NOT protected against policy auto-approval in the current codebase.
2. **Consequential Action Taxonomy Mismatch & Routing Disconnect (Active Defect RB-09)**:
   - `server/workflow.ts:isConsequentialAction` (lines 159-174) defines **12 actions**: `client_onboarding`, `candidate_share`, `final_candidate_decision`, `candidate_final_decision`, `placement_confirmation`, `replacement_case`, `invoice_issue`, `invoice_payment_status`, `invoice_dispute`, `invoice_credit`, `invoice_write_off`, `automation_stop`.
   - `server/services/approvalEngine.ts:consequentialActionTypes` (lines 15-21) defines **only 5 actions**: `candidate_final_decision`, `replacement_case`, `invoice_payment_status`, `invoice_dispute`, `invoice_credit`.
   - `server/routers/consequential.ts:consequentialActions` (line 9) also defines **only the same 5 actions**.
   - As a consequence: attempting to decide approvals for `client_onboarding`, `candidate_share`, `placement_confirmation`, or `invoice_issue` via `consequentialRouter.decide` throws `TRPCError(NOT_FOUND, "Consequential approval was not found.")`. Those actions can only be decided via the generic `approvalsRouter.decide` in `server/routers/recruitment.ts:748`.
3. **Lack of Transaction Atomicity in Approval Execution (Active Defect RB-11)**:
   In `server/services/approvalEngine.ts:applyApprovalDecision` (lines 190-220), `recordDecision` (updating `approvals` table), `applySideEffect` (updating domain tables like `placements`, `invoices`, `companies`), and `recordAudit` execute sequentially without wrapping in `db.transaction()`. If the side-effect or audit insert throws, the approval row remains marked "approved" with no automated rollback mechanism.
4. **Client Onboarding Direct Transition Bypass (Active Defect RB-08)**:
   In `server/routers/recruitment.ts:prospects.transition` (lines 95-103), a caller can transition a company from `converted` directly to `active` (which sets `companyType = "client"`) via standard tRPC mutation because `transitions.company.converted` contains `"active"`. No verification check or decided `client_onboarding` approval row is required, bypassing the onboarding approval gate entirely.

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
| **A. Clients** | Discover company → enrich domain → check hiring signal → KYB check → outreach → sign fee agreement → receive job. | Manual entry via `companies` table; KYB document upload verified; outreach via `outreachRouter`. Direct activation bypass exists (RB-08). | **PARTIAL / ACTIVE-DEFECT** | `drizzle/schema.ts:73`, `server/routers/recruitment.ts:95-118` |
| **B. Recruiters** | Discover freelance recruiters → verify credentials → assign jobs → track sourcing → commission payout. | Handled only via `teamMembers` (roles: owner, recruiter, reviewer, viewer). No marketplace, rating engine, or payouts. | **PARTIAL** | `server/routers/team.ts`, `drizzle/schema.ts:641` |
| **C. Candidates** | Acquire CV → deduplicate by hash → parse skills → obtain consent → score match → interview → place. | Implemented: SHA-256 deduplication, AI CV parsing, consent gating, shortlist sharing, `.ics` calendar. Candidate share can be policy-auto-approved (RB-07). | **PARTIAL / RELEASE-BLOCKED** | `server/routers/recruitment.ts`, `server/services/queue.ts` |
| **D. Jobs** | Intake requirement → score quality (100-pt scorecard) → client confirmation → AI match → interview → fill. | Implemented: 100-point scorecard sum validation, client confirmation required before sourcing. | **CURRENT-VERIFIED** | `server/routers/recruitment.ts:180-260` |
| **E. Leads** | Ingest lead signals → scrape website → score hiring intent → cold outreach sequence → meeting booking. | Manual company creation with `hiringSignal` field; automated scraping and lead enrichment are absent. | **TARGET / MISSING** | `drizzle/schema.ts:88` |
| **F. Partners** | Cross-border recruitment agencies, employer of record (EOR), and visa processing partners. | No partner or agency tables exist in the schema. | **TARGET / MISSING** | Zero schema/code presence |
| **G. Marketing**| Keyword discovery → content generation → SEO blog publishing → social media distribution → inbound lead. | No marketing, social publishing, or SEO distribution code exists. | **TARGET / MISSING** | Zero schema/code presence |

---

## 4. Master Capability & Engine Registry

The platform architecture is decomposed into 14 distinct engine domains. Each is classified by current implementation state:

| Engine Domain | Subsystem / Capability | Current Status | Primary Code / Schema Sites | Operational Gaps |
| :--- | :--- | :--- | :--- | :--- |
| **1. Identity & Org** | Multi-tenant Workspace & RBAC | **PARTIAL / ACTIVE-DEFECT** | `server/services/workspaceAccess.ts`, `server/routers/team.ts`, `server/hostinger.ts` | Fastify runtime fail-closed; Express dev context has owner fallback (RB-12). |
| **2. Client CRM** | Company, Contact & KYB Engine | **PARTIAL / ACTIVE-DEFECT** | `drizzle/schema.ts:73,100`, `server/routers/recruitment.ts:95` | Direct activation bypasses onboarding approval (RB-08). Auto-enrichment missing. |
| **3. Commercial** | Fee Proposals & Terms | **PARTIAL** | `drizzle/schema.ts:135`, `server/routers/outreach.ts:170` | DB tracking only; digital e-signature integration (DocuSign/HelloSign) missing. |
| **4. Requirement** | Job Intake & Quality Scorecard | **CURRENT-VERIFIED** | `server/routers/recruitment.ts:180`, `jobs` table | Automated ATS sync/import missing. |
| **5. Candidate** | Ingestion, Deduplication, Parse | **PARTIAL / RELEASE-BLOCKED** | `server/routers/recruitment.ts:270`, `server/services/queue.ts` | Ingestion/parsing verified; candidate share can be auto-approved (RB-07) and routing disconnected (RB-09). Public portal missing. |
| **6. Compliance** | GDPR/DPDP Consent & Deletion | **PARTIAL** | `server/routers/candidateWorkflows.ts:250`, `privateStorage.ts` | Consent, suppression, and fail-closed deletion verified; document scanner is heuristic only (no live antivirus). |
| **7. Matching** | Evidence-based Semantic Matching | **PARTIAL** | `server/services/queue.ts:178`, `matches` table | Evidence scoring verified; vector search, automated candidate feedback loops, and retraining missing. |
| **8. Interview** | RFC 5545 Calendar & Reminders | **PARTIAL / UNWIRED** | `server/services/calendar.ts`, `interviewReminders.ts` | Calendar export verified; reminder side-effects unwired in queue (RB-05). |
| **9. Placement** | Placement & Guarantee Tracking | **PARTIAL / ACTIVE-DEFECT** | `server/routers/recruitment.ts:650`, `placements` table | Placement confirmation can be policy-auto-approved (RB-07) and routing broken (RB-09). Guarantee cron missing. |
| **10. Finance** | Invoicing, PDF & Stripe Links | **PARTIAL / UNWIRED** | `server/services/invoicing.ts`, `invoices` table | Invoicing/PDF verified; auto-reconciliation unwired (RB-05); consequential approvals can be auto-approved (RB-07). |
| **11. Comm** | Hostinger Mail SDK & Threading | **PARTIAL / ACTIVE-DEFECT** | `server/services/hostingerMail.ts:54`, `hostingerWebhook.ts` | Outbound SDK and suppression verified; outbound `providerMessageId: null` breaks live thread correlation (RB-10). |
| **12. Queue** | Distributed Automation Queue | **PARTIAL / UNWIRED** | `server/services/queue.ts`, `automationQueue` table | 4 of 6 job handlers wired; 2 unwired in queue (`send_reminder`, `reconcile_invoice`) (RB-05). |
| **13. Marketplace**| Freelance Recruiter Network | **TARGET / MISSING** | None (`teamMembers` role "recruiter" only) | Dedicated marketplace, ratings, commission ledgers, payouts missing. |
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
- **Onboarding Approval (Intended)**: `prospects.requestOnboardingApproval` (`server/routers/recruitment.ts:104`) creates approval request for `client_onboarding` when `company.pipelineState === "converted"`.
- **Onboarding Approval Bypass (Active Defect RB-08)**: `prospects.transition` (`server/routers/recruitment.ts:95-103`) allows direct transition from `converted` to `active` (and sets `companyType: "client"`), completely bypassing the onboarding approval gate and KYB verification requirements.
- **Fee Proposals**: `feeProposals` table (`schema.ts:135`) records commercial terms (percentage fee, guarantee days, payment terms). No client signature portal exists.
- **Aggregate Status**: **PARTIAL / ACTIVE-DEFECT**.

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
- **Marketplace & Payout Reality**: **TARGET / MISSING**. The current repository does NOT contain a public recruiter marketplace, commission calculation ledger, recruiter rating engine, or automated payout gateway. Recruiter activity is managed strictly as internal workspace team members.
- **Aggregate Status**: **PARTIAL**.

---

## 7. Candidate Operating System

### 7.1 Intended Lifecycle
```
ACQUIRE → IDENTIFY → DEDUPLICATE → PROFILE → DOCUMENT → SCAN → 
PARSE → ENRICH → CONSENT → COMPLIANCE → SUPPRESS/DNC CHECK → MATCH → 
SCREEN → SHORTLIST → SHARE → INTERVIEW → FEEDBACK → OFFER → ACCEPT → 
JOIN → PLACEMENT → GUARANTEE → REPLACEMENT → CLOSE → RETAIN / NURTURE
```

### 7.2 Implementation Reality & Granular Code Trace
- **Candidate Ingestion**: **CURRENT-VERIFIED**. `candidates` table (`schema.ts:182`) tracks `ownerId`, `name`, `status`, `profileState`, and metadata.
- **Identification & Deduplication**: **CURRENT-VERIFIED**. `candidates` table requires `primaryEmailHash` and `primaryPhoneHash`. Collisions are rejected to prevent duplicate candidate profiles.
- **Document Storage**: **CURRENT-VERIFIED**. `candidateDocuments` (`schema.ts:221`) stores CVs and certifications in private storage (`local`, `s3`, or `managed`).
- **CV Parsing**: **CURRENT-VERIFIED**. `server/services/queue.ts:handleAiTaskResult` (`parse_cv`) extracts skills, experience years, education, and headline, updating `candidateDocuments.parseState = "parsed"`.
- **Consent Gating**: **CURRENT-VERIFIED**. `consents` table (`schema.ts:251`) records explicit, versioned candidate consent (`platform_processing`, `client_sharing`, etc.).
- **Suppression & DNC**: **CURRENT-VERIFIED**. `suppressionList` (`schema.ts:581`) enforces opt-out. Any candidate marked DNC or withdrawing consent cascades suppression.
- **Privacy Erasure (Fail-Closed)**: **VERIFIED-TEST**. `candidateWorkflows.ts:250-295` mandates that physical document deletion from disk/S3 MUST succeed before database records are redacted. If storage fails, the deletion aborts, transitions to `investigation`, and logs an audit failure (`privacy.erasure_failed`).
- **Candidate Sharing Approval**: **ACTIVE-DEFECT / RELEASE-BLOCKER**. `matchingRouter.requestShareApproval` (`server/routers/recruitment.ts:508-525`) creates `candidate_share` approval. However: (1) if an auto-approval rule is configured, it auto-approves without owner review (RB-07); and (2) deciding this approval via `consequentialRouter.decide` throws `NOT_FOUND` because `candidate_share` was omitted from its consequential set (RB-09).
- **Public Application Portal**: **TARGET / MISSING**. Candidates can only be imported via API/dashboard.
- **Aggregate Candidate OS Status**: **PARTIAL / RELEASE-BLOCKED**.

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
- **Aggregate Status**: **CURRENT-VERIFIED**.

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
- **Consequential Placement Confirmation**: `placementsRouter.transition` (`server/routers/recruitment.ts:656-676`) creates an approval request for `placement_confirmation` when transitioning to `joining_confirmed`. Note: If an auto-approval rule is configured, it auto-approves immediately (RB-07). Furthermore, deciding this approval via `consequentialRouter.decide` throws `NOT_FOUND` because `placement_confirmation` was omitted from `consequentialActions` (RB-09); it must be decided via `approvalsRouter.decide`.
- **Replacement Governance**: `consequentialRouter.requestReplacement` creates an approval request for `replacement_case`. Deciding the approval updates placement state to `replacement_requested`.
- **Guarantee Expiration Automation**: **TARGET / MISSING**. No cron job auto-expires guarantee periods.
- **Aggregate Status**: **PARTIAL / ACTIVE-DEFECT**.

---

## 10. Finance Operating System

### 10.1 Intended Architecture
- **Invoicing**: Commercial fee calculation, tax breakdown, PDF rendering, payment links.
- **Payment Lifecycle**: Bank transfer reconciliation, Stripe checkout, overdue tracking.
- **Dispute & Credit Governance**: Consequential approval required for credits, write-offs, or disputes.
- **AI Boundaries**: AI is strictly advisory. AI CANNOT alter invoice truth or issue write-offs.

### 10.2 Implementation Reality & Granular Code Trace
- **Invoice Drafting & Creation**: **CURRENT-VERIFIED**. `invoices` table (`schema.ts:438`) tracks line items, tax rates, and totals.
- **Invoice Document Generation**: **CURRENT-VERIFIED**. `server/services/invoicing.ts:generateInvoiceHtml` renders complete HTML/PDF invoices with tax breakdowns (`invoicing.ts:54-150`).
- **Payment Link Generation**: **CURRENT-VERIFIED**. `server/services/invoicing.ts:createInvoicePaymentLink` generates provider integration payment links.
- **Manual Payment Recording**: **CURRENT-VERIFIED**. `payments` table (`schema.ts:474`) logs manual and webhook payment records with provider transaction IDs.
- **Invoice Issue / Dispute / Credit / Write-off**: **PARTIAL / ACTIVE-DEFECT**. Requires consequential approval, but policy auto-approval rules can auto-approve without owner review (RB-07).
- **Invoice Auto-Reconciliation**: **UNWIRED (RB-05)**. `reconcile_invoice` has prompt and schema in `openrouter.ts`, but its result handler is **UNWIRED** in `server/services/queue.ts`.
- **Recruiter Commission & Payout Engine**: **TARGET / MISSING**. No commission calculation ledger or payout mechanism.
- **Aggregate Status**: **PARTIAL / UNWIRED**.

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
- **Status**: **VERIFIED-TEST**.

### 11.2 Document Security Scanner Reality
- Located in `server/services/documentScanner.ts`.
- **Architecture Reality**: Uses static byte heuristics and file hygiene checks; **NOT an active antivirus daemon or malware sandbox** (e.g. ClamAV).
- Evaluates:
  1. Size bounds (0 bytes flagged, > 5MB rejected).
  2. SHA-256 integrity against upload claims.
  3. EICAR malware test string signature.
  4. Executable magic headers (`MZ`, `ELF`, `Mach-O`, `#!`).
  5. Format magic signatures (`%PDF-`, `PK\x03\x04`).
  6. Suspicious strings (`<script`, `/JavaScript`, `vbaProject.bin`).
- **Aggregate Compliance Status**: **PARTIAL**.

---

## 12. Communication & Email Subsystem

### 12.1 Outbound Email Dispatch
- Located in `server/services/hostingerMail.ts`.
- Uses official `hostinger-mail-api-sdk` (`package.json:73`).
- **Suppression Check**: Pre-flight SHA-256 hash lookup against `suppressionList` table. Throws `TRPCError(PRECONDITION_FAILED)` if recipient is suppressed.
- **Approval Gate**: Cold recruitment outreach requires approval before `deliverApproved` can dispatch.
- **Status**: **CURRENT-VERIFIED**.

### 12.2 Inbound Email Webhook & Threading Reality (Active Defect RB-10)
- Located in `server/services/hostingerWebhook.ts` and `server/routers/email.ts`.
- **Authentication**: `isValidHostingerWebhookAuthorization` validates `HOSTINGER_MAIL_WEBHOOK_SECRET` with `timingSafeEqual`.
- **Outbound Provider Message ID Hardcoded Null (RB-10)**:
  `server/services/hostingerMail.ts:54` hardcodes `return { providerMessageId: null, senderAddress, mailboxResourceId };`. In `server/routers/email.ts:92`, `messages.providerMessageId` is updated with `null`.
- **Inbound Threading Correlation Limitation**:
  The current Hostinger outbound dispatch path returns and persists `providerMessageId` as `null`, while inbound conversation matching relies on message identity/thread headers (`In-Reply-To`, `References`) matching stored provider message IDs. Therefore, reliable bidirectional production threading through the current outbound path is incomplete/unverified (live replies to emails sent via this path will fail parent thread correlation and route to exception incidents). Inbound header extraction and incident logging are verified.
- **Exception Routing**: Every unmatched inbound reply logs an audit event (`email.inbound_unmatched`), creates an incident in `incidents` ("Inbound mail did not contain a recognized message thread reference"), and returns HTTP 202.
- **Aggregate Communication Status**: **PARTIAL / ACTIVE-DEFECT**.

---

## 13. Follow-up, Reminder & Nurture Engine

### 13.1 Intended Lifecycle
```
CONTACT → RESPONSE → CLASSIFY → NEXT ACTION → FOLLOW-UP DATE → 
REMINDER → FOLLOW-UP → RESPONSE → NURTURE → CONVERT / CLOSED
```

### 13.2 Implementation Reality & Code Trace
- **Interview Reminders**: `server/services/interviewReminders.ts` queries confirmed interviews due for reminders (`reminderAt <= now`), marks `reminderSentAt`, and inserts a `send_reminder` job into `automationQueue`.
- **Queue Gap (Active Defect RB-05)**: In `server/services/queue.ts`, `handleAiTaskResult` has **NO HANDLER** for `send_reminder`. The AI draft generated by OpenRouter is stored in `automationQueue.result` and abandoned. No notification is dispatched to candidates or interviewers.
- **Client & Candidate Nurture**: **TARGET / MISSING**. Long-term automated drip campaigns and stale lead nurture workflows are not implemented in code.
- **Aggregate Status**: **PARTIAL / UNWIRED**.

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
- **AI Authority Boundary**: AI is strictly advisory. AI cannot execute domain mutations or approve consequential actions.

### 16.2 Master AI Capability Registry

| # | AI Capability | Target Purpose | Primary Model / System Prompt | Current Status | Code Site & Evidence | Operational Defect / Gap |
| :- | :--- | :--- | :--- | :--- | :--- | :--- |
| **01** | **CV Parsing** | Extract skills, roles, education, experience | `openrouter.ts:parse_cv` | **CURRENT-VERIFIED** | `queue.ts:22-73` | Fully updates `candidateDocuments` and `candidates.headline`. |
| **02** | **Outreach Drafting** | Generate personalized outreach with opt-out | `openrouter.ts:draft_outreach` | **CURRENT-VERIFIED** | `queue.ts:74-103` | Sets `messages.status = "draft_ready"`; requires human approval. |
| **03** | **Reply Classification**| Detect interest, meeting request, or opt-out | `openrouter.ts:classify_reply` | **CURRENT-VERIFIED** | `queue.ts:104-177` | Automatically sets `opted_out` and cascades to `suppressionList`. |
| **04** | **Evidence Matching** | Score candidate evidence against job criteria | `openrouter.ts:score_match` | **PARTIAL** | `queue.ts:178-239` | Inserts/updates `matches` table. Vector search and feedback retraining are missing. |
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
- **Aggregate Queue Status**: **PARTIAL / UNWIRED** (2 of 6 job handlers unwired, RB-05).

---

## 18. Workflow & State Machines

### 18.0 Transition Enforcement Reality & Scope Note
`server/workflow.ts` provides the canonical transition definitions and `assertTransition()` is used by verified transition paths. Repository-wide enforcement of every state mutation has NOT been proven where direct state assignments or alternate mutation paths exist (e.g. `prospects.transition` direct activation bypass documented in RB-08). Universal transition enforcement remains an implementation gap unless explicitly proven.

The state-machine diagrams below represent the **canonical high-level architectural summaries**. Complete transition-by-transition definitions and boundary conditions will be maintained in a downstream `STATE_MACHINE_CATALOG.md` (which must not contradict this document). This section summarizes the primary lifecycle paths.

### 18.1 Master State Machine Summaries

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

### 21.3 Primary Owner & Runtime Context Security Audit
1. **Fastify Production Context (`server/hostinger.ts:29-32`)**:
   `createFastifyContext` resolves `user = await authenticateRuntimeRequest(...)`. If the user is unauthenticated, `user` is strictly `null`. It does NOT fabricate an owner.
2. **Express Development Context (Active Defect RB-12)**:
   In `server/_core/context.ts` (lines 27-39), if `user` is null, the handler unconditionally falls back to `(await getUserByOpenId("owner_dev")) ?? { id: 1, openId: "owner_dev", name: "Sahil (Owner)", role: "admin", ... }`. If the application is ever executed via `server.ts` in production, all unauthenticated requests are granted root owner privileges.
3. **Primary Owner Resolution (`server/services/primaryOwner.ts`)**:
   Resolves `PRIMARY_OWNER_OPEN_ID`, `OWNER_OPEN_ID`, or `PRIMARY_OWNER_EMAIL`. If unset in non-test environments, falls back to `mohd.aziz.sk@gmail.com` or `owner_dev`. Production deployments must explicitly provide `PRIMARY_OWNER_EMAIL`.
4. **Aggregate Identity / Auth Status**: **PARTIAL / ACTIVE-DEFECT**.

---

## 22. Audit & Observability Engine

### 22.1 Append-Only Audit Trail
- Powered by `server/db.ts:recordAudit` writing to `auditEvents` table (`schema.ts:553`).
- Tracks: `ownerId`, `actorType` (`user`, `system`, `ai`, `provider`), `actorId`, `action`, `resourceType`, `resourceId`, `previousState`, `nextState`, `metadata`, `ipAddress`, `userAgent`.
- Audit rows are strictly immutable (no update or delete procedures exist).
- **Status**: **CURRENT-VERIFIED**.

### 22.2 Exception Center & Incident Management
- Powered by `incidents` table (`schema.ts:615`).
- Any unhandled delivery failure, unmatched inbound email, or malformed webhook payload is automatically trapped into an incident (`operationsRouter.exceptions`).
- **Status**: **CURRENT-VERIFIED**.

---

## 23. Canonical E2E Business Scenarios

| Scenario # | Canonical Business Scenario | Target Operational Flow | Current Code State | Current Status |
| :- | :--- | :--- | :--- | :--- |
| **01** | **New Client Acquisition to Invoice** | Prospect → KYB → Agreement → Job → Match → Place → Invoice | Client onboarding approval can be bypassed via direct transition (RB-08). Consequential actions can be auto-approved (RB-07). Substeps defective. | **PARTIAL / RELEASE-BLOCKED** |
| **02** | **Existing Client New Job Requisition**| Company → Job (scorecard=100) → Client Confirmation → Pipeline | Enforced scorecard sum and mandatory client confirmation email. Substeps fully verified. | **CURRENT-VERIFIED** |
| **03** | **Candidate Ingestion to Placement** | CV upload → Dedup → Scan → Parse → Consent → Match → Place | Ingestion and parsing verified. Candidate share can be policy-auto-approved (RB-07); placement confirmation routing broken (RB-09). | **PARTIAL / RELEASE-BLOCKED** |
| **04** | **Recruiter Team Member Onboarding** | Owner invites → Email sent → Recruiter accepts at `/team/accept` | Dispatches email via Hostinger Mail; role enforced via RBAC. | **CURRENT-VERIFIED** |
| **05** | **Consent Withdrawal & DNC Cascade** | Candidate withdraws consent → Instant suppression list insertion | Pre-flight suppression check blocks outbound communications. | **CURRENT-VERIFIED** |
| **06** | **GDPR Right to Erasure (Fail-Closed)**| Deletion requested → Physical files deleted → DB redacted | Atomic fail-closed: fails if disk/S3 deletion fails; audits failure. | **VERIFIED-TEST** |
| **07** | **Interview Calendar Scheduling** | Interview created → RFC 5545 `.ics` generated → Feed subscribed | Calendar export verified; provider-free iCalendar format. | **CURRENT-VERIFIED** |
| **08** | **Interview Reminder Dispatch** | Cron triggers → Due interviews scanned → Reminder queued → Sent | **DEFECT (RB-05)**: Job queued, but result handler unwired in queue. Side effects never execute. | **UNWIRED / RELEASE-BLOCKED** |
| **09** | **Candidate Profile Sharing Approval** | Recruiter requests share → Owner approves → Shortlist marked shared | Implemented; can be auto-approved if policy rule configured (RB-07). Routing disconnected (RB-09). | **PARTIAL / RELEASE-BLOCKED** |
| **10** | **Placement Confirmation & Guarantee** | Candidate joins → Owner approves placement → Guarantee starts | Consequential approval can be auto-approved (RB-07); rejected by `consequentialRouter.decide` (RB-09). | **PARTIAL / RELEASE-BLOCKED** |
| **11** | **Replacement Guarantee Activation** | Candidate leaves → Replacement case opened → Sourcing restarts | Consequential approval updates placement to `replacement_requested` via `consequentialRouter.requestReplacement`. | **CURRENT-VERIFIED** |
| **12** | **Invoice Generation & Stripe Link** | Placement confirms → Invoice drafted → HTML rendered → Pay link | Verified invoice document generator and payment link stubs. | **CURRENT-VERIFIED** |
| **13** | **Invoice Auto-Reconciliation** | Bank event received → AI reconciles payment → Status updated | **DEFECT (RB-05)**: AI task schema exists; handler unwired in queue. Financial status never updates. | **UNWIRED / RELEASE-BLOCKED** |
| **14** | **Invoice Dispute / Credit Governance**| Client disputes invoice → Consequential approval → Status credit | Managed via `consequentialRouter.requestInvoiceAction`. However, RB-07 auto-approval applies. | **PARTIAL / RELEASE-BLOCKED** |
| **15** | **Inbound Email Thread Matching** | Inbound webhook → Message headers matched to thread → Stored | **DEFECT (RB-10)**: Outbound providerMessageId is null; incoming replies fail thread match and route to incidents. | **PARTIAL / RELEASE-BLOCKED** |
| **16** | **Inbound Email Opt-out Detection** | Candidate replies "STOP" → AI/regex detects → Suppressed | Automatically inserts into `suppressionList` and halts contact. | **CURRENT-VERIFIED** |
| **17** | **Cold Inbound Ingestion** | Unsolicited email arrives at mailbox → New lead created | **GAP**: Unmatched inbound emails cannot create leads; routed to exception incidents. | **PARTIAL** |
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
| **RB-07** | **P1** | **Approval / Safety** | **Consequential Actions Can Bypass Mandatory Human Approval**: In `server/services/approvalEngine.ts:requestOrAutoDecide` (lines 265-276), `findMatchingRule` does NOT check whether `actionType` is consequential. Any consequential action matching a workspace policy rule is automatically approved with `decisionSource: "policy"`. | `server/services/approvalEngine.ts:240-340`, `server/services/policyEngine.ts:120-173` | Enforce in code that all consequential actions strictly bypass `findMatchingRule` and require human owner decision. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-08** | **P1** | **Client Onboarding Bypass** | **Client Onboarding Direct Transition Bypass**: In `server/routers/recruitment.ts:prospects.transition` (lines 95-103), a caller can transition a company directly from `converted` to `active`, which sets `companyType: "client"` without checking or requiring a decided `client_onboarding` approval row or KYB verification. | `server/routers/recruitment.ts:95-103` | In `prospects.transition`, disallow direct transition to `active`. Require that `active` state can only be reached via approved `client_onboarding` side-effect execution. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-09** | **P1** | **Consequential Inconsistency** | **Consequential Action Taxonomy Mismatch & Routing Disconnect**: `server/workflow.ts:isConsequentialAction` defines 12 actions, but `approvalEngine.ts` and `consequential.ts` define only 5. Attempting to decide approvals for `client_onboarding`, `candidate_share`, `placement_confirmation`, or `invoice_issue` via `consequentialRouter.decide` throws `NOT_FOUND`. | `server/services/approvalEngine.ts:15-21`, `server/routers/consequential.ts:9,62` | Unify `consequentialActionTypes` across `workflow.ts`, `approvalEngine.ts`, and `consequential.ts` to include all 12 actions. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-10** | **P1** | **Email Threading Failure** | **Outbound Email Provider Message ID Hardcoded Null**: `server/services/hostingerMail.ts:54` hardcodes `providerMessageId: null` on all outbound emails. Consequently, `messages.providerMessageId` is persisted as null, making bidirectional thread correlation via `In-Reply-To` and `References` impossible. Inbound replies fail parent matching and route to `incidents`. | `server/services/hostingerMail.ts:54`, `server/routers/email.ts:92,123-138` | Extract or generate a valid, RFC-compliant Message-ID during outbound dispatch and store it in `messages.providerMessageId`. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-11** | **P1** | **Transaction Non-Atomicity** | **Approval Decision & Side-Effect Lack Transaction Boundary**: In `server/services/approvalEngine.ts:applyApprovalDecision` (lines 190-220), `recordDecision`, `applySideEffect`, and `recordAudit` execute sequentially without a database transaction wrapper (`db.transaction`). If a side effect fails, the approval remains marked "approved" with no rollback. | `server/services/approvalEngine.ts:190-220` | Wrap `recordDecision`, `applySideEffect`, and `recordAudit` in an atomic database transaction. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-12** | **P2** | **Security / Dev Fallback** | **Express Context Unconditional Owner Fallback**: `server/_core/context.ts` unconditionally assigns unauthenticated callers to `Sahil (Owner)` (`id: 1`, `role: "admin"`). While the production Fastify server (`server/hostinger.ts`) uses `createFastifyContext` without this fallback, any execution of `server.ts` exposes root owner privileges. | `server/_core/context.ts:27-39` | Guard the fallback in `server/_core/context.ts` with `if (process.env.NODE_ENV !== "production")` and throw 401 when running in production. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |

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
| **1. Identity & Auth** | Enterprise SSO, multi-factor auth, OIDC, RBAC | OIDC discovery with PKCE, session cookie JWT, workspace RBAC | **PARTIAL / ACTIVE-DEFECT** | Fastify runtime fail-closed; Express dev context has owner fallback (RB-12). |
| **2. Client CRM** | Auto-enrichment from web, automated KYB lookup | Manual company creation, document upload for KYB | **PARTIAL / ACTIVE-DEFECT** | Direct transition `converted → active` bypasses onboarding approval (RB-08). |
| **3. Fee Proposals** | E-signature contract execution, dynamic fee terms | Database proposal creation, acceptance tracking in DB | **PARTIAL** | DocuSign/HelloSign integration is target roadmap. |
| **4. Requirements** | ATS sync, automated JD parsing, quality scorecard | Manual job entry, scorecard sum=100 rule, client confirmation | **CURRENT-VERIFIED** | Direct XML/API job board ingestion is missing. |
| **5. Candidate ATS** | Career portal, resume ingestion, parsing, dedup | SHA-256 dedup, private doc storage, OpenRouter CV parsing | **PARTIAL / RELEASE-BLOCKED** | Ingestion/parsing verified; candidate share can be auto-approved (RB-07) and routing broken (RB-09). Public portal missing. |
| **6. Compliance** | GDPR/DPDP consent, fail-closed erasure, AV scanning | Versioned consent, fail-closed erasure, static heuristic scan | **PARTIAL** | Consent and fail-closed deletion verified; document scanner is heuristic only (no live antivirus). |
| **7. Matching** | Vector search, semantic evidence scoring, feedback loop| OpenRouter `score_match` writing evidence to `matches` table | **PARTIAL** | Evidence scoring verified; vector search and automated feedback retraining missing. |
| **8. Interviews** | Google/Outlook Calendar 2-way sync, reminders | RFC 5545 `.ics` export, reminder scanning in cron | **PARTIAL / UNWIRED** | Unwired reminder side effect (RB-05); no Google OAuth. |
| **9. Placements** | Offer tracking, guarantee tracking, replacement pipeline| Complete placement state machine and replacement approvals | **PARTIAL / ACTIVE-DEFECT** | Placement confirmation can be policy-auto-approved (RB-07). Guarantee cron missing. |
| **10. Finance** | Stripe/bank reconciliation, automated debt collection | HTML/PDF invoice generation, payment recording, disputes | **PARTIAL / UNWIRED** | Unwired invoice reconciliation side effect (RB-05). Consequential approvals can be auto-approved. |
| **11. Email / Comm**| Multi-mailbox Hostinger sync, auto-threading, cold leads| Hostinger SDK outbound, thread matching via In-Reply-To | **PARTIAL / ACTIVE-DEFECT** | Outbound providerMessageId is null; incoming replies fail thread match (RB-10). |
| **12. Queue Engine**| Distributed multi-worker queue with dead-letter queue| Single-table MySQL queue with priority, retry, backoff | **PARTIAL / UNWIRED** | 2 of 6 job handlers unwired in `queue.ts` (RB-05). |
| **13. Approval Safety**| Non-bypassable human owner approval for high-risk acts| Approval engine supports manual and policy auto-approval | **ACTIVE-DEFECT** | Consequential actions can be policy-auto-approved (RB-07). Non-atomic execution (RB-11). |
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
