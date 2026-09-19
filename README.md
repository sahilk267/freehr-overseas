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

The dashboard includes Command Center, Prospects, Jobs, Candidates, Interviews, Placements, Finance, Exceptions, and Control Plane. All user-created operational records are saved in the database; the product deliberately starts with no fabricated candidate, client, review, or placement data.

## Workflow guardrails

Candidate profiles begin as `consent_pending`. Candidate sharing requires purpose-specific client-sharing consent for the selected job/client pair and then requires an owner approval. Withdrawal revokes granted consent and creates email suppression when a hashed email identifier is present. Recruitment matching records evidence and uncertainty; it does not expose an autonomous reject action.

Outbound work is drafted and queued, not silently delivered. An external email provider integration must be configured before actual sending is enabled. Calendar synchronization, payment rails, and external candidate-source APIs likewise need explicit credentials and owner-approved integration setup; they are intentionally not simulated.

## Local development

```bash
pnpm install
pnpm check
pnpm test
pnpm dev
```

The managed development version uses the supplied authentication and private storage facilities. See `HOSTINGER_DEPLOYMENT.md` before transferring it to Hostinger, because a non-managed deployment requires equivalent production credentials for authentication, storage, database, and outbound communication.

## Test coverage

The test suite covers authenticated session logout, OpenRouter credential validation, invalid workflow transitions, prohibited recruiting prompts, consequential-action classification, strict AI JSON validation, and required outreach safeguards.
