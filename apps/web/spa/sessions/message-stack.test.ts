import { describe, expect, test } from 'bun:test'

import type { SessionInputSender } from '@repo/contract'

import { messageStack } from './message-stack'
import type { ProjectedMessage } from './projection'

const minute = 60_000
const noon = Date.UTC(2026, 6, 19, 12, 0)
const VIEWER: SessionInputSender = { kind: 'user', userId: 'user_1' }

function prompt(id: string, createdAt?: number): ProjectedMessage {
  return { id, role: 'input', source: 'prompt', text: id, sender: VIEWER, createdAt }
}

function agent(id: string): ProjectedMessage {
  return { id, role: 'agent', finalized: true, parts: [] }
}

function shape(messages: ProjectedMessage[]) {
  return messageStack(messages).map(
    entry => `${entry.leading ? 'L' : '-'}${entry.trailing ? 'T' : '-'}`,
  )
}

describe('message stack', () => {
  test('marks a lone message as both the head and the tail of its stack', () => {
    expect(shape([prompt('only', noon)])).toEqual(['LT'])
  })

  test('folds consecutive prompts from the same voice into one stack', () => {
    expect(
      shape([prompt('a', noon), prompt('b', noon + minute), prompt('c', noon + 2 * minute)]),
    ).toEqual(['L-', '--', '-T'])
  })

  test('breaks the stack when the voice changes', () => {
    expect(shape([prompt('a', noon), agent('b'), prompt('c', noon + minute)])).toEqual([
      'LT',
      'LT',
      'LT',
    ])
  })

  test('keeps a prompt, a note, and an answer apart even back to back', () => {
    const messages: ProjectedMessage[] = [
      prompt('p', noon),
      {
        id: 'n',
        role: 'input',
        source: 'note',
        text: 'n',
        sender: VIEWER,
        createdAt: noon + minute,
      },
      {
        id: 'a',
        role: 'input',
        source: 'answer',
        text: 'a',
        sender: VIEWER,
        createdAt: noon + 2 * minute,
      },
    ]
    expect(shape(messages)).toEqual(['LT', 'LT', 'LT'])
  })

  test('keeps two different authors apart and stacks one author’s run', () => {
    const relayed = (
      id: string,
      sender: SessionInputSender,
      createdAt: number,
    ): ProjectedMessage => ({
      id,
      role: 'input',
      source: 'prompt',
      text: id,
      sender,
      createdAt,
    })
    const ops: SessionInputSender = { kind: 'session', sessionId: 'session_ops' }

    expect(shape([prompt('mine', noon), relayed('theirs', ops, noon + minute)])).toEqual([
      'LT',
      'LT',
    ])
    expect(
      shape([
        prompt('mine', noon),
        relayed('teammate', { kind: 'user', userId: 'user_2' }, noon + minute),
      ]),
    ).toEqual(['LT', 'LT'])
    expect(shape([relayed('first', ops, noon), relayed('second', ops, noon + minute)])).toEqual([
      'L-',
      '-T',
    ])
  })

  test('starts a new stack once the gap outgrows the grouping window', () => {
    expect(shape([prompt('a', noon), prompt('b', noon + 4 * minute)])).toEqual(['LT', 'LT'])
  })

  test('stacks unclocked agent turns rather than splitting on missing data', () => {
    expect(shape([agent('a'), agent('b')])).toEqual(['L-', '-T'])
  })
})
