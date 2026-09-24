# FreelanceHR Platform Source of Truth (Canonical Architecture Record)

**Document Phase**: P0.2-B Database Startup Safety + Cron Security + Privacy Erasure Fail-Closed  
**Verification Level**: Strict Repository-Audited Evidence (Zero Speculation / Zero Hallucination)  
**Last Verified Date**: 2026-09-23  
**Repository Authority Rule**: The actual codebase, schemas, configuration files, and test files supersede all external, historical, or aspirational documentation claims.

---

## 1. Executive Summary & Canonical Repository Facts

The following table reflects the **ACTUAL CURRENT VALUES** as declared in repository files. Intended or target values are explicitly marked.

| Attribute | Current Verified Setting / Value | Actual State / Classification | Authoritative Evidence |
| :--- | :--- | :--- | :--- |
| **Platform Name** | `freelancehr` | CURRENT-VERIFIED | `package.json:2` |
| **Primary Domain (Target)** | `freelancehr.overseasjob.in` | TARGET-NOT-IMPLEMENTED | `HOSTINGER_DEPLOYMENT.md:3` |
| **Mail Domain (Target)** | `overseasjob.in` | TARGET-NOT-IMPLEMENTED | `server/services/hostingerMail.ts:6` |
| **Primary Owner Email** | Configured via `PRIMARY_OWNER_EMAIL` | CURRENT-VERIFIED | `server/services/primaryOwner.ts:9` |
| **Runtime Engine** | `node: ">=20.19.0"` declared in `engines` | CURRENT-VERIFIED | `package.json:7-9` |
| **Package Manager** | `pnpm@11.0.0` declared in `packageManager` | CURRENT-VERIFIED | `package.json:6` |
| **Lockfile Present** | `pnpm-lock.yaml` (v9.0) canonical and synchronized; `bun.lock` removed | CURRENT-VERIFIED | `pnpm-lock.yaml` |
| **React Dependency** | `react: ^19.0.1`, `react-dom: ^19.0.1` | CURRENT-VERIFIED | `package.json:83,85` |
| **Vite Dependency** | `vite: ^6.2.3` | CURRENT-VERIFIED | `package.json:96` |
| **Fastify Dependency** | `fastify: ^5.12.4` | CURRENT-VERIFIED | `package.json:71` |
| **Drizzle ORM Dependency**| `drizzle-orm: ^0.44.5` | CURRENT-VERIFIED | `package.json:68` |
| **Drizzle-Kit Dependency**| `drizzle-kit: ^0.31.4` (resolves to `0.31.5`) in `devDependencies` | CURRENT-VERIFIED | `package.json:107` |
| **Zod Dependency** | `zod: ^3.24.2` | CURRENT-VERIFIED | `package.json:98` |
| **Hostinger Mail SDK** | `hostinger-mail-api-sdk: ^1.18.0` | CURRENT-VERIFIED | `package.json:73` |
| **tRPC Dependency** | `@trpc/server: ^11.6.0`, `@trpc/client: ^11.6.0`, `@trpc/react-query: ^11.6.0` | CURRENT-VERIFIED | `package.json:57-59` |
| **Database Engine** | MySQL (via `mysql2: ^3.15.0` & Drizzle ORM) | PARTIAL | `package.json:79`, `server/db.ts` |
| **Server Architecture** | Dual Entrypoint: Express (Dev) & Fastify (Prod `dist/hostinger.js`) | CURRENT-VERIFIED | `server.ts:1`, `server/hostinger.ts:1` |
| **Production Start Script**| `node dist/hostinger.js` (executes compiled Fastify server) | CURRENT-VERIFIED | `package.json:12` |

---

## 2. Operational Invariants & Governing Principles

1. **Domain Engines Own Business State; AI Provides Intelligence**:
   - AI models extract, classify, draft, and score evidence (`server/services/openrouter.ts`, `server/services/aiRouting.ts`).
   - AI is strictly prohibited from autonomously rejecting candidates, altering invoice statuses, granting consent, executing payouts, or bypassing owner approvals (`server/services/openrouter.ts:51-58`, `server/workflow.ts:159-174`).
2. **Production Must Never Silently Fall Back to Mocks**:
   - `server/db.ts:28-48` throws a configuration error if `DATABASE_URL` is missing and a connectivity error if MySQL connection fails in strict production.
   - Synchronous `SELECT 1` connectivity verification is performed before server traffic is accepted via `verifyDatabaseConnectivity()` in `server/db.ts` and `server/hostinger.ts`.
