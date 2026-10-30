# Stage-4 landmine register — BINDING on the slices it names

Swept 2026-07-17 by three sector sweeps (full cards with evidence in
`assets/sweep-{a,b,c}-*.md`; top claims spot-verified against the code).
Every entry below is an obligation on its owning slice: the slice is not
done while its entries are unaddressed. Entries marked **OPEN** awaited
Example User and are now resolved in "Resolved forks" at the bottom unless still
marked open.

## The pause seam is much wider than servicingStatus (D8 consequences)

- **L1 · Idle retirement kills paused workspaces forever** — hourly cron
  retires any lifecycle-active workspace idle > 7 days regardless of
  servicing; `retired` is terminal and a later paid invoice cannot undo it;
  candidate selection has a TOCTOU window (no recheck at commit).
  *(slice 07; policy fork F1 below; staging leg in 12)*
- **L2 · Pause does not close the data plane** — slug-based
  `gatewayConnectionBySlugImpl` ignores `servicingStatus` (verified:
  `vmToken.ts:26-45` — only the VM-token variant checks it), and the API
  caches resolutions for 15s. Files/apps/sync/train/agent gateway routes
  stay reachable after the flip. *(slice 07: add servicing to slug
  resolution + accept/document the ≤15s cache bound; fork F2)*
- **L3 · Mid-run agent sessions orphan on pause** — local runners keep
  executing; their canonical/terminal relay 401s; backend session sticks in
  `running`/`ask`. *(slice 07 + 11; fork F2)*
- **L4 · Paused VMs keep applying sync state** — vm-sync token lookup
  rejects only deleted/retired; anchors/apps/share directives keep flowing
  and converging. *(slice 07; fork F2)*
- **L5 · `updates.paused` is the global release-rollout switch** — never
  reuse it for D8; per-workspace directive needs its own name if the VM
  must change behavior. *(slices 00/07 — naming firewall)*
- **L6 · Provisioning ignores servicing** — a lapse mid-provision still
  creates the VM, completes registration, mints VM model credentials
  (attach/registration/apiKeys check lifecycle only). *(slice 07: define
  hold-or-finish-paused; test lapse at each provisioning stage in 12)*
- **L7 · Edge cache serves paused apps ≤30s** — `max-age=30, s-maxage=30`
  on publish responses; a warmed cache outlives the "immediate" pause.
  *(slice 11: accept + document the bound; staging 12 tests warmed cache)*
- **L8 · Edge resolution erases the paused reason** — resolver 403s
  collapse to generic `forbidden` (body unread, pinned by test); the
  branded paused page needs a typed paused result on the resolve contract,
  distinct from suspension/authorization. *(slice 11)*

## Reconciler completeness (D8 trigger set)

- **L9 · Billing-user reassignment** (`setBillingUser` patches only the
  payer) must run the reconciler in the same mutation, both directions.
  *(slice 07)*
- **L10 · Workspace birth defaults to active** — new rows omit
  `servicingStatus`; a lapsed-but-`firstPaidAt` payer can birth a fresh
  active workspace that provisions a VM. Birth must write the computed
  servicing state atomically. *(slice 07)*
- **L11 · Admin credit adjustments/bulk resets can cross entitlement**
  without any reconciliation hook — wallet commands that can flip
  entitlement schedule the reconciler, including internal-admin paths.
  *(slices 06/07)*
- **L12 · Internal-admin is a competing servicingStatus writer** with no
  provenance — manual pause is indistinguishable from billing pause and
  renewal silently undoes it; manual activate re-pauses at next sweep.
  *(slice 07 + internal-admin contract; fork F3)*
- **L13 · Rate limiting runs before entitlement** in the service proxy
  (429 masks the 402 and never schedules the pause; ordering pinned by
  test) — entitlement evaluates first on every charged adapter; the pinned
  ordering test changes intentionally. *(slice 06)*

## Policy consumers and leaks

- **L14 · `firstPaidAt` grants the 10× service-proxy rate tier forever** —
  switch the rate-tier input to `isSubscriberAt`; paid-model access stays
  historical per D2. *(slices 05/06; resolved fork F4)*
