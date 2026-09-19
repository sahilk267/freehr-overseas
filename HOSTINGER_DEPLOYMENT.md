# Hostinger Business Node.js Deployment

This document is the deployment handoff for `freelancehr.overseasjob.in`. Hostinger's Node.js application manager can host the React/Vite build and Node server, but shared hosting should not be treated as a permanent worker machine. The production design therefore processes a **small, bounded batch** per cron trigger and keeps automation state in MySQL.

## Required production decisions

The managed development template includes platform-specific authentication and storage helpers. They are not portable to a third-party host. Before a Hostinger launch, the following components must be supplied with production equivalents.

| Concern | Required production choice | Do not do this |
| --- | --- | --- |
| Authentication | OIDC provider, such as Google Workspace/Auth0/Clerk, with server-side session cookies | Do not deploy platform-specific preview OAuth credentials to Hostinger |
| Database | Hostinger MySQL or a managed MySQL-compatible database with TLS | Do not expose database credentials in the React application |
| Candidate documents | Private Hostinger filesystem path outside the public web root; S3-compatible storage remains an optional backup mode | Do not retain CVs in public web directories or database BLOBs, and do not expose the local storage directory through static hosting |
| AI | `OPENROUTER_API_KEY` held only in Node environment variables | Do not use `VITE_OPENROUTER_API_KEY` or call OpenRouter directly from browser code |
| Email | Hostinger Mail API bearer token, restricted mailbox resource IDs, webhook secret, and verified SPF/DKIM/DMARC | Do not enable mass outreach or invite delivery until API verification and controlled delivery tests pass |
| Calendar | Provider-free ICS export with UTC persistence, reschedule sequence, cancellation status, and controlled reminders | No Google/Microsoft credentials are required for the current release; external sync remains a future adapter |
| Payments | Payment/bank reconciliation provider or controlled manual ledger | Do not issue credit, write-off, or mark paid automatically |

## Deployment pipeline

The repeatable pipeline is **build → upload/deploy → configure environment → set Node startup → configure domain → run migration → verify health → enable restricted automation**. The repository declares pnpm 11.x to match Hostinger Corepack; do not force pnpm 10.x during hPanel installation. The default `pnpm build` and `pnpm start` commands now target the Hostinger Fastify artifact (`dist/hostinger.js`), so hPanel does not need a custom script name. Each action should run with a separate deployment account and audit record.

| Step | Action | Acceptance condition |
| --- | --- | --- |
| 1 | Create a Git repository or zip release from the audited project | No `.env` file, candidate document, local log, or test data is included |
| 2 | In hPanel, create a Node.js application for the subdomain | App root and startup command are configured |
| 3 | Let hPanel install dependencies with pnpm 11.x, then build with `pnpm build` | `dist/public` and `dist/hostinger.js` are created |
| 4 | Set server secrets in hPanel environment settings | Secrets are visible only to the Node runtime |
| 5 | Attach TLS-enabled MySQL and run Drizzle migrations once | Tables and indices are created without destructive changes |
| 6 | Point `freelancehr.overseasjob.in` to the Node application and enable SSL | HTTPS health endpoint is reachable |
| 7 | Configure a short Hostinger cron to invoke the bounded queue endpoint | One controlled job maximum per trigger during pilot |
| 8 | Keep automation in `safe` mode for pilot | Every external-facing action still requires explicit owner approval |

## Production startup guard

The production server intentionally **refuses to start** unless its OIDC and private-storage configuration is complete. This prevents a deployment from accidentally authenticating against the development integration or writing CVs to a non-portable storage path. Set `AUTH_MODE=oidc` and `VITE_AUTH_MODE=oidc` at build time, then configure the following values in hPanel before starting `pnpm start:hostinger`.

