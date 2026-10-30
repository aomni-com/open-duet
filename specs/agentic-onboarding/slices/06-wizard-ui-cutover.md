# 06 — Wizard UI cutover

The visible rework: goal + follow-up steps exist, knowledge UI is deleted,
the ready step pays off the purpose, the local e2e walks the new flow.
Minimum-3 and the recommended rail are NOT here (slice 07) — this keeps the
diff reviewable and equals the specified LLM-failure behavior, so the flow
is shippable from this slice alone.

## Contract unlocked

A user completes the new flow end to end locally with zero typing, and the
composed purpose lands in the workspace row.

## API seam

- **`GoalStep`** (new): three tiles + "Write your own" expanding a textarea.
  Tile click sets `GoalMode` and advances.
- **`FollowUpsStep`** (new): question card, chip row (one pre-selected),
  optional "Add detail (optional)" field, and the answered-so-far recap in
  place of a question counter — it says what you chose rather than how many
  screens are left.
- **ReadyStep**: summary swaps the knowledge row for a purpose payoff (goal
  echo + team roster).
- **Deletions** (refactor-clean — remove, don't strand): `KnowledgeStep`,
  `TrainingProgress`, `KnowledgePreview`, `onboarding-website-field.tsx`,
  `onboarding-url.ts` (+ tests), `trainGlobalKnowledge` on
  `OnboardingService`, knowledge copy keys in both locales. Grep first:
  nothing outside `spa/onboarding` may import them; also grep whether
  `demo-60s` or any harness path walks the wizard.
- `OnboardingService.completeOnboarding` sends `purpose` (from
  `composePurpose`/`customPurpose`) and `goal` (analytics id).
- Copy: new `duetOnboarding` keys in `en` AND `es-419`.
- Playgrounds: `onboarding-playground.tsx` + journey fixture updated — every
  goal reachable via URL param (follow the existing `?catalog=error`
  convention), preset and custom paths.

## Playable deliverable

`/playground/onboarding` — the whole flow tappable with zero typing; and the
real local flow (via the e2e stack) producing a stored purpose readable
through `testing/workspaces:rawWorkspacesForTest`.

## Verification

- `write-tests` red first: the browser onboarding walk,
  `onboarding-service.test.ts` (train path deleted, purpose sent), routing
  tests.
- **Local e2e rewritten in the same commit as the graph flip** (the firewall
  against silently breaking the harness): asserts
  `identity → goal → follow-ups(one press per question the picked goal asks,
  a chip pre-selected on each) → team → ready`, completion POST body carries
  the exact composed purpose, raw workspace row has it. The press count comes
  from the shipped catalog, never a literal — a walk with its own number
  either strands itself on a question or presses into the next step and
  counts that as a follow-up. Team continues zero-selected here (min-3 is 07).
- Visual: `ui-playground` Docker gate (new baselines for goal/follow-ups,
  changed ready); unprimed `screenshot-critique` on the new steps;
  `compare-screenshots` for ready (before/after). Land the baseline pass
  with no unrelated drift.

## Human review checkpoint (non-blocking)

Open the new-step shots with `preview-shots` for the user; ~5 min window;
if silent, decide on the critique evidence, record here, close the shots,
proceed.

## Delegated to the implementer

Tile/chip layout and motion (cosmetic, reversible); textarea expand
behavior; exact playground param names.

## Stays green

`onboarding-chain*` suites; marketplace tests; the API-level staging
journeys. The `playground.spec.ts` onboarding walk and
`onboarding-scroll.spec.ts` step-walk are updated here, with
`tests/visual/coverage.ts` entries.
