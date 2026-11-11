# Configured Stripe checkout, verified receipts and reconciliation

Date: 11 November 2026. Scope: M21-F03/F04/F05/F06 and the existing M06 collection path. No whole advanced module is complete.

## Implemented behavior

- `createPaymentLink` now calls the fixed Stripe HTTPS API to create a real Checkout session when configured. It snapshots the owned collectible invoice's exact remaining integer balance, currency, invoice reference, mode, credential fingerprint, HTTPS return origin and expiry before network I/O. Repeated and concurrent commands share the original provider idempotency key and form body. An uncertain command is never replaced merely because a response was lost; requests beyond the safe retry/expiry window require reconciliation.
- Supported checkout currencies are explicitly limited to the existing ledger's two-decimal currencies: INR/USD/EUR/GBP/AUD/CAD/SGD/AED. Unsupported currency exponents fail closed. Provider minimums, limits, account eligibility and payment methods are still enforced by Stripe.
- `/api/webhooks/stripe` preserves the raw signed body in Fastify production and Express development, limits it to 256 KiB, verifies timestamp/HMAC before JSON use and accepts configured account mode only. A persisted intent, exact amount/currency, session identity, mode and payment-intent reference bind payment evidence to the invoice. Redirects never record money.
- Signed paid live events and owner-requested provider reconciliation call the same in-transaction receipt command as existing invoice payments. Receipt, invoice balance, promise coverage, follow-up changes, verification evidence and audit commit under the owner workspace lock. The provider payment-intent reference deduplicates multiple callbacks. The reserved `stripe_verified` source cannot be supplied to the manual receipt API.
- Test-mode success is recorded as `sandbox_paid` without changing the real receipt ledger or invoice status. Live mode additionally requires explicit enablement. Provider-paid always retains `bankSettlementVerified: false`.
- A confirmed payment that cannot fit the current balance/status becomes durable financial review evidence, pauses related follow-ups and blocks further collection preparation. No overpayment is discarded or silently clamped. Refund/dispute notifications on a known verified receipt become separate review observations; they do not manufacture a credit, refund allocation or cleared bank balance.
- Expired and asynchronous failed sessions are retained as terminal history. Reconciliation retrieves the original owned session from Stripe. If the create response was lost, the owner can supply the session ID from the original Stripe idempotency request; the provider response must match the persisted intent before binding or allocation.
- Finance exposes configuration state, checkout/reuse, safe Stripe links, provider status, unresolved financial reviews and reconciliation controls. No new queue, duplicate invoice table, payment table or migration was introduced.

## Configuration

Use private Hostinger environment variables, never committed values:

```dotenv
STRIPE_MODE=test
STRIPE_SECRET_KEY=<Stripe secret API key for the selected mode>
STRIPE_WEBHOOK_SECRET=<Signing secret for this exact webhook endpoint and mode>
STRIPE_LIVE_PAYMENTS_ENABLED=false
```

Keep the existing `APP_BASE_URL=https://freelancehr.overseasjob.in`. Configure Stripe's endpoint as `https://freelancehr.overseasjob.in/api/webhooks/stripe` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created` and `charge.dispute.funds_withdrawn`. Test sessions do not pay real invoices. A deliberate live rollout needs live keys, live webhook signing secret, `STRIPE_MODE=live` and `STRIPE_LIVE_PAYMENTS_ENABLED=true`.

Rotating the configured credential fences reuse/allocation of older intents rather than silently mixing provider accounts. Reconcile outstanding intents using their original account credential before rotation. Webhook signing secret rotation is separate. Stripe Connect, restricted keys, multiple accounts and automatic credential migration are outside this adapter.

## Validation

895 unit tests passed (86 skipped), all 662 disposable MySQL tests passed across 36 files, and types, build, four Hostinger entry checks, seven environment-preparation checks and tracker consistency passed. Targeted final route/runtime checks passed 25 tests (3 SQL-only tests skipped in that unit run). Unit provider responses and signatures are synthetic; no real provider credentials, charge, recipient message or bank transfer is used in those tests. Disposable MySQL databases are local and removed after the run. Live application checks will validate deployment and safe unconfigured behavior, not a real payment.

## Remaining acceptance

Real Stripe account readiness and checkout acceptance, webhook endpoint setup and elapsed delivery/retry acceptance, independent bank settlement, automatic refund/chargeback allocation, unallocated-credit disposition, accounting exports, payout/commission rules and the complete advanced financial subledger remain open. Financial adjustment observations require owner/accounting review; the current UI does not claim to execute refunds or resolve their ledger allocations. Signed events unrelated to a known checkout are not allocated. Other recruitment roadmap packages remain tracked separately in the complete remaining register.
