import { expect, test } from 'bun:test'

import {
  reprovisionFleet,
  selectFleetCandidates,
  type FleetBackend,
  type FleetWorkspace,
} from './reprovision-fleet'

const TARGET = `ghcr.io/aomni-com/duet-vm-image@sha256:${'a'.repeat(64)}`

test('fleet reprovision selects every attached live VM not already on the target image', () => {
  const rows: FleetWorkspace[] = [
    workspace('active-old', 'active', 'vm-active', 'old-image'),
    workspace('unhealthy-old', 'unhealthy', 'vm-unhealthy', 'old-image'),
    workspace('already-current', 'active', 'vm-current', TARGET),
    workspace('still-provisioning', 'provisioning', undefined, TARGET),
    workspace('archived', 'archived', undefined, 'old-image'),
    workspace('deleted', 'deleted', undefined, 'old-image'),
  ]

  expect(selectFleetCandidates(rows, TARGET).map(row => row.slug)).toEqual([
    'active-old',
    'unhealthy-old',
  ])
})

test('fleet reprovision accepts the deterministic VM name after the target image becomes active', async () => {
  let rows = [
    workspace('first', 'active', 'old-first', 'old-image'),
    workspace('second', 'active', 'old-second', 'old-image'),
  ]
  const started: string[] = []
  const backend: FleetBackend = {
    backup: async () => null,
    list: async () => rows,
    reprovision: async ({ workspaceId, imageRef }) => {
      const row = rows.find(candidate => candidate.workspaceId === workspaceId)!
      started.push(row.slug)
      rows = rows.map(candidate =>
        candidate.workspaceId === workspaceId
          ? { ...candidate, status: 'active', imageRef }
          : candidate,
      )
      return { status: 'provisioning' }
    },
  }

  const result = await reprovisionFleet(backend, {
    targetImageRef: TARGET,
    concurrency: 2,
    timeoutMs: 10,
    pollIntervalMs: 0,
    ...controlledClock(),
  })

  expect(started.sort()).toEqual(['first', 'second'])
  expect(result.completed.map(row => row.slug).sort()).toEqual(['first', 'second'])
  expect(result.completed.every(row => row.imageRef === TARGET)).toBe(true)
})

test('fleet reprovision retries an active-work deferral instead of skipping that VM', async () => {
  let row = workspace('busy', 'active', 'old-busy', 'old-image')
  let attempts = 0
  const backend: FleetBackend = {
    backup: async () => null,
    list: async () => [row],
    reprovision: async ({ imageRef }) => {
      attempts += 1
      if (attempts === 1) {
        return {
          status: 'deferred',
          reason: 'active_workspace_work',
          activeAgentSessions: 1,
          activeTrainJobs: 0,
        }
      }
      row = { ...row, status: 'active', vmName: 'new-busy', imageRef }
      return { status: 'provisioning' }
    },
  }

  const result = await reprovisionFleet(backend, {
    targetImageRef: TARGET,
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    ...controlledClock(),
  })

  expect(attempts).toBe(2)
  expect(result.completed.map(candidate => candidate.vmName)).toEqual(['new-busy'])
})

test('fleet reprovision forwards an explicit state-discard request', async () => {
  let row = workspace('disposable', 'active', 'old-disposable', 'old-image')
  let receivedDiscardState: boolean | undefined
  const backend: FleetBackend = {
    backup: async () => null,
    list: async () => [row],
    reprovision: async ({ imageRef, discardState }) => {
      receivedDiscardState = discardState
      row = { ...row, status: 'active', imageRef }
      return { status: 'provisioning' }
    },
  }

  await reprovisionFleet(backend, {
    targetImageRef: TARGET,
    discardState: true,
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    ...controlledClock(),
  })

  expect(receivedDiscardState).toBe(true)
})

test('fleet reprovision finishes independent workspaces before reporting failures', async () => {
  let rows = [
    workspace('broken', 'active', 'old-broken', 'old-image'),
    workspace('healthy', 'active', 'old-healthy', 'old-image'),
  ]
  const backend: FleetBackend = {
    backup: async () => null,
    list: async () => rows,
    reprovision: async ({ workspaceId, imageRef }) => {
      const row = rows.find(candidate => candidate.workspaceId === workspaceId)!
      if (row.slug === 'broken') throw new Error('provider rejected broken')
      rows = rows.map(candidate =>
        candidate.workspaceId === workspaceId
          ? { ...candidate, status: 'active', vmName: 'new-healthy', imageRef }
          : candidate,
      )
      return { status: 'provisioning' }
    },
  }

  await expect(
    reprovisionFleet(backend, {
      targetImageRef: TARGET,
      concurrency: 1,
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      ...controlledClock(),
    }),
  ).rejects.toThrow('broken: provider rejected broken')
  expect(rows.find(row => row.slug === 'healthy')?.vmName).toBe('new-healthy')
})

