import { expect, test } from 'bun:test'

import {
  INTERNAL_KEY,
  convex,
  owner,
  createSessionInDir,
  createWorkspace,
  createSession,
  appendSessionNote,
  prepareRunnerInputDelivery,
  ownerEnvelope,
  rowCreatedAt,
  markRunnerInputDelivered,
  relay,
  findCoveringTerminal,
  getSession,
  listEvents,
  terminalEvent,
  runningTurnState,
  interruptedTurnState,
} from './test-support'

export function registerTerminalRecoveryTests(): void {
  test('findCoveringTerminal returns the durable terminal that accepted the input', async () => {
    const workspaceId = await createWorkspace('agent-covering-terminal')
    const session = await createSession(workspaceId, 'initial')

    await relay(
      workspaceId,
      session.sessionId,
      terminalEvent('complete'),
      'relay-covering-terminal',
      5_000,
      2,
    )

    expect(await findCoveringTerminal(workspaceId, session.sessionId, 2)).toEqual({
      seq: 3,
      event: { type: 'complete', status: 'completed', result: 'done' },
      createdAt: 5_000,
    })
  })

  test('findCoveringTerminal carries the session cwd so wait callers can resolve relative paths', async () => {
    const workspaceId = await createWorkspace('agent-covering-cwd')
    const session = await createSessionInDir(workspaceId, 'initial', 1_000, 'agents/go-to-market')

    await relay(
      workspaceId,
      session.sessionId,
      terminalEvent('complete'),
      'relay-covering-terminal-cwd',
      5_000,
      2,
    )

    expect(await findCoveringTerminal(workspaceId, session.sessionId, 2)).toEqual({
      seq: 3,
      event: { type: 'complete', status: 'completed', result: 'done' },
      createdAt: 5_000,
      cwd: 'agents/go-to-market',
    })

    // The terminal's cwd is the frame its result was authored in. A later cd
    // must not rewrite history: a delayed wait retry still resolves the
    // result's relative paths against the directory that produced them.
    await convex.mutation('domains/agentSessions/model:setSessionCwd', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      expectedCwd: 'agents/go-to-market',
      cwd: 'agents/elsewhere',
    })
    expect((await findCoveringTerminal(workspaceId, session.sessionId, 2))?.cwd).toBe(
      'agents/go-to-market',
    )
  })

  test('a terminal from an old gateway remains history but cannot cover a wait', async () => {
    const workspaceId = await createWorkspace('agent-old-relay-terminal')
    const session = await createSession(workspaceId, 'initial')

    await relay(
      workspaceId,
      session.sessionId,
      terminalEvent('complete'),
      'relay-without-coverage',
      5_000,
    )

    expect((await listEvents(workspaceId, session.sessionId)).at(-1)).toEqual({
      seq: 3,
      event: { type: 'complete', status: 'completed', result: 'done' },
      createdAt: 5_000,
    })
    expect(await findCoveringTerminal(workspaceId, session.sessionId, 2)).toBeNull()
  })

  test('findCoveringTerminal skips old coverage and returns the earliest covering marker', async () => {
    const workspaceId = await createWorkspace('agent-covering-order')
    const session = await createSession(workspaceId, 'initial')

    await relay(
      workspaceId,
      session.sessionId,
      terminalEvent('complete'),
      'relay-below-input',
      5_000,
      1,
    )
    expect(await findCoveringTerminal(workspaceId, session.sessionId, 2)).toBeNull()

    await relay(
      workspaceId,
      session.sessionId,
      terminalEvent('interrupted'),
      'relay-first-covering',
      6_000,
      2,
    )
    await relay(
      workspaceId,
      session.sessionId,
      terminalEvent('sleep'),
      'relay-later-covering',
      7_000,
      2,
    )

    expect(await findCoveringTerminal(workspaceId, session.sessionId, 2)).toMatchObject({
      seq: 4,
      event: { type: 'interrupted' },
      createdAt: 6_000,
    })
  })

  test('a storage-full refusal settles the turn instead of leaving it running', async () => {
    const workspaceId = await createWorkspace('agent-storage-full')
    const session = await createSession(workspaceId, 'write a big file')
    const initial = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: session.sessionId,
      attemptId: 'refused-by-reserve',
      input: { kind: 'initial_prompt', prompt: 'write a big file' },
    })
    await markRunnerInputDelivered(
      workspaceId,
      session.sessionId,
      initial.dispatch.attemptId,
      initial.dispatch.throughSeq,
    )

    const settled = await relay(
      workspaceId,
      session.sessionId,
      {
        type: 'system',
        level: 'error',
        message: 'Your workspace is full. Delete files to free up space, then try again.',
        metadata: { code: 'storage_full' },
      },
      'relay-storage-full',
      undefined,
      initial.dispatch.throughSeq,
    )

    expect(settled).toMatchObject({ accepted: true, status: 'interrupted' })
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })
    expect(
      await findCoveringTerminal(workspaceId, session.sessionId, initial.dispatch.throughSeq),
    ).toMatchObject({ event: { type: 'system', metadata: { code: 'storage_full' } } })

    const retry = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: session.sessionId,
      attemptId: 'after-cleanup',
      input: { kind: 'message', prompt: 'try again' },
    })
    expect(retry.dispatch.attemptId).toBe('after-cleanup')
  })

  test('delivery marking cannot reopen a bound-root terminal settled during dispatch', async () => {
    const workspaceId = await createWorkspace('agent-bound-root-delivery-race')
    const session = await createSession(workspaceId, 'continue in the bound root')
    const prepared = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: session.sessionId,
      attemptId: 'bound-root-race',
      input: { kind: 'initial_prompt', prompt: 'continue in the bound root' },
    })

    await relay(
      workspaceId,
      session.sessionId,
      {
        type: 'system',
        level: 'error',
        message: 'This session’s bound agent root is unavailable.',
        metadata: { code: 'bound_agent_root_unavailable' },
      },
      'relay-bound-root-unavailable',
      undefined,
      prepared.dispatch.throughSeq,
    )
    await markRunnerInputDelivered(
      workspaceId,
      session.sessionId,
      prepared.dispatch.attemptId,
      prepared.dispatch.throughSeq,
    )

    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
      lastDeliveredInputSeq: prepared.dispatch.throughSeq,
    })
    expect(
      await findCoveringTerminal(workspaceId, session.sessionId, prepared.dispatch.throughSeq),
    ).toMatchObject({
      event: { type: 'system', metadata: { code: 'bound_agent_root_unavailable' } },
    })
  })

  test('permanent provisioning failure consumes queued input and interrupts the session', async () => {
    const workspaceId = await createWorkspace('agent-provisioning-failed')
    const session = await createSession(workspaceId, 'run when the VM is ready')
    await convex.mutation('testing/workspaces:setWorkspaceStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      status: 'unhealthy',
    })

    await convex.mutation('testing/workspaces:terminalizeProvisioningFailureSessionsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: 5_000,
    })

    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toEqual({
      type: 'interrupted',
      status: 'interrupted',
      error: 'workspace_provisioning_failed',
    })
    const raw = (await convex.query('testing/agentSessions:rawSessionForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
    })) as {
      lastDeliveredInputSeq: number
      lastRunnerInputSeq: number
      runnerInputPending?: boolean
      deliveryAttempt?: unknown
    }
    expect(raw.lastDeliveredInputSeq).toBe(raw.lastRunnerInputSeq)
    expect(raw.runnerInputPending).toBe(false)
    expect(raw.deliveryAttempt).toBeUndefined()
    expect(
      await findCoveringTerminal(workspaceId, session.sessionId, raw.lastRunnerInputSeq),
    ).toMatchObject({
      event: { type: 'interrupted', error: 'workspace_provisioning_failed' },
      createdAt: 5_000,
    })
  })

  test('an undeliverable interrupt consumes queued input and interrupts the session', async () => {
    const workspaceId = await createWorkspace('agent-interrupt-undeliverable')
    const session = await createSession(workspaceId, 'stop this wedged turn')

    await convex.mutation('domains/agentSessions/model:finalizeUndeliverableInterrupt', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      now: 5_000,
    })

    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toEqual({
      type: 'interrupted',
      status: 'interrupted',
      error: 'interrupt_undeliverable',
    })
    // Stop means stop: a prompt still waiting for a runner must not be handed to
    // one by the next drain tick, which would re-open the turn the user killed.
    const raw = (await convex.query('testing/agentSessions:rawSessionForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
    })) as {
      lastDeliveredInputSeq: number
      lastRunnerInputSeq: number
      runnerInputPending?: boolean
      deliveryAttempt?: unknown
    }
    expect(raw.lastDeliveredInputSeq).toBe(raw.lastRunnerInputSeq)
    expect(raw.runnerInputPending).toBe(false)
    expect(raw.deliveryAttempt).toBeUndefined()
  })

  test('a discarded session consumes queued input and interrupts the session', async () => {
    const workspaceId = await createWorkspace('agent-session-discarded')
    const session = await createSession(workspaceId, 'the gateway envelope is gone')

    await convex.mutation('domains/agentSessions/model:finalizeDiscardedSession', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      now: 5_000,
    })

    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toEqual({
      type: 'interrupted',
      status: 'interrupted',
      error: 'session_discarded',
    })
    // The gateway envelope is gone, so nothing will ever deliver this input —
    // the next drain tick must not keep finding it pending.
    const raw = (await convex.query('testing/agentSessions:rawSessionForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
    })) as {
      lastDeliveredInputSeq: number
      lastRunnerInputSeq: number
      runnerInputPending?: boolean
      deliveryAttempt?: unknown
    }
    expect(raw.lastDeliveredInputSeq).toBe(raw.lastRunnerInputSeq)
    expect(raw.runnerInputPending).toBe(false)
    expect(raw.deliveryAttempt).toBeUndefined()
  })

  test('a message after turn end re-opens the turn, so a discard interrupts it visibly', async () => {
    const workspaceId = await createWorkspace('agent-discard-reopen')
    const session = await createSession(workspaceId, 'finished, then messaged')
    const initial = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: session.sessionId,
      attemptId: 'reopen-initial',
      input: { kind: 'initial_prompt', prompt: 'finished, then messaged' },
    })
    await markRunnerInputDelivered(
      workspaceId,
      session.sessionId,
      initial.dispatch.attemptId,
      initial.dispatch.throughSeq,
    )
    await relay(workspaceId, session.sessionId, terminalEvent('complete'), 'relay-reopen', 5_000)

    // The new message flips the turn back to running at queue time, so the
    // discard must take the terminalize path: the sender sees their message
    // die in a visible interrupted terminal, never silently consumed by the
    // stray-input branch.
    await prepareRunnerInputDelivery(workspaceId, {
      sessionId: session.sessionId,
      attemptId: 'reopen-message',
      input: { kind: 'message', prompt: 'are you still there?' },
    })
    await convex.mutation('domains/agentSessions/model:finalizeDiscardedSession', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      now: 6_000,
    })

    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toEqual({
      type: 'interrupted',
      status: 'interrupted',
      error: 'session_discarded',
    })
    const raw = (await convex.query('testing/agentSessions:rawSessionForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
    })) as {
      lastDeliveredInputSeq: number
      lastRunnerInputSeq: number
      runnerInputPending?: boolean
    }
    expect(raw.lastDeliveredInputSeq).toBe(raw.lastRunnerInputSeq)
    expect(raw.runnerInputPending).toBe(false)
  })

  test('a discarded session whose turn already ended still consumes queued input', async () => {
    const workspaceId = await createWorkspace('agent-discarded-done')
    const session = await createSession(workspaceId, 'turn ended, input still queued')

    // A terminal that never accepted the queued input ends the turn but leaves
    // the input pending — the prod shape of a session whose agent folder was
    // deleted while a message sat in its queue.
    await relay(
      workspaceId,
      session.sessionId,
      terminalEvent('complete'),
      'relay-done-first',
      5_000,
    )
    const before = (await convex.query('testing/agentSessions:rawSessionForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
    })) as { bucket: string; runnerInputPending?: boolean; lastEventSeq: number }
    expect(before.bucket).toBe('done')
    expect(before.runnerInputPending).toBe(true)

    await convex.mutation('domains/agentSessions/model:finalizeDiscardedSession', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      now: 6_000,
    })

    const raw = (await convex.query('testing/agentSessions:rawSessionForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
    })) as {
      turnStatus: string
      lastEventSeq: number
      lastDeliveredInputSeq: number
      lastRunnerInputSeq: number
      runnerInputPending?: boolean
      deliveryAttempt?: unknown
    }
    // The stray input dies — the next drain tick must not find this session
    // pending and 410 against the gateway forever.
    expect(raw.lastDeliveredInputSeq).toBe(raw.lastRunnerInputSeq)
    expect(raw.runnerInputPending).toBe(false)
    expect(raw.deliveryAttempt).toBeUndefined()
    // The turn's real ending stands: no second terminal, no rewrite of a
    // completed turn into an interrupted one.
    expect(raw.turnStatus).toBe('complete')
    expect(raw.lastEventSeq).toBe(before.lastEventSeq)
  })

  test('a relay-backlog report from the gateway ends the turn', async () => {
    const workspaceId = await createWorkspace('agent-relay-backlog')
    const session = await createSession(workspaceId, 'produces more than we can save')

    // Only a runner may author a terminal, so the gateway reports the fact as a
    // system event and the control plane draws the conclusion — the same owner
    // that ends a turn for a paused workspace or a deleted agent.
    await relay(workspaceId, session.sessionId, {
      type: 'system',
      level: 'error',
      message: 'This turn was stopped: its output outran what the workspace could save.',
      metadata: { code: 'relay_backlog' },
    })

    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toEqual({
      type: 'interrupted',
      status: 'interrupted',
      error: 'relay_backlog',
    })
  })

  test('a restarted turn ends cleanly: turn_started puts the session back to running', async () => {
    const workspaceId = await createWorkspace('agent-backlog-restart')
    const session = await createSession(workspaceId, 'stopped, then restarted')

    // The gateway kills an over-producing runner and reports it. True at this
    // instant: the runner is dead.
    await relay(workspaceId, session.sessionId, {
      type: 'system',
      level: 'error',
      message: 'This turn was stopped: its output outran what the workspace could save.',
      metadata: { code: 'relay_backlog' },
    })
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })

    // Once the journal drains the gateway relaunches from the checkpoint and
    // re-sends the still-accepted prompt. The fresh runner announces the
    // restart the only way it can — through the event stream — and the control
    // plane has to believe it, or the session reads as over while it works.
    await relay(workspaceId, session.sessionId, { type: 'turn_started', state: runningTurnState() })
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'running',
    })

    // The whole point: the resumed turn's own ending is accepted, instead of
    // being refused for arriving at a session the control plane had closed.
    const finished = await relay(workspaceId, session.sessionId, terminalEvent('complete'))
    expect(finished.accepted).toBe(true)
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'complete',
    })
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toMatchObject({
      type: 'complete',
      result: 'done',
    })
  })

  /* The runner is the only author of its turn's ending. A terminal the
     gateway or the control plane wrote on the runner's behalf is a guess about
     a process it cannot see; when the guess is wrong the runner keeps sending,
     every event is accepted, and refusing its real ending leaves a journal
     that took the work and dropped the conclusion. So a later terminal simply
     overrides an earlier one, whoever wrote it. */
  test("a runner's terminal is accepted after a gateway-reported ending, and overrides it", async () => {
    const workspaceId = await createWorkspace('agent-backlog-norestart')
    const session = await createSession(workspaceId, 'stopped for good')

    await relay(workspaceId, session.sessionId, {
      type: 'system',
      level: 'error',
      message: 'This turn was stopped: its output outran what the workspace could save.',
      metadata: { code: 'relay_backlog' },
    })
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })

    const late = await relay(workspaceId, session.sessionId, terminalEvent('complete'))
    expect(late.accepted).toBe(true)
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'complete',
      bucket: 'done',
    })
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toMatchObject({
      type: 'complete',
    })
  })

  test('a runner-exited report from the gateway ends the turn', async () => {
    const workspaceId = await createWorkspace('agent-runner-exited')
    const session = await createSession(workspaceId, 'crashes before answering')

    // The runner died — crash, OOM, signal — without ever authoring a
    // terminal. The gateway is the only party that can see that (it holds the
    // process), so it reports the fact the same way it reports a relay
    // backlog, and the control plane draws the same conclusion.
    await relay(workspaceId, session.sessionId, {
      type: 'system',
      level: 'error',
      message: 'This turn stopped: the agent exited before finishing.',
      metadata: { code: 'runner_exited' },
    })

    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toEqual({
      type: 'interrupted',
      status: 'interrupted',
      error: 'runner_exited',
    })
  })

  test('provisioning failure does not invent coverage for an already delivered input', async () => {
    const workspaceId = await createWorkspace('agent-provisioning-delivered')
    const session = await createSession(workspaceId, 'already accepted')
    const prepared = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: session.sessionId,
      attemptId: 'accepted-before-provisioning-failure',
      input: { kind: 'initial_prompt', prompt: 'already accepted' },
    })
    await markRunnerInputDelivered(
      workspaceId,
      session.sessionId,
      prepared.dispatch.attemptId,
      prepared.dispatch.throughSeq,
    )
    await convex.mutation('testing/workspaces:setWorkspaceStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      status: 'unhealthy',
    })

    await convex.mutation('testing/workspaces:terminalizeProvisioningFailureSessionsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: 5_000,
    })

    expect(
      await findCoveringTerminal(workspaceId, session.sessionId, prepared.dispatch.throughSeq),
    ).toBeNull()
  })

  test('restart recovery terminalizes a turn whose original runner never returned', async () => {
    const workspaceId = await createWorkspace('agent-restart-mid-turn')
    const session = await createSession(workspaceId, 'long-running prompt')
    const initial = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: session.sessionId,
      attemptId: 'before-restart',
      input: { kind: 'initial_prompt', prompt: 'long-running prompt' },
    })
    await markRunnerInputDelivered(
      workspaceId,
      session.sessionId,
      initial.dispatch.attemptId,
      initial.dispatch.throughSeq,
    )
    await relay(workspaceId, session.sessionId, {
      type: 'turn_started',
      state: runningTurnState(),
    })

    const recovered = await relay(workspaceId, session.sessionId, {
      type: 'interrupted',
      state: interruptedTurnState(),
    })

    expect(recovered).toMatchObject({ accepted: true, status: 'interrupted' })
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toEqual({
      type: 'interrupted',
    })

    const next = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: session.sessionId,
      attemptId: 'after-restart',
      input: { kind: 'message', prompt: 'fresh prompt after restart' },
    })
    expect(next).toMatchObject({
      status: 'running',
      dispatch: {
        attemptId: 'after-restart',
        message: ownerEnvelope({
          seq: next.dispatch.throughSeq,
          at: await rowCreatedAt(workspaceId, session.sessionId, next.dispatch.throughSeq),
          body: 'fresh prompt after restart',
        }),
      },
    })
  })

  test('listEvents returns the merged stream in seq order', async () => {
    const workspaceId = await createWorkspace('agent-merged-events')
    const session = await createSession(workspaceId, 'initial')
    await appendSessionNote(workspaceId, session.sessionId, 'queued context')
    await relay(workspaceId, session.sessionId, {
      type: 'turn_started',
      state: runningTurnState(),
    })

    expect(
      (await listEvents(workspaceId, session.sessionId)).map(row => [row.seq, row.event.type]),
    ).toEqual([
      [1, 'session_created'],
      [2, 'prompt_submitted'],
      [3, 'note_submitted'],
      [4, 'turn_started'],
    ])
  })
}
