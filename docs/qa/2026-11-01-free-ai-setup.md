# Verified free-only OpenRouter — 1 November 2026

The owner added the OpenRouter key directly to hPanel. Code `6ded24b` enforces free-only routing and was verified live on https://freelancehr.overseasjob.in. No key was copied or printed.

Controlled recruitment AI uses `openrouter/free` or an explicit `:free` model ID. Legacy built-in/paid preferences resolve to the free router, and paid fallback entries are removed. The lower-level adapter independently rejects paid primary/fallback routes before fetch. JSON-object output and the actual task schema are requested; validation still precedes result application. Rate limits/provider failures remain visible queue retry/hold cases; no paid substitution occurs.

A synthetic `classify_reply` job completed through the actual production queue and provider. No conversation/candidate ID was attached. The provider selected **nvidia/nemotron-3.5-super-vl:free** and returned a validated explicit opt-out classification with `stop_contact`. This is one observed provider selection, not a pinned model or evidence that every task/model is reliable. The result did not send email or change a business record. The completed QA queue entry and AI usage/audit record remain labelled.

Validation: 423 tests passed, 16 skipped; TypeScript and production build passed. New regressions cover legacy route normalization, explicit free IDs, paid-route refusal before network requests, JSON request format and response validation. [Sanitized live evidence](2026-11-01-free-ai-evidence.json) contains the synthetic result and actual selected model, without credentials.

The existing daily AI job budget is still in effect. Provider request quotas vary; retries/fallbacks can consume more than one request per job, and a shared multi-process account-wide request limiter is not established by this release. Free-only routing does not imply unlimited throughput or full agency automation. Actual CV parsing, drafting and matching need their own representative pilot/evidence checks; all broader unimplemented agency modules remain tracked in the module registry.
