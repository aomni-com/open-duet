# 05 — Step-graph rework (headless)

The reducer and graph learn the new flow; knowledge state dies. No
components yet — this slice is pure logic, fully unit-testable.

## Contract unlocked

```ts
type OnboardingStep = 'identity' | 'goal' | 'follow-ups' | 'team' | 'ready'
type GoalMode =
  | { kind: 'none' }
  | { kind: 'preset'; goalId: GoalId }
  | { kind: 'custom' }
effectiveOnboardingGraph({ campaignAgents, goalMode }): OnboardingStep[]
requiredTeamSelections(catalog: CatalogState): number
```

One rule table, not stacked filters: `follow-ups` present only when
`goalMode.kind === 'preset'`; `team` absent when campaign agents exist
(unchanged rule, new signature — replace the current single-argument
`effectiveOnboardingGraph`, don't chain a second `.filter`).

## API seam

- `onboarding-flow.ts` reducer state gains `goal: GoalMode`,
  `answers: Record<QuestionId, ChipId>`, `answerDetails: Record<QuestionId,
  string>`, `customPurpose: string`. Picking a preset goal seeds `answers`
  with that goal's defaults from `onboarding-goals.ts` — the no-typing
  guarantee is "the initial state is already a complete answer set."
- `follow-ups` is ONE graph node; the reducer owns `followUpIndex: number`
  with next/previous-question actions, so the tap-through lives where it's
  unit-testable and the header progress stays step-granular. The index is
  bounded by `lastQuestionIndex(goal)` — the picked goal's own question
  count — and by nothing else: a literal ceiling anywhere (a type union, a
  comparison in the wizard) is a second statement of how many questions a
  goal has, and the two drift. `hasNextQuestion` is the one function that
  answers "does Continue show another question or leave the step?", so the
  reducer's clamp and the footer cannot disagree. Expose
  `data-onboarding-step="follow-ups"` + `data-followup-index` for the
  harness (wired in slice 06).
- `requiredTeamSelections`: catalog `ready` → `min(3, agents.length)`;
  loading/error → 0. The fail-open minimum-3 rule has exactly one owner.
- `onboarding-config.ts`: delete the `knowledge` step and its
  `primaryAction: 'knowledge'` special case. Re-express the per-step config
  with a vocabulary of `advance | advance-question | complete` plus
  `validation: 'duet-name' | 'team-minimum' | null` — do NOT leave a dead
  `knowledge` branch beside a new `follow-ups` one in the `goForward()`
  if-ladder.
- Delete all knowledge reducer state and actions.

## Playable deliverable

`onboarding-flow.test.ts` rewritten: graph shapes for {no-goal, preset,
custom, campaign}; default seeding on goal pick; question stepping incl.
back-navigation; `requiredTeamSelections` matrix (ready/loading/error,
thin catalog).

## Verification

`write-tests` red first; onboarding test files, then `bun test --changed`.
Type errors will point at every component still referencing knowledge —
that's slice 06's worklist, not this slice's scope (it may leave the web
package temporarily red on typecheck ONLY if 05+06 land in one pass;
otherwise stage the deletion so each slice leaves the tree green — see
delegated decisions).

## Delegated to the implementer

Whether 05 and 06 land as one commit-pair or two (the tree must be green at
every commit — if the headless deletion breaks component compilation, fold
the affected component edits forward into this slice's commit); exact
action names.

## Stays green

`onboarding-chain*` tests; routing tests not touching knowledge.
