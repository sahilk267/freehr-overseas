# AI credential health and synthetic task checks — 1 November 2026

The actual provider check observed two distinct configured credentials: **primary verified, backup rejected**. A saved key-presence flag is not proof of authentication. The owner must replace/correct `OPENROUTER_FALLBACK_API_KEY` in hPanel and can retry **Control Plane → Verify AI credentials**. No key, label, account usage or secret value is returned by the application. A valid replacement is required before declaring backup failover healthy.

The owner-only health action uses the official read-only key metadata endpoint, deduplicates identical credentials and defers further probes after throttling. Anonymous access was rejected. The live panel correctly displayed primary success and backup rejection at desktop/mobile sizes with no recorded runtime or transport errors. Keys remain in hPanel; no real credential was copied into the repository.

## Actual synthetic task observations

| Probe | Observed result | Limit |
|---|---|---|
| CV text extraction | Valid schema; five years, TypeScript, MySQL and supplied role/education extracted correctly | Synthetic text only; not a document-upload/OCR test |
| Evidence matching | Valid schema; TypeScript/MySQL/experience identified and missing AWS evidence reported | Advisory scores/recommendation are not a hiring or shortlist authorization |
| Outreach draft retest | Valid schema, recruitment purpose and explicit STOP opt-out instruction | Saved only in the QA queue result; no recipient/message record or send |

CV extraction selected `nvidia/nemotron-3-ultra-550b-a55b:free`; the successful draft retest selected `dots-studio/dots-3-note-preview:free`. These are observed free-router selections, not pinned models, a current catalog guarantee or a comparative ranking. Missing required evidence must still pass the platform's separate evidence/approval controls; model confidence does not establish suitability.

Initial failures are retained: the first CV probe returned empty assistant content and a later draft failed schema validation. Neither was accepted as a successful business outcome. Structured requests now explicitly disable optional reasoning, drafting instructions name the required checklist strings, and rejection diagnostics identify a sanitized field/code without logging invalid output. Subsequent CV/matching/draft checks passed. Guards still reject future empty/invalid responses; three basic probes are not comprehensive model-quality coverage.

Code was pushed to main and tested live. Runtime health now includes a nonsecret build commit when Git metadata is available (otherwise `unknown`). The draft retest observed exact deployed build `82112f09b85653a3b8024d74295666724404b4ec`. TypeScript/build and four Hostinger entry smokes passed; the final full suite recorded 436 passes and 16 skips.

No real candidate/client records, emails or funds were affected. Labelled QA queue failures/successes and usage/audit history remain; the queue is terminal. [Sanitized evidence](2026-11-01-ai-credential-quality-evidence.json) separates initial failures, retests, credential status and UI observations. Backup authentication, broader task evaluation, shared provider-request budgeting and the remaining agency modules are not declared complete.
