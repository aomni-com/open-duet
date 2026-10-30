import type { OnboardingGoalId } from './onboarding-goals'

/**
 * Duet, dressed for the goal.
 *
 * Each variant is the same character, cap, face and pose as the plain mark —
 * only the raised hand changes, holding the one tool that stands for the
 * goal. That is what lets the mark change identity without ever stopping
 * being Duet, and why the prop is always a bold silhouette: the header
 * renders this at 32px, where anything finer turns to mush.
 *
 * The mapping is explicit rather than derived from the id, so a rename is a
 * type error here instead of a silent 404 in the browser.
 *
 * `replace-software` wears a stand-in: the checked clipboard is close enough to
 * read while a plug, or a pair of swapped arrows, is drawn for it. The map is
 * where that swap happens and the only place it has to.
 */
const GOAL_AVATARS: Readonly<Record<OnboardingGoalId, string>> = {
  'grow-business': '/icons/duet-avatar-goal-grow-business.png',
  'launch-project': '/icons/duet-avatar-goal-launch-project.png',
  'replace-software': '/icons/duet-avatar-goal-replace-software.png',
}

/** Duet with nothing in hand — before a goal is picked, and after it is undone. */
export const DUET_AVATAR = '/icons/duet-avatar.png'

export function goalAvatar(goalId: OnboardingGoalId): string {
  return GOAL_AVATARS[goalId]
}

export function resolveDuetAvatar({
  selected,
}: {
  selected?: OnboardingGoalId | undefined
}): string {
  return selected === undefined ? DUET_AVATAR : goalAvatar(selected)
}
