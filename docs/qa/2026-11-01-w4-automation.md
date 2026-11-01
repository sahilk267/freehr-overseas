# W4 automation increment — 1 November 2026

This release adds source intake, canonical identity checks, governed campaigns and managed background processing to the existing recruitment workspace. It advances the [module registry](../freehr-module-registry.json); **the complete 25-module autonomous-agency roadmap remains unfinished**. Increment labels describe shipped slices, not completion of the similarly named master-plan waves.

## Implemented behavior

| Area | Result | Boundary |
|---|---|---|
| Source intake | Owner-reviewed CSV/JSON preview/import, scoped machine endpoint, durable batch receipts and record provenance | Real job-board, ATS, application and licensed discovery adapters still need implementation/configuration |
| Identity | Manual creation and source imports share workspace-serialized email, international-phone and company-domain matching | Ambiguous identities are held; no automatic merge, overwrite or consent grant |
| Campaigns | Acquisition, repeat-hiring, candidate-interest and availability sequences; reviewed audiences, exact personalized messages, explicit bounded delegation | No autonomous negotiation, reply-to-booking workflow or verified live mailbox outcome |
| Background work | Production Node process polls persistent MySQL while the browser is closed; observed heartbeat, pause, optimistic revision and emergency stop | Runtime downtime delays work; no external cron registration or high-availability guarantee |
| Deployment | Canonical npm lock; reviewed target-specific schema upgrade through 0018 | A successful build alone does not establish successful deployment or provider connectivity |

### Source intake and identity

`POST /api/integrations/intake/:sourceId` accepts a bearer key restricted to one owned source and one record type. Source creation returns plaintext once; storage retains a SHA-256 hash. Owner lists exclude hashes and keys. Rotation and disabling invalidate old access. Source creation and batch commands bind idempotency keys to their content; external record keys remain case-sensitive. Exact batch replay does not consume the new-batch rate limit.

Bodies are limited to 256 KB and 50 records. CSV parsing supports quoted fields/newlines, CRLF and BOM; bounded fields and allowlisted headers reject malformed or privilege-bearing input. New batches are limited to ten per minute per source. Review hashes bind the current identity evidence; changed evidence requires another preview. Source receipts retain minimal outcome/provenance data rather than copies of raw imported records.

Candidate email/phone and company domain identities are normalized within a workspace. Conflicting identities or a contact belonging to another company are held before creating unrelated records. Existing identity fields, business states and permissions are preserved. New candidates start consent-pending, companies start unverified, and contacts have unknown communication permission. Phone-only imports require an international number; a country is never guessed for a national number. Suppression, withdrawal, DNC and erased identities cannot be reactivated through import. Legacy international-phone hashes are normalized without merging records; active legacy suppression aliases are retained. Valid legacy company URLs are normalized too; colliding company rows remain separate and cause an intake hold. Already-erased hash-only values cannot be normalized without their original value.

### Campaigns and the shared follow-up engine

The owner selects up to 100 recipients and six messages, with a deadline within thirty days, timezone and optional weekdays. Supported variables are `{{name}}`, `{{company}}` and mandatory `{{opt_out}}`. Preview checks current permissions, suppression, sender purpose/status, duplicate addresses and competing active or held sequences. Launch binds the exact preview. Runtime enrollment and dispatch independently recheck current evidence; an address change cannot redirect previously reviewed messages.

Campaigns create the existing central follow-up plans, grants, outbox and queue entries. They do not introduce a second delivery gateway or timer store. Review mode is the default. Delegated mode requires explicit authority for the bounded audience/content/deadline. Replies and opt-outs stop the central sequence. Pause revokes grants and holds enrolled sequences; resuming permits new enrollment only in review mode, while previously held sequences need their own explicit review. A draft cannot bypass launch review through pause/resume. Candidate erasure redacts personalized recipient snapshots; the broader provider-retention inventory remains open.

