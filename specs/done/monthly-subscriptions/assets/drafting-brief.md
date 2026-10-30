<task>
Draft a complete implementation spec (slice ladder) for a new feature in this repo (Duet, at /Users/synthetic-user/dev/duet). You are one of several independent drafters; produce YOUR best full plan. Recon the real code first, then plan. Marker: SUBSCRIPTION-SPEC-DRAFT-2026-07-17.

FEATURE: Monthly subscription pricing. A subscription grants credits each billing period into a monthly bucket; the existing usage-based topup rail remains for overage. Product is NOT deployed and has NO accounts — greenfield pricing, hard cutover, no migrations, no backward compatibility, no deploy-order dances.

FIXED DECISIONS (do not relitigate; design within them):
- Two-bucket wallet: add `monthlyCreditBalanceMicroUsd` on users alongside the existing paid `creditBalanceMicroUsd`. Spend drains monthly bucket first, then paid. Renewal RESETS the monthly bucket to the plan allotment (no rollover): ledger gets an expiry row (-unused) plus a subscription_grant row (+allotment). Cancellation/lapse zeroes the monthly bucket. Single existing `creditTransactions` ledger, new transaction types.
- Subscription required after trial: the signup trial grant covers pre-subscription usage; once no active subscription and trial exhausted, spend preflight blocks with a new `subscription_required` reason (today's reasons: insufficient_credits, monthly_cap).
- Tiers as contract constants + per-env Stripe recurring price ids: Starter $20/mo → $20 credits; Pro $50/mo → $55 credits; Max $200/mo → $230 credits.
- Overage: seamless spill into the paid balance; existing manual topup + threshold auto-topup rail unchanged.
- Plan changes: upgrade immediate (Stripe proration, monthly bucket immediately resets to the NEW plan's full allotment); downgrade scheduled at period end; cancel runs to period end.
- Stripe mechanics: real Stripe Subscriptions started via Checkout (mode: subscription); monthly grant canonicalized on the `invoice.paid` webhook, idempotent by invoice id; lifecycle tracked via `customer.subscription.created/updated/deleted`; Billing Portal for manage/cancel. Follow the repo's existing webhook idempotency pattern (stripeWebhookEvents table + ledger reference idempotency).

RECON — start with these files (read them, don't trust this summary):
- packages/backend/convex/domains/credits/ — ledger.ts (applyLedgerEntryWithDb, runPreflightWithDb, auto-topup scheduling), creditsShared.ts (authorizeSpend, monthlySpendPatch, TransactionType), topups.ts, stripeWebhooks.ts (processStripeWebhookEventImpl), userBilling.ts, grants.ts, reservations.ts, actions.ts, billingActions.ts, usageRollups.ts
- packages/backend/convex/schema.ts — users.creditBalanceMicroUsd + users.billing (~line 111); creditTransactions / billingTopups / stripeWebhookEvents (~lines 537–623)
- packages/contract/src/ledger/index.ts — micro-USD constants, PreflightDecisionSchema
- packages/backend/convex/services/stripe.ts — Stripe client seams (checkout, portal, payment intents, webhook verify)
- packages/backend/convex/domains/modelGateway/preflight.ts and settlement.ts — where spend authorization and settlement consume the credits seam
- apps/api/src/routes/billing.ts — REST seam (/v1/user/billing, checkout, portal, ledger, usage)
- apps/web/spa/routes/user-settings.tsx — billing settings UI (balance, auto-topup, history)
- apps/lander/app/[locale]/pricing/page.tsx — public pricing page
- Tests: packages/backend/src/billing.test.ts, credits.test.ts, credits-shared.test.ts; live-staging harness under packages/test-harness. Read the root README.md conventions and any README in folders you touch.

REPO SPEC CONVENTIONS: specs live at specs/<feature>/ with README.md (goal, slice graph, contracts, firewalls, Next Agent Prompt) + slices/<NN>-<name>.md, one independently verifiable slice per file. Slices are contracts at API seams: typed inputs/outputs, deterministic fixtures, tests at the seam, and something a human can run or see per slice. Ladders in this repo typically end with a staging live e2e slice.
</task>

<output_contract>
Return the full draft plan as your final message, markdown:
1. Slice ladder: numbered slices with one-line contract each, dependency graph, ordering rationale.
2. Per slice: API seam (module, functions/types, data shapes, endpoints/webhook events it owns), what the human can run/see, verification (unit tests at the seam, staging probes), and what must stay green.
3. Risks & unknowns you found in recon (with file:line evidence), scope firewalls (what this feature must NOT touch), and any rejected alternatives with one-line reasons.
Ground every claim about existing code in files you actually read; label inferences as inferences.
</output_contract>

<grounding>
Recon before planning. Cite file paths (and line numbers where useful) for every seam you build on.
</grounding>
