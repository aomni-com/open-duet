import { expect, test } from 'bun:test'

import { bucketOf } from '@repo/contract'

import {
  INTERNAL_KEY,
  convex,
  owner,
  setSessionGlobalArchive,
  createWorkspace,
  createSession,
  relay,
  getSession,
  listEvents,
  listSessions,
  stateMachineFixture,
  turnStateWithMachine,
  terminalEvent,
  completedTurnState,
} from './test-support'

export function registerRelayPersistenceTests(): void {
  test('relayRunnerEvent rejects user event payloads', async () => {
    const workspaceId = await createWorkspace('agent-relay-reject')
    const session = await createSession(workspaceId, 'initial')

    await expect(
      relay(workspaceId, session.sessionId, {
        type: 'note_submitted',
        note: 'must enter through appendSessionNote',
        sender: { kind: 'user', userId: owner.user._id },
      }),
    ).rejects.toThrow()
  })

  test('relayRunnerEvent drops text deltas without advancing the sequence', async () => {
    const workspaceId = await createWorkspace('agent-relay-delta-drop')
    const session = await createSession(workspaceId, 'initial')
    const before = await getSession(workspaceId, session.sessionId)

    const relayed = await relay(workspaceId, session.sessionId, {
      type: 'step',
      step: { type: 'text_delta', delta: 'partial answer' },
    })

    expect(relayed).toMatchObject({ accepted: false, seq: null, lastEventSeq: 2 })
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      lastEventSeq: 2,
      updatedAt: before?.updatedAt,
    })
    expect((await listEvents(workspaceId, session.sessionId)).map(row => row.seq)).toEqual([1, 2])
  })

  test('relayRunnerEvent stores tool call starts so a mid-turn reload shows the running tool', async () => {
    const workspaceId = await createWorkspace('agent-relay-tool-start')
    const session = await createSession(workspaceId, 'initial')

    const relayed = await relay(workspaceId, session.sessionId, {
      type: 'step',
      step: {
        type: 'tool_call_start',
        toolName: 'bash',
        toolCallId: 'call-live',
        input: { command: 'sleep 600' },
      },
    })

    expect(relayed).toMatchObject({ accepted: true, seq: 3, lastEventSeq: 3 })
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)).toMatchObject({
      seq: 3,
      event: {
        type: 'step',
        step: { type: 'tool_call_start', toolName: 'bash', toolCallId: 'call-live' },
      },
    })
  })

  test('relayRunnerEvent stores final tool calls as canonical rows', async () => {
    const workspaceId = await createWorkspace('agent-relay-tool-call')
    const session = await createSession(workspaceId, 'initial')

    const relayed = await relay(workspaceId, session.sessionId, {
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: 'read_file',
        toolCallId: 'call-1',
        input: { path: 'README.md' },
        isError: false,
        output: [{ type: 'text', text: 'ok' }],
      },
    })

    expect(relayed).toMatchObject({ accepted: true, seq: 3, lastEventSeq: 3 })
    const events = await listEvents(workspaceId, session.sessionId)
    expect(events.at(-1)).toMatchObject({
      seq: 3,
      event: {
        type: 'step',
        step: { type: 'tool_call', toolName: 'read_file', isError: false },
      },
    })
  })

  test('relayRunnerEvent returns the original sequence for a repeated relay id', async () => {
    const workspaceId = await createWorkspace('agent-relay-idempotent')
    const session = await createSession(workspaceId, 'initial')
    const event = { type: 'step', step: { type: 'text', text: 'exactly once' } }

    const first = await relay(workspaceId, session.sessionId, event, 'relay-stable-1')
    const repeated = await relay(workspaceId, session.sessionId, event, 'relay-stable-1')
    // Even a differing payload settles on the receipt: the id was already
    // applied, and refusing it would strand the record for good.
    const reworded = await relay(
      workspaceId,
      session.sessionId,
      { type: 'step', step: { type: 'text', text: 'different payload' } },
      'relay-stable-1',
    )

    expect(first).toMatchObject({ accepted: true, seq: 3, lastEventSeq: 3 })
    expect(repeated).toEqual(first)
    expect(reworded).toEqual(first)
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toEqual(event)
    expect((await listEvents(workspaceId, session.sessionId)).map(row => row.seq)).toEqual([
      1, 2, 3,
    ])
  })

  test('relayRunnerEvent settles a repeated relay id whatever coverage it carries', async () => {
    const workspaceId = await createWorkspace('agent-relay-coverage-id')
    const session = await createSession(workspaceId, 'initial')
    const event = terminalEvent('complete')

    const first = await relay(
      workspaceId,
      session.sessionId,
      event,
      'relay-stable-coverage',
      5_000,
      2,
    )
    expect(
      await relay(workspaceId, session.sessionId, event, 'relay-stable-coverage', 6_000, 2),
    ).toEqual(first)
    expect(
      await relay(workspaceId, session.sessionId, event, 'relay-stable-coverage', 7_000, 3),
    ).toEqual(first)
  })

  test('relayRunnerEvent stores document patches for cursor-safe replay', async () => {
    const workspaceId = await createWorkspace('agent-relay-todos')
    const session = await createSession(workspaceId, 'initial')
    const todos = [{ id: 'todo-1', content: 'write tests', status: 'completed' }]
    const followUpQueue = [
      {
        message: 'Inspect this image next.',
        images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
      },
    ]
    const stateMachine = {
      definition: {
        name: 'durable reminder',
        prompt: 'Wait and check until done.',
        states: [
          { name: 'wait', kind: 'timer', wakeAfterMs: '1h', futureTimerField: true },
          { name: 'check', kind: 'poll', intervalMs: 60_000 },
          { name: 'approval', kind: 'park' },
          { name: 'repair', kind: 'agent', prompt: 'Use populated people records.' },
        ],
      },
      prompt: 'Remind me to get milk.',
      currentState: 'repair',
      progress: { states: { wait: { runs: 1, sleeps: 1, futureCounter: 2 } } },
      history: [
        { type: 'state_started', timestamp: 1, state: 'wait', futureAudit: true },
        {
          type: 'state_started',
          timestamp: 2,
          state: 'repair',
          execution: {
            id: 'execution-2',
            state: 'repair',
            kind: 'agent',
            fingerprint: 'a'.repeat(64),
            cwd: '/workspace/site',
            forkContext: true,
            suppliedInputKeys: ['correction', 'unreferenced'],
            renderedInputKeys: ['correction'],
            persistOverride: false,
            preview: 'Use populated people records.',
            previewTruncated: true,
            inheritedContextHash: 'b'.repeat(64),
            unchangedFrom: { id: 'execution-1', outcome: 'failed' },
          },
        },
      ],
      createdAt: 1,
      updatedAt: 2,
    }

    expect(await relay(workspaceId, session.sessionId, { type: 'todos', todos })).toMatchObject({
      accepted: true,
      seq: 3,
    })
    expect(
      await relay(workspaceId, session.sessionId, {
        type: 'follow_up_queue',
        followUpQueue,
      }),
    ).toMatchObject({ accepted: true, seq: 4 })
    const relayed = await relay(workspaceId, session.sessionId, {
      type: 'state_machine',
      stateMachine,
    })

    expect(relayed).toMatchObject({ accepted: true, seq: 5, lastEventSeq: 5 })
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      lastEventSeq: 5,
      todos,
      followUpQueue,
      machineState: stateMachine,
    })
    expect((await listEvents(workspaceId, session.sessionId)).slice(-3)).toMatchObject([
      { seq: 3, event: { type: 'todos', todos } },
      { seq: 4, event: { type: 'follow_up_queue', followUpQueue } },
      { seq: 5, event: { type: 'state_machine', stateMachine } },
    ])

    await expect(
      relay(workspaceId, session.sessionId, {
        type: 'todos',
        todos: [{ id: 'legacy', text: 'stale', status: 'done' }],
      }),
    ).rejects.toThrow()
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({ lastEventSeq: 5 })
  })

  test('relayRunnerEvent stores terminal markers without duplicating gateway runner state', async () => {
    const workspaceId = await createWorkspace('agent-terminal-marker')
    const session = await createSession(workspaceId, 'initial')
    const state = completedTurnState()

    const relayed = await relay(workspaceId, session.sessionId, {
      type: 'complete',
      state,
      status: 'completed',
      result: 'done',
    })

    expect(relayed).toMatchObject({ accepted: true, seq: 3, lastEventSeq: 3, status: 'complete' })
    const stored = await getSession(workspaceId, session.sessionId)
    expect(stored).toMatchObject({
      turnStatus: 'complete',
      lastEventSeq: 3,
    })
    expect(stored === null ? true : 'latestState' in stored).toBe(false)
    const events = await listEvents(workspaceId, session.sessionId)
    expect(events.at(-1)).toEqual({
      seq: 3,
      event: { type: 'complete', status: 'completed', result: 'done' },
      createdAt: expect.any(Number),
    })
  })

  test('the stored terminal marker keeps the turn usage tally while still dropping runner state', async () => {
    // The live stream serves the full terminal from the gateway buffer, but a
    // reload reads this stored row — if the marker drops the tally, the usage
    // readout exists only until the first refresh.
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
        transport: { provider: 'duet-gateway', billing: 'plan-covered' },
        usage: turnUsage,
      },
    ]
    const workspaceId = await createWorkspace('agent-terminal-usage')
    const session = await createSession(workspaceId, 'initial')

    await relay(workspaceId, session.sessionId, {
      type: 'complete',
      state: completedTurnState(),
      status: 'completed',
      result: 'done',
      turnUsage,
      usageByModel,
    })

    const events = await listEvents(workspaceId, session.sessionId)
    expect(events.at(-1)).toEqual({
      seq: 3,
      event: { type: 'complete', status: 'completed', result: 'done', turnUsage, usageByModel },
      createdAt: expect.any(Number),
    })
  })

  test('every row a transition touches still satisfies the bucket invariant', async () => {
    // `bucket` is materialised, so it is only ever as correct as the last writer
    // that remembered to restamp it. This drives every transition that can move
    // `status` or `machine` through the real mutations, then checks the rule
    // against every row in the workspace — including the ones the product hides,
    // because a stale bucket on a hidden row is the one nobody would notice.
    //
    // It replaces the source-reading test the slice specified. That one greps
    // `ctx.db.patch` object literals, and the most drift-prone writer builds its
    // patch across a dozen lines before calling `ctx.db.patch(id, patch)` — no
    // literal at the call site, so the writer likeliest to break is the one a
    // grep cannot see.
    const workspaceId = await createWorkspace('bucket-invariant')

    const plain = await createSession(workspaceId, 'a plain conversation')
    for (const terminal of ['complete', 'ask', 'sleep', 'interrupted'] as const) {
      const session = await createSession(workspaceId, `turn ends in ${terminal}`)
      await relay(workspaceId, session.sessionId, terminalEvent(terminal))
    }

    const machine = await createSession(workspaceId, 'a machine advancing')
    await relay(workspaceId, machine.sessionId, {
      type: 'state_machine',
      stateMachine: stateMachineFixture(),
    })
    await relay(workspaceId, machine.sessionId, {
      type: 'complete',
      status: 'completed',
      result: 'one state done',
      state: turnStateWithMachine(
        'completed',
        'completed',
        stateMachineFixture({ currentState: 'remind' }),
      ),
    })

    const finished = await createSession(workspaceId, 'a machine that finished')
    await relay(workspaceId, finished.sessionId, {
      type: 'complete',
      status: 'completed',
      state: turnStateWithMachine(
        'completed',
        'completed',
        stateMachineFixture({ currentState: 'done', terminal: { status: 'completed' } }),
      ),
    })
    // …then answered, which is the transition L1 got wrong.
    await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      workspaceId,
      sessionId: finished.sessionId,
      attemptId: 'bucket-invariant-followup',
      input: {
        sender: { kind: 'user', userId: owner.user._id },
        kind: 'message',
        prompt: 'one more thing',
        behavior: 'follow_up',
      },
    })

    await setSessionGlobalArchive(workspaceId, plain.sessionId, true)

    const rows = (await convex.query('testing/agentSessions:rawSessionsForWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{
      _id: string
      title: string
      turnStatus: string
      bucket: string
      machine?: unknown
    }>

    expect(rows.map(row => row.title).sort()).toEqual(
      [
        'a plain conversation',
        'turn ends in complete',
        'turn ends in ask',
        'turn ends in sleep',
        'turn ends in interrupted',
        'a machine advancing',
        'a machine that finished',
      ].sort(),
    )
    const wrong = rows
      .filter(row => row.bucket !== bucketOf(row as unknown as Parameters<typeof bucketOf>[0]))
      .map(row => ({ title: row.title, turnStatus: row.turnStatus, stamped: row.bucket }))
    expect(wrong).toEqual([])
  })

  test('a machine mid-run buckets as running even though its turn completed', async () => {
    const workspaceId = await createWorkspace('bucket-midrun')
    const session = await createSession(workspaceId, 'run a machine')

    // The machine starts on `wait`, then the first turn ends. `status` follows the
    // turn and goes to `complete`; the machine itself has only moved on to `remind`.
    // Grouping reads the machine, not the turn — otherwise live work reads as finished.
    await relay(workspaceId, session.sessionId, {
      type: 'state_machine',
      stateMachine: stateMachineFixture(),
    })
    await relay(workspaceId, session.sessionId, {
      type: 'complete',
      status: 'completed',
      result: 'first state done',
      state: turnStateWithMachine(
        'completed',
        'completed',
        stateMachineFixture({ currentState: 'remind' }),
      ),
    })

    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'complete',
      bucket: 'running',
    })
    expect((await listSessions(workspaceId, { bucket: 'running' })).items).toContainEqual(
      expect.objectContaining({ id: session.sessionId }),
    )
    expect((await listSessions(workspaceId, { bucket: 'done' })).items).not.toContainEqual(
      expect.objectContaining({ id: session.sessionId }),
    )
  })

  test('answering a finished job puts it back under running, not done', async () => {
    const workspaceId = await createWorkspace('bucket-followup')
    const session = await createSession(workspaceId, 'run a machine')

    // The machine reaches a terminal state: over, and bucketed `done`.
    await relay(workspaceId, session.sessionId, {
      type: 'complete',
      status: 'completed',
      state: turnStateWithMachine(
        'completed',
        'completed',
        stateMachineFixture({ currentState: 'done', terminal: { status: 'completed' } }),
      ),
    })
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({ bucket: 'done' })

    // Now follow up on it. A finished machine is a fact about the past; the
    // turn this message starts is the present, and the present is what the
    // reader is waiting on.
    await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      workspaceId,
      sessionId: session.sessionId,
      attemptId: 'bucket-followup-message',
      input: {
        sender: { kind: 'user', userId: owner.user._id },
        kind: 'message',
        prompt: 'actually, one more thing',
        behavior: 'follow_up',
      },
    })

    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'running',
      bucket: 'running',
    })
    expect((await listSessions(workspaceId, { bucket: 'running' })).items).toContainEqual(
      expect.objectContaining({ id: session.sessionId }),
    )
  })

  test('one bucket page carries jobs and conversations together, newest first', async () => {
    const workspaceId = await createWorkspace('bucket-merged')
    const conversation = await createSession(workspaceId, 'just talking')
    const job = await createSession(workspaceId, 'run a machine')

    // The conversation finishes its turn; the job's machine reaches a terminal
    // state. Two different routes to `done` — and one page has to hold both,
    // because a reader asking "what is finished" does not know or care which
    // kind of session produced it.
    await relay(workspaceId, conversation.sessionId, terminalEvent('complete'))
    await relay(workspaceId, job.sessionId, {
      type: 'complete',
      status: 'completed',
      state: turnStateWithMachine(
        'completed',
        'completed',
        stateMachineFixture({
          currentState: 'done',
          terminal: { status: 'completed' },
        }),
      ),
    })

    const done = (await listSessions(workspaceId, { bucket: 'done' })).items
    const ids = done.map(session => session.id)
    expect(ids).toContain(conversation.sessionId)
    expect(ids).toContain(job.sessionId)
    // The job moved most recently, so it leads — one ordering over one list.
    expect(ids.indexOf(job.sessionId)).toBeLessThan(ids.indexOf(conversation.sessionId))
    // Only the machine-backed one carries a relay projection; that absence is
    // the whole of what "this is a conversation" means on the wire.
    const jobRow = done.find(session => session.id === job.sessionId)
    const conversationRow = done.find(session => session.id === conversation.sessionId)
    expect(jobRow?.machine?.outcome).toBe('completed')
    expect(conversationRow?.machine).toBeUndefined()
  })
}
