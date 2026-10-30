import { describe, expect, test } from 'bun:test'

import {
  AgentMessageRequestSchema,
  AgentStateMachineSessionSchema,
  isKnownTimelineEvent,
} from '../agent/index'
import { COLLECTION_PAGE_DEFAULT_LIMIT, COLLECTION_PAGE_MAX_LIMIT } from '../pagination/index'
import { ROOT_AGENT_SCOPE } from '../slug/index'
import { WORKSPACE_MEMBER_LIMIT } from '../workspaces/index'
import {
  DefaultSessionMessageRequestSchema,
  effectiveSessionCreationAudience,
  normalizeSessionActivityText,
  projectActivitySessionSummary,
  projectSessionListItem,
  projectMachine,
  normalizeGeneratedSessionTitle,
  SessionHistoryPageSchema,
  SessionInitialHistorySnapshotSchema,
  SessionHistoryQuerySchema,
  SessionInputResponseSchema,
  SessionEventResumeQuerySchema,
  SessionListQuerySchema,
  SessionChildrenQuerySchema,
  SessionChildrenCursorCodec,
  SessionListCursorCodec,
  SessionListPageSchema,
  SessionActivityResponseSchema,
  SessionSnapshotSchema,
  SessionSummarySchema,
  SessionActivityQuerySchema,
  SessionArchiveRequestSchema,
  SessionAudienceDeltaRequestSchema,
  SessionAudiencePageQuerySchema,
  SessionAudiencePageSchema,
  SessionWaitCompletedResponseSchema,
  SessionWaitPendingResponseSchema,
  SESSION_LIST_MAX_LIMIT,
  SESSION_ACTIVITY_DEFAULT_LIMIT,
  SESSION_ACTIVITY_MAX_LIMIT,
  SESSION_ACTIVITY_TEXT_MAX_SCALARS,
  SESSION_ACTIVITY_TEXT_MAX_UTF8_BYTES,
  initialSessionTitle,
  sessionTitleExcerpt,
  SetDefaultSessionRequestSchema,
  parseSessionLastEventId,
} from './index'

test('effective creation audience inserts the human creator and canonicalizes membership', () => {
  expect(effectiveSessionCreationAudience({ kind: 'human', userId: 'self' }, undefined)).toEqual({
    kind: 'workspace',
  })
  expect(
    effectiveSessionCreationAudience(
      { kind: 'human', userId: 'self' },
      { kind: 'specific', memberUserIds: ['self', 'other', 'other'] },
    ),
  ).toEqual({ kind: 'specific', memberUserIds: ['other', 'self'] })
  expect(
    effectiveSessionCreationAudience(
      { kind: 'workspace' },
      { kind: 'specific', memberUserIds: [] },
    ),
  ).toBeNull()
})

test('session audience collection and delta use strict bounded public contracts', () => {
  expect(SESSION_LIST_MAX_LIMIT).toBe(Math.min(WORKSPACE_MEMBER_LIMIT, COLLECTION_PAGE_MAX_LIMIT))
  expect(SessionAudiencePageQuerySchema.parse({})).toEqual({
    limit: COLLECTION_PAGE_DEFAULT_LIMIT,
  })
  expect(
    SessionAudiencePageQuerySchema.parse({
      cursor: 'opaque',
      limit: String(COLLECTION_PAGE_MAX_LIMIT),
    }),
  ).toEqual({
    cursor: 'opaque',
    limit: COLLECTION_PAGE_MAX_LIMIT,
  })
  expect(SessionAudiencePageQuerySchema.safeParse({ future: 'x' }).success).toBe(false)
  expect(
    SessionAudiencePageQuerySchema.safeParse({ limit: String(COLLECTION_PAGE_MAX_LIMIT + 1) })
      .success,
  ).toBe(false)
  expect(SessionAudiencePageSchema.parse({ items: [], nextCursor: null })).toEqual({
    items: [],
    nextCursor: null,
  })

  expect(SessionAudienceDeltaRequestSchema.parse({ add: ['u1'], remove: ['u2'] })).toEqual({
    add: ['u1'],
    remove: ['u2'],
  })
  const addCount = Math.floor(WORKSPACE_MEMBER_LIMIT / 2)
  const maximumDelta = {
    add: Array.from({ length: addCount }, (_, index) => `add-${index}`),
    remove: Array.from(
      { length: WORKSPACE_MEMBER_LIMIT - addCount },
      (_, index) => `remove-${index}`,
    ),
  }
  expect(SessionAudienceDeltaRequestSchema.safeParse(maximumDelta).success).toBe(true)
  for (const delta of [
    {},
    { add: [] },
    { remove: [] },
    { add: ['u1', 'u1'] },
    { add: ['u1'], remove: ['u1'] },
    {
      add: Array.from({ length: WORKSPACE_MEMBER_LIMIT + 1 }, (_, index) => `u${index}`),
    },
    { ...maximumDelta, add: [...maximumDelta.add, `add-${addCount}`] },
    { add: ['u1'], future: true },
  ]) {
    expect(SessionAudienceDeltaRequestSchema.safeParse(delta).success).toBe(false)
  }
})

