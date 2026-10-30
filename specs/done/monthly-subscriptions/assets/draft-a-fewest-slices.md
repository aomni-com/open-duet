# Monthly subscription pricing — implementation spec draft

Marker: `SUBSCRIPTION-SPEC-DRAFT-2026-07-17`

Proposed spec folder:

```text
specs/monthly-subscriptions/
├── README.md
└── slices/
    ├── 01-two-bucket-wallet.md
    ├── 02-stripe-subscription-lifecycle.md
    └── 03-customer-surfaces-and-live-acceptance.md
```

## Goal and end-state invariants

Duet has one account-level wallet per designated billing user. It contains:

```ts
type WalletBalance = {
  monthlyCreditBalanceMicroUsd: number
  creditBalanceMicroUsd: number // paid/top-up balance
  balanceMicroUsd: number // derived sum, never stored separately
}
```

The end-state invariants are:

1. Monthly credits and paid credits have one owner: the credits domain in Convex.
2. Every wallet mutation writes exactly one or more rows to the existing `creditTransactions` ledger in the same Convex transaction.
3. Every ledger row exposes its total and bucket allocation:

   ```ts
   type CreditTransaction = {
     amountMicroUsd: number
     monthlyAmountMicroUsd: number
     paidAmountMicroUsd: number
     // amountMicroUsd === monthlyAmountMicroUsd + paidAmountMicroUsd
   }
   ```

4. Usage and reservations drain monthly first, then paid.
5. A paid subscription invoice atomically expires the currently unused monthly balance and grants the new plan’s full allotment. There is no proration of Duet credits and no rollover.
6. Checkout completion and `customer.subscription.*` events never grant credits. `invoice.paid` is the sole grant authority.
7. A scheduled cancellation remains active through its paid period. A terminal or lapsed subscription zeros the monthly bucket.
8. The manual and automatic top-up rail continues to add only paid credits.
9. After the trial is no longer usable, paid credits are overage credits, not a substitute for an active subscription.
10. No migration, compatibility shim, shadow field, dual-write period, or deploy-order protocol is introduced.

### Existing seams this builds on

- Users currently have a scalar `creditBalanceMicroUsd` and account billing state inside `users.billing` ([schema.ts:102](/Users/synthetic-user/dev/duet/packages/backend/convex/schema.ts:102)).
- `creditTransactions` is the single ledger and already owns reference indexes used for account/global idempotency ([schema.ts:537](/Users/synthetic-user/dev/duet/packages/backend/convex/schema.ts:537), [creditsShared.ts:159](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/creditsShared.ts:159)).
- `applyLedgerEntryWithDb` currently mutates the scalar balance, monthly-spend counters, and the ledger atomically ([ledger.ts:31](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/ledger.ts:31)).
- Preflight currently schedules auto-top-up and then delegates to `authorizeSpend` ([ledger.ts:149](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/ledger.ts:149)); `authorizeSpend` recognizes only `insufficient_credits` and `monthly_cap` ([creditsShared.ts:112](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/creditsShared.ts:112)).
- Reservations debit at hold time and later directly adjust the scalar balance ([reservations.ts:42](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/reservations.ts:42), [reservations.ts:302](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/reservations.ts:302)).
- Model-gateway preflight and settlement already consume the credits domain instead of implementing billing locally ([preflight.ts:124](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/modelGateway/preflight.ts:124), [settlement.ts:178](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/modelGateway/settlement.ts:178)).
- Stripe webhook verification terminates at one Convex mutation, which records `stripeWebhookEvents` only after domain processing succeeds ([http.ts:19](/Users/synthetic-user/dev/duet/packages/backend/convex/http.ts:19), [stripeWebhooks.ts:15](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/stripeWebhooks.ts:15)).
- The REST billing boundary is browser-session-only at `/v1/user/billing`, `/checkout`, `/portal`, and `/history` ([billing.ts:62](/Users/synthetic-user/dev/duet/apps/api/src/routes/billing.ts:62)).
- The web billing route already uses those REST endpoints and has a hermetic visual fixture ([user-settings.tsx:131](/Users/synthetic-user/dev/duet/apps/web/spa/routes/user-settings.tsx:131), [spa-shell-playground.tsx:554](/Users/synthetic-user/dev/duet/apps/web/components/playground/spa-shell-playground.tsx:554)).
- The lander currently presents trial, usage-based, and enterprise cards, so it materially contradicts the new offer ([page.tsx:197](/Users/synthetic-user/dev/duet/apps/lander/app/[locale]/pricing/page.tsx:197), [marketing.json:337](/Users/synthetic-user/dev/duet/apps/lander/messages/en/marketing.json:337)).

---

# 1. Slice ladder

| Slice | One-line contract | Depends on |
|---|---|---|
| 01 | Any spend, reservation, reset, or lapse produces an exact, replay-safe two-bucket wallet transition and the correct preflight decision. | — |
| 02 | Stripe Checkout, subscription lifecycle events, and paid invoices project one subscription and canonical monthly grant through the public billing API. | 01 |
| 03 | A customer can understand, purchase, manage, and verify the subscription through the product and pricing UIs, with a real Stripe staging proof. | 02 |

Dependency graph:

