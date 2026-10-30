# Choices ledger

## Sound

### Legacy API fixtures mark onboarding complete without inventing payment readiness

The new lifecycle gate makes a newly-created workspace incomplete until its
owner verifies a card and completes onboarding. Most existing API route tests
exercise the capability they own, rather than the onboarding lifecycle, so
their shared fixture now explicitly stamps `onboardedAt` through a test-only
Convex mutation. The fixture deliberately leaves payment readiness unchanged;
the billing tests still prove that payer controls require a card.

**Gap:** the plan did not specify how pre-existing capability fixtures should
represent a completed workspace after the lifecycle gate shipped.
**Reach:** future route fixtures must choose their lifecycle state explicitly,
while onboarding and billing tests retain control over incomplete and
card-missing cases.
**Verdict:** sound. **Confidence:** high.

### Public conversion now goes directly to sign-in

Every public and blog conversion action uses the product origin's `/sign-in`. A
visitor can create an account immediately; no page keeps a scheduler destination
or compatibility redirect. Calendar words that describe product integrations or
editorial examples remain ordinary content, while booking links are removed from
conversion surfaces.

**Gap:** the request was a hard cutover, so preserving old scheduler links would
have created a second public path.
**Reach:** future campaign and blog work must use the shared product CTA owner.
**Verdict:** sound. **Confidence:** high.

### Billing readiness is user-level and separate from workspace onboarding

The saved card is owned by the billing user, and `paymentMethodReadyAt` remains
the one readiness fact. Optional attempt ids and status fields only let the
server recover a lost browser response or retry a declined authorization. A
workspace never gets its own card owner.

**Gap:** retry and abandoned-tab recovery required durable attempt evidence, but
the plan did not prescribe field names.
**Reach:** billing, onboarding completion, and future subscription Checkout all
read the same user-level readiness projection.
**Verdict:** sound. **Confidence:** high.

### Card verification uses a temporary manual-capture $10 authorization

The server creates a USD 10 PaymentIntent with manual capture and
`setup_future_usage=off_session`, verifies the payer metadata and capturable
state, saves the payment method as the customer's default, then cancels the
intent to release the hold. It never records the authorization as product
revenue. Failed or abandoned attempts leave onboarding incomplete and retryable.

**Gap:** none; this was a settled product and Stripe contract.
**Reach:** the browser only handles Stripe tokenization, while all provider
secrets and settlement decisions stay server-side.
**Verdict:** sound. **Confidence:** high.

### Adding a card never starts a subscription

After verification, the user sees the existing trial. When credits are exhausted
or the seven-day trial expires, the existing entitlement wall presents Starter,
Pro, and Max. The selected plan reuses the existing subscription Checkout and
saved customer default card, with `payment_method_collection=if_required`; the
user can still complete Stripe-required authentication. No automatic Starter
conversion was added.

**Gap:** the user's later instruction changed the earlier automatic-Starter
choice.
**Reach:** subscription and invoice projection remain the only paid-access owners;
a saved card is a capability, not consent to subscribe.
**Verdict:** sound. **Confidence:** high.

### Incomplete workspaces are refused at every capability admission boundary

The API and backend model/session entry points share the onboarding admission
predicate and return HTTP 409 with the stable `onboarding_required` shape until
`onboardedAt` exists. Setup, payment, completion, provisioning, sync, and
telemetry paths are explicit exceptions so a user can finish onboarding.

**Gap:** the existing API had several admission helpers, so a single route guard
would have left bypasses.
**Reach:** new capability routes must consume the shared predicate rather than
inventing another lifecycle check.
**Verdict:** sound. **Confidence:** high.

### Visual fixtures simulate a verified card through the payment source seam

Playground and journey fixtures return the production API's ready payment state
instead of loading Stripe. They still walk the real payment step and completion
gate, while live provider behavior is covered by fake-Stripe tests. The staging
journey is authored and registered but remains unrun until credentials exist.

**Gap:** visual Docker runs cannot use live Stripe credentials.
**Reach:** fixture changes cannot become a second production payment path; the
provider seam stays at the API boundary.
**Verdict:** sound. **Confidence:** high.

### The verified state gets its own explanatory hierarchy

After a successful authorization, the final step keeps the payment-method
heading and authorization disclosure, then shows a green success panel naming
the saved payment method, the `$5` free-credit incentive, and the user-selected
subscription policy. This avoids presenting a verified card as an empty or
stalled screen.

**Gap:** visual review found the original ready state was only a small muted
sentence and visually conflicted with the “Add a card” heading.
**Reach:** future payment-state copy must preserve the distinction between card
verification, free credits, and user-selected subscription.
**Verdict:** sound. **Confidence:** high.

## Needs-user

None.

## Unsound

None.
