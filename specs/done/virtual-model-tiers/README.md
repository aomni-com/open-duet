# Virtual Model Tiers — rationale record

Shipped to staging and production 2026-07-31. Users pick one of three virtual
tiers — internal ids `frontier | balanced | economy`, shown as **Max /
Standard / Lite** — on a three-stop quality slider. A session spawns
`duet --model <tier>`; duet-agent's built-in router picks concrete models per
task and re-classifies as the work changes. Billing charges flat per-tier
token rates regardless of which model answered. The role-based chat-model
catalog no longer exists as a user-facing concept.

Companion records in this folder: [MAP.md](MAP.md) (the quadrant-walk
decision ledger — every product decision with who closed it),
[PROBE.md](PROBE.md) (the measured facts), [choices.md](choices.md) (every
call made where the spec was silent, with verdicts),
[E2E-HANDOFF.md](E2E-HANDOFF.md) (the live-journey acceptance guide; the
journey run is owned by a separate session and was the one gate outstanding
when this closed, at Example User's direction).

## Why it works this way

**Tiers, not models, are the product.** A user buys an outcome level with a
predictable price, not a model name. That single framing drove everything:
the picker is a slider rather than a menu, per-step model attribution is
deliberately hidden (the slider tooltip discloses each tier's model set
instead), and rates are flat per tier even though the router mixes models of
very different cost underneath.

**The tier list is hardcoded in duet, opaque to the agent.** The agent reads
its routing table from config that can change any time, so making it export a
tier enum would have made it own a list it merely receives — that shape
shipped as duet-agent PR #86 and was closed as wrong (history in that repo and in MAP.md #15). The inverse (duet
seeding the routing table onto VMs) was also rejected as machinery the simple
version doesn't need. What survived: the agent stamps whatever tier name it
is routing under as an opaque `x-duet-tier` header (`@duetso/agent` 0.3.6+,
PR #87); duet's `MODEL_TIERS` hardcodes the three default tiers' closures and
is updated by hand if the agent's built-in table ever changes. That manual
sync is the entire coupling, on purpose (MAP #15).

**Rates are cost-covering per input/output/cache-read leg against each
tier's most expensive route** (earlier proposals, recorded in MAP.md, sat up
to 4x under verified upstream prices — the luna "price" they mirrored was a
placeholder). Final rates: Max $10/$50/$1, Standard $5/$30/$0.50, Lite
$1.50/$6.50/$0.15 per 1M input/output/cached-input. Known negative leg,
accepted: cache-WRITE tokens bill at the input rate, and fable/sol charge a
1.25x write premium upstream ($12.50 vs Max's $10; $6.25 vs Standard's $5) —
writes happen once while reads repay at ~10x margin, and per-generation
margin is measurable because upstream real cost is retained privately
(`upstreamCostMicroUsd`).

**Token counts are disjoint — measured, not assumed.** Vercel's generation
record reports prompt, cache-read, and cache-write counts as non-overlapping
(a live cache-read call showed `tokens_prompt: 2` beside
`native_tokens_cached: 11974`; PROBE.md probe (a)). The docs are silent on
this, and the initially-shipped subtractive normalization would have parked
every multi-turn generation as unbillable. Cache-writes bill at the input
rate (their 1.25x upstream premium sits inside the ~2x tier margin) — the
one pricing judgment call made without Example User, recorded in choices.md.

**Hard cutover, no compatibility.** No dual launch shapes, no headerless
billing fallback for routed traffic, no Convex migrations. Stale VM-local
session envelopes in the old shape are quarantined and the session recreated
from the backend's durable delivery. Legacy stored ids (`recommended`,
`fast`, ...) are rejected at parse and fall to the workspace default.
Historical staging rows that violated the new generation-metadata schema were
deleted outright (`convex import --replace`, Example User's call) rather than
tolerated by a widened validator; prod had no such rows.

**Entitlement is live subscription, product-wide.** `firstPaidAt` (ever-paid)
was retired as a gating signal everywhere in the same effort — live gates use
`isSubscriberAt`, historical cohort queries use
`subscriptionEverActivatedAt`, and the stamp survives only as bookkeeping
(a firewall test enforces this). Each plan defaults to its own tier:
$20 starter -> economy, $50 pro -> balanced, $200 max -> frontier; defaults
only — any active subscriber may pick any tier.

## Invariants (violating any of these silently breaks the product)

| Invariant | Enforced by |
|---|---|
| One owner for tier facts: ids, labels, rates, closures, pricing math | `packages/contract/src/model-tiers/` by convention (no automated firewall); the lander's derivation is test-pinned to exactly three contract-sourced rows |
| Money math is exact | `priceTierUsageMicroUsd`: integer nanoUSD-per-token via BigInt, ONE rounding on the final total; rates limited to three decimals by test |
| Billing attribution fails closed | `apps/model-gateway/src/tier-attribution.ts`, parsed once into the inspected request; a claimed tier whose closure lacks the model -> `403 tier_not_allowed`, no generation row. Sole exception: catalog entries flagged `internal` (memory/embedding) may run headerless and bill legacy — background jobs have no session tier |
| The attribution header never reaches upstream | `x-duet-tier` in `STRIPPED_UPSTREAM_REQUEST_HEADERS`; a permanent test asserts the upstream mock never sees it |
| Customer charge and upstream cost are structurally separate | `billedCostMicroUsd` (ledger debit) vs `upstreamCostMicroUsd` (private margin metadata); tier-less pre-cutover rows settled once via the legacy path |
| A tiered row missing token telemetry never settles at zero | parks as `charge_failed` |
| A `forwarding` row whose upstream id was never recorded cannot bill honestly | the sweep releases it after one hour, reason persisted on the row (`upstream_id_never_recorded`) — never billed, never invisible |
| Tier entitlement comes from the workspace's billing owner, never the viewer | `packages/backend/convex/domains/workspaces/tierPolicy.ts` |
| Session tier resolution: requested -> session-last -> workspace default -> plan default; invalid values skipped; invalid *requested* restarts at the workspace default; paid tiers clamp to economy for non-subscribers WITHOUT overwriting the stored preference | `resolveSessionTier` in `packages/backend/convex/domains/agentSessions/tier.ts`, pinned by its matrix test |
| The clamp is visible and idempotent | one durable `tier_clamped` timeline event per accepted input |
| A locked slider stop never changes the selection | activating it opens the upgrade path; playground locked-stop test |
| Schemas tolerate unknown fields | the retired `model` field is stripped, not rejected (repo-wide no-strict rule) |
| The launch wire requires `launch.tier` and nothing reads `gatewayModelId` | schemas stay tolerant, so an old writer's stray field rides along unread; the VM-local envelope parser rejects tier-less envelopes (quarantine + recreate) and the VM spawns a bare `duet --model <tier>` |

## Pointers into the code

- Tier facts + math: `packages/contract/src/model-tiers/index.ts`
  (`MODEL_TIERS`, `TierEntitlement`, `defaultTierFor`, `coerceStoredTier`,
  `clampTierToEntitlement`, `priceTierUsageMicroUsd`)
- Attribution: `apps/model-gateway/src/tier-attribution.ts`,
  `request-inspection.ts`; catalog slimmed to an enforcement list in
  `packages/contract/src/approved-models/` (media + `internal` entries keep
  role semantics for the mcp media tools via `modelByRole`)
- Usage normalization: `normalizeAiGatewayUsage` in
  `packages/backend/convex/services/aiGateway.ts`
- Settlement + sweep: `packages/backend/convex/domains/modelGateway/settlement.ts`
- Session resolution + clamp event:
  `packages/backend/convex/domains/agentSessions/delivery.ts`; workspace
  projection: `packages/backend/convex/domains/workspaces/tierPolicy.ts`
- Agent side (separate repo, github.com/Example User/duet-agent): `x-duet-tier`
  stamping in its `src/model-resolution/duet-gateway.ts` +
  `src/model-routing/active-tier.ts` — merged as PR #87, released 0.3.6
  (history lives in that repo; here it is vendored under
  `node_modules/@duetso/agent/dist`, pinned 0.3.7)
- UI: `packages/ui/src/components/quality-control.tsx` (product-independent
  slider), wiring in `apps/web/spa/routes/sessions.tsx` +
  `apps/web/spa/model-tiers/`, settings card in
  `apps/web/spa/settings/workspace-default-tier-card.tsx`
- Fleet rollout: the deployed api advertises the agent version from the
  repo's `@duetso/agent` pin (`apps/api/src/config.ts`,
  `DEFAULT_AGENT_VERSION`); VMs converge via the npm self-heal rail
  (~30 min end-to-end measured). The VM image bakes the pin at build
  (`packages/vm-image`), covering fresh provisions only.
