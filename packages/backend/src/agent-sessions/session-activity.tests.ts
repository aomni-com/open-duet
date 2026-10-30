import { describe, expect, test } from 'bun:test'

import { ROOT_AGENT_SCOPE, SESSION_ACTIVITY_MAX_LIMIT } from '@repo/contract'

import {
  INTERNAL_KEY,
  convex,
  owner,
  sessionActivity,
  registerTestAgent,
  createSessionInDir,
  markSessionRead,
  listSessionsAs,
  addReaders,
  setDefaultSession,
  setSessionGlobalArchive,
  createWorkspace,
  createSession,
  createSessionAt,
  appendSessionNote,
  relay,
  terminalEvent,
} from './test-support'

export function registerSessionActivityTests(): void {
  describe('the ring\u2019s activity read', () => {
    test('a human viewer sees root work and work owned by an agent that never onboarded', async () => {
      const workspaceId = await createWorkspace('session-activity-never-onboarded')
      const viewer = (await addReaders(workspaceId, 'activity-never-onboarded', 1))[0]!
      const agent = await registerTestAgent(workspaceId, 'agents/plain', 'plain', 'Plain')
      const root = await createSessionInDir(workspaceId, 'root work', 1_000, '')
      const work = await createSessionInDir(workspaceId, 'agent work', 2_000, 'agents/plain/work')

      const human = await sessionActivity(workspaceId, viewer)
      expect(human.get(ROOT_AGENT_SCOPE)?.sessions.map(row => row.id)).toContain(root.sessionId)
      expect(human.get(agent.id)?.sessions.map(row => row.id)).toEqual([work.sessionId])
    }, 120_000)

    test('every owner is complete, however the drive\u2019s work is distributed', async () => {
      const workspaceId = await createWorkspace('session-activity-owners')
      const agentA = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const agentB = await registerTestAgent(workspaceId, 'agents/b', 'agent-b', 'Agent B')

      // The quiet owner's oldest job must survive another owner exceeding
      // the grouped read's whole per-owner budget.
      const bJob = await createSessionInDir(workspaceId, 'agent b, long ago', 1_000, 'agents/b/z')
      const aJobs = []
      for (let index = 0; index < SESSION_ACTIVITY_MAX_LIMIT * 2; index += 1) {
        aJobs.push(
          await createSessionInDir(workspaceId, `agent a ${index}`, 10_000 + index, 'agents/a/x'),
        )
      }

      const activity = await sessionActivity(workspaceId)
      expect(activity.get(agentB.id)?.sessions.map(row => row.id)).toEqual([bJob.sessionId])
      // A's own list is bounded by the caller's limit, and says so rather than
      // pretending it is whole.
      expect(activity.get(agentA.id)?.sessions.map(row => row.id)).toEqual(
        aJobs
          .slice(-SESSION_ACTIVITY_MAX_LIMIT)
          .reverse()
          .map(row => row.sessionId),
      )
      expect(activity.get(agentA.id)?.truncated).toBe(true)
      // The activity budget is fixed: a caller cannot widen one grouped read.
      const wider = await sessionActivity(workspaceId, undefined, SESSION_ACTIVITY_MAX_LIMIT + 1)
      expect(wider.get(agentA.id)?.sessions.map(row => row.id)).toEqual(
        aJobs
          .slice(-SESSION_ACTIVITY_MAX_LIMIT)
          .reverse()
          .map(row => row.sessionId),
      )
      expect(wider.get(agentA.id)?.truncated).toBe(true)
    }, 120_000)

    test('personal archives do not spend the bounded activity seats', async () => {
      const workspaceId = await createWorkspace('session-activity-personal-archive-seats')
      const [viewer] = await addReaders(workspaceId, 'activity-personal-archive-seats', 1)
      const membershipId = (
        (await convex.query('testing/workspaces:workspaceMembersForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
        })) as Array<{ _id: string; userId: string }>
      ).find(row => row.userId === viewer)!._id
      const agent = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const visible = await createSessionInDir(workspaceId, 'visible older work', 100, 'agents/a/x')
      const hidden = await Promise.all([
        createSessionInDir(workspaceId, 'hidden newer work one', 200, 'agents/a/x'),
        createSessionInDir(workspaceId, 'hidden newer work two', 300, 'agents/a/x'),
      ])
      for (const session of hidden) {
        await convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          sessionId: session.sessionId,
          membershipId,
          archivedAt: 1_000,
        })
      }

      const activity = (await sessionActivity(workspaceId, viewer, 1)).get(agent.id)
      expect(activity?.sessions.map(row => row.id)).toEqual([visible.sessionId])
      expect(activity?.truncated).toBe(false)
    }, 120_000)

    test('personal archive lookthrough stays bounded and reports unknown older work', async () => {
      const workspaceId = await createWorkspace('session-activity-personal-archive-bound')
      const [viewer] = await addReaders(workspaceId, 'activity-personal-archive-bound', 1)
      const membershipId = (
        (await convex.query('testing/workspaces:workspaceMembersForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
        })) as Array<{ _id: string; userId: string }>
      ).find(row => row.userId === viewer)!._id
      const agent = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const chat = await createSessionInDir(workspaceId, 'the chat', 50, 'agents/a/x')
      await setDefaultSession(workspaceId, { kind: 'agent', agentId: agent.id }, chat.sessionId)
      await createSessionInDir(workspaceId, 'visible beyond the bound', 100, 'agents/a/x')
      const hidden = await Promise.all(
        Array.from({ length: SESSION_ACTIVITY_MAX_LIMIT * 2 }, (_, index) =>
          createSessionInDir(
            workspaceId,
            `hidden newer work ${index}`,
            1_000 + index,
            'agents/a/x',
          ),
        ),
      )
      await Promise.all(
        hidden.map(session =>
          convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
            internalKey: INTERNAL_KEY,
            workspaceId,
            sessionId: session.sessionId,
            membershipId,
            archivedAt: 2_000,
          }),
        ),
      )

      const activity = (await sessionActivity(workspaceId, viewer, 1)).get(agent.id)
      expect(activity?.sessions).toEqual([])
      expect(activity?.truncated).toBe(true)
    }, 120_000)

    /* ---- the conversation an owner *is*, beside the work it did ----
       Every reader of this response has to tell those two apart, and only the
       pointer can: no row carries the fact. Answering it here is what lets the
       map stop asking one alias per face — and what stops the chat competing
       for the seats, the count, and the recency that belong to work. */
    test('an owner\u2019s own chat comes back beside its work, never inside it', async () => {
      const workspaceId = await createWorkspace('session-activity-chat')
      const agent = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const chat = await createSessionInDir(workspaceId, 'the chat', 1_000, 'agents/a/x')
      const job = await createSessionInDir(workspaceId, 'the work', 2_000, 'agents/a/x')
      await setDefaultSession(workspaceId, { kind: 'agent', agentId: agent.id }, chat.sessionId)

      const owner = (await sessionActivity(workspaceId)).get(agent.id)
      expect(owner?.chat?.id).toBe(chat.sessionId)
      expect(owner?.sessions.map(row => row.id)).toEqual([job.sessionId])
    }, 120_000)

    /* The drive root is an owner like any face; its pointer just lives on the
       workspace row instead of an agent's. */
    test('the drive root\u2019s own chat is answered the same way', async () => {
      const workspaceId = await createWorkspace('session-activity-root-chat')
      const chat = await createSessionAt(workspaceId, 'the drive chat', 1_000)
      const job = await createSessionAt(workspaceId, 'the drive work', 2_000)
      await setDefaultSession(workspaceId, { kind: 'root' }, chat.sessionId)

      const root = (await sessionActivity(workspaceId)).get(ROOT_AGENT_SCOPE)
      expect(root?.chat?.id).toBe(chat.sessionId)
      expect(root?.sessions.map(row => row.id)).toEqual([job.sessionId])
    }, 120_000)

    test('an archived default chat is still resolved exactly from discovery', async () => {
      const workspaceId = await createWorkspace('session-activity-archived-chat')
      const chat = await createSessionAt(workspaceId, 'archived chat', 1_000)
      await setDefaultSession(workspaceId, { kind: 'root' }, chat.sessionId)
      await setSessionGlobalArchive(workspaceId, chat.sessionId, true)

      const root = (await sessionActivity(workspaceId)).get(ROOT_AGENT_SCOPE)
      expect(root?.chat).toEqual({
        id: chat.sessionId,
        title: 'archived chat',
        bucket: 'running',
        updatedAt: expect.any(Number),
        unread: false,
        preview: {
          text: 'archived chat',
          author: { kind: 'user', userId: owner.user._id },
        },
      })
      expect(root?.sessions).toEqual([])
    }, 120_000)

    /* The seats are for work. A chat left among them spends one of them, and on
       an owner at its limit that drops a real job off the end of the answer —
       where no client can page to it, because this read has no cursor. */
    test('the chat does not spend one of the seats work is counted into', async () => {
      const workspaceId = await createWorkspace('session-activity-chat-seat')
      const agent = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const jobs: string[] = []
      for (let index = 0; index < 3; index += 1) {
        jobs.push(
          (await createSessionInDir(workspaceId, `job ${index}`, 1_000 + index, 'agents/a/x'))
            .sessionId,
        )
      }
      /* The *newest* row of the lot, which is the only version of this fixture
         that can fail: seating is recency inside a bucket, so a chat left among
         the work takes the first seat and pushes a real job off an answer that
         has no cursor to page to. An older chat falls off the end on its own
         and proves nothing. */
      const chat = await createSessionInDir(workspaceId, 'the chat', 9_000, 'agents/a/x')
      await setDefaultSession(workspaceId, { kind: 'agent', agentId: agent.id }, chat.sessionId)

      const owner = (await sessionActivity(workspaceId, undefined, 3)).get(agent.id)
      expect(owner?.sessions.map(row => row.id)).toEqual([jobs[2]!, jobs[1]!, jobs[0]!])
      // Three jobs and three seats: the answer is whole, and says so.
      expect(owner?.truncated).toBe(false)
    }, 120_000)

    /* The seats are observed rather than inferred — each bucket is read one
       deeper than the caller asked for, so a full page is distinguishable from
       a page that happened to end exactly full. Taking the chat out of that
       window costs one of those observations back, so the window has to be one
       deeper again: there is at most one chat per owner. */
    test('a job hidden behind a full page is still reported as more', async () => {
      const workspaceId = await createWorkspace('session-activity-chat-window')
      const agent = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const jobs: string[] = []
      for (let index = 0; index < 3; index += 1) {
        jobs.push(
          (await createSessionInDir(workspaceId, `job ${index}`, 1_000 + index, 'agents/a/x'))
            .sessionId,
        )
      }
      const chat = await createSessionInDir(workspaceId, 'the chat', 9_000, 'agents/a/x')
      await setDefaultSession(workspaceId, { kind: 'agent', agentId: agent.id }, chat.sessionId)

      const owner = (await sessionActivity(workspaceId, undefined, 2)).get(agent.id)
      /* The ids, not the count: a chat left among the work also returns two rows
         and also says `truncated`, so a length alone cannot tell the fix from
         the defect. */
      expect(owner?.sessions.map(row => row.id)).toEqual([jobs[2]!, jobs[1]!])
      expect(owner?.truncated).toBe(true)
    }, 120_000)

    /* The mark is the whole reason the chat rides in this answer: the ring draws
       its dot from here now, and the per-face alias read that used to carry it
       is gone. `unread` is a fact about a reader, so the chat has to be *in* the
       batch those cursors are read for rather than merely beside it. */
    test('the chat carries this reader’s unread, the same way the work does', async () => {
      const workspaceId = await createWorkspace('session-activity-chat-unread')
      const reader = (await addReaders(workspaceId, 'activity-chat', 1))[0]!
      /* On the real clock, like the work-side test beside it: unread starts at
         the reader's own membership row, so a session stamped before they
         joined is below their floor and reads as seen however new it is. */
      const chat = await createSession(workspaceId, 'not seen yet')
      await setDefaultSession(workspaceId, { kind: 'root' }, chat.sessionId)

      const before = (await sessionActivity(workspaceId, reader)).get(ROOT_AGENT_SCOPE)!
      expect(before.chat?.unread).toBe(true)

      const chatSeq = (await listSessionsAs(workspaceId, reader)).find(
        row => row.id === chat.sessionId,
      )!.lastEventSeq
      await markSessionRead(workspaceId, chat.sessionId, reader, chatSeq)
      const after = (await sessionActivity(workspaceId, reader)).get(ROOT_AGENT_SCOPE)!
      expect(after.chat?.unread).toBe(false)
    }, 120_000)

    /* An owner nobody has given work to is still an owner: its face draws that
       conversation. It sorts under everything that has actually moved, because
       recency here is a question about work and an owner with none has none. */
    test('an owner whose only session is its chat still gets a face, and sits last', async () => {
      const workspaceId = await createWorkspace('session-activity-chat-only')
      const busy = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const quiet = await registerTestAgent(workspaceId, 'agents/b', 'agent-b', 'Agent B')
      await createSessionInDir(workspaceId, 'real work', 2_000, 'agents/a/x')
      /* Newer than the busy owner's work, so the ordering half of this test is
         load-bearing: an owner whose chat counted towards its recency would sort
         *above* the one that has actually done something. */
      const chat = await createSessionInDir(workspaceId, 'hello', 9_000, 'agents/b/x')
      await setDefaultSession(workspaceId, { kind: 'agent', agentId: quiet.id }, chat.sessionId)

      const owners = await sessionActivity(workspaceId)
      expect(owners.get(quiet.id)?.chat?.id).toBe(chat.sessionId)
      expect(owners.get(quiet.id)?.sessions).toEqual([])
      expect([...owners.keys()].filter(id => id !== ROOT_AGENT_SCOPE)).toEqual([busy.id, quiet.id])
    }, 120_000)

    /* Archiving an owner's chat is one write and it is not an archive: the
       pointer is cleared, and the conversation drops back into the work it was
       always among. This read has to hand it back, or the gesture makes a
       session disappear from both halves of the answer. */
    test('clearing the pointer hands the conversation back to the work', async () => {
      const workspaceId = await createWorkspace('session-activity-chat-cleared')
      const agent = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const chat = await createSessionInDir(workspaceId, 'the chat', 1_000, 'agents/a/x')
      const job = await createSessionInDir(workspaceId, 'the work', 2_000, 'agents/a/x')
      await setDefaultSession(workspaceId, { kind: 'agent', agentId: agent.id }, chat.sessionId)
      await setDefaultSession(workspaceId, { kind: 'agent', agentId: agent.id }, null)

      const owner = (await sessionActivity(workspaceId)).get(agent.id)
      expect(owner?.chat).toBeUndefined()
      expect(owner?.sessions.map(row => row.id)).toEqual([job.sessionId, chat.sessionId])
    }, 120_000)

    /* Between owners this response is ordered by who moved last, and that
       question is about work. An owner nobody has given anything to does not
       climb over one that is mid-job because somebody said hello to it. */
    test('talking to an owner does not sort it above one that is working', async () => {
      const workspaceId = await createWorkspace('session-activity-chat-recency')
      const busy = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const chatty = await registerTestAgent(workspaceId, 'agents/b', 'agent-b', 'Agent B')
      await createSessionInDir(workspaceId, 'real work', 2_000, 'agents/a/x')
      const chat = await createSessionInDir(workspaceId, 'just talking', 9_000, 'agents/b/x')
      await setDefaultSession(workspaceId, { kind: 'agent', agentId: chatty.id }, chat.sessionId)

      const owners = [...(await sessionActivity(workspaceId)).keys()]
      expect(owners.filter(id => id !== ROOT_AGENT_SCOPE)).toEqual([busy.id, chatty.id])
    }, 120_000)

    /* ---- the row carries the last message ----
       Materialized on the row by `appendEvent` and read back by `chatSummary`,
       so the roster can print what was last said without walking a journal per
       owner on every poll. Driven through the real doors — a note arriving, a
       runner relaying a finished text step — because the write is a side effect
       of storing an event and nothing else may perform it.

       These also pin the Convex return validator at runtime: `sessionActivity`
       declares `sessionActivityResponseValidator`, and an optional field is
       exactly the case where the `satisfies` check passes and the read still
       500s on the way out. */
    test('the chat carries the last thing said in it, attributed to whoever said it', async () => {
      const workspaceId = await createWorkspace('session-activity-chat-preview')
      const chat = await createSession(workspaceId, 'the opening prompt')
      await setDefaultSession(workspaceId, { kind: 'root' }, chat.sessionId)

      /* Creating the session already said something: the initial prompt is a
         `prompt_submitted`, so a fresh conversation previews from its first
         write rather than waiting for a reply. */
      const opened = (await sessionActivity(workspaceId)).get(ROOT_AGENT_SCOPE)
      /* The identity, not the category. The row resolves this id against the
         workspace roster to draw a name, so what has to survive the round trip
         is *which* member spoke rather than that some member did. */
      expect(opened?.chat?.preview).toEqual({
        text: 'the opening prompt',
        author: { kind: 'user', userId: owner.user._id },
      })

      await relay(workspaceId, chat.sessionId, {
        type: 'step',
        step: { type: 'text', text: '## Done\n\nI shipped **the lander**.' },
      })
      const answered = (await sessionActivity(workspaceId)).get(ROOT_AGENT_SCOPE)
      // Flattened by `messagePreviewOf`, which is the only thing that knows how.
      expect(answered?.chat?.preview).toEqual({
        text: 'Done I shipped the lander.',
        author: { kind: 'agent' },
      })

      await appendSessionNote(workspaceId, chat.sessionId, 'one more thing')
      const followed = (await sessionActivity(workspaceId)).get(ROOT_AGENT_SCOPE)
      expect(followed?.chat?.preview).toEqual({
        text: 'one more thing',
        author: { kind: 'user', userId: owner.user._id },
      })
    }, 120_000)

    /* Work is described by its title, and only the chat answers "what was last
       said". A preview on a job row would be a second description of the same
       session, competing with the one the reader chose. */
    test('a work row carries no preview, however much has been said in it', async () => {
      const workspaceId = await createWorkspace('session-activity-work-preview')
      const job = await createSession(workspaceId, 'do the work')

      const owner = (await sessionActivity(workspaceId)).get(ROOT_AGENT_SCOPE)
      expect(owner?.sessions[0]).toEqual({
        id: job.sessionId,
        title: 'do the work',
        bucket: 'running',
        updatedAt: expect.any(Number),
        unread: false,
      })
    }, 120_000)

    /* ---- never a streaming partial ----
       There is no filter anywhere that says so, and there must not be one: a
       delta classifies as `ephemeral`, and the relay's store path takes
       `Exclude<AgentEventClass, 'ephemeral'>`, so a half-written sentence
       cannot reach a stored event to be previewed from. This is the half of
       that invariant only the running system can show. */
    test('a half-streamed sentence never reaches the row', async () => {
      const workspaceId = await createWorkspace('session-activity-preview-delta')
      const chat = await createSession(workspaceId, 'say something')
      await setDefaultSession(workspaceId, { kind: 'root' }, chat.sessionId)

      const relayed = await relay(workspaceId, chat.sessionId, {
        type: 'step',
        step: { type: 'text_delta', delta: 'I shipped the la' },
      })
      expect(relayed).toMatchObject({ accepted: false, seq: null })
      const owner = (await sessionActivity(workspaceId)).get(ROOT_AGENT_SCOPE)
      // Still the prompt, not the partial that streamed over it.
      expect(owner?.chat?.preview?.text).toBe('say something')
      expect(owner?.chat?.preview?.author.kind).toBe('user')
    }, 120_000)

    /* An event that is not a message says nothing about what was last said, so
       it must not clear what was. The defect this prevents is the preview
       blinking out every time a turn ends. */
    test('work happening after a message does not erase it', async () => {
      const workspaceId = await createWorkspace('session-activity-preview-kept')
      const chat = await createSession(workspaceId, 'the last word')
      await setDefaultSession(workspaceId, { kind: 'root' }, chat.sessionId)

      await relay(workspaceId, chat.sessionId, {
        type: 'step',
        step: { type: 'tool_call', toolName: 'read_file', toolCallId: 'call-1', isError: false },
      })
      await relay(workspaceId, chat.sessionId, terminalEvent('complete'))

      const owner = (await sessionActivity(workspaceId)).get(ROOT_AGENT_SCOPE)
      expect(owner?.chat?.bucket).toBe('done')
      expect(owner?.chat?.preview?.text).toBe('the last word')
      expect(owner?.chat?.preview?.author.kind).toBe('user')
    }, 120_000)

    test('seats asking first, then running, then the clock \u2014 newest inside each', async () => {
      const workspaceId = await createWorkspace('session-activity-order')
      const agent = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const asking = await createSessionInDir(workspaceId, 'needs a person', 500, 'agents/a/x')
      /* The relay's `now` is pinned, and that is the whole test. Left to default
         it stamps `updatedAt` with the wall clock, which makes the asking row the
         newest thing on the drive — and then a plain recency sort produces this
         same order and proves nothing. Asking must be genuinely *older* than both
         running rows for the seat rule to be the only thing that can seat it
         first. */
      await relay(workspaceId, asking.sessionId, terminalEvent('ask'), crypto.randomUUID(), 600)
      const olderRunning = await createSessionInDir(workspaceId, 'older run', 1_000, 'agents/a/x')
      const newerRunning = await createSessionInDir(workspaceId, 'newer run', 2_000, 'agents/a/x')

      const seated = (await sessionActivity(workspaceId)).get(agent.id)?.sessions ?? []
      /* `asking` first even though it is the *oldest* row: the one thing that
         cannot proceed without a person must never be the one pushed out. */
      expect(seated.map(row => row.id)).toEqual([
        asking.sessionId,
        newerRunning.sessionId,
        olderRunning.sessionId,
      ])
      expect(seated[0]?.bucket).toBe('asking')
    }, 60_000)

    test('fills an owner\u2019s activity limit with finished work after every unfinished session', async () => {
      const workspaceId = await createWorkspace('session-activity-finished-fill')
      const agent = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')

      const asking = await createSessionInDir(workspaceId, 'needs a person', 1_000, 'agents/a/x')
      await relay(workspaceId, asking.sessionId, terminalEvent('ask'), crypto.randomUUID(), 1_500)
      const running = await createSessionInDir(workspaceId, 'still running', 2_000, 'agents/a/x')
      const scheduled = await createSessionInDir(workspaceId, 'wakes later', 3_000, 'agents/a/x')
      await relay(
        workspaceId,
        scheduled.sessionId,
        terminalEvent('sleep'),
        crypto.randomUUID(),
        3_500,
      )

      const finished = []
      for (let index = 0; index < 4; index += 1) {
        const session = await createSessionInDir(
          workspaceId,
          `finished ${index}`,
          10_000 + index,
          'agents/a/x',
        )
        await relay(
          workspaceId,
          session.sessionId,
          terminalEvent('complete'),
          crypto.randomUUID(),
          20_000 + index,
        )
        finished.push(session)
      }

      const seated = (await sessionActivity(workspaceId, undefined, 5)).get(agent.id)
      expect(seated?.sessions.map(row => [row.id, row.bucket])).toEqual([
        [asking.sessionId, 'asking'],
        [running.sessionId, 'running'],
        [scheduled.sessionId, 'scheduled'],
        [finished[3]!.sessionId, 'done'],
        [finished[2]!.sessionId, 'done'],
      ])
      expect(seated?.truncated).toBe(true)
    }, 60_000)

    test('owners are ordered by their newest work, even when their oldest is seated first', async () => {
      const workspaceId = await createWorkspace('session-activity-owner-order')
      const agentA = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const agentB = await registerTestAgent(workspaceId, 'agents/b', 'agent-b', 'Agent B')

      /* A's *seated-first* row (asking outranks everything) is the oldest thing
         on the drive, while its running row is the newest. The contract orders
         owners by recency — "who moved last" — so A must lead B, whose only row
         sits between A's two. Reading the seated-first row's `updatedAt` as the
         owner's recency produces exactly the inverted order. */
      const asking = await createSessionInDir(workspaceId, 'a: old question', 1_000, 'agents/a/x')
      await relay(workspaceId, asking.sessionId, terminalEvent('ask'), crypto.randomUUID(), 1_500)
      await createSessionInDir(workspaceId, 'b: middle run', 3_000, 'agents/b/z')
      await createSessionInDir(workspaceId, 'a: fresh run', 5_000, 'agents/a/x')

      const owners = [...(await sessionActivity(workspaceId)).keys()]
      expect(owners).toEqual([agentA.id, agentB.id])
    }, 60_000)

    test('work no agent claimed is its own owner, including completed history', async () => {
      const workspaceId = await createWorkspace('session-activity-root')
      const agent = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const unclaimed = await createSessionInDir(workspaceId, 'drive work', 1_000, '')
      const finished = await createSessionInDir(workspaceId, 'already done', 2_000, 'agents/a/x')
      await relay(workspaceId, finished.sessionId, terminalEvent('complete'))

      const activity = await sessionActivity(workspaceId)
      expect(activity.get(ROOT_AGENT_SCOPE)?.sessions.map(row => row.id)).toEqual([
        unclaimed.sessionId,
      ])
      expect(activity.get(agent.id)?.sessions.map(row => [row.id, row.bucket])).toEqual([
        [finished.sessionId, 'done'],
      ])
    }, 60_000)

    test('unread rides along, per reader', async () => {
      const workspaceId = await createWorkspace('session-activity-unread')
      const [reader] = await addReaders(workspaceId, 'activity', 1)
      const session = await createSession(workspaceId, 'work they have not seen')

      const before = (await sessionActivity(workspaceId, reader!)).get(ROOT_AGENT_SCOPE)!
      expect(before.sessions.map(row => row.unread)).toEqual([true])

      const seq = (await listSessionsAs(workspaceId, reader!)).find(
        row => row.id === session.sessionId,
      )!.lastEventSeq
      await markSessionRead(workspaceId, session.sessionId, reader!, seq)
      const after = (await sessionActivity(workspaceId, reader!)).get(ROOT_AGENT_SCOPE)!
      expect(after.sessions.map(row => row.unread)).toEqual([false])
    }, 60_000)
  })
}
