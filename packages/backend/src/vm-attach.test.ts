import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { convexTest } from 'convex-test'
import { getFunctionName, type FunctionReference } from 'convex/server'

import {
  vmDiskGbForPlan,
  workspaceVmCapsForPlan,
  WORKSPACE_VM_POOL,
  type SubscriptionPlanId,
} from '@repo/contract'
import type { CreateVmOptions, ExeClient, ExeVm } from '@repo/exe'

import type { Id } from '../convex/_generated/dataModel'
import {
  ensureWorkspaceVmImpl,
  workspaceVmName,
  type WorkspaceVmAttachExe,
} from '../convex/domains/workspaces/vmAttach'
import schema from '../convex/schema'

const IMAGE_REF = 'ttl.sh/duet:abc'

describe('ensureWorkspaceVm', () => {
  test('does not create a VM before workspace onboarding completes', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined, onboarded: false })

    await harness.ensure()

    expect(harness.createCalls).toHaveLength(0)
    expect(harness.listCalls).toBe(0)
    expect(harness.row.vmName).toBeUndefined()
  })

  test('creates a trial workspace with its entitled capacity in the reserved pool', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })

    await harness.ensure()

    expect(harness.createCalls[0]).toMatchObject({
      pool: WORKSPACE_VM_POOL,
      ...workspaceVmCapsForPlan('starter'),
    })
  })

  test('creates a paid workspace with the payer plan capacity', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined, plan: 'pro' })

    await harness.ensure()

    expect(harness.createCalls[0]).toMatchObject(workspaceVmCapsForPlan('pro'))
  })

  test('births a never-subscribed trial payer VM with its entitled disk', async () => {
    await expectTierBirth({
      expectedDiskGb: vmDiskGbForPlan('starter'),
    })
  })

  test('births a Starter payer VM with its entitled disk', async () => {
    await expectTierBirth({
      plan: 'starter',
      expectedDiskGb: vmDiskGbForPlan('starter'),
    })
  })

  test('births a Pro payer VM with its entitled disk', async () => {
    await expectTierBirth({
      plan: 'pro',
      expectedDiskGb: vmDiskGbForPlan('pro'),
    })
  })

  test('births a Max payer VM with its entitled disk', async () => {
    await expectTierBirth({
      plan: 'max',
      expectedDiskGb: vmDiskGbForPlan('max'),
    })
  })

  test('attaches one VM to a VM-less workspace and records its identity', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })
    const result = await harness.ensure()

    expect(harness.createCalls).toHaveLength(1)
    expect(result.vmName).toBe(workspaceVmName(harness.workspaceId))
    const token = harness.createCalls[0]!.env!.find(value =>
      value.startsWith('DUET_PROVISIONING_TOKEN='),
    )!.slice('DUET_PROVISIONING_TOKEN='.length)
    expect(harness.row.provisioningTokenHash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(JSON.stringify(harness.row)).not.toContain(token)
    expect(harness.row).toMatchObject({
      imageRef: IMAGE_REF,
      vmName: workspaceVmName(harness.workspaceId),
      sshDest: `exedev@${workspaceVmName(harness.workspaceId)}.exe.xyz`,
      httpsUrl: `https://${workspaceVmName(harness.workspaceId)}.exe.xyz`,
      vmTokenNonce: expect.any(String),
      status: 'provisioning',
    })
  })

  test('uses the configured image for the VM and its reported image version', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })

    await harness.ensure()

    expect(harness.createCalls[0]).toMatchObject({ image: IMAGE_REF })
    expect(harness.createCalls[0]!.env).toContain(`DUET_IMAGE_VERSION=${IMAGE_REF}`)
    expect(harness.row.imageRef).toBe(IMAGE_REF)
  })

  test('implicit replacement does not reuse the previous VM image', async () => {
    const harness = await AttachHarness.create({ imageRef: 'ttl.sh/obsolete-reader:old' })
    await harness.ensure()
    expect(harness.createCalls[0]).toMatchObject({ image: IMAGE_REF })
    expect(harness.row.imageRef).toBe(IMAGE_REF)
  })

  test('an explicit destination remains pinned across retries and environment changes', async () => {
    const harness = await AttachHarness.create({ imageRef: 'ttl.sh/previous:1h' })
    const selected = 'ttl.sh/operator-selected:1h'
    harness.failNextRecord = true
    await expect(harness.ensure({}, selected)).rejects.toThrow('simulated record crash')
    await harness.ensure({ DUET_VM_IMAGE_REF: 'ttl.sh/later-default:1h' }, selected)
    expect(harness.createCalls.map(call => call.image)).toEqual([selected, selected])
    expect(harness.row.imageRef).toBe(selected)
  })

  test('forwards the configured web-app origin to the gateway VM', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })

    await harness.ensure({ DUET_APP_URL: 'https://app-staging.duet.so/' })

    expect(harness.createCalls[0]!.env).toContain('DUET_WEB_APP_ORIGIN=https://app-staging.duet.so')
  })

  test('forwards the fake issuer only when the staging rail configured it', async () => {
    const configured = await AttachHarness.create({ imageRef: undefined })
    await configured.ensure({
      DUET_CONNECT_FAKE_ISSUER_URL: 'https://connected-provider-issuer-staging.duet.so',
    })
    expect(configured.createCalls[0]!.env).toContain(
      'DUET_CONNECT_FAKE_ISSUER_URL=https://connected-provider-issuer-staging.duet.so',
    )

    const absent = await AttachHarness.create({ imageRef: undefined })
    await absent.ensure()
    expect(
      (absent.createCalls[0]!.env ?? []).some(row =>
        row.startsWith('DUET_CONNECT_FAKE_ISSUER_URL='),
      ),
    ).toBe(false)
  })

  test('makes the attached VM HTTP proxy public', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })

    await harness.ensure()

    expect(harness.setPublicCalls).toEqual([workspaceVmName(harness.workspaceId)])
  })

  test('re-asserts the public proxy whenever the attach is re-recorded', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })
    await harness.ensure()
    harness.row.vmTokenNonce = undefined

    await harness.ensure()

    expect(harness.setPublicCalls).toEqual([
      workspaceVmName(harness.workspaceId),
      workspaceVmName(harness.workspaceId),
    ])
  })

  test('rejects missing image configuration before calling exe', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })

    await expect(harness.ensure({ DUET_VM_IMAGE_REF: undefined })).rejects.toThrow(
      'DUET_VM_IMAGE_REF is required',
    )
    expect(harness.createCalls).toHaveLength(0)
    expect(harness.listCalls).toBe(0)
  })

  test('reconciliation keeps the image ref already persisted on the workspace', async () => {
    const persistedImageRef = 'ttl.sh/duet:persisted'
    const harness = await AttachHarness.create({ imageRef: persistedImageRef })
    harness.addExistingVm()

    await harness.ensure({ DUET_VM_IMAGE_REF: 'ttl.sh/duet:changed-env' })

    expect(harness.createCalls).toHaveLength(0)
    expect(harness.row.imageRef).toBe(persistedImageRef)
  })

  test('a second attach for the same workspace does not create another VM', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })

    await harness.ensure()
    await harness.ensure()

    expect(harness.createCalls).toHaveLength(1)
    expect(harness.vms.map(vm => vm.vm_name)).toEqual([workspaceVmName(harness.workspaceId)])
  })

  test('an existing deterministic VM receives its missing VM token nonce once', async () => {
    const harness = await AttachHarness.create({ imageRef: IMAGE_REF })
    harness.addExistingVm()

    await harness.ensure()
    await harness.ensure()

    expect(harness.row.vmTokenNonce).toEqual(expect.any(String))
    expect(harness.setPublicCalls).toEqual([workspaceVmName(harness.workspaceId)])
  })

  test('reattaching an existing VM records its realized capacity, not the desired size', async () => {
    const harness = await AttachHarness.create({ imageRef: IMAGE_REF, diskGb: 28 })
    harness.addExistingVm({ diskCapacityBytes: 58 * 1024 ** 3 })

    await harness.ensure()

    expect(harness.createCalls).toHaveLength(0)
    expect(harness.row.vmDiskGb).toBe(58)
  })

  test('a workspace scoped to a different VM is reattached to the deterministic VM', async () => {
    const harness = await AttachHarness.create({ imageRef: IMAGE_REF })
    harness.addExistingVm()
    Object.assign(harness.row, {
      vmName: 'old-vm-name',
      vmTokenNonce: 'old-nonce',
    })

    await harness.ensure()

    expect(harness.row.vmName).toBe(workspaceVmName(harness.workspaceId))
  })

  test('a retry reconciles the deterministic VM after create succeeds but recording crashes', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })
    harness.failNextRecord = true

    await expect(harness.ensure()).rejects.toThrow('simulated record crash')
    await harness.ensure()

    expect(harness.createCalls).toHaveLength(2)
    expect(harness.removeCalls).toEqual([workspaceVmName(harness.workspaceId)])
    expect(harness.row.vmName).toBe(workspaceVmName(harness.workspaceId))
    expect(harness.statCalls).toEqual([])
  })

  test('removes a VM created while its workspace is deleted before record', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })
    harness.deleteBeforeRecord = true

    await expect(harness.ensure()).rejects.toThrow('Workspace not found')

    expect(harness.removeCalls).toEqual([workspaceVmName(harness.workspaceId)])
    expect(harness.vms).toEqual([])
    // An attach rollback is not the teardown owner: no metering, no fee.
    expect(harness.statCalls).toEqual([])
  })

  test('does not attach when servicing is already paused', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })
    harness.row.servicingStatus = 'paused'

    expect(await harness.ensure()).toMatchObject({ status: 'paused' })
    expect(harness.createCalls).toEqual([])
  })

  test('stops before create when servicing lapses during prepare', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })
    harness.pauseBeforePrepare = true

    expect(await harness.ensure()).toMatchObject({ status: 'paused' })
    expect(harness.createCalls).toEqual([])
  })

  test('removes a just-created VM when servicing lapses before record', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })
    harness.pauseBeforeRecord = true

    expect(await harness.ensure()).toMatchObject({ status: 'paused' })
    expect(harness.removeCalls).toEqual([workspaceVmName(harness.workspaceId)])
    expect(harness.vms).toEqual([])
    expect(harness.statCalls).toEqual([])
  })

  test('an existing VM whose re-record is refused is removed without being metered', async () => {
    const harness = await AttachHarness.create({ imageRef: IMAGE_REF })
    harness.addExistingVm()
    harness.pauseBeforeRecord = true

    expect(await harness.ensure()).toMatchObject({ status: 'paused' })
    expect(harness.createCalls).toHaveLength(0)
    expect(harness.removeCalls).toEqual([workspaceVmName(harness.workspaceId)])
    expect(harness.statCalls).toEqual([])
  })

  test('renaming the workspace slug does not change its VM identity', async () => {
    const harness = await AttachHarness.create({ imageRef: undefined })
    await harness.ensure()
    const attachedVmName = harness.row.vmName

    harness.row.slug = 'renamed-workspace'
    await harness.ensure()

    expect(harness.createCalls).toHaveLength(1)
    expect(harness.row.vmName).toBe(attachedVmName)
  })
})

