import { describe, expect, test } from 'bun:test'

import { mutate } from '@repo/test-harness'

import {
  owner,
  createWorkspace,
  createSessionAt,
  getSession,
  listSessions,
  listJobs,
} from './test-support'

export function registerOnboardingSessionTests(): void {
  describe('onboarding sessions', () => {
    test('open-or-create reuses the newest, and hides it from every list, job view, and search', async () => {
      const workspaceId = await createWorkspace('onboarding-hide')
      const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId,
        path: 'agents/ads',
        slug: 'ads',
      })) as { id: string }
      const ordinary = await createSessionAt(workspaceId, 'ordinary onboarding work', 1_000)

      const opened = (await mutate(
        owner.client,
        'domains/agentSessions/creation:openOnboardingSession',
        { workspaceId, agentId: agent.id, now: 2_000 },
      )) as { sessionId: string }

      // Open-or-create, not create: the CTA is pressed repeatedly and must land
      // the user back in the same conversation rather than forking a new one.
      expect(
        (
          (await mutate(owner.client, 'domains/agentSessions/creation:openOnboardingSession', {
            workspaceId,
            agentId: agent.id,
            now: 3_000,
          })) as { sessionId: string }
        ).sessionId,
      ).toBe(opened.sessionId)

      // Hidden from every read path a user can reach it through...
      const unscoped = await listSessions(workspaceId)
      expect(unscoped.items.map(s => s.id)).toEqual([ordinary.sessionId])
      expect((await listSessions(workspaceId, { agentId: agent.id })).items.map(s => s.id)).toEqual(
        [],
      )
      expect(
        (await listSessions(workspaceId, { archived: 'only' })).items.map(s => s.id),
      ).not.toContain(opened.sessionId)
      expect(
        (await listSessions(workspaceId, { search: 'onboarding' })).items.map(s => s.id),
      ).toEqual([ordinary.sessionId])
      expect(
        (await listJobs(workspaceId, { view: 'active' })).jobs.map(job => job.id),
      ).not.toContain(opened.sessionId)

      // ...but still directly readable, because it IS the session the user is
      // sitting in while onboarding.
      expect(await getSession(workspaceId, opened.sessionId)).toMatchObject({
        id: opened.sessionId,
        onboarding: true,
        agent: { id: agent.id },
      })
    })
  })
}
