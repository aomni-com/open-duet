# Self-serve signup and card-gated onboarding

## Overview

Duet's public conversion path leads directly to `/sign-in`. New workspaces
remain behind onboarding until the owner verifies a payment method and finishes
the setup wizard. Verification places a temporary USD 10 authorization, saves
the card for future off-session use, and releases the authorization. The
existing workspace-birth credit ledger grants the trial; payment readiness
gates the transition out of onboarding.

When the trial is exhausted or expires, the existing entitlement wall presents
Starter, Pro, and Max. The user selects a plan and the existing subscription
checkout reuses the saved card. Card verification never starts a subscription
by itself.

## Why it works this way

The scheduler was a public conversion dependency even though the product
already had self-serve sign-in. Removing the scheduler path makes every landing
page, blog, auth fallback, SEO surface, and LLM-readable description agree on
one destination.

The card step uses Stripe's manual-capture PaymentIntent because it proves that
the card can authorize a charge while allowing Duet to release the hold without
recording revenue. `setup_future_usage=off_session` keeps the payment method
usable for the subscription the user may choose later. Saving a card is a
billing capability, so it is intentionally separate from consent to subscribe.

The onboarding restriction is a lifecycle rule rather than a new credential
scope. The API and backend capability boundaries enforce the same admission
contract and refusal shape; setup, payment, completion, provisioning, sync,
and telemetry remain available so a blocked user can finish onboarding.
Existing rows with `onboardedAt` stay usable and no backfill is required.

## Principles and invariants

- Public conversion CTAs resolve to the product origin's `/sign-in`; no
  conversion surface points to a calendar scheduler.
- `paymentMethodReadyAt` is the user-level billing readiness fact. A workspace
  does not own a card, and the UI never infers readiness from a Stripe URL.
- A successful onboarding authorization is verified server-side against the
  current customer, user, workspace, attempt, and attached payment method,
  then canceled. Declined, canceled, or incomplete intents leave onboarding
  incomplete and retryable.
- `completeWorkspaceOnboarding` is the only writer that transitions an
  incomplete workspace to `onboardedAt`, and it requires payment readiness.
- Incomplete workspaces receive the stable HTTP 409
  `onboarding_required` contract at API, agent-session, and model-gateway
  admission points. Scope and unknown-workspace checks still happen first.
- The existing `$5` trial grant and the existing Starter/Pro/Max entitlement
  and subscription owners remain authoritative. No automatic Starter conversion
  or second trial grant is introduced.
- The browser handles Stripe tokenization only. Provider secrets, authorization
  settlement, idempotency, and payment-method persistence stay in the backend.

## Code and test pointers

The public destination owner and its assertions live in
`apps/lander/src/config/origins.ts`, the shared CTA components, and
`apps/lander/src/lander-entry-ctas.test.tsx` plus the public-page visual tests.

The typed onboarding/payment boundary is in `packages/contract/src/onboarding`,
`apps/api/src/routes/onboarding.ts`, and
`apps/web/spa/onboarding/onboarding-payment-step.tsx`. Stripe authorization,
readiness, completion, and subscription reuse are owned by the Convex billing
actions and workspace lifecycle modules; focused coverage is in
`packages/backend/src/billing.test.ts`, the Stripe authorization proof, and the
API onboarding tests.

Admission enforcement follows one contract across the API workspace helpers,
VM-token/session routes, and the model-gateway preflight. The refusal contract
is pinned by `apps/api/src/shared.test.ts` and
`apps/model-gateway/src/preflight.test.ts`; backend agent-session tests cover
the separate agent-session lifecycle.

The visual journey fixtures deliberately return a ready payment state at the
provider edge so they exercise the real payment step without contacting Stripe.
The production provider path remains server-owned.

## Dead ends and rejected alternatives

- A setup-only Stripe intent was rejected because it would not prove the
  authorization hold requested by the product.
- Automatic Starter enrollment after the trial was superseded by user-selected
  subscription conversion through the existing three-plan wall.
- A single `requireAuthedWorkspace` edit was rejected because direct agent,
  VM-session, and model-gateway entry points bypass that helper.
- A workspace-local payment owner was rejected because billing readiness and
  saved cards belong to the payer user.
- A calendar compatibility redirect was rejected because the cutover is hard;
  retaining it would preserve two competing public conversion paths.

## Visual provenance

The onboarding screenshots under
`apps/web/tests/visual/__screenshots__/desktop/playground.spec.ts/` and
`.../mobile/playground.spec.ts/` are the checked-in visual review record for
the final wizard states, including the payment-ready panel. The screenshot
assertions live in `apps/web/tests/visual/playground.spec.ts`; the desktop and
mobile viewport definitions live in `apps/web/playwright.config.ts`, while
`onboarding-journey.spec.ts` owns the route-level identity-to-workspace journey.
The verified state keeps the payment-method context, foregrounds the `$5`
incentive, and explains that plan selection remains user-driven.

## Release evidence

Focused API, backend billing/analytics, onboarding, typecheck, lint, lander CTA,
and desktop/mobile Playwright journey checks pass. The repository-wide test command
was run once for closeout; its remaining failures are unrelated baseline model
expectations, agent-route expectations, and provider-domain/write-rate
contention. A live Stripe staging journey is still blocked because this
checkout has no `.env.keys` and no `STRIPE_SECRET_KEY`; the fake Stripe proof
does not claim live-provider evidence.

The final decision ledger is in [choices.md](choices.md), and the provider
proof is in [assets/authorization-proof.md](assets/authorization-proof.md).
