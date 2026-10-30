import { expect, test } from 'bun:test'

import { defaultTierFor } from '@repo/contract'
import { mutate, query, signInWithMagicLink, uniqueEmail } from '@repo/test-harness'

import {
  INTERNAL_KEY,
  convex,
  owner,
  createWorkspace,
  createSession,
  prepareRunnerInputDelivery,
  markRunnerInputDelivered,
  abandonRunnerInputDelivery,
  relay,
  findCoveringTerminal,
  getSession,
  listEvents,
  listJobs,
  eventually,
  stateMachineFixture,
  turnStateWithMachine,
  terminalEvent,
  UserRow,
} from './test-support'

export function registerServicingPolicyTests(): void {
  test('SUBS-IMPL-07 subscription cancellation pauses servicing and terminalizes eligible sessions', async () => {
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    const workspaceId = await createWorkspace('agent-lapse-terminal')
    const session = await createSession(workspaceId, 'stop when servicing pauses')
    await relay(workspaceId, session.sessionId, {
      type: 'state_machine',
      stateMachine: stateMachineFixture(),
    })
    const overflowSessions = []
    for (let index = 0; index < 8; index += 1) {
      overflowSessions.push(
        await createSession(workspaceId, `bounded terminalization overflow ${index}`),
      )
    }
    const sleepingSession = await createSession(
      workspaceId,
      'stop a sleeping scheduled job when servicing pauses',
    )
    const sleepingStateMachine = stateMachineFixture({
      prompt: 'Remind me after a long sleep.',
    })
    await relay(workspaceId, sleepingSession.sessionId, {
      type: 'state_machine',
      stateMachine: sleepingStateMachine,
    })
    await relay(workspaceId, sleepingSession.sessionId, {
      type: 'sleep',
      wakeAt: Date.now() + 60_000,
      state: {
        status: 'sleeping',
        mode: sleepingStateMachine.definition,
        agent: { status: 'waiting', messages: [] },
        stateMachine: sleepingStateMachine,
      },
    })
    const archivedSleepingSession = await createSession(
      workspaceId,
      'stop an archived sleeping scheduled job when servicing pauses',
    )
    await relay(workspaceId, archivedSleepingSession.sessionId, {
      type: 'state_machine',
      stateMachine: sleepingStateMachine,
    })
    await relay(workspaceId, archivedSleepingSession.sessionId, {
      type: 'sleep',
      wakeAt: Date.now() + 60_000,
      state: {
        status: 'sleeping',
        mode: sleepingStateMachine.definition,
        agent: { status: 'waiting', messages: [] },
        stateMachine: sleepingStateMachine,
      },
    })
    await convex.mutation('domains/agentSessions/model:setSessionArchive', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      kind: 'global',
      workspaceId,
      sessionId: archivedSleepingSession.sessionId,
      archived: true,
    })
    const completedSession = await createSession(
      workspaceId,
      'leave completed scheduled-job history unchanged when servicing pauses',
    )
    await relay(workspaceId, completedSession.sessionId, {
      type: 'state_machine',
      stateMachine: stateMachineFixture(),
    })
    const completedStateMachine = stateMachineFixture({
      currentState: 'done',
      terminal: {
        state: 'done',
        status: 'completed',
        reason: 'Already finished.',
      },
      updatedAt: 3,
    })
    await relay(workspaceId, completedSession.sessionId, {
      type: 'complete',
      status: 'completed',
      state: turnStateWithMachine('completed', 'completed', completedStateMachine),
    })
    const completedTimelineBeforePause = await listEvents(workspaceId, completedSession.sessionId)
    await mutate(owner.client, 'testing/workspaces:lapseCurrentUserSyntheticSubscriptionForTest', {
      internalKey: INTERNAL_KEY,
    })

    expect(
      await mutate(convex, 'domains/credits/internal:reconcileServicingStatus', {
        internalKey: INTERNAL_KEY,
        userId: owner.user._id,
        now: Date.now(),
      }),
    ).toBeNull()
    expect(
      await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      }),
    ).toMatchObject({ servicingStatus: 'paused' })

    const eligibleSessionIds = [
      session.sessionId,
      ...overflowSessions.map(overflow => overflow.sessionId),
      sleepingSession.sessionId,
      archivedSleepingSession.sessionId,
    ]
    await eventually(async () => {
      const converged = await Promise.all(
        eligibleSessionIds.map(sessionId => getSession(workspaceId, sessionId)),
      )
      expect(converged.map(candidate => candidate?.turnStatus)).toEqual(
        eligibleSessionIds.map(() => 'interrupted'),
      )
    })

    expect(
      await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      }),
    ).toMatchObject({ servicingStatus: 'paused' })

    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })
    expect(await getSession(workspaceId, sleepingSession.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })
    expect(await getSession(workspaceId, archivedSleepingSession.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
    })
    await convex.mutation('domains/agentSessions/model:setSessionArchive', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      kind: 'global',
      workspaceId,
      sessionId: archivedSleepingSession.sessionId,
      archived: false,
    })
    expect(await listJobs(workspaceId, { view: 'history' })).toMatchObject({
      jobs: expect.arrayContaining([
        expect.objectContaining({
          id: archivedSleepingSession.sessionId,
          bucket: 'done',
        }),
      ]),
    })
    expect(await getSession(workspaceId, completedSession.sessionId)).toMatchObject({
      turnStatus: 'complete',
      machineState: { currentState: 'done' },
    })
    expect(await listEvents(workspaceId, completedSession.sessionId)).toEqual(
      completedTimelineBeforePause,
    )
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toMatchObject({
      type: 'interrupted',
      error: 'workspace_paused',
    })
    expect(await findCoveringTerminal(workspaceId, session.sessionId, 2)).toBeNull()
    expect((await listJobs(workspaceId, { view: 'active' })).jobs).toEqual([])
    const historyProjection = await listJobs(workspaceId, { view: 'history' })
    expect(historyProjection).toMatchObject({
      jobs: expect.arrayContaining([
        expect.objectContaining({
          id: session.sessionId,
          bucket: 'done',
          machine: expect.objectContaining({
            activity: 'idle',
            outcome: 'interrupted',
          }),
        }),
        expect.objectContaining({
          id: sleepingSession.sessionId,
          bucket: 'done',
          machine: expect.objectContaining({
            activity: 'idle',
            outcome: 'interrupted',
          }),
        }),
      ]),
    })
    const impossibleInterruptedMachine = stateMachineFixture({
      currentState: 'interrupted',
      terminal: {
        state: 'done',
        status: 'completed',
        reason: 'Cannot also be interrupted.',
      },
      updatedAt: 3,
    })
    expect(
      await relay(workspaceId, archivedSleepingSession.sessionId, {
        type: 'interrupted',
        state: {
          status: 'interrupted',
          mode: impossibleInterruptedMachine.definition,
          agent: { status: 'cancelled', messages: [] },
          stateMachine: impossibleInterruptedMachine,
        },
      }),
    ).toMatchObject({ status: 'interrupted', accepted: false, seq: null })
    const archivedMachineAfterRejectedRefinement = await getSession(
      workspaceId,
      archivedSleepingSession.sessionId,
    )
    expect(archivedMachineAfterRejectedRefinement).toMatchObject({
      machineState: { currentState: 'wait' },
    })
    if (archivedMachineAfterRejectedRefinement === null) throw new Error('Session not found')
    expect(
      (archivedMachineAfterRejectedRefinement.machineState as Record<string, unknown>).terminal,
    ).toBeUndefined()
    const nativeInterruptedMachine = stateMachineFixture({
      prompt: 'Remind me after a long sleep.',
      currentState: 'interrupted',
      updatedAt: 3,
    })
    const sleepingTimelineAfterPause = await listEvents(workspaceId, sleepingSession.sessionId)
    expect(
      await relay(workspaceId, sleepingSession.sessionId, {
        type: 'interrupted',
        state: {
          status: 'interrupted',
          mode: nativeInterruptedMachine.definition,
          agent: { status: 'cancelled', messages: [] },
          stateMachine: nativeInterruptedMachine,
          todos: [],
          followUpQueue: [],
        },
      }),
    ).toMatchObject({
      status: 'interrupted',
      accepted: true,
      seq: null,
      lastEventSeq: sleepingTimelineAfterPause.at(-1)?.seq,
    })
    expect(await getSession(workspaceId, sleepingSession.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
      machineState: { currentState: 'interrupted' },
    })
    expect(await listEvents(workspaceId, sleepingSession.sessionId)).toEqual(
      sleepingTimelineAfterPause,
    )
    expect(await relay(workspaceId, session.sessionId, terminalEvent('ask'))).toMatchObject({
      status: 'interrupted',
      accepted: false,
      seq: null,
    })
    expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toMatchObject({
      type: 'interrupted',
      error: 'workspace_paused',
    })
    // ~12s under a light load: the convergence loop is many serial round trips
    // and each mutation stretches under full-gate pressure. A starved budget
    // here is not one red test — bun kills the worker's child processes on a
    // test timeout, which takes the file's deployment (and every test after
    // this one) down with it.
  }, 60_000)

  test('paused native interruption records one control marker and refines runner documents in place', async () => {
    const workspaceId = await createWorkspace('agent-pause-native')
    const session = await createSession(workspaceId, 'interrupt this sleeping job')
    const stateMachine = stateMachineFixture()
    const todos = [{ id: 'todo-1', content: 'still running', status: 'in_progress' }]
    const followUpQueue = [{ message: 'queued follow-up' }]
    await relay(workspaceId, session.sessionId, {
      type: 'state_machine',
      stateMachine,
    })
    await relay(workspaceId, session.sessionId, { type: 'todos', todos })
    await relay(workspaceId, session.sessionId, {
      type: 'follow_up_queue',
      followUpQueue,
    })
    await relay(workspaceId, session.sessionId, {
      type: 'sleep',
      wakeAt: Date.now() + 60_000,
      state: {
        status: 'sleeping',
        mode: stateMachine.definition,
        agent: { status: 'waiting', messages: [] },
        stateMachine,
        todos,
        followUpQueue,
      },
    })
    await convex.mutation('testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      servicingStatus: 'paused',
      now: Date.now(),
    })
    const timelineBeforeInterrupt = await listEvents(workspaceId, session.sessionId)
    const interruptedMachine = stateMachineFixture({
      currentState: 'interrupted',
      updatedAt: 3,
    })
    const nativeInterrupt = {
      type: 'interrupted',
      state: {
        status: 'interrupted',
        mode: interruptedMachine.definition,
        agent: { status: 'cancelled', messages: [] },
        stateMachine: interruptedMachine,
        todos: [],
        followUpQueue: [],
      },
    }

    expect(
      await relay(workspaceId, session.sessionId, nativeInterrupt, 'paused-native-interrupt-first'),
    ).toEqual({
      status: 'interrupted',
      accepted: true,
      seq: null,
      lastEventSeq: timelineBeforeInterrupt.at(-1)!.seq + 1,
    })
    const timelineAfterInterrupt = await listEvents(workspaceId, session.sessionId)
    expect(timelineAfterInterrupt).toEqual([
      ...timelineBeforeInterrupt,
      expect.objectContaining({
        seq: timelineBeforeInterrupt.at(-1)!.seq + 1,
        event: expect.objectContaining({
          type: 'interrupted',
          error: 'workspace_paused',
        }),
      }),
    ])
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'interrupted',
      machineState: { currentState: 'interrupted' },
      todos: [],
      followUpQueue: [],
      machine: { activity: 'idle', outcome: 'interrupted' },
    })
    const historyProjection = await listJobs(workspaceId, { view: 'history' })
    expect(historyProjection.jobs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: session.sessionId, bucket: 'done' })]),
    )
    expect(
      await relay(
        workspaceId,
        session.sessionId,
        nativeInterrupt,
        'paused-native-interrupt-repeated',
      ),
    ).toMatchObject({ status: 'interrupted', accepted: false, seq: null })
    expect(await listEvents(workspaceId, session.sessionId)).toEqual(timelineAfterInterrupt)
  })

  test('a stale terminalization continuation stops after workspace servicing resumes', async () => {
    const workspaceId = await createWorkspace('agent-resumed')
    const session = await createSession(workspaceId, 'keep working after servicing resumes')
    await relay(workspaceId, session.sessionId, {
      type: 'state_machine',
      stateMachine: stateMachineFixture(),
    })
    await convex.mutation('testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      servicingStatus: 'paused',
      now: Date.now(),
    })
    await convex.mutation('testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      servicingStatus: 'active',
      now: Date.now() + 1,
    })

    expect(
      await convex.mutation('testing/workspaces:continueAgentSessionTerminalizationForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        now: Date.now() + 2,
      }),
    ).toEqual({ done: true, processed: 0 })
    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      turnStatus: 'running',
    })
    expect(await listJobs(workspaceId, { view: 'active' })).toMatchObject({
      jobs: expect.arrayContaining([expect.objectContaining({ id: session.sessionId })]),
    })
    expect(
      (await listEvents(workspaceId, session.sessionId)).map(row => row.event.type),
    ).not.toContain('interrupted')
  })

  test('workspace defaults persist with owner audit and tier choices stay prompt-bound', async () => {
    const tierA = 'frontier'
    const tierB = 'balanced'
    const workspaceId = await createWorkspace('agent-tier-stickiness')
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('agent-model-member'),
      'Agent Model Member',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: member.user._id,
      role: 'editor',
    })

    await expect(
      mutate(member.client, 'domains/workspaces/mutations:setDefaultModel', {
        workspaceId,
        tier: tierA,
      }),
    ).rejects.toThrow('Requires owner access')
    const auditsBefore = (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
      workspaceId,
    })) as Array<{ event: string; provenance?: unknown }>
    await mutate(owner.client, 'domains/workspaces/mutations:setDefaultModel', {
      workspaceId,
      tier: tierA,
    })
    const auditsAfter = (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
      workspaceId,
    })) as Array<{ event: string; provenance?: unknown }>
    expect(auditsAfter.slice(auditsBefore.length)).toEqual([
      expect.objectContaining({
        event: 'workspace.default_model_changed',
        provenance: { tier: tierA },
      }),
    ])

    const initial = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'model-initial',
      input: { kind: 'initial_prompt', prompt: 'initial' },
    })
    expect(initial.dispatch.resolvedModelId).toBe(tierA)
    await markRunnerInputDelivered(
      workspaceId,
      initial.sessionId,
      initial.dispatch.attemptId,
      initial.dispatch.throughSeq,
    )

    await mutate(owner.client, 'domains/workspaces/mutations:setDefaultModel', {
      workspaceId,
      tier: tierB,
    })
    const sticky = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: initial.sessionId,
      attemptId: 'model-sticky',
      input: { kind: 'message', prompt: 'stay sticky' },
    })
    expect(sticky.dispatch.resolvedModelId).toBe(tierA)
    await markRunnerInputDelivered(
      workspaceId,
      initial.sessionId,
      sticky.dispatch.attemptId,
      sticky.dispatch.throughSeq,
    )

    const explicit = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: initial.sessionId,
      attemptId: 'model-explicit',
      input: { kind: 'message', prompt: 'switch', tier: tierB },
    })
    expect(explicit.dispatch.resolvedModelId).toBe(tierB)
    await abandonRunnerInputDelivery(workspaceId, initial.sessionId, explicit.dispatch.attemptId)
    await mutate(owner.client, 'domains/workspaces/mutations:setDefaultModel', {
      workspaceId,
      tier: tierA,
    })
    const retried = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: initial.sessionId,
      attemptId: 'model-retry',
      input: { kind: 'initial_prompt', prompt: 'drain placeholder' },
    })
    expect(retried.dispatch.resolvedModelId).toBe(tierB)
    expect(await getSession(workspaceId, initial.sessionId)).toMatchObject({
      tier: tierB,
    })
  })

  test('a trial workspace runs the paid tier it asked for, with no clamp notice', async () => {
    const workspaceId = await createWorkspace('agent-tier-unclamped')
    await mutate(owner.client, 'testing/workspaces:clearCurrentUserPaidForTest', {
      internalKey: INTERNAL_KEY,
    })
    await mutate(owner.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: 1_000,
    })

    const prepared = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'tier-unclamped',
      input: {
        kind: 'initial_prompt',
        prompt: 'use the strongest tier',
        tier: 'frontier',
      },
      now: 2_000,
    })

    expect(prepared.dispatch.resolvedModelId).toBe('frontier')
    expect(
      (await listEvents(workspaceId, prepared.sessionId)).map(row => row.event.type),
    ).not.toContain('tier_clamped')
  })

  test('legacy workspace defaults are skipped for the subscriber default tier', async () => {
    const workspaceId = await createWorkspace('agent-legacy-tier-default')
    await mutate(convex, 'testing/workspaces:setWorkspaceDefaultTierRawForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      value: 'recommended',
    })

    const prepared = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'legacy-tier-default',
      input: { kind: 'initial_prompt', prompt: 'skip the legacy preference' },
    })

    expect(prepared.dispatch.resolvedModelId).toBe(
      defaultTierFor({ subscriber: true, plan: 'starter' }),
    )
  })

  test('a cutover-spanning create retry conflicts once and recovers under a new input id', async () => {
    const workspaceId = await createWorkspace('agent-tier-cutover-retry')
    const original = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'tier-cutover-original',
      input: {
        sender: { kind: 'user', userId: owner.user._id },
        kind: 'initial_prompt',
        prompt: 'resume across cutover',
        clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b95',
      },
    })
    await mutate(convex, 'testing/agentSessions:setLastModelIdRawForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: original.sessionId,
      value: 'recommended',
    })

    await expect(
      prepareRunnerInputDelivery(workspaceId, {
        attemptId: 'tier-cutover-conflict',
        input: {
          sender: { kind: 'user', userId: owner.user._id },
          kind: 'initial_prompt',
          prompt: 'resume across cutover',
          clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b95',
        },
      }),
    ).rejects.toThrow('invalid_request')

    const recovered = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'tier-cutover-recovered',
      input: {
        sender: { kind: 'user', userId: owner.user._id },
        kind: 'initial_prompt',
        prompt: 'resume across cutover',
        clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b96',
      },
    })
    expect(recovered.dispatch.resolvedModelId).toBe(
      defaultTierFor({ subscriber: true, plan: 'starter' }),
    )
  })

  test('a workspace without a subscription can still default to a paid tier', async () => {
    const workspaceId = await createWorkspace('workspace-tier-unsubscribed')
    await mutate(owner.client, 'testing/workspaces:clearCurrentUserPaidForTest', {
      internalKey: INTERNAL_KEY,
    })

    await mutate(owner.client, 'domains/workspaces/mutations:setDefaultModel', {
      workspaceId,
      tier: 'frontier',
    })

    expect(
      await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      }),
    ).toMatchObject({ defaultModelId: 'frontier' })
  })
}
