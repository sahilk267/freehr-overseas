# FreelanceHR Implementation TODO

- [x] Define the portable React/Vite, Fastify/tRPC, MySQL, Hostinger Node.js, and OpenRouter architecture decisions in project documentation.
- [x] Create complete Drizzle schema for policies, CRM, job requisitions, candidates, consent, messages, interviews, placements, invoices, automation, approvals, audit events, suppression, rights requests, and incidents.
- [x] Generate and apply one database migration for the complete first-release schema.
- [x] Implement protected tRPC routers for dashboard analytics, policies, prospects/clients, jobs, candidates, consent, screening, matching, shortlists, interviews, placements, invoices, approvals, exceptions, and operations.
- [x] Enforce owner-controlled consequential actions, including client onboarding, candidate sharing, final candidate decisions, placement confirmation, invoice issuance, disputes, credits, and automation stopping.
- [x] Implement immutable audit-event helpers and append audit events for every workflow state transition and consequential action.
- [x] Implement explicit workflow state-transition validation for prospects, jobs, candidates, screenings, shortlists, interviews, placements, invoices, automation jobs, rights requests, and incidents.
- [x] Implement a database-backed automation queue with idempotency keys, retry/backoff state, bounded batch execution, and permanent-failure routing.
- [x] Implement an OpenRouter server-side adapter contract with environment-based credentials, model registry, structured JSON validation, safe error handling, quota tracking, retry behavior, and fallback-model support.
- [x] Implement consent, withdrawal, do-not-contact suppression, client-sharing approval, correction, and deletion-request workflows.
- [x] Implement document metadata, secure upload validation hooks, provenance, CV parsing status, and controlled sharing fields.
- [x] Build a responsive dashboard layout using the template DashboardLayout component and add navigation for Command Center, Prospects, Jobs, Candidates, Interviews, Placements, Finance, Exceptions, and Policies.
- [x] Build the Command Center page with live pipeline counts, queue health, AI quota status, upcoming interviews, invoice ageing, and safety alerts.
- [x] Build prospect/client CRM workspace with lead stages, source provenance, outreach status, reply classification, discovery notes, fee proposal state, and onboarding approval controls.
- [x] Build job-requisition workspace with structured intake, requirement-quality checks, weighted scorecard criteria, explicit client confirmation, and sourcing states.
- [x] Build candidate workspace with searchable profiles, source/provenance, consent status, CV workflow, screening evidence, match status, withdrawal, and do-not-contact actions.
- [x] Build explainable matching and shortlist workspace with rule-plus-semantic evidence placeholders, low-confidence routing, and controlled client-share approvals.
- [x] Build interview scheduling and feedback workspace with status transitions, reminders, rescheduling, attendance, scorecards, and immutable raw-feedback presentation.
- [x] Build placement, guarantee, replacement, invoice, payment-status, and dispute workspaces with approval states.
- [x] Build policy, approval, audit-log, exception-center, and emergency-stop control-plane workspaces.
- [x] Create test-safe seed/demo records that are plainly marked as operational samples and contain no fabricated reviews, ratings, or testimonials.
- [x] Add Vitest coverage for core state transitions, consent gating, audit event creation, approval-required actions, queue idempotency, and OpenRouter response validation.
- [x] Validate TypeScript, run unit tests, and resolve all application build errors.
- [x] Verify the desktop and mobile dashboard through screenshots and improve visible layout/accessibility issues.
- [x] Write Hostinger Business Node.js deployment documentation, environment-variable inventory, domain configuration steps for freelancehr.overseasjob.in, and cron/queue guidance.
- [x] Read the complete TODO list, confirm all completed items are marked accurately, save a final project checkpoint, and deliver the project summary.
- [x] Implement and verify OpenRouter daily quota budgets and status calculations, then surface them in Command Center.
- [x] Add weighted scorecard criteria fields and persistence to the job-intake workflow.
- [x] Add candidate search and filter controls with a typed backend query procedure.
- [x] Complete and verify policy management, audit-log, and exception-center workspaces plus their backing procedures.
- [x] Extend audit coverage verification for all consequential workflows, including disputes, credits, and final candidate-decision controls.
- [x] Add a complete screening router/workspace with list, detail, state, evidence, and owner-decision procedures, plus a dedicated shortlist query/update surface.
- [x] Implement correction and deletion-request fulfillment: resolve rights requests, apply candidate profile corrections, perform tracked deletion, and expose the workflow in the control plane.
- [x] Expose outreach conversations, reply classifications, discovery notes, and fee proposal states/actions inside the prospect CRM workspace.
- [x] Add interview no-show and attendance controls, plus immutable raw-feedback history in the interview workspace.
- [x] Complete placement, guarantee, invoice-eligible, and approval-state progression controls across placement and finance workspaces.
- [x] Add Vitest coverage for consent gates, audit-event writes, approval-required mutations, and queue idempotency.
- [x] Verify the final dashboard in desktop and mobile viewports and resolve confirmed accessibility or responsive-layout issues.
- [x] Add audit-flow assertions for disputes, credits, and final candidate-decision approvals.
- [x] Add screening detail and owner-decision UI, plus full shortlist update/state controls.
- [x] Expose rights-request correction and deletion fulfillment actions in the exception center.
- [x] Add candidate filter controls for profile state, source, availability, and do-not-contact/withdrawn records, with typed backend filtering.
- [x] Add configurable domain sender identities for owner, clients, talent, interviews, finance, and privacy mailboxes.
- [x] Implement a server-side SMTP transport contract, encrypted credential use, connection health check, and no-secret logging rules.
- [x] Implement approval-gated message sending, message lifecycle transitions, delivery-failure handling, recipient suppression checks, and audit records.
- [x] Add inbound-email intake contract with mailbox polling/webhook adapter, thread matching, reply classification queueing, opt-out detection, and exception routing.
- [x] Build email identity, sender-health, outbound approval, and conversation-history views in the owner workspace.
- [x] Add a message-level conversation history view with direction, subject, timestamps, status, and provider identifiers.
- [x] Add an email-approval detail view with approval reason, payload, current status, and linked message context.
- [x] Add typed-query and test coverage for email message history and email approval detail retrieval.
- [x] Display the email-approval payload safely in the owner approval-detail panel and cover payload retrieval in tests.
- [x] Add unit tests for sender allowlists, suppression enforcement, approval-before-send, inbound thread correlation, and opt-out handling.
- [x] Add an owner-scoped email message-history query test.
- [x] Add a controlled-delivery test proving outbound send fails without an approved email action.
- [x] Write the Hostinger email credential, SPF, DKIM, DMARC, forwarding, and mail-reception configuration handoff for freelancehr.overseasjob.in.
- [x] Read the email integration TODO items, verify completed work, save a checkpoint, and deliver the next-phase summary.
- [x] Validate the live SMTP connection, sender identities, and mail-reception access after the user supplies Hostinger credentials. Superseded by the Hostinger Mail API activation task.
- [x] Add an auditable SMTP transport verification procedure that persists sender health status. Superseded by Hostinger Mail API token verification.
- [x] Add outbound SMTP failure routing with message status updates, exception creation, and audit events. Superseded by Hostinger Mail API delivery-failure routing.
- [x] Add unit coverage for mail-transport verification and SMTP failure transitions. Superseded by Hostinger Mail API readiness coverage.
- [x] Replace the SMTP/IMAP client with a Hostinger Mail API client using only server-side API credentials and configurable endpoint paths.
- [x] Replace sender verification, approved delivery, and inbound message intake with Hostinger Mail API request and event-adapter contracts.
- [x] Rename the control-plane mail health and configuration language from SMTP/IMAP to Hostinger Mail API.
- [x] Update tests and Hostinger deployment documentation for Hostinger Mail API credentials, endpoint paths, sender verification, and inbound webhooks/events.
- [ ] Validate the live Hostinger Mail API connection, sender identities, outbound approval flow, and inbound events after the user provides API access details.
- [x] Receive the Hostinger Mail API token, mailbox resource IDs, and webhook secret through secure configuration when the user is ready.
- [x] Implement a Hostinger Mail API inbound webhook endpoint with secret validation, provider-payload normalization, and safe malformed-event handling.
- [x] Enqueue accepted inbound replies for controlled classification and persist a corresponding audit event.
- [x] Add tests for Hostinger inbound webhook validation, provider-thread correlation, malformed-event routing, and classification-queue creation.
- [x] Add persistence-level tests that assert matched Hostinger inbound events create classification jobs and audit records.
- [x] Add webhook tests for unmatched-event incident routing and safe accepted responses.
- [x] Enforce owner, recruiter, coordinator, finance, and read-only team roles with explicit controlled-action permissions across workspace workflows.
- [x] Add team membership and invitation tables with scoped status, expiry, revocation, and audit fields.
- [x] Reconcile and record the non-destructive team-access migration in Drizzle tracking for safe existing and fresh-environment deployment.
- [x] Implement protected team management procedures for invite creation, membership activation, role update, revocation, and activity listing.
- [x] Build a responsive Team & access workspace with member status, invitation controls, role summaries, revocation, and recent member activity.
- [x] Prevent live invite delivery until the Hostinger Mail API activation is complete; create only auditable invitation records meanwhile.
- [x] Add unit tests for owner-only team administration, role guardrails, invitation expiry, revocation, and audit events.
- [x] Add team-access documentation and run TypeScript, Vitest, production-build, desktop, and mobile validation.
- [x] Implement workspace membership resolution and role-based authorization across protected routers so displayed role permissions are actually enforced.
- [x] Add role-permission tests for recruitment preparation, coordinator operations, finance preparation, viewer read-only behavior, and owner-only consequential actions.
- [x] Add an integration test proving a team member receives a forbidden response from a real owner-only consequential recruitment procedure.
- [x] Read the team-access TODO items, save a checkpoint, and deliver the implementation status.
- [x] Complete portable OIDC session lifecycle behavior, including logout cookie invalidation, before deploying to Hostinger.
- [x] Add a dual-mode private document-storage adapter that uses project-managed storage only in development and S3-compatible private storage in production.
- [x] Add signed private document retrieval with server-side workspace ownership checks and no public object URLs.
- [x] Add production authentication configuration validation and fail-closed startup checks without selecting or activating an OIDC provider.
- [x] Complete portable session/authentication interfaces that preserve development login and correctly invalidate future OIDC sessions on logout.
- [x] Add test coverage for production configuration guards and private document access rules.
- [x] Update the Hostinger deployment handoff with concrete OIDC, session, S3-compatible storage, and migration activation steps.
- [x] Save a Hostinger-readiness checkpoint after the completed OIDC session invalidation validation.
- [x] Clear the production OIDC session cookie on logout and add specific OIDC logout coverage.
- [ ] Configure the chosen OIDC provider and private S3-compatible storage credentials in Hostinger hPanel, then run deployed-domain login and signed-document tests.