3. **Hostinger-Specific Implementation Isolated Behind Adapters**:
   - Outbound mail uses `server/services/hostingerMail.ts`.
   - Inbound webhooks use `server/services/hostingerWebhook.ts`.
   - Production HTTP server uses `server/hostinger.ts`.
4. **Least-Privilege Team RBAC with Non-Delegable Owner Controls**:
   - Workspace owner holds authority over team memberships, client sharing, policy changes, and financial decisions (`server/services/workspaceAccess.ts:10-33`).

---

## 3. Hostinger Runtime & Build Status

### 3.1 Build & Start Script Truth Matrix

| Command / Script | Target File | Current Output / Behavior | Operational Status |
| :--- | :--- | :--- | :--- |
| `pnpm build` (`package.json:11`) | `node scripts/build-hostinger.mjs` | Builds Vite frontend (`dist/public`) and bundles Fastify backend into `dist/hostinger.js` | CURRENT-VERIFIED |
| `pnpm start` (`package.json:12`) | `node dist/hostinger.js` | Starts compiled Fastify production server on validated PORT (default 3000) listening on 0.0.0.0 | CURRENT-VERIFIED |
| `pnpm build:hostinger` | `node scripts/build-hostinger.mjs` | Canonical Hostinger builder alias | CURRENT-VERIFIED |
| `pnpm start:hostinger` | `node dist/hostinger.js` | Canonical Hostinger starter alias | CURRENT-VERIFIED |

> **Production Runtime Architecture**: The production build path is now fully unified. Running `pnpm build` builds the frontend assets with Vite into `dist/public` and bundles the production Fastify server into `dist/hostinger.js` via esbuild. Running `pnpm start` runs `node dist/hostinger.js`, which serves both the API endpoints and the static SPA frontend.

### 3.2 Dual-Server Topology

```
                       ┌───────────────────────────────┐
                       │        Client Request         │
                       └───────────────┬───────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
        [DEVELOPMENT RUNTIME]                  [PRODUCTION RUNTIME]
      Entry: server.ts (Express)          Entry: server/hostinger.ts (Fastify)
    ┌──────────────────────────────┐    ┌──────────────────────────────────┐
    │ - Vite Dev Server Middleware │    │ - Fastify Static Plugin          │
    │ - Express Body Parsers       │    │ - Fastify Formbody & Multipart   │
    │ - tRPC Express Adapter       │    │ - Fastify-tRPC Plugin            │
    │ - Preview OAuth / OIDC Auth  │    │ - Strict OIDC Auth Middleware    │
    │ - Local Storage Proxy Route  │    │ - Strict Storage & Scan Route    │
    │ - Development Logger         │    │ - Cron Secret Verification       │
    └──────────────────────────────┘    └──────────────────────────────────┘
```

---

## 4. Database Connection & Startup Status

### 4.1 Actual `server/db.ts` Behavior

1. **`DATABASE_URL` Missing in Production**:
   - In strict production (`process.env.NODE_ENV === "production" && !process.env.VITEST`), `getDb()` checks `if (!process.env.DATABASE_URL)` and throws:
     `[FreelanceHR] Database configuration error: DATABASE_URL environment variable is missing. Refusing to initialize mock database store in production.`
   - Status: **CURRENT-VERIFIED** (fails closed with distinct configuration error).
2. **`drizzle()` Constructor & Startup Verification**:
   - `_db = drizzle(process.env.DATABASE_URL)` is called inside `getDb()`.
   - In strict production, `getDb()` immediately executes `await client.execute(sql`SELECT 1`)` to ensure the connection is established before saving `_db`.
   - Status: **CURRENT-VERIFIED** (eager startup verification).
3. **Startup Connectivity Verification (`SELECT 1`)**:
   - `verifyDatabaseConnectivity()` in `server/db.ts` executes `SELECT 1` ping.
   - `server/hostinger.ts` calls `verifyDatabaseConnectivity()` before starting the Fastify server and aborts process with exit code 1 if unreachable.
   - Status: **CURRENT-VERIFIED / RESOLVED IN P0.2-B**.
4. **Real MySQL Connectivity Verified Before Serving Requests**:
   - **YES**. Production startup verifies connection with `SELECT 1` before Fastify binds to the port.
   - Status: **CURRENT-VERIFIED / RESOLVED IN P0.2-B**.
