# Google Calendar connector — 1 November 2026

Implemented owner-only Google OAuth with session-bound, one-use PKCE state, connection generation checks, encrypted refresh credentials bound to owner/connection/account, refresh/reconnect and local disconnect with best-effort provider revocation. App owner-password login is unchanged. Callback logging is silent; credentials and raw provider errors are not returned to the client.

Control Plane exposes configuration status and connection management. Interviews exposes private calendar free/busy and explicit owner-reviewed event create/update/cancel. Deterministic IDs recover unknown create outcomes without duplicate events; ETags reject concurrent external edits. Workspace transactions and a durable connection lease serialize requests without holding a SQL transaction over provider HTTP. Snapshot changes fail closed, including interview changes after a provider write. Events use a generic interview reference and stored meeting URL, with no candidate CV, notes or guest invitations (`sendUpdates=none`). Review the meeting URL before sharing it with Google.

This is a partial M18 implementation. It does not provide background/bidirectional synchronization, Google Meet creation, guest invitations/RSVP ingestion, Microsoft integration, negotiated participant availability, slot reservations or automatic reconciliation of old calendar targets. Free/busy is a point-in-time check, not a reservation. Changing calendar targets leaves existing event copies in the old calendar. Disconnecting leaves events intact. Secret rotation requires reconnecting. An in-flight provider write may complete after disconnect or a local edit; its result is fenced and must be reviewed/reconciled.

## Owner setup

In Google Cloud, enable **Google Calendar API**, configure the OAuth consent screen and create an **OAuth client ID → Web application**. For testing consent, add the calendar owner's Google account as a test user. Add this exact authorized redirect URI:

```
https://freelancehr.overseasjob.in/api/integrations/google-calendar/callback
```

In Hostinger hPanel → this website → Environment variables, add/update only these fields, preserving all existing variables:

```
GOOGLE_CALENDAR_CLIENT_ID=<Web OAuth client ID ending in .apps.googleusercontent.com>
GOOGLE_CALENDAR_CLIENT_SECRET=<that Web client's secret>
GOOGLE_CALENDAR_REDIRECT_URI=https://freelancehr.overseasjob.in/api/integrations/google-calendar/callback
```

Keep `APP_BASE_URL=https://freelancehr.overseasjob.in` and the existing stable `SESSION_SECRET`. Never put OAuth secrets in `VITE_*` fields or commit them. The generated `GOOGLE_CALENDAR_API_KEY` alone cannot read/write a private calendar and is not used for this flow. Save/restart the application, then sign in with the platform owner password, open **Control Plane → Connect Google Calendar**, and approve the requested Google permissions. This consent connects the calendar; it does not enable Google platform login. Testing-mode Google refresh grants can expire after seven days; reconnect as needed or complete the appropriate Google production-consent setup.

## Validation

468 tests passed / 21 skipped, including mocked OAuth/provider failure, state reuse, expired/cross-owner state, token refresh, owner-bound encryption, late callbacks, disconnect fencing, quota vs authorization errors, stale preview, ETag conflicts, unknown-create recovery and create/reschedule/cancel without invitations. A separate disposable MySQL run passed 184 tests across 11 files, including simultaneous callback consumption and connection lease contention. TypeScript, production build and four hosting entry smokes passed. Reviewed schema upgrade 19→20 was exercised concurrently and repeatedly, preserving existing records and rejecting altered migration hashes.

The first adapted upgrade harness incorrectly expected old normalization migrations to rerun over records inserted after baseline 19. The harness was corrected to assert preservation across migration 0019; this was a test expectation error, not an application migration failure.

Live evidence is recorded separately. No actual Google calendar authorization, provider event or private free/busy success is claimed without owner OAuth credentials and consent. Provider tests above use synthetic responses; no mail or money is sent.
