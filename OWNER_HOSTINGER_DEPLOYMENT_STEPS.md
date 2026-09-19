# FreelanceHR: Owner Deployment Guide for Hostinger

This guide explains how to move the already-tested FreelanceHR project from GitHub to Hostinger Business Node.js hosting. The repository is private and contains application code only. **Never paste API keys, passwords, OIDC client secrets, database passwords, or webhook secrets into GitHub, chat, screenshots, or frontend code.** Add them only through Hostinger’s server-side environment-variable panel.

## 1. What is ready and what is not

The current local platform checkpoint is validated with TypeScript, 72 automated tests, the Hostinger production build, owner login, the Command Center, the Jobs workspace, local private storage, and fictional demo records. The GitHub repository is `https://github.com/sahilk267/freehr-overseas.git`, branch `main`.

The following activities must still be performed in Hostinger: create the production MySQL database, configure the Node.js application, add production environment variables, apply migrations, bind `freelancehr.overseasjob.in`, configure the selected OIDC provider, and perform live Hostinger Mail API tests. Do not mark production as ready until those checks pass.

## 2. Create the Hostinger Node.js application

Open Hostinger hPanel and create a Node.js application under the Business hosting plan. Use the GitHub repository `sahilk267/freehr-overseas` and the `main` branch. If hPanel asks for an application root, use the directory into which the repository is cloned. Do not deploy from a directory containing `.env` files, local logs, candidate documents, or generated private-storage files.

Use the repository’s package manager and scripts. Hostinger should use its pnpm 11.x runtime; do not force pnpm 10.x because the project metadata is aligned with Hostinger Corepack. The repository’s default commands now target the Hostinger Fastify artifact directly, so use these hPanel settings:

Build command:

```bash
pnpm build
```

Startup command:

```bash
pnpm start
```

If hPanel has a separate dependency-install field, use `pnpm install --frozen-lockfile`; do not combine that install command into the build field if hPanel installs dependencies automatically.

Do not hardcode the port. Hostinger supplies the runtime `PORT` value. If hPanel has separate install, build, and start fields, place the commands in their corresponding fields. If hPanel accepts one build command, use the combined command above.

## 3. Create the production MySQL database

In hPanel, open **Databases → MySQL Databases** and create a database and database user. Record the exact host, database name, username, password, and port supplied by Hostinger. Do not assume that the website domain is the database host.

The server-side connection variable must have this shape:

```dotenv
DATABASE_URL=mysql://<DB_USER>:<URL_ENCODED_PASSWORD>@<DB_HOST>:<DB_PORT>/<DB_NAME>?ssl={"rejectUnauthorized":true}
```

URL-encode reserved password characters such as `@`, `#`, `/`, `:`, `%`, `?`, and spaces. Do not prefix this variable with `VITE_`, because browser-exposed variables are unsafe for database credentials.

The database schema is represented by `drizzle/schema.ts`. The checked-in migration files are the source of truth:

```text
drizzle/0000_massive_shinobi_shaw.sql
drizzle/0001_daffy_katie_power.sql
drizzle/0002_white_firelord.sql
drizzle/0003_soft_blindfold.sql
drizzle/0004_abandoned_hulk.sql
drizzle/0005_talented_gauntlet.sql
drizzle/0006_drop_invoice_placement_unique.sql
drizzle/0007_add_automation_cron_task_uid.sql
drizzle/0008_add_approval_decision_source.sql
```

After `DATABASE_URL` is available to the server environment, run this once from the project root:

```bash
pnpm install --frozen-lockfile
pnpm exec drizzle-kit migrate
```

If hPanel only provides phpMyAdmin, import the nine files in the order shown above. Do not replay a migration that is already recorded as applied, and do not drop tables to solve a migration error. For a non-destructive verification, run:

```sql
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME;
```

The result should include the FreelanceHR tables such as `users`, `workspaceSettings`, `teamMembers`, `companies`, `jobs`, `candidates`, `interviews`, `placements`, `invoices`, `automationQueue`, `approvals`, and `auditEvents`.

