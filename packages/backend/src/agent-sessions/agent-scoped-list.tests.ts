import { describe, expect, test } from 'bun:test'

import {
  seedScopedWorkspace,
  registerTestAgent,
  createSessionInDir,
  setSessionGlobalArchive,
  createWorkspace,
  relay,
  listSessions,
  listJobs,
  stateMachineFixture,
  terminalEvent,
} from './test-support'

export function registerAgentScopedListTests(): void {
  describe('agent-scoped listing', () => {
    // L2 — the drive-root card's most-used query rests on q.eq('agentId', undefined)
    // selecting exactly the unattributed rows with stable pagination. This probe
    // gates the whole ladder: if it fails, stop and replan.
    test('L2 probe: agentId:root returns exactly the unattributed rows, newest-first, across a page boundary', async () => {
      const seed = await seedScopedWorkspace('agent-scope-root')

      const firstPage = await listSessions(seed.workspaceId, { agentId: 'root', limit: 1 })
      expect(firstPage.items.map(session => session.id)).toEqual([seed.root2.sessionId])
      expect(firstPage.nextCursor).toBeDefined()

      const secondPage = await listSessions(seed.workspaceId, {
        agentId: 'root',
        limit: 1,
        cursor: firstPage.nextCursor!,
      })
      expect(secondPage.items.map(session => session.id)).toEqual([seed.root1.sessionId])

      // Convex marks a *full* final page not-done and hands back a cursor; the
      // range is genuinely exhausted, so the follow-up page is empty and no
      // attributed row ever leaks across the boundary.
      if (secondPage.nextCursor !== null) {
        const thirdPage = await listSessions(seed.workspaceId, {
          agentId: 'root',
          limit: 1,
          cursor: secondPage.nextCursor,
        })
        expect(thirdPage.items).toEqual([])
        expect(thirdPage.nextCursor).toBeNull()
      }

      const allRoot = await listSessions(seed.workspaceId, { agentId: 'root', limit: 50 })
      expect(allRoot.items.map(session => session.id)).toEqual([
        seed.root2.sessionId,
        seed.root1.sessionId,
      ])
      for (const session of allRoot.items) expect(session.agent).toBeUndefined()
    })

    test('agentId:<id> returns only that agent, newest-first, with its identity attached', async () => {
      const seed = await seedScopedWorkspace('agent-scope-agent')

      const scoped = await listSessions(seed.workspaceId, { agentId: seed.agentA.id, limit: 50 })
      expect(scoped.items.map(session => session.id)).toEqual([
        seed.a2.sessionId,
        seed.a1.sessionId,
      ])
      for (const session of scoped.items)
        expect(session.agent).toEqual({ id: seed.agentA.id, name: 'Agent A' })
    })

    test('agent scope combines with a bucket filter', async () => {
      const seed = await seedScopedWorkspace('agent-scope-bucket')
      await relay(seed.workspaceId, seed.a1.sessionId, terminalEvent('complete'))

      const running = await listSessions(seed.workspaceId, {
        agentId: seed.agentA.id,
        bucket: 'running',
      })
      expect(running.items.map(session => session.id)).toEqual([seed.a2.sessionId])

      const done = await listSessions(seed.workspaceId, {
        agentId: seed.agentA.id,
        bucket: 'done',
      })
      expect(done.items.map(session => session.id)).toEqual([seed.a1.sessionId])
    })

    test('agent scope combines with archived:only', async () => {
      const seed = await seedScopedWorkspace('agent-scope-archived')
      await setSessionGlobalArchive(seed.workspaceId, seed.a1.sessionId, true)

      const archived = await listSessions(seed.workspaceId, {
        agentId: seed.agentA.id,
        archived: 'only',
      })
      expect(archived.items.map(session => session.id)).toEqual([seed.a1.sessionId])

      const active = await listSessions(seed.workspaceId, {
        agentId: seed.agentA.id,
        archived: 'exclude',
      })
      expect(active.items.map(session => session.id)).toEqual([seed.a2.sessionId])
    })

    // L1 — agentId must compose with the existing search filter fields on
    // search_sessions, both narrowing to the agent and honoring the search term.
    test('L1 probe: agentId combines with search on the search index', async () => {
      const workspaceId = await createWorkspace('agent-scope-search')
      const agentA = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      await createSessionInDir(workspaceId, 'root deployment plan', 1_000, '')
      const match = await createSessionInDir(
        workspaceId,
        'agent deployment runbook',
        2_000,
        'agents/a/x',
      )
      await createSessionInDir(workspaceId, 'agent grocery list', 3_000, 'agents/a/y')

      const scoped = await listSessions(workspaceId, { agentId: agentA.id, search: 'deployment' })
      expect(scoped.items.map(session => session.id)).toEqual([match.sessionId])
    })

    // L2-on-search — the search index's root-scope narrowing
    // (`.eq('agentId', undefined)` inside the search branch) had zero coverage
    // until slice 08's flattened search became the first code to combine a search
    // term with the root scope. Mirror the L2 probe on the search path: root-scoped
    // search returns exactly the matching unattributed rows, with no attributed
    // rows leaking in.
    test('L2-on-search probe: agentId:root + search returns only unattributed matches', async () => {
      const workspaceId = await createWorkspace('agent-scope-root-search')
      await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const rootMatch = await createSessionInDir(workspaceId, 'root deployment plan', 1_000, '')
      await createSessionInDir(workspaceId, 'agent deployment runbook', 2_000, 'agents/a/x')
      await createSessionInDir(workspaceId, 'root grocery list', 3_000, '')

      const scoped = await listSessions(workspaceId, { agentId: 'root', search: 'deployment' })
      expect(scoped.items.map(session => session.id)).toEqual([rootMatch.sessionId])
      for (const session of scoped.items) expect(session.agent).toBeUndefined()
    })

    test('agent scope stays within its workspace', async () => {
      const a = await seedScopedWorkspace('agent-scope-iso-a')
      const b = await seedScopedWorkspace('agent-scope-iso-b')

      const cross = await listSessions(b.workspaceId, { agentId: a.agentA.id, limit: 50 })
      expect(cross.items).toEqual([])

      const rootB = await listSessions(b.workspaceId, { agentId: 'root', limit: 50 })
      expect(rootB.items.map(session => session.id)).toEqual([b.root2.sessionId, b.root1.sessionId])
    })

    test('agentId scopes the Jobs list', async () => {
      const workspaceId = await createWorkspace('agent-scope-jobs')
      const agentA = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
      const agentJob = await createSessionInDir(workspaceId, 'agent job', 1_000, 'agents/a/x')
      const rootJob = await createSessionInDir(workspaceId, 'root job', 2_000, '')
      await relay(workspaceId, agentJob.sessionId, {
        type: 'state_machine',
        stateMachine: stateMachineFixture(),
      })
      await relay(workspaceId, rootJob.sessionId, {
        type: 'state_machine',
        stateMachine: stateMachineFixture(),
      })

      const scoped = await listJobs(workspaceId, { view: 'active', agentId: agentA.id })
      expect(scoped.jobs.map(job => job.id)).toEqual([agentJob.sessionId])

      const rootScoped = await listJobs(workspaceId, { view: 'active', agentId: 'root' })
      expect(rootScoped.jobs.map(job => job.id)).toEqual([rootJob.sessionId])
    })
  })
}
