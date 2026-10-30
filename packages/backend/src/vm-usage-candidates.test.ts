import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = new URL('..', import.meta.url).pathname
const INTERNAL_KEY = 'vm-usage-candidates-internal-key'

type WorkspaceStatus = 'provisioning' | 'active' | 'unhealthy' | 'archived' | 'retired' | 'deleted'

let convex: ConvexDevFixture
let sequence = 0

/**
 * Which VMs the fee meters.
 *
 * This query is the only place the abuse decision lives: a workspace keeps
 * being metered while its status is `unhealthy`, because `markUnhealthyWorkspaces`
 * flips a workspace there when its gateway stops phoning home — and the VM keeps
 * running. Metering only `active`, which is what the sibling VM-size sweep does,
 * would let an abuser buy an exemption from the fee with one `systemctl stop`.
 *
 * The sweep's own test fakes this query out, so without this file that decision
 * has no coverage at all.
 */
async function workspaceWithStatus(status: WorkspaceStatus, withVm = true): Promise<string> {
  sequence += 1
  const owner = await signInWithMagicLink<{ _id: string }>(
    convex,
    uniqueEmail(`vm-candidates-${sequence}`),
    `VM Candidates ${sequence}`,
  )
  const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: `vm-candidates-${sequence}-${Date.now()}`,
    name: `VM Candidates ${sequence}`,
  })) as string
  if (withVm) {
    await mutate(convex, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: Date.now(),
    })
  }
  await mutate(convex, 'testing/workspaces:setWorkspaceStatusForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    status,
  })
  return workspaceId
}

async function candidateIds(): Promise<string[]> {
  const page = (await query(convex, 'testing/vmTelemetry:vmUsageCandidatesForTest', {
    internalKey: INTERNAL_KEY,
    limit: 500,
  })) as { candidates: Array<{ workspaceId: string }> }
  return page.candidates.map(candidate => candidate.workspaceId)
}

describe('which VMs the fee meters', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: 'https://app-staging.duet.so',
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('an unhealthy workspace is still metered, so killing the gateway buys no exemption', async () => {
    // The whole premise of provider-side metering is immunity to VM-side
    // tampering. If stopping the gateway removed the VM from this list, an
    // abuser could keep four cores and pay nothing.
    const unhealthy = await workspaceWithStatus('unhealthy')

    expect(await candidateIds()).toContain(unhealthy)
  })

  test('a provisioning workspace is metered once it has a VM name', async () => {
    // vmAttach records vmName before the workspace goes active; that VM is
    // already consuming pool capacity.
    const provisioning = await workspaceWithStatus('provisioning')

    expect(await candidateIds()).toContain(provisioning)
  })

  test('an active workspace is metered', async () => {
    const active = await workspaceWithStatus('active')

    expect(await candidateIds()).toContain(active)
  })

  describe('a workspace with no live VM is never metered', () => {
    test.each([['archived'], ['retired'], ['deleted']] as const)('%s', async status => {
      const workspaceId = await workspaceWithStatus(status)

      expect(await candidateIds()).not.toContain(workspaceId)
    })

    test('an active workspace that never registered a VM', async () => {
      const noVm = await workspaceWithStatus('active', false)

      expect(await candidateIds()).not.toContain(noVm)
    })
  })

  test('every candidate carries the VM name the writer revalidates against', async () => {
    // The sampler passes this back as expectedVmName so a delayed write cannot
    // attribute a dead VM's usage to its replacement.
    await workspaceWithStatus('active')
    const page = (await query(convex, 'testing/vmTelemetry:vmUsageCandidatesForTest', {
      internalKey: INTERNAL_KEY,
      limit: 500,
    })) as { candidates: Array<{ workspaceId: string; vmName: string }> }

    expect(page.candidates.length).toBeGreaterThan(0)
    expect(page.candidates.every(candidate => candidate.vmName.length > 0)).toBe(true)
  })

  test('rejects a bad internal key and an out-of-range limit', async () => {
    await expect(
      query(convex, 'testing/vmTelemetry:vmUsageCandidatesForTest', { internalKey: 'wrong' }),
    ).rejects.toThrow()
    await expect(
      query(convex, 'testing/vmTelemetry:vmUsageCandidatesForTest', {
        internalKey: INTERNAL_KEY,
        limit: 501,
      }),
    ).rejects.toThrow(/1 to 500/)
  })
})
