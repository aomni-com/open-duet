# Agentic Onboarding

Rework workspace onboarding so it feels agentic and custom, and can be
completed **without typing a single character**: every step is tap-to-select
with a smart default already chosen. The user states a goal, answers one
tap-through follow-up, and an LLM recommends the four best official agents
for them — with reasons that echo their own words.

## Next Agent Prompt

**Status:** all eight slices merged, plus an unsliced polish pass — per-goal
Duet avatars revealed on tile hover, tap-to-advance on every single choice,
the answered-so-far recap replacing the question counter, a compact picker
card, and a playground that reads the real catalog when signed in. Last
updated 2026-08-10.

A canvas "goal backdrop" system was built during that pass and **deleted
again**; it is gone from the tree and from `assets/`. Do not resurrect it from
git history without reading why it lost: it was a second answer to the
question the avatars already answer, and the avatars are made of the
product's own character.

**Next pickup: the one live staging run — and it needs a human first.** The
journey (`packages/test-harness/src/staging-e2e-synthetic`,
registered as `agentic-onboarding`) is written and its selectors were
verified against the shipped components, but it has never run against a
deployment carrying this code. Once staging carries it:

    bun run e2e:staging -- --journey agentic-onboarding

It consumes real staging resources; run it once. It FAILS rather than falls
back if the recommendation rail never arrives — deliberately, because
silent-fallback-forever is the one regression the hermetic suites cannot
catch.

Before you start any slice, read this README fully, then the slice file.
Follow the repo's `write-tests` red/green flow for every behavior change, and
the `ui-playground` + `screenshot-critique` gates for every visual one. Run
the narrowest test runner while iterating; the root `bun run test` and the
staging journey run exactly once, in slice 08.

**Global TODO** (check off and re-date as you go):

- [x] 01 — recommender core + Convex action + REST endpoint (merged 6e90989f9)
- [x] 02 — `workspaces.purpose` column + write-once persistence (merged c765dd8c1)
- [x] 03 — goal catalog + purpose composition + copy, en & es-419 (merged 591663c1f)
- [x] 04 — seed the official catalog into the local e2e fixture (merged fa5d954c0)
- [x] 05 — step-graph rework, knowledge state deleted (merged 2a8118329)
- [x] 06 — wizard UI cutover: goal + follow-up steps, knowledge UI deleted, e2e rewritten (merged 0a6a55b58)
- [x] 07 — recommended rail on the team step + minimum-3 gate (merged d737aeed6)
- [x] 08 — staging journey authored + registered; local closeout done (merged; the single live run is the one thing outstanding)

**Before you end your pass:** update this section — status, next pickup,
warnings, checklist — so a fresh agent can resume from the README alone.

## The flow (end state)

```
identity → goal → follow-ups → team → ready
             │         │
             │         └ present only when a preset goal was picked
             └ "Write your own" stores typed text verbatim and skips follow-ups
```

- **identity** — unchanged. Names the assistant (`workspaces.duetName`).
- **goal** (new) — "What is your goal here?" Three preset tiles, each with a
  label and a one-line description, + a fourth "Write your own" tile that
  expands a textarea: `grow-business`, `launch-project`, `replace-software`.
  Three rather than six because the goal line barely discriminates at that
  width; the follow-ups carry the signal instead.
- **follow-ups** (new) — the picked goal's question: 3–5 chips with one
  pre-selected smart default and an optional "add detail" free-text field.
  One per goal, because the wizard is goal, question, team — so the survivor
  is the one that names something an agent can be pointed at (the job to take
  on, the part that is hardest, the thing being replaced) rather than the one
  that describes the person asking. Tapping Continue with no other input must
  produce a rich purpose — the no-typing guarantee is literally "the initial
  state is already a complete answer set." How many questions a goal asks is
  the catalog's to say: the reducer's clamp, the wizard's footer and every
  harness walk read it, and nothing writes it down a second time.
- The goal + answers compose into ONE plain-text paragraph — the **purpose**
  — stored as a single optional column `workspaces.purpose` (same table and
  mutation as `duetName`). One column, not two.
- **team** — kept, now recommendation-fed. The composed purpose goes to
  `POST /v1/ws/:slug/onboarding/recommendations`; an LLM picks the top 4
  official agents with a one-line personalized reason each. The plain
  verified catalog renders immediately; the "picked for you" rail hydrates
  when the response lands, and silently never appears on failure. The user
  must select **at least 3 agents** (any agents, not necessarily recommended)
  to continue.
- **ready** — kept. The celebration summary swaps its knowledge row for a
  purpose payoff (goal echo + team roster).
- **knowledge** — DELETED from onboarding (step, components, service call,
  copy). In-product Train is untouched.

## Decisions (settled — do not relitigate; alternatives recorded)