5. **Mock Fallback Existence & Reachability**:
   - Mock store (`createMockDrizzle(_mockStore)`) exists for non-production/test environments only.
   - In strict production, missing configuration or failed connection throws fatal errors immediately and will never assign the mock store.
   - Status: **CURRENT-VERIFIED** (Mock store cannot be reached in strict production).

---

## 5. Private Storage & Privacy Deletion Status

### 5.1 Storage Implementation Truth (`server/services/privateStorage.ts`)

| Storage Mode | Deletion Implementation (`deletePrivateDocument`) | Physical Deletion Verified? | Status |
| :--- | :--- | :--- | :--- |
| **`local`** | Calls `unlink(localFile(key))`; returns `true` on success, `true` if `ENOENT` (idempotent), throws other I/O errors. | YES | CURRENT-VERIFIED |
| **`s3`** | Sends `DeleteObjectCommand({ Bucket, Key })` to S3; returns `true`. | YES | CURRENT-VERIFIED |
| **`managed`** | Throws `Error("Physical document deletion is not supported in managed storage mode.")` | **NO (FAILS CLOSED)** | **CURRENT-VERIFIED / FAIL-CLOSED** |

> **Critical Safety Fact**: In `managed` mode, `deletePrivateDocument` strictly fails closed by throwing an error, preventing the privacy workflow from falsely claiming successful physical erasure.

### 5.2 Privacy Deletion Workflow (`server/routers/candidateWorkflows.ts`)

In `candidateWorkflows.ts:250-295`:
- When `deletePrivateDocument(doc.storageKey)` fails (throws an exception or returns non-true):
  1. The error is NOT silently swallowed.
  2. The statutory rights request transitions to `status: "investigation"`.
  3. Details are appended with failure reason `[Failure] Physical deletion failure for document...`.
  4. An append-only audit event `privacy.erasure_failed` is recorded.
  5. The workflow throws a TRPCError (`INTERNAL_SERVER_ERROR`), aborting the deletion and preventing database redaction or candidate profile deletion.
- **Classification**: **COMPLETE / FAIL-CLOSED / RESOLVED IN P0.2-B**. Database records are never redacted unless required physical storage deletion succeeds.

---

## 6. Cron & Scheduled Endpoint Authentication Status

### 6.1 Authentication Mechanism (`server/services/runtimeAuth.ts` & `server/hostinger.ts`)

1. **`CRON_SECRET` Support**:
   - `authenticateCronRequest` requires `process.env.CRON_SECRET` with length >= 8.
   - Status: **CURRENT-VERIFIED**.
2. **Timing-Safe Header & Bearer Authentication**:
   - Validates `x-cron-key` header and `Authorization: Bearer <CRON_SECRET>` using `timingSafeEqual`.
   - Status: **CURRENT-VERIFIED**.
3. **Behavior When Secret is Missing or Invalid in Production**:
   - When `CRON_SECRET` is unset, invalid, or mismatched, request is immediately rejected with HTTP 401 (`error: "cron-authentication-required"`).
   - Status: **CURRENT-VERIFIED / RESOLVED IN P0.2-B**.
4. **Fallback to Preview OAuth in Production**:
   - **ELIMINATED**. Production scheduled endpoints (`/api/scheduled/interview-reminders`, `/api/scheduled/automation-queue`) NEVER fall back to preview OAuth or `sdk.authenticateRequest`.
   - Status: **CURRENT-VERIFIED / RESOLVED IN P0.2-B**.
5. **Startup Requirement for `CRON_SECRET`**:
   - `assertProductionRuntimeConfiguration` in `server/services/runtimeAuth.ts` checks `CRON_SECRET (at least 8 characters)`. Server startup fails closed if missing in production.
   - Status: **CURRENT-VERIFIED / RESOLVED IN P0.2-B**.
6. **Test Suite Verification**:
   - Both `server/hostinger.test.ts` and `server/p02b.test.ts` verify acceptance with valid secret, rejection with 401 on missing/invalid secret, zero OAuth fallback, and uniform enforcement across all scheduled endpoints.
   - Status: **VERIFIED-TEST**.

---

## 7. Approval Engine & Policy Automation Reality

### 7.1 Consequential Action Types Set (`server/services/approvalEngine.ts:15-21`)