- Acceptance: `packages/test-harness/src/staging-e2e-synthetic`
  (journey `virtual-model-tiers`), guide in [E2E-HANDOFF.md](E2E-HANDOFF.md)

## Dead ends (do not re-walk)

- **Agent-side tier enum + closure export + RPC tier + override clamp**
  (duet-agent PR #86): made the agent own the tier list. Closed; only the
  opaque header survived (PR #87).
- **Duet-seeded `~/.duet/models.json`** and a **closure drift test** against
  an agent export: both replaced by hardcoded closures (MAP #15). The drift
  test was also unimplementable — the agent package exports no routing table.
- **Subtractive cached-token math** (`prompt - cached`) with a
  disjoint-counts `charge_failed` guard: the guard was the tell — the
  "anomaly" it parked is the steady state of every multi-turn session.
- **`.strict()` request schemas**: violated the repo-wide tolerance rule;
  old clients sending the retired `model` field must degrade to the default
  tier, not error.
- **Widening the generation-metadata validator** to tolerate pre-tier rows:
  reverted same day; staging rows were deleted instead and prod had none.
- **Three-phase compatibility rollout** (dual-shape launch window): replaced
  by the hard cutover at the spec interview.

## Notable divergences from the plan

- Slice 03 existed in three successive forms (pin+drift test -> seed the
  routing table -> deleted entirely); the shipped design has no slice 03.
- PROBE (a)'s provisional undercharge-biased normalization was overturned by
  the live measurement and replaced wholesale.
- Plan-based defaults (starter/pro/max -> economy/balanced/frontier) were
  added post-spec by Example User, threading `plan` through the existing
  `TierEntitlement` chokepoint.
- The stranded-`forwarding` release and the persisted release reason were
  added at closeout, fixing a pre-existing (pre-tier) silent billing leak
  surfaced by the final adversarial review. Its sibling finding — a
  billing-owner change during reconciliation debits the new owner without
  re-running entitlement — Example User classified as an accepted edge case.
- Two staging tests merged in born-broken (an assertion on a column no code
  ever wrote; a revision count that raced async title attempts) — fixed here
  rather than skipped; details in choices.md.

## Visual provenance

No external baseline or inspiration imagery was uploaded for this feature.
The visual standard is the product's own playground baselines
(`apps/web/tests/visual/__screenshots__/**` — `sessions-quality-*`,
`settings-default-tier-*`, `sessions-list`), reviewed shot-by-shot during the
build (locked-stop padlocks, clamp notice, question-panel/slider
composition). The slider concept itself was chosen from four rendered
directions in the planning session (quiet tiers / transparent router / score
continuity / quality slider); Example User picked the slider with a
models-disclosure tooltip. That throwaway mock lived in session scratch and
was superseded by the shipped playground scenarios.

## Open at close

- **RUN 2026-07-31 — legs 1–4 PASS live, leg 5 (live tier switch) FAILS, and the
  journey can no longer reach leg 5 at all.** Full handoff:
  [`E2E-HANDOFF-2026-07-31.md`](E2E-HANDOFF-2026-07-31.md) — read it before the
  original handoff, two of whose claims it corrects. Evidence in
  [`assets/2026-07-31-live-run.md`](assets/2026-07-31-live-run.md).
  The handoff called a post-switch `balanced` attribution "a real regression,
  not flake", and it reproduced 2/2 times the leg was reached. Both hops inside
  this repo are proven correct by passing tests: the API puts the requested tier
  in `launch.tier` on a FOLLOW-UP message (`apps/api/src/index.test.ts`, "tiers
  resolve once per queued prompt"), and the gateway forwards it per-prompt to an
  already-running runner (`durablePromptCommand`,
  `packages/gateway/src/agent-sessions/coordinator.ts`) — but both are unit tests
  against a fake gateway and a fake runner, so they prove the wiring, not the live
  path. The unchecked suspect inside this repo is the coordinator's WAKE and
  `recoverCommands` branches, which launch from the LEDGER's stored
  `envelope.launch.tier` rather than the new request's. Leg 1 does not pin an
  agent version (it only asserts one is present) and staging runs **0.3.8**, so
  the earlier note here blaming 0.3.7 and calling for an agent release was
  unfounded.
- **The journey's earlier legs are load-flaky against live staging**: 2 of 4 runs
  died before leg 5 with "Standard session did not reach a terminal event" /
  "The operation timed out" — real-model turns, not tier logic.
- Ledger entry #2 in choices.md: the lander dropped its "900+ AI models"
  claim — one-file revert if it should be rescoped to media instead.
- Two pre-existing visual scenarios still race image decode
  (`settleImages()` in `playground.spec.ts` is the fix pattern).
