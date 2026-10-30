import { describe, expect, test } from 'bun:test'

import type { MarketplaceListingSummary } from '@repo/contract'

import { ONBOARDING_STEPS } from './onboarding-config'
import {
  createInitialOnboardingState,
  effectiveOnboardingGraph,
  hasNextQuestion,
  onboardingReducer,
  recommendationsRequestNeeded,
  requiredTeamSelections,
  SELECTION_ADVANCE_MS,
  shouldAdvanceAfterAnswer,
  type CatalogState,
  type OnboardingState,
} from './onboarding-flow'
import { ONBOARDING_GOALS } from './onboarding-goals'

const catalogListing = (agentName: string): MarketplaceListingSummary => ({
  id: `listing-${agentName}`,
  publisherSlug: 'official',
  verifiedPublisher: true,
  agentName,
  title: agentName,
  summary: agentName,
  skills: [],
  tags: [],
  appNames: [],
  installs: 0,
  availability: 'available',
})

test('catalog continuation appends a supplied page without losing loaded choices', () => {
  let state = onboardingReducer(createInitialOnboardingState(), {
    type: 'catalog-page-ready',
    agents: [catalogListing('first')],
    nextCursor: 'older',
  })
  state = onboardingReducer(state, { type: 'catalog-more-loading' })
  state = onboardingReducer(state, {
    type: 'catalog-page-ready',
    agents: [catalogListing('older')],
    nextCursor: null,
  })
  expect(state.catalog).toMatchObject({
    status: 'ready',
    agents: [catalogListing('first'), catalogListing('older')],
    nextCursor: null,
  })
})

describe('effective onboarding graph', () => {
  test('a campaign arrival names its assistant and is done, whatever the goal state says', () => {
    // The campaign already answered the two questions the middle of the wizard
    // asks — what this workspace is for, and which specialists it needs — so
    // asking them again is asking a user to re-supply what they arrived with.
    // The goal mode is deliberately varied here: nothing about it may reach the
    // graph once campaign agents are present.
    for (const goalMode of [
      { kind: 'none' },
      { kind: 'preset', goalId: 'grow-business' },
      { kind: 'custom' },
    ] as const) {
      const graph = effectiveOnboardingGraph({ campaignAgents: ['fixture-researcher'], goalMode })
      expect(graph.steps.map(step => step.id)).toEqual(['identity', 'ready', 'payment'])
    }
  })

  test('the campaign graph has no way back into the steps it dropped', () => {
    const graph = effectiveOnboardingGraph({
      campaignAgents: ['fixture-researcher'],
      goalMode: { kind: 'none' },
    })
    expect(graph.at('identity')).toMatchObject({ previous: null, next: 'ready' })
    expect(graph.at('ready')).toMatchObject({ previous: 'identity', next: 'payment' })
    expect(graph.at('payment')).toMatchObject({ previous: 'ready', next: null })
    for (const dropped of ['goal', 'follow-ups', 'team'] as const) {
      expect(() => graph.at(dropped)).toThrow()
    }
  })

  test('without a campaign, follow-ups appear only on a preset goal', () => {
    const noGoal = effectiveOnboardingGraph({ campaignAgents: [], goalMode: { kind: 'none' } })
    expect(noGoal.steps.map(step => step.id)).toEqual(['identity', 'goal', 'team', 'ready', 'payment'])

    const preset = effectiveOnboardingGraph({
      campaignAgents: [],
      goalMode: { kind: 'preset', goalId: 'launch-project' },
    })
    expect(preset.steps.map(step => step.id)).toEqual([
      'identity',
      'goal',
      'follow-ups',
      'team',
      'ready',
      'payment',
    ])

    const custom = effectiveOnboardingGraph({ campaignAgents: [], goalMode: { kind: 'custom' } })
    expect(custom.steps.map(step => step.id)).toEqual([
      'identity',
      'goal',
      'team',
      'ready',
      'payment',
    ])
  })

  test('adjacency comes from the effective graph, not the full step list', () => {
    const preset = effectiveOnboardingGraph({
      campaignAgents: [],
      goalMode: { kind: 'preset', goalId: 'launch-project' },
    })
    expect(preset.at('follow-ups')).toMatchObject({ previous: 'goal', next: 'team' })

    const custom = effectiveOnboardingGraph({ campaignAgents: [], goalMode: { kind: 'custom' } })
    expect(custom.at('goal')).toMatchObject({ previous: 'identity', next: 'team' })
    expect(() => custom.at('follow-ups')).toThrow()
  })
})

