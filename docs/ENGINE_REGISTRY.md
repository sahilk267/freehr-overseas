# FreelanceHR Master Engine Registry

**Document Version**: 1.0.0 (P0.2 Master Engine Registry Construction)  
**Governance Alignment**: Strictly synchronized with frozen `docs/PLATFORM_SOURCE_OF_TRUTH.md` (P0.1-F)  
**Verification Level**: Strict Repository-Audited Evidence (Zero Hallucination / Zero Speculation)  
**Last Verified Date**: 2026-09-28  

---

## 1. Executive Summary & Document Authority

### 1.1 Purpose & Authority
`docs/ENGINE_REGISTRY.md` is the canonical registry of all recognized business, platform, compliance, and automation engines comprising the FreelanceHR (FreeHR Overseas) Recruitment Operating System (ROS).

**Engine Registry Invariant**:
- The presence of an engine in this registry signifies: **"This is an acknowledged platform capability domain within the product architecture."**
- It does **NOT** imply that the engine is fully implemented or operational. Every engine possesses an explicit, evidence-backed implementation status and maturity rating.
- The repository codebase, database schemas, and test suites are the sole source of implementation truth. Under no circumstances may documentation claim an engine is operational without verifiable repository citations.

### 1.2 Status Vocabulary & Controlled Classifications
Every engine is classified using the controlled status vocabulary established in `docs/PLATFORM_SOURCE_OF_TRUTH.md`:

| Status Token | Formal Definition |
| :--- | :--- |
| **CURRENT-VERIFIED** | The specific capability exists in the repository, is wired into the runtime execution path, is supported by concrete code evidence, does not violate security/business invariants, and the claim refers specifically to the bounded capability evaluated. |
| **VERIFIED-TEST** | Verified by an automated unit, integration, or workflow test in the repository test suite that cleanly passes in Vitest. |
| **PARTIAL** | Core code exists and executes, but boundary cases, secondary paths, safety invariants, or integrations are incomplete. |
| **INCOMPLETE** | Partially drafted or scaffolded in code, but missing essential business logic or persistence. |
| **MISSING** | Required by target architecture, but has zero code, schema, or route presence in the repository. |
| **UNWIRED** | Code, schema, or prompt exists, but is disconnected from the operational event loop or domain state persistence. |
| **BLOCKED** | Implementation cannot proceed due to an internal architectural conflict or failing invariant. |
| **BLOCKED-EXTERNAL** | Requires third-party credentials, DNS records, external APIs, or SaaS provisioning to function. |
| **UNVERIFIED** | Present in code, but cannot be proven operational without live external infrastructure or mocks. |
| **TARGET** | Intended product roadmap capability; explicitly NOT implemented in the current repository. |
| **PLANNED** | Scheduled for implementation in an upcoming sprint or migration phase. |
| **DEPRECATED** | Obsolete code or legacy pattern slated for removal; must not be extended. |
| **RESOLVED** | Previously identified defect or blocker that has been fully mitigated and verified by tests. |
| **ACTIVE-DEFECT** | Code contains a proven bug, security bypass, or data integrity flaw requiring immediate remediation. |
| **RELEASE-BLOCKER** | Critical defect, security bypass, or unwired core capability that prohibits production release until remediated. |

### 1.3 Engine Maturity Model (Supplementary Rating)
In addition to the operational status token, each engine is assigned an architectural maturity level:

| Level | Rating | Definition |
| :---: | :--- | :--- |
| **LEVEL 0** | **TARGET ONLY** | Conceptual product capability; no codebase, schema, or API presence. |
| **LEVEL 1** | **DEFINED** | Documented with schemas, enums, or prompt templates drafted, but no operational runtime execution. |
| **LEVEL 2** | **PARTIAL IMPLEMENTATION** | Runtime code exists, but secondary flows, transaction safety, or integration handlers are missing or broken. |
| **LEVEL 3** | **IMPLEMENTED** | Core runtime capabilities execute cleanly end-to-end within the application execution graph. |
| **LEVEL 4** | **VERIFIED** | Fully implemented and validated with automated test suites (unit, integration, or workflow tests). |
| **LEVEL 5** | **PRODUCTION READY** | Implementation, test verification, and all external production dependencies and security gates are satisfied. |

---

## 2. Core Governance & Authority Boundaries

The engine architecture adheres strictly to the 5-Layer Governance Model established in `docs/PLATFORM_SOURCE_OF_TRUTH.md`:

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

**Non-Negotiable Architectural Invariants**:
1. **AI Engines Are NOT Business-State Owners**: AI models provide extraction, semantic scoring, drafting, and reply sentiment classification. They are strictly advisory and are prohibited from directly mutating domain business states, granting consents, or approving actions.
2. **Policy Engines Do NOT Grant Approval**: Policy engines enforce negative guardrails (e.g. daily outbound caps, quiet hours, emergency stop). Policy rules must never bypass mandatory human owner review for consequential actions.
3. **Automation Engines Do NOT Self-Authorize**: Queue workers and scheduled cron tasks execute pre-authorized jobs; they do not possess autonomous authority to approve consequential domain transitions.
4. **Domain Engines Own Authoritative State**: Business state mutations belong exclusively to their respective domain engines (e.g. Job Engine owns job states, Placement Engine owns placement states, Invoicing Engine owns invoice states).

---

## 3. High-Level Engine Dependency Graph

The 15 engine domains interact across structured dependency layers:

```
[PLATFORM & INFRASTRUCTURE] (Database, Storage, API, Logging, Health)
         │
         ▼
[IDENTITY & ORGANIZATION] (Identity, Auth, Workspace, Team RBAC, Session)
         │
         ├───────────────────────────────────────────┐
         ▼                                           ▼
[CLIENT ACQUISITION] (Company, Contact, KYB)    [RECRUITER WORKSPACE]
         │                                           │
         ▼                                           ▼
[COMMERCIAL] (Fee Proposals, Terms)             [CANDIDATE OS] (Ingestion, Parse, Consent, DNC)
         │                                           │
         ▼                                           ▼
[JOB / REQUIREMENT] (Intake, Scorecard=100)     [RECRUITMENT PIPELINE] (Match, Screen, Shortlist)
         │                                           │
         └─────────────────────┬─────────────────────┘
                               ▼
                    [INTERVIEWS & OUTREACH] (ICS Calendar, Hostinger Mail SDK)
                               │
                               ▼
                    [CONSEQUENTIAL ACTIONS] (Placement Confirmation, Replacements)
                               │
                               ▼
                    [FINANCE] (Invoicing, PDF Generation, Payment Recording)
                               │
                               ▼
                    [AUDIT & COMPLIANCE] (Append-only Audit Events, Fail-Closed Deletion)
```

