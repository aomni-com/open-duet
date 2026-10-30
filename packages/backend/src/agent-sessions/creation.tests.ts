import { expect, test } from 'bun:test'

import { mutate, signInWithMagicLink, uniqueEmail } from '@repo/test-harness'

import {
  INTERNAL_KEY,
  convex,
  owner,
  registerTestAgent,
  createSessionInDir,
  createWorkspace,
  createSession,
  prepareRunnerInputDelivery,
  markRunnerInputDelivered,
  relay,
  findCoveringTerminal,
  getSession,
  listEvents,
  listSessions,
  listJobs,
  eventually,
  stateMachineFixture,
  terminalEvent,
  runningTurnState,
  type UserRow,
} from './test-support'

export function registerCreationTests(): void {
  test('ordinary creation with the maximum 100-member audience fits one transaction', async () => {
    const workspaceId = await createWorkspace('agent-creation-maximum-audience')
    await convex.mutation('testing/workspaces:fillWorkspaceMemberCapacityForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      targetCount: 100,
    })
    const members = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ userId: string }>

    const created = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'creation-maximum-audience',
      input: {
        kind: 'initial_prompt',
        prompt: 'Create the maximum bounded specific audience.',
        audience: { kind: 'specific', memberUserIds: members.map(member => member.userId) },
      },
    })

    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: created.sessionId,
      }),
    ).toMatchObject({
      audienceKind: 'specific',
      specificGrantedParticipantCount: 100,
    })
    expect(
      await convex.query('testing/agentSessions:childRowCountsForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: created.sessionId,
      }),
    ).toMatchObject({ memberStates: 100, discovery: 101 })
  })

  test('every creation mode stamps explicit workspace audience', async () => {
    const workspaceId = await createWorkspace('agent-creation-census')
    const agent = await registerTestAgent(workspaceId, 'agents/creation-census', 'creation-census')

    const queued = await createSession(workspaceId, 'Queued by a member.')
    const workspaceCreated = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'creation-census-workspace',
      identity: { principal: { kind: 'workspace' }, actorId: owner.user._id },
      input: {
        kind: 'initial_prompt',
        prompt: 'Queued by a workspace principal.',
        sender: { kind: 'system' },
      },
      now: 1_000,
    })
    const defaultCreated = (await convex.mutation(
      'domains/agentSessions/model:prepareRunnerInputDelivery',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        workspaceId,
        defaultOwner: { kind: 'root' },
        attemptId: 'creation-census-default',
        input: {
          kind: 'initial_prompt',
          prompt: 'Default chat.',
          behavior: 'steer',
          sender: { kind: 'user', userId: owner.user._id },
        },
        now: 2_000,
      },
    )) as { sessionId: string }
    const nested = (await convex.mutation(
      'domains/agentSessions/model:prepareRunnerInputDelivery',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        workspaceId,
        createdBySessionId: queued.sessionId,
        attemptId: 'creation-census-nested',
        input: {
          kind: 'initial_prompt',
          prompt: 'Nested work.',
          behavior: 'steer',
          sender: { kind: 'session', sessionId: queued.sessionId },
        },
        now: 3_000,
      },
    )) as { sessionId: string }
    const intruder = await signInWithMagicLink(
      convex,
      uniqueEmail('onboarding-identity-intruder'),
      'Onboarding Intruder',
    )
    await expect(
      mutate(intruder.client, 'domains/agentSessions/creation:openOnboardingSession', {
        workspaceId,
        agentId: agent.id,
        actorId: owner.user._id,
        now: 3_500,
      }),
    ).rejects.toThrow('derives its identity from authentication')
    const onboarding = (await mutate(
      owner.client,
      'domains/agentSessions/creation:openOnboardingSession',
      { workspaceId, agentId: agent.id, now: 4_000 },
    )) as { sessionId: string }

    const rows = (await Promise.all(
      [
        queued.sessionId,
        workspaceCreated.sessionId,
        defaultCreated.sessionId,
        nested.sessionId,
        onboarding.sessionId,
      ].map(sessionId =>
        convex.query('testing/agentSessions:rawSessionForTest', {
          internalKey: INTERNAL_KEY,
          sessionId,
        }),
      ),
    )) as Array<Record<string, unknown>>

    expect(rows.map(row => row.audienceKind)).toEqual(Array(5).fill('workspace'))
  })

  for (const terminal of ['complete', 'ask', 'interrupted', 'sleep'] as const) {
    test(`reaches terminal state ${terminal} and preserves event sequence`, async () => {
      const workspaceId = await createWorkspace(`agent-${terminal}`)
      const session = await createSession(workspaceId, `prompt for ${terminal}`)
      await relay(workspaceId, session.sessionId, {
        type: 'turn_started',
        state: runningTurnState(),
      })
      await relay(workspaceId, session.sessionId, terminalEvent(terminal))

      const stored = await getSession(workspaceId, session.sessionId)
      expect(stored).toMatchObject({ turnStatus: terminal, lastEventSeq: 4 })
      const events = await listEvents(workspaceId, session.sessionId)
      expect(events.map(row => [row.seq, row.event.type])).toEqual([
        [1, 'session_created'],
        [2, 'prompt_submitted'],
        [3, 'turn_started'],
        [4, terminal],
      ])
    })
  }

  test('createSession records the initial prompt as queued user input', async () => {
    const workspaceId = await createWorkspace('agent-create-timeline')
    const session = await createSession(workspaceId, 'initial timeline prompt')

    expect(session).toMatchObject({ status: 'running', lastEventSeq: 2, lastDeliveredInputSeq: 0 })
    const stored = await getSession(workspaceId, session.sessionId)
    expect(stored).toMatchObject({ lastDeliveredInputSeq: 0 })
    expect(stored?.requestedMachine).toBeUndefined()
    const events = await listEvents(workspaceId, session.sessionId)
    expect(events.map(row => [row.seq, row.event])).toMatchObject([
      [1, { type: 'session_created', prompt: 'initial timeline prompt' }],
      [
        2,
        {
          type: 'prompt_submitted',
          inputKind: 'initial',
          prompt: 'initial timeline prompt',
          behavior: 'steer',
        },
      ],
    ])
  })

  test('create persists and projects the requested start mode without seeding runner state', async () => {
    const workspaceId = await createWorkspace('agent-create-start-mode')
    const mode = {
      name: 'Review then finish',
      prompt: 'Review the work before declaring it complete.',
      states: [
        { name: 'review', kind: 'agent', prompt: 'Review the implementation.' },
        { name: 'done', kind: 'terminal', status: 'completed' },
      ],
    }

    const created = (await convex.mutation(
      'domains/agentSessions/model:prepareRunnerInputDelivery',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        workspaceId,
        attemptId: 'start-mode-create',
        now: 2_000,
        input: {
          sender: { kind: 'user', userId: owner.user._id },
          kind: 'initial_prompt',
          prompt: 'Implement the change.',
          behavior: 'steer',
          mode,
        },
      },
    )) as {
      sessionId: string
      dispatch: { mode?: typeof mode }
      created: { snapshot: { requestedMachine?: typeof mode } }
    }

    expect(created.dispatch.mode).toEqual(mode)
    expect(created.created.snapshot.requestedMachine).toEqual(mode)
    const stored = (await convex.query('testing/agentSessions:rawSessionForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: created.sessionId,
    })) as {
      requestedMachine?: typeof mode
      machineState?: unknown
      machine?: unknown
    }
    expect(stored.requestedMachine).toEqual(mode)
    // Requested is not running: `requestedMachine` is the ask, `machineState`
    // the observation, and until the runner reports one there is no `machine`
    // projection — which is the whole of what "not a job" now means.
    expect(stored.machineState).toBeUndefined()
    expect(stored.machine).toBeUndefined()
    const snapshot = await getSession(workspaceId, created.sessionId)
    expect(snapshot?.requestedMachine).toEqual(mode)

    await markRunnerInputDelivered(workspaceId, created.sessionId, 'start-mode-create', 2)
    const resumed = (await convex.mutation(
      'domains/agentSessions/model:prepareRunnerInputDelivery',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        workspaceId,
        sessionId: created.sessionId,
        attemptId: 'start-mode-resume',
        now: 3_000,
        input: {
          sender: { kind: 'user', userId: owner.user._id },
          kind: 'message',
          prompt: 'Continue.',
          behavior: 'steer',
        },
      },
    )) as { dispatch: { mode?: typeof mode } }
    expect(resumed.dispatch.mode).toEqual(mode)
  })

  test('nested creation inherits parent context, stamps lineage, and accepts explicit overrides', async () => {
    const workspaceId = await createWorkspace('agent-lineage')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/research',
      slug: 'research',
    })) as { id: string; anchorId: string }
    const parent = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'lineage-parent',
      input: {
        sender: { kind: 'user', userId: owner.user._id },
        kind: 'initial_prompt',
        prompt: 'Parent work.',
        cwd: 'agents/research',
        tier: 'frontier',
      },
      now: 1_000,
    })
    const inherited = (await convex.mutation(
      'domains/agentSessions/model:prepareRunnerInputDelivery',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        workspaceId,
        createdBySessionId: parent.sessionId,
        attemptId: 'lineage-child-inherited',
        input: {
          kind: 'initial_prompt',
          prompt: 'Inherited child.',
          behavior: 'steer',
          sender: { kind: 'session', sessionId: parent.sessionId },
        },
        now: 2_000,
      },
    )) as {
      sessionId: string
      dispatch: {
        cwd?: string
        resolvedModelId: string
        createdBySessionId?: string
      }
    }
    expect(await getSession(workspaceId, inherited.sessionId)).toMatchObject({
      createdBySessionId: parent.sessionId,
      cwd: 'agents/research',
      tier: 'frontier',
      agent: { id: agent.id },
    })
    expect(inherited.dispatch).toMatchObject({
      cwd: 'agents/research',
      resolvedModelId: 'frontier',
      createdBySessionId: parent.sessionId,
    })
    expect((await listEvents(workspaceId, inherited.sessionId))[1]?.event).toMatchObject({
      type: 'prompt_submitted',
      sender: { kind: 'session', sessionId: parent.sessionId },
    })

    const overridden = (await convex.mutation(
      'domains/agentSessions/model:prepareRunnerInputDelivery',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        workspaceId,
        createdBySessionId: parent.sessionId,
        attemptId: 'lineage-child-overridden',
        input: {
          kind: 'initial_prompt',
          prompt: 'Overridden child.',
          behavior: 'steer',
          cwd: 'projects/standalone',
          tier: 'balanced',
          sender: { kind: 'session', sessionId: parent.sessionId },
        },
        now: 3_000,
      },
    )) as { sessionId: string }
    expect(await getSession(workspaceId, overridden.sessionId)).toMatchObject({
      createdBySessionId: parent.sessionId,
      cwd: 'projects/standalone',
      tier: 'balanced',
    })
    expect(await getSession(workspaceId, overridden.sessionId)).not.toHaveProperty('agent')
  })

  test('nested creation copies the current specific audience once and then diverges', async () => {
    const workspaceId = await createWorkspace('agent-lineage-audience')
    const participant = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('agent-lineage-audience-participant'),
      'Nested participant',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: participant.user._id,
      role: 'viewer',
    })
    const memberships = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; userId: string }>
    const participantMembershipId = memberships.find(
      membership => membership.userId === participant.user._id,
    )!._id
    const parent = await createSession(workspaceId, 'Specific parent.')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: parent.sessionId,
      membershipIds: [participantMembershipId],
    })

    const child = (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
      internalKey: INTERNAL_KEY,
      actorId: participant.user._id,
      identity: {
        principal: { kind: 'human', userId: participant.user._id },
        actorId: participant.user._id,
      },
      workspaceId,
      createdBySessionId: parent.sessionId,
      attemptId: 'lineage-specific-child',
      input: {
        kind: 'initial_prompt',
        prompt: 'Specific child.',
        behavior: 'steer',
        sender: { kind: 'session', sessionId: parent.sessionId },
      },
      now: 2_000,
    })) as { sessionId: string }

    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: child.sessionId,
      }),
    ).toMatchObject({
      audienceKind: 'specific',
      specificGrantedParticipantCount: 1,
      createdBySessionId: parent.sessionId,
    })
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: child.sessionId,
        membershipId: participantMembershipId,
      }),
    ).toMatchObject({ audienceGranted: true })

    await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: parent.sessionId,
      membershipId: participantMembershipId,
      granted: false,
      now: 3_000,
    })
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: child.sessionId,
        membershipId: participantMembershipId,
      }),
    ).toMatchObject({ audienceGranted: true })
  })

  test('a nested cwd hands the child to the deepest agent, not the parent that started it', async () => {
    const workspaceId = await createWorkspace('agent-lineage-subagent')
    const research = await registerTestAgent(workspaceId, 'agents/research', 'research')
    const junior = await registerTestAgent(workspaceId, 'agents/research/junior', 'junior')
    const parent = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'subagent-parent',
      input: { kind: 'initial_prompt', prompt: 'Parent work.', cwd: 'agents/research' },
      now: 1_000,
    })
    expect(await getSession(workspaceId, parent.sessionId)).toMatchObject({
      agent: { id: research.id },
    })

    // The agent id is never on the wire: a parent hands work to a sub-agent by
    // naming its folder, and attribution re-resolves from that cwd instead of
    // being inherited.
    const child = (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
      workspaceId,
      createdBySessionId: parent.sessionId,
      attemptId: 'subagent-child',
      input: {
        kind: 'initial_prompt',
        prompt: 'Sub-agent work.',
        behavior: 'steer',
        cwd: 'agents/research/junior',
        sender: { kind: 'session', sessionId: parent.sessionId },
      },
      now: 2_000,
    })) as { sessionId: string; dispatch: { cwd?: string } }

    expect(child.dispatch.cwd).toBe('agents/research/junior')
    expect(await getSession(workspaceId, child.sessionId)).toMatchObject({
      createdBySessionId: parent.sessionId,
      cwd: 'agents/research/junior',
      agent: { id: junior.id },
    })
  })

  test('every sender kind reaches durable history through message, note, answer, and onboarding', async () => {
    const workspaceId = await createWorkspace('agent-senders')
    // Create through the delivery path and settle each lease before the next
    // input, so the ask/answer sequence below never finds pending input and
    // queues (the queued path never appends the durable row being pinned).
    const source = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'sender-source',
      input: { kind: 'initial_prompt', prompt: 'Source session.' },
      now: 500,
    })
    const initial = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'sender-initial',
      input: { kind: 'initial_prompt', prompt: 'Initial.' },
      now: 1_000,
    })
    const session = { sessionId: initial.sessionId }
    await markRunnerInputDelivered(
      workspaceId,
      initial.sessionId,
      initial.dispatch.attemptId,
      initial.dispatch.throughSeq,
    )
    const attributed = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: session.sessionId,
      attemptId: 'sender-message',
      input: {
        kind: 'message',
        prompt: 'From another session.',
        sender: { kind: 'session', sessionId: source.sessionId },
      },
      now: 2_000,
    })
    await markRunnerInputDelivered(
      workspaceId,
      session.sessionId,
      attributed.dispatch.attemptId,
      attributed.dispatch.throughSeq,
    )
    await convex.mutation('domains/agentSessions/model:appendSessionNote', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      workspaceId,
      sessionId: session.sessionId,
      note: 'Attributed context.',
      sender: { kind: 'app', appId: 'app_calendar' },
      now: 3_000,
    })
    await relay(workspaceId, session.sessionId, terminalEvent('ask'))
    const answered = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: session.sessionId,
      attemptId: 'system-answer',
      input: { kind: 'answer', answer: 'Approved.', sender: { kind: 'system' } },
      now: 4_000,
    })
    await markRunnerInputDelivered(
      workspaceId,
      session.sessionId,
      answered.dispatch.attemptId,
      answered.dispatch.throughSeq,
    )

    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/onboarding-sender',
      slug: 'onboarding-sender',
    })) as { id: string }
    const onboarding = (await mutate(
      owner.client,
      'domains/agentSessions/creation:openOnboardingSession',
      { workspaceId, agentId: agent.id, now: 5_000 },
    )) as { sessionId: string }

    const rows = await listEvents(workspaceId, session.sessionId)
    expect(rows.map(row => row.event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'prompt_submitted',
          inputKind: 'initial',
          sender: { kind: 'user', userId: owner.user._id },
        }),
        expect.objectContaining({
          type: 'prompt_submitted',
          inputKind: 'message',
          sender: { kind: 'session', sessionId: source.sessionId },
        }),
        expect.objectContaining({
          type: 'note_submitted',
          sender: { kind: 'app', appId: 'app_calendar' },
        }),
        expect.objectContaining({ type: 'answer_submitted', sender: { kind: 'system' } }),
      ]),
    )
    // Row seq and row createdAt are the only durable clocks on an input; the
    // session's own creator never leaks onto the event.
    const inputs = rows.filter(row => row.event.type !== 'session_created')
    expect(inputs.map(row => row.seq)).toEqual(inputs.map(row => row.seq).sort((a, b) => a - b))
    for (const row of inputs) {
      expect(typeof row.createdAt).toBe('number')
      expect(row.event).not.toHaveProperty('submittedAt')
      expect(row.event).not.toHaveProperty('origin')
      expect(row.event).not.toHaveProperty('userId')
    }

    expect((await listEvents(workspaceId, onboarding.sessionId))[1]?.event).toMatchObject({
      type: 'prompt_submitted',
      sender: { kind: 'system' },
    })
  })

  test('a source session outside the workspace never reaches durable history', async () => {
    const workspaceId = await createWorkspace('agent-sender-scope')
    const otherWorkspaceId = await createWorkspace('agent-sender-scope-other')
    const foreign = await prepareRunnerInputDelivery(otherWorkspaceId, {
      attemptId: 'foreign-source',
      input: { kind: 'initial_prompt', prompt: 'Foreign source.' },
      now: 500,
    })
    const target = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'scope-initial',
      input: { kind: 'initial_prompt', prompt: 'Initial.' },
      now: 1_000,
    })
    await markRunnerInputDelivered(
      workspaceId,
      target.sessionId,
      target.dispatch.attemptId,
      target.dispatch.throughSeq,
    )
    const before = await listEvents(workspaceId, target.sessionId)

    // Missing and other-workspace sources are indistinguishable to the caller.
    for (const sessionId of [foreign.sessionId, 'not-a-session-id']) {
      await expect(
        prepareRunnerInputDelivery(workspaceId, {
          sessionId: target.sessionId,
          attemptId: `scope-message-${sessionId}`,
          input: {
            kind: 'message',
            prompt: 'Unresolvable source.',
            sender: { kind: 'session', sessionId },
          },
          now: 2_000,
        }),
      ).rejects.toMatchObject({ data: { error: 'not_found' } })
      await expect(
        convex.mutation('domains/agentSessions/model:appendSessionNote', {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          sessionId: target.sessionId,
          note: 'Unresolvable source.',
          sender: { kind: 'session', sessionId },
          now: 2_000,
        }),
      ).rejects.toMatchObject({ data: { error: 'not_found' } })
    }

    expect(await listEvents(workspaceId, target.sessionId)).toEqual(before)
    expect(await getSession(workspaceId, target.sessionId)).toMatchObject({
      lastEventSeq: before.at(-1)!.seq,
    })
  })

  test('a replayed request id under a different sender conflicts instead of re-attributing', async () => {
    const workspaceId = await createWorkspace('agent-sender-idempotency')
    const source = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'idem-source',
      input: { kind: 'initial_prompt', prompt: 'Source session.' },
      now: 500,
    })
    const created = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'idem-initial',
      input: { kind: 'initial_prompt', prompt: 'Initial.' },
      now: 1_000,
    })
    await markRunnerInputDelivered(
      workspaceId,
      created.sessionId,
      created.dispatch.attemptId,
      created.dispatch.throughSeq,
    )
    const messageRequestId = '20000000-0000-4000-8000-000000000001'
    const noteRequestId = '20000000-0000-4000-8000-000000000002'
    const userSender = { kind: 'user' as const, userId: owner.user._id }
    const sessionSender = { kind: 'session' as const, sessionId: source.sessionId }

    const first = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: created.sessionId,
      attemptId: 'idem-message',
      input: {
        kind: 'message',
        prompt: 'Same payload.',
        clientRequestId: messageRequestId,
        sender: userSender,
      },
      now: 2_000,
    })
    const replayed = await prepareRunnerInputDelivery(workspaceId, {
      sessionId: created.sessionId,
      attemptId: 'idem-message-replay',
      input: {
        kind: 'message',
        prompt: 'Same payload.',
        clientRequestId: messageRequestId,
        sender: userSender,
      },
      now: 2_100,
    })
    expect(replayed.sessionId).toBe(first.sessionId)
    expect(replayed).toMatchObject({ deduplicated: true })
    await expect(
      prepareRunnerInputDelivery(workspaceId, {
        sessionId: created.sessionId,
        attemptId: 'idem-message-resender',
        input: {
          kind: 'message',
          prompt: 'Same payload.',
          clientRequestId: messageRequestId,
          sender: sessionSender,
        },
        now: 2_200,
      }),
    ).rejects.toThrow(/invalid_request/)

    const note = (await convex.mutation('domains/agentSessions/model:appendSessionNote', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      workspaceId,
      sessionId: created.sessionId,
      note: 'Same note.',
      clientRequestId: noteRequestId,
      clientRequestFingerprint: 'note-fingerprint',
      sender: userSender,
      now: 3_000,
    })) as { seq: number }
    // The early return after a fingerprint match must still compare authorship.
    expect(
      await convex.mutation('domains/agentSessions/model:appendSessionNote', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: {
          principal: { kind: 'human', userId: owner.user._id },
          actorId: owner.user._id,
        },
        workspaceId,
        sessionId: created.sessionId,
        note: 'Same note.',
        clientRequestId: noteRequestId,
        clientRequestFingerprint: 'note-fingerprint',
        sender: userSender,
        now: 3_100,
      }),
    ).toMatchObject({ seq: note.seq, deduplicated: true })
    await expect(
      convex.mutation('domains/agentSessions/model:appendSessionNote', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: {
          principal: { kind: 'human', userId: owner.user._id },
          actorId: owner.user._id,
        },
        workspaceId,
        sessionId: created.sessionId,
        note: 'Same note.',
        clientRequestId: noteRequestId,
        clientRequestFingerprint: 'note-fingerprint',
        sender: sessionSender,
        now: 3_200,
      }),
    ).rejects.toThrow(/invalid_request/)

    const createRequestId = '20000000-0000-4000-8000-000000000003'
    const createInput = {
      kind: 'initial_prompt' as const,
      prompt: 'Create once.',
      behavior: 'steer' as const,
      clientRequestId: createRequestId,
    }
    const originalCreate = await prepareRunnerInputDelivery(workspaceId, {
      attemptId: 'idem-create',
      input: { ...createInput, sender: userSender },
      now: 4_000,
    })
    expect(
      await prepareRunnerInputDelivery(workspaceId, {
        attemptId: 'idem-create-replay',
        input: { ...createInput, sender: userSender },
        now: 4_100,
      }),
    ).toMatchObject({ sessionId: originalCreate.sessionId, deduplicated: true })
    await expect(
      prepareRunnerInputDelivery(workspaceId, {
        attemptId: 'idem-create-resender',
        input: { ...createInput, sender: sessionSender },
        now: 4_200,
      }),
    ).rejects.toThrow(/invalid_request/)
  })

  test('fresh session creation snapshots the nearest agent identity', async () => {
    const workspaceId = await createWorkspace('agent-attribution')
    const outer = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/research',
      slug: 'research',
    })) as { id: string }
    const inner = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/research/notes',
      slug: 'notes',
      name: 'Notebook',
    })) as { id: string }
    const session = (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId,
      prompt: 'summarize these notes',
      cwd: 'agents/research/notes/today',
    })) as { sessionId: string }

    expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
      agent: { id: inner.id, name: 'Notebook' },
    })
    expect((await getSession(workspaceId, session.sessionId))?.agent).not.toEqual({
      id: outer.id,
      name: 'research',
    })
  })

  test('agent attribution is immutable, idempotent, and consistent across session and Job reads', async () => {
    const workspaceId = await createWorkspace('attr-history')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/writer',
      slug: 'writer',
    })) as { id: string }
    const first = (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
      workspaceId,
      attemptId: 'agent-attribution-first',
      now: 40_000,
      input: {
        sender: { kind: 'user', userId: owner.user._id },
        kind: 'initial_prompt',
        prompt: 'draft the report',
        behavior: 'steer',
        clientRequestId: '10000000-0000-4000-8000-000000000001',
        cwd: 'agents/writer/drafts',
      },
    })) as { sessionId: string; created: { snapshot: { agent?: { id: string; name: string } } } }
    expect(first.created.snapshot.agent).toEqual({ id: agent.id, name: 'writer' })

    await mutate(owner.client, 'domains/agents/model:updateAgent', {
      workspaceId,
      slug: 'writer',
      name: 'Renamed Writer',
      now: 41_000,
    })
    const retried = (await convex.mutation(
      'domains/agentSessions/model:prepareRunnerInputDelivery',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        workspaceId,
        attemptId: 'agent-attribution-retry',
        now: 42_000,
        input: {
          sender: { kind: 'user', userId: owner.user._id },
          kind: 'initial_prompt',
          prompt: 'draft the report',
          behavior: 'steer',
          clientRequestId: '10000000-0000-4000-8000-000000000001',
          cwd: 'agents/writer/drafts',
        },
      },
    )) as {
      sessionId: string
      deduplicated: true
      created: { snapshot: { agent?: { id: string; name: string } } }
    }
    expect(retried).toMatchObject({
      sessionId: first.sessionId,
      deduplicated: true,
      created: { snapshot: { agent: { id: agent.id, name: 'writer' } } },
    })

    // A second session under the same agent, promoted to an active job before the delete,
    // so the sweep must move it to Job history — the assertion D16 overturns.
    const job = (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
      workspaceId,
      attemptId: 'agent-attribution-job',
      now: 42_500,
      input: {
        sender: { kind: 'user', userId: owner.user._id },
        kind: 'initial_prompt',
        prompt: 'run a scheduled job',
        behavior: 'steer',
        clientRequestId: '10000000-0000-4000-8000-000000000002',
        cwd: 'agents/writer/drafts',
      },
    })) as { sessionId: string }
    await relay(workspaceId, job.sessionId, {
      type: 'state_machine',
      stateMachine: stateMachineFixture(),
    })
    expect((await listJobs(workspaceId, { view: 'active' })).jobs).toContainEqual(
      expect.objectContaining({
        id: job.sessionId,
        agent: { id: agent.id, name: 'Renamed Writer' },
      }),
    )

    await mutate(owner.client, 'domains/agents/model:deleteAgent', {
      workspaceId,
      slug: 'writer',
      now: 43_000,
    })

    // Neighbour invariants stay green: attribution is immutable and survives the agent
    // row being gone — in the session read and, once terminalized, the sessions list.
    expect(await getSession(workspaceId, first.sessionId)).toMatchObject({
      agent: { id: agent.id, name: 'writer' },
    })
    await eventually(async () => {
      expect((await listSessions(workspaceId)).items).toContainEqual(
        expect.objectContaining({
          id: first.sessionId,
          turnStatus: 'interrupted',
          agent: { id: agent.id, name: 'writer' },
        }),
      )
    })
    expect((await listEvents(workspaceId, first.sessionId)).at(-1)?.event).toMatchObject({
      type: 'interrupted',
      error: 'agent_deleted',
    })
    expect(await findCoveringTerminal(workspaceId, first.sessionId, 2)).toBeNull()

    // D16: the live job stops and moves to history — it is no longer an active
    // job, and attribution stays readable through the Job read too.
    await eventually(async () => {
      expect((await listJobs(workspaceId, { view: 'history' })).jobs).toContainEqual(
        expect.objectContaining({
          id: job.sessionId,
          bucket: 'done',
          agent: { id: agent.id, name: 'Renamed Writer' },
        }),
      )
    })
    expect((await listJobs(workspaceId, { view: 'active' })).jobs).not.toContainEqual(
      expect.objectContaining({ id: job.sessionId }),
    )
    expect((await listEvents(workspaceId, job.sessionId)).at(-1)?.event).toMatchObject({
      type: 'interrupted',
      error: 'agent_deleted',
    })
  })

  test('deleting an agent terminalizes only its work and converges across more than one batch', async () => {
    const workspaceId = await createWorkspace('agent-delete-sweep')
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/doomed',
      slug: 'doomed',
    })
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/keeper',
      slug: 'keeper',
    })
    // Nine attributed sessions — one more than the sweep's batch size (8) — so the
    // self-rescheduling continuation is exercised, not just the first pass.
    const doomed: { sessionId: string }[] = []
    for (let index = 0; index < 9; index += 1) {
      doomed.push(
        await createSessionInDir(
          workspaceId,
          `doomed ${index}`,
          50_000 + index,
          'agents/doomed/work',
        ),
      )
    }
    // One of them is a live active job (has a state machine); the rest are fresh runners
    // with no jobView yet — both must terminalize.
    await relay(workspaceId, doomed[0]!.sessionId, {
      type: 'state_machine',
      stateMachine: stateMachineFixture(),
    })
    expect((await listJobs(workspaceId, { view: 'active' })).jobs).toContainEqual(
      expect.objectContaining({ id: doomed[0]!.sessionId }),
    )

    // Controls: a root (unattributed) session and a second agent's active job.
    const rootSession = await createSession(workspaceId, 'root control session')
    const keeperSession = await createSessionInDir(
      workspaceId,
      'keeper control session',
      50_100,
      'agents/keeper/work',
    )
    await relay(workspaceId, keeperSession.sessionId, {
      type: 'state_machine',
      stateMachine: stateMachineFixture(),
    })

    await mutate(owner.client, 'domains/agents/model:deleteAgent', {
      workspaceId,
      slug: 'doomed',
      now: 60_000,
    })

    await eventually(async () => {
      const stored = await Promise.all(
        doomed.map(session => getSession(workspaceId, session.sessionId)),
      )
      expect(stored.map(session => session?.turnStatus)).toEqual(doomed.map(() => 'interrupted'))
    }, 30_000)
    for (const session of doomed) {
      expect((await listEvents(workspaceId, session.sessionId)).at(-1)?.event).toMatchObject({
        type: 'interrupted',
        error: 'agent_deleted',
      })
    }
    // The active job moved to history; no doomed session remains an active job.
    const activeJobs = (await listJobs(workspaceId, { view: 'active' })).jobs as { id: string }[]
    expect(activeJobs.some(job => doomed.some(d => d.sessionId === job.id))).toBe(false)
    expect((await listJobs(workspaceId, { view: 'history' })).jobs).toContainEqual(
      expect.objectContaining({ id: doomed[0]!.sessionId, bucket: 'done' }),
    )

    // Untouched controls: the root session and the second agent's job never terminalize.
    expect(await getSession(workspaceId, rootSession.sessionId)).toMatchObject({
      turnStatus: 'running',
    })
    expect(await getSession(workspaceId, keeperSession.sessionId)).toMatchObject({
      turnStatus: 'running',
    })
    expect((await listJobs(workspaceId, { view: 'active' })).jobs).toContainEqual(
      expect.objectContaining({ id: keeperSession.sessionId, bucket: 'running' }),
    )
  }, 60_000)

  test('drive root and sibling-prefix cwd values remain the unattributed default agent', async () => {
    const workspaceId = await createWorkspace('attr-default')
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/rev',
      slug: 'review',
    })
    for (const [prompt, cwd] of [
      ['root session', ''],
      ['sibling session', 'agents/reviewer'],
    ] as const) {
      const session = (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        workspaceId,
        prompt,
        cwd,
      })) as { sessionId: string }
      expect((await getSession(workspaceId, session.sessionId))?.agent).toBeUndefined()
    }
  })
}
