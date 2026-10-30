import { expect, test } from 'bun:test'

import type { AgentTurnQuestion } from '@repo/contract'

import {
  serializeSessionQuestionAnswers,
  supportsQuestionOptionPanel,
} from './session-question-answer'

const questions: AgentTurnQuestion[] = [
  {
    header: 'Deployment target',
    question: 'Where should this run?',
    options: [{ label: 'Staging' }, { label: 'Production' }],
  },
  {
    header: 'Release checks',
    question: 'Which checks should run?',
    options: [{ label: 'Typecheck' }, { label: 'Lint' }],
    multiSelect: true,
  },
]

test('serializes compose-bar selections for the existing free-text answer transport', () => {
  expect(
    serializeSessionQuestionAnswers(questions, [
      { questionIndex: 0, optionIndexes: [0] },
      { questionIndex: 1, optionIndexes: [1, 0] },
    ]),
  ).toBe('Deployment target: Staging\nRelease checks: Typecheck, Lint')
})

test('keeps free-text-only questions on the existing compose-bar answer path', () => {
  expect(supportsQuestionOptionPanel([{ question: 'Who owns this?', options: [] }])).toBeFalse()
  expect(
    supportsQuestionOptionPanel([...questions, { question: 'Anything else?', options: [] }]),
  ).toBeFalse()
  expect(supportsQuestionOptionPanel(questions)).toBeTrue()
})