test('session SSE accepts an empty query and parses only canonical ASCII Last-Event-ID values', () => {
  expect(SessionEventResumeQuerySchema.safeParse({}).success).toBe(true)
  expect(SessionEventResumeQuerySchema.safeParse({ since: '0' }).success).toBe(false)
  expect(SessionEventResumeQuerySchema.safeParse({ future: '1' }).success).toBe(false)
  expect(parseSessionLastEventId(undefined)).toEqual({ ok: true, afterSeq: 0 })
  expect(parseSessionLastEventId('0')).toEqual({ ok: true, afterSeq: 0 })
  expect(parseSessionLastEventId(String(Number.MAX_SAFE_INTEGER))).toEqual({
    ok: true,
    afterSeq: Number.MAX_SAFE_INTEGER,
  })
  for (const raw of [
    '-0',
    '00',
    '01',
    '+1',
    ' 1',
    '1 ',
    '1.0',
    '1e2',
    '0x10',
    'Infinity',
    'NaN',
    String(Number.MAX_SAFE_INTEGER + 1),
    '١',
  ]) {
    expect(parseSessionLastEventId(raw), raw).toEqual({
      ok: false,
      error: 'invalid_last_event_id',
    })
  }
})

test('archive requests choose one lifecycle and reject extra fields', () => {
  expect(SessionArchiveRequestSchema.parse({ kind: 'personal', archived: true })).toEqual({
    kind: 'personal',
    archived: true,
  })
  expect(SessionArchiveRequestSchema.parse({ kind: 'global', archived: false })).toEqual({
    kind: 'global',
    archived: false,
  })
  expect(
    SessionArchiveRequestSchema.safeParse({ kind: 'global', archived: true, private: true })
      .success,
  ).toBe(false)
  expect(SessionArchiveRequestSchema.safeParse({ archived: true }).success).toBe(false)
})

test('grouped activity uses the configured seat budget and rejects a wider request', () => {
  expect(SessionActivityQuerySchema.parse({}).limitPerAgent).toBe(SESSION_ACTIVITY_DEFAULT_LIMIT)
  expect(
    SessionActivityQuerySchema.parse({ limitPerAgent: SESSION_ACTIVITY_MAX_LIMIT }).limitPerAgent,
  ).toBe(SESSION_ACTIVITY_MAX_LIMIT)
  expect(
    SessionActivityQuerySchema.safeParse({ limitPerAgent: SESSION_ACTIVITY_MAX_LIMIT + 1 }).success,
  ).toBe(false)
})

