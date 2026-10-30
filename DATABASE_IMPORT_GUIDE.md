# Hostinger database setup

The schema is defined by `drizzle/schema.ts` and the journaled migrations 0000–0014. No customer records, passwords or application sessions are included in the import file.

## Existing empty database: phpMyAdmin

1. Download [deploy/hostinger-empty-database.sql](deploy/hostinger-empty-database.sql) from the same repository revision you deploy.
2. In phpMyAdmin, select the intended database. Confirm its Structure page says **No tables found in database**.
3. Open **Import**, choose the SQL file, and import it once with stop-on-error behavior. Do not import it into a nonempty or partially migrated database. If any statement fails, stop and retain the error; do not continue or drop existing tables to retry.
4. Run the read-only verification queries below. The import preserves Drizzle's real migration hashes and timestamps, so subsequent `npm run db:migrate` is a no-op until another migration is added.

The export is generated from the canonical journal, rather than maintained as a second schema. To regenerate it after a migration change:

```sh
npm run db:export-hostinger
```

## Alternative: terminal migration

If Hostinger provides an application terminal/SSH, set the actual `DATABASE_URL` privately in that process and run from the deployed project root:

```sh
npm run db:migrate
# Equivalent with the pinned package manager:
pnpm db:migrate
```

Use either the empty-database import or the migration command for initial setup. Do not manually import individual historical files without maintaining the migration ledger. MySQL DDL cannot be assumed to roll back if a migration fails.

## Connection settings

Set `DATABASE_URL` in the Node application's hPanel Environment variables:

```text
mysql://DB_USER:URL_ENCODED_PASSWORD@DB_HOST:DB_PORT/DB_NAME
```

Use the host, username, password, port and database name supplied for the Node application's connection. A phpMyAdmin screen showing `127.0.0.1:3306` identifies phpMyAdmin's own connection; it does not establish the correct host from the Node runtime. URL-encode password characters such as `@`, `#`, `/`, `:`, `%` and `?`. Use the provider's required TLS/CA settings; do not bypass certificate verification or copy an assumed SSL query parameter.

The database user must have access to the selected database. Put credentials only in hPanel server-side configuration, never in `VITE_` variables or a committed file. [deploy/hostinger.env.example](deploy/hostinger.env.example) lists the other required runtime settings.

## Verify the import

Run these queries in the selected database:

```sql
SELECT COUNT(*) AS applied_migrations FROM __drizzle_migrations;
SHOW TABLES;
SELECT TABLE_NAME, DATA_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'invoicePaymentPromises'
  AND COLUMN_NAME = 'baselinePaid';
```

For the current release, expect 15 migration entries and `bigint` for `baselinePaid`. Tables include `users`, `workspaceSettings`, `companies`, `candidates`, `invoices`, `payments`, `automationQueue`, `followUpPlans`, `emailDispatches`, `workflowEvents`, `invoiceCollectionSettings` and `invoicePaymentPromises`. Business tables are initially empty; owner identity is created during configured sign-in. Do not import local test/demo records into production.

Database import does not configure authentication, start the application, send email or activate a payment provider. Continue with [the owner deployment steps](OWNER_HOSTINGER_DEPLOYMENT_STEPS.md).