```text
01 Two-bucket wallet
          │
          ▼
02 Stripe lifecycle + REST contract
          │
          ▼
03 Product/lander surfaces + staging live E2E
```

## Ordering rationale

Slice 01 answers the highest-risk accounting question without Stripe, HTTP, or UI: whether every debit, hold, refund, renewal, and lapse preserves bucket invariants.

Slice 02 adds the external state machine only after wallet transitions are deterministic. It proves webhook ordering, invoice idempotency, price-to-plan mapping, Checkout shape, and the browser-facing REST contract together because those are one Stripe integration boundary.

Slice 03 composes already-proven contracts into the two visible surfaces and extends the existing staging billing leg. Splitting “UI” and “staging” would create an extra rung whose only useful verdict arrives after both are complete.

---

# 2. Per-slice specification

## Slice 01 — Two-bucket wallet and subscription-aware spend

**Contract:** Given wallet state, subscription eligibility, and a ledger command, the credits domain deterministically returns the new monthly balance, paid balance, total balance, bucket allocation, ledger rows, and preflight decision.

### API seam and ownership

#### Shared contract

Extend `packages/contract/src/billing/index.ts` and `packages/contract/src/ledger/index.ts`.

```ts
export const SubscriptionPlanIdSchema =
  z.enum(['starter', 'pro', 'max'])

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

export const PreflightBlockReasonSchema = z.enum([
  'subscription_required',
  'insufficient_credits',
  'monthly_cap',
])
```

`SUBSCRIPTION_PLANS` is the sole owner of product tier IDs, display prices, and credit allotments. Stripe price IDs must not enter this package because they vary by environment.

Extend the preflight result while preserving `balanceMicroUsd` as the derived total:

```ts
type PreflightDecision = {
  proceed: boolean
  reason?: 'subscription_required' | 'insufficient_credits' | 'monthly_cap'
  tier?: 'account' | 'workspace'
  balanceMicroUsd: number
  monthlyCreditBalanceMicroUsd: number
  paidCreditBalanceMicroUsd: number
  accountMonthlySpendMicroUsd: number
  accountMonthlyCapMicroUsd?: number
  workspaceMonthlySpendMicroUsd: number
  workspaceMonthlyCapMicroUsd?: number
}
```

The current contract exposes only one balance and two reasons ([ledger/index.ts:16](/Users/synthetic-user/dev/duet/packages/contract/src/ledger/index.ts:16)).

#### Durable data

Change `packages/backend/convex/schema.ts`:

```ts
users: {
  monthlyCreditBalanceMicroUsd: number
  creditBalanceMicroUsd: number
  billing?: {
    // existing top-up and cap fields remain
    subscription?: {
      stripeSubscriptionId: string
      plan: 'starter' | 'pro' | 'max'
      stripePriceId: string
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
      lastEventCreatedAt: number
      lastEventId: string
    }
    monthlyCreditGrantInvoiceId?: string
    monthlyCreditGrantEffectiveAt?: number
  }
}

creditTransactions: {
  amountMicroUsd: number
  monthlyAmountMicroUsd: number
  paidAmountMicroUsd: number
  type:
    | 'grant'
    | 'topup'
    | 'usage'
    | 'adjustment'
    | 'reservation'
    | 'subscription_grant'
    | 'subscription_expiry'
  // existing identity/reference/metadata fields
}
```

This is a hard schema cutover. Update user creation to initialize both balances to zero; it currently initializes only the paid scalar ([users/model.ts:57](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/users/model.ts:57)).

#### Wallet kernel

Give `packages/backend/convex/domains/credits/ledger.ts` one internal wallet command boundary:

```ts
type WalletSnapshot = {
  monthlyMicroUsd: number
  paidMicroUsd: number
}

type BucketDelta = {
  monthlyAmountMicroUsd: number
  paidAmountMicroUsd: number
  amountMicroUsd: number
}

function allocateDebit(
  wallet: WalletSnapshot,
  debitMicroUsd: number,
): BucketDelta

async function applyLedgerEntryWithDb(
  ctx: MutationCtx,
  command: LedgerCommand,
): Promise<{
  applied: boolean
  balanceMicroUsd: number
  monthlyCreditBalanceMicroUsd: number
  paidCreditBalanceMicroUsd: number
  transactionId?: Id<'creditTransactions'>
}>

async function resetMonthlyCreditsWithDb(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    userId: Id<'users'>
    invoiceId: string
    grantEffectiveAt: number
    plan: SubscriptionPlanId
    now: number
  },
): Promise<{ applied: boolean; ...WalletBalance }>

async function zeroMonthlyCreditsWithDb(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    userId: Id<'users'>
    reference: string
    reason: 'lapse' | 'canceled' | 'deleted'
    now: number
  },
): Promise<{ applied: boolean; ...WalletBalance }>
```

`LedgerCommand` routes buckets by type:

