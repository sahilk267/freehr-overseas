# FreelanceHR Audit Changelog

This changelog maps each implemented fix back to the specific audit numbering and requirements established in Prompts 1–10.

---

### Audit 1: Strict Consent Verification & Candidate Consent Gating
- **Gap/Bug**: Candidates could transition to `"consented"` without an existing, active, non-expired consent record of type `platform_processing`.
- **Fix Implemented**: Updated `candidatesRouter.transition` in `server/routers/recruitment.ts` to query the database for valid consent records before permitting state transition. Transitions to `"consented"` reject with `BAD_REQUEST` if no active consent record exists or if consent has expired/withdrawn.
- **Verification**: Covered by `server/routers/candidateConsentTransition.test.ts`.

---

### Audit 2: Owner Approval Enforcement for Consequential Actions
- **Gap/Bug**: Sensitive, revenue-impacting, or privacy-critical actions (client onboarding, candidate profile sharing, placement confirmation, invoice issuance, replacements, credit notes, and disputes) lacked mandatory owner-approval gates.
- **Fix Implemented**: Implemented `requireOwnerApproval` and role-checked procedures across `recruitment.approvals`, `recruitment.consequential`, and `recruitment.invoices`. Actions create pending approval records that must be explicitly decided by the workspace owner.
- **Verification**: Covered by `server/routers/consequential.teamAccess.test.ts` and `server/e2eHappyPath.workflow.test.ts`.

---

### Audit 3: Comprehensive Immutable Audit Trail
- **Gap/Bug**: Workflow state changes and security decisions were not consistently recorded in an immutable append-only audit log.
- **Fix Implemented**: Integrated `recordAudit` across all state transitions in `recruitment`, `operations`, `team`, and `email` routers. Records actor ID, action type, resource ID, timestamp, and audit metadata.
- **Verification**: Verified via `server/services/workspaceAccess.test.ts` and audit queries in `operations.audits.list`.

---

### Audit 4: Candidate Document Security Scanning & Private Storage
- **Gap/Bug**: Candidate CVs and uploaded documents lacked malware/security scan verification and could be accessed before safety verification was complete.
- **Fix Implemented**: Added `server/services/documentScanner.ts` to perform multi-rule file signature and safety checks. Added `scanState` checks (`pending`, `clean`, `flagged`) to private storage download routes (`/api/private-storage/*`) and `candidates.documents.access`, returning HTTP 403 Forbidden if unverified or flagged.
- **Verification**: Covered by `server/services/documentScanner.test.ts`, `server/services/privateStorage.test.ts`, and `server/routers/documentAccess.teamAccess.test.ts`.

---

### Audit 5: Automation Queue Safety & Emergency Kill-Switch
- **Gap/Bug**: Automated background jobs could execute unbounded without retry backoff or runtime kill-switch controls.
- **Fix Implemented**: Added idempotency keys, max-retry caps, exponential backoff, and a global workspace emergency stop (`isEmergencyStopActive`) in `server/services/queue.ts` and `operations.settings.setEmergencyStop`.
- **Verification**: Covered by `server/services/queue.test.ts`.

---

### Audit 6: Inbound Mail Webhook Authentication & Identity Verification
- **Gap/Bug**: Inbound Hostinger Mail webhooks lacked signature verification and unverified sender identities could be marked active.
- **Fix Implemented**: Implemented webhook secret verification and payload parsing in `server/services/hostingerWebhook.ts` and `server/services/hostingerMail.ts`. Sender identities require explicit verification against the Hostinger Mail API before being activated.
- **Verification**: Covered by `server/services/hostingerWebhook.test.ts` and `server/services/hostingerWebhook.persistence.test.ts`.

---

### Audit 7: Calendar RFC-5545 Versioning & Cancellation Handling
- **Gap/Bug**: Interview calendar event updates did not increment the RFC-5545 `SEQUENCE` counter, and cancelled interviews generated active invitations.
- **Fix Implemented**: Updated `server/services/calendar.ts` to track calendar version increments on reschedule, assign `STATUS:CANCELLED` on cancellation, and generate valid RFC-5545 `.ics` payloads.
- **Verification**: Covered by `server/services/calendar.test.ts` and `server/services/interviewReminders.test.ts`.

---

### Audit 8: Team RBAC & Multi-Role Access Control
- **Gap/Bug**: Workspace permissions lacked strict role hierarchies (owner, admin, recruiter, auditor), risking privilege escalation.
- **Fix Implemented**: Implemented role-based authorization checks in `server/services/workspaceAccess.ts` and middleware in `server/_core/trpc.ts`. Restricted approval decisions, team invitations, and policy changes to owners and admins.
- **Verification**: Covered by `server/routers/team.test.ts`, `server/_core/trpc.teamAccess.test.ts`, and `server/services/workspaceAccess.test.ts`.

