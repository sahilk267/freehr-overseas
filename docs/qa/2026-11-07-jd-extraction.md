# Quoted JD / requirement-text extraction

Date: 7 November 2026 (Asia/Calcutta). Target: `https://freelancehr.overseasjob.in`.

## Behavior

A draft owner can paste JD/email requirement text or start from the current description. One logical source/body/intake-state intent reuses the existing `extract_job_requirements` AI queue task. Its payload contains owned references and hashes; immutable source text and label live in the existing workflow ledger. No new table, migration, timer, transport or AI provider is introduced. The existing free-only OpenRouter routing, fallback credentials, request budgets and retry/lease controls apply. Generic queue enqueue cannot create this task without its domain source command.

Provider output has a typed allowlist of requirement fields, compact values and supporting quotes. Each suggestion is checked against normalized literal source text and intake validation. Numeric values must be explicitly supported, currency must be named as a code, dates must be literal valid ISO dates, and category aliases are bounded. Scaled salary formats such as lakh/LPA/k are not guessed or silently stored as raw units; they require manual normalization. Unsupported suggestions remain visible and cannot be selected. Excerpt matching is not semantic verification, client identity or authenticated sign-off. Unknowns stay unknown; model questions/confidence are advisory. No scorecard weights, approval, pipeline or financial authority can be extracted as a command.

Model completion records suggestions only. Owner adoption selects individual facts, optionally copies the original source as description, and explicitly permits replacement of existing values where necessary. Unselected manual facts are preserved. Conflicting scalar selections and cross-category/range conflicts are rejected by canonical intake validation. One reviewed selection is saved atomically with the existing intake version and its source provenance. An exact repeat acknowledges the original adoption, including after later edits, without overwriting current work; a different selection under an already-applied intent is rejected. Further interpretation uses a fresh source/current-version request or manual intake editing.

Preflight prevents known stale inference, and late outputs remain marked stale. Adoption requires the original current draft revision/fingerprint and unchanged source hash. If a stage-only review round trip returns to exactly the original draft snapshot, the stored late result can receive a fresh explicit owner review without another inference; its arrival-time warning is retained. Actual version/fact changes still require a new extraction. Workspace locking serializes owner edits against result/application commands. Cancelled/blocked/failed tasks without an accepted result can be explicitly requeued using the same intent/task identity; running tasks and immutable accepted outputs are preserved. The source UI keeps oversized pasted text intact, shows its length and blocks submission rather than silently truncating it.

## Verification

Full suite: 764 passed, 67 skipped. Disposable MySQL: 512 passed across 27 files. Final extraction/worker focused checks passed 26 tests with 3 SQL-only skips. TypeScript, production build and four hosting entry checks passed, including the final source-counter UI. Coverage includes quoted facts, fabricated/unsupported values, schema/authority rejection, no automatic job edit, stale work before/during inference, ownership, conflicts, idempotency, controlled requeue, duplicate SQL commands, concurrent edit/adoption and atomic audit-failure rollback. Provider calls in these regressions are synthetic mocks. Actual free-provider and owner browser acceptance passed on implementation commit `a18aa3f77793301183d1db61ac280acf651318cc`; see [sanitized evidence](2026-11-07-jd-extraction-evidence.json).

## Live acceptance

The managed worker, without a manual worker run, used `dots-studio/dots-3-note-preview:free` and returned 16 supported suggestions and one unsupported suggestion. The provider combined TypeScript and SQL as a comma-separated value absent from the supporting quote, so it was disabled; this pilot is not general extraction-quality evidence. Desktop source entry preserved oversized text and blocked submission, and exact source retries reused one queue intent. Provider completion left intake unchanged.

At a 390 × 844 mobile viewport, owner review selected 15 supported facts, copied the source description and explicitly allowed selected-value replacement. Requirement version 2 preserved the manual department and original version 1; the role remained draft with no verified confirmation. Exact adoption replay created no extra version. A later manual headcount edit created version 3, and replay of the original selection still acknowledged version 2 without replacing version 3. A different selection conflicted. All three extraction APIs rejected anonymous access. Both browser runs had zero runtime errors; mobile had no horizontal overflow.

The synthetic job was cancelled, its company suppressed and its extraction task remained completed. The persistent managed worker was enabled with a recent heartbeat, no emergency stop and no error. No recipient messages, invitations or payments were sent.

## Subsequent document intake increment

[Document import acceptance](2026-11-07-jd-document-import.md) adds bounded PDF/DOCX/TXT text preview and document-bound source adoption, verified live on `ad7431d`. Original-file lifecycle and scanned-image OCR remain open. The following scope statement describes the text-only increment at its original release.

## Remaining scope

PDF/DOCX/OCR ingestion, automatic inbox attachment intake, semantically verified interpretation, scale/FX/pay-period normalization, automatic clarification sending, authenticated client sign-off, active amendments and the remaining advanced roadmap are open. This is partial M08-F01/F03/F08 and M12-F01 implementation. No recipient communication or business approval is authorized by QA.