Cross-Cutting Layers:
- **AI Intelligence Layer** (OpenRouter Gateway, CV Parsing, Semantic Matching, Reply Classification) feeds into Candidate, Matching, and Outreach engines.
- **Automation Layer** (Fastify CRON_SECRET Scheduler, Priority Queue, Emergency Stop) drives background parsing, reminder scanning, and queue execution.
- **Policy & Approval Layer** governs transitions across Client Onboarding, Candidate Sharing, Placements, Replacements, and Invoices.

---

## 4. Master Engine Registry Table (All 129 Engines)

The table below catalogs all 129 engines across the 15 platform domains, identifying their classification, maturity, status, authoritative business-state owner, and primary dependencies.

| ID | Domain | Engine Name | Type | Maturity | Status | Business State Owner | Dependencies |
| :--- | :--- | :--- | :--- | :---: | :--- | :--- | :--- |
| **ENG-001** | Identity & Org | Identity Engine | PLATFORM | LEVEL 3 | CURRENT-VERIFIED | `users` Table | DB, Auth |
| **ENG-002** | Identity & Org | Authentication Engine | PLATFORM | LEVEL 2 | ACTIVE-DEFECT / RELEASE-BLOCKER | OIDC / Session State | Fastify OIDC, RuntimeAuth (RB-12) |
| **ENG-003** | Identity & Org | Authorization Engine | PLATFORM | LEVEL 4 | VERIFIED-TEST | Workspace RBAC Matrix | WorkspaceAccess, TeamMembers |
| **ENG-004** | Identity & Org | Workspace / Tenant Engine | PLATFORM | LEVEL 3 | CURRENT-VERIFIED | `workspaceSettings` Table | DB, Identity |
| **ENG-005** | Identity & Org | Team / RBAC Engine | BUSINESS | LEVEL 4 | CURRENT-VERIFIED | `teamMembers`, `teamInvitations` | Email Engine, DB |
| **ENG-006** | Identity & Org | Session Engine | PLATFORM | LEVEL 3 | CURRENT-VERIFIED | Encrypted JWT Cookie | Fastify Cookie Plugin |
| **ENG-007** | Client Acquisition | Prospect Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `companies` (`prospect`) | DB, Audit |
| **ENG-008** | Client Acquisition | Lead Engine | BUSINESS | LEVEL 1 | TARGET / MISSING | `companies.hiringSignal` | Web Scraping (Missing) |
| **ENG-009** | Client Acquisition | Company Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `companies` Table | DB, Workflow |
| **ENG-010** | Client Acquisition | Contact Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `contacts` Table | SHA-256 Hasher, DB |
| **ENG-011** | Client Acquisition | Client Verification / KYB Engine | COMPLIANCE | LEVEL 3 | CURRENT-VERIFIED | `companies.verificationState` | PrivateStorage, Company Engine |
| **ENG-012** | Client Acquisition | Client Onboarding Engine | BUSINESS | LEVEL 2 | ACTIVE-DEFECT / RELEASE-BLOCKER | `companies.pipelineState` | Approval Engine (RB-08) |
| **ENG-013** | Client Acquisition | Client CRM / Relationship Engine | BUSINESS | LEVEL 2 | PARTIAL | `companies` State Machine | Company Engine, Contacts |
| **ENG-014** | Commercial | Commercial Agreement Engine | BUSINESS | LEVEL 2 | PARTIAL | `feeProposals` Table | Company Engine, DB |
| **ENG-015** | Commercial | Pricing Engine | BUSINESS | LEVEL 2 | PARTIAL | `feeProposals`, `placements` | Fee Calculations |
| **ENG-016** | Commercial | Commission Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | Placement Engine |
| **ENG-017** | Commercial | Contract / Terms Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | E-Signature Provider (Missing) |
| **ENG-018** | Commercial | Billing Terms Engine | BUSINESS | LEVEL 2 | PARTIAL | `feeProposals.paymentTermsDays` | Fee Proposals, Invoicing |
| **ENG-019** | Job / Requirement | Job Intake Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `jobs` Table | Company Engine, DB |
| **ENG-020** | Job / Requirement | Job Quality Engine | BUSINESS | LEVEL 4 | CURRENT-VERIFIED | `jobs.scorecardWeights` | Scorecard Sum Rule (=100) |
| **ENG-021** | Job / Requirement | Job Validation Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | Job Zod Schemas | Input Validation |
| **ENG-022** | Job / Requirement | Job Approval Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `jobs.approvedAt` | Client Confirmation Gate |
| **ENG-023** | Job / Requirement | Job Publication Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | Public Job Boards (Missing) |
| **ENG-024** | Job / Requirement | Job Lifecycle Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `jobs.state` | Workflow Engine |
| **ENG-025** | Job / Requirement | SLA Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | Job Lifecycle |
| **ENG-026** | Candidate | Candidate Acquisition Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `candidates` Table | DB, Workspace |
| **ENG-027** | Candidate | Candidate Identity Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `candidates` Table | Deduplication Engine |
| **ENG-028** | Candidate | Candidate Deduplication Engine | BUSINESS | LEVEL 4 | CURRENT-VERIFIED | SHA-256 Email/Phone Hashes | SHA-256 Hasher, DB |
| **ENG-029** | Candidate | Candidate Profile Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `candidates` Metadata | CV Parsing, DB |
| **ENG-030** | Candidate | Candidate Document Engine | PLATFORM | LEVEL 4 | VERIFIED-TEST | `candidateDocuments` Table | PrivateStorage Engine |
| **ENG-031** | Candidate | Resume Parsing Engine | AI | LEVEL 4 | CURRENT-VERIFIED | `candidateDocuments.parseState` | OpenRouter, Automation Queue |
| **ENG-032** | Candidate | Candidate Enrichment Engine | AI | LEVEL 0 | TARGET / MISSING | None (Missing) | External Enrichers (Missing) |
| **ENG-033** | Candidate | Consent Engine | COMPLIANCE | LEVEL 3 | CURRENT-VERIFIED | `consents` Table | Versioned Consent Ledger |
| **ENG-034** | Candidate | Candidate Compliance Engine | COMPLIANCE | LEVEL 4 | VERIFIED-TEST | `candidates.profileState` | Fail-Closed Erasure, Storage |
| **ENG-035** | Candidate | Suppression / DNC Engine | COMPLIANCE | LEVEL 4 | CURRENT-VERIFIED | `suppressionList` Table | Pre-flight Dispatch Check |
| **ENG-036** | Candidate | Candidate Ownership Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `candidates.ownerId` | Workspace Engine |
| **ENG-037** | Recruitment | Sourcing Engine | BUSINESS | LEVEL 2 | PARTIAL | Candidate Pipeline | Candidate Search |
| **ENG-038** | Recruitment | Matching Engine | INTELLIGENCE | LEVEL 3 | PARTIAL | `matches` Table | Score Match AI, Job Engine |
| **ENG-039** | Recruitment | Screening Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `screenings` Table | Candidate Engine, Workflow |
| **ENG-040** | Recruitment | Shortlist Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `shortlists` Table | Screening Engine |
| **ENG-041** | Recruitment | Candidate Share Engine | BUSINESS | LEVEL 2 | ACTIVE-DEFECT / RELEASE-BLOCKER | `shortlists.sharedAt` | Approval Engine (RB-07, RB-09) |
| **ENG-042** | Recruitment | Outreach Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `messages.status = "draft_ready"` | AI Drafting, Suppression |
| **ENG-043** | Recruitment | Communication Engine | BUSINESS | LEVEL 2 | PARTIAL | `conversations`, `messages` | Email Engine |
| **ENG-044** | Recruitment | Interview Engine | BUSINESS | LEVEL 4 | CURRENT-VERIFIED | `interviews` Table | Calendar Engine (RFC 5545) |
| **ENG-045** | Recruitment | Feedback Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `feedback` Table | Interview Engine |
| **ENG-046** | Recruitment | Offer Engine | BUSINESS | LEVEL 2 | PARTIAL | `placements.state` | Placement Engine |
| **ENG-047** | Recruitment | Placement Engine | BUSINESS | LEVEL 2 | ACTIVE-DEFECT / RELEASE-BLOCKER | `placements` Table | Approval Engine (RB-07, RB-09) |
| **ENG-048** | Recruitment | Joining Confirmation Engine | BUSINESS | LEVEL 2 | PARTIAL | `placements.state` | Placement Confirmation |
| **ENG-049** | Recruitment | Replacement Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `placements.state` | Consequential Router |
| **ENG-050** | Recruitment | Guarantee Engine | BUSINESS | LEVEL 2 | PARTIAL | `placements.guaranteeEndDate` | Placement Engine |
| **ENG-051** | Finance | Invoice Engine | BUSINESS | LEVEL 4 | CURRENT-VERIFIED | `invoices` Table | Invoicing Service, DB |
| **ENG-052** | Finance | Payment Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `payments` Table | Invoicing Engine, DB |
| **ENG-053** | Finance | Receivable Engine | BUSINESS | LEVEL 2 | PARTIAL | `invoices.status` | Invoices Table |
| **ENG-054** | Finance | Dispute Engine | BUSINESS | LEVEL 2 | PARTIAL / ACTIVE-DEFECT | `invoices.status = "disputed"` | Consequential Router (RB-07) |
| **ENG-055** | Finance | Credit Engine | BUSINESS | LEVEL 2 | PARTIAL / ACTIVE-DEFECT | `invoices.status = "credited"` | Consequential Router (RB-07) |
| **ENG-056** | Finance | Write-off Engine | BUSINESS | LEVEL 1 | INCOMPLETE / ACTIVE-DEFECT | `invoices.status = "written_off"`| Consequential Router (RB-09) |
| **ENG-057** | Finance | Revenue Engine | BUSINESS | LEVEL 2 | PARTIAL | Dashboard Aggregates | Invoices, Payments |
| **ENG-058** | Finance | Recruiter Commission Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | Placement Engine |
| **ENG-059** | Finance | Recruiter Payout Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | Payment Gateway (Missing) |
| **ENG-060** | Compliance / Risk | Compliance Rule Engine | COMPLIANCE | LEVEL 4 | CURRENT-VERIFIED | AI Safety Rails | ensureSafeAiText (Workflow) |
| **ENG-061** | Compliance / Risk | Privacy Engine | COMPLIANCE | LEVEL 4 | VERIFIED-TEST | `rightsRequests` Table | Fail-Closed Physical Deletion |
| **ENG-062** | Compliance / Risk | Data Retention Engine | COMPLIANCE | LEVEL 1 | TARGET / MISSING | Retention Config | Automated Purging Cron (Missing) |
| **ENG-063** | Compliance / Risk | Consent Evidence Engine | COMPLIANCE | LEVEL 3 | CURRENT-VERIFIED | `consents` Table | Audit Trail |
| **ENG-064** | Compliance / Risk | Audit Engine | PLATFORM | LEVEL 4 | CURRENT-VERIFIED | `auditEvents` Table | Append-only DB Logging |
| **ENG-065** | Compliance / Risk | Fraud / Risk Engine | COMPLIANCE | LEVEL 2 | PARTIAL | Heuristic Scanner | Document Scanner |
| **ENG-066** | Compliance / Risk | Anti-Poaching Engine | COMPLIANCE | LEVEL 0 | TARGET / MISSING | None (Missing) | Candidate Placements |
| **ENG-067** | Compliance / Risk | SLA Breach Engine | COMPLIANCE | LEVEL 0 | TARGET / MISSING | None (Missing) | Job / Interview Timers |
| **ENG-068** | Compliance / Risk | Incident Engine | PLATFORM | LEVEL 3 | CURRENT-VERIFIED | `incidents` Table | Operations Router |
| **ENG-069** | Communication | Email Engine | INTEGRATION | LEVEL 2 | PARTIAL / ACTIVE-DEFECT | `messages` Table | Hostinger SDK (RB-10) |
| **ENG-070** | Communication | Inbound Email Engine | INTEGRATION | LEVEL 4 | VERIFIED-TEST | `messages`, `incidents` | Fastify Webhook Handler |
| **ENG-071** | Communication | Conversation Engine | BUSINESS | LEVEL 2 | PARTIAL / ACTIVE-DEFECT | `conversations` Table | Thread Matcher (RB-10) |
| **ENG-072** | Communication | Notification Engine | BUSINESS | LEVEL 2 | PARTIAL | Exception Alerts | Incident Router |
| **ENG-073** | Communication | Reminder Engine | AUTOMATION | LEVEL 2 | UNWIRED / RELEASE-BLOCKER | `automationQueue` Jobs | Queue Handler (RB-05) |
| **ENG-074** | Communication | Template Engine | BUSINESS | LEVEL 2 | PARTIAL | Hardcoded Templates | Email Dispatch |
| **ENG-075** | Communication | Message Approval Engine | BUSINESS | LEVEL 3 | CURRENT-VERIFIED | `messages.status` | Outbound Approval Router |
| **ENG-076** | Automation | Scheduler Engine | AUTOMATION | LEVEL 4 | VERIFIED-TEST | Fastify Cron Routes | `CRON_SECRET`, timingSafeEqual |
| **ENG-077** | Automation | Automation Queue Engine | AUTOMATION | LEVEL 3 | PARTIAL / UNWIRED | `automationQueue` Table | Queue Service (RB-05) |
| **ENG-078** | Automation | Retry Engine | AUTOMATION | LEVEL 4 | CURRENT-VERIFIED | `automationQueue.retryCount` | Exponential Backoff Worker |
| **ENG-079** | Automation | Idempotency Engine | AUTOMATION | LEVEL 3 | CURRENT-VERIFIED | Queue Unique Keys | DB Unique Indices |
| **ENG-080** | Automation | Workflow Engine | AUTOMATION | LEVEL 3 | PARTIAL | `transitions` Maps | workflow.ts (RB-08) |
| **ENG-081** | Automation | Event Engine | AUTOMATION | LEVEL 0 | TARGET / MISSING | None (Missing) | Event Bus (Missing) |
| **ENG-082** | Automation | Emergency Stop Engine | AUTOMATION | LEVEL 4 | CURRENT-VERIFIED | `workspaceSettings.emergencyStop` | Queue Worker Check |
| **ENG-083** | AI | AI Gateway Engine | AI | LEVEL 4 | CURRENT-VERIFIED | OpenRouter Client | `server/services/openrouter.ts` |
| **ENG-084** | AI | AI Model Router Engine | AI | LEVEL 4 | CURRENT-VERIFIED | Model Selector | `server/services/aiRouting.ts` |
| **ENG-085** | AI | CV Intelligence Engine | AI | LEVEL 4 | CURRENT-VERIFIED | CV Extraction JSON | OpenRouter `parse_cv` |
| **ENG-086** | AI | Job Intelligence Engine | AI | LEVEL 0 | TARGET / MISSING | None (Missing) | OpenRouter JD Generator |
| **ENG-087** | AI | Candidate Matching Intelligence Engine | AI | LEVEL 3 | CURRENT-VERIFIED | `matches` Evidence Scores | OpenRouter `score_match` |
| **ENG-088** | AI | Screening Intelligence Engine | AI | LEVEL 0 | TARGET / MISSING | None (Missing) | AI Screening Drafter |
| **ENG-089** | AI | Outreach Intelligence Engine | AI | LEVEL 3 | CURRENT-VERIFIED | Outreach Draft Text | OpenRouter `draft_outreach` |
| **ENG-090** | AI | Reply Classification Engine | AI | LEVEL 4 | CURRENT-VERIFIED | Sentiment & Opt-Out Tag | OpenRouter `classify_reply` |
| **ENG-091** | AI | Interview Intelligence Engine | AI | LEVEL 1 | UNWIRED / RELEASE-BLOCKER | Reminder Draft Text | OpenRouter `send_reminder` (RB-05) |
| **ENG-092** | AI | Invoice Intelligence Engine | AI | LEVEL 1 | UNWIRED / RELEASE-BLOCKER | Invoice Reconciliation | OpenRouter `reconcile_invoice` (RB-05) |
| **ENG-093** | AI | Recruitment Analytics Intelligence Engine | AI | LEVEL 0 | TARGET / MISSING | None (Missing) | Predictive Analytics |
| **ENG-094** | Platform / Infra | Database Engine | INFRASTRUCTURE | LEVEL 4 | VERIFIED-TEST | MySQL 8.0 Connection Pool | Drizzle ORM, Startup Ping |
| **ENG-095** | Platform / Infra | Migration Engine | INFRASTRUCTURE | LEVEL 3 | CURRENT-VERIFIED | Drizzle Migration Journal | Drizzle Kit |
| **ENG-096** | Platform / Infra | Storage Engine | INFRASTRUCTURE | LEVEL 4 | VERIFIED-TEST | Private Storage Filesystem/S3 | `privateStorage.ts` |
| **ENG-097** | Platform / Infra | Document Scan Engine | PLATFORM | LEVEL 4 | PARTIAL | Document Scan Metadata | `documentScanner.ts` (Heuristic) |
| **ENG-098** | Platform / Infra | Search Engine | PLATFORM | LEVEL 2 | PARTIAL | SQL Queries | MySQL LIKE / Indices |
| **ENG-099** | Platform / Infra | API Engine | PLATFORM | LEVEL 4 | CURRENT-VERIFIED | tRPC Route Graph | tRPC v11, Zod |
| **ENG-100** | Platform / Infra | Error Handling Engine | PLATFORM | LEVEL 3 | CURRENT-VERIFIED | TRPCError & Fastify Handlers | Error Sanitizers |
| **ENG-101** | Platform / Infra | Logging Engine | PLATFORM | LEVEL 3 | CURRENT-VERIFIED | Fastify Pino Logger | Console / Standard Output |
| **ENG-102** | Platform / Infra | Health / Readiness Engine | INFRASTRUCTURE | LEVEL 4 | VERIFIED-TEST | Health Route `/healthz` | Startup Ping `SELECT 1` |
| **ENG-103** | Platform / Infra | Backup / Recovery Engine | INFRASTRUCTURE | LEVEL 0 | TARGET / UNVERIFIED | Database Dumps | Hostinger Backups |
| **ENG-104** | Platform / Infra | Deployment Engine | INFRASTRUCTURE | LEVEL 4 | CURRENT-VERIFIED | Build Artifacts (`dist/`) | `build-hostinger.mjs`, Fastify |
| **ENG-105** | Platform / Infra | Integration Engine | INTEGRATION | LEVEL 2 | PARTIAL / UNVERIFIED | External API Clients | Hostinger SDK, OpenRouter |
| **ENG-106** | Recruiter Marketplace | Recruiter Marketplace Engine | MARKETPLACE | LEVEL 0 | TARGET / MISSING | None (Missing) | Marketplace Tables (Missing) |
| **ENG-107** | Recruiter Marketplace | Recruiter Profile Engine | MARKETPLACE | LEVEL 0 | TARGET / MISSING | None (Missing) | Recruiter Profiles (Missing) |
| **ENG-108** | Recruiter Marketplace | Recruiter Verification Engine | MARKETPLACE | LEVEL 0 | TARGET / MISSING | None (Missing) | Recruiter KYC (Missing) |
| **ENG-109** | Recruiter Marketplace | Recruiter Assignment Engine | MARKETPLACE | LEVEL 0 | TARGET / MISSING | None (Missing) | Job Requisition Sharing (Missing) |
| **ENG-110** | Recruiter Marketplace | Recruiter Rating Engine | MARKETPLACE | LEVEL 0 | TARGET / MISSING | None (Missing) | Performance Metrics (Missing) |
| **ENG-111** | Recruiter Marketplace | Recruiter Commission Engine (Marketplace) | MARKETPLACE | LEVEL 0 | TARGET / MISSING | None (Missing) | Commission Ledger (Missing) |
| **ENG-112** | Recruiter Marketplace | Recruiter Payout Engine (Marketplace) | MARKETPLACE | LEVEL 0 | TARGET / MISSING | None (Missing) | Automated Payouts (Missing) |
| **ENG-113** | Recruiter Marketplace | Marketplace Anti-Poaching Engine | MARKETPLACE | LEVEL 0 | TARGET / MISSING | None (Missing) | Anti-Poaching Rules (Missing) |
| **ENG-114** | International Recr. | Country Rule Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | Country Compliance DB (Missing) |
| **ENG-115** | International Recr. | Visa / Work Permit Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | Visa Trackers (Missing) |
| **ENG-116** | International Recr. | International Compliance Engine | COMPLIANCE | LEVEL 0 | TARGET / MISSING | None (Missing) | Cross-border Rules (Missing) |
| **ENG-117** | International Recr. | Overseas Employer Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | Overseas KYB (Missing) |
| **ENG-118** | International Recr. | Overseas Candidate Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | Emigration Clearance (Missing) |
| **ENG-119** | International Recr. | Agency Compliance Engine | COMPLIANCE | LEVEL 0 | TARGET / MISSING | None (Missing) | Partner Agency Rules (Missing) |
| **ENG-120** | International Recr. | Country Document Engine | PLATFORM | LEVEL 0 | TARGET / MISSING | None (Missing) | Document Checklists (Missing) |
| **ENG-121** | Growth / Marketing | Market Intelligence Engine | INTELLIGENCE | LEVEL 0 | TARGET / MISSING | None (Missing) | Salary Benchmarking (Missing) |
| **ENG-122** | Growth / Marketing | Content Intelligence Engine | AI | LEVEL 0 | TARGET / MISSING | None (Missing) | Content Generator (Missing) |
| **ENG-123** | Growth / Marketing | SEO Intelligence Engine | INTELLIGENCE | LEVEL 0 | TARGET / MISSING | None (Missing) | Keyword Research (Missing) |
| **ENG-124** | Growth / Marketing | Social Publishing Engine | INTEGRATION | LEVEL 0 | TARGET / MISSING | None (Missing) | LinkedIn/Twitter OAuth (Missing) |
| **ENG-125** | Growth / Marketing | Social Engagement Engine | INTEGRATION | LEVEL 0 | TARGET / MISSING | None (Missing) | Social Webhooks (Missing) |
| **ENG-126** | Growth / Marketing | Lead Generation Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | Apollo/Scraping APIs (Missing) |
| **ENG-127** | Growth / Marketing | Campaign Engine | BUSINESS | LEVEL 0 | TARGET / MISSING | None (Missing) | Drip Sequences (Missing) |
| **ENG-128** | Growth / Marketing | Attribution Engine | INTELLIGENCE | LEVEL 0 | TARGET / MISSING | None (Missing) | UTM / Conversion Trackers (Missing)|
| **ENG-129** | Growth / Marketing | Growth Analytics Engine | INTELLIGENCE | LEVEL 0 | TARGET / MISSING | None (Missing) | Growth Dashboards (Missing) |

