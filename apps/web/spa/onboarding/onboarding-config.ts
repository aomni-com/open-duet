import type { OnboardingStep } from './onboarding-flow'

/**
 * What the footer's primary button does on each step: advance to the next
 * step, advance one follow-up question (stepping into the next step only
 * after the last question), or complete onboarding.
 */
type OnboardingPrimaryAction = 'advance' | 'advance-question' | 'complete'

/**
 * The gate the primary action must clear first. `goal-choice` demands a picked
 * goal (and, for "Write your own", non-blank text). `team-minimum` is the
 * minimum-selection floor owned by `requiredTeamSelections` in
 * `onboarding-flow.ts` — fail-open, so it only bites while the catalog is
 * healthy.
 */
type OnboardingStepValidation = 'duet-name' | 'goal-choice' | 'team-minimum' | null

type OnboardingStepConfig = {
  id: OnboardingStep
  primaryAction: OnboardingPrimaryAction
  validation: OnboardingStepValidation
  primaryWidth: 'responsive-full' | 'intrinsic'
}

export const ONBOARDING_STEPS = [
  {
    id: 'identity',
    primaryAction: 'advance',
    validation: 'duet-name',
    primaryWidth: 'responsive-full',
  },
  {
    id: 'goal',
    primaryAction: 'advance',
    validation: 'goal-choice',
    primaryWidth: 'intrinsic',
  },
  {
    id: 'follow-ups',
    primaryAction: 'advance-question',
    validation: null,
    primaryWidth: 'intrinsic',
  },
  {
    id: 'team',
    primaryAction: 'advance',
    validation: 'team-minimum',
    primaryWidth: 'intrinsic',
  },
  {
    id: 'ready',
    primaryAction: 'advance',
    validation: null,
    primaryWidth: 'intrinsic',
  },
  {
    id: 'payment',
    primaryAction: 'complete',
    validation: null,
    primaryWidth: 'intrinsic',
  },
] as const satisfies readonly OnboardingStepConfig[]

/* Two boxes, and the order they nest in is the whole point. `gutter` is the
   width the header rule, the step, and the footer rule all line up on;
   `content` is the reading column inside it. Neither may own the scroll —
   that belongs to the window, so a wheel over the margin still moves the step. */
export const ONBOARDING_LAYOUT = {
  gutter: 'mx-auto w-full max-w-5xl px-5 sm:px-8',
  content: 'mx-auto w-full max-w-[42rem]',
} as const
