import { describe, expect, test } from 'bun:test'

import {
  COLLECTION_PAGE_DEFAULT_LIMIT,
  COLLECTION_PAGE_MAX_LIMIT,
  CONVEX_EVENT_BUDGET_BYTES,
  SESSION_LIST_MAX_LIMIT,
  WORKSPACE_MEMBER_LIMIT,
  sessionTitleExcerpt,
} from '@repo/contract'
import { mutate, signInWithMagicLink, uniqueEmail } from '@repo/test-harness'

import {
  SESSION_HISTORY_PAGE_LIMITS,
  SESSION_LIST_PAGE_LIMITS,
  serializedSessionPageBytes,
} from '../../convex/domains/agentSessions/pageBudget'
import {
  convex,
  INTERNAL_KEY,
  owner,
  addReaders,
  createWorkspace,
  createSessionAt,
  createSessionInDir,
  appendSessionNoteAt,
  listSessionHistoryPage,
  listDefaultSessionHistoryPage,
  setDefaultSession,
  listSessions,
  listChildSessions,
  registerTestAgent,
  type UserRow,
} from './test-support'

export function registerSessionListTests(): void {
  describe('listSessions', () => {
    test('separates top-level sessions from direct children without returning grandchildren', async () => {
      const workspaceId = await createWorkspace('agent-list-lineage')
      const parent = await createSessionAt(workspaceId, 'parent', 1_000)
      const otherRoot = await createSessionAt(workspaceId, 'other root', 2_000)
      const createChild = async (parentSessionId: string, attemptId: string, now: number) =>
        (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          createdBySessionId: parentSessionId,
          attemptId,
          input: {
            kind: 'initial_prompt',
            prompt: attemptId,
            behavior: 'steer',
            sender: { kind: 'session', sessionId: parentSessionId },
          },
          now,
        })) as { sessionId: string }
      const firstChild = await createChild(parent.sessionId, 'first-child', 3_000)
      const secondChild = await createChild(parent.sessionId, 'second-child', 4_000)
      await createChild(firstChild.sessionId, 'grandchild', 5_000)

      const topLevel = await listSessions(workspaceId, { topLevel: true })
      expect(topLevel.items.map(row => row.id)).toEqual([otherRoot.sessionId, parent.sessionId])

      const firstPage = await listChildSessions(workspaceId, parent.sessionId, {
        limit: 1,
      })
      expect(firstPage.items.map(row => row.id)).toEqual([secondChild.sessionId])
      expect(firstPage.nextCursor).toBeString()
      const secondPage = await listChildSessions(workspaceId, parent.sessionId, {
        cursor: firstPage.nextCursor!,
        limit: 1,
      })
      expect(secondPage.items.map(row => row.id)).toEqual([firstChild.sessionId])
      expect(secondPage.nextCursor).toBeNull()
    })
    test('returns newest sessions first and note updates reorder the list', async () => {
      const workspaceId = await createWorkspace('agent-list-order')
      const first = await createSessionAt(workspaceId, 'first prompt', 1_000)
      const second = await createSessionAt(workspaceId, 'second prompt', 2_000)

      const initial = await listSessions(workspaceId, {
        actorId: owner.user._id,
      })
      expect(initial.nextCursor).toBeNull()
      expect(initial.items.map(session => session.id)).toEqual([second.sessionId, first.sessionId])

      await appendSessionNoteAt(workspaceId, first.sessionId, 'bring first to the top', 3_000)
      const bumped = await listSessions(workspaceId)

      expect(bumped.items.map(session => session.id)).toEqual([first.sessionId, second.sessionId])
      expect(bumped.items[0]).toMatchObject({
        id: first.sessionId,
        turnStatus: 'running',
        title: 'first prompt',
        titleOrigin: 'excerpt',
        createdAt: 1_000,
        updatedAt: 3_000,
        lastEventSeq: 3,
      })
    })

    test('paginates sessions without duplicates or gaps', async () => {
      const workspaceId = await createWorkspace('agent-list-pages')
      const sessions = []
      for (let index = 0; index < 5; index += 1) {
        sessions.push(await createSessionAt(workspaceId, `prompt ${index}`, 10_000 + index))
      }
      const expectedNewestFirst = sessions.map(session => session.sessionId).reverse()

      const firstPage = await listSessions(workspaceId, { limit: 2 })
      expect(firstPage.items.map(session => session.id)).toEqual(expectedNewestFirst.slice(0, 2))
      expect(firstPage.nextCursor).toBeDefined()

      const secondPage = await listSessions(workspaceId, {
        cursor: firstPage.nextCursor!,
        limit: 2,
      })
      expect(secondPage.items.map(session => session.id)).toEqual(expectedNewestFirst.slice(2, 4))
      expect(secondPage.nextCursor).toBeDefined()

      const thirdPage = await listSessions(workspaceId, {
        cursor: secondPage.nextCursor!,
        limit: 2,
      })
      expect(thirdPage.items.map(session => session.id)).toEqual(expectedNewestFirst.slice(4))
      expect(thirdPage.nextCursor).toBeNull()
    })

    test('bounds maximum audience pages and continues without losing candidates', async () => {
      const workspaceId = await createWorkspace('agent-list-budget-boundary')
      await convex.mutation('testing/workspaces:fillWorkspaceMemberCapacityForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })
      const sessions = []
      const candidateCount =
        Math.floor(SESSION_LIST_PAGE_LIMITS.ranges / WORKSPACE_MEMBER_LIMIT) + 1
      for (let index = 0; index < candidateCount; index += 1) {
        const session = await createSessionAt(workspaceId, `maximum candidate ${index}`, index + 1)
        await convex.mutation('testing/agentSessions:makeMaximumSpecificSessionForBudgetTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          sessionId: session.sessionId,
        })
        sessions.push(session.sessionId)
      }

      const measured = (await convex.query('testing/agentSessions:listSessionsBudgetForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: owner.user._id,
        limit: SESSION_LIST_MAX_LIMIT,
      })) as {
        page: Awaited<ReturnType<typeof listSessions>>
        budget: {
          reads: { ranges: number; documents: number; bytes: number }
          responseBytes: number
        }
      }
      const expected = sessions.slice().reverse()
      const first = measured.page
      expect(first.items.length).toBeGreaterThan(0)
      expect(first.items.map(row => row.id)).toEqual(expected.slice(0, first.items.length))
      expect(measured.budget.reads.ranges).toBeLessThanOrEqual(SESSION_LIST_PAGE_LIMITS.ranges)
      expect(measured.budget.reads.documents).toBeLessThanOrEqual(
        SESSION_LIST_PAGE_LIMITS.documents,
      )
      expect(measured.budget.reads.bytes).toBeLessThan(SESSION_LIST_PAGE_LIMITS.readBytes)
      expect(measured.budget.responseBytes).toBeLessThan(SESSION_LIST_PAGE_LIMITS.responseBytes)

      const returned = first.items.map(row => row.id)
      let cursor = first.nextCursor
      for (let pageNumber = 0; cursor !== null && pageNumber < candidateCount; pageNumber += 1) {
        const page = await listSessions(workspaceId, {
          actorId: owner.user._id,
          cursor,
          limit: SESSION_LIST_MAX_LIMIT,
        })
        returned.push(...page.items.map(row => row.id))
        cursor = page.nextCursor
      }
      expect(cursor).toBeNull()
      expect(returned).toEqual(expected)
    }, 60_000)

    test('a prompt larger than the old read reservation still makes fresh-page progress', async () => {
      const workspaceId = await createWorkspace('agent-list-large-prompt')
      const session = await createSessionAt(workspaceId, 'small indexed prompt', 1_000)
      await convex.mutation('testing/agentSessions:setLargeSessionProjectionFieldsForBudgetTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        prompt: 'p'.repeat(600 * 1024),
      })

      const measured = (await convex.query('testing/agentSessions:listSessionsBudgetForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: owner.user._id,
        limit: SESSION_LIST_MAX_LIMIT,
      })) as {
        page: Awaited<ReturnType<typeof listSessions>>
        budget: { reads: { bytes: number }; responseBytes: number }
      }
      expect(measured.page.items.map(row => row.id)).toEqual([session.sessionId])
      expect(measured.budget.reads.bytes).toBeGreaterThan(512 * 1024)
      expect(measured.budget.responseBytes).toBeLessThan(SESSION_LIST_PAGE_LIMITS.responseBytes)
    })

    test('a canonical machine larger than the old response reservation stays bounded on the list', async () => {
      const workspaceId = await createWorkspace('agent-list-large-machine')
      const sessions = []
      for (let index = 0; index < 2; index += 1) {
        const session = await createSessionAt(workspaceId, `machine ${index}`, index + 1)
        await convex.mutation(
          'testing/agentSessions:setLargeSessionProjectionFieldsForBudgetTest',
          {
            internalKey: INTERNAL_KEY,
            sessionId: session.sessionId,
            // Control characters exercise the sixfold worst JSON escaping, not
            // only an ASCII payload whose wire size happens to equal raw bytes.
            machinePathName: `${index}:${'\u0001'.repeat(700 * 1024)}`,
          },
        )
        sessions.push(session.sessionId)
      }

      const measured = (await convex.query('testing/agentSessions:listSessionsBudgetForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: owner.user._id,
        limit: SESSION_LIST_MAX_LIMIT,
      })) as {
        page: Awaited<ReturnType<typeof listSessions>>
        budget: { reads: { bytes: number }; responseBytes: number }
      }
      expect(measured.page.items).toHaveLength(2)
      expect(measured.page.nextCursor).toBeNull()
      expect(measured.page.items.map(row => row.machine)).toEqual([
        { step: 'large-state', activity: 'running' },
        { step: 'large-state', activity: 'running' },
      ])
      expect(measured.budget.responseBytes).toBeLessThan(SESSION_LIST_PAGE_LIMITS.responseBytes)
      expect(measured.budget.responseBytes).toBeLessThan(64 * 1024)
      expect(measured.page.items.map(row => row.id)).toEqual(sessions.slice().reverse())
    }, 30_000)

    test('isolates workspaces and uses the bounded deterministic title excerpt', async () => {
      const firstWorkspaceId = await createWorkspace('agent-list-isolated-a')
      const secondWorkspaceId = await createWorkspace('agent-list-isolated-b')
      const longPrompt = 'x'.repeat(260)
      const first = await createSessionAt(firstWorkspaceId, longPrompt, 1_000)
      const second = await createSessionAt(secondWorkspaceId, 'other workspace prompt', 2_000)

      const firstList = await listSessions(firstWorkspaceId)
      const secondList = await listSessions(secondWorkspaceId)

      expect(firstList.items.map(session => session.id)).toEqual([first.sessionId])
      expect(secondList.items.map(session => session.id)).toEqual([second.sessionId])
      expect(firstList.items[0]!.title).toBe(sessionTitleExcerpt(longPrompt))
    })

    test('returns an empty terminal page for malformed and foreign agent filters', async () => {
      const workspaceId = await createWorkspace('agent-list-invalid-filter')
      const foreignWorkspaceId = await createWorkspace('agent-list-invalid-filter-foreign')
      const foreignAgent = await registerTestAgent(
        foreignWorkspaceId,
        'agents/foreign-filter-agent',
        'foreign-filter-agent',
      )
      for (const agentId of ['not-an-id', foreignAgent.id]) {
        expect(await listSessions(workspaceId, { agentId })).toEqual({
          items: [],
          nextCursor: null,
        })
      }
    })

    test('subtracts an invisible canonical row even when discovery is stale', async () => {
      const workspaceId = await createWorkspace('agent-list-invisible-stale')
      const session = await createSessionAt(workspaceId, 'stale visible projection', 1_000)
      await convex.mutation('testing/agentSessions:setSessionVisibleWithoutDiscoveryForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        visible: false,
      })
      expect(await listSessions(workspaceId)).toEqual({
        items: [],
        nextCursor: null,
      })
    })

    test('rejects a cursor after membership removal and rejoin changes generation', async () => {
      const workspaceId = await createWorkspace('agent-list-membership-generation')
      const [readerId] = await addReaders(workspaceId, 'list-generation', 1)
      await createSessionAt(workspaceId, 'older', 1_000)
      await createSessionAt(workspaceId, 'newer', 2_000)
      const first = await listSessions(workspaceId, {
        actorId: readerId!,
        limit: 1,
      })
      await mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
        workspaceId,
        userId: readerId!,
      })
      await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        userId: readerId!,
        role: 'viewer',
      })
      await expect(
        listSessions(workspaceId, {
          actorId: readerId!,
          cursor: first.nextCursor!,
          limit: 1,
        }),
      ).rejects.toThrow(/invalid_cursor/)
    })

    test('rejects exclude-default continuation after the pointer is repointed', async () => {
      const workspaceId = await createWorkspace('agent-list-default-binding')
      const firstDefault = await createSessionAt(workspaceId, 'first default', 1_000)
      const nextDefault = await createSessionAt(workspaceId, 'next default', 2_000)
      await createSessionAt(workspaceId, 'ordinary side session', 3_000)
      await setDefaultSession(workspaceId, { kind: 'root' }, firstDefault.sessionId)
      const first = await listSessions(workspaceId, {
        agentId: 'root',
        excludeDefault: true,
        limit: 1,
      })
      await setDefaultSession(workspaceId, { kind: 'root' }, nextDefault.sessionId)
      await expect(
        listSessions(workspaceId, {
          agentId: 'root',
          excludeDefault: true,
          cursor: first.nextCursor!,
          limit: 1,
        }),
      ).rejects.toThrow(/invalid_cursor/)
    })

    test('list and point detail agree for every human role and the workspace lane when an agent row is gone', async () => {
      const workspaceId = await createWorkspace('agent-list-point-agreement')
      const editor = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail('agent-list-point-editor'),
        'List Point Editor',
      )
      await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        userId: editor.user._id,
        role: 'editor',
      })
      const [viewerId] = await addReaders(workspaceId, 'list-point-viewer', 1)
      await registerTestAgent(workspaceId, 'agents/plain-list', 'plain-list')
      const missing = await registerTestAgent(workspaceId, 'agents/missing-list', 'missing-list')
      const plainSession = await createSessionInDir(
        workspaceId,
        'never-onboarded agent session',
        1_000,
        'agents/plain-list/work',
      )
      const missingSession = await createSessionInDir(
        workspaceId,
        'missing-agent session',
        2_000,
        'agents/missing-list/work',
      )
      await convex.mutation('testing/agents:deleteAgentRowWithoutSessionCleanupForTest', {
        internalKey: INTERNAL_KEY,
        agentId: missing.id,
      })

      // A human sees the never-onboarded agent's session like any other; only
      // the session whose agent row is gone is hidden from every human role.
      for (const actorId of [owner.user._id, editor.user._id, viewerId!]) {
        expect((await listSessions(workspaceId, { actorId })).items.map(row => row.id)).toEqual([
          plainSession.sessionId,
        ])
        expect(
          await convex.query('domains/agentSessions/model:getSessionPoint', {
            internalKey: INTERNAL_KEY,
            workspaceId,
            sessionId: missingSession.sessionId,
            identity: {
              principal: { kind: 'human', userId: actorId },
              actorId,
            },
          }),
        ).toBeNull()
      }

      expect((await listSessions(workspaceId)).items.map(row => row.id)).toEqual([
        missingSession.sessionId,
        plainSession.sessionId,
      ])
      for (const sessionId of [plainSession.sessionId, missingSession.sessionId]) {
        expect(
          await convex.query('domains/agentSessions/model:getSessionPoint', {
            internalKey: INTERNAL_KEY,
            workspaceId,
            sessionId,
            identity: {
              principal: { kind: 'workspace' },
              actorId: owner.user._id,
            },
          }),
        ).not.toBeNull()
      }
    }, 30_000)
  })

  describe('session history pages', () => {
    test('the canonical writer refuses a timeline event above the shared storage ceiling', async () => {
      const workspaceId = await createWorkspace('session-history-writer-cap')
      const session = await createSessionAt(workspaceId, 'writer cap', 1_000)
      const empty = {
        type: 'note_submitted',
        note: '',
        sender: { kind: 'user', userId: owner.user._id },
      }
      const emptyBytes = serializedSessionPageBytes(empty).json
      const exactNote = 'x'.repeat(CONVEX_EVENT_BUDGET_BYTES - emptyBytes)
      expect(
        await appendSessionNoteAt(workspaceId, session.sessionId, exactNote, 2_000),
      ).toMatchObject({ seq: 3, lastEventSeq: 3 })
      await expect(
        appendSessionNoteAt(workspaceId, session.sessionId, `${exactNote}x`, 3_000),
      ).rejects.toThrow(/invalid_request/)
      const history = await listSessionHistoryPage(workspaceId, session.sessionId)
      expect(history.items.map(row => row.seq)).toEqual([3, 2, 1])
    })

    test('byte-short pages walk maximum events without gaps through direct and pinned default aliases', async () => {
      const workspaceId = await createWorkspace('session-history-byte-pages')
      const original = await createSessionAt(workspaceId, 'maximum history', 1_000)
      const replacement = await createSessionAt(workspaceId, 'replacement default', 2_000)
      const emptyEvent = { type: 'task_output', taskId: 't1', chunk: '' }
      const eventOverhead = new TextEncoder().encode(JSON.stringify(emptyEvent)).byteLength
      await convex.mutation('testing/agentSessions:seedSessionOutputForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: original.sessionId,
        count: 30,
        chunkBytes: CONVEX_EVENT_BUDGET_BYTES - eventOverhead,
      })

      const descending = await drainHistory(args =>
        listSessionHistoryPage(workspaceId, original.sessionId, args),
      )
      expect(descending.first.items.length).toBeLessThan(COLLECTION_PAGE_MAX_LIMIT)
      expect(maximumPageBytes(descending.first)).toBeLessThanOrEqual(
        SESSION_HISTORY_PAGE_LIMITS.responseBytes,
      )
      expect(descending.seqs).toEqual(Array.from({ length: 32 }, (_, index) => 32 - index))

      const ascending = await drainHistory(
        args => listSessionHistoryPage(workspaceId, original.sessionId, args),
        { order: 'asc' },
      )
      expect(ascending.seqs).toEqual(Array.from({ length: 32 }, (_, index) => index + 1))

      /* The seed above is deliberately the widest a session can hold — thirty
         maximum-size events, some nine megabytes — and the deployment admits
         four megabytes of writes per rolling second. So the next write has to
         stand off until that drains. It used to stand off by accident: paging
         this transcript took long enough on its own to cover the window, and
         when the page read got faster the write landed inside it and the quota
         refused it. Reading is not this test's clock. */
      await Bun.sleep(2_500)
      await setDefaultSession(workspaceId, { kind: 'root' }, original.sessionId)
      const firstDefault = await listDefaultSessionHistoryPage(
        workspaceId,
        { kind: 'root' },
        { limit: COLLECTION_PAGE_MAX_LIMIT },
      )
      expect(firstDefault.nextCursor).toBeString()
      await setDefaultSession(workspaceId, { kind: 'root' }, replacement.sessionId)
      const defaultTail = await drainHistory(
        args => listDefaultSessionHistoryPage(workspaceId, { kind: 'root' }, args),
        { cursor: firstDefault.nextCursor! },
      )
      expect([...firstDefault.items.map(row => row.seq), ...defaultTail.seqs]).toEqual(
        descending.seqs,
      )
    }, 60_000)

    test('uses the universal collection default and maximum page sizes', async () => {
      const workspaceId = await createWorkspace('session-history-universal-limits')
      const session = await createSessionAt(workspaceId, 'history limit prompt', 1_000)
      await convex.mutation('testing/agentSessions:seedSessionOutputForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        count: COLLECTION_PAGE_MAX_LIMIT + 1,
      })

      const defaultPage = await listSessionHistoryPage(workspaceId, session.sessionId)
      expect(defaultPage.items).toHaveLength(COLLECTION_PAGE_DEFAULT_LIMIT)
      expect(defaultPage.nextCursor).toBeString()

      const maximumPage = await listSessionHistoryPage(workspaceId, session.sessionId, {
        limit: COLLECTION_PAGE_MAX_LIMIT + 1,
      })
      expect(maximumPage.items).toHaveLength(COLLECTION_PAGE_MAX_LIMIT)
      expect(maximumPage.nextCursor).toBeString()
    }, 30_000)

    test('walks both declared orders and binds afterSeq into opaque continuation', async () => {
      const workspaceId = await createWorkspace('session-history-pages')
      const session = await createSessionAt(workspaceId, 'history prompt', 1_000)
      await appendSessionNoteAt(workspaceId, session.sessionId, 'three', 2_000)
      await appendSessionNoteAt(workspaceId, session.sessionId, 'four', 3_000)

      const descending = await listSessionHistoryPage(workspaceId, session.sessionId, { limit: 2 })
      expect(descending.items.map(row => row.seq)).toEqual([4, 3])
      expect(descending.nextCursor).toBeString()
      const older = await listSessionHistoryPage(workspaceId, session.sessionId, {
        cursor: descending.nextCursor!,
        limit: 2,
      })
      expect(older.items.map(row => row.seq)).toEqual([2, 1])
      expect(older.nextCursor).toBeNull()

      const ascending = await listSessionHistoryPage(workspaceId, session.sessionId, {
        order: 'asc',
        afterSeq: 1,
        limit: 1,
      })
      expect(ascending.items.map(row => row.seq)).toEqual([2])
      await expect(
        listSessionHistoryPage(workspaceId, session.sessionId, {
          order: 'asc',
          afterSeq: 0,
          cursor: ascending.nextCursor!,
          limit: 1,
        }),
      ).rejects.toThrow(/invalid_cursor/)
    })

    test('pins a default transcript across alias repointing', async () => {
      const workspaceId = await createWorkspace('default-history-pin')
      const original = await createSessionAt(workspaceId, 'original', 1_000)
      await appendSessionNoteAt(workspaceId, original.sessionId, 'original tail', 2_000)
      const replacement = await createSessionAt(workspaceId, 'replacement', 3_000)
      await setDefaultSession(workspaceId, { kind: 'root' }, original.sessionId)

      const first = await listDefaultSessionHistoryPage(workspaceId, { kind: 'root' }, { limit: 1 })
      expect(first.items.map(row => row.seq)).toEqual([3])
      await setDefaultSession(workspaceId, { kind: 'root' }, replacement.sessionId)
      const continued = await listDefaultSessionHistoryPage(
        workspaceId,
        { kind: 'root' },
        { cursor: first.nextCursor!, limit: 10 },
      )
      expect(continued.items.map(row => row.seq)).toEqual([2, 1])
    })
  })
}

type HistoryPage = Awaited<ReturnType<typeof listSessionHistoryPage>>

async function drainHistory(
  read: (args: { cursor?: string; limit: number; order?: 'asc' | 'desc' }) => Promise<HistoryPage>,
  initial: { cursor?: string; order?: 'asc' | 'desc' } = {},
): Promise<{ first: HistoryPage; seqs: number[] }> {
  let cursor = initial.cursor
  let first: HistoryPage | undefined
  const seqs: number[] = []
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await read({
      ...(cursor === undefined ? {} : { cursor }),
      ...(initial.order === undefined ? {} : { order: initial.order }),
      limit: COLLECTION_PAGE_MAX_LIMIT,
    })
    first ??= page
    seqs.push(...page.items.map(row => row.seq))
    if (page.nextCursor === null) return { first, seqs }
    cursor = page.nextCursor
  }
  throw new Error('history did not terminate within 20 pages')
}

function maximumPageBytes(page: HistoryPage): number {
  const measured = serializedSessionPageBytes(page)
  return Math.max(measured.json, measured.convex)
}
