# Draft C — seam-quality bias (claude)

Archived planning artifact. Superseded by `../README.md` — the canonical
ladder took this draft's single-writer wallet refactor, pure state-machine
framing, and several recon findings, but **rejected its first-party
plan-change endpoints** (decision D1: Portal-owned plan changes). Sections
kept verbatim below because slice 04's kill criteria name this draft as the
fallback design if the Portal cannot express the required behavior.

Marker: SUBSCRIPTION-SPEC-DRAFT-2026-07-17 · Bias: seam quality (one owner
per concept, typed seams, deterministic fixtures).

## 0. Recon summary

- **Wallet today is one number with two writers.** `users.creditBalanceMicroUsd` (`packages/backend/convex/schema.ts:111`) is patched by `applyLedgerEntryWithDb` (`packages/backend/convex/domains/credits/ledger.ts:31-94`) *and independently* by `adjustBalanceAndMonthlySpend` in reservations (`packages/backend/convex/domains/credits/reservations.ts:302-322`, called from settle/release). Any two-bucket change made only in `applyLedgerEntryWithDb` would silently corrupt reservation settle/release.
- **Spend decision is a pure function.** `authorizeSpend` (`creditsShared.ts:112-149`) takes workspace+user docs and returns `SpendAuthorizationDecision` with reasons `insufficient_credits | monthly_cap`; floor is `HARD_BLOCK_FLOOR_MICRO_USD` (`packages/contract/src/ledger/index.ts:5`). Preflight (`ledger.ts:149-175`) and reservations both call it; model gateway consumes it at `modelGateway/preflight.ts:124-166` and maps reasons to 402 bodies in `modelGateway/blocks.ts:15-44` (closed union `GatewayBlockSchema`, `packages/contract/src/gateway/index.ts:51+`).
- **Webhook rail is a single idempotent dispatcher.** `/v1/stripe/webhook` (`convex/http.ts:19-47`) → `processStripeWebhookEventImpl` (`stripeWebhooks.ts:15-115`), idempotent by `stripeWebhookEvents.eventId`, with ledger-reference idempotency as the second rail. Today `invoice.paid` **requires `metadata.source === 'duet'` or is ignored** (`stripeWebhooks.ts:44-54`) — subscription invoices won't carry that invoice-level metadata. Stripe-created subscription PIs have no duet metadata and already fall into the `ignored` branch — a load-bearing accident to pin with a test.
- **Trial + paid-model gating already exist.** Trial grant: `grants.ts:11-43` (global idempotency `signup_grant:canonical:<email>`, $10). `firstPaidAt` (set in `clearTopupErrorWithDb`, `topups.ts:209-228`) gates paid-only models via `evaluateModelAccess` (`packages/contract/src/approved-models/catalog.ts:101-108`).
- **Test rails:** `bun:test` against a real `convexDev` deployment (`packages/backend/src/billing.test.ts:37-51`), test-only ledger probes at `convex/testing/credits.ts`, live staging Stripe acceptance with a resource ledger (`packages/test-harness/src/staging-e2e-synthetic`).
- `users.by_stripe_customer` index exists (`schema.ts:131`); `creditTransactions.workspaceId` is required today (`schema.ts:538`).

## 1. Slice ladder (as drafted)

| # | Slice | Owner |
|---|---|---|
| 00 | contract-grammar | `@repo/contract` |
| 01 | wallet-single-writer | `domains/credits/wallet.ts` (new) |
| 02 | two-bucket-drain | `wallet.ts` + `ledger.ts` |
| 03 | subscription-state-machine | `domains/credits/subscription.ts` (new, pure) |
| 04 | subscription-required-gate | `creditsShared.authorizeSpend` + `blocks.ts` |
| 05 | webhook-projection | `stripeWebhooks.ts` |
| 06 | stripe-subscription-service | `services/stripe.ts` + `planCatalog.ts` + `billingActions.ts` |
| 07 | rest-subscription-surface | `apps/api/src/routes/billing.ts` |
| 08 | settings-billing-ui | `user-settings.tsx` |
| 09 | lander-pricing-page | lander pricing route |
| 10 | subscription-reconcile-sweep | `subscriptionReconcile.ts` + cron |
| 11 | composed-dev-journey | `subscription.test.ts` |
| 12 | staging-e2e-synthetic | test harness |

### The pure state machine (adopted in spirit by canonical slice 05)