test('activity projection owns its exact bounded row shape', () => {
  const emojiLimit = Math.min(
    SESSION_ACTIVITY_TEXT_MAX_SCALARS,
    Math.floor(SESSION_ACTIVITY_TEXT_MAX_UTF8_BYTES / 4),
  )
  const asciiLimit = Math.min(
    SESSION_ACTIVITY_TEXT_MAX_SCALARS,
    SESSION_ACTIVITY_TEXT_MAX_UTF8_BYTES,
  )
  const summary = SessionSummarySchema.parse({
    id: 'session-1',
    ...workspaceSessionProjection,
    turnStatus: 'complete',
    bucket: 'running',
    title: '🚀'.repeat(emojiLimit + 1),
    titleOrigin: 'excerpt',
    titleStatus: 'complete',
    machine: {
      definitionName: 'fallback',
      currentState: 'x'.repeat(asciiLimit + 1),
      orderedPath: [],
      activity: 'idle',
    },
    createdAt: 1,
    updatedAt: 2,
    lastEventSeq: 3,
    unread: true,
  })
  const projected = projectActivitySessionSummary(summary)

  expect(projected).toEqual({
    id: 'session-1',
    title: '🚀'.repeat(emojiLimit),
    bucket: 'running',
    updatedAt: 2,
    unread: true,
    machine: { step: 'x'.repeat(asciiLimit), activity: 'idle' },
  })
  expect(
    new TextEncoder().encode(normalizeSessionActivityText('🚀'.repeat(emojiLimit + 1))).byteLength,
  ).toBe(emojiLimit * 4)

  const listItem = projectSessionListItem(summary)
  expect(listItem.machine).toEqual({ step: 'x'.repeat(asciiLimit), activity: 'idle' })
  expect('orderedPath' in (listItem.machine ?? {})).toBe(false)
  expect(SessionListPageSchema.parse({ items: [listItem], nextCursor: null }).items).toEqual([
    listItem,
  ])
})

describe('foreground session wait responses', () => {
  test('returns one durable terminal marker or one resumable pending response', () => {
    expect(
      SessionWaitCompletedResponseSchema.parse({
        sessionId: 'session-1',
        inputSeq: 14,
        terminal: {
          seq: 21,
          createdAt: 1_785_831_000_000,
          event: { type: 'complete', status: 'failed', error: 'runner failed' },
        },
      }),
    ).toEqual({
      sessionId: 'session-1',
      inputSeq: 14,
      terminal: {
        seq: 21,
        createdAt: 1_785_831_000_000,
        event: { type: 'complete', status: 'failed', error: 'runner failed' },
      },
    })
    expect(
      SessionWaitPendingResponseSchema.parse({
        sessionId: 'session-1',
        inputSeq: 14,
        status: 'pending',
      }),
    ).toEqual({
      sessionId: 'session-1',
      inputSeq: 14,
      status: 'pending',
    })
  })
})

