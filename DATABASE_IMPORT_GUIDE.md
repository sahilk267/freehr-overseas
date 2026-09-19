# FreelanceHR Hostinger database handoff

## Purpose

FreelanceHR uses a MySQL-compatible database. The repository does not contain a database dump or customer data file. The database definition is represented by the Drizzle schema and the checked-in migrations, which should be applied to a newly created Hostinger database exactly once.

| Database artifact | Repository location |
| --- | --- |
| Drizzle schema | `drizzle/schema.ts` |
| Migration configuration | `drizzle.config.ts` |
| Ordered migrations | `drizzle/0000_*.sql` through `drizzle/0008_*.sql` |
| Runtime connection variable | `DATABASE_URL` |
| Database dialect | MySQL |

## Create the empty database

In Hostinger hPanel, create a MySQL database and database user. Record the exact database host, database name, username, password, and port supplied by hPanel. Do not use the application domain as the database host unless hPanel explicitly gives that value.

The connection string must remain server-side:

```dotenv
DATABASE_URL=mysql://<DB_USER>:<URL_ENCODED_DB_PASSWORD>@<DB_HOST>:<DB_PORT>/<DB_NAME>?ssl={"rejectUnauthorized":true}
```

Use the Hostinger-provided port, normally `3306` when no different value is shown. URL-encode reserved characters in the password, including `@`, `#`, `/`, `:`, `%`, `?`, and spaces. Do not prefix this variable with `VITE_`.

## Apply migrations

Upload the repository release without `.env` files, logs, candidate documents, or local test artifacts. After dependencies are installed and `DATABASE_URL` is available to the Node process, run the migration command from the project root:

```bash
pnpm install --frozen-lockfile
pnpm exec drizzle-kit migrate
```

The migration runner reads `drizzle.config.ts`, uses `DATABASE_URL`, and applies the checked-in migrations in order. Do not run `drizzle-kit generate` against production as part of the first import, and do not manually replay a migration that is already recorded as applied.

If hPanel only offers phpMyAdmin import, import the nine files in this order:

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

The project’s migration ledger must be preserved. If a migration fails, stop and inspect the exact error instead of continuing with later files or dropping existing tables.

## Non-destructive verification

After migration, confirm that the migration ledger exists and that the core tables are present. The exact metadata-table name is managed by Drizzle; use the application migration command as the source of truth rather than manually modifying the ledger. For a table-level check, run a read-only query appropriate to the Hostinger MySQL database:

```sql
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'workspaceSettings', 'teamMembers', 'teamInvitations',
    'companies', 'jobs', 'candidates', 'candidateDocuments',
    'interviews', 'placements', 'invoices', 'automationQueue',
    'approvals', 'auditEvents'
  )
ORDER BY TABLE_NAME;
```

The result should contain the project’s core tables. Hostinger or Drizzle may use a different physical naming convention for identifiers; if so, inspect the actual names with a read-only `SHOW TABLES` query and do not rename tables manually.

## Minimum production environment

Set the database variable together with the application runtime values documented in `HOSTINGER_DEPLOYMENT.md`:

```dotenv
NODE_ENV=production
PORT=<provided-by-hostinger>
DATABASE_URL=mysql://<DB_USER>:<URL_ENCODED_DB_PASSWORD>@<DB_HOST>:<DB_PORT>/<DB_NAME>?ssl={"rejectUnauthorized":true}
PRIVATE_STORAGE_MODE=local
PRIVATE_LOCAL_STORAGE_PATH=<absolute-path-outside-public-web-root>
APP_BASE_URL=https://freelancehr.overseasjob.in
SESSION_SECRET=<random-value-at-least-32-bytes>
```

OIDC variables are required before the production authentication boundary is enabled. Hostinger Mail API, mailbox resource IDs, and webhook secret are required before live mail operations are enabled. The local database import itself does not require sending mail or enabling automation.

## Startup sequence

Use this order: create the empty MySQL database; configure `DATABASE_URL`; install dependencies; apply migrations once; configure the private local storage path; build with `pnpm build:hostinger`; configure the Node startup command `pnpm start:hostinger`; confirm the application health and owner login; then keep automation in safe mode. Deployment and live-domain testing are separate steps and are not performed by this guide.

## Optional local demo validation

The repository includes an explicitly opt-in demo seed command. Run it only against the local development database after the owner has signed in once:

```bash
DEMO_OWNER_OPEN_ID='<local-owner-open-id>' pnpm seed:demo
```

The command creates one fictional company, one consent-pending candidate, and one draft job with a shared `demo_<type>_<suffix>` identifier. It does not send email, invoke AI, create interviews, or trigger external automation. Save the three IDs printed by the command for local review. To remove only these records after validation, first verify the IDs and delete the child job and candidate rows before the company row using a database administration tool; never run a broad delete against a shared or production database without reviewing every returned row.