1. **No fallback recommender** (user-settled). LLM failure/timeout/invalid
   output ⇒ empty recommendations ⇒ the team step is today's plain catalog.
   That degradation is error handling, not a second recommender.
2. **The LLM call lives in Convex**, as a `'use node'` action copying
   `domains/campaigns/fitClassifier.ts` (structured output via
   `generateText` + `Output.object`, `gateway(model)`, injectable `generate`
   seam for hermetic tests) — platform-paid via the Convex env
   `AI_GATEWAY_API_KEY`, like session titles. NOT `apps/model-gateway`: that
   surface is for workspace-billed VM credentials and would charge the user
   for our onboarding.
3. **Exactly 4 or nothing.** After validating the LLM output against the
   verified catalog (drop fabricated/duplicate names), fewer than 4 survivors
   ⇒ empty response. A one-item "recommendation" reads as broken UI.
   (Alternatives considered: partial lists; a typed 503. Rejected for
   client-contract simplicity — one shape, one fallback.)
4. **Purpose composition is owned by the web app** (`onboarding-purpose.ts`),
   using the localized labels the user actually tapped —
   what-you-tapped-is-what-you-stored. The server transports and stores an
   opaque string; the LLM is told to answer in the purpose's language.
   (Alternative: contract-owned canonical English — rejected: it creates a
   second locale system.)
5. **Minimum-3 is client-only and fails open**: enforced only while the
   catalog is `ready` with ≥3 verified agents; on catalog error/thin catalog
   Continue stays enabled. A marketplace outage must not dead-end signup, and
   the server keeps accepting `skip`/fewer — the API-level staging journeys
   (`agent-naming`, `campaign-conversions`) depend on that.
6. **Campaign users keep goal + follow-ups and skip only `team`** (today's
   exact rule) — they never fire the recommendations call (no team step to
   feed). Rationale: purpose is the product's personalization input; a
   campaign cohort with permanently empty purposes would be the anomaly, and
   the cost is four taps. (Alternative: skip straight identity → ready —
   rejected; recorded because one draft argued it.)
7. **Write your own** stores the typed text verbatim (trimmed, clamped),
   skips follow-ups, and still gets recommendations.
8. **Endpoint guards**: `requireAuthedWorkspace`, owner-only, and
   `onboardedAt === undefined` — the endpoint exists only during the
   onboarding window, which also closes off the platform-paid LLM as a free
   general endpoint. No rate limiting now (`domains/shared/rateLimits.ts`
   exists if abuse ever shows).
9. **No server-side cache/idempotency.** The client memoizes by exact purpose
   string (back/forward navigation reuses; changed answers refetch).
10. **Request carries `purpose` + optional `tagHints`** (≤3, from the closed
    `AGENT_TAGS` vocab), computed client-side from the goal catalog — so the
    server never learns goal ids and the goal catalog keeps one owner.
    Hints are a soft prior in the prompt; agent summaries carry the load
    (several catalog agents have no tags at all).
11. **Hard cutover, no migrations, no compat shims.** `purpose` is optional;
    existing onboarded workspaces are untouched. The web/api deploy window
    degrades gracefully (old api strips the unknown `purpose` key and 404s
    the recommendations route; the client treats both as absent/empty).
12. **Model**: one constant beside the prompt, `openai/gpt-5.4-mini`,
    `temperature: 0`, `AbortSignal.timeout(10_000)`, one attempt, no retry.
13. **Analytics**: `onboarding.completed` gains a `goal` property
    (`<goalId> | 'custom' | 'none'`). Never send the full purpose text to
    analytics.

## Ownership map (one owner per concept — the refactor-clean invariants)

| Concept | Single owner |
|---|---|
| Goal/question/chip catalog (ids, defaults, tag hints) | `apps/web/spa/onboarding/onboarding-goals.ts` (+ labels in `messages/{en,es-419}/app.json`) |
| Purpose composition | `apps/web/spa/onboarding/onboarding-purpose.ts` (pure `composePurpose`) |
| Purpose value schema (trim/clamp, 1–1000 chars) | `packages/contract` `WorkspacePurposeSchema` (beside `WorkspaceDuetNameSchema`) |
| Purpose persistence (write-once, one writer) | `completeWorkspaceOnboarding` in `packages/backend/convex/domains/workspaces/birth.ts` |
| Recommendation wire contract | `packages/contract/src/onboarding/` (new module) |
| Recommender logic (prompt build, validate, cap) | `packages/backend/convex/domains/onboarding/recommendationsCore.ts` (pure, injectable `generate`) + `recommend.ts` action |
| Recommendation validity | four-or-nothing, enforced on both sides: the action validates names against the catalog, and `partitionCatalog` collapses the whole rail if a pick has since left it |
| Which Duet the flow wears | `apps/web/spa/onboarding/onboarding-avatars.ts` — selection only; hover previews inside the tile and is never persisted |
| Recommendation endpoint HTTP semantics | `apps/api/src/routes/onboarding.ts` (new file) |
| Step graph & selection rule | `apps/web/spa/onboarding/onboarding-flow.ts` (`effectiveOnboardingGraph({campaignAgents, goalMode})`, `requiredTeamSelections(catalog)`) |
| Recommended-first catalog ordering | pure `partitionCatalog(catalog, recommendations)` beside `TeamStep` |

