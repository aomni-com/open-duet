# Stripe authorization proof

This artifact records the provider seam proof for slice 00. The executable
proof is `packages/backend/src/stripe-authorization-proof.test.ts`; it uses the
Stripe SDK request types and a deterministic fake that models the documented
PaymentIntent and Checkout state transitions. The fake never contacts Stripe,
stores card data, captures an intent, or writes billing state.

## Immutable inputs

- Source revision at proof start: `935ec31899755515f397d2510f33593337ccdf10`
- Stripe SDK: `20.4.1`
- Stripe API version: `2026-02-25.clover`
- Request identity: customer, workspace, user, and attempt ids are synthetic
  (`cus_*`, `workspace_*`, `user_*`, `onboarding:*`); no customer PII is stored.
- Checkout billing fixture: synthetic name, email, and US address are supplied
  on the customer before Checkout. The fake reports `billingDetailsComplete=true`
  alongside the saved default card; these are the fields slice 04 must collect
  or confirm for Stripe Checkout prefill.
- Card fixtures: Stripe test payment method labels only (`pm_card_visa`,
  `pm_card_chargeDeclined`, `pm_card_authenticationRequired`); no PAN or client
  secret is retained.

## Request and state trace

The fake records the same request fields the production Stripe seam must send:

```json
{
  "amount": 1000,
  "currency": "usd",
  "customer": "cus_onboarding",
  "capture_method": "manual",
  "setup_future_usage": "off_session",
  "payment_method_types": ["card"],
  "metadata": {
    "source": "duet",
    "type": "onboarding_payment_method_authorization",
    "workspaceId": "workspace_onboarding",
    "userId": "user_onboarding",
    "attemptId": "onboarding:user_onboarding:attempt-1"
  }
}
```

The successful path is:

```text
created (requires_payment_method)
  -> confirmed (requires_capture, amount_capturable=1000, pm_card_visa attached)
  -> customer invoice default set to pm_card_visa
  -> canceled (amount_capturable=0, no captured charge, revenue=0)
```

The recovery proof also covers:

- A lost response after creation: retrying the same idempotency key returns the
  original `pi_proof_1`, with no second hold.
- A lost response after cancellation: retrieval and a repeated cancel converge
  on `canceled`.
- `pm_card_chargeDeclined` remains `requires_payment_method` and is retryable.
- `pm_card_authenticationRequired` remains `requires_action` and is retryable.
- The existing `createSubscriptionCheckout` call passes the same customer; the
  fake customer has `pm_card_visa` as its invoice default, so the session is
  returned with that saved method and `cardEntryRequired=false`.

## Verdict

The focused fake/SDK seam proof passed with:

```text
4 pass, 0 fail, 21 expect() calls
```

The repository checkout does not contain `.env.keys`, and `STRIPE_SECRET_KEY`
is not available in this environment. A live Stripe test-mode run and the
resulting provider event IDs therefore remain an explicit follow-up; this
artifact does not claim live-provider evidence. No production payment behavior
is introduced by this slice.