## 4. Add production environment variables

For the first private test, set `OWNER_ONLY_MODE=true`. This does not create a signup flow and blocks every authenticated account except the configured primary owner from protected application routes. Keep team invitations and external access disabled. OIDC can remain a later activation step; do not invent OIDC values just to begin local owner testing.


In the Hostinger Node.js application’s environment settings, add the following variables. Replace every placeholder with a real value from Hostinger or the selected provider. Do not commit this list with values into GitHub.

```dotenv
NODE_ENV=production
PORT=<Hostinger-provided-port>
DATABASE_URL=mysql://<user>:<encoded-password>@<host>:<port>/<database>?ssl={"rejectUnauthorized":true}
APP_BASE_URL=https://freelancehr.overseasjob.in
SESSION_SECRET=<at-least-32-random-bytes>
PRIMARY_OWNER_EMAIL=owner.fl@overseasjob.in
OPENROUTER_API_KEY=<server-side-only>

AUTH_MODE=oidc
VITE_AUTH_MODE=oidc
OIDC_ISSUER_URL=<selected-provider-issuer>
OIDC_CLIENT_ID=<selected-provider-client-id>
OIDC_CLIENT_SECRET=<selected-provider-client-secret>
OIDC_REDIRECT_URI=https://freelancehr.overseasjob.in/api/auth/oidc/callback

PRIVATE_STORAGE_MODE=local
PRIVATE_LOCAL_STORAGE_PATH=<absolute-path-outside-public-web-root>

HOSTINGER_MAIL_API_TOKEN=<server-side-only>
HOSTINGER_MAIL_FROM_DOMAIN=overseasjob.in
HOSTINGER_MAILBOX_OWNER_ID=<Hostinger-resource-id>
HOSTINGER_MAILBOX_CLIENTS_ID=<Hostinger-resource-id>
HOSTINGER_MAILBOX_TALENT_ID=<Hostinger-resource-id>
HOSTINGER_MAILBOX_INTERVIEWS_ID=<Hostinger-resource-id>
HOSTINGER_MAILBOX_FINANCE_ID=<Hostinger-resource-id>
HOSTINGER_MAILBOX_PRIVACY_ID=<Hostinger-resource-id>
HOSTINGER_MAILBOX_OWNER_ADDRESS=owner.fl@overseasjob.in
HOSTINGER_MAILBOX_CLIENTS_ADDRESS=clients.fl@overseasjob.in
HOSTINGER_MAILBOX_TALENT_ADDRESS=talent.fl@overseasjob.in
HOSTINGER_MAILBOX_INTERVIEWS_ADDRESS=interviews.fl@overseasjob.in
HOSTINGER_MAILBOX_FINANCE_ADDRESS=finance.fl@overseasjob.in
HOSTINGER_MAILBOX_PRIVACY_ADDRESS=privacy.fl@overseasjob.in
HOSTINGER_MAIL_WEBHOOK_SECRET=<long-random-webhook-secret>
```

The six `*_ADDRESS` variables are visible sender identities. The six matching `*_ID` variables must contain the Hostinger Mail API mailbox resource IDs. Do not put an email address into an `*_ID` variable if Hostinger’s API expects a numeric or provider-specific resource ID.

The private storage path must be outside the public web root. A safe Hostinger example is a private application directory supplied by hPanel, not `public_html`, not `client/public`, and not a static-assets directory. The application serves local private documents only through an authenticated owner-authorized route.

## 5. Configure OIDC later, only when scaling beyond the owner

OIDC is not required for the initial owner-only test. Leave the OIDC variables unset only in an environment that still uses the existing preview/development authentication. Before using a standalone Hostinger production deployment, select an OIDC provider and complete the provider setup below; production startup validation will then require the OIDC values.


Choose one OIDC provider that supports authorization-code flow with PKCE. In that provider, register this exact callback URL:

```text
https://freelancehr.overseasjob.in/api/auth/oidc/callback
```

Set the issuer URL, client ID, client secret, redirect URI, and session secret in hPanel. Set the provider’s allowed origin or application URL to:

```text
https://freelancehr.overseasjob.in
```

The `PRIMARY_OWNER_EMAIL` value is currently `owner.fl@overseasjob.in`. The provider account used by the owner must have that email, or the owner identity must be mapped using the corresponding `PRIMARY_OWNER_OPEN_ID`. Do not use the local Manus preview OAuth settings in production.

## 6. Configure the domain and HTTPS

In hPanel, bind `freelancehr.overseasjob.in` to the Node.js application. If Hostinger requests DNS changes, add exactly the CNAME or A record shown by hPanel. Wait for DNS propagation, issue SSL, and force HTTP to HTTPS. The application should ultimately open at:

```text
https://freelancehr.overseasjob.in
```

Do not treat a DNS error as an application error. First confirm that the domain resolves to the Hostinger Node.js application, then test the HTTPS application.

## 7. Start in safe mode

After the first production start, keep automation in safe mode. Confirm the following manually before enabling any low-risk cron task:

| Check | Expected result |
| --- | --- |
| Owner sign-in | OIDC login returns to the dashboard without a 401/403 |
| Command Center | Pipeline cards load and owner controls are visible |
| Database | Core tables and migration ledger exist |
| Private documents | A private file is inaccessible from the public URL and accessible only through the authenticated route |
| Mail status | Token, six sender addresses, six resource IDs, and webhook status are visible without exposing secrets |
| Approval gates | Consequential actions remain pending until the owner approves |
| Suppression | Do-not-contact and withdrawn records block outreach |
| Calendar | ICS export, reschedule sequence, cancellation, and reminder draft behavior work |
| AI | OpenRouter quota and structured-response validation work; no browser API key exists |
| Emergency stop | Safe mode prevents external sends and other consequential automation |

Do not send a client or candidate email during the first test. First send one controlled test only to `owner.fl@overseasjob.in` after confirming the approval record, mailbox resource ID, and sender address. Then inspect the Hostinger Mail API delivery result and audit event. Only after that should you post one controlled inbound webhook test and verify its secret validation, thread correlation, classification queue, and audit record.

## 8. Configure the bounded reminder schedule

The provider-free interview reminder callback is:

```text
POST /api/scheduled/interview-reminders
```

It must be invoked with the platform Heartbeat task UID and should run as a bounded UTC schedule. The callback creates reminder drafts only; it never sends an external email by itself. Keep the first pilot limited to low-risk processing and leave outbound messages in draft until the owner approves them.

Do not create a permanent Node.js worker, `setInterval`, or `node-cron` process on shared hosting.

## 9. Common mistakes to avoid

Do not upload `.env` files to GitHub or `public_html`. Do not put `DATABASE_URL`, `OPENROUTER_API_KEY`, OIDC secrets, Mail API tokens, or webhook secrets into any `VITE_` variable. Do not expose the private storage directory through static hosting. Do not use SMTP or IMAP; the project uses the Hostinger Mail API contract. Do not replace mailbox resource IDs with visible sender addresses. Do not enable autonomous final candidate rejection, client sharing, placement confirmation, invoice issuance, or outbound email without owner approval.

## 10. Exact order to follow

The safest order is: create MySQL; connect the GitHub repository; configure Node.js build and startup commands; add environment variables; run migrations; create the private local storage directory; bind the domain and issue SSL; start the application; complete OIDC owner login; inspect the Control Plane readiness card; run non-destructive database and document checks; perform one owner-only controlled Mail API test; validate one inbound webhook; configure the bounded reminder schedule; and only then begin the pilot in safe mode.

For the database-specific migration details, also read `DATABASE_IMPORT_GUIDE.md`. For the complete technical rationale and environment inventory, read `HOSTINGER_DEPLOYMENT.md`.
