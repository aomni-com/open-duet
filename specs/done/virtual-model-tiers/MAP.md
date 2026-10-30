# Virtual Model Tiers — quadrant map

Walked 2026-07-27 (explore-unknowns). Feature: the models presented to users
become duet-agent's three **virtual tiers** — `frontier` / `balanced` /
`economy` (user-facing: **Max / Standard / Lite**) — replacing the role-based
model catalog everywhere users touch it. Sessions run router-based
(`duet --model <tier>`); billing charges flat per-tier token rates.

> **SUPERSEDED for build purposes (2026-07-27):** the implementation plan
> lives in [README.md](README.md) + [slices/](slices/), synthesized from
> three independent drafts after a spec interview that revised two map
> decisions (rates → cost-covering; rollout → hard cutover) and corrected
> three map claims (Q2#13 switching, birth.ts semantics, headerless
> fallback). This map remains the decision record; where build detail here
> conflicts with the slices, the slices win.

---

## Q1 — Known knowns (territory facts, cited)

**duet-agent already ships the whole router.** v0.3.5 `--model` accepts
"Virtual tier (frontier|balanced|economy) or concrete model pin"
(`duet-agent/src/cli/help.ts:40`). `BUILT_IN_ROUTING_TABLE`
(`src/model-routing/table.ts:222`) defines per-tier routes
(visual/plan/implement/writing/general) with thinking levels, advisor policy,
vision fallbacks, and a luna classifier re-routing every 5 steps. Tier flips
mid-session work via the inline `/model` machinery.

**The product pins concrete models end-to-end today:**

- Picker: `apps/web/spa/routes/sessions.tsx:115` builds options from
  `visibleModels(APPROVED_MODELS, 'chat')`; default role `'recommended'`
  (`packages/contract/src/approved-models/data.ts:4`).
- Contract: role enum rides `AgentStartSessionRequest.model` /
  `AgentMessageRequest.model` (`contract/src/agent/index.ts:760`) and
  `WorkspaceDefaultModelRequestSchema` (`workspaces/index.ts:114`).
- Backend: resolution chain `requested ?? sessionLast ?? workspaceDefault ??
  DEFAULT_CHAT_MODEL_ROLE` (`backend/convex/domains/agentSessions/delivery.ts:836`);
  role ids are **persisted** (`lastModelId`, per-input `resolvedModelId`).
- API: `apps/api/src/agent-runner.ts:414` resolves role → one concrete
  `gatewayModelId`, sent as `launch.gatewayModelId` per input.
- VM gateway: model is a flippable session parameter
  (`packages/gateway/src/agent-sessions/ledger.ts:652`); spawns
  `duet --rpc --model duet:<gatewayModelId>` (`runner/process-runner.ts:303`)
  — a hard pin bypassing the router.
- Enforcement: model-gateway inspects the concrete model per request
  (`apps/model-gateway/src/request-inspection.ts`); backend preflight
  (`backend/convex/domains/modelGateway/preflight.ts:82`) runs
  `evaluateModelAccess` (allow-list + paidOnly) with a workspace-scoped key —
  **no session identity rides requests today** (agent transport sends only
  `Authorization`, `duet-agent/src/model-resolution/model-gateway.ts:63`).
- Billing today is **upstream-reported actual cost**
  (`modelGateway/actions.ts:54`, `dollarsToMicroUsd(result.info.total_cost)`);
  catalog `pricing` fields are display-only.

**Tier-target coverage vs the approved catalog:** fable, sol, terra, opus-5,
sonnet-5, luna, glm-5.2 are approved; **kimi (`moonshotai/kimi-k3`) is not**
— see landmine L1.

## Q2 — Known unknowns (decision ledger — all closed unless marked OPEN)

| # | Question | Decision | Closed by |
|---|---|---|---|
| 1 | Tier representation | **Tier-native launch**: contract + api→gateway launch carry the tier id; process-runner spawns bare `duet --model <tier>`; no concrete pin | Example User |
| 2 | Model definitions | Role-based catalog **dies as a user-facing concept**; everything router-based | Example User |
| 3 | Tier gating | **frontier + balanced paid-only; economy is the free tier** | Example User |
| 4 | Catalog fate | Concrete-model list survives **only** as gateway allow-list + paidOnly gate; presentation (pricing/scores/names) moves to tier entries; add `moonshotai/kimi-k3` | Example User |
| 5 | Fee shape | **Per-tier token rates** (input/output/cached per 1M) regardless of underlying model; upstream real cost kept as margin metadata | Example User |
| 6 | Billing attribution | **`x-duet-tier` header** sent by duet-agent on every gateway call; gateway validates claimed tier's route closure contains the requested model, fail closed | Example User |
| 7 | Legacy stored ids | **Reject-and-default**: unaccepted id → workspace default tier; no Convex migration | Example User |
| 8 | Defaults | Free → economy, paid → **balanced**; frontier is an explicit pick | Example User |
| 9 | Economy metering | **Metered at tier rate for everyone**; glm loses `isFree`; trial credits are the free-tier abuse limiter | Example User |
| 10 | Paid-gate signal | **Active subscription** (`isSubscriberAt` / authorizeSpend rail). Broadened mid-walk: `firstPaidAt` is retired as a gating signal **product-wide** — `evaluateModelAccess` (incl. paidOnly media models) moves to subscription entitlement; the field may persist as bookkeeping only. Churned users clamp to economy with a notice | Example User |
| 11 | Tier names | User-facing **Max / Standard / Lite**; internal ids stay frontier/balanced/economy | Example User |
| 12 | Rollout sequencing | **REVISED at spec interview (2026-07-27): hard cutover.** No dual-shape launch compat, no deploy-order dance: agent release + image rebuild land first as plain prerequisites, then gateway/api/web flip together; stale VMs fail sessions until the self-heal rail catches them. Header-less billing fallback only as long as needed for the same window | Example User |
| 13 | Mid-session switching | Stays — **CORRECTED during spec drafting:** the map overstated current behavior; live prompt commands carry no model (`coordinator.ts:1103-1121`), so switching is relaunch-only today. The agent release adds an RPC per-prompt tier (slice 02) and the gateway sends it (slice 09), upgrading switching to next-prompt fidelity | decide-and-inform, unobjected |