describe('onboarding reducer', () => {
  test('keeps Duet implicit while users build an optional specialist team', () => {
    const initial = createInitialOnboardingState()

    expect(initial).toMatchObject({
      step: 'identity',
      duetName: 'Duet',
      selectedAgentNames: [],
      goal: { kind: 'none' },
      followUpIndex: 0,
    })

    const selected = onboardingReducer(initial, {
      type: 'toggle-agent',
      name: 'research-assistant',
    })
    expect(selected.selectedAgentNames).toEqual(['research-assistant'])

    const deselected = onboardingReducer(selected, {
      type: 'toggle-agent',
      name: 'research-assistant',
    })
    expect(deselected.selectedAgentNames).toEqual([])
  })

  test('picking a preset goal seeds every question with its smart default', () => {
    const picked = onboardingReducer(createInitialOnboardingState(), {
      type: 'pick-goal',
      goalId: 'launch-project',
    })

    expect(picked.goal).toEqual({ kind: 'preset', goalId: 'launch-project' })
    expect(picked.answers).toEqual({ 'hardest-part': 'building-it' })
    expect(picked.followUpIndex).toBe(0)
  })

  test('re-picking a goal replaces prior answers and clears details', () => {
    let state = onboardingReducer(createInitialOnboardingState(), {
      type: 'pick-goal',
      goalId: 'launch-project',
    })
    state = onboardingReducer(state, {
      type: 'answer-question',
      questionId: 'hardest-part',
      chipId: 'first-users',
    })
    state = onboardingReducer(state, {
      type: 'set-answer-detail',
      questionId: 'hardest-part',
      detail: 'shipping to a private beta next week',
    })

    const repicked = onboardingReducer(state, { type: 'pick-goal', goalId: 'replace-software' })
    expect(repicked.answers).toEqual({ replacing: 'spreadsheets' })
    expect(repicked.answerDetails).toEqual({})
    expect(repicked.followUpIndex).toBe(0)
  })

  test('a tapped chip overrides its seeded default, and details attach per question', () => {
    let state = onboardingReducer(createInitialOnboardingState(), {
      type: 'pick-goal',
      goalId: 'grow-business',
    })
    state = onboardingReducer(state, {
      type: 'answer-question',
      questionId: 'first-job',
      chipId: 'reports-admin',
    })
    state = onboardingReducer(state, {
      type: 'set-answer-detail',
      questionId: 'first-job',
      detail: 'orders pile up in the inbox',
    })

    expect(state.answers).toEqual({ 'first-job': 'reports-admin' })
    expect(state.answerDetails).toEqual({ 'first-job': 'orders pile up in the inbox' })
  })

  test('choosing custom mode clears preset answers and stores the supplied purpose', () => {
    let state = onboardingReducer(createInitialOnboardingState(), {
      type: 'pick-goal',
      goalId: 'grow-business',
    })
    state = onboardingReducer(state, { type: 'choose-custom-goal' })
    state = onboardingReducer(state, {
      type: 'set-custom-purpose',
      text: 'Help me run my ceramics studio',
    })

    expect(state.goal).toEqual({ kind: 'custom' })
    expect(state.answers).toEqual({})
    expect(state.customPurpose).toBe('Help me run my ceramics studio')
  })

  /* One question, so both ends of the walk are the same index. The stepper is
     still exercised: it must not run off a one-element list in either
     direction, which is the whole failure a clamp exists to prevent. */
  test('question stepping is clamped at both ends of a single question', () => {
    let state = onboardingReducer(createInitialOnboardingState(), {
      type: 'pick-goal',
      goalId: 'replace-software',
    })

    state = onboardingReducer(state, { type: 'previous-question' })
    expect(state.followUpIndex).toBe(0)

    state = onboardingReducer(state, { type: 'next-question' })
    expect(state.followUpIndex).toBe(0)
    state = onboardingReducer(state, { type: 'previous-question' })
    expect(state.followUpIndex).toBe(0)
  })
})

describe('composed graph and reducer walk through follow-up questions', () => {
  /* The wizard's footer, reduced to the one fork that can strand a user:
     `advance-question` either shows another question or steps out. This walk
     asks `hasNextQuestion` because `goForward` asks it too — that shared
     function is what the assertions below actually pin. A fork that answers
     to its own ceiling leaves an enabled Continue dispatching a
     `next-question` the reducer's clamp swallows: the state comes back
     identical, the page never moves, and nothing throws. Counting the
     questions the walk was shown is what makes that visible. */
  function pressContinue(state: OnboardingState): OnboardingState {
    const config = ONBOARDING_STEPS.find(step => step.id === state.step)
    expect(config?.primaryAction).toBe('advance-question')
    if (hasNextQuestion(state)) return onboardingReducer(state, { type: 'next-question' })
    const next = effectiveOnboardingGraph({ campaignAgents: [], goalMode: state.goal }).at(
      state.step,
    ).next
    expect(next).not.toBeNull()
    return onboardingReducer(state, { type: 'go-to', step: next! })
  }

  for (const goal of ONBOARDING_GOALS) {
    test(`${goal.id}: one reducer walk action per question, then out to the team step`, () => {
      let state: OnboardingState = {
        ...onboardingReducer(createInitialOnboardingState(), {
          type: 'pick-goal',
          goalId: goal.id,
        }),
        step: 'follow-ups',
      }

      const shown: number[] = [state.followUpIndex]
      for (let press = 0; press < goal.questions.length; press += 1) {
        expect(state.step).toBe('follow-ups')
        state = pressContinue(state)
        if (state.step === 'follow-ups') shown.push(state.followUpIndex)
      }

      // Each question shown exactly once — a repeat means a press did nothing.
      expect(shown).toEqual(goal.questions.map((_, index) => index))
      expect(state.step).toBe('team')
    })
  }
})