describe('session history tolerant read', () => {
  test('uses opaque universal pagination and keeps afterSeq as an ascending-only filter', () => {
    expect(SessionHistoryQuerySchema.parse({})).toEqual({
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
      order: 'desc',
      view: 'all',
    })
    expect(
      SessionHistoryQuerySchema.parse({
        cursor: 'opaque',
        limit: String(COLLECTION_PAGE_MAX_LIMIT),
        order: 'asc',
        afterSeq: '41',
      }),
    ).toEqual({
      cursor: 'opaque',
      limit: COLLECTION_PAGE_MAX_LIMIT,
      order: 'asc',
      afterSeq: 41,
      view: 'all',
    })
    expect(SessionHistoryQuerySchema.safeParse({ cursor: '41', before: '41' }).success).toBe(false)
    expect(SessionHistoryQuerySchema.safeParse({ before: '41' }).success).toBe(false)
    expect(SessionHistoryQuerySchema.safeParse({ afterSeq: '41' }).success).toBe(false)
    expect(SessionHistoryQuerySchema.safeParse({ order: 'desc', afterSeq: '41' }).success).toBe(
      false,
    )
    expect(SessionHistoryQuerySchema.safeParse({ order: 'asc', afterSeq: '-1' }).success).toBe(
      false,
    )
    expect(
      SessionHistoryQuerySchema.safeParse({
        order: 'asc',
        afterSeq: String(Number.MAX_SAFE_INTEGER + 1),
      }).success,
    ).toBe(false)
    expect(SessionHistoryQuerySchema.safeParse({ future: '1' }).success).toBe(false)
  })

  // Old bundles must survive event types minted after they shipped: the
  // unknown event parses opaquely, the response and its neighbors parse, and
  // readers gate on isKnownTimelineEvent (map D10).
  test('an unknown event type parses opaquely instead of failing the response', () => {
    const parsed = SessionHistoryPageSchema.parse({
      items: [
        {
          seq: 1,
          event: { type: 'session_created', prompt: 'Hi', createdAt: '2026-08-13T00:00:00Z' },
          createdAt: 1,
        },
        { seq: 2, event: { type: 'from_the_future', payload: true }, createdAt: 2 },
      ],
      nextCursor: null,
    })
    expect(parsed.items.map(entry => entry.seq)).toEqual([1, 2])
    expect(parsed.items.map(entry => isKnownTimelineEvent(entry.event))).toEqual([true, false])
    // Opaque means intact: the unknown event keeps its fields for a newer
    // reader downstream, it is just never interpreted here.
    expect(parsed.items[1]?.event).toEqual({ type: 'from_the_future', payload: true })
  })

  test('an agent first message is a first-class timeline event', () => {
    const event = {
      type: 'agent_message' as const,
      message: 'Hi — I’m your Account Researcher.',
      createdAt: '2026-08-13T00:00:00Z',
    }
    const parsed = SessionInitialHistorySnapshotSchema.parse({
      events: [{ seq: 2, event, createdAt: 2 }],
    })
    expect(parsed.events[0]?.event).toEqual(event)
  })

  test('hard-cuts collection envelopes while keeping initial snapshots unpaged', () => {
    const row = {
      seq: 1,
      event: { type: 'session_created', prompt: 'Hi', createdAt: '2026-08-13T00:00:00Z' },
      createdAt: 1,
    }
    expect(SessionHistoryPageSchema.safeParse({ events: [row] }).success).toBe(false)
    expect(
      SessionInitialHistorySnapshotSchema.safeParse({ items: [row], nextCursor: null }).success,
    ).toBe(false)
  })
})

describe('default session messages', () => {
  // The first-message carry is a default-route affordance only (map D2, D6):
  // the ordinary message route strips it as unknown-key noise.
  test('carries an agent first message on the default route alone', () => {
    expect(
      DefaultSessionMessageRequestSchema.parse({
        prompt: 'acme.com',
        agentFirstMessage: 'Hi — I’m your Account Researcher.',
      }).agentFirstMessage,
    ).toBe('Hi — I’m your Account Researcher.')
    expect(
      AgentMessageRequestSchema.parse({
        prompt: 'acme.com',
        agentFirstMessage: 'Hi — I’m your Account Researcher.',
      }),
    ).not.toHaveProperty('agentFirstMessage')
  })

  test('accepts the ordinary message shape and rejects creation-only overrides', () => {
    expect(
      DefaultSessionMessageRequestSchema.safeParse({
        prompt: 'Continue.',
        tier: 'balanced',
        behavior: 'follow_up',
      }).success,
    ).toBe(true)
    for (const extra of [{ mode: { states: [] } }, { audience: { kind: 'workspace' } }]) {
      expect(
        DefaultSessionMessageRequestSchema.safeParse({ prompt: 'Continue.', ...extra }).success,
      ).toBe(false)
    }
  })
})