class AttachHarness {
  readonly createCalls: CreateVmOptions[] = []
  readonly removeCalls: string[] = []
  readonly setPublicCalls: string[] = []
  readonly statCalls: string[] = []
  readonly vms: ExeVm[] = []
  listCalls = 0
  deleteBeforeRecord = false
  failNextRecord = false
  pauseBeforePrepare = false
  pauseBeforeRecord = false
  row!: Record<string, unknown>

  /* `stat` is here only so the rollback tests can prove attach never calls it:
     the three rollback removals below delete VMs that are seconds old and never
     served anyone, and they must never grow a compute fee. */
  readonly exe: WorkspaceVmAttachExe & Pick<ExeClient, 'stat'> = {
    stat: async vmName => {
      this.statCalls.push(vmName)
      return { points: [] }
    },
    list: async () => {
      this.listCalls += 1
      if (this.pauseBeforePrepare) await this.pause()
      return [...this.vms]
    },
    create: async (options = {}) => {
      this.createCalls.push(options)
      const vmName = options.name!
      const vm = {
        vm_name: vmName,
        ssh_dest: `exedev@${vmName}.exe.xyz`,
        https_url: `https://${vmName}.exe.xyz`,
        status: 'running',
      }
      this.vms.push(vm)
      return vm
    },
    remove: async vmName => {
      this.removeCalls.push(vmName)
      const index = this.vms.findIndex(vm => vm.vm_name === vmName)
      if (index >= 0) this.vms.splice(index, 1)
    },
    setSharePublic: async vmName => {
      this.setPublicCalls.push(vmName)
      if (this.pauseBeforeRecord) await this.pause()
      if (this.deleteBeforeRecord) await this.t.run(ctx => ctx.db.delete(this.workspaceId))
    },
  }

