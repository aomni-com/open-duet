import type { AgentTag } from '@repo/contract'

/**
 * The onboarding goal catalog: three preset goals, one tap-through follow-up
 * question each, 3–5 answer chips with one pre-selected smart default. This
 * module is the single owner of every id, default, and per-goal tag hint;
 * display copy lives in `messages/{en,es-419}/app.json` under
 * `duetOnboarding.goals`, keyed by these same ids (see the key builders below).
 *
 * Three goals rather than six, because the goal line barely discriminates at
 * that width — "grow my business" and "increase sales" recommend nearly the
 * same team. One follow-up rather than three, because the wizard was asking
 * more than a first run can carry: goal, one question, then the team.
 *
 * That leaves the single question doing all the work the other two used to
 * share, so each goal keeps the one that names something an agent can be
 * pointed at — the job to take on, the part that is hardest, the thing being
 * replaced — rather than the one that describes the person asking.
 *
 * Every default is the most common real answer, so tapping straight through
 * still composes a purpose worth reading.
 *
 * Tag hints are a soft prior for the agent recommender, drawn from the
 * contract's closed `AGENT_TAGS` vocabulary — at most 3 per goal, matching the
 * recommendation request contract.
 */

/** Compile-time guarantee that a question's default is one of its chips. */
function question<const Id extends string, const Chips extends readonly string[]>(
  id: Id,
  chipIds: Chips,
  defaultChipId: Chips[number],
) {
  return { id, chipIds, defaultChipId } as const
}

export const ONBOARDING_GOALS = [
  {
    id: 'grow-business',
    tagHints: ['sales', 'marketing', 'operations'],
    questions: [
      question(
        'first-job',
        ['lead-research', 'outreach', 'content-seo', 'customer-conversations', 'reports-admin'],
        'content-seo',
      ),
    ],
  },
  {
    id: 'launch-project',
    tagHints: ['product', 'engineering', 'marketing'],
    questions: [
      question(
        'hardest-part',
        [
          'building-it',
          'making-it-look-right',
          'explaining-it',
          'first-users',
          'keeping-it-running',
        ],
        'building-it',
      ),
    ],
  },
  {
    id: 'replace-software',
    tagHints: ['operations', 'customer-support', 'marketing'],
    questions: [
      // Carries most of the signal for this goal, which is why it leads:
      // "replace my existing software" is thin input for the recommender,
      // "replacing a support desk" is rich. Spreadsheets default deliberately —
      // the most common real answer, and it widens the goal past people who
      // arrived shopping for a vendor swap.
      question(
        'replacing',
        [
          'spreadsheets',
          'crm-sales-tool',
          'support-desk',
          'analytics-reporting',
          'agency-freelancer',
        ],
        'spreadsheets',
      ),
    ],
  },
] as const satisfies readonly {
  id: string
  tagHints: readonly AgentTag[]
  questions: readonly {
    id: string
    chipIds: readonly string[]
    defaultChipId: string
  }[]
}[]

export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number]
export type OnboardingGoalId = OnboardingGoal['id']
export type OnboardingQuestion = OnboardingGoal['questions'][number]
export type OnboardingQuestionId = OnboardingQuestion['id']
export type OnboardingChipId = OnboardingQuestion['chipIds'][number]

export function getOnboardingGoal(goalId: OnboardingGoalId): OnboardingGoal {
  const goal = ONBOARDING_GOALS.find(candidate => candidate.id === goalId)
  if (!goal) throw new Error(`Unknown onboarding goal: ${goalId}`)
  return goal
}

/*
 * i18n key builders — the only bridge between catalog ids and display copy.
 * All keys are relative to the `duetOnboarding` namespace. Sentence values are
 * raw templates carrying an `{answer}` placeholder that `composePurpose`
 * splices (or next-intl formats, when rendered directly).
 */

export function goalLabelKey(goalId: OnboardingGoalId) {
  return `goals.${goalId}.label`
}

/** The tile's second line — three broad labels leave room to say who each is for. */
export function goalDescriptionKey(goalId: OnboardingGoalId) {
  return `goals.${goalId}.description`
}

export function questionTitleKey(goalId: OnboardingGoalId, questionId: OnboardingQuestionId) {
  return `goals.${goalId}.questions.${questionId}.title`
}

export function questionSentenceKey(goalId: OnboardingGoalId, questionId: OnboardingQuestionId) {
  return `goals.${goalId}.questions.${questionId}.sentence`
}

export function chipLabelKey(
  goalId: OnboardingGoalId,
  questionId: OnboardingQuestionId,
  chipId: OnboardingChipId,
) {
  return `goals.${goalId}.questions.${questionId}.chips.${chipId}`
}