describe('relay summary projection', () => {
  test('classifies one deterministic current item without treating definition order as history', () => {
    const stateMachine = AgentStateMachineSessionSchema.parse({
      definition: {
        name: 'Release relay',
        prompt: 'Build and publish.',
        states: [
          { name: 'build', kind: 'script', command: 'bun run build' },
          { name: 'review', kind: 'agent', prompt: 'Review the build.' },
          { name: 'review', kind: 'park' },
          { name: 'done', kind: 'terminal', status: 'completed' },
          { name: 'failed', kind: 'terminal', status: 'failed' },
        ],
      },
      prompt: 'Ship the release.',
      currentState: 'review',
      progress: {
        states: {
          build: { runs: 1, sleeps: 0 },
          review: { runs: 2, sleeps: 1, nextWakeAt: 2_000 },
        },
      },
      history: [],
      createdAt: 1,
      updatedAt: 2,
    })

    expect(projectMachine(stateMachine, { activity: 'sleeping', nextWakeAt: 2_000 })).toEqual({
      definitionName: 'Release relay',
      currentState: 'review',
      followingDefinitionState: 'review',
      progress: { completed: 2, total: 3 },
      orderedPath: [
        { key: 'state:0', index: 0, name: 'build', kind: 'script', phase: 'past' },
        { key: 'state:1', index: 1, name: 'review', kind: 'agent', phase: 'current' },
        { key: 'state:2', index: 2, name: 'review', kind: 'park', phase: 'past' },
        {
          key: 'state:3',
          index: 3,
          name: 'done',
          kind: 'terminal',
          phase: 'outcome',
          terminalStatus: 'completed',
        },
        {
          key: 'state:4',
          index: 4,
          name: 'failed',
          kind: 'terminal',
          phase: 'outcome',
          terminalStatus: 'failed',
        },
      ],
      activity: 'sleeping',
      nextWakeAt: 2_000,
    })
  })

  test('projects terminal and interrupted outcomes independently of turn activity', () => {
    const base = AgentStateMachineSessionSchema.parse({
      definition: {
        name: 'Reminder',
        prompt: 'Wait then remind.',
        states: [
          { name: 'wait', kind: 'timer', wakeAfterMs: '1h' },
          { name: 'done', kind: 'terminal', status: 'completed' },
        ],
      },
      prompt: 'Get milk.',
      currentState: 'done',
      history: [],
      terminal: { state: 'done', status: 'completed' },
      createdAt: 1,
      updatedAt: 2,
    })

    expect(projectMachine(base, { activity: 'idle' })).toMatchObject({
      activity: 'idle',
      outcome: 'completed',
      orderedPath: [
        expect.objectContaining({ key: 'state:0', phase: 'future' }),
        expect.objectContaining({ key: 'state:1', phase: 'current' }),
      ],
    })
    expect(
      projectMachine(
        { ...base, currentState: 'interrupted', terminal: undefined },
        { activity: 'idle' },
      ),
    ).toMatchObject({ outcome: 'interrupted' })
  })
})

describe('session titles', () => {
  test('creates a deterministic whitespace-normalized fallback excerpt', () => {
    expect(
      sessionTitleExcerpt('  Inspect\n\n the   deployment logs and explain the failure  ', 24),
    ).toBe('Inspect the deployment…')
  })

  test('normalizes model output without accepting an empty title', () => {
    expect(normalizeGeneratedSessionTitle(' “ Diagnose   deployment failures ” ')).toBe(
      'Diagnose deployment failures',
    )
    expect(normalizeGeneratedSessionTitle('   ""  ')).toBeNull()
  })
})

describe('session input acknowledgement', () => {
  test('distinguishes runner acceptance from a durably queued retry', () => {
    expect(SessionInputResponseSchema.parse({ ok: true, delivery: 'accepted' })).toEqual({
      ok: true,
      delivery: 'accepted',
    })
    expect(SessionInputResponseSchema.parse({ ok: true, delivery: 'queued' })).toEqual({
      ok: true,
      delivery: 'queued',
    })
    expect(() => SessionInputResponseSchema.parse({ accepted: true, dispatched: false })).toThrow()
  })
})

