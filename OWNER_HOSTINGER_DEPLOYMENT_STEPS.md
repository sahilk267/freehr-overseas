# Hostinger owner deployment steps

The repository is `sahilk267/freehr-overseas`, branch `main`. Local implementation and validation are recorded in [implementation progress](docs/IMPLEMENTATION_PROGRESS.md); they do not establish a live production deployment. Enter completed credentials only in Hostinger's server-side Environment variables.

## 1. Build and entry file

The supplied Hostinger log shows `npm install` and `npm run build` succeeded, followed by **Entry file not found** because Hostinger expected root `server.js`. The repository now supplies that entry and declares it as `package.json.main`. It calls the same production server as `dist/hostinger.js`.

Keep these settings for the observed Node application:

| Setting | Value |
|---|---|
| Branch | `main` |
| Root | `./` |
| Package manager | `npm` as already selected |
| Dependency install | `npm install` |
| Build | `npm run build` |
| Entry file | `server.js` |
| Output directory | Leave unset for this Node application; retain root files and `dist` |
| Start command, if offered | `npm start` |
| Port | Use Hostinger's supplied `PORT` |

`pnpm build` / `pnpm start` remain equivalent if you explicitly configure the pinned pnpm 11 runtime with Node >=22.13. Do not put `dist/public` in the server-entry field or deploy only frontend static files. `dist/public` holds the UI; `dist/hostinger.js` holds the server. Direct `node dist/hostinger.js` also remains supported if explicitly configured.

A build can succeed with no `.env` file. Environment variables in hPanel are sufficient; no completed `.env` belongs in GitHub. Root `server.js` defaults to production mode and refuses a missing production database configuration.

## 2. Initialize the empty database

Use [DATABASE_IMPORT_GUIDE.md](DATABASE_IMPORT_GUIDE.md). For phpMyAdmin, select the empty database and import [deploy/hostinger-empty-database.sql](deploy/hostinger-empty-database.sql) once. It contains migrations 0000–0014 and the matching Drizzle journal records, with no customer data. Expect 15 applied migrations.

If an application terminal is available, `npm run db:migrate` with the correct private `DATABASE_URL` is the alternative. Do not import the generated fresh-install SQL into an existing database.

## 3. Add production environment variables

The [production template](deploy/hostinger.env.example) includes the public settings from `.env.example`: application URLs, owner email, Google issuer/callback, six intended mailbox addresses and optional storage/AI settings. These addresses and identifiers are configuration intentions, not proof that the external accounts exist.

Prepare a private import file from the project root:

```sh
npm run env:hostinger
# Optionally merge values from an existing private dotenv file:
npm run env:hostinger -- --from /private/path/to/.env.provider
```

The command writes Git-ignored `.env.hostinger` with owner-only file permissions, generates separate 32-byte session/cron/webhook secrets, and reports only key names that still need setup. Re-running preserves existing real values and secrets. A supplied nonblank value can explicitly update its matching key; blanks and example placeholders do not clear an existing value. It never copies Hostinger's managed `PORT` or development/preview credentials, and enforces production OIDC with the initial owner-only pilot setting. It does not change the development `.env`.

Fill the remaining actual database/OIDC/private-storage values privately, then import **`.env.hostinger`** in hPanel or add its variables individually. The committed `.example` deliberately has no real secrets; it is not the completed import file. Do not upload the private file to GitHub or overwrite an already configured Hostinger environment with an incomplete file. Optional Mail API/OpenRouter credentials and mailbox resource IDs must come from their providers; generated webhook keys do not activate those integrations.

| Purpose | Required configuration |
|---|---|
| Runtime | `NODE_ENV=production`, `APP_BASE_URL=https://freelancehr.overseasjob.in` |
| Database | `DATABASE_URL` using the actual Node-accessible host/user/password/database |
| Owner login | `AUTH_MODE=oidc`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` |
| Frontend login | `VITE_AUTH_MODE=oidc`; the production build also defaults to this value |
| Session signing | A private random `SESSION_SECRET` of at least 32 characters |
| Cron authentication | A separate private random `CRON_SECRET` of at least 8 characters |
| Owner identity | The intended `PRIMARY_OWNER_EMAIL` or `PRIMARY_OWNER_OPEN_ID`; use `OWNER_ONLY_MODE=true` for the initial private pilot |
| Documents | `PRIVATE_STORAGE_MODE=local`, and a persistent absolute `PRIVATE_LOCAL_STORAGE_PATH` outside the public web root |

The preparation command generates the three local secrets without printing their values. It validates URLs and rejects multiline values before writing. It does not rotate existing secrets automatically. `npm run test:hostinger-env` checks preservation, file permissions, placeholder filtering, quoting and failure handling. Do not send generated values in chat or commit the private file.

Standalone production requires OIDC even for an owner-only pilot. Select a provider supporting authorization-code flow, PKCE and verified email, and register this exact callback:

```text
https://freelancehr.overseasjob.in/api/auth/oidc/callback
```

The configured owner must match the intended verified provider identity. Development demo/preview authentication is not a production login. Blank or invented provider credentials cannot complete this step. AI and mail credentials are separate later integration activations; they are not needed to resolve the entry-file error or import the schema.

## 4. Redeploy and verify runtime

After database import and environment setup, redeploy the latest `main` commit. A passed build does not prove startup succeeded. Inspect Runtime logs, then verify HTTPS `/api/health`, the built page, actual owner OIDC login and authenticated dashboard/database access. Check that documents are stored privately and persist across deployments. Keep the initial pilot restricted to the owner.

If startup reports `DATABASE_URL` or OIDC configuration missing, correct those variables in hPanel rather than switching production to development mode. Build warnings about deprecated dependencies, audit findings or frontend chunk size do not explain the supplied **Entry file not found** error; review them separately.

## 5. Background execution and external integrations

Shared hosting needs authenticated, bounded scheduled execution supported by the hosting plan. Existing callbacks are `POST /api/scheduled/interview-reminders` and `POST /api/scheduled/automation-queue`, authenticated with the configured cron secret. A standalone worker needs a separately supervised persistent process and the same migrated MySQL database; do not assume a permanent worker is available on shared hosting.

Validate the actual schedule and required source adapters before claiming unattended operation. Provider credentials alone do not complete pending lifecycle features. Configure purpose-specific mailboxes, delivery/webhook validation, AI credentials and other providers only when activating those integrations. Owner review and bounded authority still govern external effects.

For technical context, see [HOSTINGER_DEPLOYMENT.md](HOSTINGER_DEPLOYMENT.md) and [implementation progress](docs/IMPLEMENTATION_PROGRESS.md).

## Hostinger connector

Hostinger's [official MCP instructions](https://github.com/hostinger/api-mcp-server#quick-start-hosted-remote-server) provide a hosted remote server at **`https://mcp.hostinger.com`**. Add it as a remote Streamable HTTP MCP server in the client and complete its OAuth authorization. The hosted option does not require installing Hostinger's local Node package.

The connector's authenticated tools must be available in the active session before an agent can operate the hosting account. After connection, inspect the tools/capabilities for this specific Node application before using deployment, logs, environment or database operations; do not assume every hPanel operation is exposed. A repository connection or cloud-environment onboarding tool is not Hostinger account authorization.

Keep any Hostinger management/OAuth token in the MCP client's secure credential flow. Do not put it in the application's Mail API token field or committed configuration. The Mail API and hosting management connections serve separate purposes.
