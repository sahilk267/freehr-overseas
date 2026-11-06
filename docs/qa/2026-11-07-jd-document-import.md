# JD document text import and bound extraction

Date: 7 November 2026 (Asia/Calcutta). Target: `https://freelancehr.overseasjob.in`.

## Behavior

The existing job intake/extraction panel accepts an owned draft's PDF, DOCX or UTF-8 TXT file, with a 2 MB upload limit. It reuses the shared document signature checks and PDF/Mammoth text parsers. PDF import rejects more than 100 pages; DOCX import checks its ZIP directory, allowed compression, entry names, encryption flags and actual bounded expansion before parsing. The bounds are 256 entries, 5 MB per expanded entry and 8 MB total expanded content. Existing signature/macro/script checks and these format/resource checks are not comprehensive antivirus scanning. Encrypted, corrupt and image-only documents fail with conversion/OCR guidance. Strict UTF-8 decoding rejects replacement-character corruption. Strict PDF extraction removes parser-generated page markers, so empty pages cannot masquerade as source text. The existing CV extraction defaults remain compatible.

Full normalized extracted text is retained up to 50000 characters; larger text is rejected, never silently shortened. The private workflow ledger stores text, binary/text hashes, format, sanitized name, size and original intake revision/fingerprint. The original binary/base64 is not retained or exposed through a download. This is a text-import workflow, not an original-document repository. Retries of identical bytes/type/current snapshot reuse one import even if the submitted filename differs. Import authorization runs before parsing and rechecks after parsing; concurrent SQL finalization and audit writes are atomic. No new table, migration, private-storage mode, timer or sender is added.

A preview and explicit “Use imported text as source” action connect an unchanged complete excerpt to the existing `extract_job_requirements` queue. Sources longer than 8500 characters need an explicit shorter excerpt; all imported text remains available for review. Manual text entry can explicitly clear the document link. Document-based task identity includes the import identity, retaining provenance even when the same text was previously pasted manually. Request, inference, result recording and adoption recheck the source binding. Other job/workspace documents, altered excerpts, stale drafts and tampered source hashes are rejected. Current requirement versions remain authoritative. Import does not enqueue inference, change the role or verify client sign-off. AI completion still records suggestions only; reviewed adoption uses the existing selective versioned intake transaction.

## Verification

Local unit suite: 778 passed, 69 skipped. TypeScript, production build and four hosting entry smokes passed. All 528 disposable MySQL regressions across 28 files passed. Final document/worker focused checks passed 21 tests with 2 SQL-only skips. Regression coverage exercises real PDF/DOCX parsers, long TXT without truncation, duplicate requests, source/adoption provenance, ownership, stage/revision guards, malformed/oversized base64, UTF-8 errors, corrupt/blank PDFs, unsupported ZIPs, macros, encryption flags, bounded/lying expansion sizes, page limits, concurrent imports and audit rollback. The worker outage regression now injects failure only into its intended synthetic owner and waits within the existing bounded global polling fairness model; production polling is unchanged.

Live document import, managed free-model inference, owner browser adoption and cleanup are pending deployment. No recipient communication or real business records are part of QA.

## Remaining scope

Scanned-image OCR, automatic inbox attachment collection, original-binary retention/download/lifecycle, comprehensive malware scanning or parser sandboxing, semantically verified interpretation, automated clarification delivery, authenticated client sign-off and active requisition amendments remain open. This advances scoped M08-F01/F03 and M12-F01 behavior; no full advanced module is complete.