The actual codebase defines `consequentialActionTypes` as a Set containing **EXACTLY 5 ACTIONS**:
1. `candidate_final_decision`
2. `replacement_case`
3. `invoice_payment_status`
4. `invoice_dispute`
5. `invoice_credit`

*(Note: `server/workflow.ts:159` documents an array of 12 actions, but the runtime approval engine enforcement in `approvalEngine.ts` uses the 5-item Set above).*

### 7.2 Actions with Defined Side Effects (`applySideEffect` in `approvalEngine.ts:58-188`)
1. `client_onboarding` (updates `companies`)
2. `candidate_share` (updates `shortlists`)
3. `placement_confirmation` (updates `placements`)
4. `invoice_issue` (updates `invoices`)
5. `candidate_final_decision` (updates `screenings`)
6. `replacement_case` (updates `placements`)
7. `invoice_payment_status` (updates `invoices`)
8. `invoice_dispute` (updates `invoices`)
9. `invoice_credit` (updates `invoices`)

### 7.3 Policy Auto-Approval Capabilities & Safety Flaw (`requestOrAutoDecide` in `approvalEngine.ts:240-340`)

- `requestOrAutoDecide` passes `(policyConfig, actionType, payload)` to `findMatchingRule` in `server/services/policyEngine.ts:120-173`.
- `findMatchingRule` checks if any rule has `rule.actionType === actionType` and satisfies conditions.
- **Safety Fact**: `findMatchingRule` does **NOT** check `consequentialActionTypes`. It does **NOT** prohibit consequential actions from matching auto-approval rules.
- If a workspace configures an auto-approval rule for `candidate_final_decision`, `replacement_case`, or any other action, `findMatchingRule` returns the rule, and `approvalEngine.ts` auto-approves it with `decisionSource: "policy"`.
- **Classification**: **ACTIVE DEFECT / SAFETY RISK**. Consequential actions can bypass mandatory human approval if matching policy rules are configured.
- Actions that can currently be policy-auto-approved: **ALL 9 ACTION TYPES** (no action type is locked to mandatory human approval by code constraint).

---

## 8. AI Queue Handlers Status (`server/services/queue.ts`)

The AI job execution pipeline processes jobs via `handleAiTaskResult` (`queue.ts:13-240`). Each handler is classified below:

| Job Type | Handler Implementation | Actual Side Effects | Operational Status |
| :--- | :--- | :--- | :--- |
| `parse_cv` | `queue.ts:22-73` | Updates `candidateDocuments.parseState = "parsed"`, saves `parsedData`, sets `candidates.headline`, logs `candidate.document_parsed` audit. | **COMPLETE** |
| `draft_outreach` | `queue.ts:74-103` | Updates `messages.subject`, `messages.body`, `messages.status = "draft_ready"`, logs `outreach.draft_ready` audit. | **COMPLETE** |
| `classify_reply` | `queue.ts:104-177`| Updates `conversations.classification`. If opt-out: sets `conversations.status = "opted_out"`, inserts into `suppressionList`, updates `contacts` and `candidates`, logs audit. | **COMPLETE** |
| `score_match` | `queue.ts:178-239`| Inserts/updates `matches` table (`ruleScore`, `semanticScore`, `confidence`, `evidence`, `missingEvidence`, `status`), logs audit. | **COMPLETE** |
| `send_reminder` | **NONE** in `handleAiTaskResult` | Zod schema & prompt exist in `openrouter.ts`. Output is stored only in `automationQueue.result`. No domain tables or notification states updated. | **UNWIRED** |
| `reconcile_invoice` | **NONE** in `handleAiTaskResult` | Zod schema & prompt exist in `openrouter.ts`. Output is stored only in `automationQueue.result`. No invoice ledger or dispute records updated. | **UNWIRED** |

---

## 9. Test Suite Verification Facts

### 9.1 Static Test Inventory
- **Current Test Files Count**: **35 test files** (all located in `server/`)
- **Current Test / Test Case Declarations**: **192 test declarations** (`it(` / `test(`)

### 9.2 Execution Status
- **P0.2-B Safety Suite**: `npx vitest run server/routers/candidateDeletion.test.ts server/hostinger.test.ts server/p02b.test.ts` executes and passes cleanly:
  - `server/routers/candidateDeletion.test.ts`: **5 passed**
  - `server/hostinger.test.ts`: **4 passed**
  - `server/p02b.test.ts`: **12 passed**
  - Total: **3 test files, 21 tests passed, 0 failed** (Duration: 6.99s).