- `grant`, `topup`, and ordinary `adjustment` affect paid balance.
- `subscription_grant` and `subscription_expiry` affect monthly balance.
- `usage` and `reservation` accept a positive debit cost and allocate monthly first, then paid.
- `amountMicroUsd` is always the sum of the two bucket deltas.
- Positive monthly balance is possible only through `resetMonthlyCreditsWithDb`.
- A renewal/upgrade reset inserts an expiry row even when the expired amount is zero, followed by a full grant row. References are `subscription_expiry:<invoiceId>` and `subscription_grant:<invoiceId>`.
- The reset is one Convex mutation; a replay finding the invoice grant reference returns the existing wallet without either row being duplicated.
- An invoice older than `monthlyCreditGrantEffectiveAt` is recorded as processed by Slice 02 but cannot reset the current bucket.

#### Reservation contract

Replace the current mutable reservation projection with append-only wallet deltas:

```ts
type ReservationAllocation = {
  monthlyHeldMicroUsd: number
  paidHeldMicroUsd: number
  monthlyGrantInvoiceId?: string
}
```

- Hold writes a negative `reservation` row with its exact split and grant-generation token.
- Settle writes a terminal reservation row whose bucket fields are the actual additional debit or refundable amount.
- Release writes a terminal refund row.
- Paid funds always refund to paid.
- Monthly funds refund to monthly only when the held `monthlyGrantInvoiceId` still equals the user’s current grant invoice.
- Monthly funds released after a renewal, upgrade reset, or lapse are forfeited and recorded as `forfeitedMonthlyMicroUsd` metadata; they cannot roll into the new bucket or paid balance.
- If actual cost exceeds the hold, the excess drains the wallet’s current monthly bucket first, then paid.
- Monthly-spend counters and usage rollups reflect actual cost, not the estimate.

This is necessary because reservations currently debit and later refund a single scalar without retaining bucket provenance ([reservations.ts:91](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/reservations.ts:91), [reservations.ts:136](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/reservations.ts:136)).

#### Preflight contract

`authorizeSpend` owns this ordering:

1. If there is no active subscription and either:

   - the remaining trial/paid balance is at or below `HARD_BLOCK_FLOOR_MICRO_USD`, or
   - `billing.firstPaidAt` is already set,

   return `subscription_required`, account tier.

2. If an active subscription exists but combined balance cannot satisfy the existing floor/reservation rules, return `insufficient_credits`.
3. Apply account and workspace monthly caps in their existing order.
4. Otherwise proceed.

“Inference”: `firstPaidAt` is used as the durable “this is no longer an untouched signup trial” discriminator. It already controls paid-model access and whether another workspace can be created ([modelGateway/preflight.ts:74](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/modelGateway/preflight.ts:74), [workspaces/birth.ts:36](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/birth.ts:36)), and successful Stripe payment currently sets it ([topups.ts:209](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/topups.ts:209)). This prevents a manual top-up from becoming a subscription bypass while leaving the overage rail intact for subscribers.

Auto-top-up checks the combined spendable balance, but credits only paid balance. Otherwise every subscriber with a zero paid bucket would schedule a top-up despite having monthly credits; today the scheduler reads only the scalar paid balance ([ledger.ts:177](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/ledger.ts:177)).

Extend:

- `packages/backend/convex/domains/credits/creditsShared.ts`
- `packages/backend/convex/domains/credits/internal.ts`
- `packages/backend/convex/domains/modelGateway/blocks.ts`
- `packages/contract/src/gateway/index.ts`
- `packages/backend/convex/validators.ts`

with the `subscription_required` 402 block:

```json
{
  "error": "subscription_required",
  "code": "subscription_required",
  "billingUrl": "https://service.example.invalid/settings/billing"
}
```

Do not reuse the existing `subscription_inactive` block: that code currently represents workspace `servicingStatus === "paused"` before credit preflight ([modelGateway/preflight.ts:63](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/modelGateway/preflight.ts:63), [blocks.ts:47](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/modelGateway/blocks.ts:47)).

### What a human can run or see

Run the isolated backend seams:

```bash
bun test packages/contract/src/ledger/index.test.ts
bun test packages/backend/src/credits-shared.test.ts
bun test packages/backend/src/credits.test.ts
bun test packages/backend/src/model-gateway.test.ts
```

The test output should enumerate deterministic balances and ledger rows for trial-only, monthly-only, spillover, renewal, upgrade reset, lapse, and reservations crossing a reset.

### Verification

Add pure tests for:

- exact tier constants;
- debit smaller than, equal to, and greater than monthly balance;
- total equals monthly plus paid after every transition;
- no negative bucket created by allocation;
- active subscription with depleted wallet → `insufficient_credits`;
- no subscription with exhausted trial → `subscription_required`;
- lapsed subscriber with paid overage remaining → `subscription_required`;
- trial user above the floor → proceed;
- account cap still precedes workspace cap as today ([credits.test.ts:195](/Users/synthetic-user/dev/duet/packages/backend/src/credits.test.ts:195)).

Add Convex tests for:

- concurrent ledger-reference replay;
- renewal produces exactly one expiry and one grant row;
- upgrade from partially spent Starter to Pro resets monthly to `$55`;
- renewal does not alter paid balance;
- lapse zeros only monthly balance;
- overage debit splits across both bucket fields;
- top-up adds only paid;
- release before reset restores both held buckets;
- release after reset restores paid but forfeits old monthly;
- settlement above estimate draws excess from the current wallet;
- monthly spend and usage rollups still reflect actual usage;
- model-gateway post-response and reservation modes return the same new 402 contract.

