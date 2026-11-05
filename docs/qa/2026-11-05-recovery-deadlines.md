# Recovery deadlines and exceptions — 5 November 2026

The existing managed and standalone workers now evaluate expired interview recovery pairs. A valid current occurrence receives one deterministic medium-severity incident in the existing Exception Center; both capability hashes are cleared and links revoked atomically with the incident, workflow event and audit. Responses already submitted are recorded as role-level booleans, without copying windows or capability tokens into incident/event text. No message is sent, new appointment chosen or new request automatically created.

The bounded SQL scan filters ordinary availability, paused/stopped workspaces and already processed recovery before its limit. Each selected group is checked again under the shared workspace lock. Candidate ineligibility, cancellation or a newer schedule closes stale recovery without a misleading deadline incident. Competing managed/standalone polls cannot duplicate the incident or expiry event. Failure rolls back both authority closure and incident creation.

Owner replacement resolves the old request’s incident; canonical reschedule/cancel/state changes resolve recovery incidents for the affected interview. Exceptions link back to the availability panel. Deadline evaluation appears in persisted worker heartbeat results. No migration, second timer loop, queue or sending engine is added. Existing outbox validation still blocks expired/revoked private-link delivery; pending draft review remains separate.

Local validation: 584 tests pass (40 skipped), 306 real-MySQL regressions pass in 19 files. SQL cases verify concurrent polls, rollback and starvation prevention with old ordinary/paused records. Types, tracker/build/entry and live results are recorded as checks complete. Positive production elapsed-deadline acceptance remains unverified; live heartbeat and synthetic incident UI checks are not substitutes for a real expired recovery case.

The preceding assisted recovery flow is live-verified separately in [its report](2026-11-05-interview-recovery.md). Owner-reviewed slot selection, recipient delivery, verified identity/provider RSVP and unattended rescheduling remain pending. M18 remains implementing.

TypeScript, tracker consistency, production build and all four hosting entry smokes pass. Live worker and synthetic UI checks remain pending at this commit; no elapsed-deadline production success is claimed.

Application `ab3bf4d` is live. The managed worker’s recent persisted heartbeat includes the actual recovery-deadline source result. Desktop/mobile Exception Center checks passed using an explicitly manual synthetic incident, and its link reached the existing recovery panel. The fixture incident was resolved and removed from open exceptions; no email or invitations were sent. This verifies the deployed worker integration and UI navigation, not a positive elapsed-deadline production case. [Sanitized evidence](2026-11-05-recovery-deadlines-evidence.json).
