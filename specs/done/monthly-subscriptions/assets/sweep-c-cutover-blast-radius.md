Marker: `SUBSCRIPTION-LANDMINE-SWEEP-2026-07-17`

1. OPEN WORKSPACES HAVE NO ENTITLEMENT POLL

EVIDENCE: `apps/web/spa/root.tsx:56-63` configures only a 30-second stale time; the root identity query at `apps/web/spa/root.tsx:102-110` has no `refetchInterval`. Billing is fetched only inside the settings route at `apps/web/spa/routes/user-settings.tsx:131-142`.

WHY IT BITES: An already-open workspace never learns that a webhook or sweep paused it unless another event triggers a refetch. Inference: the subscribe wall and low-credit toast can remain absent indefinitely in a quiet tab, despite D8 requiring immediate servicing pause and slice 11 requiring the wall within one poll.

WHAT IT CHANGES: Slice 11 needs a root-owned overview/identity polling contract, including tests for webhook-driven pause/resume while the user remains on the workspace route.

2. THE “DERIVED” TRIAL COPY CONSTANT IS ACTUALLY A MANUAL DUPLICATE

EVIDENCE: `apps/lander/lib/brand-copy.ts:47-53` says the label derives directly from a backend constant, but it imports `TRIAL_CREDIT_USD` from `public-site-config`; `apps/lander/lib/public-site-config.ts:1-5` hardcodes it to `10`. The real grant is independently defined in `packages/contract/src/ledger/index.ts:6`.

WHY IT BITES: Changing `DEFAULT_TRIAL_GRANT_MICRO_USD` to $5 leaves every `TRIAL_CREDIT_LABEL` surface, JSON-LD offer, and SEO description advertising $10 while tests remain green. The misleading comment actively directs maintainers to a nonexistent old owner.

WHAT IT CHANGES: Slice 00 or 10 must delete this duplicate or add an equality assertion against the contract before changing the trial value.

3. THE PRODUCT-COPY SWEEP IS BLIND TO BILLING CLAIMS

EVIDENCE: `apps/lander/scripts/check-product-copy.ts:34-35` defines candidates only around channel/chat vocabulary; `apps/lander/scripts/check-product-copy.ts:125-130` returns `unrelated` before applying any rule when those words are absent. Yet scanned content contains current commercial claims such as `$10 trial` and usage-based pricing in `apps/lander/content/guides/best-ai-agent-platforms-2026.mdx:119,183`, and “no separate subscription required” in `apps/lander/content/blog/claude-opus-4-7-gpt-5-4-extended-thinking-duet.mdx:249`.

WHY IT BITES: The checker scans those files but silently approves stale $10, pay-as-you-go, zero-platform-fee, and “no subscription required” claims. Updating only the pricing page leaves contradictory SEO/editorial pages live.

WHAT IT CHANGES: Slice 10 needs billing-specific forbidden-claim rules and a broad content sweep, not reliance on the existing `check-product-copy` pass.

4. STAGING STARTS WITH THE REAL TRIAL PLUS AN UNRELATED $10 GRANT

EVIDENCE: Workspace birth automatically calls the canonical trial grant at `packages/backend/convex/domains/workspaces/birth.ts:87-99`; the grant uses the contract amount at `packages/backend/convex/domains/credits/grants.ts:23-31`. The staging runner then separately marks the user paid and adds a hardcoded `10_000_000` generic grant at `packages/test-harness/src/staging-e2e-synthetic:267-277`.

WHY IT BITES: After the cutover, the “fresh trial” staging account starts with $5 trial credit plus $10 paid reserve. Draining the combined wallet can still produce a paused workspace, yielding a false-positive lifecycle test that never proves trial exhaustion occurs at $5. Existing live legs also become dependent on an undocumented paid-reserve fixture.

WHAT IT CHANGES: Slice 12 must isolate the subscription lifecycle account from the general acceptance account, or remove the synthetic grant and explicitly budget existing legs against the real trial.

5. THE “STRIPE BILLING” LIVE LEG IS SETUP-MODE ONLY—THERE IS NO EXISTING TOPUP LEG TO PRESERVE

EVIDENCE: The harness waits for the old `/user/billing/checkout` route and clicks “Set up billing / Add payment method” at `packages/test-harness/src/staging-e2e-synthetic:31-44`. Its terminal assertion only polls `hasPaymentMethod` at `packages/test-harness/src/staging-e2e-synthetic:124-135`; it never initiates or verifies a topup. Resource tracking currently knows only Stripe sessions and customers at `packages/test-harness/src/staging-e2e-synthetic:7-22`.

WHY IT BITES: Slice 09 hides topup controls for unsubscribed trial users, so this leg cannot run in its current position. Repurposing it for subscription Checkout would silently remove coverage for the supposedly “existing topup acceptance leg,” because no such credit/topup assertion currently exists. Subscription schedules, invoices, and test clocks also cannot yet be independently tracked or verified during cleanup.

WHAT IT CHANGES: Slice 12 must split subscription Checkout from an explicit post-subscription setup/topup verification and extend resource ownership before creating Stripe clocks or schedules.

6. FUTURE-CLOCK BILLING TESTS BECOME ENTITLEMENT TESTS ACCIDENTALLY