### Must stay green

- Existing ledger authorization and reference-idempotency tests.
- Trial grant remains one canonical-email grant across workspaces ([grants.ts:11](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/grants.ts:11)).
- Account/workspace monthly cap semantics and UTC counter rollover.
- Usage daily/monthly rollups.
- Free models remain uncharged.
- Designated-payer ownership remains account-level.
- Existing auto-top-up creation, failure backoff, and recovery behavior.

---

## Slice 02 — Stripe subscription lifecycle, Checkout, and REST contract

**Contract:** Given a browser Checkout request or verified Stripe event, Duet creates the correct hosted session or atomically projects the subscription and monthly grant exactly once.

### API seam and ownership

#### Environment price mapping

Add to `packages/backend/convex/config.ts`:

```ts
type StripeSubscriptionPriceIds = Record<
  SubscriptionPlanId,
  string
>

function stripeSubscriptionPriceIds(
  env: NodeJS.ProcessEnv = process.env,
): StripeSubscriptionPriceIds

function subscriptionPlanForStripePrice(
  priceId: string,
  env?: NodeJS.ProcessEnv,
): SubscriptionPlanId | undefined
```

Required per environment:

```text
STRIPE_STARTER_RECURRING_PRICE_ID
STRIPE_PRO_RECURRING_PRICE_ID
STRIPE_MAX_RECURRING_PRICE_ID
STRIPE_BILLING_PORTAL_CONFIGURATION_ID
```

The resolver fails closed if IDs are missing, duplicated, or not `price_*`. Price IDs never enter durable plan economics; they only map Stripe objects to contract plans.

The backend config module is the existing owner of typed defaults and environment overrides ([config.ts:1](/Users/synthetic-user/dev/duet/packages/backend/convex/config.ts:1)).

#### Checkout and portal service seam

Replace the optional-amount ambiguity in `packages/contract/src/billing/index.ts` with:

```ts
const BillingCheckoutRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subscription'),
    workspaceSlug: WorkspaceSlugSchema,
    plan: SubscriptionPlanIdSchema,
  }),
  z.object({
    kind: z.literal('topup'),
    workspaceSlug: WorkspaceSlugSchema,
    amountMicroUsd: MicroUsdAmountSchema.min(MIN_AUTO_TOPUP_AMOUNT_MICRO_USD),
  }),
  z.object({
    kind: z.literal('setup'),
    workspaceSlug: WorkspaceSlugSchema,
  }),
])
```

The existing request treats absent amount as setup and present amount as top-up ([billing/index.ts:77](/Users/synthetic-user/dev/duet/packages/contract/src/billing/index.ts:77), [stripe.ts:82](/Users/synthetic-user/dev/duet/packages/backend/convex/services/stripe.ts:82)). This is a hard API cutover.

Extend `packages/backend/convex/services/stripe.ts`:

```ts
createSubscriptionCheckout(stripe, {
  customerId,
  workspaceId,
  userId,
  priceId,
  successUrl,
  cancelUrl,
})

createTopupCheckout(...) // existing payment-mode behavior
createPaymentMethodSetup(...) // existing setup-mode behavior
createBillingPortal(stripe, {
  customerId,
  returnUrl,
  configurationId,
})
```

Subscription Checkout must create:

```ts
{
  mode: 'subscription',
  customer: customerId,
  line_items: [{ price: priceId, quantity: 1 }],
  subscription_data: {
    metadata: {
      source: 'duet',
      userId,
      workspaceId,
    },
  },
  success_url,
  cancel_url,
}
```

Top-up PaymentIntents and payment-mode Checkout retain their current `credit_topup` metadata and idempotency behavior ([stripe.ts:54](/Users/synthetic-user/dev/duet/packages/backend/convex/services/stripe.ts:54), [stripe.ts:110](/Users/synthetic-user/dev/duet/packages/backend/convex/services/stripe.ts:110)).

The dedicated portal configuration must enforce:

- all three monthly prices belong to the same Stripe product;
- allowed update is price only;
- upgrades use `always_invoice`;
- decreasing price schedules at period end;
- cancellation mode is `at_period_end`.

