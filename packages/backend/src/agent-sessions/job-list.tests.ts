import { describe, expect, test } from 'bun:test'

import {
  INTERNAL_KEY,
  convex,
  owner,
  createWorkspace,
  createSession,
  createSessionAt,
  relay,
  getSession,
  listSessions,
  listJobs,
  stateMachineFixture,
  turnStateWithMachine,
} from './test-support'

export function registerJobListTests(): void {
  describe('listJobs', () => {
    test('projects state-machine membership independently of turn status', async () => {
      const workspaceId = await createWorkspace('agent-job-membership')
      const session = await createSessionAt(workspaceId, 'Remind me to get milk', 1_000)
      const stateMachine = stateMachineFixture({ currentState: 'wait' })

      await relay(
        workspaceId,
        session.sessionId,
        { type: 'state_machine', stateMachine },
        undefined,
        2_000,
      )

      // Starting a machine no longer moves the session to a different list —
      // it gains a relay projection and stays exactly where it was.
      expect((await listSessions(workspaceId)).items.map(entry => entry.id)).toEqual([
        session.sessionId,
      ])
      const active = await listJobs(workspaceId, { view: 'active' })
      expect(active.jobs).toHaveLength(1)
      expect(active.jobs[0]).toMatchObject({
        id: session.sessionId,
        bucket: 'running',
        machine: {
          step: 'wait',
          activity: 'running',
        },
      })
      const snapshot = await getSession(workspaceId, session.sessionId)
      expect(active.jobs[0]!.machine).toEqual({
        step: 'wait',
        progress: { completed: 0, total: 2 },
        activity: 'running',
      })
      expect(snapshot?.machine).toMatchObject({
        currentState: 'wait',
        activity: 'running',
      })
    })

    test('keeps completed relay steps active and requires a new turn to reactivate interruption', async () => {
      const workspaceId = await createWorkspace('agent-job-lifecycle')
      const session = await createSession(workspaceId, 'Run a durable reminder')
      const activeMachine = stateMachineFixture({ currentState: 'remind' })
      await relay(workspaceId, session.sessionId, {
        type: 'state_machine',
        stateMachine: activeMachine,
      })
      await relay(workspaceId, session.sessionId, {
        type: 'complete',
        status: 'completed',
        state: turnStateWithMachine('completed', 'completed', activeMachine),
      })

      expect((await listJobs(workspaceId, { view: 'active' })).jobs.map(job => job.id)).toEqual([
        session.sessionId,
      ])
      expect((await listJobs(workspaceId, { view: 'history' })).jobs).toEqual([])

      const interruptedMachine = stateMachineFixture({
        currentState: 'interrupted',
      })
      await relay(workspaceId, session.sessionId, {
        type: 'interrupted',
        state: turnStateWithMachine('interrupted', 'cancelled', interruptedMachine),
      })
      expect((await listJobs(workspaceId, { view: 'active' })).jobs).toEqual([])
      expect((await listJobs(workspaceId, { view: 'history' })).jobs[0]).toMatchObject({
        id: session.sessionId,
        bucket: 'done',
        machine: { outcome: 'interrupted', activity: 'idle' },
      })

      const reactivatedMachine = stateMachineFixture({
        currentState: 'wait',
        updatedAt: 3,
      })
      await relay(workspaceId, session.sessionId, {
        type: 'state_machine',
        stateMachine: reactivatedMachine,
      })
      // A machine projection alone can be a delayed event; native execution
      // must start a new turn before an interrupted relay becomes active.
      expect((await listJobs(workspaceId, { view: 'active' })).jobs).toEqual([])
      await relay(workspaceId, session.sessionId, {
        type: 'turn_started',
        state: {
          status: 'running',
          mode: reactivatedMachine.definition,
          agent: { status: 'running', messages: [] },
          stateMachine: reactivatedMachine,
        },
      })
      const reactivated = (await listJobs(workspaceId, { view: 'active' })).jobs[0]!
      expect(reactivated).toMatchObject({
        id: session.sessionId,
        bucket: 'running',
      })
      expect(reactivated.machine?.outcome).toBeUndefined()
    })

    test('projects wake observations and terminal outcomes while excluding archives', async () => {
      const workspaceId = await createWorkspace('agent-job-observations')
      const sleeping = await createSession(workspaceId, 'Sleep then remind')
      const activeMachine = stateMachineFixture({ currentState: 'wait' })
      await relay(workspaceId, sleeping.sessionId, {
        type: 'state_machine',
        stateMachine: activeMachine,
      })
      await relay(workspaceId, sleeping.sessionId, {
        type: 'sleep',
        wakeAt: 50_000,
        state: {
          status: 'sleeping',
          mode: activeMachine.definition,
          agent: { status: 'waiting', messages: [] },
          stateMachine: activeMachine,
        },
      })
      expect((await listJobs(workspaceId, { view: 'active' })).jobs[0]).toMatchObject({
        machine: { activity: 'sleeping', nextWakeAt: 50_000 },
      })

      await relay(workspaceId, sleeping.sessionId, {
        type: 'turn_started',
        state: {
          status: 'running',
          mode: activeMachine.definition,
          agent: { status: 'running', messages: [] },
          stateMachine: activeMachine,
        },
      })
      const running = (await listJobs(workspaceId, { view: 'active' })).jobs[0]!
      expect(running.machine).toMatchObject({ activity: 'running' })
      expect(running.machine?.nextWakeAt).toBeUndefined()

      const completedMachine = stateMachineFixture({
        currentState: 'done',
        terminal: {
          state: 'done',
          status: 'completed',
          reason: 'Reminder sent.',
        },
      })
      await relay(workspaceId, sleeping.sessionId, {
        type: 'complete',
        status: 'completed',
        state: turnStateWithMachine('completed', 'completed', completedMachine),
      })
      expect((await listJobs(workspaceId, { view: 'history' })).jobs[0]).toMatchObject({
        bucket: 'done',
        machine: { outcome: 'completed', activity: 'idle' },
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
        sessionId: sleeping.sessionId,
        archived: true,
      })
      expect((await listJobs(workspaceId, { view: 'history' })).jobs).toEqual([])

      const failed = await createSession(workspaceId, 'Run a failing relay')
      const failedMachine = stateMachineFixture({
        currentState: 'failed',
        terminal: {
          state: 'failed',
          status: 'failed',
          reason: 'Delivery failed.',
        },
      })
      await relay(workspaceId, failed.sessionId, {
        type: 'complete',
        status: 'completed',
        state: turnStateWithMachine('completed', 'completed', failedMachine),
      })
      expect((await listJobs(workspaceId, { view: 'history' })).jobs[0]).toMatchObject({
        id: failed.sessionId,
        machine: { outcome: 'failed' },
      })
    })

    test('paginates and searches the indexed Job projection without gaps', async () => {
      const workspaceId = await createWorkspace('agent-job-pages')
      const jobIds: string[] = []
      for (let index = 0; index < 5; index += 1) {
        const session = await createSessionAt(
          workspaceId,
          index === 2 ? 'Deployment reminder' : `Reminder ${index}`,
          1_000 + index,
        )
        jobIds.push(session.sessionId)
        await relay(
          workspaceId,
          session.sessionId,
          { type: 'state_machine', stateMachine: stateMachineFixture() },
          undefined,
          2_000 + index,
        )
      }
      const ordinary = await createSessionAt(workspaceId, 'Ordinary deployment session', 3_000)
      const deploymentJobId = jobIds[2]!

      // Paging is per bucket by construction: a Convex cursor belongs to one
      // index range. Walk it to exhaustion — "without gaps" means every row in
      // the bucket appears exactly once, in recency order, however the page
      // boundaries happen to fall.
      const paged: string[] = []
      let cursor: string | null | undefined
      for (let pageNumber = 0; pageNumber <= jobIds.length + 1; pageNumber += 1) {
        const page = await listSessions(workspaceId, {
          bucket: 'running',
          limit: 2,
          ...(typeof cursor === 'string' ? { cursor } : {}),
        })
        paged.push(...page.items.map(entry => entry.id))
        cursor = page.nextCursor
        if (cursor === null) break
      }
      expect(cursor).toBeNull()

      // The ordinary session shares the bucket — it is running too. That it is
      // no longer filtered out at the index is the point of the merge.
      expect(paged).toEqual([ordinary.sessionId, ...[...jobIds].reverse()])
      expect(new Set(paged).size).toBe(paged.length)
      expect(
        (await listJobs(workspaceId, { view: 'active', search: 'deployment' })).jobs.map(
          job => job.id,
        ),
      ).toEqual([deploymentJobId])
    })
  })
}
