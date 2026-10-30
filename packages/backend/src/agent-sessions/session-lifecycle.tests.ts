import { describe, expect, test } from 'bun:test'

import { mutate } from '@repo/test-harness'

import {
  DELETE_EVENT_BATCH,
  DELETE_SESSION_READ_BATCH,
  DELETE_MEMBER_STATE_BATCH,
} from '../../convex/domains/agentSessions/deletion'
import { DELETE_DISCOVERY_BATCH } from '../../convex/domains/agentSessions/discovery'
import {
  INTERNAL_KEY,
  convex,
  owner,
  listSessionsAs,
  markSessionRead,
  readCursors,
  childRowCounts,
  addReaders,
  drainDeleteBatches,
  createWorkspace,
  createSession,
  createSessionAt,
  appendSessionNote,
  prepareRunnerInputDelivery,
  storeInputImages,
  markRunnerInputDelivered,
  abandonRunnerInputDelivery,
  relay,
  getSession,
  listSessions,
  runningTurnState,
} from './test-support'

export function registerSessionLifecycleTests(): void {
  describe('session product lifecycle', () => {
    test('point detail admits a viewer participant and hides a viewer nonparticipant', async () => {
      const workspaceId = await createWorkspace('agent-point-viewer')
      const [participantId, nonparticipantId] = await addReaders(workspaceId, 'point-viewer', 2)
      const members = (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
      const participantMembershipId = members.find(row => row.userId === participantId)!._id
      const session = await createSession(workspaceId, 'Only one viewer should see this')
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        membershipIds: [participantMembershipId],
      })

      expect(
        await convex.query('domains/agentSessions/model:getSessionPoint', {
          internalKey: INTERNAL_KEY,
          identity: {
            principal: { kind: 'human', userId: participantId },
            actorId: participantId,
          },
          workspaceId,
          sessionId: session.sessionId,
        }),
      ).toMatchObject({ id: session.sessionId })
      expect(
        await convex.query('domains/agentSessions/model:getSessionPoint', {
          internalKey: INTERNAL_KEY,
          identity: {
            principal: { kind: 'human', userId: nonparticipantId },
            actorId: nonparticipantId,
          },
          workspaceId,
          sessionId: session.sessionId,
        }),
      ).toBeNull()
      expect(
        await convex.query('domains/agentSessions/model:getSessionPoint', {
          internalKey: INTERNAL_KEY,
          identity: { principal: { kind: 'workspace' }, actorId: owner.user._id },
          workspaceId,
          sessionId: session.sessionId,
        }),
      ).toMatchObject({ id: session.sessionId, unread: false })
    })

    test('a viewer participant can change cwd through the same point policy', async () => {
      const workspaceId = await createWorkspace('agent-cwd-viewer')
      const [participantId] = await addReaders(workspaceId, 'cwd-viewer', 1)
      const membershipId = (
        (await convex.query('testing/workspaces:workspaceMembersForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
        })) as Array<{ _id: string; userId: string }>
      ).find(row => row.userId === participantId)!._id
      const session = await createSession(workspaceId, 'Let a viewer move this session')
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        membershipIds: [membershipId],
      })

      expect(
        await convex.mutation('domains/agentSessions/model:setSessionCwd', {
          internalKey: INTERNAL_KEY,
          actorId: participantId,
          identity: {
            principal: { kind: 'human', userId: participantId },
            actorId: participantId,
          },
          workspaceId,
          sessionId: session.sessionId,
          cwd: 'projects/viewer',
          now: 1_500,
        }),
      ).toEqual({ id: session.sessionId, cwd: 'projects/viewer' })
    })

    test('cwd CAS changes only cwd metadata while the public projection carries it', async () => {
      const workspaceId = await createWorkspace('agent-cwd-cas')
      const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId,
        path: 'agents/writer',
        slug: 'writer',
      })) as { id: string; anchorId: string }
      const session = (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        workspaceId,
        prompt: 'Move without rebinding',
        cwd: 'agents/writer/drafts',
        now: 1_000,
      })) as { sessionId: string }
      const before = (await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      })) as { cwd: string; updatedAt: number; agentId?: string }

      expect(
        await convex.mutation('domains/agentSessions/model:setSessionCwd', {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          sessionId: session.sessionId,
          expectedCwd: 'agents/writer/drafts',
          cwd: 'agents/writer/published',
          now: 2_000,
        }),
      ).toEqual({ id: session.sessionId, cwd: 'agents/writer/published' })

      const after = (await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      })) as typeof before
      // Session rows carry agentId + agentName; no agentAnchorId column has
      // ever existed (this assertion was born failing on staging).
      expect(after).toMatchObject({
        cwd: 'agents/writer/published',
        updatedAt: 2_000,
        agentId: agent.id,
        agentName: 'writer',
      })
      expect(after.agentId).toBe(before.agentId)
      expect(await getSession(workspaceId, session.sessionId)).toMatchObject({
        id: session.sessionId,
        cwd: 'agents/writer/published',
      })

      await expect(
        convex.mutation('domains/agentSessions/model:setSessionCwd', {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          sessionId: session.sessionId,
          expectedCwd: 'agents/writer/drafts',
          cwd: 'agents/writer/conflicting',
          now: 3_000,
        }),
      ).rejects.toThrow('Cwd conflict')
      expect(
        await convex.query('testing/agentSessions:rawSessionForTest', {
          internalKey: INTERNAL_KEY,
          sessionId: session.sessionId,
        }),
      ).toEqual(after)
    })

    test('manual rename updates the public title and claims title ownership', async () => {
      const workspaceId = await createWorkspace('agent-title-race')
      const raced = await createSession(workspaceId, 'Prepare a release summary')
      await convex.mutation('domains/agentSessions/model:renameSession', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: {
          principal: { kind: 'human', userId: owner.user._id },
          actorId: owner.user._id,
        },
        workspaceId,
        sessionId: raced.sessionId,
        title: 'Friday release',
        now: 4_000,
      })
      expect(await getSession(workspaceId, raced.sessionId)).toMatchObject({
        title: 'Friday release',
        titleOrigin: 'manual',
        titleStatus: 'complete',
      })
    })

    test('searches, filters, archives, and restores without leaking another workspace', async () => {
      const workspaceId = await createWorkspace('agent-filter')
      const otherWorkspaceId = await createWorkspace('agent-filter-other')
      const deploy = await createSessionAt(workspaceId, 'Diagnose the deployment timeout', 1_000)
      const report = await createSessionAt(workspaceId, 'Draft the quarterly report', 2_000)
      await createSessionAt(otherWorkspaceId, 'deployment timeout in another workspace', 3_000)
      await convex.mutation('domains/agentSessions/model:setSessionArchive', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        kind: 'global',
        workspaceId,
        sessionId: report.sessionId,
        archived: true,
        now: 4_000,
      })

      expect(
        (await listSessions(workspaceId, { search: 'deployment' })).items.map(row => row.id),
      ).toEqual([deploy.sessionId])
      expect(
        (await listSessions(workspaceId, { archived: 'only' })).items.map(row => row.id),
      ).toEqual([report.sessionId])
      expect((await listSessions(workspaceId)).items.map(row => row.id)).toEqual([deploy.sessionId])

      await convex.mutation('domains/agentSessions/model:setSessionArchive', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        kind: 'global',
        workspaceId,
        sessionId: report.sessionId,
        archived: false,
        now: 5_000,
      })
      expect((await listSessions(workspaceId)).items.map(row => row.id)).toEqual([
        report.sessionId,
        deploy.sessionId,
      ])
    })

    test('hides deletion immediately and completes a bounded idempotent event cascade', async () => {
      const workspaceId = await createWorkspace('agent-delete')
      const session = await createSession(workspaceId, 'Delete this long session')
      const images = await storeInputImages([{ data: 'ZGVsZXRlLW1l', mimeType: 'image/png' }])
      await appendSessionNote(workspaceId, session.sessionId, 'image to delete', images)
      const imageBeforeDelete = (await convex.action(
        'domains/agentSessions/model:sessionImageUrl',
        {
          internalKey: INTERNAL_KEY,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          sessionId: session.sessionId,
          storageId: images[0]!.storageId,
        },
      )) as { url: string }
      expect((await fetch(imageBeforeDelete.url)).ok).toBe(true)
      await relay(workspaceId, session.sessionId, {
        type: 'turn_started',
        state: runningTurnState(),
      })
      await convex.mutation('testing/agentSessions:appendSessionNoteRunForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        actorId: owner.user._id,
        notePrefix: 'note ',
        count: DELETE_EVENT_BATCH + 1,
      })
      await convex.mutation('testing/agentSessions:markDeletingForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      })
      await expect(
        convex.mutation('domains/agentSessions/model:relayRunnerEvent', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          sessionId: session.sessionId,
          relayId: crypto.randomUUID(),
          event: { type: 'complete', state: {}, result: 'late result' },
        }),
      ).rejects.toThrow(/not_found/)
      await expect(appendSessionNote(workspaceId, session.sessionId, 'late note')).rejects.toThrow(
        /not_found/,
      )
      await expect(
        convex.mutation('domains/agentSessions/model:requestInterrupt', {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          sessionId: session.sessionId,
        }),
      ).rejects.toThrow(/not_found/)
      await expect(
        prepareRunnerInputDelivery(workspaceId, {
          sessionId: session.sessionId,
          attemptId: 'late-prepare',
          input: { kind: 'message', prompt: 'late message' },
        }),
      ).rejects.toThrow(/not_found/)
      await expect(
        markRunnerInputDelivered(workspaceId, session.sessionId, 'late-mark', 2),
      ).rejects.toThrow('Session not found')
      await expect(
        abandonRunnerInputDelivery(workspaceId, session.sessionId, 'late-abandon'),
      ).rejects.toThrow('Session not found')
      expect(await getSession(workspaceId, session.sessionId)).toBeNull()
      expect((await listSessions(workspaceId)).items).toEqual([])
      expect((await listSessions(workspaceId, { archived: 'only' })).items).toEqual([])
      const drainCandidates = (await convex.query(
        'domains/agentSessions/model:listRunnerInputDrainCandidates',
        { internalKey: INTERNAL_KEY, workspaceId, limit: 50 },
      )) as { sessions: Array<{ sessionId: string }> }
      expect(drainCandidates.sessions.map(candidate => candidate.sessionId)).not.toContain(
        session.sessionId,
      )
      await expect(
        convex.action('domains/agentSessions/model:sessionImageUrl', {
          internalKey: INTERNAL_KEY,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          sessionId: session.sessionId,
          storageId: images[0]!.storageId,
        }),
      ).rejects.toThrow(/not_found/)
      const workId = await convex.mutation(
        'testing/agentSessions:prepareSessionDeletionCleanupForTest',
        { internalKey: INTERNAL_KEY, sessionId: session.sessionId },
      )
      await drainDeleteBatches(session.sessionId)
      expect(
        await convex.mutation('testing/agentSessions:runSessionDeletionCleanupForTest', {
          internalKey: INTERNAL_KEY,
          workId,
        }),
      ).toEqual({ done: true })
      expect((await fetch(imageBeforeDelete.url)).ok).toBe(false)
      expect(
        await convex.query('testing/agentSessions:childRowCountsForTest', {
          internalKey: INTERNAL_KEY,
          sessionId: session.sessionId,
        }),
      ).toEqual({
        events: 0,
        relayReceipts: 0,
        images: 0,
        reads: 0,
        memberStates: 0,
        discovery: 0,
        toolRouter: 0,
      })
      await expect(
        convex.mutation('domains/agentSessions/model:beginSessionSubtreeDeletion', {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId,
          sessionId: session.sessionId,
        }),
      ).rejects.toThrow(/not_found/)
    }, 60_000)

    test('the staging deletion census distinguishes public absence from physical cleanup', async () => {
      const workspaceId = await createWorkspace('session-deletion-census')
      const session = await createSession(workspaceId, 'Leave observable deletion metadata')

      const before = (await convex.query('testing/agentSessions:sessionDeletionCensusForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionIds: [session.sessionId],
      })) as Array<{
        sessionId: string
        canonical: number
        deletionWork: number
        dependents: { events: number; discovery: number }
      }>
      expect(before).toHaveLength(1)
      // A workspace-audience session projects exactly two discovery lanes:
      // the owner lane and the workspace lane. Member lanes need a specific
      // audience and personal lanes need a personal archive, so the fixture
      // produces neither.
      expect(before[0]).toMatchObject({
        sessionId: session.sessionId,
        canonical: 1,
        deletionWork: 0,
        dependents: { events: 1, discovery: 2 },
      })

      await convex.mutation('testing/agentSessions:markDeletingForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      })
      expect(await getSession(workspaceId, session.sessionId)).toBeNull()
      const workId = await convex.mutation(
        'testing/agentSessions:prepareSessionDeletionCleanupForTest',
        { internalKey: INTERNAL_KEY, sessionId: session.sessionId },
      )
      expect(
        await convex.query('testing/agentSessions:sessionDeletionCensusForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          sessionIds: [session.sessionId],
        }),
      ).toMatchObject([{ sessionId: session.sessionId, canonical: 1, deletionWork: 1 }])
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = (await convex.mutation(
          'testing/agentSessions:runSessionDeletionCleanupForTest',
          { internalKey: INTERNAL_KEY, workId },
        )) as { done: boolean }
        if (result.done) break
        if (attempt === 19) throw new Error('delete cascade did not finish in 20 batches')
      }

      expect(
        await convex.query('testing/agentSessions:sessionDeletionCensusForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          sessionIds: [session.sessionId],
        }),
      ).toEqual([
        {
          sessionId: session.sessionId,
          canonical: 0,
          deletionWork: 0,
          dependents: {
            events: 0,
            relayReceipts: 0,
            images: 0,
            reads: 0,
            memberStates: 0,
            discovery: 0,
            toolRouter: 0,
          },
        },
      ])
    }, 60_000)

    // The read cursor is the first table keyed on (workspace, member, session),
    // so it is the first one whose delete cascade cannot use the upsert index —
    // and a miss here leaks silently rather than erroring. Three members so a
    // cascade that dropped only the caller's own row still fails.
    test('deleting a session drops every member read cursor for it', async () => {
      const workspaceId = await createWorkspace('session-read-leak')
      const readers = await addReaders(workspaceId, 'leak', 3)
      const session = await createSession(workspaceId, 'work several people watch')
      const other = await createSession(workspaceId, 'work nobody deletes')

      for (const reader of readers) {
        await markSessionRead(workspaceId, session.sessionId, reader, 7)
        await markSessionRead(workspaceId, other.sessionId, reader, 4)
      }
      expect(await childRowCounts(session.sessionId)).toMatchObject({ reads: 3 })

      await convex.mutation('domains/agentSessions/model:beginSessionSubtreeDeletion', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        workspaceId,
        sessionId: session.sessionId,
      })
      await drainDeleteBatches(session.sessionId)

      expect(await childRowCounts(session.sessionId)).toMatchObject({ reads: 0 })
      // The neighbouring session keeps every cursor: the cascade is scoped to
      // the row being deleted, not to the members who read it.
      expect(await childRowCounts(other.sessionId)).toMatchObject({ reads: 3 })
      for (const reader of readers) {
        expect(await readCursors(workspaceId, reader)).toEqual([
          { sessionId: other.sessionId, lastReadSeq: 4 },
        ])
      }
    }, 60_000)

    test('deletion drains member state and discovery through multiple bounded pages', async () => {
      const workspaceId = await createWorkspace('session-delete-multipage')
      const session = await createSession(workspaceId, 'Delete every projection page')
      const children = Math.max(DELETE_MEMBER_STATE_BATCH, DELETE_DISCOVERY_BATCH) + 1
      const membershipIdsBefore = (
        (await convex.query('testing/workspaces:workspaceMembersForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
        })) as Array<{ _id: string }>
      ).map(row => row._id)
      await convex.mutation('testing/agentSessions:markDeletingForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      })
      await convex.mutation('testing/agentSessions:seedDeleteChildrenForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        count: children,
      })
      expect(
        (
          (await convex.query('testing/workspaces:workspaceMembersForTest', {
            internalKey: INTERNAL_KEY,
            workspaceId,
          })) as Array<{ _id: string }>
        ).map(row => row._id),
      ).toEqual(membershipIdsBefore)
      expect(await childRowCounts(session.sessionId)).toMatchObject({
        memberStates: children,
        discovery: children,
      })
      await drainDeleteBatches(session.sessionId)
      expect(await childRowCounts(session.sessionId)).toEqual({
        events: 0,
        relayReceipts: 0,
        images: 0,
        reads: 0,
        memberStates: 0,
        discovery: 0,
        toolRouter: 0,
      })
    }, 60_000)

    test('the read cursor only ever moves forward', async () => {
      const workspaceId = await createWorkspace('session-read-monotonic')
      const session = await createSession(workspaceId, 'read me')
      const me = owner.user._id

      expect(await markSessionRead(workspaceId, session.sessionId, me, 5)).toEqual({
        lastReadSeq: 5,
      })
      // A late flush from a backgrounded tab, arriving after a newer one.
      expect(await markSessionRead(workspaceId, session.sessionId, me, 2)).toEqual({
        lastReadSeq: 5,
      })
      expect(await markSessionRead(workspaceId, session.sessionId, me, 5)).toEqual({
        lastReadSeq: 5,
      })
      expect(await markSessionRead(workspaceId, session.sessionId, me, 9)).toEqual({
        lastReadSeq: 9,
      })
      // One row per member per session, never one per stamp.
      expect(await readCursors(workspaceId, me)).toEqual([
        { sessionId: session.sessionId, lastReadSeq: 9 },
      ])
    }, 60_000)

    test('one member reading leaves the others unread', async () => {
      const workspaceId = await createWorkspace('session-read-per-member')
      const [alice, bob] = await addReaders(workspaceId, 'pair', 2)
      const session = await createSession(workspaceId, 'shared work')

      await markSessionRead(workspaceId, session.sessionId, alice!, 12)

      expect(await readCursors(workspaceId, alice!)).toEqual([
        { sessionId: session.sessionId, lastReadSeq: 12 },
      ])
      expect(await readCursors(workspaceId, bob!)).toEqual([])
    }, 60_000)

    test('removing a member preserves user-continuity cursors', async () => {
      const workspaceId = await createWorkspace('session-read-member-cascade')
      const [leaver, stayer] = await addReaders(workspaceId, 'cascade', 2)
      const first = await createSession(workspaceId, 'first')
      const second = await createSession(workspaceId, 'second')

      for (const sessionId of [first.sessionId, second.sessionId]) {
        await markSessionRead(workspaceId, sessionId, leaver!, 3)
        await markSessionRead(workspaceId, sessionId, stayer!, 3)
      }

      await mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
        workspaceId,
        userId: leaver!,
      })

      const expected = [first.sessionId, second.sessionId]
        .map(sessionId => ({ sessionId, lastReadSeq: 3 }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
      for (const reader of [leaver!, stayer!]) {
        expect(
          (await readCursors(workspaceId, reader)).sort((a, b) =>
            a.sessionId.localeCompare(b.sessionId),
          ),
        ).toEqual(expected)
      }
    }, 30_000)

    // The floor is the half of the predicate that is easy to get wrong: without
    // it a workspace with any history reads as entirely unread on day one, and
    // every agent is permanently badged.
    test('unread starts at the reader\u2019s own membership, not at the workspace', async () => {
      const workspaceId = await createWorkspace('session-unread-floor')
      const before = await createSession(workspaceId, 'work that predates the reader')
      // A distinct member, joining after that session already existed.
      const [latecomer] = await addReaders(workspaceId, 'floor', 1)
      const after = await createSession(workspaceId, 'work they could have seen')

      const seen = await listSessionsAs(workspaceId, latecomer!)
      // Never opened either one, so the cursor is absent for both. Only the
      // floor separates them.
      expect(seen.find(row => row.id === before.sessionId)?.unread).toBe(false)
      expect(seen.find(row => row.id === after.sessionId)?.unread).toBe(true)

      // The owner was there before both, so both are theirs to have missed.
      const ownerView = await listSessionsAs(workspaceId, owner.user._id)
      expect(ownerView.map(row => row.unread)).toEqual([true, true])
    }, 60_000)

    test('reading clears unread for that member alone', async () => {
      const workspaceId = await createWorkspace('session-unread-per-member')
      const [alice, bob] = await addReaders(workspaceId, 'unread-pair', 2)
      const session = await createSession(workspaceId, 'shared work')

      const seq = (await listSessionsAs(workspaceId, alice!)).find(
        row => row.id === session.sessionId,
      )?.lastEventSeq
      expect(seq).toBeGreaterThan(0)
      await markSessionRead(workspaceId, session.sessionId, alice!, seq!)

      expect(
        (await listSessionsAs(workspaceId, alice!)).find(row => row.id === session.sessionId)
          ?.unread,
      ).toBe(false)
      expect(
        (await listSessionsAs(workspaceId, bob!)).find(row => row.id === session.sessionId)?.unread,
      ).toBe(true)
    }, 60_000)

    test('a cursor behind the session goes unread again when work lands', async () => {
      const workspaceId = await createWorkspace('session-unread-reopens')
      const [reader] = await addReaders(workspaceId, 'reopen', 1)
      const session = await createSession(workspaceId, 'work that continues')

      const before = (await listSessionsAs(workspaceId, reader!)).find(
        row => row.id === session.sessionId,
      )!
      await markSessionRead(workspaceId, session.sessionId, reader!, before.lastEventSeq)
      expect(
        (await listSessionsAs(workspaceId, reader!)).find(row => row.id === session.sessionId)
          ?.unread,
      ).toBe(false)

      // The agent says something more. A stale cursor is exactly what unread is.
      await appendSessionNote(workspaceId, session.sessionId, 'one more thing')
      const after = (await listSessionsAs(workspaceId, reader!)).find(
        row => row.id === session.sessionId,
      )!
      expect(after.lastEventSeq).toBeGreaterThan(before.lastEventSeq)
      expect(after.unread).toBe(true)
    }, 60_000)

    test('a caller with no actor is never unread to anyone', async () => {
      const workspaceId = await createWorkspace('session-unread-actorless')
      const session = await createSession(workspaceId, 'nobody\u2019s unread')
      // The internal-key path: a machine is not a person, so there is nobody
      // for the badge to be true of.
      expect((await listSessions(workspaceId)).items.map(row => row.unread)).toEqual([false])
      expect((await getSession(workspaceId, session.sessionId))?.unread).toBe(false)
    }, 60_000)

    // The other cascade's boundary, and the one that leaks silently: a session
    // read by more people than a batch holds. `drainDeleteBatches` runs the
    // passes by hand, so a truncated first pass shows up as leftover rows rather
    // than as a scheduler race.
    test('deleting a session crosses its own read batch boundary', async () => {
      const workspaceId = await createWorkspace('session-read-delete-batches')
      const session = await createSession(workspaceId, 'work a crowd watched')
      const readers = DELETE_SESSION_READ_BATCH + 1
      expect(
        await convex.mutation('testing/agentSessions:seedSessionReadersForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          sessionId: session.sessionId,
          count: readers,
          now: 1_000,
        }),
      ).toBe(readers)
      expect(await childRowCounts(session.sessionId)).toMatchObject({ reads: readers })

      await convex.mutation('domains/agentSessions/model:beginSessionSubtreeDeletion', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        workspaceId,
        sessionId: session.sessionId,
      })
      await drainDeleteBatches(session.sessionId)

      expect(await childRowCounts(session.sessionId)).toMatchObject({ reads: 0 })
    }, 60_000)
  })
}