## Repository Delivery

- [x] Create the requested Git commit.
- [x] Push the commit to the configured remote, verify the remote branch, and report any remaining local changes.

## New Remote Repository Delivery

- [x] Inspect available Git provider connections and confirm the remote repository owner and name.
- [x] Create the new remote repository for FreelanceHR through the supported provider flow.
- [x] Update the local origin remote and push the `main` branch without exposing credentials.
- [x] Verify the remote repository URL, pushed revision, and clean worktree.
- [x] Report the new repository path and push status.

## Remaining Implementation

- [x] Implement provider-free interview calendar events and deterministic ICS export.
- [x] Integrate calendar export, reminders, reschedule, cancellation, and audit controls.
- [x] Verify the live built-in model catalog and configure the safest free-model routing with OpenRouter fallback.
- [x] Add tests and documentation for calendar and free-model safeguards.
- [x] Run full validation and save the remaining-implementation checkpoint.

## External Configuration Prerequisites

- [ ] Configure OIDC/private storage in Hostinger and run deployed-domain tests.
- [ ] Supply and validate Hostinger Mail API credentials and webhook events.

## Hostinger Local Storage Mode

- [x] Make private local filesystem storage configurable for Hostinger as the current primary document store.
- [x] Preserve S3-compatible storage as an explicit optional backup mode, not a required startup dependency in local mode.
- [x] Add local-storage path safety, upload/retrieval tests, and update the Hostinger handoff documentation.

