import { describe, expect, test } from 'bun:test'

import { ROOT_AGENT_SCOPE } from '@repo/contract'
import { mutate } from '@repo/test-harness'

import {
  INTERNAL_KEY,
  convex,
  owner,
  registerTestAgent,
  addReaders,
  deliverDefault,
  getDefaultSession,
  setDefaultSession,
  createWorkspace,
  createSession,
  markRunnerInputDelivered,
  getSession,
  listEvents,
  listSessions,
} from './test-support'

export function registerDefaultSessionTests(): void {
  describe('default session aliases', () => {
    test('default history distinguishes an absent alias from denied current policy', async () => {
      const workspaceId = await createWorkspace('default-history-miss-kind')
      await expect(
        convex.query('domains/agentSessions/model:listDefaultSessionHistoryPage', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          owner: { kind: 'root' },
          identity: { principal: { kind: 'workspace' }, actorId: owner.user._id },
          order: 'desc',
          limit: 10,
        }),
      ).rejects.toThrow(/no_default_session/)

      await deliverDefault(
        workspaceId,
        { kind: 'root' },
        'Default exists now.',
        'default-history-miss-kind-create',
        1_000,
      )
      const [removedReader] = await addReaders(workspaceId, 'default-history-denied', 1)
      await mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
        workspaceId,
        userId: removedReader!,
      })
      await expect(
        convex.query('domains/agentSessions/model:listDefaultSessionHistoryPage', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          owner: { kind: 'root' },
          identity: {
            principal: { kind: 'human', userId: removedReader! },
            actorId: removedReader!,
          },
          order: 'desc',
          limit: 10,
        }),
      ).rejects.toThrow(/not_found/)
    })

    /* The jobs dialog lists everything an agent has done *except* the thread
       that is the agent's chat — that one has its own panel beside the list, so
       a row for it in the list is the same conversation offered twice, once
       under a heading that calls it work.

       The list cannot tell which row that is: the fact lives on the owner's row
       as `defaultSessionId`, and it stays there. The query resolves the pointer
       once and drops the row, rather than the summary carrying a flag that
       would make two owners of one fact. */
    test('a list can be asked to leave out the owner\u2019s own chat', async () => {
      const workspaceId = await createWorkspace('default-excluded')

      const chat = (await convex.mutation(
        'domains/agentSessions/model:prepareRunnerInputDelivery',
        {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          defaultOwner: { kind: 'root' },
          attemptId: 'default-excluded-chat',
          input: {
            sender: { kind: 'user', userId: owner.user._id },
            kind: 'initial_prompt',
            prompt: 'The drive\u2019s own chat.',
            behavior: 'steer',
          },
          now: 1_000,
        },
      )) as { sessionId: string }

      const work = await createSession(workspaceId, 'Ordinary work')

      const everything = await listSessions(workspaceId, { agentId: ROOT_AGENT_SCOPE })
      expect(everything.items.map(session => session.id).sort()).toEqual(
        [chat.sessionId, work.sessionId].sort(),
      )

      const listed = await listSessions(workspaceId, {
        agentId: ROOT_AGENT_SCOPE,
        excludeDefault: true,
      })
      expect(listed.items.map(session => session.id)).toEqual([work.sessionId])
    })

    /* Asking for it without naming an owner is a question with no answer: every
       agent has its own default, so "leave out the default" over the whole
       drive would have to leave out one row per face. The wire refuses rather
       than guessing, because a filter that silently does nothing is worse than
       one that is not offered. */
    test('excluding the default requires saying whose default it is', async () => {
      const workspaceId = await createWorkspace('default-excluded-unscoped')
      await expect(listSessions(workspaceId, { excludeDefault: true })).rejects.toThrow(/agentId/i)
    })

    test('a human opens the default chat of an agent that never onboarded', async () => {
      const workspaceId = await createWorkspace('default-never-onboarded')
      // The ordinary agent: registered from its folder, declaring no onboarding,
      // so nothing ever stamps `onboardedAt`. Its chat opens for a human like
      // any other; only a session that IS onboarding is gated.
      const agent = await registerTestAgent(workspaceId, 'agents/plain', 'plain', 'Plain')
      const created = await deliverDefault(
        workspaceId,
        { kind: 'agent', agentId: agent.id },
        'Hello, plain agent.',
        'default-never-onboarded-create',
        1_000,
        'agents/plain',
      )
      expect(created.created).toBeDefined()
      const viewer = (await addReaders(workspaceId, 'default-never-onboarded', 1))[0]!
      expect(
        await convex.query('domains/agentSessions/model:getDefaultSession', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          owner: { kind: 'agent', agentId: agent.id },
          identity: { principal: { kind: 'human', userId: viewer }, actorId: viewer },
        }),
      ).toMatchObject({ id: created.sessionId })
      expect(
        (await listSessions(workspaceId, { actorId: viewer })).items.map(row => row.id),
      ).toEqual([created.sessionId])
    }, 60_000)

    test('a root default payload creates and stamps once, then delivers ordinary messages', async () => {
      const workspaceId = await createWorkspace('default-root-create')

      const first = (await convex.mutation(
        'domains/agentSessions/model:prepareRunnerInputDelivery',
        {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          defaultOwner: { kind: 'root' },
          attemptId: 'default-root-first',
          input: {
            sender: { kind: 'user', userId: owner.user._id },
            kind: 'initial_prompt',
            prompt: 'Start the root default.',
            behavior: 'steer',
          },
          now: 1_000,
        },
      )) as { sessionId: string; created?: unknown; dispatch: { defaultSession?: true } }

      expect(first.created).toBeDefined()
      expect(first.dispatch).toMatchObject({ defaultSession: true })
      expect(
        await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
        }),
      ).toMatchObject({ rootDefaultSessionId: first.sessionId })

      // Settle the creating lease first: an undelivered first input makes the
      // second prepare queue (no dispatch lease), which is the busy path, not
      // the deliver-ordinary-message path this test pins.
      await markRunnerInputDelivered(
        workspaceId,
        first.sessionId,
        (first.dispatch as { attemptId: string }).attemptId,
        (first.dispatch as { throughSeq: number }).throughSeq,
      )

      const second = (await convex.mutation(
        'domains/agentSessions/model:prepareRunnerInputDelivery',
        {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          defaultOwner: { kind: 'root' },
          attemptId: 'default-root-second',
          input: {
            sender: { kind: 'user', userId: owner.user._id },
            kind: 'initial_prompt',
            prompt: 'Continue the root default.',
            behavior: 'steer',
          },
          now: 2_000,
        },
      )) as { sessionId: string; created?: unknown; dispatch: { defaultSession?: true } }

      expect(second.sessionId).toBe(first.sessionId)
      expect(second.created).toBeUndefined()
      expect(second.dispatch).toMatchObject({ defaultSession: true })
      expect((await listEvents(workspaceId, first.sessionId)).map(row => row.event)).toMatchObject([
        { type: 'session_created', prompt: 'Start the root default.' },
        { type: 'prompt_submitted', inputKind: 'initial', prompt: 'Start the root default.' },
        { type: 'prompt_submitted', inputKind: 'message', prompt: 'Continue the root default.' },
      ])
    })

    test('a default create materializes the agent first message once, ahead of the prompt', async () => {
      const workspaceId = await createWorkspace('default-first-message')
      const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId,
        path: 'agents/researcher',
        slug: 'researcher',
      })) as { id: string }
      // Angle brackets on purpose: the envelope must carry the message as
      // inert escaped text, never as markup.
      const greeting = 'Hi — I’m your researcher. <Who> should we look at first?'
      const deliver = (attemptId: string, now: number) =>
        convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          defaultOwner: { kind: 'agent', agentId: agent.id },
          attemptId,
          input: {
            sender: { kind: 'user', userId: owner.user._id },
            kind: 'initial_prompt',
            prompt: 'acme.com',
            behavior: 'steer',
            cwd: 'agents/researcher',
            agentFirstMessage: greeting,
          },
          now,
        }) as Promise<{
          sessionId: string
          created?: unknown
          dispatch: { message: string; attemptId: string; throughSeq: number }
        }>

      const first = await deliver('default-first-message-create', 1_000)
      const events = await listEvents(workspaceId, first.sessionId)
      expect(events.map(row => row.event)).toMatchObject([
        { type: 'session_created', prompt: 'acme.com' },
        { type: 'agent_message', message: greeting },
        { type: 'prompt_submitted', inputKind: 'initial', prompt: 'acme.com' },
      ])
      const promptSeq = events[2]!.seq
      // The runner-input cursor tracks the prompt, never the agent's message:
      // the agent message is not deliverable input.
      expect(
        await convex.query('testing/agentSessions:rawSessionForTest', {
          internalKey: INTERNAL_KEY,
          sessionId: first.sessionId,
        }),
      ).toMatchObject({ lastRunnerInputSeq: promptSeq })
      // The first envelope quotes the message, escaped, ahead of the user's.
      const envelope = first.dispatch.message
      expect(envelope).toContain(
        '<agent_first_message>Hi — I’m your researcher. &lt;Who&gt; should we look at first?</agent_first_message>',
      )
      expect(envelope.indexOf('<agent_first_message')).toBeLessThan(
        envelope.indexOf('<user_message'),
      )

      // A second initial through the alias redirects to an ordinary message:
      // no second agent_message in history, none quoted to the runner.
      await markRunnerInputDelivered(
        workspaceId,
        first.sessionId,
        first.dispatch.attemptId,
        first.dispatch.throughSeq,
      )
      const second = await deliver('default-first-message-redirect', 2_000)
      expect(second.sessionId).toBe(first.sessionId)
      const after = await listEvents(workspaceId, first.sessionId)
      expect(
        after
          .filter(row => row.event.type === 'agent_message')
          .map(row => ({ type: row.event.type, message: row.event.message })),
      ).toEqual([{ type: 'agent_message', message: greeting }])
      expect(second.dispatch.message).not.toContain('agent_first_message')
    })

    test('concurrent first deliveries converge while agent and root owners remain distinct', async () => {
      const workspaceId = await createWorkspace('default-concurrent')
      const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId,
        path: 'agents/research',
        slug: 'research',
      })) as { id: string }
      const deliver = (
        ownerSpec: { kind: 'root' } | { kind: 'agent'; agentId: string },
        prompt: string,
        attemptId: string,
        cwd?: string,
      ) =>
        convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          defaultOwner: ownerSpec,
          attemptId,
          input: {
            sender: { kind: 'user', userId: owner.user._id },
            kind: 'initial_prompt',
            prompt,
            behavior: 'steer',
            ...(cwd === undefined ? {} : { cwd }),
          },
          now: 1_000,
        }) as Promise<{ sessionId: string; created?: unknown }>

      const [first, second] = await Promise.all([
        deliver({ kind: 'root' }, 'Root race one.', 'root-race-one'),
        deliver({ kind: 'root' }, 'Root race two.', 'root-race-two'),
      ])
      expect(second.sessionId).toBe(first.sessionId)
      expect([first.created, second.created].filter(Boolean)).toHaveLength(1)
      expect(
        (await listSessions(workspaceId, { agentId: ROOT_AGENT_SCOPE })).items.map(row => row.id),
      ).toEqual([first.sessionId])

      const agentDefault = await deliver(
        { kind: 'agent', agentId: agent.id },
        'Agent default.',
        'agent-default',
        'agents/research',
      )
      expect(agentDefault.sessionId).not.toBe(first.sessionId)
      expect(await getSession(workspaceId, agentDefault.sessionId)).toMatchObject({
        cwd: 'agents/research',
        agent: { id: agent.id },
      })
      const agents = (await convex.query('testing/agents:rawAgentsForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<{ _id: string; defaultSessionId?: string }>
      expect(agents.find(row => row._id === agent.id)?.defaultSessionId).toBe(
        agentDefault.sessionId,
      )
    })

    test('archive preserves the pointer, while delete clears it and the next delivery recreates', async () => {
      const workspaceId = await createWorkspace('default-lifecycle')
      const createDefault = (attemptId: string, prompt: string, now: number) =>
        convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          defaultOwner: { kind: 'root' },
          attemptId,
          input: {
            kind: 'initial_prompt',
            prompt,
            behavior: 'steer',
            sender: { kind: 'user', userId: owner.user._id },
          },
          now,
        }) as Promise<{ sessionId: string }>
      const first = await createDefault('default-lifecycle-first', 'First default.', 1_000)

      await convex.mutation('domains/agentSessions/model:setSessionArchive', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        kind: 'global',
        workspaceId,
        sessionId: first.sessionId,
        archived: true,
        now: 2_000,
      })
      expect(
        await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
        }),
      ).toMatchObject({ rootDefaultSessionId: first.sessionId })

      await convex.mutation('domains/agentSessions/model:beginSessionSubtreeDeletion', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        workspaceId,
        sessionId: first.sessionId,
        now: 3_000,
      })
      expect(
        await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
        }),
      ).not.toHaveProperty('rootDefaultSessionId')

      const replacement = await createDefault(
        'default-lifecycle-replacement',
        'Replacement default.',
        4_000,
      )
      expect(replacement.sessionId).not.toBe(first.sessionId)
      expect(
        await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
        }),
      ).toMatchObject({ rootDefaultSessionId: replacement.sessionId })
    })

    test('deletion preserves a repointed default slot', async () => {
      const workspaceId = await createWorkspace('default-delete-repoint')
      const original = await deliverDefault(
        workspaceId,
        { kind: 'root' },
        'Original default.',
        'default-delete-repoint-original',
        1_000,
      )
      const replacement = await createSession(workspaceId, 'Replacement default target')
      const identity = {
        principal: { kind: 'human' as const, userId: owner.user._id },
        actorId: owner.user._id,
      }
      await convex.mutation('domains/agentSessions/model:setDefaultSession', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        owner: { kind: 'root' },
        sessionId: replacement.sessionId,
        actorId: owner.user._id,
        identity,
      })
      await convex.mutation('domains/agentSessions/model:beginSessionSubtreeDeletion', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: original.sessionId,
        actorId: owner.user._id,
        identity,
        now: 2_000,
      })
      expect(
        await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
        }),
      ).toMatchObject({ rootDefaultSessionId: replacement.sessionId })
    })

    /* Demoting the chat is the whole "archive default chat" gesture, and the
       only durable change it makes is the pointer. The conversation keeps its
       archiveState and its place; it simply stops being the owner's chat, which
       is what moves it into the very list its own panel held it out of. */
    test('clearing an agent pointer demotes the chat into the list that excluded it', async () => {
      const workspaceId = await createWorkspace('default-demote-agent')
      const agent = await registerTestAgent(workspaceId, 'agents/scout', 'scout')
      const ownerSpec = { kind: 'agent', agentId: agent.id } as const
      const chat = await deliverDefault(
        workspaceId,
        ownerSpec,
        'The agent’s own chat.',
        'default-demote-agent-chat',
        1_000,
        'agents/scout',
      )
      const jobs = async () =>
        (await listSessions(workspaceId, { agentId: agent.id, excludeDefault: true })).items.map(
          session => session.id,
        )
      expect(await jobs()).toEqual([])

      expect(await setDefaultSession(workspaceId, ownerSpec, null)).toBeNull()

      expect(await jobs()).toEqual([chat.sessionId])
      expect(await getDefaultSession(workspaceId, ownerSpec)).toBeNull()
      // Demote, not archive: the session row is untouched, so it stays an
      // ordinary active conversation rather than one hidden behind
      // `archived: 'only'` — there is no archived view in the product to land
      // in, which is exactly why this gesture does not use archiveState.
      expect(await getSession(workspaceId, chat.sessionId)).toMatchObject({ id: chat.sessionId })
      expect(await getSession(workspaceId, chat.sessionId)).not.toHaveProperty('archivedAt')
      expect((await listSessions(workspaceId, { archived: 'only' })).items).toEqual([])

      // Idempotent: the caller asked for a state, not for a transition, and
      // the button that sends this is one click away from being pressed twice.
      expect(await setDefaultSession(workspaceId, ownerSpec, null)).toBeNull()
      expect(await getDefaultSession(workspaceId, ownerSpec)).toBeNull()
    })

    /* The root owner is an owner like any agent, on its own column. Its half of
       the round trip is the part the product actually performs: clear, then let
       the next message mint a replacement. */
    test('a cleared root pointer leaves the old chat alone and the next delivery mints a fresh one', async () => {
      const workspaceId = await createWorkspace('default-demote-root')
      const first = await deliverDefault(
        workspaceId,
        { kind: 'root' },
        'First chat.',
        'default-demote-root-first',
        1_000,
      )

      expect(await setDefaultSession(workspaceId, { kind: 'root' }, null)).toBeNull()
      expect(
        await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
        }),
      ).not.toHaveProperty('rootDefaultSessionId')
      expect(await getDefaultSession(workspaceId, { kind: 'root' })).toBeNull()
      expect(
        (
          await listSessions(workspaceId, {
            agentId: ROOT_AGENT_SCOPE,
            excludeDefault: true,
          })
        ).items.map(session => session.id),
      ).toEqual([first.sessionId])

      const second = await deliverDefault(
        workspaceId,
        { kind: 'root' },
        'Second chat.',
        'default-demote-root-second',
        2_000,
      )
      expect(second.sessionId).not.toBe(first.sessionId)
      expect(second.created).toBeDefined()
      expect(await getDefaultSession(workspaceId, { kind: 'root' })).toMatchObject({
        id: second.sessionId,
      })
      // The demoted conversation is still whole — nothing was deleted, and its
      // history is the one the user can go back and reply to.
      expect((await listEvents(workspaceId, first.sessionId)).map(row => row.event.type)).toEqual([
        'session_created',
        'prompt_submitted',
      ])

      // Reversible on the wire even though the product only ever clears:
      // aiming the pointer back answers with the same snapshot the alias read
      // would return.
      expect(await setDefaultSession(workspaceId, { kind: 'root' }, first.sessionId)).toMatchObject(
        { id: first.sessionId },
      )
      expect(await getDefaultSession(workspaceId, { kind: 'root' })).toMatchObject({
        id: first.sessionId,
      })
    })

    /* Delivery refuses to stamp a pointer at a session of another owner, and
       this writer has to refuse the same thing: a pointer that names a session
       its readers all skip is a default chat nobody can open. */
    test('a pointer refuses a session belonging to another owner', async () => {
      const workspaceId = await createWorkspace('default-demote-guard')
      const agent = await registerTestAgent(workspaceId, 'agents/one', 'agent-one')
      const other = await registerTestAgent(workspaceId, 'agents/two', 'agent-two')
      const chat = await deliverDefault(
        workspaceId,
        { kind: 'agent', agentId: agent.id },
        'One’s chat.',
        'default-demote-guard-chat',
        1_000,
        'agents/one',
      )

      await expect(
        setDefaultSession(workspaceId, { kind: 'agent', agentId: other.id }, chat.sessionId),
      ).rejects.toMatchObject({ data: { error: 'not_found' } })
      await expect(
        setDefaultSession(workspaceId, { kind: 'root' }, chat.sessionId),
      ).rejects.toMatchObject({ data: { error: 'not_found' } })

      expect(
        await getDefaultSession(workspaceId, { kind: 'agent', agentId: agent.id }),
      ).toMatchObject({ id: chat.sessionId })
      expect(await getDefaultSession(workspaceId, { kind: 'agent', agentId: other.id })).toBeNull()
      expect(await getDefaultSession(workspaceId, { kind: 'root' })).toBeNull()
    })

    test('a viewer can converse through a default chat but cannot move its pointer', async () => {
      const workspaceId = await createWorkspace('default-demote-role')
      const chat = await deliverDefault(
        workspaceId,
        { kind: 'root' },
        'Owner’s chat.',
        'default-demote-role-chat',
        1_000,
      )
      const reader = (await addReaders(workspaceId, 'default-demote-role', 1))[0]!

      await expect(
        convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
          internalKey: INTERNAL_KEY,
          actorId: reader,
          identity: { principal: { kind: 'human', userId: reader }, actorId: reader },
          workspaceId,
          defaultOwner: { kind: 'root' },
          attemptId: 'default-demote-role-viewer-message',
          input: {
            sender: { kind: 'user', userId: reader },
            kind: 'initial_prompt',
            prompt: 'Viewer continuation.',
            behavior: 'steer',
          },
          now: 2_000,
        }),
      ).resolves.toMatchObject({ sessionId: chat.sessionId })
      await expect(
        setDefaultSession(workspaceId, { kind: 'root' }, null, reader),
      ).rejects.toMatchObject({ data: { error: 'forbidden' } })
      expect(await getDefaultSession(workspaceId, { kind: 'root' })).toMatchObject({
        id: chat.sessionId,
      })
    })
  })
}