describe('session list agent scope', () => {
  test('lineage collection flags are strict at the public query boundary', () => {
    expect(SessionListQuerySchema.parse({ topLevel: 'true' })).toMatchObject({ topLevel: true })
    expect(SessionListQuerySchema.parse({ topLevel: true })).toMatchObject({ topLevel: true })
    expect(SessionListQuerySchema.safeParse({ topLevel: 'false' }).success).toBe(false)
    expect(SessionListQuerySchema.safeParse({ topLevel: false }).success).toBe(false)

    expect(SessionChildrenQuerySchema.parse({})).toEqual({
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
      archived: 'exclude',
    })
    expect(
      SessionChildrenQuerySchema.parse({ limit: '1', bucket: 'running', archived: 'only' }),
    ).toEqual({ limit: 1, bucket: 'running', archived: 'only' })
    for (const query of [
      { search: 'needle' },
      { agentId: ROOT_AGENT_SCOPE },
      { excludeDefault: 'true' },
      { recursive: 'true' },
    ]) {
      expect(SessionChildrenQuerySchema.safeParse(query).success).toBe(false)
    }
  })

  test('child cursors reject list use and a different parent binding', async () => {
    const cursor = await SessionChildrenCursorCodec.encode({
      subject: 'workspace:one:parent:alpha',
      filters: { parentSessionId: 'alpha', bucket: null, archived: 'exclude' },
      order: 'updatedAt-desc-sessionId-desc',
      position: { scannedThroughOrderKey: '0001' },
    })
    await expect(
      SessionChildrenCursorCodec.decode(cursor, {
        subject: 'workspace:one:parent:beta',
        filters: { parentSessionId: 'beta', bucket: null, archived: 'exclude' },
        order: 'updatedAt-desc-sessionId-desc',
      }),
    ).rejects.toThrow('invalid_cursor')
    await expect(
      SessionListCursorCodec.decode(cursor, {
        subject: 'workspace:one',
        filters: { topLevel: true },
        order: 'updatedAt-desc-sessionId-desc',
      }),
    ).rejects.toThrow('invalid_cursor')
  })

  test('uses the universal collection envelope and default page size', () => {
    expect(SessionListQuerySchema.parse({})).toEqual({
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
      archived: 'exclude',
    })
    expect(SessionListPageSchema.parse({ items: [], nextCursor: null, future: true })).toEqual({
      items: [],
      nextCursor: null,
    })
    expect(SessionListPageSchema.safeParse({ sessions: [], nextCursor: null }).success).toBe(false)
    expect(SessionListQuerySchema.safeParse({ future: '1' }).success).toBe(false)
  })

  test('accepts an agent scope with either archive filter', () => {
    for (const archived of ['exclude', 'only'] as const) {
      expect(
        SessionListQuerySchema.safeParse({ agentId: ROOT_AGENT_SCOPE, archived }).success,
      ).toBe(true)
    }
  })

  // Archived and active are two collections, never one. The old third option
  // asked for both at once, which no index could answer and no client could
  // produce; it is gone rather than guarded.
  test('rejects asking for archived and active together', () => {
    expect(SessionListQuerySchema.safeParse({ archived: 'include' }).success).toBe(false)
  })

  /* The route parses `Object.fromEntries(url.searchParams)`, so every value it
   sees is a string. A flag typed as the boolean `true` alone would reject
   `?excludeDefault=true` and 400 the request — the caller would look correct at
   the call site and be refused on the wire. Both spellings parse to the same
   boolean, exactly as `limit` coerces its digits. */
  test('the default-chat flag survives the trip through a query string', () => {
    const fromWire = SessionListQuerySchema.safeParse({
      agentId: ROOT_AGENT_SCOPE,
      excludeDefault: 'true',
    })
    expect(fromWire.success && fromWire.data.excludeDefault).toBe(true)

    const fromCode = SessionListQuerySchema.safeParse({
      agentId: ROOT_AGENT_SCOPE,
      excludeDefault: true,
    })
    expect(fromCode.success && fromCode.data.excludeDefault).toBe(true)

    /* Every owner has its own default, so leaving "the default" out of a
     drive-wide list would mean one row per face. Refused rather than ignored:
     a filter that silently does nothing is worse than one that is not offered. */
    expect(SessionListQuerySchema.safeParse({ excludeDefault: 'true' }).success).toBe(false)
  })

  test('pages one bucket at a time', () => {
    expect(SessionListQuerySchema.safeParse({ bucket: 'scheduled' }).success).toBe(true)
    expect(SessionListQuerySchema.safeParse({ bucket: 'fresh' }).success).toBe(false)
  })

  /* `null` is the body the product actually sends, and it is the one value a
   permissive `string | undefined` would have swallowed: an omitted key would
   read as "leave the pointer alone" while meaning "clear it". Required and
   nullable, never optional. */
  test('clearing the default alias is a value, not an omission', () => {
    expect(SetDefaultSessionRequestSchema.safeParse({ sessionId: null }).success).toBe(true)
    expect(SetDefaultSessionRequestSchema.safeParse({ sessionId: 'js7abc' }).success).toBe(true)
    expect(SetDefaultSessionRequestSchema.safeParse({}).success).toBe(false)
    expect(SetDefaultSessionRequestSchema.safeParse({ sessionId: '' }).success).toBe(false)
  })
})