## Hostinger Mail Identity Update

- [x] Update the six Hostinger mailbox sender addresses supplied by the owner.
- [x] Request and securely store the Hostinger Mail API token without exposing it in chat or source control.
- [x] Verify the mail adapter contract and document that live API calls require Hostinger mailbox resource IDs if the API rejects plain addresses.

## Mail Sender Identity Separation

- [x] Add explicit per-purpose Hostinger sender-address configuration for the six supplied .fl addresses.
- [x] Separate sender email addresses from Hostinger mailbox resource IDs in outbound delivery and status reporting.
- [x] Add tests and documentation for sender-address allowlists and resource-ID compatibility.

## Hostinger Resource-ID Compatibility

- [x] Add a focused delivery test proving sender address and mailbox resource ID are passed separately.
- [x] Add a documented rejection/remediation test path for plain email values used where Hostinger requires mailbox resource IDs.

## Platform Completion Acceptance

- [x] Audit every owner dashboard workspace against its backend procedure, loading state, empty state, error state, and approval gate.
- [x] Audit every consequential action for owner-only authorization, consent/suppression checks, immutable audit evidence, and safe failure behavior.
- [x] Audit configuration/status surfaces so missing external credentials are clearly represented without blocking local platform development.
- [x] Run end-to-end local acceptance checks for CRM, jobs, candidates, screening, interviews/calendar, placements/finance, team access, approvals, exceptions, mail, AI, and private documents.
- [x] Complete final UI accessibility and responsive verification for all dashboard workspaces before deployment.