End-state test: the onboarding module reads as designed today — no dead
`knowledge` branches, no second catalog projection, no forked agent card
(`MarketplaceAgentGalleryCard` gains an optional `reason` slot instead), no
compatibility layer. No transitional scaffolding is planned; if a slice
needs any, it must name the seam and the slice that removes it.

## Slice graph

```
01 recommender+endpoint ─┐
02 purpose column ────────┼→ 06 wizard UI cutover → 07 rail + min-3 → 08 staging closeout
03 goal catalog ─→ 05 graph ┘         ↑
04 e2e catalog seed ──────────────────┘
```

01, 02, and 03/04 have no dependencies on each other. 05 needs 03; 06 needs
02+04+05; 07 needs 01+06; 08 needs everything.

## Verification doctrine

- Every behavior slice opens red (`write-tests`), iterates on the narrowest
  runner, and reaches for `bun test --changed` only when it spans files.
- Every visual slice runs the Docker visual gate (`ui-playground`), then an
  unprimed `screenshot-critique`, and `compare-screenshots` whenever there is
  a before to judge against (the reworked team step, the ready payoff).
  Expect a large intentional baseline diff at slices 06/07 — per the visual
  gate's rules, land those in a pass with no unrelated drift (`--force`
  rewrites ALL baselines).
- The local e2e permanently exercises the recommendations **fallback** path
  (local Convex has no `AI_GATEWAY_API_KEY`) — by design, the failure mode
  gets the strongest regression coverage. The staging journey is the only
  end-to-end evidence for the real LLM path, and it FAILS (not falls back)
  if the rail never arrives — silent-fallback-forever is the one regression
  hermetic suites can't catch.
- Closeout (slice 08 only): one root `bun run test`, then
  `bun run e2e:staging -- --journey agentic-onboarding`.

## Scope firewalls (explicitly out)

- No deterministic fallback recommender. No server-side minimum-3. No
  purpose-editing surface post-onboarding. No migration/backfill. No
  recommendation caching infrastructure. No rate-limit machinery yet.
- The per-agent onboarding chain (`onboarding-chain*.ts(x)`) is a different
  feature — do not touch it.
- In-product Train / root memory is untouched; only the onboarding step dies.
- No new trust boundaries (SECURITY.md consulted): owner-only routes,
  internal-key Convex functions, the platform LLM key never leaves Convex.
  User free-text round-trips through the LLM back to the same user — one
  trust domain, no sanitization theater beyond the length clamp.

## Stays green / needs updating

**Must not break:** `onboarding-chain.test.ts`,
`onboarding-chain-storage.test.ts`, marketplace route/listing tests,
`birth.ts` workspace-creation tests, campaign `starterAgents` tests, the
API-level staging journeys (`agent-naming`, `campaign-conversions` — they
post `skip`/few agents and stay valid), whoami tests (additive field),
`official-hub-seed.test.ts`.

**Updated by this feature:** `onboarding-flow.test.ts`,
`onboarding-catalog.test.ts`, `onboarding-service.{ts,test.ts}`,
`onboarding-routing.test.ts`, `onboarding-config.ts`,
`local-onboarding-e2e.ts`, visual specs (`onboarding-journey.spec.ts`,
`onboarding-scroll.spec.ts`, the `playground.spec.ts` onboarding walk) and
their baselines, playground fixtures (`onboarding-playground.tsx`,
`onboarding-journey-*`), `duetOnboarding` copy in **both** `en` and `es-419`
(knowledge keys removed, ~40 goal/follow-up/rail keys added — es-419 follows
the es419-copy-voice conventions and must not trail the en slice).

## Known unknowns (burn down early, in the owning slice)

- `AI_GATEWAY_API_KEY` on staging Convex: session titles already work there,
  so it exists — confirm with one probe run in slice 01 anyway.
- Whether anything outside `spa/onboarding` imports the knowledge-step
  helpers (`onboarding-website-field.tsx`, `onboarding-url.ts`) — grep
  before deleting in slice 06.
- Whether `demo-60s` or any other harness path walks the onboarding wizard —
  grep in slice 06 before the graph flip.
- Recommendation latency: budgeted ≤10s hard timeout; slice 01's probe
  measures reality before any UI depends on it.