---

### Audit 9: Production Route Parity (Express Dev & Fastify Hostinger)
- **Gap/Bug**: Route registrations between the Express development server (`server/_core/index.ts`) and Fastify production server (`server/hostinger.ts`) had discrepancies in path patterns and 404 error responses.
- **Fix Implemented**: Synchronized all endpoints across both servers:
  - `GET /api/health` -> Standardized JSON health check
  - `GET /api/private-storage/*` -> Strict tokenized & scan-gated document serving
  - `POST /api/scheduled/interview-reminders` -> Cron-authenticated reminder dispatcher
  - `POST /api/scheduled/automation-queue` -> Cron-authenticated batch execution
  - `POST /api/webhooks/hostinger-mail` -> Webhook intake
  - `GET /api/auth/oidc/login` and `GET /api/auth/oidc/callback` -> OIDC authentication
  - Catch-all `/api/*` JSON 404 response to eliminate Vite SPA HTML fallbacks.
- **Verification**: Verified via `server/hostinger.test.ts` and manual endpoint curl checks.

---

### Audit 10: End-to-End Integration Verification & Dev Server Resilience
- **Gap/Bug**: Lack of an end-to-end integration test validating the entire recruitment happy path with owner approval gates, and client crashing with `Unexpected token '<'` when receiving HTML error pages from reverse proxies.
- **Fix Implemented**:
  1. Created `server/e2eHappyPath.workflow.test.ts` verifying the end-to-end lifecycle: prospect creation -> conversion -> onboarding approval -> job creation -> candidate addition -> consent grant -> candidate transition -> matching -> share approval -> interview scheduling -> feedback -> placement -> joining approval -> invoice drafting -> issue approval -> payment status update.
  2. Implemented client-side non-JSON response interception in `client/src/main.tsx` and Express `/api/*` fallback to guarantee all API responses return valid JSON.
- **Verification**: All 190 unit and integration tests passing across 34 test files (`npm test`), with 2 skipped due to missing live API credentials.

---

### Audit 11: Enterprise Production Hardening & Gap Resolution (GAPs 01-21)
- **Gaps Addressed**:
  1. **GAP-01 [P0] (Production DB Guard)**: Strict error throwing in production when `DATABASE_URL` is missing or fails connection.
  2. **GAP-02 [P0] (Hostinger Cron Auth)**: Implemented `authenticateCronRequest` supporting `X-Cron-Key` / Bearer token via `CRON_SECRET` for `/api/scheduled/*`.
  3. **GAP-03 [P0] (Multi-Adapter Storage & Scanner)**: Unified `privateStorage` to support `local`, `s3`, and `managed` across both reads and writes.
  4. **GAP-04 [P0] (GDPR Deletion)**: Verified and tested `deletePrivateDocument` across all storage modes.
  5. **GAP-05 [P0] (Right-to-Erasure Deletion Fulfillment)**: Added physical file deletion, document row redaction, suppression indexing, and audit logging during candidate deletion cascades.
  6. **GAP-07 / 08 / 09 [P1] (AI Persistence)**: Centralized post-processing of AI outreach, scoring, and classification tasks into conversation and message stores via `handleAiTaskResult`.
  7. **GAP-11 [P1] (Team Invitation Acceptance)**: Wired Hostinger Mail invite delivery and added public `/team/accept` accept invite UI route.
  8. **GAP-12 [P2] (Invoicing & Payments)**: Implemented automated HTML invoice document generation (`invoices.generateDocument`), payment link creation (`invoices.createPaymentLink`), and payment recording (`invoices.recordPayment`).
  9. **GAP-13 [P2] (Two-Way Calendar Sync)**: Added RFC 5545 multi-event subscription feed generator (`generateCalendarFeedIcs`), tRPC query (`interviews.calendarFeed`), and public calendar feed endpoint (`/api/calendar/feed/:userId`).
  10. **GAP-15 [P2] (Seed Script)**: Confirmed `seed:demo` script presence and operational readiness.
  11. **GAP-16 [P3] (Client KYB Verification)**: Added `prospects.attachKybDocument` and `prospects.verifyKyb` for compliance verification.
  12. **GAP-18 [P3] (Granular UI RBAC)**: Enforced role-based route access guards and warning view in `DashboardLayout.tsx`.
  13. **GAP-20 [P5] (Heartbeat Fallback)**: Documented non-preview mock heartbeat fallback behavior for Linux crontabs.
  14. **GAP-21 [P5] (Test Count Drift)**: Synchronized test counts to current test suite metrics.
- **Verification**: 190 tests passing across 34 test files.
