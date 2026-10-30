import { describe, expect, test } from 'bun:test'

import type { AgentEventAttachment, SessionInputSender, SessionTimelineEntry } from '@repo/contract'

import { DEMO_USER_SENDER, TRANSCRIPT_EVENTS, TRANSCRIPT_SNAPSHOT } from './fixtures'
import { createIncrementalSessionProjector, projectSession } from './index'

const EMPTY_TOKEN_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

describe('session event projection', () => {
  test('projects a growing live-token tail with linear reported event count and replay-equivalent output', () => {
    const durableEvents: SessionTimelineEntry[] = [
      { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
    ]
    const snapshot = { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 1 }
    const projector = createIncrementalSessionProjector()
    const frames: Array<{
      cursor: number
      correlationId: string
      event: SessionTimelineEntry['event']
    }> = []
    let processedEvents = 0
    let incremental = projector.project({ snapshot, durableEvents, ephemeralFrames: frames })
    processedEvents += incremental.processedEvents
    for (let index = 0; index < 200; index += 1) {
      frames.push({
        cursor: 1,
        correlationId: `token:${index}`,
        event: { type: 'step', step: { type: 'text_delta', delta: String(index % 10) } },
      })
      incremental = projector.project({ snapshot, durableEvents, ephemeralFrames: frames })
      processedEvents += incremental.processedEvents
    }

    expect(incremental.projection).toEqual(
      projectSession({ snapshot, durableEvents, ephemeralFrames: frames }),
    )
    expect(processedEvents).toBeLessThanOrEqual(durableEvents.length + frames.length)
  })

  /* The task list is the row's, never rebuilt from events. The control plane
     writes the row's todos in the same mutation that appends the todos event,
     so the row is never older than the journal — but the history the browser
     holds can be (a load that stopped short, a gap), and a stale replayed
     value must never outrank a finished row. */
  test('the row outranks a replay that has not caught up to it', () => {
    const snapshot = {
      ...TRANSCRIPT_SNAPSHOT,
      lastEventSeq: 10,
      todos: [{ id: 'a', content: 'Remove the old ZIP', status: 'completed' as const }],
    }
    const durableEvents: SessionTimelineEntry[] = [
      { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
      {
        seq: 2,
        createdAt: 2,
        event: {
          type: 'todos',
          todos: [{ id: 'a', content: 'Remove the old ZIP', status: 'in_progress' }],
        },
      },
    ]
    expect(projectSession({ snapshot, durableEvents }).todos).toEqual([
      { id: 'a', content: 'Remove the old ZIP', status: 'completed' },
    ])
  })

  test('a replay that has run ahead of the row still shows the row', () => {
    const snapshot = {
      ...TRANSCRIPT_SNAPSHOT,
      lastEventSeq: 1,
      todos: [{ id: 'a', content: 'Remove the old ZIP', status: 'pending' as const }],
    }
    const durableEvents: SessionTimelineEntry[] = [
      { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
      {
        seq: 2,
        createdAt: 2,
        event: {
          type: 'todos',
          todos: [{ id: 'a', content: 'Remove the old ZIP', status: 'in_progress' }],
        },
      },
    ]
    expect(projectSession({ snapshot, durableEvents }).todos).toEqual([
      { id: 'a', content: 'Remove the old ZIP', status: 'pending' },
    ])
  })

  test('updates snapshot todos when history and live frames stay unchanged', () => {
    const projector = createIncrementalSessionProjector()
    const durableEvents: SessionTimelineEntry[] = []
    const initial = {
      ...TRANSCRIPT_SNAPSHOT,
      lastEventSeq: 0,
      todos: [{ id: 'first', content: 'First snapshot', status: 'pending' as const }],
    }
    projector.project({ snapshot: initial, durableEvents })

    const updated = projector.project({
      snapshot: {
        ...initial,
        todos: [{ id: 'second', content: 'Updated snapshot', status: 'in_progress' as const }],
      },
      durableEvents,
    })

    expect(updated.projection.todos).toEqual([
      { id: 'second', content: 'Updated snapshot', status: 'in_progress' },
    ])
  })

  test('carries submitted attachments onto every durable input kind without inventing an empty list', () => {
    const attachments = [
      {
        path: 'agents/research/uploads/release-notes.pdf',
        name: 'release-notes.pdf',
        bytes: 84_203,
        mimeType: 'application/pdf',
      },
    ] satisfies AgentEventAttachment[]
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 4 },
      durableEvents: [
        {
          seq: 1,
          createdAt: 11,
          event: {
            type: 'prompt_submitted',
            prompt: 'Review this.',
            inputKind: 'message',
            behavior: 'steer',
            sender: DEMO_USER_SENDER,
            attachments,
          },
        },
        {
          seq: 2,
          createdAt: 12,
          event: {
            type: 'note_submitted',
            note: 'Keep this with the record.',
            sender: DEMO_USER_SENDER,
            attachments,
          },
        },
        {
          seq: 3,
          createdAt: 13,
          event: {
            type: 'answer_submitted',
            answer: 'Use the attached version.',
            sender: DEMO_USER_SENDER,
            attachments,
          },
        },
        {
          seq: 4,
          createdAt: 14,
          event: {
            type: 'prompt_submitted',
            prompt: 'No files here.',
            inputKind: 'message',
            behavior: 'steer',
            sender: DEMO_USER_SENDER,
          },
        },
      ],
    })

    expect(projected.messages.slice(0, 3)).toEqual([
      expect.objectContaining({ source: 'prompt', attachments }),
      expect.objectContaining({ source: 'note', attachments }),
      expect.objectContaining({ source: 'answer', attachments }),
    ])
    expect(projected.messages[3]).not.toHaveProperty('attachments')
  })

  test('carries every durable sender variant onto its prompt, note, and answer frame', () => {
    const senders: SessionInputSender[] = [
      { kind: 'user', userId: 'user_ada' },
      { kind: 'app', appId: 'app_calendar' },
      { kind: 'session', sessionId: 'session_ops' },
      { kind: 'system' },
    ]

    for (const sender of senders) {
      const projected = projectSession({
        snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 3 },
        durableEvents: [
          {
            seq: 1,
            createdAt: 11,
            event: {
              type: 'prompt_submitted',
              prompt: 'Run the release checks.',
              inputKind: 'message',
              behavior: 'steer',
              sender,
            },
          },
          {
            seq: 2,
            createdAt: 12,
            event: { type: 'note_submitted', note: 'Customer approved.', sender },
          },
          {
            seq: 3,
            createdAt: 13,
            event: { type: 'answer_submitted', answer: 'Production', sender },
          },
        ],
      })

      expect(projected.messages).toEqual([
        {
          id: 'event:1',
          role: 'input',
          source: 'prompt',
          text: 'Run the release checks.',
          sender,
          createdAt: 11,
        },
        {
          id: 'event:2',
          role: 'input',
          source: 'note',
          text: 'Customer approved.',
          sender,
          createdAt: 12,
        },
        {
          id: 'event:3',
          role: 'input',
          source: 'answer',
          text: 'Production',
          sender,
          createdAt: 13,
        },
      ])
    }
  })

  test('projects a mid-turn user prompt as AI, user, AI authored messages', () => {
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 7 },
      durableEvents: [
        TRANSCRIPT_EVENTS[0]!,
        { seq: 2, createdAt: 2, event: { type: 'turn_started' } },
        {
          seq: 3,
          createdAt: 3,
          event: { type: 'step', step: { type: 'text', text: 'I am checking the logs.' } },
        },
        {
          seq: 4,
          createdAt: 4,
          event: {
            type: 'prompt_submitted',
            prompt: 'Check the API too.',
            inputKind: 'message',
            behavior: 'steer',
            sender: DEMO_USER_SENDER,
          },
        },
        {
          seq: 5,
          createdAt: 5,
          event: {
            type: 'todos',
            todos: [{ id: 'api', content: 'Check API logs', status: 'in_progress' }],
          },
        },
        {
          seq: 6,
          createdAt: 6,
          event: { type: 'step', step: { type: 'reasoning', text: 'The API is correlated.' } },
        },
        {
          seq: 7,
          createdAt: 7,
          event: {
            type: 'step',
            step: { type: 'text', text: 'The API failed for the same reason.' },
          },
        },
      ],
    })

    expect(projected.messages).toEqual([
      {
        id: 'agent:event:2',
        role: 'agent',
        finalized: true,
        createdAt: 2,
        parts: [
          {
            kind: 'text',
            id: 'event:3',
            text: 'I am checking the logs.',
          },
        ],
      },
      {
        id: 'event:4',
        role: 'input',
        source: 'prompt',
        text: 'Check the API too.',
        sender: DEMO_USER_SENDER,
        createdAt: 4,
      },
      {
        id: 'agent:event:5',
        role: 'agent',
        finalized: false,
        createdAt: 5,
        parts: [
          {
            kind: 'reasoning',
            id: 'event:6',
            text: 'The API is correlated.',
          },
          {
            kind: 'text',
            id: 'event:7',
            text: 'The API failed for the same reason.',
          },
        ],
      },
    ])
  })

  test('an agent first message opens the transcript as a finalized agent message', () => {
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 3 },
      durableEvents: [
        {
          seq: 1,
          createdAt: 1,
          event: {
            type: 'session_created',
            prompt: 'acme.com',
            createdAt: '2026-08-13T00:00:00.000Z',
          },
        },
        {
          seq: 2,
          createdAt: 2,
          event: {
            type: 'agent_message',
            message: 'Hi — who should we look at first?',
            createdAt: '2026-08-13T00:00:00.000Z',
          },
        },
        {
          seq: 3,
          createdAt: 3,
          event: {
            type: 'prompt_submitted',
            prompt: 'acme.com',
            inputKind: 'initial',
            behavior: 'steer',
            sender: DEMO_USER_SENDER,
          },
        },
      ],
    })
    expect(projected.messages).toEqual([
      {
        id: 'agent-message:event:2',
        role: 'agent',
        finalized: true,
        createdAt: 2,
        parts: [{ kind: 'text', id: 'event:2', text: 'Hi — who should we look at first?' }],
      },
      {
        id: 'event:3',
        role: 'input',
        source: 'prompt',
        text: 'acme.com',
        sender: DEMO_USER_SENDER,
        createdAt: 3,
      },
    ])
  })

  test('an unknown-typed event renders nothing — never a phantom agent bubble', () => {
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 2 },
      durableEvents: [
        {
          seq: 1,
          createdAt: 1,
          event: { type: 'from_the_future', payload: true },
        },
        {
          seq: 2,
          createdAt: 2,
          event: {
            type: 'prompt_submitted',
            prompt: 'still here',
            inputKind: 'message',
            behavior: 'steer',
            sender: DEMO_USER_SENDER,
          },
        },
      ],
    })
    expect(projected.messages).toEqual([
      {
        id: 'event:2',
        role: 'input',
        source: 'prompt',
        text: 'still here',
        sender: DEMO_USER_SENDER,
        createdAt: 2,
      },
    ])
  })

  test('keeps visible runner parts in source order without exposing runtime tasks', () => {
    const events: SessionTimelineEntry[] = [
      { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
      { seq: 2, createdAt: 2, event: { type: 'step', step: { type: 'text', text: 'Result' } } },
      {
        seq: 3,
        createdAt: 3,
        event: { type: 'step', step: { type: 'reasoning', text: 'Evidence' } },
      },
      {
        seq: 4,
        createdAt: 4,
        event: {
          type: 'step',
          step: {
            type: 'tool_call_start',
            toolName: 'read_file',
            toolCallId: 'tool-1',
            input: { path: 'README.md' },
          },
        },
      },
      {
        seq: 5,
        createdAt: 5,
        event: {
          type: 'step',
          step: {
            type: 'tool_call',
            toolName: 'read_file',
            toolCallId: 'tool-1',
            input: { path: 'README.md' },
            details: { durationMs: 4 },
            output: [{ type: 'text', text: 'contents' }],
            isError: false,
          },
        },
      },
      {
        seq: 6,
        createdAt: 6,
        event: { type: 'step', step: { type: 'system', message: 'Compacted context' } },
      },
      {
        seq: 7,
        createdAt: 7,
        event: { type: 'system', level: 'warn', message: 'Retrying provider' },
      },
      {
        seq: 8,
        createdAt: 8,
        event: {
          type: 'task_started',
          task: {
            id: 't1',
            kind: 'tool',
            name: 'index',
            label: 'Index files',
            ownerScopeId: 'turn-1',
            status: 'running',
            startedAt: 8,
          },
        },
      },
      { seq: 9, createdAt: 9, event: { type: 'task_output', taskId: 't1', chunk: 'halfway' } },
      {
        seq: 10,
        createdAt: 10,
        event: {
          type: 'task_settled',
          settlement: { id: 't1', status: 'completed', settledAt: 10, result: 'indexed' },
        },
      },
      {
        seq: 11,
        createdAt: 11,
        event: {
          type: 'ask',
          questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }],
        },
      },
    ]
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: events.length },
      durableEvents: events,
    })

    expect(projected.messages).toHaveLength(1)
    expect(projected.messages[0]).toEqual({
      id: 'agent:event:1',
      role: 'agent',
      finalized: true,
      createdAt: 1,
      finalizedAt: 11,
      parts: [
        { kind: 'text', id: 'event:2', text: 'Result' },
        { kind: 'reasoning', id: 'event:3', text: 'Evidence' },
        {
          kind: 'tool',
          id: 'event:5',
          toolCallId: 'tool-1',
          name: 'read_file',
          input: { path: 'README.md' },
          details: { durationMs: 4 },
          output: [{ type: 'text', text: 'contents' }],
          status: 'complete',
        },
        { kind: 'system', id: 'event:6', source: 'step', message: 'Compacted context' },
        {
          kind: 'system',
          id: 'event:7',
          source: 'runner',
          level: 'warn',
          message: 'Retrying provider',
        },
        {
          kind: 'ask',
          id: 'event:11',
          questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }],
        },
      ],
    })
  })

  /* Any MCP server's prefix decodes, not one hardcoded name — and the decoder
     is total, so nothing here consults a list of servers that exist. */
  test('splits every namespaced tool name into its server and its tool', () => {
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 4 },
      durableEvents: [
        { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
        {
          seq: 2,
          createdAt: 2,
          event: {
            type: 'step',
            step: {
              type: 'tool_call',
              toolName: 'integrations__COMPOSIO_SEARCH_TOOLS',
              toolCallId: 'tool-catalog',
              output: [{ type: 'text', text: 'tools found' }],
              isError: false,
            },
          },
        },
        {
          // The split is on the FIRST separator, so a tool whose own name
          // carries `__` still resolves to one server and the whole tool.
          seq: 3,
          createdAt: 3,
          event: {
            type: 'step',
            step: {
              type: 'tool_call',
              toolName: 'acme_internal__search__orders',
              toolCallId: 'tool-custom',
              output: [{ type: 'text', text: 'four orders' }],
              isError: false,
            },
          },
        },
        {
          seq: 4,
          createdAt: 4,
          event: {
            type: 'step',
            step: {
              type: 'tool_call',
              toolName: 'read_file',
              toolCallId: 'tool-builtin',
              output: [{ type: 'text', text: 'contents' }],
              isError: false,
            },
          },
        },
      ],
    })

    const message = projected.messages[0]
    if (message?.role !== 'agent') throw new Error('expected an agent message')
    expect(
      message.parts.map(part =>
        part.kind === 'tool' ? { name: part.name, server: part.server } : part.kind,
      ),
    ).toEqual([
      { name: 'COMPOSIO_SEARCH_TOOLS', server: 'integrations' },
      { name: 'search__orders', server: 'acme_internal' },
      { name: 'read_file', server: undefined },
    ])
  })

  /* `details.mcpServer` only arrives on `tool_call`; naming the server from the
     name means the chip is right from the first frame instead of flickering
     in mid-turn. */
  test('names the server from the first streaming frame, before details exist', () => {
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 2 },
      durableEvents: [
        { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
        {
          seq: 2,
          createdAt: 2,
          event: {
            type: 'step',
            step: {
              type: 'tool_call_start',
              toolName: 'integrations__COMPOSIO_SEARCH_TOOLS',
              toolCallId: 'tool-1',
              input: { query: 'github' },
            },
          },
        },
      ],
    })

    const message = projected.messages[0]
    if (message?.role !== 'agent') throw new Error('expected an agent message')
    const part = message.parts[0]
    if (part?.kind !== 'tool') throw new Error('expected a tool part')
    expect(part.name).toBe('COMPOSIO_SEARCH_TOOLS')
    expect(part.server).toBe('integrations')
    expect(part.status).toBe('running')
  })

  test('keeps the public subagent tool call without exposing child-authored steps', () => {
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 5 },
      durableEvents: [
        { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
        {
          seq: 2,
          createdAt: 2,
          event: {
            type: 'step',
            step: {
              type: 'tool_call_start',
              toolName: 'spawn_agent',
              toolCallId: 'spawn-1',
              input: { prompt: 'Inspect the release.' },
            },
          },
        },
        {
          seq: 3,
          createdAt: 3,
          event: {
            type: 'step',
            origin: { taskId: 't1' },
            step: { type: 'reasoning', text: 'Child-only reasoning' },
          },
        },
        {
          seq: 4,
          createdAt: 4,
          event: {
            type: 'step',
            origin: { taskId: 't1' },
            step: { type: 'text', text: 'Child-only report' },
          },
        },
        {
          seq: 5,
          createdAt: 5,
          event: {
            type: 'step',
            step: {
              type: 'tool_call',
              toolName: 'spawn_agent',
              toolCallId: 'spawn-1',
              input: { prompt: 'Inspect the release.' },
              output: [{ type: 'text', text: 'Release is ready.' }],
              isError: false,
            },
          },
        },
      ],
    })

    expect(projected.messages).toEqual([
      expect.objectContaining({
        role: 'agent',
        parts: [
          {
            kind: 'tool',
            id: 'event:5',
            toolCallId: 'spawn-1',
            name: 'spawn_agent',
            status: 'complete',
            input: { prompt: 'Inspect the release.' },
            output: [{ type: 'text', text: 'Release is ready.' }],
          },
        ],
      }),
    ])
  })

  test('keeps adjacent prompt, note, and answer inputs as distinct user messages', () => {
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 4 },
      durableEvents: [
        {
          seq: 1,
          createdAt: 1,
          event: {
            type: 'prompt_submitted',
            prompt: 'Deploy it.',
            inputKind: 'message',
            behavior: 'steer',
            sender: DEMO_USER_SENDER,
          },
        },
        {
          seq: 2,
          createdAt: 2,
          event: {
            type: 'note_submitted',
            note: 'Customer approved.',
            sender: DEMO_USER_SENDER,
          },
        },
        {
          seq: 3,
          createdAt: 3,
          event: {
            type: 'answer_submitted',
            answer: 'Production',
            sender: DEMO_USER_SENDER,
          },
        },
        {
          seq: 4,
          createdAt: 4,
          event: { type: 'todos', todos: [{ id: 'ship', content: 'Ship', status: 'pending' }] },
        },
      ],
    })

    expect(projected.messages).toEqual([
      expect.objectContaining({
        id: 'event:1',
        role: 'input',
        source: 'prompt',
        text: 'Deploy it.',
      }),
      expect.objectContaining({
        id: 'event:2',
        role: 'input',
        source: 'note',
        text: 'Customer approved.',
      }),
      expect.objectContaining({
        id: 'event:3',
        role: 'input',
        source: 'answer',
        text: 'Production',
      }),
    ])
  })

  test('never replaces a pending part across a user-authored boundary', () => {
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 3 },
      durableEvents: [
        { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
        {
          seq: 2,
          createdAt: 2,
          event: {
            type: 'prompt_submitted',
            prompt: 'Steer now.',
            inputKind: 'message',
            behavior: 'steer',
            sender: DEMO_USER_SENDER,
          },
        },
        {
          seq: 3,
          createdAt: 3,
          event: { type: 'step', step: { type: 'text', text: 'Canonical after steering.' } },
        },
      ],
      ephemeralFrames: [
        {
          cursor: 1,
          correlationId: 'live-before-steer',
          event: { type: 'step', step: { type: 'text_delta', delta: 'Live before steering.' } },
        },
      ],
    })

    expect(projected.messages).toEqual([
      expect.objectContaining({
        role: 'agent',
        finalized: true,
        parts: [expect.objectContaining({ kind: 'text', text: 'Live before steering.' })],
      }),
      expect.objectContaining({ role: 'input', text: 'Steer now.' }),
      expect.objectContaining({
        role: 'agent',
        finalized: false,
        parts: [expect.objectContaining({ kind: 'text', text: 'Canonical after steering.' })],
      }),
    ])
  })

  test('reconciles a tool only within its owning AI message', () => {
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 3 },
      durableEvents: [
        { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
        {
          seq: 2,
          createdAt: 2,
          event: {
            type: 'prompt_submitted',
            prompt: 'Steer before completion.',
            inputKind: 'message',
            behavior: 'steer',
            sender: DEMO_USER_SENDER,
          },
        },
        {
          seq: 3,
          createdAt: 3,
          event: {
            type: 'step',
            step: {
              type: 'tool_call',
              toolName: 'read',
              toolCallId: 'tool-1',
              isError: false,
            },
          },
        },
      ],
      ephemeralFrames: [
        {
          cursor: 1,
          correlationId: 'tool-1',
          event: {
            type: 'step',
            step: { type: 'tool_call_start', toolName: 'read', toolCallId: 'tool-1' },
          },
        },
      ],
    })

    const agentMessages = projected.messages.filter(message => message.role === 'agent')
    expect(agentMessages).toHaveLength(2)
    expect(agentMessages[0]?.parts).toEqual([
      expect.objectContaining({ kind: 'tool', toolCallId: 'tool-1', status: 'running' }),
    ])
    expect(agentMessages[1]?.parts).toEqual([
      expect.objectContaining({ kind: 'tool', toolCallId: 'tool-1', status: 'complete' }),
    ])
  })

  test('finalizes each terminal as an exact lifecycle part', () => {
    const terminalEvents: SessionTimelineEntry['event'][] = [
      { type: 'complete', status: 'failed', result: 'partial', error: 'provider failed' },
      { type: 'sleep', wakeAt: 1_800_000_000_000 },
      { type: 'interrupted', error: 'stopped by user' },
    ]

    expect(
      terminalEvents.map(
        event =>
          projectSession({
            snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 1 },
            durableEvents: [{ seq: 1, createdAt: 1, event }],
          }).messages[0],
      ),
    ).toEqual([
      {
        id: 'agent:event:1',
        role: 'agent',
        finalized: true,
        createdAt: 1,
        finalizedAt: 1,
        parts: [
          {
            kind: 'lifecycle',
            id: 'event:1',
            type: 'complete',
            status: 'failed',
            error: 'provider failed',
          },
        ],
      },
      {
        id: 'agent:event:1',
        role: 'agent',
        finalized: true,
        createdAt: 1,
        finalizedAt: 1,
        parts: [{ kind: 'lifecycle', id: 'event:1', type: 'sleep', wakeAt: 1_800_000_000_000 }],
      },
      {
        id: 'agent:event:1',
        role: 'agent',
        finalized: true,
        createdAt: 1,
        finalizedAt: 1,
        parts: [
          { kind: 'lifecycle', id: 'event:1', type: 'interrupted', error: 'stopped by user' },
        ],
      },
    ])
  })

  test('projects stable transcript prefixes at every supplied durable cursor', () => {
    const complete = projectSession({
      snapshot: TRANSCRIPT_SNAPSHOT,
      durableEvents: TRANSCRIPT_EVENTS,
    })
    for (let cursor = 0; cursor <= TRANSCRIPT_EVENTS.length; cursor += 1) {
      const prefix = TRANSCRIPT_EVENTS.slice(0, cursor)
      const connected = projectSession({ snapshot: TRANSCRIPT_SNAPSHOT, durableEvents: prefix })
      expect(connected.cursor).toBe(cursor)
      expect(
        complete.messages.slice(0, connected.messages.length).map(message => message.id),
      ).toEqual(connected.messages.map(message => message.id))
      for (const [index, message] of connected.messages.entries()) {
        const completedMessage = complete.messages[index]
        if (message.role === 'input') {
          if (completedMessage?.role !== 'input') throw new Error('user message owner changed')
          expect(message).toEqual(completedMessage)
        } else {
          if (completedMessage?.role !== 'agent') throw new Error('agent message owner changed')
          expect(completedMessage.parts.slice(0, message.parts.length)).toEqual(message.parts)
          if (message.finalized) expect(message).toEqual(completedMessage)
        }
      }
      expect(connected.todos).toEqual(TRANSCRIPT_SNAPSHOT.todos)
    }
  })

  test('deduplicates and orders durable events while stopping at a gap', () => {
    const projected = projectSession({
      snapshot: TRANSCRIPT_SNAPSHOT,
      durableEvents: [
        TRANSCRIPT_EVENTS[1]!,
        TRANSCRIPT_EVENTS[0]!,
        TRANSCRIPT_EVENTS[1]!,
        TRANSCRIPT_EVENTS[3]!,
      ],
    })
    expect(projected.cursor).toBe(2)
    expect(projected.gapAt).toBe(3)
    expect(projected.messages).toEqual([
      expect.objectContaining({
        role: 'input',
        source: 'prompt',
        text: 'Why did staging fail?',
        createdAt: TRANSCRIPT_EVENTS[1]!.createdAt,
      }),
    ])
  })

  test('projects the same durable prefix for every arrival permutation', () => {
    const prefix = TRANSCRIPT_EVENTS.slice(0, 4)
    const expected = projectSession({ snapshot: TRANSCRIPT_SNAPSHOT, durableEvents: prefix })

    for (const arrivalOrder of permutations(prefix)) {
      expect(
        projectSession({ snapshot: TRANSCRIPT_SNAPSHOT, durableEvents: arrivalOrder }),
      ).toEqual(expected)
    }
  })

  test('canonical events replace matching ephemeral deltas and tool starts', () => {
    const prefix = TRANSCRIPT_EVENTS.slice(0, 3)
    const ephemeral = projectSession({
      snapshot: TRANSCRIPT_SNAPSHOT,
      durableEvents: prefix,
      ephemeralFrames: [
        {
          cursor: 3,
          correlationId: 'text-1',
          event: { type: 'step', step: { type: 'text_delta', delta: 'The web' } },
        },
        {
          cursor: 3,
          correlationId: 'tool-1',
          event: {
            type: 'step',
            step: { type: 'tool_call_start', toolName: 'read_logs', toolCallId: 'tool-1' },
          },
        },
      ],
    })
    const ephemeralAgent = ephemeral.messages.find(message => message.role === 'agent')
    expect(ephemeralAgent?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'text', text: 'The web' }),
        expect.objectContaining({ kind: 'tool', toolCallId: 'tool-1', status: 'running' }),
      ]),
    )

    const durable = projectSession({
      snapshot: TRANSCRIPT_SNAPSHOT,
      durableEvents: TRANSCRIPT_EVENTS.slice(0, 5),
      ephemeralFrames: [
        {
          cursor: 3,
          correlationId: 'tool-1',
          event: {
            type: 'step',
            step: { type: 'tool_call_start', toolName: 'read_logs', toolCallId: 'tool-1' },
          },
        },
        {
          cursor: 4,
          correlationId: 'text-1',
          event: { type: 'step', step: { type: 'text_delta', delta: 'stale delta' } },
        },
      ],
    })
    const durableAgent = durable.messages.find(message => message.role === 'agent')
    expect(durableAgent?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'text',
          text: 'The web service is missing DATABASE_URL.',
        }),
        expect.objectContaining({ kind: 'tool', toolCallId: 'tool-1', status: 'complete' }),
      ]),
    )
    expect(durableAgent?.parts.some(part => 'pending' in part && part.pending)).toBe(false)
    expect(durableAgent?.parts.some(part => 'text' in part && part.text === 'stale delta')).toBe(
      false,
    )
  })

  test('does not blank live text, reasoning, or tools when a document patch becomes durable', () => {
    const projected = projectSession({
      snapshot: {
        ...TRANSCRIPT_SNAPSHOT,
        lastEventSeq: 2,
        followUpQueue: [{ message: 'Review the result' }],
      },
      durableEvents: [
        { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
        {
          seq: 2,
          createdAt: 2,
          event: {
            type: 'follow_up_queue',
            followUpQueue: [{ message: 'Review the result' }],
          },
        },
      ],
      ephemeralFrames: [
        {
          cursor: 1,
          correlationId: 'text',
          event: { type: 'step', step: { type: 'text_delta', delta: 'Live answer' } },
        },
        {
          cursor: 1,
          correlationId: 'reasoning',
          event: { type: 'step', step: { type: 'reasoning_delta', delta: 'Live thought' } },
        },
        {
          cursor: 1,
          correlationId: 'tool-1',
          event: {
            type: 'step',
            step: { type: 'tool_call_start', toolName: 'read', toolCallId: 'tool-1' },
          },
        },
      ],
    })

    expect(projected.messages).toEqual([
      expect.objectContaining({
        role: 'agent',
        parts: [
          expect.objectContaining({ kind: 'text', text: 'Live answer' }),
          expect.objectContaining({ kind: 'reasoning', text: 'Live thought' }),
          expect.objectContaining({ kind: 'tool', toolCallId: 'tool-1', status: 'running' }),
        ],
      }),
    ])
    expect(projected.followUpQueue).toEqual([{ message: 'Review the result' }])
  })

  test('settles streamed reasoning once the turn moves past it, without a canonical step', () => {
    // Some transports never deliver the canonical `reasoning` step (the
    // OpenAI-responses path drops `thinking_end`), so the projection may only
    // ever see deltas. Once any later part exists, that block is no longer
    // streaming and must not stay pending forever.
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 1 },
      durableEvents: [{ seq: 1, createdAt: 1, event: { type: 'turn_started' } }],
      ephemeralFrames: [
        {
          cursor: 1,
          correlationId: 'thought',
          event: { type: 'step', step: { type: 'reasoning_delta', delta: 'Weighing options' } },
        },
        {
          cursor: 1,
          correlationId: 'tool-1',
          event: {
            type: 'step',
            step: { type: 'tool_call_start', toolName: 'read', toolCallId: 'tool-1' },
          },
        },
        {
          cursor: 1,
          correlationId: 'thought-2',
          event: { type: 'step', step: { type: 'reasoning_delta', delta: 'Still thinking' } },
        },
      ],
    })

    const agent = projected.messages.find(message => message.role === 'agent')
    expect(agent?.parts).toEqual([
      // Exact shape on purpose: the settled block must have shed `pending`.
      { kind: 'reasoning', id: 'frame:thought', text: 'Weighing options' },
      expect.objectContaining({ kind: 'tool', toolCallId: 'tool-1', status: 'running' }),
      // The tail of the transcript is the only part still streaming.
      expect.objectContaining({ kind: 'reasoning', text: 'Still thinking', pending: true }),
    ])
  })

  test('retains cursor-anchored live output across unrelated durable events', () => {
    const projected = projectSession({
      snapshot: TRANSCRIPT_SNAPSHOT,
      durableEvents: TRANSCRIPT_EVENTS,
      ephemeralFrames: [
        {
          cursor: 5,
          correlationId: 'anchored',
          event: { type: 'step', step: { type: 'text_delta', delta: 'Still streaming' } },
        },
        { cursor: 6, correlationId: 'bad', event: { type: 'step', step: { type: 'not_real' } } },
      ],
    })
    expect(projected.cursor).toBe(6)
    const agent = projected.messages.find(message => message.role === 'agent')
    expect(agent?.parts).toEqual([
      expect.objectContaining({ kind: 'tool', toolCallId: 'tool-1' }),
      expect.objectContaining({ kind: 'text', text: 'The web service is missing DATABASE_URL.' }),
      expect.objectContaining({ kind: 'text', text: 'Still streaming' }),
      expect.objectContaining({ kind: 'ask' }),
    ])
  })

  test('degrades an unknown optional durable event without changing the cursor contract', () => {
    const projected = projectSession({
      snapshot: TRANSCRIPT_SNAPSHOT,
      durableEvents: [
        TRANSCRIPT_EVENTS[0]!,
        {
          seq: 2,
          createdAt: 2,
          event: { type: 'future_optional_event', payload: true },
        },
      ],
    })
    expect(projected.cursor).toBe(2)
    expect(projected.messages).toEqual([])
  })

  test('advances cursor without a gap for each supplied durable event shape', () => {
    const events: SessionTimelineEntry['event'][] = [
      { type: 'session_created', prompt: 'start', createdAt: '2026-01-01T00:00:00.000Z' },
      { type: 'turn_started' },
      { type: 'step', step: { type: 'text_delta', delta: 'draft' } },
      { type: 'step', step: { type: 'reasoning_delta', delta: 'thinking' } },
      { type: 'step', step: { type: 'text', text: 'answer' } },
      { type: 'step', step: { type: 'reasoning', text: 'reason' } },
      {
        type: 'step',
        step: { type: 'tool_call_start', toolName: 'read', toolCallId: 'tool-1' },
      },
      {
        type: 'step',
        step: {
          type: 'tool_call',
          toolName: 'read',
          toolCallId: 'tool-1',
          isError: false,
        },
      },
      { type: 'step', step: { type: 'system', message: 'tool notice' } },
      { type: 'todos', todos: [{ id: 'ship', content: 'ship', status: 'pending' }] },
      { type: 'follow_up_queue', followUpQueue: [{ message: 'next' }] },
      {
        type: 'state_machine',
        stateMachine: {
          definition: { name: 'working', prompt: 'Work.', states: [] },
          prompt: 'Work.',
          history: [],
          createdAt: 1,
          updatedAt: 1,
        },
      },
      { type: 'memory', phase: 'observation', status: 'running', message: 'Observing' },
      {
        type: 'usage',
        turnUsage: EMPTY_TOKEN_USAGE,
        usageByModel: [],
        lastMessageUsage: EMPTY_TOKEN_USAGE,
        effectiveContextWindow: 200_000,
        contextWindowUsage: { systemPrompt: 0, messages: 0, localMemory: 0, globalMemory: 0 },
      },
      { type: 'system', level: 'info', message: 'runner notice' },
      { type: 'complete', result: 'done' },
      { type: 'ask', questions: [{ question: 'Approve?', options: [] }] },
      { type: 'interrupted' },
      { type: 'sleep', wakeAt: 1_800_000_000_000 },
      { type: 'interrupt_requested', requestedAt: '2026-01-01T00:00:01.000Z' },
      {
        type: 'prompt_submitted',
        prompt: 'start',
        inputKind: 'initial',
        behavior: 'steer',
        sender: DEMO_USER_SENDER,
      },
      { type: 'note_submitted', note: 'context', sender: DEMO_USER_SENDER },
      { type: 'answer_submitted', answer: 'yes', sender: DEMO_USER_SENDER },
    ]
    for (const event of events) {
      const projected = projectSession({
        snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 1 },
        durableEvents: [{ seq: 1, createdAt: 1, event }],
      })
      expect(projected.cursor).toBe(1)
      expect(projected.gapAt).toBeUndefined()
    }
  })

  /* Transcript pages skip the task rail, so paged history has holes by
     design. Only the streamed tail — every row above the seq the pages
     delivered through — is contiguous by construction, and only there is a
     hole a gap. */
  test('holes in paged history are not gaps; a hole in the streamed tail is', () => {
    const input = (seq: number) => ({
      seq,
      createdAt: seq,
      event: {
        type: 'prompt_submitted' as const,
        prompt: `Prompt ${seq}`,
        inputKind: 'message' as const,
        behavior: 'steer' as const,
        sender: DEMO_USER_SENDER,
      },
    })
    const paged = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 7 },
      durableEvents: [input(1), input(4), input(7)],
      pagedThroughSeq: 7,
    })
    expect(paged.gapAt).toBeUndefined()
    expect(paged.cursor).toBe(7)
    expect(paged.messages.map(message => message.id)).toEqual(['event:1', 'event:4', 'event:7'])

    const streamed = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 10 },
      durableEvents: [input(1), input(4), input(7), input(8), input(10)],
      pagedThroughSeq: 7,
    })
    expect(streamed.gapAt).toBe(9)
    expect(streamed.cursor).toBe(8)
    expect(streamed.messages.map(message => message.id)).toEqual([
      'event:1',
      'event:4',
      'event:7',
      'event:8',
    ])
  })

  test('deduplicates live correlation ids while preserving their durable cursor anchors', () => {
    const projected = projectSession({
      snapshot: TRANSCRIPT_SNAPSHOT,
      durableEvents: TRANSCRIPT_EVENTS.slice(0, 2),
      ephemeralFrames: [
        {
          cursor: 2,
          correlationId: 'text-1',
          event: { type: 'step', step: { type: 'text_delta', delta: 'obsolete' } },
        },
        {
          cursor: 1,
          correlationId: 'out-of-order',
          event: { type: 'step', step: { type: 'text_delta', delta: 'wrong cursor' } },
        },
        {
          cursor: 2,
          correlationId: 'text-1',
          event: { type: 'step', step: { type: 'text_delta', delta: 'current' } },
        },
      ],
    })
    expect(projected.messages).toEqual([
      expect.objectContaining({
        role: 'agent',
        finalized: true,
        parts: [expect.objectContaining({ kind: 'text', text: 'wrong cursor' })],
      }),
      expect.objectContaining({ role: 'input', text: 'Why did staging fail?' }),
      expect.objectContaining({
        role: 'agent',
        finalized: false,
        parts: [expect.objectContaining({ kind: 'text', text: 'current', pending: true })],
      }),
    ])
  })

  test('lifts turn usage and the settle clock from the terminal event onto the agent message', () => {
    const turnUsage = {
      input: 1_200,
      output: 480,
      cacheRead: 9_000,
      cacheWrite: 300,
      totalTokens: 10_980,
      cost: { input: 0.0036, output: 0.0072, cacheRead: 0.0009, cacheWrite: 0.0011, total: 0.0128 },
    }
    const usageByModel = [
      {
        model: 'claude-sonnet-5',
        transport: { provider: 'duet-gateway' as const, billing: 'plan-covered' as const },
        usage: turnUsage,
      },
    ]
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 3 },
      durableEvents: [
        { seq: 1, createdAt: 1_700_000_010_000, event: { type: 'turn_started' } },
        {
          seq: 2,
          createdAt: 1_700_000_020_000,
          event: { type: 'step', step: { type: 'text', text: 'All checks passed.' } },
        },
        {
          seq: 3,
          createdAt: 1_700_000_092_000,
          event: { type: 'complete', status: 'completed', turnUsage, usageByModel },
        },
      ],
    })

    expect(projected.messages).toHaveLength(1)
    const message = projected.messages[0]!
    if (message.role !== 'agent') throw new Error('expected an agent message')
    expect(message.finalized).toBe(true)
    expect(message.createdAt).toBe(1_700_000_010_000)
    expect(message.finalizedAt).toBe(1_700_000_092_000)
    expect(message.turnUsage).toEqual(turnUsage)
    expect(message.usageByModel).toEqual(usageByModel)
  })

  test('a terminal event without usage leaves the agent message bare', () => {
    const projected = projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 2 },
      durableEvents: [
        { seq: 1, createdAt: 5, event: { type: 'turn_started' } },
        { seq: 2, createdAt: 9, event: { type: 'complete', status: 'completed' } },
      ],
    })
    const message = projected.messages[0]!
    if (message.role !== 'agent') throw new Error('expected an agent message')
    expect(message.finalizedAt).toBe(9)
    expect(message.turnUsage).toBeUndefined()
    expect(message.usageByModel).toBeUndefined()
  })
})

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()]

  return items.flatMap((item, index) =>
    permutations(items.filter((_, itemIndex) => itemIndex !== index)).map(rest => [item, ...rest]),
  )
}