- [x] Fix mobile overflow in the Candidates action controls so Upload CV, Record match, and Add candidate remain fully reachable at narrow widths.

- [x] Update Control Plane sender identity cards and reply-to defaults to use the six configured `.fl@overseasjob.in` addresses.

## Acceptance Evidence Follow-up

- [x] Perform a documented workspace-by-workspace QA checklist covering procedure wiring, loading, empty, error, and approval-gate states for Command Center, Prospects, Jobs, Candidates, Interviews, Placements, Finance, Exceptions, Team, and Control Plane.
- [x] Create or expand focused validations for each consequential action covering owner-only authorization, consent/suppression enforcement, audit-event creation, and safe failure.
- [x] Add explicit UI status indicators for missing OIDC, private-storage, webhook, and mail configuration without blocking local development.
- [x] Run and record concrete local acceptance flows for CRM, jobs, candidates, screening, interviews/calendar, placements/finance, team access, approvals, exceptions, mail, AI, and private documents.

## Hostinger Database Handoff

- [x] Add a safe database-import guide covering Hostinger MySQL creation, DATABASE_URL formatting, migration order, and verification.
- [x] Document production startup checks and a non-destructive schema verification query.
- [x] Validate the handoff documentation against the checked-in migration directory and Hostinger build.

## OAuth Owner Workspace Regression

- [x] Trace the successful-login 403 path from session identity through workspace resolution and owner approval checks.
- [x] Fix development owner bootstrap or workspace selection without weakening production owner/RBAC enforcement.
- [x] Add regression coverage proving the configured owner reaches the Command Center after login.
- [x] Verify the local preview dashboard loads after the fix.

## Local Demo Validation

- [x] Run the existing explicitly fictional, owner-scoped demo seed against the local development database only.
- [x] Verify the seeded prospect, candidate, and job appear in the owner workspace without sending email or triggering external automation.
- [x] Document the generated demo IDs and cleanup guidance.

- [x] Fix the demo seed’s MySQL TLS parsing so it works with the project’s secure TiDB/Hostinger DATABASE_URL format without weakening transport security.

## Git Push and Owner Deployment Handoff

- [x] Audit the current worktree, remote branch, ignored secrets, and deployment documentation before pushing.
- [x] Commit and push the latest platform-complete state to `sahilk267/freehr-overseas`.
- [x] Verify the remote revision and prepare a detailed secret-safe Hostinger deployment checklist for the owner.

## Hostinger pnpm Compatibility Fix

- [x] Align package-manager metadata and lockfile expectations with Hostinger’s Corepack pnpm runtime.
- [x] Re-run install, TypeScript, tests, and Hostinger build after the compatibility fix.
- [x] Push the fix and update the owner deployment guide with the corrected Hostinger settings.

## Owner-Only Testing Phase

- [x] Disable public signup and external-user access for the current testing phase.
- [x] Keep only the configured primary owner allowed to use the application in test mode.
- [x] Preserve OIDC and team-access configuration as a later opt-in, not a current prerequisite.
- [x] Add automated coverage and deployment guidance for owner-only testing.
- [x] Apply owner-only enforcement to direct authenticated requests and OIDC user provisioning, not only tRPC workspace routes.

## Hostinger Deployment Failure Follow-up

- [x] Compare the pasted Hostinger build command and artifacts with the repository’s intended Hostinger build/start commands.
- [x] Resolve any deployment command or runtime artifact mismatch and preserve the pnpm 11 compatibility fix.
- [x] Re-run TypeScript, tests, and Hostinger build validation, then update the owner handoff with the exact hPanel command.