const workspaceSessionProjection = {
  audience: { kind: 'workspace' as const },
  archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
  permissions: {
    send: true,
    answer: true,
    interrupt: true,
    rename: true,
    manageAudience: false,
    personalArchive: true,
    globalArchive: true,
    delete: true,
  },
}

describe('session runner documents', () => {
  test('validates the audience-aware snapshot without leaking attribution', () => {
    const requestedMachine = {
      name: 'reminder',
      prompt: 'Wait then remind.',
      states: [{ name: 'wait', kind: 'timer' as const, wakeAfterMs: '1h' }],
    }
    const snapshot = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      turnStatus: 'running' as const,
      bucket: 'running' as const,
      title: 'Reminder',
      titleOrigin: 'excerpt' as const,
      titleStatus: 'complete' as const,
      createdAt: 1,
      updatedAt: 2,
      lastEventSeq: 3,
      unread: false,
      audience: {
        kind: 'specific' as const,
        count: 1,
        preview: [
          {
            memberId: 'member-1',
            userId: 'user-1',
            name: 'Ada',
            email: 'ada@example.com',
            role: 'editor' as const,
          },
        ],
      },
      archive: {
        globalArchivedAt: null,
        personalArchivedAt: 4,
        reason: 'personal' as const,
      },
      permissions: {
        send: true,
        answer: true,
        interrupt: true,
        rename: true,
        manageAudience: true,
        personalArchive: true,
        globalArchive: true,
        delete: true,
      },
      lastDeliveredInputSeq: 1,
      requestedMachine,
      todos: [{ id: 'todo-1', content: 'Wait', status: 'in_progress' as const }],
      followUpQueue: [{ message: 'Buy eggs too.' }],
      machineState: {
        definition: { name: 'reminder', prompt: 'Wait then remind.', states: [] },
        prompt: 'Get milk.',
        history: [],
        createdAt: 1,
        updatedAt: 2,
      },
    }

    expect(SessionSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(
      SessionSnapshotSchema.parse({ ...snapshot, userId: 'attribution-only' }),
    ).not.toHaveProperty('userId')
    expect(SessionSnapshotSchema.parse({ ...snapshot, archivedAt: 99 })).not.toHaveProperty(
      'archivedAt',
    )
    expect(
      SessionSnapshotSchema.safeParse({
        ...snapshot,
        audience: { kind: 'specific', count: 0, preview: snapshot.audience.preview },
      }).success,
    ).toBe(false)
    expect(
      SessionSnapshotSchema.safeParse({
        ...snapshot,
        archive: { ...snapshot.archive, globalArchivedAt: null, reason: 'global' },
      }).success,
    ).toBe(false)
    // A declared field with the wrong shape still fails hard...
    expect(
      SessionSnapshotSchema.safeParse({
        ...snapshot,
        todos: [{ text: 'legacy', status: 'done' }],
      }).success,
    ).toBe(false)
    // ...while a field this reader does not know about is ignored rather than
    // rejected, so a browser one deploy behind the API keeps rendering its
    // sessions instead of failing the whole snapshot.
    const forwardCompatible = SessionSnapshotSchema.safeParse({ ...snapshot, latestState: {} })
    expect(forwardCompatible.success).toBe(true)
    expect(forwardCompatible.data?.title).toBe('Reminder')
  })

  test('keeps activity rows thin and tolerant while chat alone carries a preview', () => {
    const row = {
      id: 'session-1',
      title: 'Research',
      bucket: 'running' as const,
      updatedAt: 2,
      unread: true,
    }
    const parsed = SessionActivityResponseSchema.parse({
      owners: [
        {
          agentId: 'root',
          sessions: [row],
          truncated: false,
          chat: { ...row, preview: { text: 'Hello', author: { kind: 'agent' as const } } },
        },
      ],
    })
    expect(parsed.owners[0]?.sessions[0]).toEqual({
      id: 'session-1',
      title: 'Research',
      bucket: 'running',
      updatedAt: 2,
      unread: true,
    })
    expect(parsed.owners[0]?.chat?.preview?.text).toBe('Hello')
  })

  test('marks an onboarding session on the summary the client caches', () => {
    const summary = {
      id: 'session-1',
      ...workspaceSessionProjection,
      turnStatus: 'running' as const,
      bucket: 'running' as const,
      title: 'Onboarding',
      titleOrigin: 'excerpt' as const,
      titleStatus: 'complete' as const,
      createdAt: 1,
      updatedAt: 2,
      lastEventSeq: 0,
      unread: false,
    }

    // The hiding rule runs client-side too, and the optimistic cache matcher
    // only sees summaries — a server-only column would let a just-created
    // onboarding session be inserted into every open list.
    expect(SessionSummarySchema.parse({ ...summary, onboarding: true }).onboarding).toBe(true)
    expect(SessionSummarySchema.parse(summary).onboarding).toBeUndefined()
    expect(SessionSummarySchema.safeParse({ ...summary, onboarding: 'yes' }).success).toBe(false)
  })

  test('preserves a session lineage id without resolving the parent row', () => {
    const summary = {
      id: 'session-child',
      ...workspaceSessionProjection,
      turnStatus: 'running' as const,
      bucket: 'running' as const,
      title: 'Child',
      titleOrigin: 'excerpt' as const,
      titleStatus: 'complete' as const,
      createdBySessionId: 'session-deleted-parent',
      createdAt: 1,
      updatedAt: 2,
      lastEventSeq: 2,
      unread: false,
    }

    expect(SessionSummarySchema.parse(summary).createdBySessionId).toBe('session-deleted-parent')
  })

  test('accepts complete agent attribution and rejects partial identity', () => {
    const snapshot = {
      id: 'session-1',
      ...workspaceSessionProjection,
      workspaceId: 'workspace-1',
      turnStatus: 'running' as const,
      bucket: 'running' as const,
      title: 'Research',
      titleOrigin: 'excerpt' as const,
      titleStatus: 'complete' as const,
      agent: { id: 'agent-1', name: 'Research' },
      createdAt: 1,
      updatedAt: 2,
      lastEventSeq: 0,
      unread: false,
      lastDeliveredInputSeq: 0,
    }

    expect(SessionSnapshotSchema.parse(snapshot).agent).toEqual({
      id: 'agent-1',
      name: 'Research',
    })
    expect(SessionSnapshotSchema.safeParse({ ...snapshot, agent: { id: 'agent-1' } }).success).toBe(
      false,
    )
    expect(
      SessionSnapshotSchema.safeParse({ ...snapshot, agent: { name: 'Research' } }).success,
    ).toBe(false)
  })
})

test('names a session by its files when the first message is only files', () => {
  const file = (name: string) => ({ path: `uploads/${name}`, name, bytes: 1 })
  const image = { storageId: 'storage-1', mimeType: 'image/png' as const, bytes: 1 }
  expect(
    initialSessionTitle({ prompt: '  Summarize the brief  ', attachments: [file('a.pdf')] }),
  ).toBe('Summarize the brief')
  expect(
    initialSessionTitle({ prompt: '', attachments: [file('brief.pdf'), file('notes.md')] }),
  ).toBe('brief.pdf, notes.md')
  expect(initialSessionTitle({ prompt: ' ', images: [image] })).toBe('Image')
  expect(initialSessionTitle({ prompt: '', images: [image, image] })).toBe('2 images')
  expect(initialSessionTitle({ prompt: '', images: [] })).not.toMatch(/\d+ images/)
})
