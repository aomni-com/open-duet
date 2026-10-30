import { expect, test } from 'bun:test'

import { SessionInitialHistorySnapshotSchema } from '@repo/contract'

import { assertRelayPreviewHistory } from './staging-live-relay-previews.ts'

const marker = '[truncated — 350 KB total]'

function history(
  chunk = marker,
  result: unknown = { stdout: marker, exitCode: 0 },
  input = { definition: { prompt: marker } },
  options: { status?: string; output?: Array<{ type: 'text'; text: string }> } = {},
) {
  return SessionInitialHistorySnapshotSchema.parse({
    events: [
      {
        seq: 1,
        createdAt: 1,
        event: {
          type: 'step',
          step: {
            type: 'tool_call',
            toolCallId: 'call1',
            toolName: 'create_state_machine_definition',
            input,
            ...(options.output === undefined ? {} : { output: options.output }),
            isError: false,
          },
        },
      },
      {
        seq: 2,
        createdAt: 2,
        event: {
          type: 'task_started',
          task: {
            id: 'task1',
            kind: 'tool',
            name: 'emit_large_relay_output',
            label: 'large output',
            ownerScopeId: 'turn1',
            status: 'running',
            startedAt: 2,
          },
        },
      },
      { seq: 3, createdAt: 3, event: { type: 'task_output', taskId: 'task1', chunk } },
      {
        seq: 4,
        createdAt: 4,
        event: {
          type: 'task_settled',
          settlement: {
            id: 'task1',
            status: 'completed',
            settledAt: 4,
            result,
          },
        },
      },
      {
        seq: 5,
        createdAt: 5,
        event: { type: 'complete', status: options.status ?? 'completed', result: 'done' },
      },
    ],
  })
}

test('relay preview acceptance rejects untrimmed task output', () => {
  expect(() => assertRelayPreviewHistory(history('x'.repeat(350 * 1024)))).toThrow(
    'task output exceeds 1 KiB',
  )
})

test('relay preview acceptance requires marked previews and prompt completion', () => {
  expect(() => assertRelayPreviewHistory(history())).not.toThrow()
  expect(() => assertRelayPreviewHistory(history(marker, { stdout: 'x'.repeat(2048) }))).toThrow(
    'task result exceeds 1 KiB',
  )
  expect(() => assertRelayPreviewHistory(history('é'.repeat(520)))).toThrow(
    'task output exceeds 1 KiB',
  )
  expect(() => assertRelayPreviewHistory(history('silently lost output'))).toThrow(
    'task output lacks a truncation marker',
  )
  expect(() =>
    assertRelayPreviewHistory(
      history(marker, { stdout: marker }, { definition: { prompt: 'x'.repeat(2048) } }),
    ),
  ).toThrow('tool input exceeds 1 KiB')
  const incomplete = history()
  incomplete.events.pop()
  expect(() => assertRelayPreviewHistory(incomplete)).toThrow('completion did not follow')
  const slow = history()
  slow.events.at(-1)!.createdAt = 180_000
  expect(() => assertRelayPreviewHistory(slow)).toThrow('completion stalled')
})

test('relay preview acceptance rejects oversized machine-history diagnostics', () => {
  const untrimmed = history()
  const machineRow = SessionInitialHistorySnapshotSchema.parse({
    events: [
      {
        seq: 5,
        createdAt: 4,
        event: {
          type: 'state_machine',
          stateMachine: {
            definition: { name: 'preview', states: [] },
            prompt: '',
            createdAt: 1,
            updatedAt: 4,
            history: [
              {
                type: 'state_completed',
                timestamp: 4,
                state: 'emit_large_relay_output',
                output: { stdout: 'x'.repeat(350 * 1024) },
              },
            ],
          },
        },
      },
    ],
  }).events[0]!
  untrimmed.events.splice(4, 0, { ...machineRow, seq: 5 })
  untrimmed.events.at(-1)!.seq = 6
  expect(() => assertRelayPreviewHistory(untrimmed)).toThrow('machine history output exceeds 1 KiB')
})

test('relay preview acceptance rejects failed turns and oversized tool output', () => {
  for (const status of ['failed', 'cancelled']) {
    expect(() =>
      assertRelayPreviewHistory(history(undefined, undefined, undefined, { status })),
    ).toThrow('relay turn did not complete successfully')
  }
  expect(() =>
    assertRelayPreviewHistory(
      history(undefined, undefined, undefined, {
        output: [{ type: 'text', text: 'x'.repeat(2048) }],
      }),
    ),
  ).toThrow('tool output exceeds 1 KiB')
})
