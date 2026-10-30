# E2E handoff — virtual model tiers on live staging

For the session running staging e2e. Written 2026-07-31, after the cutover
landed: staging deploys are green at `586177c4`, the active VM runs agent
0.3.7, prod is promoted (`main` at `90076e82`) with both env fanouts applied.

## The one command

```bash
bun run e2e:staging -- --journey virtual-model-tiers
```

The journey (`packages/test-harness/src/staging-e2e-synthetic`)
already asserts everything below — this doc tells you what each leg is FOR,
what "pass" must actually mean, and which failures are signal vs noise.

## What the feature is, in one breath

Users pick Max / Standard / Lite (internal: frontier / balanced / economy) on
a three-stop slider; the VM spawns `duet --model <tier>` and the agent's
router picks concrete models per task; every gateway call carries
`x-duet-tier`; billing charges flat per-tier token rates
(Max $10/$50/$1, Standard $5/$30/$0.50, Lite $1.50/$6.50/$0.15 per 1M
in/out/cached-in) regardless of which model answered; upstream real cost is
private margin metadata.

## The legs, and what each one proves

1. **Versions** — the workspace row must report `agentVersion: "0.3.7"`.
   0.3.5/0.3.6 means the fleet heal regressed; stop there, nothing else is
   meaningful.
2. **Subscriber default** — `defaultTier.access === 'all_tiers'`. NOTE: the
   *unconfigured* effective default is PLAN-DEPENDENT now ($20 starter →
   economy, $50 pro → balanced, $200 max → frontier), so the journey only
   sanity-checks the shape, then sets an explicit Standard default and reads
   it back. If the fixture account's plan changes someday, that's why the
   before-value moved.
3. **Routed session** — a Standard session produces a text completion AND a
   `gatewayGenerations` row with `tier: 'balanced'` and a concrete model
   inside balanced's closure (sonnet-5 / terra / sol / kimi / fable / luna /
   embedding). A row with a tier is the live proof the `x-duet-tier` header
   survived agent → gateway → backend.
4. **Billing math** — the journey INDEPENDENTLY recomputes
   tokens × Standard rates and requires the ledger debit to equal it
   exactly, and requires `upstreamCostMicroUsd` to be present AND a
   different number. If billed == upstream, settlement fell back to the old
   cost path — that is a hard fail even though money moved.
   Token semantics that make the math work: the generation record's counts
   are DISJOINT — cache-read tokens bill at the cached rate, cache-WRITE
   tokens are added to the uncached input leg. If the journey's recompute
   disagrees with the debit by roughly the cache-write tokens × input rate,
   suspect that normalization regressed (PROBE.md, probe (a)).
5. **Live tier switch** — flip the session to Max; the NEXT generation
   attributes `frontier`. Switching is applied per-prompt over RPC (agent
   0.3.7); a stale runner that keeps attributing balanced after the flip is
   a real regression, not flake.
6. **Free clamp** — the deterministic playground fixture: Max/Standard
   locked with padlocks but VISIBLE, activating one opens the upgrade CTA
   without changing selection, and the clamp notice text names the effective
   tier. (Deliberately not exercised against a real free Stripe account —
   backend tests own that matrix.)
7. **Forged mismatch** — a request claiming `x-duet-tier: economy` for a
   model outside economy's closure must get `403 tier_not_allowed` and
   create NO generation row. This is the billing-security boundary; treat
   any pass-through as a release blocker.
8. **Screenshots** — slider, settings default-tier card, usage tier badges,
   lander pricing. Two things nobody has visually reviewed yet, look at
   them like a human: the LANDER TIER CARDS (three cards, Max/Standard/Lite
   with the rates above — data is unit-tested but no eyeball has confirmed
   the render), and usage badges on a real settled row.
9. **Cleanup** — the journey ledgers and deletes everything it makes. If it
   aborts mid-run, sweep by BOTH convex deployments before deleting any VM
   (the exe.dev account is shared staging+prod — see the standing memory).

## Known sharp edges (don't misread these as tier failures)

- **Pre-existing, unrelated to tiers, found in final review** (both
  byte-identical on pre-tier `main`): (a) a routed call whose
  generation-id callback fails once stays `forwarding` forever and never
  bills — the recovery sweep only picks `reconciling`/`charge_failed`/
  `upstream_failed`; (b) if a workspace's billing owner changes while a
  generation is reconciling, settlement debits the NEW owner without
  re-running entitlement. If the journey trips either, it's this, not the
  cutover.
- **`packages/gateway` flake** — "a pause received while a CLI is
  downloading prevents activation" fails rarely in full-suite runs,
  ordering-dependent, npm-rail area, predates tiers.
- **Session e2e prompts now route by tier** — an economy-tier session runs
  luna/glm; if an unrelated journey asserts on response *quality/latency*
  from a default session, remember a starter-plan fixture account now
  defaults to economy, not the old terra pin.
- **Legacy ids are gone from the wire**: any harness code still sending
  `model: 'recommended'` (or any role id) is silently STRIPPED (tolerant
  schemas) and the session lands on the workspace/plan default; the launch
  wire rejects `gatewayModelId` outright — stale VM envelopes in that shape
  are quarantined and the session is recreated from durable delivery.
- **Staging's `gatewayGenerations` table was emptied 2026-07-30** (Example User's
  call, schema cutover) — do not expect any generation rows older than
  that.

## If it fails

File the evidence (journey artifacts + the failing leg) into
`specs/done/virtual-model-tiers/` and note it in that folder's README "Open
at close" list. The spec was closed at Example User's direction with this journey
as the one outstanding gate; everything else — code, deploys, image, envs,
prod — is done.
