# Monthly subscriptions — rationale record

**Shipped to staging 2026-07-20.** Feature diff base `e2bd3892`; the final-green
endpoint `e2bd3892..b8aef0b3` is 134 commits (this rationale-record commit sits a
few commits later). Proven by the staging live lifecycle e2e
(`bun run e2e:staging`) reporting a full-green run — all 52 legs, subscription
legs 01–12 included — on a Stripe test clock. (The retained evidence capture
holds the subscription timeline for legs 01–11; leg 12 is the cleanup leg,
assigned from the global teardown, so the 52-leg pass is the run's reported
result rather than a single retained artifact.)

This document is the *why* and the *what-must-stay-true*; the code is the source
of truth for *how*. It supersedes the build plan; the slice ladder that built it
has been collapsed (its durable content folded in below).

## What shipped

Duet's pricing is a monthly subscription. Each paid billing period grants
credits into a **monthly bucket** that resets on renewal with no rollover;
spend drains monthly-first and only spills into the **paid bucket** (the old
`creditBalanceMicroUsd`, renamed `paidCreditBalanceMicroUsd`), which the
manual/auto topup rail funds for overage (topup *behavior* is unchanged, but
its charging moved to invoice-backed topups — D13, slice 04b). After a $5 /
7-day signup trial, an **active subscription is required to use Duet at all** —
not just to spend AI credits: on trial exhaustion or a lapsed/unpaid period the
billing user's workspaces are paused (VM token issuance blocked, data plane
closed), and 7 days paused → archived-but-resumable. Renewal resumes them.

Three tiers, credits-only differentiation at launch: **Starter $20/mo → $20
credits, Pro $50/mo → $60 (20% more per dollar), Max $200/mo → $250 (25%
more)**. Plan changes are first-party (not Portal): upgrade is immediate with
Stripe proration, downgrade applies at period end, cancel runs to period end.

## The reason it's shaped this way

- **`invoice.paid` is the sole authority for *subscription monthly-credit*
  grants**, keyed by invoice id, amount always from the catalog
  (`subscriptions.ts:330`). Stripe's `customer.subscription.*` lifecycle object
  controls subscription access but never grants monthly credits on its own.
  Every subscription grant path (new subscription, renewal, upgrade proration
  via `proration_behavior: 'always_invoice'`) is an `invoice.paid`; a second
  monthly-reset door is exactly the bug this forbids. This is not the *only*
  credit source: the signup trial grants into the paid bucket
  (`grants.ts`), admin adjustments can add paid credit
  (`internalAdmin/model.ts`), and topups canonicalize on their own
  `invoice.paid` keyed by invoice id but priced from the invoice total, not the
  catalog (`stripeWebhooks.ts`). The invariant is scoped to the monthly bucket.
- **The wallet is the single post-creation owner of both balance fields.**
  `domains/credits/wallet.ts` owns the monthly-first drain policy and
  bucket-routing-by-transaction-type (`allocateSpend`, `bucketFor`); the
  single-writer refactor landed *before* the two-bucket semantics so the policy
  could never fork between the ledger and the reservation path. Account
  creation initializes both fields once in `domains/users/model.ts`; every
  balance *mutation* thereafter goes through `wallet.ts`. `grep -rn
  'CreditBalanceMicroUsd' packages/backend/convex/domains` is a review aid, not
  a pure gate — it also surfaces the schema, the initializer, projections, and
  tests — so read it as "no new balance-mutating writer outside wallet.ts."
