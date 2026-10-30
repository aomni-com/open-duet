Marker: `SUBSCRIPTION-LANDMINE-SWEEP-2026-07-17`

1. BILLING-USER CHANGES LEAVE SERVICING PROJECTED FROM THE OLD PAYER

EVIDENCE: `packages/backend/convex/domains/workspaces/mutations.ts:213-242` changes only `billingUserId` and `updatedAt`. The planned reconciler derives servicing from the billing user and is called on entitlement transitions, not payer reassignment (`specs/monthly-subscriptions/slices/07-period-lapse.md:33-45`).

WHY IT BITES: An active workspace reassigned to a trial-exhausted, lapsed, or disputed owner remains active. Conversely, a paused workspace moved to an entitled payer remains paused. No Stripe event for the new payer necessarily follows, so the denormalization can remain stale indefinitely; charged traffic may eventually expose it, but published apps and unmetered paths inherit the wrong status.

WHAT IT CHANGES: Slice 07 / D8. `setBillingUser` must invoke the servicing reconciler after changing the payer, or the reconciler must own the combined payer-and-status transition atomically.

2. ADMIN DEBITS CAN EXHAUST A TRIAL WITHOUT PAUSING ITS WORKSPACES

EVIDENCE: The global free-credit reset drains the full balance through an `adjustment` ledger entry (`packages/backend/convex/domains/internalAdmin/model.ts:259-284`). Per-workspace admin credit adjustments use the same path (`packages/backend/convex/domains/internalAdmin/model.ts:321-338`). Ledger reconciliation side effects currently exist only around spend/preflight; adjustments simply patch the wallet (`packages/backend/convex/domains/credits/ledger.ts:60-70`).

WHY IT BITES: Resetting free credits or applying a negative admin adjustment can make a never-subscribed trial account unentitled while all of its workspaces remain active. Because its future `trialExpiresAt` has not elapsed, the time-based sweep need not select it. The account can therefore retain active published apps and unmetered servicing until a charged request happens to run the entitlement gate.

WHAT IT CHANGES: Slices 06–07 / D8 and D10. Wallet commands that can cross entitlement from positive to exhausted need to schedule reconciliation, including internal-admin adjustments and the bulk reset.

3. NEW WORKSPACES ARE ACTIVE-BY-DEFAULT EVEN WHEN THEIR PAYER IS LAPSED

EVIDENCE: Workspace birth allows every account with historical `firstPaidAt` to create additional workspaces (`packages/backend/convex/domains/workspaces/birth.ts:36-53`). The inserted row has no `servicingStatus`, which all consumers interpret as active (`packages/backend/convex/domains/workspaces/birth.ts:71-81`; `packages/backend/convex/domains/workspaces/queries.ts:106-115`).

WHY IT BITES: `firstPaidAt` is one-way, so a lapsed or disputed former subscriber can create a fresh workspace that starts active and is immediately scheduled for provisioning. The globally idempotent trial grant will not restore entitlement. This creates a new stale-active workspace after the account’s existing workspaces were correctly paused.

WHAT IT CHANGES: Workspace birth plus slice 07 / D8. Birth must initialize or reconcile servicing from current entitlement; preserving `firstPaidAt` as the workspace-count policy does not make it a valid servicing policy.

4. INTERNAL ADMIN IS A COMPETING `servicingStatus` OWNER

EVIDENCE: The admin mutation directly writes arbitrary `active`, `paused`, or `banned` status (`packages/backend/convex/domains/internalAdmin/model.ts:299-344`). Its public contract exposes the same unrestricted operation (`packages/contract/src/internal-admin/index.ts:26-52`). Slice 07 declares `reconcileServicingStatus` the single owner of desired status (`specs/monthly-subscriptions/slices/07-period-lapse.md:33-45`).

WHY IT BITES: An operator can reactivate a lapsed/disputed workspace without changing entitlement, temporarily republishing its edge apps. The reverse also happens: an intentional admin pause of an entitled account will be silently undone on its next renewal or reconciliation. The UI presents both writes as durable, but future webhook/sweep timing decides which wins.

WHAT IT CHANGES: Slice 07 / D8 and the internal-admin contract. Decide whether admin servicing becomes a separate persisted override folded into the reconciler, or remove `active`/`paused` as direct derived-state writes. `banned` already has explicit “untouched” semantics.

5. RATE LIMITING RUNS BEFORE ENTITLEMENT AND CAN DELAY THE PAUSE TRIGGER

EVIDENCE: Service-proxy preflight consumes and may reject on the rate limit before running metered billing preflight (`packages/backend/convex/domains/serviceProxy/model.ts:38-55`). The existing test explicitly pins servicing → rate → credit ordering (`packages/backend/src/service-proxy.test.ts:52-92`). Slice 06 schedules reconciliation only when authorization returns `subscription_required` (`specs/monthly-subscriptions/slices/06-subscription-required-gate.md:46-52`).

WHY IT BITES: The first request after trial exhaustion or lapse can return `429 rate_limited` instead of `402 subscription_required`. More importantly, authorization never runs, so the D8 pause is not scheduled. Repeated requests inside the window continue masking the entitlement transition.

WHAT IT CHANGES: Slice 06 / D8. Charged adapters need entitlement evaluation before consumptive rate limiting, or an entitlement-only guard must run first. The pinned service-proxy ordering test must intentionally change.

6. THE SESSION USER PROJECTION WILL LEAK NEW STRIPE PROJECTION INTERNALS