  private readonly t = convexTest(schema, {
    './_generated/api.ts': async () => ({}),
    './domains/workspaces/vmAttachModel.ts': () =>
      import('../convex/domains/workspaces/vmAttachModel'),
  })
  workspaceId!: Id<'workspaces'>
  private constructor() {}

  static async create(seed: {
    imageRef?: string
    diskGb?: number
    plan?: SubscriptionPlanId
    onboarded?: boolean
  }) {
    const harness = new AttachHarness()
    await harness.t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'vm-attach@example.com',
        createdAt: 1,
        updatedAt: 1,
        memberDirectoryRevision: 0,
        monthlyCreditBalanceMicroUsd: 0,
        paidCreditBalanceMicroUsd: 0,
        billing: seed.plan
          ? {
              firstPaidAt: 1,
              subscriptionEverActivatedAt: 1,
              subscription: {
                plan: seed.plan,
                status: 'active',
                stripeSubscriptionId: 'sub_fixture',
                stripePriceId: 'price_fixture',
                currentPeriodStart: 1,
                currentPeriodEnd: Date.now() + 100_000,
                latestLifecycleEventCreatedAt: 1,
                latestLifecycleEventId: 'evt_fixture',
                cancelAtPeriodEnd: false,
              },
            }
          : { trialExpiresAt: 100_000 },
      })
      harness.workspaceId = await ctx.db.insert('workspaces', {
        billingUserId: userId,
        createdByUserId: userId,
        slug: 'renameable-slug',
        name: 'VM attach fixture',
        status: 'provisioning',
        createdAt: 1,
        imageRef: seed.imageRef,
        vmDiskGb: seed.diskGb,
        ...(seed.onboarded === false ? {} : { onboardedAt: 1 }),
      })
      harness.row = (await ctx.db.get(harness.workspaceId))!
    })
    return harness
  }

  private async pause() {
    await this.t.run(ctx => ctx.db.patch(this.workspaceId, { servicingStatus: 'paused' }))
  }

  readonly ctx = {
    runQuery: async (ref: FunctionReference<'query'>, args: Record<string, unknown>) => {
      return await this.t.query(ref, args)
    },
    runMutation: async (ref: FunctionReference<'mutation'>, args: Record<string, unknown>) => {
      if (
        getFunctionName(ref) === 'domains/workspaces/vmAttachModel:recordWorkspaceVmAttach' &&
        this.failNextRecord
      ) {
        this.failNextRecord = false
        throw new Error('simulated record crash')
      }
      return await this.t.mutation(ref, args)
    },
  }

  addExistingVm(overrides: { diskCapacityBytes?: number } = {}): void {
    const vmName = workspaceVmName(this.workspaceId)
    this.vms.push({
      vm_name: vmName,
      ssh_dest: `exedev@${vmName}.exe.xyz`,
      https_url: `https://${vmName}.exe.xyz`,
      status: 'running',
      disk_capacity_bytes: overrides.diskCapacityBytes,
    })
  }

  async ensure(env: NodeJS.ProcessEnv = {}, imageRef?: string) {
    const { _id, _creationTime, ...fields } = this.row
    await this.t.run(ctx => ctx.db.patch(this.workspaceId, fields))
    try {
      return await ensureWorkspaceVmImpl(this.ctx, {
        workspaceId: this.workspaceId,
        imageRef,
        exe: this.exe,
        env: {
          DUET_API_URL: 'https://api.example',
          DUET_VM_IMAGE_REF: IMAGE_REF,
          DUET_API_INTERNAL_KEY: 'test-internal-key',
          ...env,
        },
        now: 10_000,
      })
    } finally {
      this.row = (await this.t.run(ctx => ctx.db.get(this.workspaceId))) ?? this.row
    }
  }
}

async function expectTierBirth(args: {
  plan?: SubscriptionPlanId
  expectedDiskGb: number
}): Promise<void> {
  const harness = await AttachHarness.create({
    imageRef: undefined,
    plan: args.plan,
  })

  await harness.ensure()

  expect(harness.createCalls[0]).toMatchObject({ disk: `${args.expectedDiskGb}GB` })
  expect(harness.row.vmDiskGb).toBe(args.expectedDiskGb)
}
