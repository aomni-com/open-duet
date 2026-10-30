import { describe, expect, test } from 'bun:test'

import {
  INTERNAL_KEY,
  addReaders,
  convex,
  createSessionAt,
  createWorkspace,
  owner,
  setSessionGlobalArchive,
} from './test-support'

export function registerDiscoveryTests(): void {
  describe('the durable authorized session discovery source', () => {
    test('owner, workspace, and exact member-generation views stay in sync with lifecycle writes', async () => {
      const workspaceId = await createWorkspace('session-discovery-matrix')
      const readerIds = await addReaders(workspaceId, 'discovery', 2)
      const participantId = readerIds[0]!
      const bystanderId = readerIds[1]!
      const memberships = (await convex.query('testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
      const participantMembershipId = memberships.find(
        membership => membership.userId === participantId,
      )!._id
      const workspaceSession = await createSessionAt(workspaceId, 'workspace row', 300)
      const specificSession = await createSessionAt(workspaceId, 'specific row', 200)
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: specificSession.sessionId,
        membershipIds: [participantMembershipId],
      })

      expect(await page(workspaceId, participantId)).toEqual([
        workspaceSession.sessionId,
        specificSession.sessionId,
      ])
      expect(await page(workspaceId, bystanderId)).toEqual([workspaceSession.sessionId])
      expect(await page(workspaceId, owner.user._id)).toEqual([
        workspaceSession.sessionId,
        specificSession.sessionId,
      ])

      await convex.mutation('testing/agentSessions:setPersonalArchiveForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: specificSession.sessionId,
        membershipId: participantMembershipId,
        archivedAt: 400,
      })
      expect(await page(workspaceId, participantId)).toEqual([workspaceSession.sessionId])
      expect(await page(workspaceId, participantId, true)).toEqual([specificSession.sessionId])

      await setSessionGlobalArchive(workspaceId, specificSession.sessionId, true)
      expect(await page(workspaceId, participantId, true)).toEqual([specificSession.sessionId])

      await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        sessionId: specificSession.sessionId,
        membershipId: participantMembershipId,
        granted: false,
      })
      expect(await page(workspaceId, participantId, true)).toEqual([])
      expect(await page(workspaceId, owner.user._id, true)).toEqual([specificSession.sessionId])
    }, 120_000)
  })
}

async function page(workspaceId: string, actorId: string, archived = false): Promise<string[]> {
  const result = (await convex.query('domains/agentSessions/model:listSessions', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    actorId,
    archived: archived ? 'only' : 'exclude',
    identity: { principal: { kind: 'human', userId: actorId }, actorId },
    limit: 20,
  })) as { items: Array<{ id: string }> }
  return result.items.map(row => row.id)
}