EVIDENCE: The session query removes only top-level `stripeCustomerId`, then returns the remainder of `user.billing` wholesale (`packages/backend/convex/domains/users/queries.ts:5-22`). The planned subscription object contains Stripe subscription/price IDs and lifecycle event IDs (`specs/monthly-subscriptions/slices/05-subscription-projection.md:30-33`). The existing projection test checks only that top-level `stripeCustomerId` is absent (`packages/backend/src/auth-workspaces.test.ts:634-650`).

WHY IT BITES: Adding `billing.subscription` automatically exposes its Stripe identifiers, webhook ordering fields, dispute marker, and future internal billing fields to every authenticated browser session. This bypasses the curated slice-08 billing overview and silently expands an existing API shape.

WHAT IT CHANGES: Slices 05 and 08. `domains/users/queries:current` needs an explicit allow-list projection, and its test should reject nested Stripe/internal fields.

7. DISPUTES HAVE NO ADMIN RESOLUTION CONTRACT

EVIDENCE: The planned webhook sets `billing.disputeFlaggedAt` and says clearing it is a manual admin action (`specs/monthly-subscriptions/slices/05-subscription-projection.md:73-76`). Current admin operations cover only credit, servicing, message, and suspension (`packages/contract/src/internal-admin/index.ts:26-52`), while workspace summaries expose no dispute state (`packages/contract/src/internal-admin/index.ts:69-89`).

WHY IT BITES: Implementing only the webhook marker makes the pause durable but operationally irreversible. Directly setting servicing active will not clear the flag and the reconciler will pause it again. Operators also cannot distinguish a dispute pause from lapse/topup failure using the existing surface.

WHAT IT CHANGES: Slice 05 / D11 and slice 07’s reconciler matrix. Add an account-level dispute projection and audited clear operation; do not treat workspace servicing mutation as dispute resolution.

8. `firstPaidAt` SILENTLY GRANTS A PERMANENT 10× SERVICE-PROXY RATE TIER

EVIDENCE: Service-proxy rate selection treats any `firstPaidAt` as paid (`packages/backend/convex/domains/serviceProxy/model.ts:38-44`), selecting 600 rather than 60 requests per minute by default (`packages/backend/convex/domains/serviceProxy/rateLimit.ts:5-24`). Subscription activation permanently sets `firstPaidAt` (`specs/monthly-subscriptions/slices/05-subscription-projection.md:58-61`).

WHY IT BITES: A subscriber retains the paid service-proxy rate tier after cancellation or lapse. Inference: normally D8’s pause masks this, but any stale-active interval from payer reassignment, workspace birth, delayed timeout reconciliation, or an admin activation exposes the permanent higher unmetered allowance. This policy consumer is not one of D2’s explicitly named approved-model/workspace gates.

WHAT IT CHANGES: D2/D9 and slices 05–07. Decide explicitly whether this is historical paid access or an active-subscription product limit; if current-only, use `isSubscriberAt`, not `firstPaidAt`.

9. THE TESTING SEAM’S “PAID USER” FIXTURE WILL CREATE NON-ENTITLED ACCOUNTS

EVIDENCE: `markCurrentUserPaidForTest` and `markUserPaidByEmailForTest` set only `billing.firstPaidAt` (`packages/backend/convex/testing/workspaces.ts:103-117`, `:148-167`). Service-proxy fixtures and many workspace tests depend on that helper (`packages/backend/src/service-proxy.test.ts:95-123`, `:157-181`). Slice 06 explicitly forbids using `firstPaidAt` for subscription entitlement (`specs/monthly-subscriptions/slices/06-subscription-required-gate.md:28-33`).

WHY IT BITES: After the new gate lands, these fixtures look paid to model/catalog/workspace/rate policies but are not subscribers. Charged tests will fail broadly, and tests intended to exercise paid behavior may accidentally exercise trial behavior from workspace bootstrap. The dangerous “fix” would be weakening production entitlement to preserve fixture semantics.

WHAT IT CHANGES: Slices 05–06 and `convex/testing`. Replace the ambiguous helper with explicit trial and synthetic-subscription fixtures; update consumers according to the policy they intend to test.

10. PAUSED PROVISIONING CAN STILL MINT AND RETURN A VM TOKEN

EVIDENCE: VM registration validates provisioning state but never checks `servicingStatus`, then generates, persists, and returns a VM token (`packages/backend/convex/domains/workspaces/registration.ts:23-58`, `:87-105`). The ordinary gateway-token lookup rejects paused workspaces (`packages/backend/convex/domains/workspaces/vmToken.ts:63-95`).

WHY IT BITES: If entitlement expires while provisioning, or birth correctly initializes the row as paused, registration still reports successful activation and hands the VM credentials. The token is rejected at the normal gateway-connection seam, producing a successfully registered but unusable VM rather than a clean paused outcome. Inference: this can cause provisioning retry/health churn depending on the caller.

WHAT IT CHANGES: Slice 07 / D8 and the `vm_register` trial path. Registration must define paused behavior explicitly—either refuse issuance or register without presenting serviceable credentials.

Clean areas: approved-model access deliberately keys off historical `firstPaidAt` as D2 requires (`packages/contract/src/approved-models/catalog.ts:101-111`); usage rollups are bucket- and entitlement-blind actual-cost telemetry as required (`packages/backend/convex/domains/credits/usageRollups.ts:61-87`, `:110-139`); trial grant idempotency remains centralized across workspace birth and VM registration (`packages/backend/convex/domains/credits/grants.ts:11-42`).

Coverage: swept `README.md`, `specs/monthly-subscriptions/{README.md,slices/}`, `domains/{users,workspaces,credits,internalAdmin,serviceProxy,modelGateway,invitations,apiKeys}`, `convex/{auth.ts,schema.ts,testing/}`, approved-model and admin/billing contracts, backend policy tests, API workspace/admin seams, and the staging billing harness.