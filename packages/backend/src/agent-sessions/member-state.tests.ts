import { expect, test } from 'bun:test'

import { WORKSPACE_MEMBER_LIMIT } from '@repo/contract'
import { mutate, signInWithMagicLink, uniqueEmail } from '@repo/test-harness'

import { MEMBERSHIP_REMOVAL_BATCH_SIZE } from '../../convex/domains/agentSessions/membershipRemoval'
import {
  INTERNAL_KEY,
  addReaders,
  appendSessionNote,
  convex,
  createSession,
  createSessionAt,
  createWorkspace,
  eventually,
  markSessionRead,
  owner,
  readCursors,
  type UserRow,
} from './test-support'

export function registerMemberStateTests(): void {
  test('workspace members can personally archive a workspace session without an audience grant', async () => {
    const workspaceId = await createWorkspace('member-state-workspace-archive')
    const [participantId] = await addReaders(workspaceId, 'workspace-archive', 1)
    const membershipId = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === participantId)!._id
    const session = await createSession(workspaceId, 'Archive this workspace chat for me')

    await convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId,
      archivedAt: 900,
    })

    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId,
      }),
    ).toMatchObject({ audienceGranted: false, personalArchivedAt: 900 })
    expect(
      await listSessionIdsPage({
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: participantId,
        archived: false,
        limit: 10,
      }),
    ).toEqual({ sessionIds: [], nextCursor: null })
    expect(
      await listSessionIdsPage({
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: participantId,
        archived: true,
        limit: 10,
      }),
    ).toEqual({ sessionIds: [session.sessionId], nextCursor: null })

    await convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId,
    })
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId,
      }),
    ).toBeNull()
    expect(
      await listSessionIdsPage({
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: participantId,
        archived: false,
        limit: 10,
      }),
    ).toEqual({ sessionIds: [session.sessionId], nextCursor: null })
  })

  test('public personal and global archive are independent desired states', async () => {
    const workspaceId = await createWorkspace('member-state-public-archive')
    const [viewerId] = await addReaders(workspaceId, 'public-archive', 1)
    const membershipId = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === viewerId)!._id
    const session = await createSession(workspaceId, 'Keep the two archive causes separate')
    const viewerIdentity = {
      principal: { kind: 'human' as const, userId: viewerId },
      actorId: viewerId,
    }
    const ownerIdentity = {
      principal: { kind: 'human' as const, userId: owner.user._id },
      actorId: owner.user._id,
    }

    await convex.mutation('domains/agentSessions/model:setSessionArchive', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      actorId: viewerId,
      identity: viewerIdentity,
      kind: 'personal',
      archived: true,
      now: 1_000,
    })
    await convex.mutation('domains/agentSessions/model:setSessionArchive', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      actorId: viewerId,
      identity: viewerIdentity,
      kind: 'personal',
      archived: true,
      now: 2_000,
    })
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId,
      }),
    ).toMatchObject({ personalArchivedAt: 1_000 })
    await expect(
      convex.mutation('domains/agentSessions/model:setSessionArchive', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        actorId: viewerId,
        identity: viewerIdentity,
        kind: 'global',
        archived: true,
      }),
    ).rejects.toThrow(/forbidden/)

    for (const now of [3_000, 4_000]) {
      await convex.mutation('domains/agentSessions/model:setSessionArchive', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        actorId: owner.user._id,
        identity: ownerIdentity,
        kind: 'global',
        archived: true,
        now,
      })
    }
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ archiveState: 'archived', archivedAt: 3_000, updatedAt: 3_000 })
    expect(
      await convex.query('domains/agentSessions/model:getSessionPoint', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        identity: viewerIdentity,
      }),
    ).toMatchObject({
      archive: { globalArchivedAt: 3_000, personalArchivedAt: 1_000, reason: 'global' },
    })

    await convex.mutation('domains/agentSessions/model:setSessionArchive', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      actorId: owner.user._id,
      identity: ownerIdentity,
      kind: 'global',
      archived: false,
      now: 5_000,
    })
    expect(
      await convex.query('domains/agentSessions/model:getSessionPoint', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        identity: viewerIdentity,
      }),
    ).toMatchObject({
      archive: { globalArchivedAt: null, personalArchivedAt: 1_000, reason: 'personal' },
    })

    await appendSessionNote(workspaceId, session.sessionId, 'Activity does not unarchive me')
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId,
      }),
    ).toMatchObject({ personalArchivedAt: 1_000 })
  })

  test('workspace principals can globally archive but have no personal archive', async () => {
    const workspaceId = await createWorkspace('member-state-workspace-principal')
    const session = await createSession(workspaceId, 'Workspace lifecycle authority')
    const identity = { principal: { kind: 'workspace' as const }, actorId: owner.user._id }
    await expect(
      convex.mutation('domains/agentSessions/model:setSessionArchive', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        actorId: owner.user._id,
        identity,
        kind: 'personal',
        archived: true,
      }),
    ).rejects.toThrow(/forbidden/)
    expect(
      await convex.mutation('domains/agentSessions/model:setSessionArchive', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        actorId: owner.user._id,
        identity,
        kind: 'global',
        archived: true,
        now: 7_000,
      }),
    ).toMatchObject({ archive: { globalArchivedAt: 7_000, personalArchivedAt: null } })
  })

  test('global archive admits an editor participant but hides an editor nonparticipant', async () => {
    const workspaceId = await createWorkspace('member-state-editor-global')
    const editor = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('member-state-editor-global'),
      'Archive Editor',
    )
    const membershipId = (await mutate(
      owner.client,
      'testing/workspaces:addWorkspaceMemberForTest',
      {
        internalKey: INTERNAL_KEY,
        workspaceId,
        userId: editor.user._id,
        role: 'editor',
      },
    )) as string
    const identity = {
      principal: { kind: 'human' as const, userId: editor.user._id },
      actorId: editor.user._id,
    }
    const admitted = await createSession(workspaceId, 'Editor participant lifecycle')
    const hidden = await createSession(workspaceId, 'Editor is outside this audience')
    for (const [sessionId, membershipIds] of [
      [admitted.sessionId, [membershipId]],
      [hidden.sessionId, []],
    ] as const) {
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId,
        membershipIds: [...membershipIds],
      })
    }
    expect(
      await convex.mutation('domains/agentSessions/model:setSessionArchive', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: admitted.sessionId,
        actorId: editor.user._id,
        identity,
        kind: 'global',
        archived: true,
        now: 8_000,
      }),
    ).toMatchObject({ archive: { globalArchivedAt: 8_000 } })
    await expect(
      convex.mutation('domains/agentSessions/model:setSessionArchive', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: hidden.sessionId,
        actorId: editor.user._id,
        identity,
        kind: 'global',
        archived: true,
      }),
    ).rejects.toThrow(/not_found/)
  })

  test('owner override can personally archive a specific session without becoming a participant', async () => {
    const workspaceId = await createWorkspace('member-state-owner-archive')
    const [participantId] = await addReaders(workspaceId, 'owner-archive', 1)
    const members = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; userId: string }>
    const ownerMembershipId = members.find(row => row.userId === owner.user._id)!._id
    const participantMembershipId = members.find(row => row.userId === participantId)!._id
    const session = await createSession(workspaceId, 'Owner-only recovery view')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [participantMembershipId],
    })

    await convex.mutation('domains/agentSessions/model:setSessionArchive', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      kind: 'personal',
      archived: true,
      now: 950,
    })

    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId: ownerMembershipId,
      }),
    ).toMatchObject({ audienceGranted: false, personalArchivedAt: 950 })
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ specificGrantedParticipantCount: 1 })
    expect(
      await listSessionIdsPage({
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: owner.user._id,
        archived: true,
        limit: 10,
      }),
    ).toEqual({ sessionIds: [session.sessionId], nextCursor: null })

    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: ownerMembershipId,
      now: 960,
    })
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: ownerMembershipId,
      expectedAfterSessionId: null,
    })
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId: ownerMembershipId,
      }),
    ).toBeNull()
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ archiveState: 'active', specificGrantedParticipantCount: 1 })
  })

  test('workspace preference cleanup is generation-exact and rejoin starts unarchived', async () => {
    const workspaceId = await createWorkspace('member-state-workspace-rejoin')
    const [participantId] = await addReaders(workspaceId, 'workspace-rejoin', 1)
    const membershipA = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === participantId)!._id
    const session = await createSession(workspaceId, 'A fresh membership gets a fresh preference')
    await convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId: membershipA,
      archivedAt: 975,
    })
    expect(
      await convex.query('testing/agentSessions:discoveryLaneExistsForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        laneKey: `personal:${membershipA}`,
      }),
    ).toBe(true)

    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: membershipA,
      now: 980,
    })
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: membershipA,
      expectedAfterSessionId: null,
    })

    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId: membershipA,
      }),
    ).toBeNull()
    expect(
      await convex.query('testing/agentSessions:membershipRemovalJobForTest', {
        internalKey: INTERNAL_KEY,
        membershipId: membershipA,
      }),
    ).toBeNull()
    expect(
      await convex.query('testing/agentSessions:discoveryLaneExistsForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        laneKey: `personal:${membershipA}`,
      }),
    ).toBe(false)
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ audienceKind: 'workspace', archiveState: 'active' })

    await convex.mutation('testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: participantId,
      role: 'viewer',
    })
    expect(
      await listSessionIdsPage({
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: participantId,
        archived: false,
        limit: 10,
      }),
    ).toEqual({ sessionIds: [session.sessionId], nextCursor: null })
    expect(
      await listSessionIdsPage({
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: participantId,
        archived: true,
        limit: 10,
      }),
    ).toEqual({ sessionIds: [], nextCursor: null })
  })

  test('archive discovery continues across personal/global lanes and active short pages', async () => {
    const workspaceId = await createWorkspace('member-state-archive-pages')
    const [viewerId] = await addReaders(workspaceId, 'archive-pages', 1)
    const membershipId = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === viewerId)!._id
    const older = await createSessionAt(workspaceId, 'Older active row', 100)
    const personalA = await createSessionAt(workspaceId, 'Personal archive A', 200)
    const personalB = await createSessionAt(workspaceId, 'Personal archive B', 300)
    for (const [sessionId, archivedAt] of [
      [personalA.sessionId, 1_000],
      [personalB.sessionId, 2_000],
    ] as const) {
      await convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId,
        membershipId,
        archivedAt,
      })
    }
    await convex.mutation('domains/agentSessions/model:setSessionArchive', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: personalA.sessionId,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      kind: 'global',
      archived: true,
      now: 3_000,
    })

    const archivedIds: string[] = []
    let cursor: string | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = (await listSessionIdsPage({
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: viewerId,
        archived: true,
        limit: 1,
        cursor,
      })) as { sessionIds: string[]; nextCursor: string | null }
      archivedIds.push(...page.sessionIds)
      cursor = page.nextCursor ?? undefined
      if (cursor === undefined) break
    }
    expect(cursor).toBeUndefined()
    expect(new Set(archivedIds)).toEqual(new Set([personalA.sessionId, personalB.sessionId]))
    expect(archivedIds).toHaveLength(2)

    const short = (await listSessionIdsPage({
      internalKey: INTERNAL_KEY,
      workspaceId,
      actorId: viewerId,
      archived: false,
      limit: 1,
    })) as { sessionIds: string[]; nextCursor: string | null }
    expect(short.sessionIds).toEqual([])
    expect(short.nextCursor).not.toBeNull()
    const activeIds: string[] = []
    cursor = short.nextCursor ?? undefined
    for (let attempt = 0; cursor !== undefined && attempt < 3; attempt++) {
      const page = (await listSessionIdsPage({
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: viewerId,
        archived: false,
        limit: 1,
        cursor,
      })) as { sessionIds: string[]; nextCursor: string | null }
      activeIds.push(...page.sessionIds)
      cursor = page.nextCursor ?? undefined
    }
    expect(cursor).toBeUndefined()
    expect(activeIds).toEqual([older.sessionId])
  })

  test('removing an absent grant is idempotent on a valid zero-count session', async () => {
    const workspaceId = await createWorkspace('member-state-absent-remove')
    const [participantId] = await addReaders(workspaceId, 'absent-remove', 1)
    const membershipId = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === participantId)!._id
    const session = await createSession(workspaceId, 'No grant exists')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [],
    })

    await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId,
      granted: false,
    })
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ specificGrantedParticipantCount: 0 })
  })

  test('same-generation grant toggles preserve personal archive state', async () => {
    const workspaceId = await createWorkspace('member-state-sticky-archive')
    const [participantId, otherParticipantId] = await addReaders(workspaceId, 'sticky', 2)
    const members = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; userId: string }>
    const membershipId = members.find(row => row.userId === participantId)!._id
    const otherMembershipId = members.find(row => row.userId === otherParticipantId)!._id
    const session = await createSession(workspaceId, 'Keep my archive preference')

    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [membershipId, otherMembershipId],
    })
    await convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId,
      archivedAt: 1_000,
    })
    expect(
      await listSessionIdsPage({
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: participantId,
        archived: true,
        limit: 10,
      }),
    ).toEqual({ sessionIds: [session.sessionId], nextCursor: null })
    await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId,
      granted: false,
    })
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId,
      }),
    ).toMatchObject({ audienceGranted: false, personalArchivedAt: 1_000 })
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ archiveState: 'active', specificGrantedParticipantCount: 1 })
    expect(
      await listSessionIdsPage({
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: participantId,
        archived: true,
        limit: 10,
      }),
    ).toEqual({ sessionIds: [], nextCursor: null })

    await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId,
      granted: true,
    })
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId,
      }),
    ).toMatchObject({ audienceGranted: true, personalArchivedAt: 1_000 })
    expect(
      await listSessionIdsPage({
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: participantId,
        archived: true,
        limit: 10,
      }),
    ).toEqual({ sessionIds: [session.sessionId], nextCursor: null })
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({
      audienceKind: 'specific',
      archiveState: 'active',
      specificGrantedParticipantCount: 2,
    })
  })

  test('audience edits preserve the human caller unread badge', async () => {
    const workspaceId = await createWorkspace('member-state-audience-unread')
    const [participantId] = await addReaders(workspaceId, 'audience-unread', 1)
    const memberships = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; userId: string }>
    const ownerMembershipId = memberships.find(row => row.userId === owner.user._id)!._id
    const session = await createSession(workspaceId, 'Audience edits are not reads')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [ownerMembershipId],
    })
    await appendSessionNote(workspaceId, session.sessionId, 'unread work')

    const result = (await convex.mutation('domains/agentSessions/model:applySessionAudienceDelta', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      add: [participantId!],
      remove: [],
    })) as { unread: boolean }

    expect(result.unread).toBe(true)

    const workspaceResult = (await convex.mutation(
      'domains/agentSessions/model:applySessionAudienceDelta',
      {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        identity: { principal: { kind: 'workspace' }, actorId: owner.user._id },
        add: [],
        remove: [participantId!],
      },
    )) as { unread: boolean }
    expect(workspaceResult.unread).toBe(false)
  }, 120_000)

  test('nonfinal removal decrements while final removal globally archives', async () => {
    const workspaceId = await createWorkspace('member-state-final')
    const [firstUserId, secondUserId] = await addReaders(workspaceId, 'final', 2)
    const members = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; userId: string }>
    const firstMembershipId = members.find(row => row.userId === firstUserId)!._id
    const secondMembershipId = members.find(row => row.userId === secondUserId)!._id
    const session = await createSession(workspaceId, 'Archive when everyone leaves')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [firstMembershipId, secondMembershipId],
    })

    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: firstMembershipId,
      now: 3_000,
    })
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: firstMembershipId,
      expectedAfterSessionId: null,
    })
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ archiveState: 'active', specificGrantedParticipantCount: 1 })

    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: secondMembershipId,
      now: 4_000,
    })
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: secondMembershipId,
      expectedAfterSessionId: null,
    })
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({
      archiveState: 'archived',
      archivedAt: expect.any(Number),
      specificGrantedParticipantCount: 0,
    })
  })

  test('false grants clean up without double-decrement and duplicate jobs are harmless', async () => {
    const workspaceId = await createWorkspace('member-state-false-cleanup')
    const [participantId] = await addReaders(workspaceId, 'false-cleanup', 1)
    const membershipId = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === participantId)!._id
    const session = await createSession(workspaceId, 'Revoked before membership deletion')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [membershipId],
    })
    await convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId,
      archivedAt: 5_000,
    })
    await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId,
      granted: false,
      now: 5_001,
    })
    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      now: 5_002,
    })
    const dispatch = {
      internalKey: INTERNAL_KEY,
      membershipId,
      expectedAfterSessionId: null,
    } as const
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', dispatch)
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', dispatch)

    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId,
      }),
    ).toBeNull()
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ archiveState: 'archived', specificGrantedParticipantCount: 0 })
    expect(
      await convex.query('testing/agentSessions:membershipRemovalJobForTest', {
        internalKey: INTERNAL_KEY,
        membershipId,
      }),
    ).toBeNull()
    await expect(
      convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        membershipId,
        granted: true,
      }),
    ).rejects.toThrow('Workspace member not found')
  })

  test('one poisoned session does not starve later sessions and converges on retry', async () => {
    const workspaceId = await createWorkspace('member-state-poison')
    const [participantId] = await addReaders(workspaceId, 'poison', 1)
    const membershipId = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === participantId)!._id
    const sessions = await Promise.all(
      ['first', 'second', 'third'].map(async label => {
        const session = await createSession(workspaceId, `Poison ${label}`)
        await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          sessionId: session.sessionId,
          membershipIds: [membershipId],
        })
        return session.sessionId
      }),
    )
    const ordered = [...sessions].sort()
    const poisoned = ordered[0]!
    const later = ordered.slice(1)
    await convex.mutation('testing/agentSessions:setSpecificParticipantCountForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: poisoned,
      count: 0,
    })
    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      now: 6_000,
    })
    const dispatch = {
      internalKey: INTERNAL_KEY,
      membershipId,
      expectedAfterSessionId: null,
    } as const
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', dispatch)

    const remaining = (await convex.query(
      'testing/agentSessions:memberStatesForMembershipForTest',
      { internalKey: INTERNAL_KEY, membershipId },
    )) as Array<{ sessionId: string }>
    expect(remaining.map(row => row.sessionId)).toEqual([poisoned])
    expect(remaining.map(row => row.sessionId)).not.toEqual(later)
    const retryJob = (await convex.query('testing/agentSessions:membershipRemovalJobForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
    })) as { afterSessionId?: string } | null
    expect(retryJob).not.toBeNull()
    expect(retryJob?.afterSessionId).toBeUndefined()

    await convex.mutation('testing/agentSessions:setSpecificParticipantCountForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: poisoned,
      count: 1,
    })
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', dispatch)
    expect(
      await convex.query('testing/agentSessions:memberStatesForMembershipForTest', {
        internalKey: INTERNAL_KEY,
        membershipId,
      }),
    ).toEqual([])
    expect(
      await convex.query('testing/agentSessions:membershipRemovalJobForTest', {
        internalKey: INTERNAL_KEY,
        membershipId,
      }),
    ).toBeNull()
  })

  test('an empty tail checkpoint wraps to earlier remaining state', async () => {
    const workspaceId = await createWorkspace('member-state-empty-tail')
    const [participantId] = await addReaders(workspaceId, 'empty-tail', 1)
    const membershipId = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === participantId)!._id
    const sessionIds = (
      await Promise.all(
        ['a', 'b', 'c'].map(
          async label => (await createSession(workspaceId, `Empty tail ${label}`)).sessionId,
        ),
      )
    ).sort()
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: sessionIds[0]!,
      membershipIds: [membershipId],
    })
    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      now: 6_500,
    })
    await convex.mutation('testing/agentSessions:setMembershipRemovalCheckpointForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      afterSessionId: sessionIds.at(-1)!,
    })
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      expectedAfterSessionId: sessionIds.at(-1)!,
    })

    const wrapped = (await convex.query('testing/agentSessions:membershipRemovalJobForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
    })) as { afterSessionId?: string } | null
    expect(wrapped).not.toBeNull()
    expect(wrapped?.afterSessionId).toBeUndefined()
    expect(
      (
        (await convex.query('testing/agentSessions:memberStatesForMembershipForTest', {
          internalKey: INTERNAL_KEY,
          membershipId,
        })) as Array<{ sessionId: string }>
      ).map(row => row.sessionId),
    ).toEqual([sessionIds[0]!])

    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      expectedAfterSessionId: null,
    })
  })

  test('concurrent grant removal and membership deletion linearize to one final archive', async () => {
    const workspaceId = await createWorkspace('member-state-concurrent')
    const participant = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('member-state-concurrent'),
      'Concurrent participant',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: participant.user._id,
      role: 'viewer',
    })
    const participantId = participant.user._id
    const membershipA = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === participantId)!._id
    const session = await createSession(workspaceId, 'Concurrent removal')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [membershipA],
    })

    const [membershipDeletion, grantRemoval] = await Promise.allSettled([
      convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
        internalKey: INTERNAL_KEY,
        membershipId: membershipA,
        now: 6_700,
      }),
      mutate(participant.client, 'testing/agentSessions:applyAudienceGrantForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        membershipId: membershipA,
        granted: false,
        now: 6_700,
      }),
    ])
    expect(membershipDeletion.status).toBe('fulfilled')
    if (grantRemoval.status === 'rejected') {
      expect(String(grantRemoval.reason)).toContain('Workspace member not found')
    } else {
      expect(grantRemoval.status).toBe('fulfilled')
    }
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: membershipA,
      expectedAfterSessionId: null,
    })
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId: membershipA,
      }),
    ).toBeNull()
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ archiveState: 'archived', specificGrantedParticipantCount: 0 })

    const membershipB = (await convex.mutation('testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: participantId!,
      role: 'viewer',
    })) as string
    await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId: membershipB,
      granted: true,
      now: 6_800,
    })
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ archiveState: 'archived', specificGrantedParticipantCount: 1 })
  })

  test('stale dispatches are no-ops and cleanup crosses its batch boundary', async () => {
    const workspaceId = await createWorkspace('member-state-batch')
    const [participantId] = await addReaders(workspaceId, 'batch', 1)
    const membershipId = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === participantId)!._id
    const sessionIds: string[] = []
    for (let index = 0; index < MEMBERSHIP_REMOVAL_BATCH_SIZE + 1; index += 1) {
      const session = await createSession(workspaceId, `Batch ${index}`)
      sessionIds.push(session.sessionId)
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        membershipIds: [membershipId],
      })
    }
    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      now: 7_000,
    })

    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      expectedAfterSessionId: sessionIds[0]!,
    })
    expect(
      (
        (await convex.query('testing/agentSessions:memberStatesForMembershipForTest', {
          internalKey: INTERNAL_KEY,
          membershipId,
        })) as Array<{ sessionId: string }>
      )
        .map(row => row.sessionId)
        .sort(),
    ).toEqual([...sessionIds].sort())

    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      expectedAfterSessionId: null,
    })
    await eventually(async () => {
      expect(
        await convex.query('testing/agentSessions:memberStatesForMembershipForTest', {
          internalKey: INTERNAL_KEY,
          membershipId,
        }),
      ).toEqual([])
      expect(
        await convex.query('testing/agentSessions:membershipRemovalJobForTest', {
          internalKey: INTERNAL_KEY,
          membershipId,
        }),
      ).toBeNull()
    }, 30_000)
    const rows = (await Promise.all(
      sessionIds.map(sessionId =>
        convex.query('testing/agentSessions:rawSessionForTest', {
          internalKey: INTERNAL_KEY,
          sessionId,
        }),
      ),
    )) as Array<{ specificGrantedParticipantCount?: number; archiveState?: string } | null>
    expect(rows).toHaveLength(sessionIds.length)
    expect(rows.every(row => row?.specificGrantedParticipantCount === 0)).toBe(true)
    expect(rows.every(row => row?.archiveState === 'archived')).toBe(true)
  }, 60_000)

  test('the ordinary member-removal mutation schedules exact-generation cleanup', async () => {
    const workspaceId = await createWorkspace('member-state-production-remove')
    const [participantId] = await addReaders(workspaceId, 'production-remove', 1)
    const membershipId = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === participantId)!._id
    const session = await createSession(workspaceId, 'Production removal path')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [membershipId],
    })

    await mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
      workspaceId,
      userId: participantId!,
    })
    await eventually(async () => {
      expect(
        await convex.query('testing/agentSessions:memberStateForTest', {
          internalKey: INTERNAL_KEY,
          sessionId: session.sessionId,
          membershipId,
        }),
      ).toBeNull()
      expect(
        await convex.query('testing/agentSessions:membershipRemovalJobForTest', {
          internalKey: INTERNAL_KEY,
          membershipId,
        }),
      ).toBeNull()
    }, 30_000)
  }, 60_000)

  test('missing and deleting sessions are cleanup success', async () => {
    const workspaceId = await createWorkspace('member-state-terminal-cleanup')
    const [participantId] = await addReaders(workspaceId, 'terminal-cleanup', 1)
    const membershipId = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === participantId)!._id
    const missing = await createSession(workspaceId, 'Missing during cleanup')
    const deleting = await createSession(workspaceId, 'Deleting during cleanup')
    for (const sessionId of [missing.sessionId, deleting.sessionId]) {
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId,
        membershipIds: [membershipId],
      })
    }
    await convex.mutation('testing/agentSessions:deleteSessionRowForMembershipCleanupTest', {
      internalKey: INTERNAL_KEY,
      sessionId: missing.sessionId,
    })
    await convex.mutation('testing/agentSessions:markDeletingForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: deleting.sessionId,
    })
    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      now: 8_000,
    })
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      expectedAfterSessionId: null,
    })

    expect(
      await convex.query('testing/agentSessions:memberStatesForMembershipForTest', {
        internalKey: INTERNAL_KEY,
        membershipId,
      }),
    ).toEqual([])
    expect(
      await convex.query('testing/agentSessions:membershipRemovalJobForTest', {
        internalKey: INTERNAL_KEY,
        membershipId,
      }),
    ).toBeNull()
  })

  test('deleting generation A preserves unread and cannot erase rejoined generation B', async () => {
    const workspaceId = await createWorkspace('member-state-rejoin')
    const [participantId] = await addReaders(workspaceId, 'rejoin', 1)
    const membershipA = (
      (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === participantId)!._id
    const session = await createSession(workspaceId, 'Generation-safe cleanup')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [membershipA],
    })
    await markSessionRead(workspaceId, session.sessionId, participantId!, 2)

    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: membershipA,
      now: 2_000,
    })
    expect(
      await convex.query('testing/agentSessions:sessionAccessForMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        userId: participantId!,
      }),
    ).toEqual({ ok: false, error: 'not_found' })
    expect(await readCursors(workspaceId, participantId!)).toEqual([
      { sessionId: session.sessionId, lastReadSeq: 2 },
    ])
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId: membershipA,
      }),
    ).toMatchObject({ audienceGranted: true })
    await expect(
      convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        membershipId: membershipA,
        granted: false,
      }),
    ).rejects.toThrow('Workspace member not found')
    const membershipB = (await convex.mutation('testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: participantId!,
      role: 'viewer',
    })) as string
    await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId: membershipB,
      granted: true,
      now: 2_100,
    })
    await convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId: membershipB,
      archivedAt: 2_200,
    })
    await convex.action('testing/agentSessions:runMembershipRemovalCoordinatorForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: membershipA,
      expectedAfterSessionId: null,
    })

    expect(await readCursors(workspaceId, participantId!)).toEqual([
      { sessionId: session.sessionId, lastReadSeq: 2 },
    ])
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId: membershipA,
      }),
    ).toBeNull()
    expect(
      await convex.query('testing/agentSessions:memberStateForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        membershipId: membershipB,
      }),
    ).toMatchObject({ audienceGranted: true, personalArchivedAt: 2_200 })
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ archiveState: 'active', specificGrantedParticipantCount: 1 })
  })

  test('maximum disjoint audience delta stays bounded and a repeated delta writes nothing', async () => {
    const workspaceId = await createWorkspace('member-state-audience-budget')
    await convex.mutation('testing/workspaces:fillWorkspaceMemberCapacityForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      targetCount: WORKSPACE_MEMBER_LIMIT,
    })
    const members = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; userId: string }>
    expect(members).toHaveLength(WORKSPACE_MEMBER_LIMIT)

    const session = await createSession(workspaceId, 'Bound one atomic audience replacement')
    const half = Math.floor(members.length / 2)
    const remove = members.slice(0, half)
    const add = members.slice(half)
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: remove.map(member => member._id),
    })

    const maximumMetrics = await convex.mutation(
      'testing/agentSessions:applySessionAudienceDeltaBudgetForTest',
      {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        actorId: owner.user._id,
        add: add.map(member => member.userId),
        remove: remove.map(member => member.userId),
      },
    )
    const measured = maximumMetrics as {
      reads: { ranges: number; documents: number }
      writes: number
      reconciliations: number
    }
    expect(measured.reads.ranges).toBeLessThanOrEqual(3 * members.length + 3)
    expect(measured.reads.documents).toBeLessThanOrEqual(2 * members.length + remove.length + 3)
    expect(measured.writes).toBeLessThanOrEqual(members.length + remove.length + add.length + 1)
    expect(measured.reconciliations).toBeLessThanOrEqual(1)
    expect(
      await convex.query('testing/agentSessions:childRowCountsForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ memberStates: add.length, discovery: add.length + 1 })

    const beforeNoop = await convex.query('testing/agentSessions:rawSessionForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
    })
    const noopMetrics = await convex.mutation(
      'testing/agentSessions:applySessionAudienceDeltaBudgetForTest',
      {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: session.sessionId,
        actorId: owner.user._id,
        add: add.map(member => member.userId),
        remove: [],
      },
    )
    const noop = noopMetrics as typeof measured
    expect(noop.reads.ranges).toBeLessThanOrEqual(members.length + 1)
    expect(noop.reads.documents).toBeLessThanOrEqual(members.length + add.length + 1)
    expect(noop.writes).toBe(0)
    expect(noop.reconciliations).toBe(0)
    expect(
      await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      }),
    ).toEqual(beforeNoop)
  })
}

async function listSessionIdsPage(args: {
  internalKey: string
  workspaceId: string
  actorId: string | undefined
  archived: boolean
  limit: number
  cursor?: string
}): Promise<{ sessionIds: string[]; nextCursor: string | null }> {
  if (args.actorId === undefined) throw new Error('Fixture reader missing')
  const page = (await convex.query('domains/agentSessions/model:listSessions', {
    ...args,
    identity: { principal: { kind: 'human', userId: args.actorId }, actorId: args.actorId },
    archived: args.archived ? 'only' : 'exclude',
  })) as { items: Array<{ id: string }>; nextCursor: string | null }
  return { sessionIds: page.items.map(row => row.id), nextCursor: page.nextCursor }
}
