import { describe, expect, test } from 'bun:test'

import { FileHistoryResponseSchema, SessionInitialHistorySnapshotSchema } from '@repo/contract'

import {
  attachmentCardCompletion,
  filesOnlyInputDelivered,
  hasAttributedBrowserWrite,
  terminalResultIncludes,
} from './staging-live-chat-attachments.ts'

describe('chat attachments staging journey oracles', () => {
  test('waits for the completion signal each composer card actually renders', () => {
    expect(attachmentCardCompletion('file')).toEqual({ visible: 'Ready' })
    expect(attachmentCardCompletion('inline-image')).toEqual({ hidden: 'Preparing' })
  })

  test('requires the completed agent result itself to carry the attachment marker', () => {
    const history = SessionInitialHistorySnapshotSchema.parse({
      events: [
        {
          seq: 3,
          createdAt: 3,
          event: { type: 'complete', status: 'completed', result: 'The brief says ORCHID-731.' },
        },
      ],
    })

    expect(terminalResultIncludes(history, 'ORCHID-731')).toBe(true)
    expect(terminalResultIncludes(history, 'different-marker')).toBe(false)
    const failed = SessionInitialHistorySnapshotSchema.parse({
      events: history.events.map(row => ({
        ...row,
        event: { ...row.event, status: 'failed' },
      })),
    })
    expect(terminalResultIncludes(failed, 'ORCHID-731')).toBe(false)
  })

  test('requires an exact-path write resolved to the browser user', () => {
    const history = FileHistoryResponseSchema.parse({
      items: [
        {
          seq: 9,
          event: {
            kind: 'write',
            path: 'agents/research/uploads/brief.txt',
            actor: 'web:user-1',
            userId: 'user-1',
            at: 9,
          },
        },
      ],
      nextCursor: null,
    })

    expect(hasAttributedBrowserWrite(history, 'agents/research/uploads/brief.txt', 'user-1')).toBe(
      true,
    )
    expect(hasAttributedBrowserWrite(history, 'agents/research/uploads/brief.txt', 'user-2')).toBe(
      false,
    )
    expect(hasAttributedBrowserWrite(history, 'agents/research/uploads/other.txt', 'user-1')).toBe(
      false,
    )
    for (const change of [{ actor: 'session:fixture' }, { kind: 'read' }]) {
      const differentEvent = FileHistoryResponseSchema.parse({
        ...history,
        items: history.items.map(row => ({ ...row, event: { ...row.event, ...change } })),
      })
      expect(
        hasAttributedBrowserWrite(differentEvent, 'agents/research/uploads/brief.txt', 'user-1'),
      ).toBe(false)
    }
  })

  test('recognizes a message that carried a file and no words', () => {
    const history = (prompt: string) =>
      SessionInitialHistorySnapshotSchema.parse({
        events: [
          {
            seq: 4,
            createdAt: 4,
            event: {
              type: 'prompt_submitted',
              prompt,
              inputKind: 'message',
              behavior: 'steer',
              sender: { kind: 'user', userId: 'user-1' },
              attachments: [
                { path: 'agents/research/uploads/only.txt', name: 'only.txt', bytes: 9 },
              ],
            },
          },
        ],
      })

    expect(filesOnlyInputDelivered(history(''), 'agents/research/uploads/only.txt')).toBe(true)
    expect(
      filesOnlyInputDelivered(history('also read this'), 'agents/research/uploads/only.txt'),
    ).toBe(false)
    expect(filesOnlyInputDelivered(history(''), 'agents/research/uploads/other.txt')).toBe(false)
  })
})
