import type { MarketplaceListingSummary, OnboardingRecommendation } from '@repo/contract'

import { ONBOARDING_STEPS } from './onboarding-config'
import {
  getOnboardingGoal,
  type OnboardingChipId,
  type OnboardingGoalId,
  type OnboardingQuestionId,
} from './onboarding-goals'

export type OnboardingStep = 'identity' | 'goal' | 'follow-ups' | 'team' | 'ready' | 'payment'

export type GoalMode =
  | { kind: 'none' }
  | { kind: 'preset'; goalId: OnboardingGoalId }
  | { kind: 'custom' }

/** The official-agent catalog as the team step sees it. */
export type CatalogState =
  | { status: 'loading'; agents: readonly MarketplaceListingSummary[] }
  | {
      status: 'ready'
      agents: readonly MarketplaceListingSummary[]
      nextCursor?: string | null
      loadingMore?: boolean
      moreError?: boolean
    }
  | { status: 'error'; agents: readonly MarketplaceListingSummary[] }

/**
 * The "picked for you" recommendations as the team step sees them. `purpose`
 * is the memo key: the exact composed purpose string the current status
 * answers for. There is no error status by design — every failure (transport,
 * timeout, 404 from an older API) settles as `ready` with empty items, and an
 * empty rail simply never renders. Onboarding never blocks on this state.
 */
export type RecommendationsState = {
  status: 'idle' | 'pending' | 'ready'
  purpose: string | null
  items: readonly OnboardingRecommendation[]
}

/**
 * Fire exactly one recommendations request per distinct purpose: idle fires,
 * pending for the same purpose is already in flight, ready for the same
 * purpose is memoized (back/forward reuses it), and a changed purpose
 * refetches. A blank purpose (nothing composed yet) never fires.
 */
export function recommendationsRequestNeeded(
  recommendations: RecommendationsState,
  purpose: string,
): boolean {
  return purpose.length > 0 && recommendations.purpose !== purpose
}

/**
 * Which of the picked goal's follow-up questions the follow-ups step is
 * showing. Plain `number`, deliberately: a literal union would be a second
 * statement of how many questions a goal has, every writer would cast past it
 * to satisfy the compiler, and a bound nobody can trust invites a matching
 * literal in the code beside it. `lastQuestionIndex` is the only bound.
 */
export type FollowUpIndex = number

/**
 * How far the follow-up stepper may walk for the goal currently picked — the
 * one bound, read by the reducer's clamp and by `hasNextQuestion` below.
 * A custom goal has no questions and never reaches the step, so 0 is a floor
 * rather than an answer.
 */
export function lastQuestionIndex(goal: GoalMode): number {
  return goal.kind === 'preset' ? getOnboardingGoal(goal.goalId).questions.length - 1 : 0
}

/**
 * Does Continue show another question, or leave the follow-ups step?
 *
 * The wizard's footer asks exactly this, so the fork and the reducer's clamp
 * cannot disagree about where the last question is. A wizard answering it with
 * a ceiling of its own is how a one-question goal ends up with an enabled
 * Continue that dispatches a step the clamp swallows: the state comes back
 * identical, the page never moves, and nothing is broken enough to throw.
 */
export function hasNextQuestion(state: Pick<OnboardingState, 'goal' | 'followUpIndex'>): boolean {
  return state.followUpIndex < lastQuestionIndex(state.goal)
}

export type OnboardingState = {
  step: OnboardingStep
  duetName: string
  goal: GoalMode
  /** questionId → tapped chipId; seeded with the goal's smart defaults on pick. */
  answers: Readonly<Partial<Record<OnboardingQuestionId, OnboardingChipId>>>
  /** questionId → optional "add detail" free text. */
  answerDetails: Readonly<Partial<Record<OnboardingQuestionId, string>>>
  /** "Write your own" text, stored verbatim until composition trims/clamps it. */
  customPurpose: string
  followUpIndex: FollowUpIndex
  selectedAgentNames: string[]
  catalog: CatalogState
  recommendations: RecommendationsState
}

export type OnboardingAction =
  | { type: 'set-name'; name: string }
  | { type: 'pick-goal'; goalId: OnboardingGoalId }
  | { type: 'choose-custom-goal' }
  | { type: 'set-custom-purpose'; text: string }
  | { type: 'answer-question'; questionId: OnboardingQuestionId; chipId: OnboardingChipId }
  | { type: 'set-answer-detail'; questionId: OnboardingQuestionId; detail: string }
  | { type: 'next-question' }
  | { type: 'previous-question' }
  | { type: 'toggle-agent'; name: string }
  | { type: 'catalog-loading' }
  | {
      type: 'catalog-page-ready'
      agents: readonly MarketplaceListingSummary[]
      nextCursor: string | null
    }
  | { type: 'catalog-more-loading' }
  | { type: 'catalog-more-error' }
  | { type: 'catalog-error' }
  | { type: 'recommendations-pending'; purpose: string }
  | {
      type: 'recommendations-settle'
      purpose: string
      items: readonly OnboardingRecommendation[]
    }
  | { type: 'go-to'; step: OnboardingStep }

/**
 * The one rule table for step presence. Every step's inclusion rule lives on
 * this line-per-step map — add a rule here, not a second filter downstream.
 *
 * Campaign agents are the flow's one fork, and they collapse it to its two
 * ends: name the assistant, then meet it. Everything between those two steps
 * exists to learn what the workspace is for and which specialists it needs, and
 * a campaign arrival has already answered both — by the page they came from and
 * by the agents that page hands them. Non-empty `campaignAgents` IS the signal
 * that they came from one; there is no second flag to keep in step with it.
 */