| Configuration group | Required values | Runtime behavior when absent |
| --- | --- | --- |
| OIDC login | `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `APP_BASE_URL`, `SESSION_SECRET`, and either `PRIMARY_OWNER_OPEN_ID` or `PRIMARY_OWNER_EMAIL` | Startup is blocked without exposing the missing secret value. |
| OIDC callback | `OIDC_REDIRECT_URI=https://freelancehr.overseasjob.in/api/auth/oidc/callback` registered exactly with the provider | Sign-in is rejected if state, nonce, PKCE, issuer, audience, or signature validation fails. |
| Private documents | `PRIVATE_STORAGE_MODE=local` and optional `PRIVATE_LOCAL_STORAGE_PATH` outside the public web root; use `PRIVATE_STORAGE_MODE=s3` plus S3 credentials only when backup/provider storage is activated | Local mode keeps documents behind the authenticated `/api/private-storage/*` route. Explicit S3 mode remains fail-closed until its credentials are configured. |

In local mode, the document table stores a non-public `local/...` reference outside the public web root. Access is granted through the authenticated owner-authorized `/api/private-storage/*` route, with a corresponding audit event. When S3 backup mode is activated, records instead use `private://s3/...` and short-lived signed URLs. Team roles cannot access the signed-document procedure.

## Initial owner-only testing mode

For the first private test, set `OWNER_ONLY_MODE=true`. This blocks protected routes for every authenticated account except the configured primary owner and does not create a public signup path. Keep team invitations and external access disabled. OIDC is a later scaling step; standalone production startup still requires the selected OIDC provider configuration before public deployment.

## Environment inventory

Never commit the values. Set these in the Hostinger application environment panel or equivalent secure secret manager. The `HOSTINGER_MAILBOX_*_ADDRESS` variables define the visible From identity, while the separate `HOSTINGER_MAILBOX_*_ID` variables must contain the resource identifiers accepted by the Hostinger Mail API. An email address may be valid for sender allowlisting but still be rejected as an API mailbox resource ID. If delivery returns a `mailboxResourceId` validation error, keep the matching `HOSTINGER_MAILBOX_*_ADDRESS` unchanged and replace only the matching `HOSTINGER_MAILBOX_*_ID` with the mailbox resource ID shown by Hostinger. Do not substitute the visible sender address into the resource-ID field.

```dotenv
NODE_ENV=production
PORT=<provided-by-hostinger>
DATABASE_URL=mysql://<user>:<password>@<host>:<port>/<database>?ssl={"rejectUnauthorized":true}
OPENROUTER_API_KEY=<server-side-only>
APP_BASE_URL=https://freelancehr.overseasjob.in
OWNER_ONLY_MODE=true
SESSION_SECRET=<at-least-32-random-bytes>
OIDC_ISSUER_URL=<selected-auth-provider>
OIDC_CLIENT_ID=<selected-auth-provider>
OIDC_CLIENT_SECRET=<selected-auth-provider>
STORAGE_BUCKET=<private-bucket-name>
STORAGE_REGION=<region>
STORAGE_ACCESS_KEY_ID=<server-side-only>
STORAGE_SECRET_ACCESS_KEY=<server-side-only>
PRIVATE_STORAGE_MODE=local
PRIVATE_LOCAL_STORAGE_PATH=<absolute-path-outside-public-web-root>
HOSTINGER_MAIL_API_TOKEN=<server-side-only>
HOSTINGER_MAIL_FROM_DOMAIN=overseasjob.in
HOSTINGER_MAILBOX_OWNER_ID=<Hostinger mailbox resource ID>
HOSTINGER_MAILBOX_CLIENTS_ID=<Hostinger mailbox resource ID>
HOSTINGER_MAILBOX_TALENT_ID=<Hostinger mailbox resource ID>
HOSTINGER_MAILBOX_INTERVIEWS_ID=<Hostinger mailbox resource ID>
HOSTINGER_MAILBOX_FINANCE_ID=<Hostinger mailbox resource ID>
HOSTINGER_MAILBOX_PRIVACY_ID=<Hostinger mailbox resource ID>
HOSTINGER_MAILBOX_OWNER_ADDRESS=owner.fl@overseasjob.in
HOSTINGER_MAILBOX_CLIENTS_ADDRESS=clients.fl@overseasjob.in
HOSTINGER_MAILBOX_TALENT_ADDRESS=talent.fl@overseasjob.in
HOSTINGER_MAILBOX_INTERVIEWS_ADDRESS=interviews.fl@overseasjob.in
HOSTINGER_MAILBOX_FINANCE_ADDRESS=finance.fl@overseasjob.in
HOSTINGER_MAILBOX_PRIVACY_ADDRESS=privacy.fl@overseasjob.in
HOSTINGER_MAIL_WEBHOOK_SECRET=<one-time webhook bearer secret>
```