- **Hostinger Production Verification**: `npx tsx scripts/verify-hostinger.ts`: **21 passed, 0 failed**.
- **Classification**: **VERIFIED-TEST** for P0.2-B scope (Database startup safety, Cron timing-safe authentication & no OAuth fallback, and Privacy erasure fail-closed).

---

## 10. Comprehensive 30-Workflow Verification Matrix

| Flow # | Workflow Name | Current Code State | Operational Status | Verified Defect / Note |
| :--- | :--- | :--- | :--- | :--- |
| **01** | **Authentication** | `server/services/runtimeAuth.ts` | **PARTIAL** | OIDC flow implemented; requires production IdP configuration. |
| **02** | **Authorization** | `server/services/workspaceAccess.ts` | **PARTIAL** | Backend procedures check role; non-owner UI views restricted. |
| **03** | **Workspace / Team Access**| `server/routers/team.ts` | **COMPLETE** | Dispatches via Hostinger Mail when configured; `/team/accept` mounted. |
| **04** | **Client Onboarding** | `server/services/approvalEngine.ts` | **PARTIAL** | Can be policy-auto-approved if rule matches. |
| **05** | **Client Verification** | `server/routers/recruitment.ts` | **COMPLETE** | KYB document attachment and verification implemented. |
| **06** | **Job Creation** | `server/routers/recruitment.ts` | **COMPLETE** | Quality checks and scorecard sum validation enforced. |
| **07** | **Job Validation** | `server/routers/recruitment.ts` | **COMPLETE** | Client confirmation required before sourcing. |
| **08** | **Candidate Creation** | `server/routers/recruitment.ts` | **COMPLETE** | SHA-256 contact hashing and provenance capture enforced. |
| **09** | **Candidate Document Upload**| `server/services/privateStorage.ts`| **COMPLETE** | Size checks, SHA-256 validation, and storage write verified. |
| **10** | **Resume Parsing** | `server/services/queue.ts` | **COMPLETE** | Updates `candidateDocuments.parseState = "parsed"` and `candidates.headline`. |
| **11** | **Consent Management** | `server/routers/recruitment.ts` | **COMPLETE** | Explicit consent gating; withdrawal cascades to suppression. |
| **12** | **Candidate Matching** | `server/services/queue.ts` | **COMPLETE** | Manual and queued `score_match` update `matches` table. |
| **13** | **Candidate Screening** | `server/services/approvalEngine.ts` | **PARTIAL** | `candidate_final_decision` can be policy-auto-approved if rule exists. |
| **14** | **Candidate Profile Sharing**| `server/services/approvalEngine.ts`| **PARTIAL** | Shortlist sharing can be policy-auto-approved if rule exists. |
| **15** | **Interview Lifecycle** | `server/services/calendar.ts` | **COMPLETE** | RFC 5545 `.ics` export and subscription feed implemented. |
| **16** | **Offer Extended / Accepted**| `server/routers/recruitment.ts` | **COMPLETE** | Placement creation and compensation tracking verified. |
| **17** | **Placement Confirmation** | `server/services/approvalEngine.ts` | **PARTIAL** | Can be policy-auto-approved if rule exists. |
| **18** | **Replacement Case** | `server/services/approvalEngine.ts` | **PARTIAL** | `replacement_case` can be policy-auto-approved if rule exists. |
| **19** | **Invoice Generation** | `server/services/invoicing.ts` | **COMPLETE** | PDF rendering and payment link generation supported. |
| **20** | **Payment & Revenue Actions**| `server/services/approvalEngine.ts` | **PARTIAL** | Payment status actions can be policy-auto-approved if rule exists. |
| **21** | **Outbound Email Dispatch** | `server/services/hostingerMail.ts` | **COMPLETE** | Suppression check and Hostinger Mail SDK delivery verified. |
| **22** | **Inbound Email Webhook** | `server/services/hostingerWebhook.ts`| **COMPLETE** | Timing-safe auth, opt-out detection, incident logging. |
| **23** | **Task Scheduler** | `server/hostinger.ts` | **COMPLETE** | Strictly requires and timingSafeEqual-validates `CRON_SECRET` in production; no dev OAuth fallback. |
| **24** | **Automation Queue** | `server/services/queue.ts` | **PARTIAL** | Concurrency locks & budget work; 2 of 6 job handlers unwired. |
| **25** | **AI Task Execution** | `server/services/openrouter.ts` | **PARTIAL** | Prompt & schema exist; `send_reminder` & `reconcile_invoice` unwired. |
| **26** | **Privacy Right Fulfillment**| `server/routers/candidateWorkflows.ts`| **COMPLETE** | Atomic fail-closed: physical deletion must succeed before record redaction; failure transitions to investigation. |
| **27** | **Private Storage Deletion** | `server/services/privateStorage.ts`| **COMPLETE** | Fail-closed: `managed` mode explicitly throws; `local` mode handles ENOENT idempotency. |
| **28** | **Audit Trail Logging** | `server/db.ts:recordAudit` | **COMPLETE** | Append-only audit events recorded across domain procedures. |
| **29** | **Hostinger Production Deploy**| `package.json`, `scripts/build-hostinger.mjs`| **COMPLETE** | `package.json` `"start"` boots compiled Fastify server (`node dist/hostinger.js`). |
| **30** | **Production Startup Guard**| `server/hostinger.ts`, `server/db.ts`| **COMPLETE** | Synchronous `SELECT 1` ping executes before port bind; fails closed on DB error. |