export function effectiveOnboardingGraph({
  campaignAgents,
  goalMode,
}: {
  campaignAgents: readonly string[]
  goalMode: GoalMode
}) {
  const fromCampaign = campaignAgents.length > 0
  const includes: Record<OnboardingStep, boolean> = {
    identity: true,
    goal: !fromCampaign,
    'follow-ups': !fromCampaign && goalMode.kind === 'preset',
    team: !fromCampaign,
    ready: true,
    payment: true,
  }
  const steps = ONBOARDING_STEPS.filter(step => includes[step.id])

  return {
    steps,
    at(step: OnboardingStep) {
      const index = steps.findIndex(candidate => candidate.id === step)
      if (index === -1) throw new Error(`Step is not in the effective onboarding graph: ${step}`)
      return {
        ...steps[index]!,
        index,
        previous: steps[index - 1]?.id ?? null,
        next: steps[index + 1]?.id ?? null,
      }
    },
  }
}

/**
 * The minimum-3 team selection floor, and its only owner — fail-open by
 * design: it exists only while the catalog is healthy, so a marketplace
 * outage (or a thin catalog) never dead-ends signup. The server keeps
 * accepting `skip`/fewer, so this is a UI floor, not a contract.
 */
export function requiredTeamSelections(catalog: CatalogState): number {
  return catalog.status === 'ready' ? Math.min(3, catalog.agents.length) : 0
}

/**
 * How long a tapped answer is left on screen before the flow moves on.
 *
 * Long enough to see the choice land — the tile's mark settles in about
 * 200ms — and short enough that it still feels like the tap did it. Anything
 * under ~150ms and the selection is gone before the eye registers it, which
 * reads as the app skipping a step rather than answering one.
 */
export const SELECTION_ADVANCE_MS = 280

/**
 * Should answering this question carry the user forward on its own?
 *
 * Only when the optional detail field is untouched. Someone who has typed
 * there is mid-thought, and moving the page out from under them would throw
 * the sentence away — so a typed detail hands control back to Continue.
 */
export function shouldAdvanceAfterAnswer(detail: string | undefined): boolean {
  return (detail ?? '').trim().length === 0
}

export function createInitialOnboardingState(): OnboardingState {
  return {
    step: 'identity',
    duetName: 'Duet',
    goal: { kind: 'none' },
    answers: {},
    answerDetails: {},
    customPurpose: '',
    followUpIndex: 0,
    selectedAgentNames: [],
    catalog: { status: 'loading', agents: [] },
    recommendations: { status: 'idle', purpose: null, items: [] },
  }
}

/**
 * The no-typing guarantee: picking a goal makes the initial state already a
 * complete answer set — every question answered with its smart default.
 */
function seedDefaultAnswers(
  goalId: OnboardingGoalId,
): Partial<Record<OnboardingQuestionId, OnboardingChipId>> {
  return Object.fromEntries(
    getOnboardingGoal(goalId).questions.map(question => [question.id, question.defaultChipId]),
  )
}

export function onboardingReducer(
  state: OnboardingState,
  action: OnboardingAction,
): OnboardingState {
  switch (action.type) {
    case 'set-name':
      return { ...state, duetName: action.name }
    case 'pick-goal':
      return {
        ...state,
        goal: { kind: 'preset', goalId: action.goalId },
        answers: seedDefaultAnswers(action.goalId),
        answerDetails: {},
        followUpIndex: 0,
      }
    case 'choose-custom-goal':
      return {
        ...state,
        goal: { kind: 'custom' },
        answers: {},
        answerDetails: {},
        followUpIndex: 0,
      }
    case 'set-custom-purpose':
      return { ...state, customPurpose: action.text }
    case 'answer-question':
      return { ...state, answers: { ...state.answers, [action.questionId]: action.chipId } }
    case 'set-answer-detail':
      return {
        ...state,
        answerDetails: { ...state.answerDetails, [action.questionId]: action.detail },
      }
    case 'next-question':
      /* Clamped against the goal's own question count, not a constant: a
         literal ceiling is true only for the goal shape it was written for,
         and silently one past the end for every other. */
      return {
        ...state,
        followUpIndex: Math.min(lastQuestionIndex(state.goal), state.followUpIndex + 1),
      }
    case 'previous-question':
      return { ...state, followUpIndex: Math.max(0, state.followUpIndex - 1) }
    case 'toggle-agent':
      return state.selectedAgentNames.includes(action.name)
        ? {
            ...state,
            selectedAgentNames: state.selectedAgentNames.filter(name => name !== action.name),
          }
        : { ...state, selectedAgentNames: [...state.selectedAgentNames, action.name] }
    case 'catalog-loading':
      return { ...state, catalog: { status: 'loading', agents: [] } }
    case 'catalog-page-ready':
      return {
        ...state,
        catalog: {
          status: 'ready',
          agents: [...state.catalog.agents, ...action.agents],
          nextCursor: action.nextCursor,
        },
      }
    case 'catalog-more-loading':
      return state.catalog.status === 'ready'
        ? { ...state, catalog: { ...state.catalog, loadingMore: true, moreError: false } }
        : state
    case 'catalog-more-error':
      return state.catalog.status === 'ready'
        ? { ...state, catalog: { ...state.catalog, loadingMore: false, moreError: true } }
        : state
    case 'catalog-error':
      return { ...state, catalog: { status: 'error', agents: [] } }
    case 'recommendations-pending':
      return {
        ...state,
        recommendations: { status: 'pending', purpose: action.purpose, items: [] },
      }
    case 'recommendations-settle':
      // A settle for a superseded purpose is stale — the newer request's own
      // settle is on its way; applying this one would flash old picks.
      if (state.recommendations.purpose !== action.purpose) return state
      return {
        ...state,
        recommendations: { status: 'ready', purpose: action.purpose, items: action.items },
      }
    case 'go-to':
      return { ...state, step: action.step }
  }
}
