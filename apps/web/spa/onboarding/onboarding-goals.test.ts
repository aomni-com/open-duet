import { describe, expect, test } from 'bun:test'

import { MAX_ONBOARDING_TAG_HINTS } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import {
  chipLabelKey,
  goalDescriptionKey,
  goalLabelKey,
  ONBOARDING_GOALS,
  questionSentenceKey,
  questionTitleKey,
} from './onboarding-goals'
import { PURPOSE_GOAL_SENTENCE_KEY } from './onboarding-purpose'

describe('the goal catalog shape (spec invariants the compiler cannot see)', () => {
  test('three goals, one question each, 3-5 chips per question', () => {
    expect(ONBOARDING_GOALS.map(goal => goal.id)).toEqual([
      'grow-business',
      'launch-project',
      'replace-software',
    ])
    for (const goal of ONBOARDING_GOALS) {
      // One follow-up: the wizard is goal, question, team. The single question
      // therefore carries every bit of signal the recommender gets beyond the
      // goal label itself.
      expect(goal.questions).toHaveLength(1)
      for (const question of goal.questions) {
        expect(question.chipIds.length).toBeGreaterThanOrEqual(3)
        expect(question.chipIds.length).toBeLessThanOrEqual(5)
        expect(new Set(question.chipIds).size).toBe(question.chipIds.length)
      }
    }
  })

  test('question ids are unique across goals, not just within one', () => {
    /* The reducer stores answers in ONE map keyed by question id, across every
       goal — so two goals sharing an id would have the second goal's seeded
       default land on the first goal's answer, and re-picking would compose a
       purpose out of a question the reader was never asked. */
    const questionIds = ONBOARDING_GOALS.flatMap(goal =>
      goal.questions.map(question => question.id),
    )
    expect(new Set(questionIds).size).toBe(questionIds.length)
  })

  test('tag hints stay within the recommendation request cap', () => {
    for (const goal of ONBOARDING_GOALS) {
      expect(goal.tagHints.length).toBeGreaterThanOrEqual(1)
      expect(goal.tagHints.length).toBeLessThanOrEqual(MAX_ONBOARDING_TAG_HINTS)
    }
  })
})

describe('every catalog id has copy in both locales (es-419 must not trail en)', () => {
  const locales = [
    ['en', appEn],
    ['es-419', appEs],
  ] as const

  for (const [locale, messages] of locales) {
    test(`${locale} resolves every label, description, title, sentence, and chip`, () => {
      const resolve = (key: string): string => {
        let node: unknown = messages.duetOnboarding
        for (const part of key.split('.')) {
          if (node === null || typeof node !== 'object') break
          node = (node as Record<string, unknown>)[part]
        }
        if (typeof node !== 'string' || node.length === 0)
          throw new Error(`Missing ${locale} duetOnboarding message: ${key}`)
        return node
      }

      expect(resolve(PURPOSE_GOAL_SENTENCE_KEY)).toContain('{goal}')
      for (const goal of ONBOARDING_GOALS) {
        resolve(goalLabelKey(goal.id))
        // Three broad goals leave the tile grid roomy enough for a subtitle,
        // so every preset now owes one — the custom tile is no longer the
        // only two-line tile.
        resolve(goalDescriptionKey(goal.id))
        for (const question of goal.questions) {
          resolve(questionTitleKey(goal.id, question.id))
          expect(resolve(questionSentenceKey(goal.id, question.id))).toContain('{answer}')
          for (const chipId of question.chipIds) resolve(chipLabelKey(goal.id, question.id, chipId))
        }
      }
    })
  }
})