- **L15 · Session query leaks `user.billing` wholesale** — adding
  `billing.subscription` exposes Stripe ids/lifecycle fields to every
  browser session; `users/queries:current` needs an allow-list projection
  + a test rejecting nested Stripe fields. *(slices 05/08)*
- **L16 · Disputes need an admin resolution contract** — a
  `disputeFlaggedAt` marker with no clear operation makes the D11 pause
  irreversible; add account-level dispute projection + audited clear to
  internal-admin. *(slices 05/07)*
- **L17 · Wall state must come from the workspace payer, not the viewer**
  — shared workspaces: an entitled viewer of a lapsed payer's workspace
  must see the paused state (non-payer copy: "contact the owner"), and a
  lapsed member must NOT be walled out of an entitled payer's workspace.
  Derive from workspace servicing + payer identity (`listMine` already
  projects both). *(slice 11 — decided, no fork)*

## Cutover blast radius

- **L18 · No entitlement poll in an open tab** — the SPA root query has no
  refetchInterval; the wall/toast can stay absent indefinitely. Slice 11
  owns a root-level entitlement polling contract. *(slice 11)*
- **L19 · Lander's `TRIAL_CREDIT_USD = 10` is a hand-rolled duplicate**
  whose comment claims derivation; delete or pin by equality test before
  D10 changes the amount. *(slice 10)*
- **L20 · `check-product-copy` is blind to billing claims** — stale "$10
  trial", "pay-as-you-go", "no subscription required" claims live in
  guides/blog content the checker passes; slice 10 adds billing
  forbidden-claim rules and sweeps ALL lander content, not just the
  pricing page.
- **L21 · Staging seeds a stray hardcoded $10 grant** (`staging-e2e-synthetic`)
  on top of the real trial — the lifecycle account must be isolated or the
  grant removed, else trial-exhaustion legs are false positives.
  *(slice 12)*
- **L22 · The "billing" live leg is setup-mode only** — there is no
  existing topup acceptance to preserve; slice 12 builds subscription
  Checkout + an explicit post-subscription topup leg, and extends the
  resource ledger to clocks/subscriptions/schedules/invoices before
  creating any.
- **L23 · Future-clock tests will all hit `subscription_required`** —
  2032/2035 timestamps in credits tests outlive any trial window; slices
  02/06 ship entitlement-aware fixture builders + a side-effect-free
  balance reader (the current `balance()` helper calls preflight, which
  would schedule pauses from inside tests).
- **L24 · `markCurrentUserPaidForTest` fixtures become non-entitled** —
  replace with explicit trial / synthetic-subscription fixtures; never
  weaken production entitlement to keep old fixtures green. *(slices 05/06)*
- **L25 · Internal-admin balance becomes paid-reserve-only after D7** —
  admin contract must expose both buckets explicitly. *(slice 02)*
- **L26 · Web has no i18n leaf-key parity check** (lander does) — add one
  before slice 09's new keys.
- **L27 · `/es/pricing` has no full-page visual coverage** — slice 10's
  gate includes it.
- **L28 · The model-gateway "every policy block" test covers one block** —
  slice 06 makes it exhaustive over all GatewayBlockSchema billing members.

## Shared Stripe account (L29 — raised by Example User post-walk)

- **L29 · The Stripe account hosts other apps; customers may overlap** —
  binding invariant (slices 04/05, README firewall): for grants and
  lifecycle, provenance (recognized price id, plus our subscription
  metadata as defense-in-depth) before ANY effect; foreign events silently
  ignored + marked processed; provisioner additive-only, never account
  defaults/branding. **Deliberate exception (Example User):** disputes are
  customer-scoped on purpose — a dispute on ANY charge (even another
  app's) by a customer mapped to a Duet user flags + pauses that account.
  Slice-05 tests: another app's invoice.paid and subscription lifecycle
  are no-ops; a foreign-charge dispute for a mapped customer DOES pause.
- **L30 · `STRIPE_WEBHOOK_SECRET` is currently a placeholder** — no *Duet*
  webhook endpoint exists yet (Example User), but the other app's endpoints DO
  exist on the account. The slice-04 provisioner creates a new endpoint at
  exactly Duet's URL and captures the signing secret at creation (the only
  time Stripe returns it); placeholder-secret + existing-endpoint-at-Duet's-URL
  → delete that one and recreate to rotate. Endpoints at any other URL are
  never listed for modification, edited, or deleted. Note the other app's
  endpoint independently receives its own event types — creating ours
  changes nothing for it. Until slice 04 runs on staging, nothing real is
  arriving at the webhook route — the live topup webhook path is
  effectively unexercised in deployed staging, so slice 12's legs are the
  first true end-to-end proof of the whole webhook rail, not just the
  subscription parts.

