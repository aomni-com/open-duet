import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

import { hashApiKey } from '@repo/contract'
import { seedAppRegistrations } from '@repo/seed-drive/manifest'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  settleWorkspaceProvisioning,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'seed-at-birth-internal-key'
const SEED_SHA256 = 'a'.repeat(64)

let convex: ConvexDevFixture
let owner: SignedInUser
let seedStorageId: string
let bootstrapWorkspaceId: string
let explicitWorkspaceId: string
let sequence = 0

describe('workspace seed at birth', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_API_URL: 'http://api.example',
        DUET_APP_URL: 'http://localhost:3000',
        DUET_EDGE_INTERNAL_KEY: 'seed-at-birth-edge-secret',
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_TEST_FAKE_EXE: '1',
        DUET_VM_IMAGE_REF: 'ttl.sh/seed-at-birth:1h',
        DUET_VM_TOKEN_DERIVE_SECRET: 'seed-at-birth-vm-secret',
      },
      reset: true,
    })
    seedStorageId = await uploadSeedArchive('seed archive')
    await mutate(convex, 'testing/seedDrive:recordSeedBundle', {
      internalKey: INTERNAL_KEY,
      sha256: SEED_SHA256,
      storageId: seedStorageId,
    })
    owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('seed-at-birth-owner'),
      'Seed Owner',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('first-user bootstrap pins the current bundle and registers manifest apps', async () => {
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id
    bootstrapWorkspaceId = workspaceId

    await expectSeededWorkspace(workspaceId)
  })

  test('explicit workspace creation uses the same current bundle and manifest', async () => {
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
        plan: 'max',
      },
    )
    const created = (await mutate(convex, 'domains/workspaces/birth:createWorkspace', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      slug: uniqueSlug('seed-explicit'),
      name: 'Explicit Seed',
    })) as { workspaceId: string }
    explicitWorkspaceId = created.workspaceId

    await expectSeededWorkspace(created.workspaceId)
  })

  test('repeated birth seeding retains the workspace original bundle pin', async () => {
    const newerStorageId = await uploadSeedArchive('newer seed archive')
    await mutate(convex, 'testing/seedDrive:recordSeedBundle', {
      internalKey: INTERNAL_KEY,
      sha256: 'b'.repeat(64),
      storageId: newerStorageId,
    })

    await mutate(convex, 'testing/seedDrive:seedWorkspaceAtBirthForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: explicitWorkspaceId,
      actorId: owner.user._id,
      now: 12_000,
    })
    const workspace = (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: explicitWorkspaceId,
    })) as WorkspaceRow

    expect(workspace).toMatchObject({
      birthSeedStorageId: seedStorageId,
      birthSeedSha256: SEED_SHA256,
    })
  })

  test('registration advertises the birth seed once while its authenticated URL stays downloadable', async () => {
    const workspaceId = bootstrapWorkspaceId
    const now = 20_000
    await mutate(convex, 'testing/workspaces:prepareWorkspaceForRegistration', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId,
      slug: uniqueSlug('seed-register'),
      name: 'Seed Registration',
      imageRef: 'ttl.sh/seed-registration:1h',
      provisioningTokenHash: 'seed-provisioning-hash',
      provisioningTokenExpiresAt: now + 60_000,
      now,
    })

    const registered = (await mutate(convex, 'domains/workspaces/provisioning:registerVm', {
      internalKey: INTERNAL_KEY,
      provisioningTokenHash: 'seed-provisioning-hash',
      workspaceHint: workspaceId,
      vmName: 'seed-vm',
      sshDest: 'exedev@seed-vm.exe.xyz',
      httpsUrl: 'https://seed-vm.exe.xyz',
      now: now + 1_000,
    })) as { vmToken: string; restore: { kind: string; url: string; sha256: string } | null }
    const workspace = (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as WorkspaceRow
    const download = (await query(convex, 'domains/workspaces/provisioning:restoreForVm', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      vmTokenHash: await hashApiKey(registered.vmToken),
    })) as { kind: string; url: string; sha256: string }

    expect(registered.restore).toMatchObject({ kind: 'birth-seed', sha256: SEED_SHA256 })
    expect(workspace.birthSeedDeliveredAt).toBe(now + 1_000)
    expect(registered.restore).toEqual(download)
    expect(await (await fetch(download.url)).text()).toBe('seed archive')
  })

  test('reprovision does not advertise an already delivered birth seed again', async () => {
    const now = 30_000
    await mutate(convex, 'testing/workspaces:prepareWorkspaceForRegistration', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: bootstrapWorkspaceId,
      slug: uniqueSlug('seed-reprovision'),
      name: 'Seed Reprovision',
      imageRef: 'ttl.sh/seed-reprovision:1h',
      provisioningTokenHash: 'seed-reprovisioning-hash',
      provisioningTokenExpiresAt: now + 60_000,
      now,
    })

    const registered = (await mutate(convex, 'domains/workspaces/provisioning:registerVm', {
      internalKey: INTERNAL_KEY,
      provisioningTokenHash: 'seed-reprovisioning-hash',
      workspaceHint: bootstrapWorkspaceId,
      vmName: 'reprovisioned-seed-vm',
      sshDest: 'exedev@reprovisioned-seed-vm.exe.xyz',
      httpsUrl: 'https://reprovisioned-seed-vm.exe.xyz',
      now: now + 1_000,
    })) as { vmToken: string; restore: { kind: string; url: string; sha256: string } | null }
    const workspace = (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: bootstrapWorkspaceId,
    })) as WorkspaceRow

    expect(registered.restore).toBeNull()
    expect(workspace.birthSeedDeliveredAt).toBe(21_000)
    await expect(
      query(convex, 'domains/workspaces/provisioning:restoreForVm', {
        internalKey: INTERNAL_KEY,
        workspaceId: bootstrapWorkspaceId,
        vmTokenHash: await hashApiKey(registered.vmToken),
      }),
    ).rejects.toThrow('Restore not found')
  }, 60_000)

  test('a missing pinned archive is not marked delivered when registration cannot advertise it', async () => {
    const missingStorageId = await uploadSeedArchive('soon missing')
    await mutate(convex, 'testing/seedDrive:recordSeedBundle', {
      internalKey: INTERNAL_KEY,
      sha256: 'c'.repeat(64),
      storageId: missingStorageId,
    })
    const created = (await mutate(convex, 'domains/workspaces/birth:createWorkspace', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      slug: uniqueSlug('missing-seed'),
      name: 'Missing Seed Workspace',
    })) as { workspaceId: string }
    await mutate(convex, 'testing/seedDrive:deleteSeedStorageForTest', {
      internalKey: INTERNAL_KEY,
      storageId: missingStorageId,
    })
    const now = 40_000
    // Birth schedules the auto-provision pipeline; prove the actor exists,
    // then settle it so the manual pair below is deterministically unraced.
    expect(
      (
        (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: created.workspaceId,
        })) as { vmAttachRunId?: string }
      ).vmAttachRunId,
    ).toBeDefined()
    await settleWorkspaceProvisioning(convex, {
      internalKey: INTERNAL_KEY,
      workspaceId: created.workspaceId,
    })
    const tokenHash = 'missing-seed-provisioning-hash'
    await mutate(convex, 'testing/workspaces:prepareWorkspaceForRegistration', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: created.workspaceId,
      slug: uniqueSlug('missing-seed-register'),
      name: 'Missing Seed Registration',
      imageRef: 'ttl.sh/missing-seed:1h',
      provisioningTokenHash: tokenHash,
      provisioningTokenExpiresAt: now + 60_000,
      now,
    })
    const registered = (await mutate(convex, 'domains/workspaces/provisioning:registerVm', {
      internalKey: INTERNAL_KEY,
      provisioningTokenHash: tokenHash,
      workspaceHint: created.workspaceId,
      vmName: 'missing-seed-vm',
      sshDest: 'exedev@missing-seed-vm.exe.xyz',
      httpsUrl: 'https://missing-seed-vm.exe.xyz',
      now: now + 1_000,
    })) as { restore: { kind: string; url: string; sha256: string } | null }
    const workspace = (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: created.workspaceId,
    })) as WorkspaceRow

    expect(registered.restore).toBeNull()
    expect(workspace.birthSeedDeliveredAt).toBeUndefined()
  })

  test('workspace creation succeeds seedless when no bundle is current', async () => {
    await mutate(convex, 'testing/seedDrive:clearCurrentSeedBundleForTest', {
      internalKey: INTERNAL_KEY,
    })
    const created = (await mutate(convex, 'domains/workspaces/birth:createWorkspace', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      slug: uniqueSlug('seedless'),
      name: 'Seedless Workspace',
    })) as { workspaceId: string }
    const workspace = (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: created.workspaceId,
    })) as WorkspaceRow
    const apps = (await query(convex, 'testing/apps:rawAppsForTest', {
      internalKey: INTERNAL_KEY,
    })) as AppRow[]

    expect(workspace.birthSeedStorageId).toBeUndefined()
    expect(workspace.birthSeedSha256).toBeUndefined()
    expect(apps.some(app => app.workspaceId === created.workspaceId)).toBe(false)
  })
})

