# FreelanceHR

FreelanceHR is a private recruitment-operations workspace for controlled client acquisition, hiring intake, candidate management, evidence-based matching, interview coordination, placements, and revenue tracking. The React interface is backed by typed tRPC procedures, a MySQL workflow ledger, an owner approval queue, and a server-side OpenRouter AI adapter.

## Operating model

The application is deliberately designed as a **controlled automation system**, not a tool that sends messages or makes hiring decisions without accountability. The owner must approve client activation, candidate profile sharing, joining confirmation, and invoice issuance. AI can extract, classify, draft, and score evidence, but it cannot autonomously make a final candidate rejection.

| Layer | Implementation | Control principle |
| --- | --- | --- |
| Owner dashboard | React, Vite, TypeScript, Tailwind | Responsive workspaces with visible workflow states |
| API | tRPC procedures | Protected, typed application contracts |
| Data | MySQL with Drizzle schema | Source provenance, consent, approvals, audit events, and state transitions |
| AI | Server-side OpenRouter adapter | Free-model routing, JSON validation, quota/error recording, fallback models |
| Automation | Database queue | Idempotency key, bounded execution, retry/backoff, visible failure routing |
| Document handling | Private storage references | File-type/size validation, provenance, parsing status, no browser-exposed storage credentials |

## Implemented workspaces

The dashboard includes Command Center, Prospects, Jobs, Candidates, Follow-ups, Interviews, Placements, Finance, Exceptions, and Control Plane. All user-created operational records are saved in the database; the product deliberately starts with no fabricated candidate, client, review, or placement data.

## Workflow guardrails

Candidate profiles begin as `consent_pending`. Candidate sharing requires purpose-specific client-sharing consent for the selected job/client pair and then requires an owner approval. Withdrawal revokes granted consent and creates email suppression when a hashed email identifier is present. Recruitment matching records evidence and uncertainty; it does not expose an autonomous reject action.

Follow-up sequences support versioned editing/restart, snooze, history and owner evidence recovery for uncertain delivery. They start in owner review; the owner can delegate only their exact messages, recipient, count and expiry. Outbound work is drafted and queued. An external email provider integration must be configured before actual sending is enabled. Calendar synchronization, payment rails, and external candidate-source APIs likewise need explicit credentials and owner-approved integration setup; they are intentionally not simulated.

Finance includes receivable aging, owner-opted-in overdue collection sequences, payment promises, partial-receipt balances and collection holds. A client promise never counts as payment. Pending disputes/adjustments freeze collection, and AI reconciliation remains advisory. Collection messages use the same Follow-ups review, authorization and delivery path.

## Local development

Automation implementation is underway. See [implementation progress](docs/IMPLEMENTATION_PROGRESS.md) for verified fixes and remaining gaps, and [the module master plan](docs/freehr-module-master-plan.md) for the approved advanced scope. The complete autonomous recruitment workflow is not yet implemented.

```bash
pnpm install
pnpm check
pnpm test
pnpm dev
```

The managed development version uses the supplied authentication and private storage facilities. For Hostinger, follow [the deployment steps](OWNER_HOSTINGER_DEPLOYMENT_STEPS.md). The production entry is root `server.js`, started by `npm start` or Hostinger's `node server.js`; it loads the compiled server after `npm run build`. An empty phpMyAdmin database can be initialized with the [generated migration import](deploy/hostinger-empty-database.sql). `npm run env:hostinger` prepares Git-ignored `.env.hostinger` with the [production defaults](deploy/hostinger.env.example) and separate generated local secrets. Fill the remaining real database/OIDC values privately before importing it in hPanel; repeat preparation preserves existing secrets.

For persistent follow-ups, apply `pnpm db:migrate` through 0014 to the intended database, then run `pnpm worker` alongside the API with the same MySQL `DATABASE_URL`. The standalone worker refuses an in-memory adapter and reports missing collection tables. See [implementation progress](docs/IMPLEMENTATION_PROGRESS.md) for verified behavior and remaining limits.

## Test coverage

The test suite covers authenticated session logout, OpenRouter credential validation, invalid workflow transitions, prohibited recruiting prompts, consequential-action classification, strict AI JSON validation, and required outreach safeguards.
