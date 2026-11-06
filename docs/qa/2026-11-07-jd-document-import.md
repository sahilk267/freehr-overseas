# JD document text import and bound extraction

Date: 7 November 2026 (Asia/Calcutta). Target: `https://freelancehr.overseasjob.in`.

## Behavior

The existing job intake/extraction panel accepts an owned draft's PDF, DOCX or UTF-8 TXT file, with a 2 MB upload limit. It reuses the shared document signature checks and PDF/Mammoth text parsers. PDF import rejects more than 100 pages; DOCX import checks its ZIP directory, allowed compression, entry names, encryption flags and actual bounded expansion before parsing. The bounds are 256 entries, 5 MB per expanded entry and 8 MB total expanded content. Existing signature/macro/script checks and these format/resource checks are not comprehensive antivirus scanning. Encrypted, corrupt and image-only documents fail with conversion/OCR guidance. Strict UTF-8 decoding rejects replacement-character corruption. Strict PDF extraction removes parser-generated page markers, so empty pages cannot masquerade as source text. The existing CV extraction defaults remain compatible.

Full normalized extracted text is retained up to 50000 characters; larger text is rejected, never silently shortened. The private workflow ledger stores text, binary/text hashes, format, sanitized name, size and original intake revision/fingerprint. The original binary/base64 is not retained or exposed through a download. This is a text-import workflow, not an original-document repository. Retries of identical bytes/type/current snapshot reuse one import even if the submitted filename differs. Import authorization runs before parsing and rechecks after parsing; concurrent SQL finalization and audit writes are atomic. No new table, migration, private-storage mode, timer or sender is added.

A preview and explicit “Use imported text as source” action connect an unchanged complete excerpt to the existing `extract_job_requirements` queue. Sources longer than 8500 characters need an explicit shorter excerpt; all imported text remains available for review. Manual text entry can explicitly clear the document link. Document-based task identity includes the import identity, retaining provenance even when the same text was previously pasted manually. Request, inference, result recording and adoption recheck the source binding. Other job/workspace documents, altered excerpts, stale drafts and tampered source hashes are rejected. Current requirement versions remain authoritative. Import does not enqueue inference, change the role or verify client sign-off. AI completion still records suggestions only; reviewed adoption uses the existing selective versioned intake transaction.

## Verification

Local unit suite: 778 passed, 69 skipped. TypeScript, production build and four hosting entry smokes passed. All 528 disposable MySQL regressions across 28 files passed. Final document/worker focused checks passed 21 tests with 2 SQL-only skips. Regression coverage exercises real PDF/DOCX parsers, long TXT without truncation, duplicate requests, source/adoption provenance, ownership, stage/revision guards, malformed/oversized base64, UTF-8 errors, corrupt/blank PDFs, unsupported ZIPs, macros, encryption flags, bounded/lying expansion sizes, page limits, concurrent imports and audit rollback. The worker outage regression now injects failure only into its intended synthetic owner and waits within the existing bounded global polling fairness model; production polling is unchanged.

Live acceptance passed on implementation commit `ad7431d241930a0dd2c032004448c29ba0b31bbc`; see [sanitized evidence](2026-11-07-jd-document-import-evidence.json).

## Live acceptance

Owner desktop DOCX upload, exact retry reuse, production PDF parsing and long TXT import passed. The complete long source remained available beyond the 8500-character inference limit. Preview and explicit source use bound the document identity to the existing AI task without editing the draft. The managed worker used `nvidia/nemotron-3.5-super-vl:free`, with no manual worker run or explicit retry; it produced nine supported suggestions and one nonselectable category value (`full-time` instead of canonical `full_time`). This pilot does not establish general semantic quality.

At 390 × 844, using the long source retained its full text and disabled extraction. Clearing the document link and switching back to the DOCX source worked without horizontal overflow. Owner review applied eight supported facts to requirement version 2, preserved the manual department and version 1 history, and left the role draft with no verified confirmation. A later manual version 3 edit remained intact after replay of the old adoption. Different adoption selections conflicted. Both browser runs had zero runtime errors.

Document and extraction routes rejected anonymous requests. Invalid base64, corrupt PDF signatures/contents and script payloads were rejected. Old document links became stale after adoption while their full source text and provenance remained readable to the owner. Reusing that stale import for a newer intake conflicted. The synthetic job was cancelled and its company suppressed; the AI task remained completed. The persistent worker was enabled with a recent heartbeat, no emergency stop and no last error. No recipient messages, invitations or payments were sent.

## Remaining scope

Scanned-image OCR, automatic inbox attachment collection, original-binary retention/download/lifecycle, comprehensive malware scanning or parser sandboxing, semantically verified interpretation, automated clarification delivery, authenticated client sign-off and active requisition amendments remain open. This advances scoped M08-F01/F03 and M12-F01 behavior; no full advanced module is complete.