---

## 11. RELEASE BLOCKER REGISTER (Rebuilt from Code Only)

### Active Release Blockers

| Blocker ID | Severity | Category | Description & Verified Code Fact | File Site | Required Resolution |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **RB-05** | **P1** | **AI / Queue** | **Unwired Automation Queue Side Effects**: In `server/services/queue.ts`, `handleAiTaskResult` implements handlers for `parse_cv`, `draft_outreach`, `classify_reply`, and `score_match`, but contains NO handler for `send_reminder` or `reconcile_invoice`. Completed results are abandoned in `automationQueue.result`. | `server/services/queue.ts:13-240` | Implement side-effect handlers for `send_reminder` (updating interview reminder dispatch state) and `reconcile_invoice` (updating invoice ledger status). |
| **RB-07** | **P1** | **Approval / Safety** | **Consequential Actions Can Bypass Mandatory Human Approval**: `server/services/approvalEngine.ts:15-21` defines only 5 actions in `consequentialActionTypes`. Furthermore, `requestOrAutoDecide` and `findMatchingRule` do NOT prevent consequential actions from matching `autoApprovalRules`. Any action can be policy-auto-approved if configured. | `server/services/approvalEngine.ts:240-340`, `server/services/policyEngine.ts:120-173` | Enforce in code that consequential actions (`consequentialActionTypes`) MUST NEVER match policy auto-approval rules and strictly require human owner decision. |

### Resolved Blockers (P0.2-A / P0.2-B)

| Blocker ID | Severity | Category | Resolution Summary | Resolved In |
| :--- | :--- | :--- | :--- | :--- |
| **RB-01** | **P0** | **Runtime / Build** | Updated `package.json` to canonical `"start": "node dist/hostinger.js"` and `"build": "node scripts/build-hostinger.mjs"`. | P0.2-A |
| **RB-02** | **P0** | **Privacy / Safety** | Made document erasure fail-closed in `server/routers/candidateWorkflows.ts` and `server/services/privateStorage.ts`: storage deletion verified before redaction; failures record audit and transition to `investigation`. | P0.2-B |
| **RB-03** | **P0** | **Database / Safety** | Added synchronous `SELECT 1` ping (`verifyDatabaseConnectivity`) in `server/db.ts` called on production startup by Fastify before binding. | P0.2-B |
| **RB-04** | **P1** | **Automation / Cron** | Enforced `CRON_SECRET` in `server/services/runtimeAuth.ts:configIssues` and removed dev OAuth fallback in `server/hostinger.ts` production routes with `timingSafeEqual`. | P0.2-B |
| **RB-06** | **P1** | **Tooling / Config** | Declared `packageManager` and `engines` in `package.json`, removed `bun.lock`, and added `drizzle-kit` to `devDependencies`. | P0.2-A |

---

## 12. Environment Variable Inventory