~~OPEN: actual tier rates~~ CLOSED at spec interview, then **REVISED at
synthesis (2026-07-27, Example User): cost-covering rates** — frontier $10 / $50 /
$1, balanced $5 / $30 / $0.50, economy $1.50 / $6.50 / $0.15 per 1M
in/out/cached. Why: the interview rates (mirroring opus/terra/luna catalog
entries) sat below verified upstream cost on several routes — economy ~4×
under luna's real $1/$6 (the catalog luna entry was a placeholder), Max 2×
under fable's $10/$50. Each tier's rate now covers its most expensive route.

| 14 | Churned subscribers | **Keep the pause lifecycle** (Example User, synthesis
2026-07-27): lapsed subscription → workspace paused → blocked, exactly as
today; the economy clamp applies only to serviceable non-subscribers
(trial/never-paid). The alternative (churned-with-credits ride Lite) was
rejected as a billing-lifecycle rework riding along. |
| 15 | Tier-list ownership | **Hardcode duet-agent's three default tiers**
(Example User, 2026-07-29, superseding both earlier directions). The agent stamps
only an opaque `x-duet-tier` (0.3.6); duet's `MODEL_TIERS` hardcodes the
matching closures and is updated by hand if the agent's built-in table ever
changes. Rejected along the way: an agent-side closure export/tier enum
(made the agent own a list it merely receives — PR #86 closed), and
duet-seeding the table onto VMs (machinery the simple version doesn't
need). |

## Q3 — Unknown knowns (extracted, and what each reshaped)

- **Flat-fee product framing**: users buy an outcome level, not a model — the
  set usage fee "regardless of what it costs under the hood" is the product.
  Killed per-model pricing display entirely.
- **Picker is a quality slider** (direction D): one control, three stops —
  not a model menu. **With a hover tooltip disclosing the exact models each
  tier routes to** (added mid-walk) — tiers are opaque *per step* (no
  "Fable answered this" attribution) but transparent *in the picker*.
- **Naming taste**: Max / Standard / Lite; "Economy" reads too cheap,
  "Frontier" too jargony for users.
- **Lander updates ride in the same effort** (pricing/marketing pages
  reference the old model story, e.g. `apps/lander/lib/public-site-config.ts`).
- **Workspace default-tier card wanted** — note: contract schema exists but
  **no settings-card UI exists today** (swept `apps/web/spa`); this is
  net-new UI, not a port.
- **Locked tiers stay visible** to free users with an upgrade CTA.

## Q4 — Unknown unknowns (landmine cards)

1. **L1 — kimi unapproved** (`moonshotai/kimi-k3`, frontier/balanced visual
   route target; absent from `approved-models/data.ts`) → mid-session 403 on
   visual work. **Decided:** add to allow-list (Q2#4).
2. **L2 — fable is paidOnly** and targeted by frontier plan/advisor →
   free-user 403 mid-session. **Decided:** whole tiers are paid-gated (Q2#3)
   on active subscription (Q2#10).
3. **L3 — 1-role→1-model assumption is load-bearing**: `ApprovedModel`
   requires a single `gatewayModelId`+pricing; old deployed gateways validate
   `nonEmptyString(launchRecord.gatewayModelId)` (`ledger.ts:536`).
   **Decided:** tier-native launch + three-phase rollout (Q2#1, #12).
   `mergedLaunch` keeps unknown keys (newer-gateway fields survive older
   rewrites) — helpful during skew.
4. **isFree short-circuits billing** (`preflight.ts:90`): glm generations
   would never reach the ledger. **Decided:** economy metered; strip `isFree`
   (Q2#9).
5. **Two paid signals conflict**: `firstPaidAt` (ever-paid) vs active
   subscription. **Decided:** active subscription (Q2#10).
6. **Sharp edge — tier metadata needs a product-side source of truth.** The
   routing table lives in duet-agent; the product needs tier→model closures
   for (a) the slider tooltip, (b) gateway `x-duet-tier` validation, (c)
   deriving paidOnly defense-in-depth. Recommendation: one contract-owned
   tier-definition module (names, rates, scores, route closure) + a drift
   check against duet-agent's table (probe-slice precedent from
   connected-providers).
7. **Sharp edge — cutover breaks in-flight retries/dedup.** Duplicate
   detection compares `resolvedModelId` to the client's expected value
   (`delivery.ts:525`); web retry payloads carry model ids. Retries spanning
   the deploy will mismatch once, then recover. Accepted transient.
8. **Sharp edge — pinned agent/image version.** The VM image pins an older
   agent (connected-providers-era 0.3.x); tier-header billing needs a new
   agent release + image rebuild + fleet heal BEFORE the api flips (rollout
   phase 1). Confirm the pinned version actually resolves bare tier names.
9. **Sharp edge — visual-test churn.** `apps/web/tests/visual/playground.spec.ts`
   asserts the model menu (`compose-bar-model-menu.png`, role fixtures
   `'recommended'`/`'balanced'`/`'deep'`, `data-model-provider` attributes) —
   slider rework = fixture + baseline churn; ui-playground gate mandatory.
10. **Sharp edge — i18n**: slider/tooltip/upgrade-CTA copy lands in
    `apps/web/messages/en/app.json` + `es-419/app.json`.
11. **Sharp edge — usage page vocabulary**: ledger metadata keeps concrete
    model + upstream cost (margin tracking) but user-facing usage should
    speak tiers; concrete models remain in metadata only.

## Facts the builder must confirm before coding

- The image-pinned duet-agent version resolves `--model frontier` bare (and
  if not, the release/rebuild ordering in Q2#12 covers it).
- Bare tier spawn resolves concrete targets through the duet-gateway provider
  when only `DUET_API_KEY`/gateway env is present (PROVIDER_ORDER says yes —
  verify once on a real VM).
- The `x-duet-tier` header passes the Vercel gateway proxy untouched (it
  only needs to reach model-gateway, which strips/uses it — verify it isn't
  forwarded upstream in a way any provider rejects).
- Exact tier→model closure derivation: routes + advisor targets + classifier
  + vision fallbacks + memory models (memory/embedding ride every session).
- demo-60s harness + staging journeys touching model ids
  (`packages/test-harness/src/demo-60s.ts`, `staging-e2e-synthetic`).
- ~~`firstPaidAt` gate sites beyond model access~~ **RESOLVED during spec
  drafting:** `birth.ts:82` is NOT trial-skip — it is the second-workspace
  gate (ever-paid owners may hold >1 live workspace); trial granting lives
  in `credits/grants.ts` and is idempotent by canonical email. Decisions:
  birth gate → `isSubscriberAt`; the internal-admin "never paid" cohort →
  `subscriptionEverActivatedAt` (historical meaning preserved). Owned by
  slice 05.

## Tweakable plan (sorted by likelihood-of-tweaking)

> **Superseded** by [README.md](README.md) + [slices/](slices/) — kept for
> the record of how the walk sorted the work; do not build from this
> section. Known-stale bits: "gateway accepts both shapes" (overturned by
> the hard-cutover decision), the headerless billing fallback (fail-closed
> now, with an internal-model exception — slice 06), and the original
> suggested slice ladder (replaced by the 00–14 ladder).

**Judgment calls (alternatives still swappable):**
- Tier rates (OPEN) and whether frontier/balanced share a price.
- Slider + tooltip presentation details; upgrade-CTA copy; Max/Standard/Lite
  final spellings.
- Clamp-notice wording when a paid tier falls back to economy.
- Shape of the contract tier-definition module (and how the drift check runs).

**Mechanical (trusted):**
- duet-agent: `x-duet-tier` header on gateway transport; release + image pin.
- Contract: tier module (ids, names, rates, scores, closure); chat roles
  deleted; media/internal roles untouched; kimi allow-list entry; strip
  `isFree` from glm; catalog slims to allow/paid gate.
- Backend: delivery chain speaks tiers (reject-and-default); preflight
  validates tier header + entitlement (active subscription); settlement
  prices tokens at tier rates, records upstream cost as metadata; retire
  `firstPaidAt` from all gating (evaluateModelAccess signature, birth.ts
  trial-skip, admin filter) — field survives as bookkeeping.
- API/gateway: launch carries tier; gateway accepts both shapes; spawn
  `duet --model <tier>`.
- Web: slider picker + tooltip; default-tier settings card (net-new);
  locked-stop upgrade CTA; i18n; visual fixtures/baselines.
- Lander: pricing/marketing copy to the tier story.
- Test-harness: staging journey for tier session + tier-billed ledger entry;
  register in `staging-e2e-synthetic`.

**Suggested slice ladder** (two-repo, agent first, mirrors
connected-providers): 00 probe (pinned agent resolves bare tiers; header
passthrough) → 01 contract tier module + drift check → 02 agent tier header +
release → 03 gateway dual-shape launch + bare-tier spawn → 04 backend tier
resolution + entitlement clamp → 05 billing (header validation + tier-rate
settlement) → 06 web slider + tooltip + settings card → 07 lander → 08
staging e2e journey.
