# Monthly subscriptions — implementation-spec draft

Marker: `SUBSCRIPTION-SPEC-DRAFT-2026-07-17`

Proposed materialization:

```text
specs/monthly-subscriptions/
├── README.md
└── slices/
    ├── 01-stripe-contract-oracle.md
    ├── 02-two-bucket-wallet.md
    ├── 03-subscription-webhook-state-machine.md
    ├── 04-subscription-required-and-reservations.md
    ├── 05-period-lapse-enforcement.md
    ├── 06-checkout-portal-and-read-api.md
    ├── 07-product-billing-ui.md
    ├── 08-public-pricing.md
    └── 09-staging-subscription-lifecycle.md
```

## 1. Slice ladder

| # | Slice | One-line contract |
|---|---|---|
| 01 | Stripe contract oracle | Every configured price ID and relevant Stripe event normalizes to exactly one Duet plan/lifecycle meaning or fails closed. |
| 02 | Two-bucket wallet | One account-level wallet primitive drains monthly before paid, resets monthly atomically, and preserves reservation bucket provenance. |
| 03 | Subscription webhook state machine | Any supported webhook ordering converges to one subscription projection and at most one monthly reset per paid invoice. |
| 04 | Subscription-required gating | Charged work proceeds only during the signup trial or an active subscription, through every preflight and settlement adapter. |
| 05 | Period-lapse enforcement | Expired or canceled entitlements zero monthly credits exactly once even if a lifecycle webhook is delayed or missed. |
| 06 | Checkout, Portal, and read API | A browser payer starts a typed recurring plan, manages it in Portal, and reads both balances and normalized subscription state. |
| 07 | Product billing UI | Billing settings make plan state, monthly credits, paid overage, topups, and plan management understandable and operable. |
| 08 | Public pricing | The static lander accurately presents Starter, Pro, Max, trial, reset, overage, and plan-change rules. |
| 09 | Live staging lifecycle | Stripe test mode proves subscribe, grant, spend, spill, upgrade, downgrade, cancellation/lapse, replay safety, and cleanup. |

Dependency graph:

```text
01 Stripe oracle ──────┬──────────────► 06 Checkout/API
                       ├──► 03 webhook state machine ──┬──► 04 gating/reservations
02 wallet ─────────────┘                               ├──► 05 lapse enforcement
                                                      └──► 06 Checkout/API

01 ───────────────────────────────────────────────────────► 08 public pricing
04 + 06 ──────────────────────────────────────────────────► 07 product UI
03 + 04 + 05 + 06 + 07 + 08 ─────────────────────────────► 09 staging E2E
```

Ordering is deliberately risk-first:

1. Slice 01 tests the pinned Stripe payloads and Portal capabilities before schema or UI work. Stripe explicitly does not guarantee webhook delivery order, so the design cannot depend on `subscription.created` preceding `invoice.paid` ([Stripe webhook ordering](https://docs.stripe.com/webhooks)).
2. Slice 02 removes the existing single-balance and reservation bypass hazards before external events can mutate balances.
3. Slice 03 proves duplicate-event, duplicate-invoice, stale-event, renewal, and upgrade convergence.
4. Slice 04 exercises the widest regression surface: post-response charging, reservations, service proxies, and direct API preflight.
5. Slice 05 proves correctness at the period boundary without relying exclusively on Stripe delivery or cron timing.
6. Only then do hosted billing, public responses, and visual surfaces build on the contract.

## End-state contracts and single owners

### Plan catalog

`packages/contract/src/billing/index.ts` owns the commercial constants consumed by backend, product UI, and lander:

```ts
export const SubscriptionPlanSchema = z.enum(['starter', 'pro', 'max'])

export const SUBSCRIPTION_PLANS = {
  starter: {
    monthlyPriceMicroUsd: 20_000_000,
    monthlyCreditsMicroUsd: 20_000_000,
  },
  pro: {
    monthlyPriceMicroUsd: 50_000_000,
    monthlyCreditsMicroUsd: 55_000_000,
  },
  max: {
    monthlyPriceMicroUsd: 200_000_000,
    monthlyCreditsMicroUsd: 230_000_000,
  },
} as const
```

`packages/backend/convex/config.ts` owns the per-environment reverse mapping between those plans and three recurring Stripe price IDs. Configuration must reject missing, duplicated, non-recurring, non-USD, or non-monthly prices before Checkout or webhook processing.

Stripe Portal configuration is also an explicit per-environment prerequisite. Its three prices must share the same Stripe product because Stripe’s scheduled-downgrade support is limited to prices on the same product ([Stripe Portal configuration](https://docs.stripe.com/customer-management/configure-portal)).

### Durable account projection

Greenfield schema—required fields, no optional cutover state:

```ts
users: {
  creditBalanceMicroUsd: number          // paid/trial/topup
  monthlyCreditBalanceMicroUsd: number   // subscription allotment

  billing?: {
    // Existing topup/cap/error fields remain.

    subscriptionEverActivatedAt?: number

    subscription?: {
      stripeSubscriptionId: string
      stripePriceId: string
      plan: SubscriptionPlan
      status:
        | 'incomplete'
        | 'incomplete_expired'
        | 'trialing'
        | 'active'
        | 'past_due'
        | 'canceled'
        | 'unpaid'
        | 'paused'
      currentPeriodStart: number
      currentPeriodEnd: number
      cancelAtPeriodEnd: boolean
      pendingPlan?: SubscriptionPlan
      latestLifecycleEventCreatedAt: number
      latestLifecycleEventId: string
    }

    monthlyCreditEpoch?: string            // canonical paid invoice ID
    monthlyCreditExpiresAt?: number        // paid invoice line period end
    latestEntitlementInvoiceCreatedAt?: number
  }
}
```

`monthlyCreditExpiresAt` is owned by the last accepted paid invoice, not blindly by the subscription lifecycle object. An unpaid renewal must not advance the entitlement deadline.

The current schema has only one required balance and a topup-oriented billing object (`packages/backend/convex/schema.ts:102-131`). New-user creation currently initializes only `creditBalanceMicroUsd` (`packages/backend/convex/domains/users/model.ts:57-68`).

### Wallet shapes

```ts
type WalletBalances = {
  monthlyCreditBalanceMicroUsd: number
  paidCreditBalanceMicroUsd: number
  availableCreditBalanceMicroUsd: number // derived, never stored
}

type SpendAllocation = {
  monthlyDebitMicroUsd: number
  paidDebitMicroUsd: number
  monthlyCreditEpoch?: string
}
```

One new `credits/wallet.ts` module owns all mutations of both balances. No ledger, reservation, settlement, admin, testing, or webhook caller patches either field directly.

### Ledger

Continue using `creditTransactions`; add:

```ts
type TransactionType =
  | 'grant'
  | 'topup'
  | 'usage'
  | 'adjustment'
  | 'reservation'
  | 'subscription_grant'
  | 'subscription_expiry'
```

Make `creditTransactions.workspaceId` optional for account-level subscription rows. Subscription renewals are user-wide and cannot safely depend on the Checkout workspace remaining live or retaining the same payer. Existing usage, topup, reservation, and workspace-ledger rows remain workspace-attributed.

The current primitive loads a workspace and derives its current payer before touching the account (`credits/ledger.ts:48-70`; `creditsShared.ts:37-59`). That is unsuitable as the ownership seam for unattended renewal.

A reset is one atomic mutation:

```ts
resetMonthlyCreditsWithDb(ctx, {
  userId,
  invoiceId,
  invoiceCreatedAt,
  subscriptionId,
  plan,
  periodStart,
  periodEnd,
  allotmentMicroUsd,
  now,
}): Promise<{
  applied: boolean
  expiredMicroUsd: number
  grantedMicroUsd: number
  balances: WalletBalances
}>
```

It always inserts:

```text
subscription_expiry:invoice:<invoiceId>  amount = -unusedMonthly
subscription_grant:invoice:<invoiceId>   amount = +planAllotment
```

The expiry row exists even when unused monthly credit is zero, as required.

## 2. Per-slice specification

### Slice 01 — Stripe contract oracle

**Contract:** Given deployment configuration or an SDK-shaped Stripe event, return one normalized meaning or fail without mutating billing state.

**API seam**

- `packages/contract/src/billing/index.ts`
  - `SubscriptionPlanSchema`
  - `SUBSCRIPTION_PLANS`
  - public plan/status schemas
- `packages/backend/convex/config.ts`
  - `stripeSubscriptionPriceIds(env)`
  - `stripePlanForPriceId(priceId, env)`
  - `stripeBillingPortalConfigurationId(env)`
- `packages/backend/convex/services/stripe.ts`
  - extend its narrow interface for subscription, invoice, schedule, and Portal-configuration retrieval
- New `domains/credits/subscriptionEvents.ts`:

```ts
type NormalizedSubscriptionEvent =
  | {
      kind: 'invoice_paid'
      eventId: string
      eventCreatedAt: number
      invoiceId: string
      invoiceCreatedAt: number
      customerId: string
      subscriptionId: string
      priceId: string
      plan: SubscriptionPlan
      periodStart: number
      periodEnd: number
      billingReason:
        | 'subscription_create'
        | 'subscription_cycle'
        | 'subscription_update'
    }
  | {
      kind: 'subscription_lifecycle'
      eventId: string
      eventCreatedAt: number
      customerId: string
      subscriptionId: string
      priceId: string
      plan: SubscriptionPlan
      status: SubscriptionStatus
      currentPeriodStart: number
      currentPeriodEnd: number
      cancelAtPeriodEnd: boolean
      pendingPlan?: SubscriptionPlan
    }
  | {
      kind: 'subscription_deleted'
      eventId: string
      eventCreatedAt: number
      customerId: string
      subscriptionId: string
    }
```

Current `invoice.paid` handling depends on invoice metadata containing `workspaceId` and `userId` (`credits/stripeWebhooks.ts:44-57`). The subscription path must resolve the account through Stripe customer/subscription identity and the existing `users.by_stripe_customer` index (`schema.ts:129-131`), not assumed metadata inheritance.

Tighten `payment_intent.succeeded` to require `metadata.type === 'credit_topup'`. It currently checks only `source === 'duet'` before crediting received cents (`stripeWebhooks.ts:58-81`), creating a subscription double-credit risk.

**Human can run/see**

A table-driven fixture report for:

- initial Checkout;
- renewal;
- immediate prorated upgrade;
- scheduled downgrade;
- cancel-at-period-end;
- deletion;
- invoice before lifecycle event;
- duplicate event;
- two events wrapping one invoice;
- irrelevant/manual invoice.

**Verification**

- Unit tests pin all three prices/allotments.
- Missing or duplicate price IDs fail clearly.
- Test-mode price probes verify recurring USD/month and same-product Portal eligibility.
- Captured fixtures from the repo’s pinned Stripe API version `2026-02-25.clover` normalize deterministically (`services/stripe.ts:1-37`; existing assertion at `billing.test.ts:334`).
- A subscription invoice/payment intent never enters the topup branch.
- Portal configuration proves immediate prorated upgrades, scheduled downgrades, and period-end cancellation. Stripe requires `always_invoice` when an update must immediately invoice prorations ([Stripe prorations](https://docs.stripe.com/billing/subscriptions/prorations)).

**Must stay green**

- Contract billing/gateway tests.
- `packages/backend/src/billing.test.ts`.
- Existing Stripe API-version and hosted-session parameter tests.
- Root typecheck/lint.

**Kill criteria**

Stop before schema work if:

- renewal or upgrade cannot yield customer, subscription, current price, and entitlement period from the event plus at most one authoritative Stripe retrieval;
- upgrade versus renewal cannot be distinguished;
- Portal cannot enforce immediate upgrade and scheduled downgrade;
- fixture order changes normalized meaning.

Do not infer plan from invoice dollars, line ordering, or copied metadata.

---

### Slice 02 — Two-bucket wallet

**Contract:** Every credit mutation uses one account-level wallet owner; usage drains monthly then paid, while reset and cancellation never roll monthly value forward.

**API seam**

- `schema.ts`
  - required `monthlyCreditBalanceMicroUsd`
  - new transaction types
  - optional `creditTransactions.workspaceId`
  - subscription/customer/expiry indexes
- `domains/users/model.ts`
  - initialize both balances to zero
- New `credits/wallet.ts`
  - `walletBalances(user)`
  - `allocateSpend(user, amount)`
  - `applyPaidCreditWithDb(...)`
  - `applySpendWithDb(...)`
  - `resetMonthlyCreditsWithDb(...)`
  - `expireMonthlyCreditsWithDb(...)`
- Refactor `applyLedgerEntryWithDb` into a discriminated credit-transaction command or replace it; do not leave a compatibility wrapper that permits callers to select the wrong bucket.
- Usage/reservation private metadata gains:

```ts
walletAllocation: {
  monthlyDebitMicroUsd: number
  paidDebitMicroUsd: number
  monthlyCreditEpoch?: string
}
```

Trial grants remain paid-bucket `grant` entries and retain global canonical-email idempotency (`grants.ts:11-42`). Topups and ordinary adjustments remain paid-bucket entries.

Usage still increments account/workspace monthly spend and schedules usage rollups only for actual `usage`; that behavior currently lives at `ledger.ts:63-91`.

**Reservation invariant**

Current holds use the ledger, but settlement and release directly patch the single paid balance (`reservations.ts:119-235,302-321`). Replace that bypass.

- Hold records exact monthly/paid allocation and epoch.
- If actual exceeds estimate, the extra charge drains the current wallet monthly-first.
- Unused paid hold always returns to paid.
- Unused monthly hold returns only if its epoch is still current.
- If renewal, upgrade, cancellation, or lapse changed the epoch, the stale monthly refund expires rather than reappearing or becoming paid value.
- Terminal reservation rows retain the current append-plus-projection convention (`reservations.ts:238-283`).

**Human can run/see**

Deterministic traces:

1. monthly $5, paid $7, debit $3 → monthly $2, paid $7;
2. next debit $5 → monthly $0, paid $4;
3. replay → unchanged;
4. reset with $2 unused → expiry -$2, grant +new allotment;
5. hold → renewal → release does not resurrect the old monthly portion.

**Verification**

- Pure allocation matrix: monthly-only, paid-only, exact boundary, spill, zero, and post-response overdraft.
- OCC/concurrent replay tests update both balances once.
- Reset produces exactly one expiry and one grant per invoice.
- An older invoice delivered after a newer invoice cannot reset the current epoch.
- Reservation settle/release tests cover same epoch and crossed epoch.
- Ledger sum and stored wallet remain reconcilable.
- Update internal testing/admin balance helpers to consume the wallet owner.

**Must stay green**

- Existing ledger reference/OCC tests (`credits.test.ts:55-78`).
- Trial grant test (`credits.test.ts:310-347`).
- Reservation round-trip and terminal-projection tests.
- Monthly-cap and usage-rollup tests.
- Topup PaymentIntent and backoff tests.

**Kill criteria**

Stop if any production path directly patches either balance, or if a reservation crossing a reset can mint, lose, or convert monthly value. Do not solve this with a third bucket or a later reconciliation job.

---

### Slice 03 — Subscription webhook state machine

**Contract:** Exact replay, logical invoice replay, and out-of-order lifecycle delivery all converge to one subscription projection and one monthly reset.

**API seam**

- `convex/http.ts` keeps raw-body signature verification (`http.ts:19-45`) and passes `event.id`, `event.created`, type, and normalized payload onward.
- `credits/stripeWebhooks.ts` owns event dispatch and `stripeWebhookEvents` idempotency, not Stripe-shape interpretation.
- New `credits/subscriptions.ts`:
  - `applySubscriptionLifecycleWithDb`
  - `applyPaidSubscriptionInvoiceWithDb`
  - `deleteSubscriptionWithDb`
  - `effectiveEntitlementAt(user, now)`
- Account lookup uses customer/subscription indexes.
- `customer.subscription.created/updated/deleted` mutates lifecycle only.
- `invoice.paid` for `subscription_create`, `subscription_cycle`, or `subscription_update` is the sole monthly-grant authority.
- Grant amount comes from `SUBSCRIPTION_PLANS`, never invoice/proration amount.
- An upgrade’s paid `subscription_update` invoice expires unused old credits and grants the new plan’s full allotment immediately.
- Scheduling a downgrade causes no reset; the reset occurs only when the later paid invoice carries the lower price.
- Cancellation at period end retains the current epoch until its paid-through boundary.
- Deleted/immediately lapsed subscriptions expire monthly credits, leaving paid credits unchanged.

Idempotency remains two-layered:

- `stripeWebhookEvents.eventId` protects exact replay (`schema.ts:618-623`; `stripeWebhooks.ts:20-24`);
- ledger references keyed by invoice protect the same invoice arriving under another event ID (`schema.ts:553-557`; `creditsShared.ts:159-175`).

Lifecycle projection uses a monotonic reducer over normalized event creation time plus event ID and period data. Entitlement invoice ordering uses `(periodEnd, invoiceCreatedAt, invoiceId)`, allowing a later same-period upgrade to supersede the earlier grant while rejecting an old invoice delivered late.

**Human can run/see**

A permutation harness runs the same fixture set in normal and reversed order and prints identical subscription state, bucket balances, epoch, and ledger references.

**Verification**

- `invoice.paid` before `subscription.created`.
- Lifecycle event before invoice.
- Duplicate event ID.
- Two event IDs for one invoice.
- Stale active update after cancellation/deletion.
- Renewal replay.
- Upgrade invoice amount unrelated to full credit allotment.
- Scheduled downgrade does nothing until next paid period.
- Subscription PaymentIntent cannot create paid topup credit.
- Event marker is inserted only after successful state changes, preserving the current transactional “marker last” behavior (`stripeWebhooks.ts:113-126`).
- Subscription success does not accidentally call the current topup recovery helper, which also sets `firstPaidAt` and reactivates paused workspaces (`topups.ts:209-227`).

**Must stay green**

- Signed webhook HTTP test.
- Setup-intent readiness.
- Topup replay and invoice/payment-intent non-double-credit tests (`billing.test.ts:186-284`).
- Paused versus banned workspace recovery tests (`billing.test.ts:130-183`).

**Kill criteria**

Stop if any event permutation changes plan, paid-through boundary, balance, epoch, or row count. Also stop if a subscription invoice can be credited both as paid topup dollars and monthly plan credits.

---

### Slice 04 — `subscription_required` and reservation integration

**Contract:** Charged usage proceeds during the signup trial or a current subscription entitlement; after trial/lapse it consistently returns `subscription_required`.

**API seam**

Extend:

- `PreflightBlockReasonSchema` in `contract/src/ledger/index.ts:16-30`;
- `SpendAuthorizationDecision` in `creditsShared.ts:19-35`;
- `runPreflight` validators/results in `credits/internal.ts:60-108`;
- reservation result types in `reservations.ts:42-62`;
- `GatewayBlockSchema` in `contract/src/gateway/index.ts:50-103`;
- `modelGateway/blocks.ts:15-45`;
- direct API translation at `apps/api/src/shared.ts:248-298`;
- service-proxy translation at `domains/serviceProxy/model.ts:47-55`.

Wire block:

```ts
{
  status: 402,
  body: {
    error: 'subscription_required',
    code: 'subscription_required',
    billingUrl: string
  }
}
```

Authorization order:

```text
1. Is this charged usage entitled by active subscription or remaining signup trial?
2. Is total available wallet above the hard floor / reservation requirement?
3. Is the account monthly cap exceeded?
4. Is the workspace monthly cap exceeded?
```

Trial policy:

- `subscriptionEverActivatedAt === undefined` and usable paid trial balance above the existing $1 hard floor → trial may proceed.
- Once a paid subscription invoice has activated the account, inactive/canceled/lapsed state returns `subscription_required`, even if paid overage remains.
- Manual and automatic topups are overage rails for active subscribers, not a pre-subscription bypass.
- Do not repurpose `firstPaidAt`; it already controls paid-model access and other policies (`modelGateway/preflight.ts:74-79`; `workspaces/birth.ts:36-52`).

All charged adapters must consume the same decision:

- model-gateway reservation path (`modelGateway/preflight.ts:124-157`);
- model-gateway post-response preflight (`modelGateway/preflight.ts:159-166`);
- post-response settlement (`modelGateway/settlement.ts:178-209`);
- service proxy (`serviceProxy/model.ts:47-103`);
- direct API spend helper (`apps/api/src/shared.ts:248-298`).

Free approved models remain outside charged preflight as they are today (`modelGateway/preflight.ts:105-123`).

Auto-topup keeps its existing threshold/amount/idempotency/backoff behavior but watches the paid bucket and schedules only for active subscriptions. The current scheduler runs before authorization and checks `creditBalanceMicroUsd` (`ledger.ts:167-199`).

**Human can run/see**

One fixture table covers both billing modes:

- trial succeeds;
- exhausted trial blocks;
- active Starter succeeds;
- monthly debit spills into paid;
- active account with no total funds returns `insufficient_credits`;
- inactive subscriber with paid overage returns `subscription_required`;
- account/workspace caps retain their priority;
- reservation held before renewal settles/releases safely.

**Verification**

- Pure authorization reason-precedence tests.
- Convex preflight/reservation response tests.
- Gateway/service/API tests assert identical 402 code and billing URL.
- Post-response settlement may still exceed the preflight estimate and drive paid negative; monthly must never go negative. Existing tests intentionally allow negative settlement (`credits.test.ts:235-237`).
- Actual usage and rollups remain identical regardless of debit allocation.

**Must stay green**

- Account/workspace cap and period-roll tests (`credits.test.ts:195-308`).
- Free-model, post-response, reservation, retry, and missed-charge gateway tests.
- Service-proxy billing tests.
- Existing auto-topup idempotency and three-failure backoff.

**Kill criteria**

Stop if any charged surface bypasses `subscription_required`, or if reservation versus post-response mode produces different entitlement, balance, or actual-usage semantics.

---

### Slice 05 — Period-lapse enforcement

**Contract:** At or after the last paid entitlement boundary, stale monthly credits cannot authorize spend and are expired exactly once.

**API seam**

- `ensureCurrentEntitlementWithDb(ctx, user, now)`:
  - called before charged preflight and reservation;
  - compares `monthlyCreditExpiresAt`, subscription status, and current epoch;
  - writes `subscription_expiry:lapse:<subscriptionId>:<epoch>` if needed.
- `expireLapsedSubscriptions({cursor?, limit, now})`:
  - bounded indexed scan;
  - idempotent;
  - added to `credits/internal.ts`.
- Add a frequent Convex cron alongside the existing five-minute missed-charge sweep and daily usage pruning (`convex/crons.ts:23-48`).

Correctness comes from the lazy request-time guard. The cron provides prompt projection convergence and ledger cleanup; neither mechanism is sufficient alone.

A read-only billing query may project `monthlyCreditBalanceMicroUsd: 0` and `status: 'lapsed'` once the boundary has passed, but it must not mutate.

**Human can run/see**

Advance a deterministic clock across:

```text
expiresAt - 1 → spend permitted
expiresAt     → subscription_required, monthly = 0
expiresAt + 1 → same state, no additional expiry row
```

**Verification**

- Missing renewal webhook.
- Late deleted webhook.
- Sweep racing lazy preflight.
- Cancel-at-period-end before and at boundary.
- Older paid invoice cannot reopen an expired period.
- A newer paid invoice arriving after local lapse grants its later period once.
- Cursor/limit behavior across multiple accounts.
- No ledger scan on preflight.

**Must stay green**

- Existing cron definitions.
- Billing retention and missed-charge sweeps.
- Preflight latency remains bounded to direct/indexed reads.

**Kill criteria**

Stop if correctness depends solely on cron timing or `customer.subscription.deleted`, or if a late old invoice can reopen expired credits.

---

### Slice 06 — Subscription Checkout, Portal, and read API

**Contract:** An authenticated payer can start a selected recurring plan and read a validated wallet/subscription projection; existing topup Checkout remains distinct.

**API seam**

Prefer a dedicated endpoint instead of overloading the current optional-amount helper:

```http
POST /v1/user/billing/subscription/checkout
```

```ts
type SubscriptionCheckoutRequest = {
  workspaceSlug: string
  plan: 'starter' | 'pro' | 'max'
}

type HostedSessionResponse = { url: string }
```

Backend:

- `billingActions:createSubscriptionCheckout`
- `services/stripe.createSubscriptionCheckout(...)`
- Checkout parameters:

```ts
{
  mode: 'subscription',
  customer: customerId,
  line_items: [{ price: configuredPriceId, quantity: 1 }],
  subscription_data: {
    metadata: {
      source: 'duet',
      type: 'subscription',
      userId,
    },
  },
  success_url,
  cancel_url,
}
```

The browser never supplies a raw price ID.

The existing helper’s setup and one-time payment branches remain intact (`services/stripe.ts:82-135`). Portal remains `POST /v1/user/billing/portal`, but uses the environment-owned Portal configuration.

Reject a second nonterminal subscription; resubscription is allowed only after the stored subscription becomes terminal.

Extend `UserBillingOverviewSchema`:

```ts
{
  paidCreditBalanceMicroUsd: number
  monthlyCreditBalanceMicroUsd: number
  availableCreditBalanceMicroUsd: number
  monthlySpendMicroUsd: number

  trial: {
    status: 'available' | 'exhausted' | 'ended'
  }

  subscription?: {
    plan: SubscriptionPlan
    status: SubscriptionStatus
    currentPeriodStart: number
    currentPeriodEnd: number
    creditsExpireAt: number
    cancelAtPeriodEnd: boolean
    pendingPlan?: SubscriptionPlan
  }

  // existing topup, cap, error, payment-method, and payer-workspace fields
}
```

Hard-cut over the ambiguous `balanceMicroUsd`; the current public contract exposes only that field (`contract/src/billing/index.ts:46-68`).

Account-level history rows use:

```ts
{
  id: string
  scope: 'account' | 'workspace'
  workspaceId?: string
  workspaceName?: string
  amountMicroUsd: number
  type: TransactionType
  createdAt: number
}
```

Workspace ledger remains workspace-only and continues hiding references/metadata (`credits/ledger.ts:109-127`). Update endpoint registry and developer docs because billing endpoints are registered at `contract/src/endpoints/index.ts:486-531`.

**Human can run/see**

- Fake-Stripe parameter snapshots for Starter/Pro/Max.
- JSON fixtures for trial, active, canceling, lapsed, upgraded, and scheduled-downgrade accounts.
- A real test-mode subscription Checkout URL.

**Verification**

- Contract schemas reject unknown plans and raw price IDs.
- Existing customer reuse and canceled-Checkout behavior.
- Payer authorization through `billingSessionAccount`, currently tied to a live payer workspace (`userBilling.ts:118-133,188-206`).
- Existing return URL remains derived from configured app origin (`apps/api/src/routes/billing.ts:137-154`).
- Total equals paid plus monthly.
- No Stripe customer, subscription, invoice, price, ledger reference, or private metadata leaks.
- Existing setup/topup/Portal tests stay green (`billing.test.ts:337-473`).
- `apps/api/src/index.test.ts` billing auth/update tests and SPA client tests are updated.

**Must stay green**

- Manual topup and threshold auto-topup.
- Setup-intent readiness.
- API browser-session and payer authorization.
- Endpoint/docs coverage and generated types.

---

### Slice 07 — Product billing UI

**Contract:** Billing settings clearly distinguish subscription entitlement from paid overage while preserving all existing topup controls.

**API seam**

- `apps/web/spa/api/client.ts`
  - `createSubscriptionCheckout(workspaceSlug, plan)`
  - existing topup and Portal methods remain explicit
- `apps/web/spa/routes/user-settings.tsx`
  - trial/no-plan: plan cards and Subscribe actions;
  - active: plan, renewal date, monthly remaining, paid overage, total;
  - canceling: “active until” state;
  - lapsed: `subscription_required` callout and resubscribe;
  - pending downgrade;
  - failed renewal/payment;
  - existing manual topup, threshold, auto-topup, cap, and error controls;
  - history labels for grant and expiry.

The current page is payment-method-first and renders one balance metric (`user-settings.tsx:131-303`). Replace that hierarchy rather than adding subscription cards below it.

Extend existing hermetic playground ownership in `spa-shell-playground.tsx` with:

```text
settings-billing-trial
settings-billing-active-starter
settings-billing-active-pro-overage
settings-billing-canceling
settings-billing-downgrade-scheduled
settings-billing-lapsed
settings-billing-topup-error
```

**Human can run/see**

Desktop and mobile playground shots for all states, plus interaction fixtures for subscribe, Portal, topup, and auto-topup.

**Verification**

Per repo instructions, implementation begins with `ui-playground` and red visual reproduction.

- API client request tests.
- CTA/state presentation tests.
- Docker visual regression.
- Keyboard, busy, disabled, error, and no-payer states.
- Run `screenshot-critique` unprimed as the final check.
- Run `compare-screenshots` against the existing billing shot, judging hierarchy, loss of existing controls, and comprehension of the two balances.
- Open shots with `preview-shots`; review is non-blocking with the spec’s short response window.

**Must stay green**

- Web’s API-only data boundary from `apps/web/README.md`.
- Existing billing-decline fixture.
- SPA shell visual ownership/coverage.
- Auth continuity and route tests.

**Acceptance criterion**

An active user must be able to answer, without explanatory copy elsewhere:

1. Which plan am I on?
2. When do included credits reset?
3. How much monthly credit remains?
4. How much permanent paid overage remains?
5. Where do I upgrade, downgrade, cancel, or top up?

---

### Slice 08 — Public pricing

**Contract:** The static pricing page displays the exact commercial contract without retaining usage-only claims.

**API seam**

- `apps/lander/app/[locale]/pricing/page.tsx`
- lander pricing translations and page-copy metadata
- shared `SUBSCRIPTION_PLANS` constants, with no second hand-maintained numeric catalog

Replace the current Free Trial / Usage / Enterprise tier grid (`pricing/page.tsx:197-258`) with:

- separate signup-trial explanation;
- Starter: $20/month, $20 monthly credits;
- Pro: $50/month, $55 monthly credits;
- Max: $200/month, $230 monthly credits;
- monthly reset/no rollover;
- paid-balance spill and manual/automatic topups;
- immediate upgrade;
- downgrade and cancellation at period end.

If Enterprise remains, it is a separate procurement callout, not a fourth subscription plan.

Replace the usage-only sample receipt and FAQ claims. The current copy says usage is simply billed monthly and emphasizes no platform fee (`pricing/page.tsx:261-360`; `messages/en/marketing.json:348-357,370-386,406-418`).

**Human can run/see**

Localized desktop/mobile `/pricing` shots, including Spanish.

**Verification**

- Static assertions pin every plan amount and commercial rule.
- Locale completeness and SEO metadata checks.
- Lander static-export and dependency-firewall checks.
- Visual regression.
- `screenshot-critique` as the final unprimed review.
- `compare-screenshots` against the current pricing page for hierarchy and mobile legibility.
- Non-blocking `preview-shots` review.

**Must stay green**

- Lander remains static and free of auth, Convex, browser-session, or product-API ownership per `apps/lander/README.md`.
- Public route, locale, content, SEO, and visual coverage checks.

**Acceptance criterion**

No rendered price/allotment may be a freehand literal without an automated equality assertion against `SUBSCRIPTION_PLANS`, and no usage-only billing promise may remain on the pricing page.

---

### Slice 09 — Live Stripe staging lifecycle

**Contract:** A fresh Stripe test-clock account completes the real subscription lifecycle through deployed browser/API/webhook seams with complete cleanup.

**API seam**

Extend `packages/test-harness/src/staging-e2e-synthetic`. It already:

- refuses non-test Stripe keys (`staging-e2e-synthetic:20`);
- drives Checkout in a real browser (`:31-135`);
- records sessions/customers for cleanup (`:20-88`);
- verifies customer deletion (`:199-225`).

Add resource-ledger ownership for:

- Stripe test clock;
- customer;
- Checkout and Portal sessions;
- subscription;
- invoices;
- subscription schedule.

Suggested live legs:

1. Fresh account receives signup trial and can perform charged usage.
2. Exhaust trial; charged preflight returns `subscription_required`.
3. Create a Stripe test-clock customer, associate it through a testing-only staging seam, and start Starter Checkout through the UI.
4. Complete Checkout and poll public billing state until:
   - Starter active;
   - monthly balance $20;
   - one invoice-canonical grant and one expiry row.
5. Perform monthly-first spend.
6. Add paid topup and spend past monthly balance; paid bucket supplies the remainder.
7. Replay the signed invoice event or safe event-delivery test seam; balances and ledger counts remain unchanged.
8. Upgrade Starter → Pro with immediate Stripe proration; observe expiry of unused Starter credits and full $55 Pro reset.
9. Schedule Pro → Starter downgrade through Portal; verify Pro remains current before the boundary.
10. Cancel at period end; verify credits remain until that boundary.
11. Advance the Stripe test clock; prove monthly expiry and `subscription_required`.
12. Cancel/delete remaining Stripe resources and verify cleanup.

The staging harness must poll durable state rather than sleep fixed intervals. Public assertions use REST/UI; testing queries are limited to raw ledger reference/count evidence.

**Human can run/see**

```bash
bun run e2e:staging
```

Artifacts:

- redacted state-transition timeline;
- billing UI shots;
- public overview snapshots;
- bucket deltas;
- ledger type/reference counts;
- Stripe resource cleanup report.

**Verification**

- Real subscription Checkout.
- Real signed webhook route.
- Real paid renewal/upgrade invoice.
- Real Portal configuration and scheduled downgrade.
- Real charged model-gateway request.
- Duplicate-invoice protection.
- No secret or card data in artifacts.
- Subscription/schedule cancellation precedes customer deletion.
- Existing staging legs and cleanup guarantees remain green.

**Kill criteria**

The feature is not complete if:

- the live upgrade payload differs from Slice 01’s normalized contract;
- Portal applies a downgrade immediately;
- cancellation removes credits before the period end;
- one invoice creates multiple grants;
- monthly credit spends after its paid-through boundary;
- any created Stripe resource cannot be proven cleaned up.

## 3. Recon risks, unknowns, firewalls, and rejected alternatives

### Risks and unknowns

1. **Workspace-coupled ledger versus account subscription.** Every current transaction requires a workspace (`schema.ts:537-557`), and the ledger resolves the current workspace payer (`ledger.ts:48-53`). A deleted or reassigned Checkout workspace could otherwise break renewal. This plan makes subscription rows account-level.

2. **Reservation corrections bypass the ledger.** Settlement/release directly patch the paid balance (`reservations.ts:302-321`). Changing only `applyLedgerEntryWithDb` would silently corrupt two-bucket refunds.

3. **Held reservations cross subscription epochs.** Existing hold metadata records estimate/status but no bucket allocation or entitlement epoch (`reservations.ts:91-105`). Without an epoch, release after renewal creates rollover.

4. **Webhook ordering is not guaranteed.** Stripe explicitly warns integrations not to depend on event order ([Stripe webhooks](https://docs.stripe.com/webhooks)). The current handler protects only exact event replay, not stale lifecycle updates (`stripeWebhooks.ts:20-24`).

5. **Invoice identity currently relies on metadata.** Current `invoice.paid` ignores invoices lacking Duet workspace/user metadata (`stripeWebhooks.ts:44-57`). Subscription renewal must use customer/subscription identity.

6. **PaymentIntent classification is too broad.** Any Duet-sourced successful PaymentIntent currently becomes paid credits (`stripeWebhooks.ts:58-81`). This must be narrowed before subscription invoices exist.

7. **Topup recovery has unrelated side effects.** `clearTopupErrorWithDb` clears failures, sets `firstPaidAt`, and may reactivate a paused workspace (`topups.ts:209-227`). Subscription invoice success needs a separate policy owner.

8. **Two charged gateway paths exist.** Reservations debit during preflight (`modelGateway/preflight.ts:124-157`); post-response usage debits during settlement (`modelGateway/settlement.ts:178-209`). Both must consume the same wallet owner.

9. **Other preflight adapters exist.** Service proxies translate the same decision (`serviceProxy/model.ts:47-55`), while API routes have a separate block translator (`apps/api/src/shared.ts:248-298`). Missing either would create route-dependent subscription enforcement.

10. **`subscription_inactive` already means something else.** A paused workspace maps to that existing gateway code (`modelGateway/preflight.ts:63-65`; `modelGateway/blocks.ts:47-61`). It is not the new account-level `subscription_required` state.

11. **Trial and topups share the paid bucket.** Signup trial grants are ordinary paid-bucket `grant` rows (`grants.ts:23-32`). Therefore an explicit `subscriptionEverActivatedAt` is necessary, and pre-subscription topups must not bypass the gate.

12. **“Trial exhausted” currently means the $1 floor, not zero.** `HARD_BLOCK_FLOOR_MICRO_USD` is $1 (`contract/src/ledger/index.ts:5`), and authorization blocks at or below it (`creditsShared.ts:118-129`). This plan preserves that behavior.

13. **No current lapse rail exists.** Billing cron work currently only prunes daily usage (`convex/crons.ts:41-48`). Correctness needs lazy expiry plus a bounded sweep.

14. **Paid-through versus lifecycle period must be separate.** Inference: an unpaid renewal may advance or change Stripe lifecycle period data without producing `invoice.paid`; entitlement therefore follows the last paid invoice line period, not lifecycle projection alone.

15. **Past-due policy.** Inference selected for the plan: no new credits without `invoice.paid`; already paid credits remain usable only through their recorded paid-through boundary. At that boundary, `past_due` becomes `subscription_required` and monthly credits expire.

16. **Multiple subscriptions.** Inference selected for the plan: one nonterminal Stripe subscription per user. Checkout rejects another, and webhook processing fails loudly rather than merging two monthly allotments.

17. **Public API currently exposes one ambiguous balance.** `UserBillingOverviewSchema` has only `balanceMicroUsd` (`contract/src/billing/index.ts:46-68`), and the UI renders one “Credit balance” (`user-settings.tsx:203-219`).

18. **Public pricing currently contradicts the feature.** It advertises Free Trial / Usage / Enterprise and reinforces usage-only monthly billing (`pricing/page.tsx:197-360`).

19. **Existing staging ownership is suitable.** The current live billing leg already owns real Stripe browser work and cleanup (`staging-e2e-synthetic:11-225`); a second harness would duplicate lifecycle and secret policy.

### Scope firewalls

- No migrations, backfills, compatibility aliases, optional legacy fields, dual reads/writes, or deploy-order choreography.
- No third trial bucket, second wallet table, or second subscription ledger.
- No workspace-owned subscriptions.
- No arbitrary “subscription workspace” required for renewal ledger writes.
- No client-supplied Stripe price IDs.
- No grant on `checkout.session.completed` or `customer.subscription.updated`.
- No credit amount derived from invoice amount, tax, discounts, or proration.
- No reset when a downgrade is merely scheduled.
- No monthly-to-paid conversion on expiry, cancellation, release, or settlement.
- No subscription grants/expiry counted as usage or monthly-cap spend.
- No change to usage rollup schemas or retention.
- No change to topup amount, threshold, five-minute idempotency window, or three-failure backoff.
- No auto-topup of the monthly bucket.
- No use of workspace `servicingStatus` as account subscription state.
- No request-time Stripe dependency; spend authorization reads the local projection.
- No direct Stripe calls from apps/api, apps/web, or apps/lander; `packages/backend/convex/services/stripe.ts` remains the adapter owner.
- No raw Stripe IDs, invoice IDs, ledger references, or private metadata in public REST/UI responses.
- No in-app card form; Checkout and Portal stay hosted.
- No custom plan-change API if Portal passes Slice 01.
- No lander auth/backend dependency or dynamic pricing fetch.
- No production Stripe resources in automated acceptance.
- No broad internal-admin redesign beyond required type/build updates and correct total-balance projection.

### Rejected alternatives

- **One stored balance plus tagged ledger rows:** cannot expire or prioritize monthly funds without replaying the ledger on every debit.
- **Third persisted trial bucket:** violates the fixed two-bucket wallet.
- **Workspace-owned subscription:** conflicts with the existing account-wide payer wallet.
- **Required subscription attribution workspace:** renewal can fail after workspace deletion or payer reassignment.
- **Grant on Checkout completion:** does not cover renewals and is not payment canonical.
- **Grant on subscription lifecycle events:** can precede or duplicate paid invoices.
- **Use invoice dollars as credits:** fails Pro/Max bonuses and full-allotment upgrades.
- **Trust invoice metadata inheritance:** not a durable renewal identity contract.
- **Event-ID-only idempotency:** different events can wrap the same invoice.
- **Cron-only lapse:** leaves a post-boundary spending window.
- **Preflight-only lapse:** blocks spend but leaves stale balance/history indefinitely.
- **Refund stale monthly reservations into paid:** launders expiring credit into permanent value.
- **Treat `firstPaidAt` as subscription state:** it already owns different model/workspace/rate-limit policies.
- **Reuse `servicingStatus`:** conflates workspace administrative/payment health with account entitlement.
- **Let topups satisfy inactive subscription:** restores the pay-as-you-go model the feature explicitly replaces.
- **Overload the current optional-amount Checkout helper with a third implicit mode:** a dedicated subscription endpoint is typed and independently testable.