## Team access and invitation safety

The `teamMembers` and `teamInvitations` migration introduces an **owner-managed, least-privilege** membership register. A pending invitation stores only a SHA-256 hash of its one-time code, has a fixed expiry, and is invalidated if the owner revokes the membership. The application currently creates auditable invitation records and displays a one-time code for manual secure sharing; it does **not** send invitation emails until the Hostinger Mail API is fully configured and verified.

| Role | Permitted scope | Always reserved for owner |
| --- | --- | --- |
| Recruiter | Prepare recruitment records, drafts, and approval requests | Candidate sharing, final disposition, client onboarding, external sends, placement and commercial decisions |
| Coordinator | Interview operations, notes, reminders drafts | All approvals, candidate/client external actions, policy changes |
| Finance | Finance evidence and controlled approval requests | Invoice issuance, payment/credit/dispute final state, external sends |
| Viewer | Read-only visibility after production shared-workspace authorization is implemented | All modifications and all approval controls |

For a **fresh production database**, apply the project migrations exactly once, including `0003_soft_blindfold.sql`. The development database received the additive team tables in dependency order because the generated first draft ordered its dependent foreign key before its referenced table; the checked-in production migration has the corrected order. Do not replay a migration against a database where its tables already exist.

## Automation and cron

The queue processor must never use `setInterval`, `node-cron`, or a long-running worker on shared hosting. A single authenticated cron invocation should claim one database record by lock token, verify the workspace emergency-stop flag, process a bounded task, write its structured result, and exit. The existing queue service follows those state and idempotency patterns. Configure the cron time in UTC and convert business schedules to `Asia/Kolkata` in the application interface.

During the first pilot, schedule only one low-risk task class, such as reply classification or CV extraction, and keep all outbound messages in draft. Do not schedule automated sending, client sharing, hiring outcomes, or invoice changes.

Interview reminders use the bounded Heartbeat callback `/api/scheduled/interview-reminders` at `0 */5 * * * *` UTC. The callback authenticates the platform task UID, resolves the owner through `workspaceSettings.scheduleCronTaskUid`, claims due confirmed interviews idempotently, and queues a `send_reminder` draft. It never sends an external email by itself; owner approval and the Hostinger Mail API activation remain required.

## Domain and HTTPS

In Hostinger hPanel, add `freelancehr.overseasjob.in` as a subdomain or Node application domain. Create the CNAME/A record required by the selected Hostinger app configuration and issue SSL after DNS propagation. Redirect HTTP to HTTPS, enable `Secure`, `HttpOnly`, and `SameSite` cookie attributes, and set the production CORS allowlist to only `https://freelancehr.overseasjob.in`.

## Pre-launch go/no-go

The system must not go live until the team has confirmed: the owner sign-in flow; production shared-workspace authorization for invited members; database backups and restoration test; private document access test; consent withdrawal and suppression test; OpenRouter quota/fallback failure test; built-in model catalog verification and free-model fallback test; owner approval test; Hostinger Mail API verification, controlled test delivery, webhook payload validation, and email opt-out handling; TLS verification; no secrets in frontend bundles; and the emergency-stop drill. A successful `pnpm check` and `pnpm test` are necessary but not sufficient for this production approval.