function workspace(
  slug: string,
  status: FleetWorkspace['status'],
  vmName: string | undefined,
  imageRef: string | undefined,
): FleetWorkspace {
  return { workspaceId: `id-${slug}`, slug, status, vmName, imageRef }
}

test('fleet follows one admitted backup and reports its failure without creating another job', async () => {
  const row = workspace('capture-fails', 'active', 'original-vm', 'old-image')
  let admissions = 0
  let polls = 0
  const backend = {
    list: async () => [row],
    reprovision: async () => {
      admissions++
      return { status: 'backup_pending' as const, backupId: 'backup-fails' }
    },
    backup: async () => {
      polls++
      return polls === 1
        ? { status: 'running' as const, lifecycle: { status: 'capturing' as const } }
        : {
            status: 'failed' as const,
            error: { message: 'Upload interrupted' },
            lifecycle: { status: 'failed' as const, reason: 'backup_failed' },
          }
    },
  }
  await expect(
    reprovisionFleet(backend, {
      targetImageRef: TARGET,
      timeoutMs: 100,
      pollIntervalMs: 0,
      ...controlledClock(),
    }),
  ).rejects.toThrow('capture-fails: backup backup-fails failed: Upload interrupted')
  expect(admissions).toBe(1)
  expect(row.vmName).toBe('original-vm')
})

test('fleet waits for restore acknowledgement even after the new VM registers on the target image', async () => {
  let row = workspace('restoring', 'active', 'original-vm', 'old-image')
  let stage: 'capturing' | 'restoring' | 'complete' = 'capturing'
  let clock = 0
  let admissions = 0
  const backend: FleetBackend = {
    list: async () => [row],
    reprovision: async () => {
      admissions++
      return { status: 'backup_pending', backupId: 'backup-ready' }
    },
    backup: async () => ({
      status: stage === 'capturing' ? 'running' : 'ready',
      completeness: 'complete',
      lifecycle: { status: stage },
    }),
  }
  const result = await reprovisionFleet(backend, {
    targetImageRef: TARGET,
    timeoutMs: 1000,
    pollIntervalMs: 0,
    now: () => clock,
    sleep: async () => {
      clock += 1
      if (stage === 'capturing') {
        stage = 'restoring'
        row = { ...row, imageRef: TARGET, vmName: 'replacement-vm' }
      } else stage = 'complete'
    },
  })
  expect(String(stage)).toBe('complete')
  expect(result.completed[0]?.vmName).toBe('replacement-vm')
  expect(admissions).toBe(1)
})

test('fleet times out one stalled backup without creating replacement jobs', async () => {
  let clock = 0
  let admissions = 0
  let polls = 0
  const backend: FleetBackend = {
    list: async () => [workspace('stalled', 'active', 'original', 'old-image')],
    reprovision: async () => {
      admissions++
      return { status: 'backup_pending', backupId: 'stalled-backup' }
    },
    backup: async () => {
      polls++
      return { status: 'running', lifecycle: { status: 'capturing' } }
    },
  }
  await expect(
    reprovisionFleet(backend, {
      targetImageRef: TARGET,
      timeoutMs: 20,
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async milliseconds => {
        clock += milliseconds
      },
    }),
  ).rejects.toThrow('stalled: timed out waiting for the target image (backup stalled-backup)')
  expect(admissions).toBe(1)
  expect(polls).toBe(2)
})

test('fleet polling failures retain the admitted workspace and backup identity', async () => {
  const backend: FleetBackend = {
    list: async () => [workspace('poll-fails', 'active', 'original', 'old-image')],
    reprovision: async () => ({ status: 'backup_pending', backupId: 'lookup-backup' }),
    backup: async () => {
      throw new Error('Convex command timed out')
    },
  }
  await expect(
    reprovisionFleet(backend, {
      targetImageRef: TARGET,
      timeoutMs: 1000,
      pollIntervalMs: 0,
      ...controlledClock(),
    }),
  ).rejects.toThrow('poll-fails: backup lookup-backup status unavailable: Convex command timed out')
})

function controlledClock() {
  let clock = 0
  return {
    now: () => clock,
    sleep: async (milliseconds: number) => {
      clock += Math.max(1, milliseconds)
    },
  }
}