- **L31 · chat-app also stamps `source: 'duet'` on this account** — its
  topup invoices carry `{source:'duet', type:'credit_topup*',
  organizationId}` (`../chat-app/.../services/stripe.ts:479-483`), so
  source+type metadata alone CANNOT discriminate the two apps. The apps
  are mutually safe by field presence only (`organizationId` = chat-app;
  `workspaceId`+`userId` = v2) — deliberate, documented in slice 04b, and
  pinned by a real chat-app invoice fixture normalizing to not-ours.
  **Superseded 2026-07-20 (Example User):** the `organizationId` *exclusion* was
  removed; provenance is now positive-id only (`source:'duet'` + `userId` +
  (`type:'subscription'` | `workspaceId`); topups require `workspaceId`). See
  the README "Provenance" reason bullet for the current contract. Safe because
  Duet is the only app issuing subscriptions on this account, so
  `type:'subscription'` is itself Duet-exclusive.

## Post-build follow-ups (found live)

- **L32 · Gateway archive 500s on a never-written workspace** — the VM
  gateway's `tarWorkspaceState` tars the drive dir unconditionally; a
  workspace whose drive was never written 500s the archive (observed live:
  admin archive-now on a fresh fixture). Harness seeds a file as a
  workaround (fix8); FIXED in-branch (fix9): tarWorkspaceState treats
  absent drive/state dirs as valid empty contributions (repro'd locally:
  `tar: state: Cannot stat`); ships with the API deploy per the
  one-release-operation rail. Pre-existing bug — the idle-retirement rail
  would have hit it on any never-used workspace.

## Resolved forks (F1–F4, all closed 2026-07-17)

- **F0 (slice-04 kill) — D1 flipped to first-party plan changes**: Stripe
  Portal rejects multiple same-interval prices per product
  (assets/stripe-portal-d1-report.json). Upgrade grants still ride
  invoice.paid via always_invoice proration — the single grant door
  survives the flip. Portal narrowed to payment-method + invoices.

- **F1 (L1) — archive after 7 days paused, resurrect on resubscribe**
  (Example User). Pause keeps the VM at first; a workspace continuously paused
  for 7 days is archived via the existing archive rail and its VM torn
  down — landing in a **resumable** state, never terminal `retired`.
  Resubscribing reprovisions from the archive. The idle-retirement path
  becomes servicing-aware and rechecks state at commit (closes the TOCTOU
  window).
- **F2 (L2/L3/L4/L7) — full stop** (Example User). On pause: slug resolution
  refuses paused workspaces (data plane closed — files/apps/sync/train),
  agent sessions are cleanly interrupted and terminalized, VM sync narrows
  to a quiesce directive for paused workspaces, and the ≤15s API
  resolution cache + ≤30s edge cache are the accepted, documented
  propagation bound on "immediate".
- **F3 (L12) — pause is fully automated; admin never touches it** (Example User).
  Direct `active`/`paused` writes leave the internal-admin contract. The
  admin levers are: **ban** — which now inherits the same 7-day archive
  logic as pause (banned 7 days → archive + teardown, non-resumable by the
  user) — plus direct "archive VM now" and "delete VM now" operations.
  The reconciler's rule simplifies to: banned → never active; else
  entitlement decides.
- **F4 (L14) — rate tier follows current subscription:** decided
  (decide-and-inform): `isSubscriberAt` drives the service-proxy rate
  tier; `firstPaidAt` keeps only paid-model access + workspace-count
  meanings per D2.
