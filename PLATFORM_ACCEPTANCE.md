# FreelanceHR platform acceptance record

This record covers the local platform state before deployment. External DNS, Hostinger hPanel, OIDC, webhook, and live outbound delivery are deliberately excluded from local acceptance.

| Workspace | Backend/procedure surface | Safety gate verified | UI state coverage | Local evidence |
| --- | --- | --- | --- | --- |
| Command Center | `operations.dashboard` | Read-only owner dashboard; queue and quota are informational | Loading shell, empty queue, visible safety alerts | Full Vitest suite, desktop/mobile route capture |
| Prospects | `recruitment.prospects.*`, email conversation queries | Client onboarding remains approval-controlled | Loading prospects, empty CRM, conversation empty state | Full Vitest suite, desktop/mobile route capture |
| Jobs | `recruitment.jobs.*` | Sourcing requires confirmed client requirement | Empty requisition state and disabled create action without company | Workflow tests, desktop/mobile route capture |
| Candidates | candidate, consent, screening, shortlist, document procedures | Consent, withdrawal, DNC, owner-controlled sharing, private document access | Loading directory, filters, empty state, responsive action wrap | 69 tests, private-storage tests, desktop/mobile route capture |
| Interviews | interview, feedback, calendar, reminder procedures | Reschedule/cancel and feedback remain auditable; reminders create drafts | Empty timeline, scheduling controls, calendar actions | Calendar/reminder tests, desktop/mobile route capture |
| Placements | placement and replacement procedures | Joining, guarantee, replacement, and final outcomes remain controlled | Empty placement ledger and guarded actions | Workflow/authorization tests, desktop/mobile route capture |
| Finance | invoice and consequential finance procedures | Invoice issue, payment, dispute, credit actions remain approval-controlled | Empty receivables and eligibility guidance | Workflow/authorization tests, desktop/mobile route capture |
| Exceptions | approvals, queue retry, rights requests, incidents | Owner decision and retry actions are explicit and auditable | Empty approval and incident states | Approval, queue, rights, and audit tests |
| Team & access | team overview, invite, role, revoke, accept | Owner-only administration; member routes remain permissioned | Membership/invitation empty states and mobile controls | 9 workspace-access tests, mobile route capture |
| Control Plane | settings, readiness, policies, queue, mail status, audits | Safe mode, emergency stop, structured AI, no autonomous final rejection | Loading control plane, readiness states, empty queue/policy/audit states | Full validation, desktop/mobile route capture |

## Acceptance result

The local platform build passes TypeScript validation, the complete Vitest suite, and the Hostinger production build. The owner dashboard routes render on desktop and mobile viewports. Missing deployment credentials are represented as readiness states rather than silently treated as active. No test or acceptance flow sends live email, changes a real external account, or performs an autonomous consequential decision.

## Remaining deployment prerequisites

The remaining work is external configuration: bind the production domain, select and configure the OIDC provider, set the Hostinger local storage path, configure the inbound webhook secret, confirm Hostinger mailbox resource IDs, and run deployed-domain login, private-document, inbound-webhook, and approval-gated delivery validation.
