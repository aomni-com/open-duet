'use client'

import { useTranslations } from 'next-intl'
import { createContext, useContext, useState } from 'react'

/**
 * The prompt an empty entry composer wears before anyone types in it.
 *
 * A blank bar with one fixed sentence under it reads as a form field; a bar
 * that greets you differently each time you arrive reads as something waiting
 * for work. The pool mixes two tones on purpose — imperative prompts that push
 * toward delegating, and open questions that invite — so neither one becomes
 * the product's single voice.
 *
 * Only the *entry* composers rotate. Inside a running session the placeholder
 * is a statement of where you are ("Continue this session…"), which is not a
 * greeting and does not get to change under you.
 */

/**
 * A pinned roll, for surfaces that must render the same pixels twice.
 *
 * The visual playground is the only thing that provides it: a screenshot gate
 * cannot photograph a die. Nothing in the product supplies a value, so the
 * product always rolls its own.
 */
export const PinnedComposePlaceholderRoll = createContext<number | null>(null)

/** Maps a roll in [0, 1] onto the pool, clamped so an edge roll still lands. */
export function composePlaceholderFor(
  pool: readonly string[] | undefined,
  roll: number,
  fallback: string,
): string {
  if (!Array.isArray(pool) || pool.length === 0) return fallback
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)))
  return pool[index] ?? fallback
}

/**
 * One prompt per mounted composer. Rolled in a `useState` initializer rather
 * than a `useMemo` so no re-render can reshuffle the words under someone who
 * is mid-sentence; arriving at the entry surface again is what re-rolls it.
 *
 * `describeTask` stays the accessible name of the field and the fallback here,
 * so a locale that has not translated the pool yet still gets a sentence.
 * `agentName` is who the composer talks to; prompts that address an agent
 * carry `{name}` and are filled with it.
 */
export function useComposePlaceholder(agentName: string): string {
  const t = useTranslations('duetApp.sessionProduct')
  const pinnedRoll = useContext(PinnedComposePlaceholderRoll)
  const [roll] = useState(() => Math.random())
  /* The pool is read raw, so the `{name}` a prompt addresses is filled here:
     whoever this composer talks to, never a hard-coded "Duet". */
  return composePlaceholderFor(
    t.raw('taskPlaceholders') as readonly string[] | undefined,
    pinnedRoll ?? roll,
    t('describeTask', { name: agentName }),
  ).replaceAll('{name}', agentName)
}