EVIDENCE: Reservation/cap tests inject May 2032 into preflight at `packages/backend/src/credits.test.ts:152-190`; the pure authorization test fabricates a user without trial/subscription state and evaluates July 2035 at `packages/backend/src/credits-shared.test.ts:8-26`. The common `balance()` helper itself calls the preflight mutation at `packages/backend/src/credits.test.ts:446-464`.

WHY IT BITES: Once `authorizeSpend` checks `trialExpiresAt` first, these tests return `subscription_required` before reaching reservation or monthly-cap logic. Because preflight also schedules D8 reconciliation on that result, a helper intended merely to read a balance can pause the fixture workspace and cause cascading failures.

WHAT IT CHANGES: Slices 02 and 06 need entitlement-aware fixture builders and a side-effect-free wallet reader for test assertions; future-clock tests should explicitly seed a subscription spanning their injected time.

7. INTERNAL ADMIN’S “BALANCE” WILL SILENTLY BECOME PAID-RESERVE-ONLY

EVIDENCE: The admin wire contract contains one `creditBalanceMicroUsd` at `packages/contract/src/internal-admin/index.ts:69-89`; the backend projects the payer’s scalar directly at `packages/backend/convex/domains/internalAdmin/model.ts:562-567`; the web labels and displays it as the workspace balance at `apps/web/spa/routes/internal-admin.tsx:218-222` and `apps/web/spa/routes/internal-admin.tsx:317-324`.

WHY IT BITES: A mechanical D7 rename can keep this UI compiling while showing only paid reserve. Inference: an active Pro user with $60 monthly credit and $0 reserve appears to internal admin as having a $0 balance, leading to incorrect support and dispute diagnosis.

WHAT IT CHANGES: Slice 02/D7 must make an explicit internal-admin contract decision: expose both buckets or a clearly named derived total, rather than mechanically renaming the scalar.

8. WEB ENGLISH/SPANISH KEY PARITY IS UNENFORCED

EVIDENCE: Product messages are independently loaded by locale at `apps/web/lib/i18n/product-locale.ts:7-10`. The web test script runs scripts/app/src/spa plus boundary and visual checks at `apps/web/package.json:13-17`, but its only i18n boundary test checks cookie/runtime ownership, not leaf keys, at `apps/web/scripts/i18n-language-boundary.test.ts:33-50`. By contrast, the lander explicitly compares leaf keys at `apps/lander/scripts/verify-public-content.ts:113-127`.

WHY IT BITES: New subscription keys can be added only to English and still pass the web suite until the Spanish state is rendered. Current files happen to match, but there is no invariant keeping them matched.

WHAT IT CHANGES: Slice 09 needs a web message leaf-key parity test before adding its subscription-state copy.

9. THE PRICING VISUAL CONTRACT DOES NOT FULL-PAGE CHECK SPANISH

EVIDENCE: Ordinary public-page screenshots are viewport-only at `apps/lander/tests/visual/public-pages.spec.ts:124-131`. Full-page no-JS coverage includes `/pricing` but not `/es/pricing` at `apps/lander/tests/visual/public-visual-contract.ts:33-42`; the no-JS test is the full-page capture at `apps/lander/tests/visual/public-no-js.spec.ts:14-31`.

WHY IT BITES: The Spanish fold is covered, but the expanded tier rules, reset/overage explanation, sample bill, FAQ, and final CTA below it can overflow or retain contradictory content without full-page Spanish evidence.

WHAT IT CHANGES: Slice 10’s “English and Spanish, desktop and mobile” gate needs `/es/pricing` full-page coverage or a dedicated lower-page assertion.

10. THE MODEL-GATEWAY TEST CLAIMING “EVERY POLICY BLOCK” EXERCISES ONLY ONE BILLING BLOCK

EVIDENCE: `apps/model-gateway/src/index.test.ts:434-476` names exhaustive policy coverage but supplies only `insufficient_credits`; it does not enumerate `monthly_cap`, `subscription_inactive`, `payment_required`, or the new `subscription_required`. Runtime handling itself is generic and clean through `gatewayBlockResponse` at `packages/contract/src/gateway/index.ts:158-166`.

WHY IT BITES: Adding the new block can leave gateway-specific body/header expectations unpinned while the purported exhaustive test remains green. The shared runtime helper reduces implementation risk, but the client-facing contract test does not prove the new 402 envelope.

WHAT IT CHANGES: Slice 06 should make this table genuinely exhaustive over all `GatewayBlockSchema` billing members.

Clean finding: no prior implementation or reverted attempt for `createSubscriptionCheckout`, recurring price envs, or `SUBSCRIPTION_PLANS` exists outside the new spec; the current path is the older setup/topup billing rail, not a half-built subscription rail.

Coverage: swept root/spec READMEs; `packages/backend/src/{billing,credits,credits-shared,model-gateway,auth-workspaces}.test.ts`; billing/user/internal-admin backend domains and fixtures; API billing routes/tests; web client, root, settings, playground, i18n, and admin surfaces; model-gateway tests/runtime; `packages/test-harness/src/staging-e2e-synthetic*`, `apps-live`, `demo-60s`; lander copy/config/checkers/content/pricing/visual contracts; and `apps/docs/app/billing`.