```ts
type SubscriptionEvent =
  | { kind: 'started'; planId; stripeSubscriptionId; periodStart; periodEnd }
  | { kind: 'renewed'; invoiceId; periodStart; periodEnd; planId }
  | { kind: 'plan_upgraded'; planId; effectiveAt }        // immediate
  | { kind: 'downgrade_scheduled'; planId }
  | { kind: 'cancel_scheduled' } | { kind: 'lapsed' }
type SubscriptionEffect =
  | { kind: 'reset_monthly_bucket'; grantMicroUsd; grantReference; expiryReference }
  | { kind: 'zero_monthly_bucket'; expiryReference }
  | { kind: 'set_first_paid_at' }
applySubscriptionEvent(current, event): { next; effects: SubscriptionEffect[] }
```

Effects are declarative with deterministic ledger references baked in, so
idempotency is a property of the pure function, testable without a database.

### D1 fallback: first-party plan changes (REJECTED in canonical plan)

The part slice 04's kill criteria would resurrect:

- `services/stripe.ts`: `changeSubscriptionPlan(stripe, { subscriptionId,
  itemId, newPriceId, direction })` — upgrade: immediate item update with
  `proration_behavior: 'create_prorations'`; downgrade: Stripe subscription
  schedule swaps the price at period end. `cancelAtPeriodEnd(stripe, {
  subscriptionId })`.
- `billingActions.ts`: a `changeSubscriptionPlan` action; after the Stripe
  call succeeds, the **upgrade** feeds a `plan_upgraded` event through the
  state machine so the monthly bucket resets to the new allotment
  immediately, keyed
  `subscription_grant:upgrade:<stripeSubscriptionId>:<planId>:<periodStart>`;
  the later `customer.subscription.updated` webhook replays to a no-op
  because both paths share the reference scheme.
- REST: `POST /v1/user/billing/subscription/plan` — body
  `{ workspaceSlug, planId } | { workspaceSlug, cancel: true }`; upgrade
  immediate, downgrade scheduled, cancel at period end; 409 when no
  subscription exists.
- UI: tier picker performs upgrade/downgrade in-app; Portal narrows to
  payment method + invoices.

Known hazard of this path (why it lost): the immediate-upgrade grant cannot
ride `invoice.paid` (the proration invoice is not the full allotment), so a
second grant door exists and the double-entry safety rests entirely on the
shared reference scheme.

### Reconcile sweep (REJECTED-for-now, D4)

`subscriptionReconcile.ts`: for users whose
`billing.subscription.currentPeriodEnd < now − grace`, fetch the live Stripe
subscription and re-project through the state-machine door (same events,
same deterministic references ⇒ safe replay). Never zeroes on suspicion.
Bounded batch, `internalKey`-gated. Convergence property: sweep ∘ sweep =
sweep. Canonical plan covers enforcement lazily (slice 07) and accepts
Stripe's ~72h webhook retries + admin adjustments for missed grants;
resurrect this if missed grants occur in practice.

## Risks the canonical plan absorbed from this draft

1. Subscription `invoice.paid` ignored by today's metadata guard (fixture
   must be captured, not hand-rolled).
2. Two wallet writers (reservations bypass) → single-writer slice.
3. Refund-to-source is not derivable after the fact → record the split at
   hold time.
4. `creditTransactions.workspaceId` required vs account-scoped rows.
5. Auto-topup fires against the paid scalar while a full monthly bucket
   sits unused.
6. Upgrade reset vs proration invoice double-entry hazard.
7. Name collisions: `monthly_cap`/`monthlySpend*` (telemetry) vs monthly
   bucket; gateway `subscription_inactive` (servicing) vs
   `subscription_required`.
8. Stripe API version pin `2026-02-25.clover` — verify payload shapes
   against it, not older docs.

## Rejected alternatives argued in this draft

- Balance inside `users.billing` — spread-patch writers everywhere would
  gain accidental write access; top-level column + wallet module instead.
- A `subscriptions` table — one subscription per payer; a table adds a join
  and a second source of truth.
- Duet-side cron applying downgrades/renewals — a second clock that can
  disagree with the invoice stream; Stripe owns billing time.
- Granting on `checkout.session.completed` / `payment_intent.succeeded` —
  `invoice.paid` is the only event covering first cycle + renewals with a
  stable idempotency key.
- Reusing `adjustment` type for grant/expiry — history/analytics need the
  distinction.
- Extending `createBillingCheckout` with a third implicit mode — the seam
  would guess-the-mode from optionals.
- `subscription_required` as 403 or a new error family — it is a payment
  precondition; staying a 402 union member keeps client handling monotonic.