- **Subscription access follows Stripe status, independently of credit expiry.**
  The [backend billing policy](../../../packages/backend/README.md#payment-recovery)
  separates renewal processing from monthly credit grants. The REST overview
  derives access from that shared predicate (`userBilling.ts`), without a second
  persisted `isActive` flag. The one-way marker
  `subscriptionEverActivatedAt` gates the trial and is **never cleared on
  unsubscribe** in any production path (clearing would re-open trial gating for
  lapsed subscribers); only a test fixture clears it.
- **Pause is an effect of entitlement, computed by one owner for the
  entitlement transitions.** `reconcileServicingStatus` (slice 07) folds
  subscription state and the pre-existing topup-failure pause into a single
  desired `servicingStatus`, so a topup success can never resume a
  subscription-paused workspace. (Two non-entitlement paths write servicing
  directly by design: workspace birth stamps the computed initial state
  atomically, and admin archival writes `paused` — see Invariant 5.) "Full
  stop" was chosen over a soft cap: on pause the slug data plane refuses the
  workspace, agent sessions terminalize, VM sync narrows to a quiesce
  directive. The accepted propagation bound is ≤15s (API resolution cache) +
  ≤30s (edge cache) — documented, not eliminated.
- **Provenance before any effect, because the Stripe account is shared.** Other
  apps (chat-app) invoice on the same account, and chat-app *also* stamps
  `source: 'duet'` — so source alone cannot discriminate the apps.
  Discrimination is **positive, by our own ids** (`isDuetV2SubscriptionMetadata`
  in `subscriptionEvents.ts`): an event is ours when `source === 'duet'` **and**
  it carries our `userId` **and** it is either `type: 'subscription'` (account-
  level, no `workspaceId`) or carries a `workspaceId`. Topups likewise require
  `source: 'duet'` + a `workspaceId` + a topup `type` (`stripeWebhooks.ts`). An
  `organizationId` is no longer inspected (Example User, 2026-07-20): a foreign event
  is rejected because it lacks our ids, not because it carries chat-app's marker.
  Foreign events are silently ignored and marked processed. **Deliberate
  exception:** disputes are customer-scoped by Example User's policy — a dispute on
  *any* charge (even another app's) by a customer mapped to a Duet user pauses
  that account. The provisioner leaves foreign objects untouched; it may update
  its *own* Portal configuration in place and delete-and-replace the webhook
  endpoint at Duet's *exact* URL, and never touches account defaults, branding,
  or endpoints at any other URL.

  **Why the subscription arm is safe without a `workspaceId`:** account-level
  subscription events carry no `workspaceId`, so they qualify on `source:
  'duet'` + `userId` + `type: 'subscription'` alone. That is sufficient because
  **Duet is the only app that issues subscriptions on this Stripe account**
  (Example User, 2026-07-20) — the other apps only invoice directly (topups), and
  those are covered by the required `workspaceId`. `type: 'subscription'` is
  therefore itself a Duet-exclusive marker; the `organizationId` exclusion was
  redundant and was removed.

## Invariants that must keep holding

1. **One monthly-grant door.** All *monthly-bucket* credit grants originate from
   a recognized subscription `invoice.paid`, keyed by invoice id, amount from
   `SUBSCRIPTION_PLANS` — never from invoice dollars. Trial grants and admin
   adjustments are separate paid-bucket ledger entries; topups price from the
   invoice total.
2. **One post-creation balance writer.** After account initialization
   (`users/model.ts`), only `wallet.ts` mutates
   `paidCreditBalanceMicroUsd` / `monthlyCreditBalanceMicroUsd`. New
   balance-mutating writers outside `wallet.ts` are the regression to catch.
3. **Monthly-first drain, provenance on holds.** Reservations record bucket
   provenance + epoch so a refund can never resurrect expired monthly credit
   (`wallet.ts` epoch-mismatch forfeiture; `reservations.ts` readback).
4. **Subscription access derived per-request** via `isSubscriber`; no persisted
   `isActive`. `subscriptionEverActivatedAt` is one-way in production.
5. **Entitlement-driven pause/resume flows only through
   `reconcileServicingStatus`.** Two direct-write exceptions are by design and
   must stay narrow: workspace birth writes the computed initial servicing
   state atomically (`birth.ts`), and admin archival writes `paused`
   (`provisioningCore.ts`). Block *codes* stay distinct:
   `subscription_required` = account entitlement, `subscription_inactive` =
   workspace servicing paused.
6. **Shared-account safety:** positive-id provenance — `source: 'duet'` + our
   `userId` + (`type: 'subscription'` or a `workspaceId`), plus a recognized
   price id — before any grant/lifecycle effect; foreign lifecycle/invoice
   events no-op; disputes are the one customer-scoped exception. Topups
   additionally require a `workspaceId`. (`organizationId` is not inspected —
   see the residual-risk note above.) The provisioner never touches foreign
   objects — it edits only its own Portal config and the webhook at Duet's exact
   URL.
7. **Wall state derives from the workspace payer, not the viewer** — an entitled
   viewer of a lapsed payer's workspace sees paused; a lapsed member is not
   walled out of an entitled payer's workspace (`subscribe-wall.tsx`, tested
   both directions).

The end state reads as designed today: one wallet with two buckets, one ledger,
one projection, one spend-decision function (`authorizeSpend` in
`creditsShared.ts`) — not a subscription module bolted beside the topup rail.

## Where the build diverged from the plan

- **All 13 slices shipped**, including 08 (checkout / first-party plan
  endpoints / narrowed portal / REST overview), 09 (billing settings UI: plan
  card, % used meter, in-app plan changes), and 12 (staging lifecycle
  acceptance). The plan's TODO left 08/09/12 unchecked at hand-off; they landed.
- **D1 flipped mid-build (slice-04 kill criterion).** Stripe's Billing Portal
  rejects offering multiple prices at the same billing interval on one product
  (evidence: `assets/stripe-portal-d1-report.json`, a retained 400), so
  Portal-owned tier switching is impossible for three monthly tiers. Plan
  changes became first-party endpoints backed by a `changeSubscriptionPlan`
  seam (`services/stripe.ts`); the Portal narrowed to payment-method management
  + invoice history. The upgrade proration invoice still rides the single
  subscription `invoice.paid` grant door — the flip did not add a second door.
- **The live e2e campaign found and fixed five product bugs the unit suites
  never exercised**, each now pinned by a unit test:
  - `fix30` — resubscribe after a terminal lapse was locked out; the wallet now
    rebinds to a new subscription id (terminal blocks only same-subscription
    invoices). `subscriptions.ts:344`, `billing.test.ts:863`.
  - `fix39` — two lifecycle events in the same Stripe second could drop the
    cancel to a tie-break; same-second events now apply in delivery order,
    event-id dedup makes replays safe, an equal-second event never revives a
    terminal subscription. `subscriptions.ts:273`.
  - `fix36` / `fix52` — workspace archives are streamed to storage via an upload
    URL (`duplex: 'half'`) instead of buffered, with per-candidate sweep
    isolation. The named `archive_too_large` at 1GB fires when the upload's
    `content-length` declares the oversize (`provisioningActions.ts:309`); a
    chunked oversize still surfaces as a generic upload failure.
  - `fix64` — pending runner input now drains on **every non-quiesced** VM-sync
    poll (an indexed `.first()` independent trigger, `vmSync.ts:201`), fixing
    lost first prompts; quiesced (paused) polls report no pending input.
  - `fix73` — a failed or dead session runner releases the turn lock, ending the
    permanent `turn_already_running` 409 leak (`process-runner.ts`).
  - Adjacent: `fix55` (strip stale `content-encoding`/`length` from decoded
    composio proxy bodies — the same *class* of bug chat-app fixed in its
    ai-gateway; that external comparison is from the campaign notes, not
    verifiable in this repo), `fix9` / L32 (tar an absent workspace drive as
    empty, not a 500).
- **Reconciliation drift is tolerated to $1.** Reserve→settle→reconcile settles
  minutes later and drifts by a small amount per generation (~50k µUSD was the
  *observed* staging value, not an enforced runtime cap — settlement accepts any
  nonnegative cost); the harness asserts within a $1 bound
  (`withinReconciliationDrift`, fix28/32/56) rather than exact equality, and
  proves correctness via per-bucket ledger-row splits instead.
- **The provisioner reconciles Duet-owned Portal drift in place** (aef9f918)
  while foreign configured portals stay fail-closed — hardening beyond the plan.

## Pointers into the code

- Plan catalog (single source of tiers/prices/allotments):
  `packages/contract/src/plans/index.ts` — `SUBSCRIPTION_PLANS`,
  `bonusPercentForPlan`. Trial constants: `packages/contract/src/ledger/index.ts`.
- Price-id ↔ plan binding, fails closed on missing/duplicate:
  `packages/backend/convex/config.ts`.
- Wallet / drain policy: `packages/backend/convex/domains/credits/wallet.ts`;
  account init of both fields: `domains/users/model.ts`.
- Subscription projection + grant/reset/expiry, dispute + lifecycle branches:
  `domains/credits/subscriptions.ts`; pure payload normalization:
  `domains/credits/subscriptionEvents.ts`. Stripe API version pin
  (`2026-02-25.clover`) lives in `convex/services/stripe.ts`. Captured Stripe
  fixtures live with the tests at
  `packages/backend/test-fixtures/stripe-subscriptions/` (each stamped with that
  api_version; regenerated by `scripts/capture-stripe-subscription-fixtures.ts`).
- Entitlement gate + block reasons: `domains/credits/creditsShared.ts`
  (`authorizeSpend`); block codes in `domains/modelGateway/blocks.ts`.
- Servicing reconciler / full-stop / 7-day archive:
  `reconcileServicingStatus`, `workspaces/vmToken.ts`, `workspaces/vmSync.ts`,
  `workspaces/provisioningCore.ts`, `provisioningActions.ts` (archive streaming).
- Checkout / first-party plan endpoints / REST overview:
  `apps/api/src/routes/billing.ts`, `domains/credits/userBilling.ts`,
  `domains/credits/billingActions.ts`.
- Live lifecycle proof: `packages/test-harness/src/staging-e2e-synthetic`
  is the behavior runner; the leg *names* (`subscription-01`…`subscription-12`)
  are declared in `packages/test-harness/src/staging-e2e-synthetic`.
- Binding sweep register: `LANDMINES.md` (L1–L32, forks F0–F4 resolved).

## Dead ends (do not re-walk)

- **Portal-owned plan changes** — impossible for 3 same-interval prices
  (D1/F0 above). `assets/` keeps the original Portal design and draft C's
  endpoint sketch for the record.
- **A Stripe-fetching reconcile sweep that heals missed grants** (draft C's D4)
  — rejected: Stripe retries webhooks ~72h and the admin adjustment rail covers
  the residual. Revisit only if missed grants actually occur.
- **Leaving auto-topup threshold on the paid balance alone** — would charge
  subscribers holding a full monthly bucket; D5 reads combined spendable
  balance (`creditsShared.ts`, `ledger.ts`).
- **`markCurrentUserPaidForTest` / future-clock (2032/2035) fixtures** — became
  non-entitled under the trial timebox; replaced with explicit trial /
  synthetic-subscription fixtures and a side-effect-free balance reader
  (`testing/workspaces.ts`, `testing/credits.ts`). Never weaken production
  entitlement to keep an old fixture green (L23/L24).

## Visual provenance

- `assets/stage3-wall-directions.html` — the stage-3 locked design Example User
  reviewed for the subscribe wall, edge paused page, and low-credit toast; it
  drove slice 11's copy and layout (D12: prices shown, monthly bucket as
  "% used" only, never a dollar figure).
- `assets/staging-e2e-synthetic/` — the final green-run
  capture kept as evidence-of-done: `02-subscribe-wall.png` (exhausted-trial
  wall), `11-resubscribed.png` (resume-from-archive), and the
  `overview-snapshots.json` / `subscription-timeline.json` (subscription legs
  01–11) the lifecycle legs asserted against. The ~80 intermediate run captures
  were pruned at close.
- `assets/draft-{a,b,c}-*.md`, `assets/sweep-{a,b,c}-*.md`,
  `assets/drafting-brief.md`, `assets/stripe-portal-d1-report.json` — the
  planning provenance (three biased drafts, three stage-4 sector sweeps, the
  D1 kill evidence) synthesized into this feature.
Note: the captured Stripe fixtures are **live test inputs**, not provenance, so
they live with the tests at `packages/backend/test-fixtures/stripe-subscriptions/`
— deleting everything under `specs/` never breaks the suite. (They briefly lived
under `assets/` during the build; moved out at close so `specs/` holds only
documentation.)

## Follow-ups left open (not blockers)

- **Prod cutover is Example User-gated.** The live-mode provisioner run is the last
  step (refuses `sk_live_` without an explicit confirm flag); needs the
  secret-topology push, edge-hosts DNS, image rebake, and a real-card smoke.
  Nothing runs against live Stripe without Example User's confirmation.
- **Convex preview-deploy footgun:** feature-branch Vercel builds also run
  `convex deploy` last-writer-wins and can overwrite staging functions;
  re-pin with a keyed `convex deploy` from `packages/backend` after pushes.
- **Archive offload** for 100GB drives (trial-skip + object storage) is specced
  separately at `specs/archive-offload/` — provider pick is Example User's.
