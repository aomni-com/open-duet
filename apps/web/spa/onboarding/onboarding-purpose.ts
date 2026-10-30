import { WORKSPACE_PURPOSE_MAX_LENGTH } from '@repo/contract'

import {
  chipLabelKey,
  getOnboardingGoal,
  goalLabelKey,
  questionSentenceKey,
  type OnboardingChipId,
  type OnboardingGoalId,
  type OnboardingQuestionId,
} from './onboarding-goals'

/**
 * Purpose composition: turns any onboarding answer state into the single
 * plain-text paragraph stored as `workspaces.purpose`. Pure — labels arrive
 * through a resolver so composition always uses the localized strings the
 * user actually tapped (what-you-tapped-is-what-you-stored).
 */

/**
 * The one non-catalog key composition needs: the opening sentence template,
 * `duetOnboarding.purposeGoalSentence`, carrying a `{goal}` placeholder.
 */
export const PURPOSE_GOAL_SENTENCE_KEY = 'purposeGoalSentence'

/**
 * Returns the raw `duetOnboarding` message for a key produced by the
 * onboarding-goals key builders (raw: sentence templates keep their
 * placeholders — this module splices them).
 */
export type PurposeLabelResolver = (key: string) => string

export type ComposePurposeInput = {
  goalId: OnboardingGoalId
  /** questionId → tapped chipId. Missing/unknown entries fall back to the smart default. */
  answers?: Readonly<Partial<Record<OnboardingQuestionId, string>>>
  /** questionId → optional free-text detail; blank entries are ignored. */
  details?: Readonly<Partial<Record<OnboardingQuestionId, string>>>
}

export function composePurpose(
  { goalId, answers, details }: ComposePurposeInput,
  resolveLabel: PurposeLabelResolver,
): string {
  const goal = getOnboardingGoal(goalId)
  const goalLabel = midSentence(resolveLabel(goalLabelKey(goalId)))
  const sentences = [resolveLabel(PURPOSE_GOAL_SENTENCE_KEY).replace('{goal}', goalLabel)]

  for (const question of goal.questions) {
    const tapped = answers?.[question.id]
    const chipId: OnboardingChipId =
      tapped !== undefined && (question.chipIds as readonly string[]).includes(tapped)
        ? (tapped as OnboardingChipId)
        : question.defaultChipId
    const answer = midSentence(resolveLabel(chipLabelKey(goalId, question.id, chipId)))
    let sentence = resolveLabel(questionSentenceKey(goalId, question.id)).replace(
      '{answer}',
      answer,
    )
    const detail = details?.[question.id]?.trim()
    if (detail) sentence += ` (${detail})`
    sentences.push(sentence)
  }

  return clampPurpose(sentences.map(sentence => `${sentence}.`).join(' '))
}

/** "Write your own": stored verbatim — trimmed and clamped, nothing else. */
export function customPurpose(text: string): string {
  return clampPurpose(text)
}

function clampPurpose(text: string): string {
  return text.trim().slice(0, WORKSPACE_PURPOSE_MAX_LENGTH)
}

/**
 * Lowers a label's leading capital so it reads mid-sentence ("Other
 * businesses" → "other businesses") without mangling acronyms or proper
 * casings ("B2B services", "SaaS or software", "CRM or helpdesk" stay put):
 * only a plain capitalized first word — one uppercase letter followed by
 * lowercase only — gets lowered. Unicode-aware, so es-419 labels behave.
 */
function midSentence(label: string): string {
  const firstWord = (label.split(/\s+/, 1)[0] ?? '').replace(/[^\p{L}\p{N}]+$/u, '')
  if (!/^\p{Lu}\p{Ll}*$/u.test(firstWord)) return label
  return label.charAt(0).toLowerCase() + label.slice(1)
}