Stripe supports scheduled portal downgrades only between prices on the same product, and implements them through a subscription schedule ([Stripe portal configuration](https://docs.stripe.com/customer-management/configure-portal)). Stripe recommends `always_invoice` when an upgrade’s proration must be charged immediately ([Stripe subscription price changes](https://docs.stripe.com/billing/subscriptions/change-price)).

#### Webhook normalization

Extend the verified HTTP-to-mutation shape in `packages/backend/convex/http.ts` and `credits/internal.ts`:

```ts
type StripeWebhookCommand = {
  eventId: string
  eventCreatedAt: number
  type: string
  object: unknown
}
```

The current seam drops `event.created`, retaining only ID, type, and object ([http.ts:36](/Users/synthetic-user/dev/duet/packages/backend/convex/http.ts:36)). Lifecycle projection needs creation time to ignore stale, out-of-order snapshots.

Add one domain owner, for example:

```text
packages/backend/convex/domains/credits/subscriptions.ts
```

with:

```ts
projectSubscriptionLifecycleWithDb(ctx, event)
applyPaidSubscriptionInvoiceWithDb(ctx, event)
```

`stripeWebhooks.ts` remains the dispatcher and `stripeWebhookEvents` remains event-delivery idempotency.

#### Lifecycle rules

For `customer.subscription.created|updated|deleted`:

1. Require Duet metadata, a known customer/user association, exactly one licensed recurring item, and a recognized price ID.
2. Ignore a lifecycle snapshot older than `lastEventCreatedAt`; break an exact timestamp tie deterministically by event ID.
3. Project Stripe subscription ID, normalized plan, price ID, status, current period bounds, and `cancelAtPeriodEnd`.
4. Set `firstPaidAt` when the subscription becomes paid/active.
5. `active` keeps access; `cancel_at_period_end: true` remains active.
6. `past_due`, `unpaid`, `paused`, `incomplete_expired`, `canceled`, or deletion is a lapse and calls `zeroMonthlyCreditsWithDb`.
7. Deletion clears the active subscription projection only after writing the expiry row.

Stripe documents that scheduled cancellation first produces `customer.subscription.updated` with `cancel_at_period_end`, followed by `customer.subscription.deleted` when the paid period ends ([Stripe cancellation events](https://docs.stripe.com/billing/subscriptions/cancel)).

For `invoice.paid`:

1. Distinguish subscription invoices from top-up/payment invoices using `invoice.parent.subscription_details.subscription`.
2. Read the user/workspace metadata snapshot from `parent.subscription_details.metadata`.
3. Read recognized recurring price IDs from invoice lines.
4. Select the recognized positive subscription/proration line with the latest `period.start`; fail closed on ambiguity.
5. Map that price to a plan constant.
6. Call `resetMonthlyCreditsWithDb` using the invoice ID as the grant idempotency key.
7. Update subscription projection to that plan if a newer `subscription.updated` event has not arrived yet.
8. Clear subscription payment error state without incrementing top-up failure counters.

Current `invoice.paid` only clears top-up error state, while `payment_intent.succeeded` grants top-ups ([stripeWebhooks.ts:44](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/stripeWebhooks.ts:44)). Preserve the latter unchanged.

The pinned Stripe API version is `2026-02-25.clover` ([stripe.ts:3](/Users/synthetic-user/dev/duet/packages/backend/convex/services/stripe.ts:3)). Current invoice objects expose their subscription under `parent.subscription_details`, and invoice lines expose price IDs under `pricing.price_details.price` ([Stripe Invoice object](https://docs.stripe.com/api/invoices/object), [Stripe Invoice Line Item object](https://docs.stripe.com/api/invoice-line-item/object)).

For `invoice.payment_failed`:

- Subscription invoice: record a subscription payment error; do not mutate `billingTopups`, `consecutiveTopupFailures`, or workspace servicing status.
- Top-up invoice/payment: retain existing top-up failure behavior.
- Access becomes blocked and monthly balance expires when the lifecycle projection reports a non-active subscription, not merely because any invoice failed.

This split is required because the current handler treats every Duet invoice failure as a top-up failure ([stripeWebhooks.ts:90](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/stripeWebhooks.ts:90)).

#### Public REST projection

Extend `UserBillingOverviewSchema`:

```ts
type UserBillingOverview = {
  balanceMicroUsd: number
  monthlyCreditBalanceMicroUsd: number
  paidCreditBalanceMicroUsd: number
  subscription: null | {
    plan: SubscriptionPlanId
    status: StripeSubscriptionStatus
    currentPeriodStart: number
    currentPeriodEnd: number
    cancelAtPeriodEnd: boolean
  }
  hasPaymentMethod: boolean

  // existing top-up settings, limits, errors, spend, workspaces
}
```

Extend billing-history and workspace-ledger entries with monthly and paid deltas and the two new transaction types. Internal references and metadata remain private, matching the existing member ledger projection ([ledger.ts:109](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/ledger.ts:109)).

Update:

- `apps/api/src/routes/billing.ts`
- `packages/contract/src/endpoints/index.ts`
- `apps/docs/app/billing/page.mdx`

The docs update is part of this slice because the contract package generates the public endpoint reference, and the API README requires public route changes to update developer documentation ([apps/api/README.md](/Users/synthetic-user/dev/duet/apps/api/README.md), [apps/docs/app/billing/page.mdx:42](/Users/synthetic-user/dev/duet/apps/docs/app/billing/page.mdx:42)).

### What a human can run or see

Run:

```bash
bun test packages/backend/src/billing.test.ts
bun test apps/api/src/index.test.ts
bun test apps/web/spa/api/client.test.ts
bun run check-types
```

The Stripe service tests should print captured Checkout/Portal parameters for all three checkout kinds. Convex tests should show the projected subscription and exact expiry/grant rows for deterministic webhook fixtures.

### Verification

Add service tests for:

- Starter/Pro/Max contract plan → environment price ID;
- subscription Checkout uses `mode: subscription`, one recurring price, and subscription metadata;
- setup and top-up Checkout retain their existing Stripe shapes;
- portal session always supplies the dedicated configuration ID;
- missing or duplicate environment price IDs fail before a Stripe call.

Add webhook tests for:

- initial subscription: created event alone grants nothing; invoice paid grants once;
- same invoice under two Stripe event IDs still grants once by invoice reference;
- event replay returns `replay: true`;
- subscription update delivered before or after upgrade invoice converges to the same Pro/Max state;
- immediate upgrade expires unused old monthly credit and grants the full new allotment;
- scheduled downgrade update retains old plan/allotment until the new-period paid invoice;
- cancel-at-period-end retains the bucket;
- deleted/lapsed subscription zeros the bucket once;
- a stale renewal invoice cannot overwrite a newer upgrade grant;
- a stale lifecycle event cannot resurrect a deleted/lapsed subscription;
- subscription payment failure does not increment auto-top-up failures;
- top-up invoice/payment behavior remains unchanged.

Add API contract tests for:

- browser session required;
- payer ownership required;
- subscription checkout validates plan and sends the correct action arguments;
- overview returns total/monthly/paid balances and normalized subscription;
- history/ledger accept the new transaction types without exposing references or metadata;
- docs endpoint coverage remains complete.

### Must stay green

- Raw webhook signature verification and HTTP replay behavior ([billing.test.ts:231](/Users/synthetic-user/dev/duet/packages/backend/src/billing.test.ts:231)).
- PaymentIntent top-up idempotency and metadata.
- A canceled setup Checkout does not mark the payment method ready ([billing.test.ts:418](/Users/synthetic-user/dev/duet/packages/backend/src/billing.test.ts:418)).
- Billing payer authorization and payer-reassignment races ([index.test.ts:6816](/Users/synthetic-user/dev/duet/apps/api/src/index.test.ts:6816)).
- Existing billing usage, ledger, caps, and history endpoints.
- Stripe API version remains pinned unless a separately justified SDK upgrade is required.

---

## Slice 03 — Customer surfaces and staging live acceptance

**Contract:** The pricing page and billing settings present the same three-plan contract, and a staging customer can purchase Starter through real test-mode Checkout and observe the canonical monthly grant.

### API seam and ownership

#### Product billing UI

Update:

- `apps/web/spa/api/client.ts`
- `apps/web/spa/routes/user-settings.tsx`
- `apps/web/messages/en/app.json`
- `apps/web/messages/es-419/app.json`
- billing fixtures in `apps/web/components/playground/spa-shell-playground.tsx`

The billing settings surface owns presentation only. It imports plan IDs/economics from `@repo/contract` and consumes `UserBillingOverview`.

Required states:

1. **Trial / no subscription**

   - Show paid/trial balance.
   - Show Starter, Pro, and Max subscribe actions.
   - Hide or disable manual/automatic overage top-up controls until a subscription is active.
   - Checkout request is `{kind:"subscription", plan, workspaceSlug}`.

2. **Active subscription**

   - Show current plan, renewal date, monthly included balance, paid overage balance, and total.
   - “Manage plan” opens the Stripe Portal.
   - Existing top-up amount, threshold, cap, enable-auto, and top-up-now controls remain.

3. **Cancellation scheduled**

   - Show “Active until <date>”.
   - Keep balances and overage controls available.
   - Portal remains the place to undo cancellation.

4. **Lapsed/payment problem**

   - Show the Stripe-owned recovery action.
   - Show paid balance as retained but unavailable until resubscription.
   - Offer a fresh subscription Checkout when no subscription can be resumed.

5. **History**

   - Render human labels for `subscription_grant` and `subscription_expiry`.
   - Continue showing usage/top-up/reservation entries.
   - Do not expose Stripe invoice IDs.

The current UI presents one scalar balance, payment-method setup, top-up controls, and raw capitalized transaction types ([user-settings.tsx:203](/Users/synthetic-user/dev/duet/apps/web/spa/routes/user-settings.tsx:203), [user-settings.tsx:309](/Users/synthetic-user/dev/duet/apps/web/spa/routes/user-settings.tsx:309)).

#### Public pricing page

Update:

- `apps/lander/app/[locale]/pricing/page.tsx`
- `apps/lander/components/landing/pricing/pricing-faq.tsx`
- `apps/lander/messages/en/marketing.json`
- `apps/lander/messages/es-419/marketing.json`
- `apps/lander/lib/i18n/page-copy.ts`

Replace the usage-based/enterprise tier grid with:

- a trial introduction;
- Starter — `$20/month`, `$20` included credits;
- Pro — `$50/month`, `$55` included credits;
- Max — `$200/month`, `$230` included credits;
- explicit “monthly credits reset; they do not roll over” copy;
- explicit “usage beyond included credits draws from paid top-up balance” copy;
- cancel-at-period-end language;
- existing model-pricing section reframed as overage pricing, not the primary commercial model.

Do not duplicate numeric tier data as arbitrary component literals. Either import the contract constants if the lander’s dependency firewall permits it, or add a mechanically checked lander copy projection whose test asserts exact equality with `SUBSCRIPTION_PLANS`. The lander README forbids product runtime/auth dependencies, but a build-time contract constant is an inference that must be checked against its import firewall ([apps/lander/README.md](/Users/synthetic-user/dev/duet/apps/lander/README.md)).

#### Visual fixtures

Add deterministic product playground scenarios:

```text
settings-billing-trial
settings-billing-pro
settings-billing-canceling
settings-billing-lapsed
```

The default billing screenshot should use the active Pro state. Preserve the existing not-payer and top-up-error fixtures ([spa-shell-playground.tsx:2367](/Users/synthetic-user/dev/duet/apps/web/components/playground/spa-shell-playground.tsx:2367)).

The pricing route already has Docker visual and no-JS coverage ([public-visual-contract.ts:29](/Users/synthetic-user/dev/duet/apps/lander/tests/visual/public-visual-contract.ts:29)). Update its baselines rather than creating a parallel screenshot harness.

#### Staging acceptance

Rewrite `packages/test-harness/src/staging-e2e-synthetic`. It currently completes a setup-mode Checkout and waits only for `hasPaymentMethod` ([staging-e2e-synthetic:31](/Users/synthetic-user/dev/duet/packages/test-harness/src/staging-e2e-synthetic:31), [staging-e2e-synthetic:124](/Users/synthetic-user/dev/duet/packages/test-harness/src/staging-e2e-synthetic:124)).

The live leg must:

1. Refuse non-test Stripe keys, as today.
2. Open billing settings and choose Starter.
3. Assert the API returns one `cs_test_*` subscription Checkout session.
4. Complete Checkout with Stripe’s test card.
5. Poll `/v1/user/billing` until:

   ```json
   {
     "subscription": {
       "plan": "starter",
       "status": "active",
       "cancelAtPeriodEnd": false
     },
     "monthlyCreditBalanceMicroUsd": 20000000
   }
   ```

6. Query the test ledger and assert exactly one `subscription_grant` for the paid invoice and no grant from `customer.subscription.created`.
7. Apply a deterministic run-tagged `$20.25` usage debit through the existing internal ledger seam; verify monthly becomes zero and paid decreases by `$0.25`.
8. Create a Portal session and verify it uses the configured test portal configuration.
9. Through the Stripe test API, assert all three allowed recurring prices share one product and the portal configuration has:

   - price updates enabled;
   - `always_invoice` proration;
   - decreasing-price updates scheduled at period end;
   - cancellation at period end.

10. Schedule cancellation and wait until overview shows `cancelAtPeriodEnd: true` while the subscription and remaining wallet remain usable.
11. Cleanup the subscription/session/customer through the existing resource ledger, with verified deletion.

Upgrade, downgrade-transition, and lapse event outcomes remain deterministic local webhook tests. The staging leg proves the real Checkout → signed webhook → subscription projection → invoice grant chain and the real portal configuration without waiting a calendar month.

### What a human can run or see

Run the visual and live entry points already owned by the repo:

```bash
bun run ui:check
bun run e2e:staging
```

A human should inspect:

- desktop and mobile billing screenshots for all four subscription states;
- English and Spanish `/pricing`;
- the staging timeline showing Checkout creation, subscription activation, invoice grant, two-bucket spill, portal configuration, and scheduled cancellation.

Before accepting screenshots:

1. Run `screenshot-critique` unprimed on each changed billing/pricing shot.
2. Run `compare-screenshots` against the previous billing and pricing baselines and record the less-wrong verdict.
3. Use `preview-shots` to open the candidate/baseline set for a non-blocking human review window; if there is no response, record the evidence-based decision and continue.

### Verification

- Contract-copy test pins all three displayed prices and allotments to `SUBSCRIPTION_PLANS`.
- API-client tests pin the discriminated Checkout request shapes.
- Component/playground assertions verify the correct subscribe/manage/recover controls for every fixture.
- English and Spanish locale-key parity stays green.
- Pricing remains statically rendered and functional without JavaScript.
- Docker screenshots cover desktop/mobile billing plus both localized pricing routes.
- Staging test asserts exact ledger row count and bucket balances, not only navigation success.
- Staging cleanup verifies no open Checkout session, subscription, or customer remains.

### Must stay green

- The full web and lander visual ownership ledgers.
- Existing not-payer billing state.
- Auto-top-up form behavior for active subscribers.
- Public route manifest, sitemap, static export, localization, and no-JS gates.
- Staging browser diagnostics, cleanup ledger, and required acceptance-leg accounting.
- The rest of `bun run test`, `bun run check-types`, and `bun run lint`.

---

# 3. Risks, unknowns, firewalls, and rejected alternatives

## Risks and unknowns found in recon

### 1. Reservations can accidentally create rollover

Current reservation settlement knows only the scalar estimate and directly refunds the scalar wallet ([reservations.ts:136](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/reservations.ts:136)). Without a grant-generation token, releasing a pre-renewal hold after renewal would put expired credits into the new period. Slice 01 must pin this before Stripe work begins.

### 2. Stripe webhook delivery order is not sufficient state ordering

The repo records event IDs but drops `event.created` at the HTTP seam ([http.ts:36](/Users/synthetic-user/dev/duet/packages/backend/convex/http.ts:36)). Event replay is safe, but a delayed older lifecycle snapshot could overwrite newer status. Slice 02 adds explicit monotonic projection rules and stale-invoice rules.

### 3. Upgrade invoices can contain both old and new prices

The grant cannot infer the plan from invoice total: discounts, credits, taxes, and prorations change the amount. It must identify the recognized positive subscription line and its effective period. Stripe exposes price identity and proration information on invoice lines ([Stripe Invoice Line Item object](https://docs.stripe.com/api/invoice-line-item/object)).

### 4. Portal downgrade behavior depends on Stripe product/configuration topology

Stripe only schedules portal downgrades between prices on the same product ([Stripe portal configuration](https://docs.stripe.com/customer-management/configure-portal)). The three per-environment prices and dedicated portal configuration therefore need a staging assertion; code alone cannot compensate for misconfigured Stripe objects.

### 5. `firstPaidAt` has multiple existing policy consumers

It gates paid models and additional workspace creation, not merely billing-history display ([modelGateway/preflight.ts:74](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/modelGateway/preflight.ts:74), [workspaces/birth.ts:42](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/birth.ts:42)). Subscription payment must set it, and tests must confirm subscription signup unlocks those existing paid-account behaviors.

### 6. Subscription failure and top-up failure are currently conflated

Every Duet `invoice.payment_failed` currently enters top-up failure handling ([stripeWebhooks.ts:90](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/stripeWebhooks.ts:90)). Subscription invoices must be classified before touching top-up backoff or workspace servicing state.

### 7. Existing `subscription_inactive` means something else

Model-gateway maps workspace `servicingStatus: paused` to `subscription_inactive` before wallet preflight ([preflight.ts:63](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/modelGateway/preflight.ts:63)). Reusing it for the new account-level rule would collapse administrative/top-up failure state and subscription eligibility into one code.

### 8. Auto-top-up’s threshold currently sees one scalar

It reads `creditBalanceMicroUsd` directly ([ledger.ts:183](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/credits/ledger.ts:183)). With two buckets, leaving that unchanged would top up subscribers while included monthly credit remains. “Inference”: threshold semantics should remain “total spendable credits below threshold,” while the purchased funds still enter paid balance.

### 9. UI coverage is visual rather than component-unit-heavy

Billing already appears in the product-shell screenshot loop ([playground.spec.ts:1382](/Users/synthetic-user/dev/duet/apps/web/tests/visual/playground.spec.ts:1382)), but state-specific billing fixtures are sparse. Slice 03 must add explicit trial/active/canceling/lapsed fixtures so one happy-path image does not conceal state errors.

### 10. The public pricing copy is broadly usage-based

The tier grid, FAQ, sample bill, metadata, and localized copy all describe pay-as-you-go monthly billing ([marketing.json:348](/Users/synthetic-user/dev/duet/apps/lander/messages/en/marketing.json:348), [marketing.json:409](/Users/synthetic-user/dev/duet/apps/lander/messages/en/marketing.json:409)). Changing only the cards would leave contradictory promises below them.

## Scope firewalls

This feature must not:

- Create a second wallet or ledger table.
- Move wallet ownership from the billing user to individual workspaces.
- Add rollover, annual plans, seats, credit sharing, coupons, taxes, invoices/POs, or enterprise-contract logic.
- Prorate Duet credits to match Stripe’s dollar proration.
- Grant credits from Checkout success URLs, `checkout.session.completed`, or `customer.subscription.updated`.
- Infer a plan from invoice amount or display text.
- Let manual top-ups replace the subscription requirement.
- Rewrite `billingTopups` or PaymentIntent idempotency.
- Reuse workspace `servicingStatus` as subscription state.
- Pause or ban workspaces merely because a subscription is scheduled to cancel.
- Build custom card collection or custom cancellation/plan-change screens.
- Add cron-based monthly resets; Stripe paid invoices are the clock.
- Add compatibility aliases for the old checkout request or scalar-only overview.
- Add migrations, backfills, dual reads, dual writes, feature flags, or deploy sequencing.
- Introduce a second source of tier economics in backend, web, or lander.
- Change usage rollup grouping, monthly caps, payer reassignment, or model pricing.
- Expand the staging harness into a general Stripe provisioning system.

## Rejected alternatives

- **Keep one scalar balance and tag grants in metadata:** cannot enforce monthly-first spend or exact expiry.
- **Create separate monthly and paid ledgers:** violates the fixed single-ledger decision and complicates atomic ordering.
- **Put trial credits in a third bucket:** violates the fixed two-bucket wallet.
- **Grant on `customer.subscription.updated`:** an update is not proof that its invoice was paid.
- **Grant the prorated dollar amount on upgrade:** fixed product behavior grants the new plan’s full allotment.
- **Refund an old monthly reservation into the new monthly bucket:** creates rollover through the reservation path.
- **Convert expired reservation refunds into paid credit:** also creates rollover, merely under another name.
- **Reset from a monthly cron:** duplicates Stripe’s billing-period clock and races invoices/upgrades.
- **Use invoice total to choose the plan:** discounts, tax, credits, and prorations make totals non-canonical.
- **Build first-party upgrade/downgrade endpoints:** duplicates the fixed Billing Portal owner.
- **Reuse `subscription_inactive`:** that code already represents workspace servicing state.
- **Leave portal configuration implicit in the Stripe Dashboard:** makes upgrade/downgrade/cancel behavior unverifiable.
- **Split UI and live staging into separate slices:** neither answers a distinct architectural question; the visible end-to-end contract is one final integration gate.