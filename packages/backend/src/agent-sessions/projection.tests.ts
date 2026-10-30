import { expect, test } from 'bun:test'

import {
  SESSION_AUDIENCE_PREVIEW_LIMIT,
  WORKSPACE_MEMBER_LIMIT,
  SessionSummarySchema,
} from '@repo/contract'
import { mutate } from '@repo/test-harness'

import {
  INTERNAL_KEY,
  addReaders,
  convex,
  createSession,
  createSessionInDir,
  createWorkspace,
  owner,
  registerTestAgent,
} from './test-support'

export function registerProjectionTests(): void {
  test('session responses do not expose persisted creator metadata', async () => {
    const workspaceId = await createWorkspace('projection-current-creator')
    await convex.mutation('testing/publishes:setUserNameForTest', {
      internalKey: INTERNAL_KEY,
      userId: owner.user._id,
      name: 'Current Creator',
    })
    const session = await createSession(workspaceId, 'Show the current creator.')

    const snapshot = (await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId,
      sessionId: session.sessionId,
    })) as Record<string, unknown> & { permissions: unknown }
    expect(snapshot).not.toHaveProperty('creator')
    expect(snapshot.permissions).toEqual({
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: false,
      personalArchive: true,
      globalArchive: true,
      delete: true,
    })
  })

  test('specific audience preview is current, canonical, bounded, and excludes owner override', async () => {
    const workspaceId = await createWorkspace('projection-specific-preview')
    const participantIds = await addReaders(
      workspaceId,
      'projection-preview',
      SESSION_AUDIENCE_PREVIEW_LIMIT + 1,
    )
    const memberships = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; userId: string }>
    const participantMemberships = participantIds.map(
      userId => memberships.find(membership => membership.userId === userId)!,
    )
    const session = await createSession(workspaceId, 'Bound the audience.')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: participantMemberships.map(membership => membership._id).reverse(),
    })

    const snapshot = (await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId,
      sessionId: session.sessionId,
    })) as {
      audience: {
        kind: 'specific'
        count: number
        preview: Array<{ memberId: string; userId: string; name: string }>
      }
      permissions: unknown
    }
    expect(snapshot.audience.count).toBe(participantIds.length)
    expect(snapshot.audience.preview.map(member => member.userId)).toEqual(
      participantIds.slice(0, SESSION_AUDIENCE_PREVIEW_LIMIT),
    )
    expect(snapshot.audience.preview.map(member => member.memberId)).toEqual(
      participantMemberships.slice(0, SESSION_AUDIENCE_PREVIEW_LIMIT).map(member => member._id),
    )
    expect(snapshot.audience.preview.some(member => member.userId === owner.user._id)).toBe(false)
    const ownerOverride = (await convex.query('domains/agentSessions/model:getSessionPoint', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
      workspaceId,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
    })) as { audience: typeof snapshot.audience; permissions: unknown }
    expect(ownerOverride.audience.preview.some(member => member.userId === owner.user._id)).toBe(
      false,
    )
    expect(ownerOverride.permissions).toEqual({
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: true,
      personalArchive: true,
      globalArchive: true,
      delete: true,
    })
    const workspacePrincipal = (await convex.query('domains/agentSessions/model:getSessionPoint', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
      workspaceId,
      identity: { principal: { kind: 'workspace' }, actorId: owner.user._id },
    })) as { permissions: unknown }
    expect(workspacePrincipal.permissions).toEqual({
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: true,
      personalArchive: false,
      globalArchive: true,
      delete: true,
    })
  })

  test('workspace authority can manage a specific audience after its agent row is deleted', async () => {
    const workspaceId = await createWorkspace('projection-missing-agent-audience')
    const participantId = (await addReaders(workspaceId, 'missing-agent-audience', 1))[0]!
    const memberships = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; userId: string }>
    const ownerMembershipId = memberships.find(row => row.userId === owner.user._id)!._id
    const agent = await registerTestAgent(
      workspaceId,
      'agents/missing-audience-owner',
      'missing-audience-owner',
    )
    const session = await createSessionInDir(
      workspaceId,
      'Keep the workspace authority consistent.',
      1_000,
      'agents/missing-audience-owner/work',
    )
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [ownerMembershipId],
    })
    await convex.mutation('testing/agents:deleteAgentRowWithoutSessionCleanupForTest', {
      internalKey: INTERNAL_KEY,
      agentId: agent.id,
    })
    const identity = {
      principal: { kind: 'workspace' as const },
      actorId: owner.user._id,
    }

    const before = (await convex.query('domains/agentSessions/model:getSessionPoint', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      identity,
    })) as { permissions: { manageAudience: boolean } }
    expect(before.permissions.manageAudience).toBe(true)

    const after = (await convex.mutation('domains/agentSessions/model:applySessionAudienceDelta', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      identity,
      add: [participantId],
      remove: [],
      now: 2_000,
    })) as {
      audience: {
        kind: 'specific'
        count: number
        preview: Array<{ userId: string }>
      }
      permissions: { manageAudience: boolean }
    }
    expect(after.audience.count).toBe(2)
    expect(after.audience.preview.map(member => member.userId)).toEqual([
      owner.user._id,
      participantId,
    ])
    expect(after.permissions.manageAudience).toBe(true)
  })

  test('specific audience projection stays bounded at the workspace member cap', async () => {
    const workspaceId = await createWorkspace('projection-specific-cap')
    await convex.mutation('testing/workspaces:fillWorkspaceMemberCapacityForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      targetCount: WORKSPACE_MEMBER_LIMIT,
    })
    const memberships = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string }>
    expect(memberships).toHaveLength(WORKSPACE_MEMBER_LIMIT)
    const session = await createSession(workspaceId, 'Project the largest valid audience.')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: memberships.map(membership => membership._id),
    })

    const snapshot = (await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId,
      sessionId: session.sessionId,
    })) as { audience: { kind: 'specific'; count: number; preview: unknown[] } }
    expect(snapshot.audience.count).toBe(WORKSPACE_MEMBER_LIMIT)
    expect(snapshot.audience.preview).toHaveLength(SESSION_AUDIENCE_PREVIEW_LIMIT)

    const renamed = (await convex.mutation('domains/agentSessions/model:renameSession', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      workspaceId,
      sessionId: session.sessionId,
      title: 'Largest valid audience',
      now: 5_000,
    })) as { audience: { kind: 'specific'; count: number; preview: unknown[] } }
    expect(renamed.audience.count).toBe(WORKSPACE_MEMBER_LIMIT)
    expect(renamed.audience.preview).toHaveLength(SESSION_AUDIENCE_PREVIEW_LIMIT)
  })

  test('global archive dominates personal reason while preserving both causes and permissions', async () => {
    const workspaceId = await createWorkspace('projection-archive-precedence')
    const [viewerId] = await addReaders(workspaceId, 'projection-archive', 1)
    const memberships = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; userId: string }>
    const viewerMembership = memberships.find(membership => membership.userId === viewerId)!
    const session = await createSession(workspaceId, 'Keep both archive causes.')
    const workspaceViewer = (await convex.query('domains/agentSessions/model:getSessionPoint', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
      workspaceId,
      identity: {
        principal: { kind: 'human', userId: viewerId },
        actorId: viewerId,
      },
    })) as { permissions: unknown }
    expect(workspaceViewer.permissions).toEqual({
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: false,
      personalArchive: true,
      globalArchive: false,
      delete: false,
    })
    await mutate(owner.client, 'domains/workspaces/mutations:setMemberRole', {
      workspaceId,
      userId: viewerId,
      role: 'editor',
    })
    const workspaceEditor = (await convex.query('domains/agentSessions/model:getSessionPoint', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
      workspaceId,
      identity: {
        principal: { kind: 'human', userId: viewerId },
        actorId: viewerId,
      },
    })) as { permissions: unknown }
    expect(workspaceEditor.permissions).toEqual({
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: false,
      personalArchive: true,
      globalArchive: true,
      delete: true,
    })
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [viewerMembership._id],
    })
    const specificEditor = (await convex.query('domains/agentSessions/model:getSessionPoint', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
      workspaceId,
      identity: {
        principal: { kind: 'human', userId: viewerId },
        actorId: viewerId,
      },
    })) as { permissions: unknown }
    expect(specificEditor.permissions).toEqual({
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: true,
      personalArchive: true,
      globalArchive: true,
      delete: true,
    })
    await mutate(owner.client, 'domains/workspaces/mutations:setMemberRole', {
      workspaceId,
      userId: viewerId,
      role: 'viewer',
    })
    await convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId: viewerMembership._id,
      archivedAt: 3_000,
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
      sessionId: session.sessionId,
      archived: true,
      now: 4_000,
    })

    const snapshot = (await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      actorId: viewerId,
      workspaceId,
      sessionId: session.sessionId,
    })) as {
      archive: unknown
      permissions: unknown
    }
    expect(snapshot.archive).toEqual({
      globalArchivedAt: 4_000,
      personalArchivedAt: 3_000,
      reason: 'global',
    })
    expect(snapshot.permissions).toEqual({
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: true,
      personalArchive: true,
      globalArchive: false,
      delete: false,
    })
  })

  test('production projection outputs satisfy the summary cross-field refinements', async () => {
    const workspaceId = await createWorkspace('projection-contract-conformance')
    const [viewerId] = await addReaders(workspaceId, 'projection-contract', 1)
    const memberships = (await convex.query('testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; userId: string }>
    const viewerMembership = memberships.find(membership => membership.userId === viewerId)!
    const session = await createSession(workspaceId, 'Validate the public projection contract.')
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipIds: [viewerMembership._id],
    })
    await convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      membershipId: viewerMembership._id,
      archivedAt: 3_000,
    })

    const personal = await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      actorId: viewerId,
      workspaceId,
      sessionId: session.sessionId,
    })
    expect(SessionSummarySchema.safeParse(personal).success).toBe(true)

    const global = await convex.mutation('domains/agentSessions/model:setSessionArchive', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      kind: 'global',
      workspaceId,
      sessionId: session.sessionId,
      archived: true,
      now: 4_000,
    })
    expect(SessionSummarySchema.safeParse(global).success).toBe(true)
  })
}