describe('recommendations state', () => {
  test('a request marks pending and its settle hydrates items for that exact purpose', () => {
    const pending = onboardingReducer(createInitialOnboardingState(), {
      type: 'recommendations-pending',
      purpose: 'Goal: grow my business.',
    })
    expect(pending.recommendations).toEqual({
      status: 'pending',
      purpose: 'Goal: grow my business.',
      items: [],
    })

    const settled = onboardingReducer(pending, {
      type: 'recommendations-settle',
      purpose: 'Goal: grow my business.',
      items: [{ agentName: 'research-assistant', reason: 'Matches your research goal.' }],
    })
    expect(settled.recommendations).toEqual({
      status: 'ready',
      purpose: 'Goal: grow my business.',
      items: [{ agentName: 'research-assistant', reason: 'Matches your research goal.' }],
    })
  })

  test('a stale settle for a superseded purpose is ignored', () => {
    let state = onboardingReducer(createInitialOnboardingState(), {
      type: 'recommendations-pending',
      purpose: 'Goal: original purpose.',
    })
    state = onboardingReducer(state, {
      type: 'recommendations-pending',
      purpose: 'Goal: changed purpose.',
    })
    const afterStale = onboardingReducer(state, {
      type: 'recommendations-settle',
      purpose: 'Goal: original purpose.',
      items: [{ agentName: 'writing-editor', reason: 'Stale answer.' }],
    })
    expect(afterStale.recommendations).toEqual({
      status: 'pending',
      purpose: 'Goal: changed purpose.',
      items: [],
    })
  })
})

describe('recommendationsRequestNeeded', () => {
  test('memoizes by exact purpose string and never fires on a blank purpose', () => {
    const idle = createInitialOnboardingState().recommendations
    expect(recommendationsRequestNeeded(idle, 'Goal: grow my business.')).toBe(true)
    expect(recommendationsRequestNeeded(idle, '')).toBe(false)

    // Single in-flight: a pending request for the same purpose never re-fires.
    const pending = onboardingReducer(createInitialOnboardingState(), {
      type: 'recommendations-pending',
      purpose: 'Goal: grow my business.',
    }).recommendations
    expect(recommendationsRequestNeeded(pending, 'Goal: grow my business.')).toBe(false)

    // Back/forward with unchanged answers reuses the settled result…
    const ready = onboardingReducer(
      { ...createInitialOnboardingState(), recommendations: pending },
      {
        type: 'recommendations-settle',
        purpose: 'Goal: grow my business.',
        items: [],
      },
    ).recommendations
    expect(recommendationsRequestNeeded(ready, 'Goal: grow my business.')).toBe(false)
    // …while changed answers (a different composed purpose) refetch.
    expect(recommendationsRequestNeeded(ready, 'Goal: increase sales.')).toBe(true)
  })
})

describe('requiredTeamSelections', () => {
  const agents = (count: number) =>
    Array.from({ length: count }, (_, index) => catalogListing(`agent-${index}`))

  test('a healthy catalog requires three picks, or the whole thin catalog', () => {
    expect(requiredTeamSelections({ status: 'ready', agents: agents(8) })).toBe(3)
    expect(requiredTeamSelections({ status: 'ready', agents: agents(3) })).toBe(3)
    expect(requiredTeamSelections({ status: 'ready', agents: agents(2) })).toBe(2)
    expect(requiredTeamSelections({ status: 'ready', agents: agents(0) })).toBe(0)
  })

  test('fails open while the catalog is loading or broken', () => {
    const loading: CatalogState = { status: 'loading', agents: [] }
    const error: CatalogState = { status: 'error', agents: [] }
    expect(requiredTeamSelections(loading)).toBe(0)
    expect(requiredTeamSelections(error)).toBe(0)
  })
})

describe('answer auto-advance eligibility and feedback budget', () => {
  test('untouched or blank detail permits answer auto-advance', () => {
    expect(shouldAdvanceAfterAnswer(undefined)).toBe(true)
    expect(shouldAdvanceAfterAnswer('')).toBe(true)
    expect(shouldAdvanceAfterAnswer('   ')).toBe(true)
  })

  test('nonblank detail prevents answer auto-advance', () => {
    // Moving the page out from under someone mid-sentence would throw their
    // words away, so the tap stops being a navigation.
    expect(shouldAdvanceAfterAnswer('mostly cold email replies')).toBe(false)
  })

  test('the pause is long enough to see the choice land, short enough to feel caused', () => {
    expect(SELECTION_ADVANCE_MS).toBeGreaterThanOrEqual(150)
    expect(SELECTION_ADVANCE_MS).toBeLessThanOrEqual(450)
  })
})
