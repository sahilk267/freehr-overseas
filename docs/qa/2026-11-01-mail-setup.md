# Live Mail API setup — 1 November 2026

Code `65655a6` was pushed to main and verified on https://freelancehr.overseasjob.in. The owner added the token directly to hPanel. No real token was copied to the workspace, committed or printed.

The official Mail API account lookup returned unique authorized resource IDs for all six configured addresses: owner, clients, talent, interviews, finance and privacy. Corresponding sender identities were registered/reused by exact address, verified against the actual account and activated. Existing disabled QA identities remain disabled. Before activation the complete small queue was terminal and there were no active campaigns. No email was sent.

Missing IDs are resolved in each production process on startup and can be rediscovered from Control Plane. These runtime bindings do not replace the hosting environment; restart repeats discovery using the token already on the host. Explicit conflicting IDs are preserved and reported. Provider outages leave the app available and affected mail configuration blocked. This also applies to the standalone worker and Express entry. The owner-only discovery action does not return the token or unrelated mailbox inventory.

The verified IDs were also copied into the ignored private `.env.hostinger`. Its token is still a placeholder because the real token resides only in hPanel. Do not bulk-import that local file over live secrets without preserving the actual token.

Validation: 422 Vitest tests passed, 16 skipped; TypeScript, production build and four Hostinger entry smokes passed. Real discovery resolved all six mailboxes; all six sender verifications returned success. Anonymous discovery was rejected with 401. Live Control Plane discovery and desktop/mobile layout passed with no recorded runtime or transport errors. No messages or funds were sent. This establishes actual account/mailbox connectivity, not accepted/delivered message evidence or inbox synchronization. OpenRouter and the remaining agency business modules are still separate work.

The historical W4 report's missing-mail-configuration finding is superseded by this checkpoint. Its 158-procedure matrix predates the added protected mutation `email.discoverMailboxes`.

Sanitized live evidence: [mail setup evidence](2026-11-01-mail-setup-evidence.json). Private logs/screenshots remain in `/workspace/freehr-wave4-validation/`.