Background discovery uses a bounded recipient budget and scan cooldown. Managed cycles process at most five queue jobs per workspace and inspect at most 25 enabled workspaces. Existing quiet hours, send caps, spacing, owner approvals and delivery authority remain effective. `operations.queue.enableSchedule` and `recruitment.interviews.enableReminderSchedule` now delegate to this same persisted controller and return worker status; they do not return an external cron task UID. Separately supervised workers and authenticated callbacks still consume the same queue. Pausing managed processing prevents future managed cycles; already claimed work or independently configured runners may finish.

### Dependencies and migrations

`npm ci` with committed `package-lock.json` is the supported reproducible install, matching Hostinger. Competing pnpm/Bun lockfiles were removed. The resolved graph upgrades Drizzle and Zod, with corresponding regression checks; no forced audit fix or TLS/integrity bypass was used. Server-only campaign validators avoid adding the validator runtime to the client bundle.

When `RUN_DB_MIGRATIONS` is unset, root `server.js` authorizes only `freelancehr.overseasjob.in` to advance an exact canonical 0000–0014-or-later ledger through reviewed migration 0018. SQL content hashes and history must match `deploy/schema-release.json`. Empty, older, divergent or unreviewed histories are refused; current history is a no-op. A database-scoped advisory lock serializes simultaneous startup migrations. Explicit `false` disables this behavior; explicit `true` runs the canonical migration command. Other domains retain explicit opt-in. The fresh empty-database export includes all 19 entries. This does not establish backup restoration or recovery from every partially applied DDL failure.

## Validation

| Check | Observed result |
|---|---|
| Full Vitest suite | 419 passed, 16 skipped; 54 files passed, one skipped |
| Disposable real MySQL | 147 passed across nine files, including competing intake, campaign/worker, W0, follow-up, collection and email regressions |
| Existing-database upgrade | 15 to 19 entries; concurrent/repeated execution, suppression aliases, legacy company domains, unchanged contact permission and changed-manifest rejection passed |
| TypeScript / build | Passed; existing large-chunk advisory remains |
| Hostinger entry | Four smokes passed, including LiteSpeed-style CommonJS loading and missing-database refusal |
| Browser workflow/layout | 15 passed; intake, campaigns and Control Plane at 1440/390 px; no recorded runtime or transport errors |
| Browser-closed processing | Actual local production-mode worker prepared a review-only campaign sequence with the browser closed |
| Router inventory | 158 procedures, including 155 protected procedures; live guard/read verification is recorded separately below |
| Production dependency audit | Zero critical/high; nine package findings remain: three moderate and six low |

The browser positive-send prerequisites used a clearly synthetic sender state in a disposable local database. Provider calls in unit/SQL tests are mocked. These checks do not establish actual Hostinger Mail verification, real messages, AI provider execution or transferred money. Local virtual-origin browser routing does not attest to production HTTPS. Full-suite skips include SQL/provider-dependent checks; separate SQL results overlap the default suite and must not be added as unique feature counts.

Detailed local logs/screenshots: `/workspace/freehr-wave4-validation/`. Private owner credentials, cookies, machine keys and environment values are excluded from committed evidence. Earlier failed selector assumptions and stale-build test-server routes were corrected before the final browser run; these are not counted as successful product assertions.

## Remaining business and operational scope

Actual automatic client discovery/hiring signals, enrichment, reply-based qualification/bookings, negotiation/e-sign, conversation-driven requirement sign-off, external candidate sourcing, OCR lifecycle, complete ranked matching and evidence verification, candidate-facing adaptive screening, controlled client submission portal, calendar negotiation/meetings, authenticated offer acceptance, real payment checkout/webhook reconciliation and retention/replacement orchestration remain incomplete. This increment supplies reusable infrastructure for those modules; it does not claim autonomous agency operation or guaranteed income.

Mail API credentials and mailbox resource IDs, AI credentials and each selected external provider need actual connectivity and contract tests. Missing credentials must continue to block outcomes. Restart/restore drills, workload testing, full accessibility coverage and broader provider/privacy retention work remain open. The historical 31 October report describes the earlier release; its scheduler and dependency findings should be read alongside this increment's new evidence.