| Environment Variable | Required Mode | Sensitive | Code Site | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `DATABASE_URL` | Production / Dev | Yes | `server/db.ts:24` | MySQL connection string |
| `NODE_ENV` | Runtime | No | `server/db.ts:23` | Runtime environment mode |
| `PORT` | Container | No | `server/_core/index.ts:188` | Port to bind (3000) |
| `APP_BASE_URL` | Production | No | `server/services/runtimeAuth.ts:61` | Base URL for application |
| `PRIMARY_OWNER_EMAIL` | Production | No | `server/services/primaryOwner.ts:9` | Primary owner email identifier |
| `PRIMARY_OWNER_OPEN_ID`| Optional | No | `server/services/primaryOwner.ts:8` | Primary owner openId |
| `OWNER_ONLY_MODE` | Optional | No | `server/services/workspaceAccess.ts:16`| Lock workspace to owner |
| `OPENROUTER_API_KEY` | Production AI | Yes | `server/services/openrouter.ts:84` | Bearer key for OpenRouter models |
| `AUTH_MODE` | Production | No | `server/services/runtimeAuth.ts:57` | Must be `oidc` in production |
| `OIDC_ISSUER_URL` | Production | No | `server/services/runtimeAuth.ts:58` | OIDC discovery base URL |
| `OIDC_CLIENT_ID` | Production | No | `server/services/runtimeAuth.ts:59` | OIDC client application ID |
| `OIDC_CLIENT_SECRET` | Production | Yes | `server/services/runtimeAuth.ts:60` | OIDC client secret key |
| `OIDC_REDIRECT_URI` | Production | No | `server/services/runtimeAuth.ts:82` | Callback URL |
| `SESSION_SECRET` | Production | Yes | `server/services/runtimeAuth.ts:71` | Min 32-character secret for cookies |
| `CRON_SECRET` | Production Cron | Yes | `server/hostinger.ts:124` | Secret for scheduled endpoint execution |
| `PRIVATE_STORAGE_MODE` | All | No | `server/services/privateStorage.ts:10` | `local`, `s3`, or `managed` |
| `PRIVATE_LOCAL_STORAGE_PATH`| Hostinger local| No | `server/services/privateStorage.ts:25`| Path outside web root |
| `STORAGE_BUCKET` | S3 mode | No | `server/services/privateStorage.ts:37` | S3 bucket name |
| `STORAGE_REGION` | S3 mode | No | `server/services/privateStorage.ts:38` | S3 region identifier |
| `STORAGE_ACCESS_KEY_ID`| S3 mode | Yes | `server/services/privateStorage.ts:39` | S3 access key ID |
| `STORAGE_SECRET_ACCESS_KEY`| S3 mode | Yes | `server/services/privateStorage.ts:40` | S3 secret access key |
| `STORAGE_ENDPOINT` | S3 mode | No | `server/services/privateStorage.ts:53` | Custom S3 endpoint URL |
| `STORAGE_FORCE_PATH_STYLE` | S3 mode | No | `server/services/privateStorage.ts:54` | Path style S3 option |
| `HOSTINGER_MAIL_API_TOKEN` | Hostinger Mail | Yes | `server/services/hostingerMail.ts:28` | Hostinger Mail API Bearer token |
| `HOSTINGER_MAIL_FROM_DOMAIN`| Hostinger Mail | No | `server/services/hostingerMail.ts:6` | Domain for email dispatches |
| `HOSTINGER_MAILBOX_OWNER_ID` | Hostinger Mail | No | `server/services/hostingerMail.ts:7` | Mailbox ID for owner |
| `HOSTINGER_MAILBOX_CLIENTS_ID`| Hostinger Mail | No | `server/services/hostingerMail.ts:7` | Mailbox ID for clients |
| `HOSTINGER_MAILBOX_TALENT_ID` | Hostinger Mail | No | `server/services/hostingerMail.ts:7` | Mailbox ID for talent |
| `HOSTINGER_MAILBOX_INTERVIEWS_ID`| Hostinger Mail | No | `server/services/hostingerMail.ts:7`| Mailbox ID for interviews |
| `HOSTINGER_MAILBOX_FINANCE_ID`| Hostinger Mail | No | `server/services/hostingerMail.ts:7` | Mailbox ID for finance |
| `HOSTINGER_MAILBOX_PRIVACY_ID`| Hostinger Mail | No | `server/services/hostingerMail.ts:7` | Mailbox ID for privacy |
| `HOSTINGER_MAIL_WEBHOOK_SECRET`| Hostinger Mail | Yes | `server/services/hostingerWebhook.ts:13`| Secret for inbound webhook verification |
