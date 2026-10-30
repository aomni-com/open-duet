# Low-credit recovery

## Overview

Duet stops a workspace before its spendable balance reaches the hard refusal floor. At an inclusive
low-credit boundary, the workspace shell becomes an urgent recovery surface: a trial payer chooses
a subscription, an active subscriber chooses a top-up, and a member waits for the owner. An account
that has enabled automatic top-up does not see this proactive gate.

The gate complements rather than replaces the server refusal. Browser projections can be stale, so
an attempted send can still reach the hard floor first. In that case the composer presents the
structured refusal and preserves the draft instead of collapsing the failure into a generic session
error.

## Why this shape

### The server projects a recovery kind, not billing data

Every viewer of a workspace needs the same answer about whether work must stop, but members do not
need the payer's balance, automatic-top-up configuration, payment-method state, or detailed
subscription lifecycle. The recovery addition to `WorkspaceSummary` therefore carries only
`creditRecovery: 'subscribe' | 'topup' | null`. The browser combines that answer with the existing
payer identity to choose payer or member presentation; the pre-existing funding summary remains.

This keeps money arithmetic and entitlement knowledge in the backend. It also prevents a member
route, browser cache, or UI component from becoming a second low-credit policy owner.

### The three money boundaries remain independent

The automatic-top-up minimum, proactive recovery boundary, and hard spend floor describe different
product promises. They have separate named constants and an asserted order. Changing one must not
silently retune another.

The recovery calculation uses the same expiry-aware spendable balance as authorization: paid reserve
plus live monthly credit. Automatic top-up suppresses the proactive gate solely because the user
enabled it; Stripe readiness and retry backoff do not reinterpret that choice.

### One shell owns blocking billing precedence

The existing paused/lapsed entitlement wall wins over low credit, and low credit wins over the
mounted destination. Keeping the destination mounted preserves the route and unsent work. Mounting
this choice in the shared workspace shell also prevents settings, admin, and ordinary workspace
routes from drifting into different billing behavior.

The recovery surface is deliberately non-dismissible and blocks only its workspace. The mounted
workspace becomes inert while recovery is required; account-level invitations above it remain
visible and keyboard-accessible, so a blocked workspace cannot prevent joining another one.

### Recovery leaves the working tab intact

Hosted checkout opens in a fresh isolated tab reserved synchronously by the click. The helper removes
the opener relationship and replaces the blank tab's history entry with checkout. A failed setup
closes only that tab and leaves a retryable error in the workspace.

Returning focus merely asks the server again. The gate clears only when a fresh workspace projection
reports no recovery state; checkout launch, redirect, elapsed time, and local state are not evidence
that funds landed.

### Reactive refusal remains first-class

The proactive modal and the hard-floor refusal can race. A composer that already began submitting
must trust the server's structured `402`, keep the exact draft, and show the correct subscription,
top-up, cap, or payment recovery. A mounted refusal clears automatically only after it observes a
real recovery cycle from non-null recovery state back to null. Treating any cached null as recovery
would erase the stale-projection fallback.

## Invariants

- `workspaceCreditRecovery` is the only owner of the recovery decision: it applies the shared
  threshold, expiry, automatic-top-up suppression, servicing precedence, and payer recovery kind.
- `workspaceSummary` projects the same payer-derived enum to owners and members without adding payer
  balance, automatic-top-up configuration, payment-method, or Stripe state.
- `WorkspaceBillingBoundary` renders at most one billing surface within the workspace, with entitlement state
  ahead of low credit.
- The low-credit gate never replaces the mounted destination and never becomes dismissible through
  Escape, backdrop interaction, or a close control.
- Trial payers receive subscription recovery; active subscribers receive top-up recovery; members
  receive no billing action.
- The gate offers only the approved top-up presets. The general Billing Settings checkout remains a
  broader manual-payment surface.
- Low-credit recovery checkout never navigates or optimistically updates the working tab.
- Server state is the only proof of recovery. The reactive refusal remains available when that state
  arrives too late.