async function expectSeededWorkspace(workspaceId: string): Promise<void> {
  const workspace = (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as WorkspaceRow
  const apps = (await query(convex, 'testing/apps:rawAppsForTest', {
    internalKey: INTERNAL_KEY,
  })) as AppRow[]
  const anchors = (await query(convex, 'testing/anchors:rawAnchorsForTest', {
    internalKey: INTERNAL_KEY,
  })) as AnchorRow[]
  expect(workspace).toMatchObject({
    birthSeedStorageId: seedStorageId,
    birthSeedSha256: SEED_SHA256,
  })
  expect(workspace.birthSeedDeliveredAt).toBeUndefined()
  const workspaceApps = apps.filter(app => app.workspaceId === workspaceId)
  expect(workspaceApps.map(app => app.slug).sort()).toEqual(
    seedAppRegistrations.map(app => app.slug).sort(),
  )
  for (const registration of seedAppRegistrations) {
    const app = workspaceApps.find(app => app.slug === registration.slug)
    expect(app).toMatchObject({
      workspaceId,
      command: registration.command,
      apiScopes: registration.apiScopes,
      slug: registration.slug,
      visibility: 'folder',
      createdByUserId: owner.user._id,
    })
    expect(app!.port).toBeGreaterThan(0)
    expect(anchors.find(anchor => anchor._id === app?.anchorId)).toMatchObject({
      workspaceId,
      path: registration.path,
      kind: 'app',
      state: 'active',
      settings: {},
    })
  }
}

async function uploadSeedArchive(contents: string): Promise<string> {
  const uploadUrl = (await mutate(convex, 'testing/seedDrive:generateSeedBundleUploadUrl', {
    internalKey: INTERNAL_KEY,
  })) as string
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-tar' },
    body: contents,
  })
  expect(response.ok).toBe(true)
  return ((await response.json()) as { storageId: string }).storageId
}

async function listMine(client: ConvexHttpClient): Promise<Array<{ workspace: WorkspaceRow }>> {
  return (await query(client, 'domains/workspaces/queries:listMine', {})) as Array<{
    workspace: WorkspaceRow
  }>
}

function uniqueSlug(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

interface UserRow {
  _id: string
}

interface WorkspaceRow {
  _id: string
  birthSeedStorageId?: string
  birthSeedSha256?: string
  birthSeedDeliveredAt?: number
}

interface AppRow {
  workspaceId: string
  anchorId: string
  command: string
  port: number
  slug: string
  visibility: string
  runtimeStatus: string
  createdByUserId: string
}

interface AnchorRow {
  _id: string
  workspaceId: string
  path: string
  kind: string
  state: string
  settings: Record<string, never>
}