test('a stored terminal marker (no runner state) still carries its tally onto the message', () => {
  // History rows are lean markers — no `state` field — so the projection must
  // not need the full runner terminal to lift usage.
  const turnUsage = {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
  }
  const projected = projectSession({
    snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 2 },
    durableEvents: [
      { seq: 1, createdAt: 100, event: { type: 'turn_started' } },
      { seq: 2, createdAt: 900, event: { type: 'complete', status: 'completed', turnUsage } },
    ],
  })
  const message = projected.messages[0]!
  if (message.role !== 'agent') throw new Error('expected an agent message')
  expect(message.finalizedAt).toBe(900)
  expect(message.turnUsage).toEqual(turnUsage)
})

test('reordering retained historical frames rebuilds their timeline order', () => {
  const projector = createIncrementalSessionProjector()
  const durableEvents: SessionTimelineEntry[] = [
    { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
    {
      seq: 2,
      createdAt: 2,
      event: { type: 'step', step: { type: 'reasoning_delta', delta: ' later' } },
    },
  ]
  const text = {
    cursor: 1,
    correlationId: 'text',
    event: { type: 'step', step: { type: 'text', text: 'answer' } },
  }
  const reasoning = {
    cursor: 1,
    correlationId: 'reasoning',
    event: { type: 'step', step: { type: 'reasoning_delta', delta: 'thought' } },
  }
  const args = { snapshot: TRANSCRIPT_SNAPSHOT, durableEvents }
  projector.project({ ...args, ephemeralFrames: [text, reasoning] })
  expect(projector.project({ ...args, ephemeralFrames: [reasoning, text] }).projection).toEqual(
    projectSession({ ...args, ephemeralFrames: [reasoning, text] }),
  )
})
