# 07 — Recommended rail and the minimum-3 gate

The team step becomes recommendation-fed and enforces the selection floor.

## Contract unlocked

Entering the team step fires one recommendations request; the plain catalog
renders immediately; four personalized picks hydrate into a "picked for
you" rail when they arrive (and silently never appear on failure); Continue
requires ≥3 selected agents whenever the catalog is healthy.

## API seam

- `DuetApiClient.recommendOnboardingAgents(slug, body, signal)` — enters as
  a new narrow source type mirroring `MarketplaceAgentCatalogSource`, NOT a
  method on `OnboardingService` (it's a read, not an orchestration).
- Fired once on the transition into `team` (from follow-ups, or from goal on
  the custom path) with the composed purpose + client-computed `tagHints`.
  Fire-and-forget into reducer state
  `recommendations: {status: 'idle'|'pending'|'ready', items}`; single
  in-flight; memoized by exact purpose string (back/forward reuses, changed
  answers refetch); client-side 12s guard atop the server's 10s abort.
  Never blocks — enforced by construction.
- `TeamStep`: skeleton band while `pending` that simply disappears on
  failure/empty; `partitionCatalog(catalog, recommendations)` computes
  `{recommended: [{listing, reason}], rest}` by joining `agentName` to
  catalog listings (unknown names impossible — the action validated).
  `MarketplaceAgentGalleryCard` gains an optional `reason` slot — do NOT
  fork a parallel recommended-card component; keep the slot
  rendering-neutral when absent (the marketplace surface shares this card).
- Footer: Continue disabled below `requiredTeamSelections(catalog)` with a
  "pick N more" hint; campaign users never reach this step (graph rule).
- Playground: mock recommendation source with `?recommendations=pending|error`
  states alongside the existing catalog params.

## Playable deliverable

Playground: rail hydrating, failure collapsing to plain catalog, floor
blocking until 3 picks. Local e2e: the fallback path — local Convex has no
gateway key, so the e2e permanently asserts the rail's absence does not
block, plus Continue disabled at 2 / enabled at 3 against the seeded
catalog (slice 04), POST `selectedNames` length ≥3, installs succeed.

## Verification

- `write-tests` red first: component tests for the state matrix
  (pending/ready/failed × selection floor incl. catalog error fail-open),
  partition ordering, single-flight memoization.
- Visual gate + unprimed `screenshot-critique` + `compare-screenshots`
  (team step before/after — the one surface with a real prior look).
- e2e extension as above.

## Human review checkpoint (non-blocking)

`preview-shots` of the rail states; ~5 min; decide-record-proceed if silent.

## Delegated to the implementer

Rail layout/skeleton styling; hint copy phrasing; where the 12s client guard
constant lives.

## Stays green

Marketplace gallery/card tests (slot neutral when absent); slice 06's e2e
assertions; `onboarding-chain*`.
