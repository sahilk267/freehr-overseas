# FreelanceHR platform acceptance record

Current implementation status and validation evidence are maintained in [implementation progress](docs/IMPLEMENTATION_PROGRESS.md). The workspace inventory below is historical coverage, not acceptance of the advanced autonomous-recruitment roadmap.

This record covers the local platform state before deployment. External DNS, Hostinger hPanel, OIDC, webhook, and live outbound delivery are deliberately excluded from local acceptance.

| Workspace | Backend/procedure surface | Safety gate verified | UI state coverage | Local evidence |
| --- | --- | --- | --- | --- |
| Command Center | `operations.dashboard` | Read-only owner dashboard; queue and quota are informational | Loading shell, empty queue, visible safety alerts | Full Vitest suite, desktop/mobile route capture |
| Prospects | `recruitment.prospects.*`, email conversation queries | Client onboarding remains approval-controlled | Loading prospects, empty CRM, conversation empty state | Full Vitest suite, desktop/mobile route capture |
| Jobs | `recruitment.jobs.*` | Sourcing requires confirmed client requirement | Empty requisition state and disabled create action without company | Workflow tests, desktop/mobile route capture |
| Candidates | candidate, consent, screening, shortlist, document procedures | Consent, withdrawal, DNC, owner-controlled sharing, private document access | Loading directory, filters, empty state, responsive action wrap | 69 tests, private-storage tests, desktop/mobile route capture |
| Follow-ups | `followups.*`, shared gateway/outbox and persistent worker | Exact-message review or scoped delegation; reply/withdrawal/schedule/payment revalidation; single-use dispatch claims | Create, review, grant/revoke, pause/resume, versioned restart/history, snooze and owner-evidence recovery with preserved drafts | Workflow tests, real MySQL concurrency, Chromium owner journey |
| Interviews | interview, feedback, calendar, reminder procedures | Reschedule/cancel and feedback remain auditable; reminders create drafts | Empty timeline, scheduling controls, calendar actions | Calendar/reminder tests, desktop/mobile route capture |
| Placements | placement and replacement procedures | Joining, guarantee, replacement, and final outcomes remain controlled | Empty placement ledger and guarded actions | Workflow/authorization tests, desktop/mobile route capture |
| Finance | invoice, collections and consequential finance procedures | Owner-controlled collection intent; promises remain separate from receipts; financial-review holds; exact-message sending authority | Aging ledger, partial receipts, promise/history, collection settings, failed-draft preservation and explicit reload | Workflow tests, real MySQL concurrency, Chromium desktop/mobile Finance journey |
| Exceptions | approvals, queue retry, rights requests, incidents | Owner decision and retry actions are explicit and auditable | Empty approval and incident states | Approval, queue, rights, and audit tests |
| Team & access | team overview, invite, role, revoke, accept | Owner-only administration; member routes remain permissioned | Membership/invitation empty states and mobile controls | 9 workspace-access tests, mobile route capture |
| Control Plane | settings, readiness, policies, queue, mail status, audits | Safe mode, emergency stop, structured AI, no autonomous final rejection | Loading control plane, readiness states, empty queue/policy/audit states | Full validation, desktop/mobile route capture |

## Acceptance result

The W0/W1/W2/W3 increments have 355 passed and 13 skipped default-suite checks; 95 real MySQL checks pass separately. W3 adds 24 collection scenarios, including concurrent commands and source-scan fairness. Current TypeScript, build, Hostinger, migration, worker and browser evidence is maintained in the linked progress record. Fresh/repeated migrations through 0014 pass. These increment labels do not certify the broader master-plan delivery waves. Complete provider integration and autonomous recruitment remain open; regression email sends are mocked and payment receipts are synthetic.

## Remaining deployment prerequisites

Both implementation and external configuration remain. The central follow-up/scoped-grant/outbox foundation is implemented. Follow the module master plan for remaining lifecycle triggers, advanced cadence, provider-correlated reconciliation and crash fencing, durable workflow operations, portals, sourcing, commercial obligations and verified collections. Production domain/OIDC, storage, mailboxes, webhooks, schedules and provider credentials also need configuration and live validation; credentials alone do not complete the missing functionality.