---

## 5. Domain-by-Domain Engine Profiles (Active & Partial Engines)

### 5.1 Domain A: Identity & Organization
- **ENG-001 (Identity Engine)**: Owns user accounts (`users` table). Resolves user OpenID and system roles. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-002 (Authentication Engine)**: Manages login sessions. Production uses Fastify OIDC with PKCE. Express dev context unconditionally assigns root owner (`Sahil (Owner)`) to unauthenticated callers (RB-12). Status: `ACTIVE-DEFECT / RELEASE-BLOCKER` (Maturity 2).
- **ENG-003 (Authorization Engine)**: Enforces role-based permissions (`workspaceAccess.ts`). Tested via `workspaceAccess.test.ts` (14 passing tests). Status: `VERIFIED-TEST` (Maturity 4).
- **ENG-004 (Workspace / Tenant Engine)**: Scopes data to workspace owners (`workspaceSettings`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-005 (Team / RBAC Engine)**: Manages team invitations and member roles (`teamMembers`, `teamInvitations`, `team.ts`). Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-006 (Session Engine)**: Issues signed `__Host-fh_session` JWT cookies. Status: `CURRENT-VERIFIED` (Maturity 3).

### 5.2 Domain B: Client Acquisition
- **ENG-007 (Prospect Engine)**: Manages prospect accounts (`companies` where `companyType = 'prospect'`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-008 (Lead Engine)**: Captures hiring intent signals. Target automated web scrapers do not exist. Status: `TARGET / MISSING` (Maturity 1).
- **ENG-009 (Company Engine)**: Manages core company CRM records (`companies`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-010 (Contact Engine)**: Manages client decision-makers with SHA-256 deduplicated email/phone hashes (`contacts`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-011 (Client Verification / KYB Engine)**: Handles registration proof and tax document uploads to private storage (`companies.verificationState`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-012 (Client Onboarding Engine)**: Governs transition of prospective companies to active clients. Active defect RB-08 allows direct transition `converted → active` via `prospects.transition` without required approval. Status: `ACTIVE-DEFECT / RELEASE-BLOCKER` (Maturity 2).
- **ENG-013 (Client CRM / Relationship Engine)**: Handles client relationship history and contact logs. Status: `PARTIAL` (Maturity 2).

### 5.3 Domain C: Commercial
- **ENG-014 (Commercial Agreement Engine)**: Tracks fee proposals in database (`feeProposals`). Digital e-signature integration is missing. Status: `PARTIAL` (Maturity 2).
- **ENG-015 (Pricing Engine)**: Validates percentage fees and minimum placement charges. Status: `PARTIAL` (Maturity 2).
- **ENG-016 (Commission Engine)**: Recruiter commission tracking. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-017 (Contract / Terms Engine)**: Digital contract management. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-018 (Billing Terms Engine)**: Configures credit days and due dates. Status: `PARTIAL` (Maturity 2).

### 5.4 Domain D: Job / Requirement
- **ENG-019 (Job Intake Engine)**: Ingests job requisitions (`jobs`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-020 (Job Quality Engine)**: Validates that scorecard criterion weights sum exactly to 100 points (`jobs.ts`). Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-021 (Job Validation Engine)**: Enforces salary boundaries, workplace type, and location validity. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-022 (Job Approval Engine)**: Enforces mandatory `clientConfirmedBy` email before transitioning from draft to approved. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-023 (Job Publication Engine)**: Syndication to external job portals. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-024 (Job Lifecycle Engine)**: Governs state transitions across job pipeline (`workflow.ts`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-025 (SLA Engine)**: Tracks requisition time-to-fill SLAs. Status: `TARGET / MISSING` (Maturity 0).

### 5.5 Domain E: Candidate
- **ENG-026 (Candidate Acquisition Engine)**: Ingests candidate profiles into `candidates`. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-027 (Candidate Identity Engine)**: Manages candidate identifiers and metadata. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-028 (Candidate Deduplication Engine)**: Computes SHA-256 hashes of email and phone to prevent duplicate ingestion. Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-029 (Candidate Profile Engine)**: Manages resume summary, skills, experience years, and headline. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-030 (Candidate Document Engine)**: Stores CVs and certificates in private storage with workspace isolation. Status: `VERIFIED-TEST` (Maturity 4).
- **ENG-031 (Resume Parsing Engine)**: AI queue worker parses CV text via OpenRouter into structured JSON and updates document state. Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-032 (Candidate Enrichment Engine)**: Enriches candidate social/GitHub data. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-033 (Consent Engine)**: Records versioned candidate processing consent (`consents`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-034 (Candidate Compliance Engine)**: Enforces statutory erasure (GDPR/DPDP) with fail-closed physical document deletion before database redaction. Status: `VERIFIED-TEST` (Maturity 4).
- **ENG-035 (Suppression / DNC Engine)**: Automatically cascades consent withdrawals to `suppressionList` and performs pre-flight checks on outbound email. Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-036 (Candidate Ownership Engine)**: Restricts candidate data access by workspace owner. Status: `CURRENT-VERIFIED` (Maturity 3).

### 5.6 Domain F: Recruitment
- **ENG-037 (Sourcing Engine)**: Searches internal database for candidate pools. Status: `PARTIAL` (Maturity 2).
- **ENG-038 (Matching Engine)**: Scores candidates against jobs using rule weights and semantic AI evaluation (`matches`). Vector search is missing. Status: `PARTIAL` (Maturity 3).
- **ENG-039 (Screening Engine)**: Tracks recruiter screening stages and notes (`screenings`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-040 (Shortlist Engine)**: Generates shortlists for client presentation (`shortlists`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-041 (Candidate Share Engine)**: Governs candidate profile sharing. Affected by auto-approval defect RB-07 and consequential router omission RB-09. Status: `ACTIVE-DEFECT / RELEASE-BLOCKER` (Maturity 2).
- **ENG-042 (Outreach Engine)**: AI drafts cold outreach with mandatory opt-out clauses; stored as `draft_ready` awaiting human approval. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-043 (Communication Engine)**: Cross-channel messaging abstraction (currently email-only). Status: `PARTIAL` (Maturity 2).
- **ENG-044 (Interview Engine)**: Coordinates interviews, exports RFC 5545 `.ics` calendar files, and maintains calendar feeds (`calendar.ts`). Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-045 (Feedback Engine)**: Captures structured interview feedback and scores (`feedback`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-046 (Offer Engine)**: Tracks job offers extended to candidates. Status: `PARTIAL` (Maturity 2).
- **ENG-047 (Placement Engine)**: Governs placement records (`placements`). Placement confirmation approval can be auto-approved (RB-07) and routing broken (RB-09). Status: `ACTIVE-DEFECT / RELEASE-BLOCKER` (Maturity 2).
- **ENG-048 (Joining Confirmation Engine)**: Validates actual candidate joining date. Status: `PARTIAL` (Maturity 2).
- **ENG-049 (Replacement Engine)**: Opens replacement cases when placed candidates leave during guarantee (`consequentialRouter.requestReplacement`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-050 (Guarantee Engine)**: Calculates guarantee start/end dates. Automatic expiration background cron is missing. Status: `PARTIAL` (Maturity 2).

### 5.7 Domain G: Finance
- **ENG-051 (Invoice Engine)**: Calculates fees and taxes, generates HTML/PDF invoices (`server/services/invoicing.ts`). Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-052 (Payment Engine)**: Records bank transfer and payment gateway events (`payments`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-053 (Receivable Engine)**: Monitors payment aging and overdue invoices. Status: `PARTIAL` (Maturity 2).
- **ENG-054 (Dispute Engine)**: Records client invoice disputes via consequential approval router. Subject to RB-07 auto-approval defect. Status: `PARTIAL / ACTIVE-DEFECT` (Maturity 2).
- **ENG-055 (Credit Engine)**: Issues credit notes via consequential approval router. Subject to RB-07 auto-approval defect. Status: `PARTIAL / ACTIVE-DEFECT` (Maturity 2).
- **ENG-056 (Write-off Engine)**: Bad debt write-offs. Defined in `workflow.ts` but missing in approval and consequential routers (RB-09). Status: `INCOMPLETE / ACTIVE-DEFECT` (Maturity 1).
- **ENG-057 (Revenue Engine)**: Computes realized recruitment revenue in dashboard KPIs. Status: `PARTIAL` (Maturity 2).
- **ENG-058 (Recruiter Commission Engine)**: Computes recruiter commission splits. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-059 (Recruiter Payout Engine)**: Disburses freelance recruiter payments. Status: `TARGET / MISSING` (Maturity 0).

### 5.8 Domain H: Compliance / Risk
- **ENG-060 (Compliance Rule Engine)**: Content safety filter rejects inputs containing protected recruitment traits (`workflow.ts:ensureSafeAiText`). Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-061 (Privacy Engine)**: Processes statutory erasure requests with fail-closed physical document deletion. Status: `VERIFIED-TEST` (Maturity 4).
- **ENG-062 (Data Retention Engine)**: Retention duration policies defined; automated data purge cron is missing. Status: `TARGET / MISSING` (Maturity 1).
- **ENG-063 (Consent Evidence Engine)**: Maintains versioned consent records and audit logs. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-064 (Audit Engine)**: Appends immutable evidentiary audit records (`auditEvents`, `recordAudit`). Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-065 (Fraud / Risk Engine)**: Performs static byte signature and header checks on uploaded files (`documentScanner.ts`). Live antivirus daemon is missing. Status: `PARTIAL` (Maturity 2).
- **ENG-066 (Anti-Poaching Engine)**: Prevents recruiting client staff. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-067 (SLA Breach Engine)**: Emits breach alerts for overdue SLA milestones. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-068 (Incident Engine)**: Traps delivery failures and unmatched webhook messages in `incidents`. Status: `CURRENT-VERIFIED` (Maturity 3).

### 5.9 Domain I: Communication
- **ENG-069 (Email Engine)**: Transports outbound emails via Hostinger Mail API SDK. Outbound `providerMessageId` hardcoded `null` prevents inbound correlation (RB-10). Status: `PARTIAL / ACTIVE-DEFECT` (Maturity 2).
- **ENG-070 (Inbound Email Engine)**: Ingests incoming emails via Fastify webhook with timing-safe authorization (`timingSafeEqual`). Status: `VERIFIED-TEST` (Maturity 4).
- **ENG-071 (Conversation Engine)**: Tracks email threads (`conversations`, `messages`). Broken for live replies due to null outbound message IDs (RB-10). Status: `PARTIAL / ACTIVE-DEFECT` (Maturity 2).
- **ENG-072 (Notification Engine)**: Alerts team members of new incidents or tasks. Status: `PARTIAL` (Maturity 2).
- **ENG-073 (Reminder Engine)**: Scans due interview reminders, enqueues `send_reminder`, but task result handler is unwired in `queue.ts` (RB-05). Status: `UNWIRED / RELEASE-BLOCKER` (Maturity 2).
- **ENG-074 (Template Engine)**: Formats email body content. Status: `PARTIAL` (Maturity 2).
- **ENG-075 (Message Approval Engine)**: Enforces human review before outbound dispatch (`outbound.deliverApproved`). Status: `CURRENT-VERIFIED` (Maturity 3).

### 5.10 Domain J: Automation
- **ENG-076 (Scheduler Engine)**: Scheduled cron triggers via Fastify routes requiring `CRON_SECRET` verified with `timingSafeEqual`. Status: `VERIFIED-TEST` (Maturity 4).
- **ENG-077 (Automation Queue Engine)**: Prioritized background task queue (`automationQueue`). 4 of 6 job handlers wired; `send_reminder` and `reconcile_invoice` unwired (RB-05). Status: `PARTIAL / UNWIRED` (Maturity 3).
- **ENG-078 (Retry Engine)**: Handles failed queue tasks with exponential backoff. Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-079 (Idempotency Engine)**: Prevents duplicate queue execution and webhook processing. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-080 (Workflow Engine)**: Enforces valid state transitions via `assertTransition()`. Direct mutation bypasses exist in specific routers (RB-08). Status: `PARTIAL` (Maturity 3).
- **ENG-081 (Event Engine)**: Cross-domain pub/sub event bus. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-082 (Emergency Stop Engine)**: Halts queue execution when `workspaceSettings.emergencyStop` is enabled. Status: `CURRENT-VERIFIED` (Maturity 4).

### 5.11 Domain K: AI
- **ENG-083 (AI Gateway Engine)**: OpenRouter API adapter with JSON schema validation. Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-084 (AI Model Router Engine)**: Routes requests with preference for `manus-1.6-lite` and fallback to OpenRouter. Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-085 (CV Intelligence Engine)**: AI CV extraction into structured schema. Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-086 (Job Intelligence Engine)**: AI job description drafting. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-087 (Candidate Matching Intelligence Engine)**: Semantic comparison of candidate evidence against job scorecards (`score_match`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-088 (Screening Intelligence Engine)**: Automated candidate questionnaire drafting. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-089 (Outreach Intelligence Engine)**: Personalized outreach email drafting (`draft_outreach`). Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-090 (Reply Classification Engine)**: Sentiment and opt-out classification (`classify_reply`). Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-091 (Interview Intelligence Engine)**: Reminder text generation. Prompt exists, handler unwired in `queue.ts` (RB-05). Status: `UNWIRED / RELEASE-BLOCKER` (Maturity 1).
- **ENG-092 (Invoice Intelligence Engine)**: Discrepancy reconciliation. Prompt exists, handler unwired in `queue.ts` (RB-05). Status: `UNWIRED / RELEASE-BLOCKER` (Maturity 1).
- **ENG-093 (Recruitment Analytics Intelligence Engine)**: Predictive hiring analytics. Status: `TARGET / MISSING` (Maturity 0).

### 5.12 Domain L: Platform & Infrastructure
- **ENG-094 (Database Engine)**: MySQL 8.0 connection pool with eager `SELECT 1` startup connectivity check. Status: `VERIFIED-TEST` (Maturity 4).
- **ENG-095 (Migration Engine)**: Drizzle Kit migrations in `drizzle/`. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-096 (Storage Engine)**: Local and S3 storage adapters with workspace owner isolation (`privateStorage.ts`). Status: `VERIFIED-TEST` (Maturity 4).
- **ENG-097 (Document Scan Engine)**: Static byte heuristics (magic bytes, EICAR, script tags). File hygiene only (no live antivirus daemon). Status: `PARTIAL` (Maturity 4).
- **ENG-098 (Search Engine)**: Relational SQL LIKE / index searching. Status: `PARTIAL` (Maturity 2).
- **ENG-099 (API Engine)**: tRPC route hierarchy with Zod input validation and procedure-level RBAC. Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-100 (Error Handling Engine)**: Standardized TRPCError and Fastify error sanitization. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-101 (Logging Engine)**: Fastify structured logger. Status: `CURRENT-VERIFIED` (Maturity 3).
- **ENG-102 (Health / Readiness Engine)**: `/healthz` HTTP endpoint and startup ping. Status: `VERIFIED-TEST` (Maturity 4).
- **ENG-103 (Backup / Recovery Engine)**: Database dump scripts and recovery runbooks. Status: `TARGET / UNVERIFIED` (Maturity 0).
- **ENG-104 (Deployment Engine)**: `scripts/build-hostinger.mjs` bundling Fastify backend and Vite SPA into `dist/`. Status: `CURRENT-VERIFIED` (Maturity 4).
- **ENG-105 (Integration Engine)**: Third-party SDK client management. Status: `PARTIAL / UNVERIFIED` (Maturity 2).

---

## 6. Target Engine Profiles (Domains M, N, O)

The following engines represent intended platform roadmap capabilities. They have **zero codebase, database schema, or route presence in the current repository**:

### 6.1 Domain M: Recruiter Marketplace (ENG-106 to ENG-113)
- **ENG-106 (Recruiter Marketplace Engine)**: Open network for assigning requisitions to external freelance recruiters. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-107 (Recruiter Profile Engine)**: Public profile, niche expertise, and track record. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-108 (Recruiter Verification Engine)**: ID verification and recruiter credential vetting. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-109 (Recruiter Assignment Engine)**: Automated requisition broadcasting and claiming. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-110 (Recruiter Rating Engine)**: Peer reviews, delivery speed, and fill rate scoring. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-111 (Recruiter Commission Engine - Marketplace)**: Automated commission split calculations. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-112 (Recruiter Payout Engine - Marketplace)**: Stripe Connect / automated payout disbursement. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-113 (Marketplace Anti-Poaching Engine)**: Enforces candidate non-solicitation rules across recruiters. Status: `TARGET / MISSING` (Maturity 0).

### 6.2 Domain N: International Recruitment (ENG-114 to ENG-120)
- **ENG-114 (Country Rule Engine)**: Destination country legal hiring regulations. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-115 (Visa / Work Permit Engine)**: Visa document checklist and processing timeline tracker. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-116 (International Compliance Engine)**: Cross-border labor mobility compliance. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-117 (Overseas Employer Engine)**: International employer verification and tax identifiers. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-118 (Overseas Candidate Engine)**: Emigration clearance and passport validation. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-119 (Agency Compliance Engine)**: Sub-agency partner licensing and agreements. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-120 (Country Document Engine)**: Country-specific document checklist management. Status: `TARGET / MISSING` (Maturity 0).

### 6.3 Domain O: Growth & Marketing (ENG-121 to ENG-129)
- **ENG-121 (Market Intelligence Engine)**: Salary benchmarking and hiring demand trends. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-122 (Content Intelligence Engine)**: AI recruitment thought leadership drafting. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-123 (SEO Intelligence Engine)**: High-intent hiring search keyword discovery. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-124 (Social Publishing Engine)**: Automated publishing to LinkedIn and Twitter/X. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-125 (Social Engagement Engine)**: Inbound comment and direct message monitoring. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-126 (Lead Generation Engine)**: Automated prospect discovery via Apollo / web scrapers. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-127 (Campaign Engine)**: Multi-channel automated email and LinkedIn drip sequences. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-128 (Attribution Engine)**: Campaign lead attribution and source tracking. Status: `TARGET / MISSING` (Maturity 0).
- **ENG-129 (Growth Analytics Engine)**: Funnel analytics and visitor-to-job conversion rates. Status: `TARGET / MISSING` (Maturity 0).

---

## 7. Critical Release Blockers & Engine Impact Matrix

The active release blockers from `docs/PLATFORM_SOURCE_OF_TRUTH.md` directly impact specific platform engines:

| Blocker ID | Affected Engines | Root Cause in Repository | Operational Impact | Status |
| :--- | :--- | :--- | :--- | :--- |
| **RB-05** | ENG-073, ENG-077, ENG-091, ENG-092 | `server/services/queue.ts:240` has no result handlers for `send_reminder` or `reconcile_invoice`. | Interview reminders and invoice reconciliation results are abandoned in `automationQueue.result` without updating domain records. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-07** | ENG-012, ENG-041, ENG-047, ENG-054, ENG-055 | `server/services/approvalEngine.ts:265-276` executes `findMatchingRule` without checking if action is consequential. | Consequential actions (candidate share, placement confirmation, invoice disputes) can be auto-approved by workspace policy rules without human review. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-08** | ENG-007, ENG-012, ENG-080 | `server/routers/recruitment.ts:95-103` permits direct transition `converted → active`. | Client onboarding approval gate and KYB verification can be bypassed via direct tRPC mutation. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-09** | ENG-041, ENG-047, ENG-056 | `workflow.ts` defines 12 consequential actions; `approvalEngine.ts` and `consequential.ts` define only 5. | Deciding approvals for `placement_confirmation`, `candidate_share`, `client_onboarding`, or `invoice_issue` via `consequentialRouter.decide` throws `NOT_FOUND`. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-10** | ENG-069, ENG-070, ENG-071 | `server/services/hostingerMail.ts:54` hardcodes `providerMessageId: null`. | All outbound messages persist null message IDs; incoming reply emails fail thread correlation headers and route to exception incidents. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-11** | ENG-012, ENG-041, ENG-047, ENG-054 | `server/services/approvalEngine.ts:190-220` executes decision, side effect, and audit sequentially without `db.transaction`. | Failure during side effect leaves approval row marked "approved" with no automated rollback mechanism. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |
| **RB-12** | ENG-002, ENG-003 | `server/_core/context.ts:27-39` unconditionally falls back to `Sahil (Owner)` with `role: "admin"` if unauthenticated. | Any execution of development server (`server.ts`) grants root administrative privileges to unauthenticated callers. | **ACTIVE-DEFECT / RELEASE-BLOCKER** |

---

## 8. Summary Statistics & Implementation Breakdown

- **Total Recognized Platform Engines**: **129**
- **Total Architectural Domains**: **15**
- **Implementation Status Distribution**:
  - **CURRENT-VERIFIED / VERIFIED-TEST**: **36 engines**
  - **PARTIAL (Functional with gaps)**: **25 engines**
  - **ACTIVE-DEFECT / RELEASE-BLOCKER**: **11 engines**
  - **UNWIRED (Scaffolded without event connection)**: **4 engines**
  - **TARGET / MISSING (Roadmap capabilities)**: **53 engines**
- **Engine Type Breakdown**:
  - Business Engines: 54
  - Platform / Infrastructure Engines: 23
  - Compliance / Risk Engines: 13
  - AI Intelligence Engines: 14
  - Automation Engines: 7
  - Integration Engines: 6
  - Recruiter Marketplace Engines: 8
  - International Recruitment Engines: 4
- **Active Release Blockers Documented**: **7 (RB-05, RB-07, RB-08, RB-09, RB-10, RB-11, RB-12)**
- **Historical Resolved Blockers Preserved**: **5 (RB-01, RB-02, RB-03, RB-04, RB-06)**

---

## 9. Master Document Freeze & Audit Sign-Off

`docs/ENGINE_REGISTRY.md` is complete, consistent with `docs/PLATFORM_SOURCE_OF_TRUTH.md`, and frozen as the architectural engine baseline. Future implementation tasks must resolve active release blockers within their respective engines without altering engine domain boundaries.