- The old percentage warning, acknowledgement write, persisted acknowledgement field, and UI toast
  have no compatibility reader or migration rail.

## Pointers

- Shared money and workspace contracts: `packages/contract/src/ledger/index.ts` and
  `packages/contract/src/workspaces/index.ts`.
- Backend policy and projection: `workspaceCreditRecovery` in
  `packages/backend/convex/domains/credits/creditsShared.ts` and `workspaceSummary` in
  `packages/backend/convex/domains/workspaces/summary.ts`.
- Automatic-top-up input and effective-floor behavior:
  `packages/backend/convex/domains/credits/userBilling.ts` and
  `packages/backend/convex/domains/credits/topups.ts`.
- Presentation and shell ownership: `LowCreditGate`, `SubscriptionPlanChooser`, and
  `WorkspaceBillingBoundary` under `apps/web/spa/entitlements/`, mounted by
  `apps/web/spa/drive/drive-workspace-shell.tsx`.
- Hosted-tab and refresh mechanics: `openHostedCheckout` and `createCheckoutReturnRefresher` under
  `apps/web/spa/entitlements/`.
- Reactive fallback: `SpendRefusalNotice` under `apps/web/spa/entitlements/` and both composer send
  paths in `apps/web/spa/routes/sessions.tsx`.
- Deployed lifecycle proof: `packages/test-harness/src/staging-e2e-synthetic`, registered as the
  focused `low-credit-recovery` journey.
- The implementation decision audit remains in [`choices.md`](choices.md).

The neighboring focused tests pin these contracts at their owning seams. The visual playground and
snapshots under `apps/web/components/playground/` and `apps/web/tests/visual/` pin the three recovery
views, composed shell behavior, pending/error states, and the reactive refusal.

## Divergences and dead ends

- Reusing a named checkout window was rejected. A retry can inherit a cross-origin `WindowProxy`, so
  each attempt reserves a fresh `_blank` context instead.
- Assigning the checkout URL would leave a useless blank page in browser history. Replacing the
  temporary entry keeps Back from returning to scaffolding.
- Clearing a refusal whenever the current projection is null would erase the exact stale-client case
  the fallback protects. Recovery therefore requires an observed non-null-to-null cycle.
- A live test first tried to prove `insufficient_credits` on a trial. The server correctly returned
  `subscription_required`; the exact insufficient-credit race belongs to the active-subscriber leg.
- The live journey cannot honestly produce paused servicing and non-null recovery simultaneously,
  because backend policy clears recovery when servicing is inactive. Pure selector and composed UI
  tests prove that precedence; staging proves the real paused transition.
- A full run identifier exceeded the email local-part limit for the secondary test identity. Its
  shortened alias retains the `staging-e2e-synthetic` cleanup marker, while the full identifier stays in the
  return URL used for mailbox correlation.

## Visual provenance

- [`assets/generic-session-error-reference.png`](assets/generic-session-error-reference.png) is the
  user-supplied failure screenshot. It established the defect: an out-of-credit send was reduced to
  a generic “Session could not be created” message while the draft remained in the composer.
- [`visualizations/low-credit-gate-directions.html`](visualizations/low-credit-gate-directions.html)
  is the approved direction-C exploration. It drove the urgent amber stripe, direct hierarchy, and
  modal silhouette while visualizing the already-decided trial/subscriber/member treatments; it was
  inspiration, not a pixel baseline.
- Active desktop and mobile regression baselines live under
  `apps/web/tests/visual/__screenshots__/`. They are the executable record for clipping, hierarchy,
  selected states, draft continuity, and the reactive refusal.

## Cutover record

The strict schema cutover required deleting one obsolete production acknowledgement value. The user
authorized that deletion; the temporary operator function was removed immediately afterward. The
bounded, privacy-preserving result is recorded in
[`assets/deployment-probe-2026-08-23.md`](assets/deployment-probe-2026-08-23.md). No compatibility
field, dual reader, or migration mechanism remains.
