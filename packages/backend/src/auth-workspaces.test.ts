import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'
import { ConvexError } from 'convex/values'

import { WorkspaceMemberAdmissionRefusalSchema, type SubscriptionPlanId } from '@repo/contract'
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

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'auth-workspaces-internal-key'

let convex: ConvexDevFixture
let sequence = 0

describe('auth workspaces', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        AUTH_GOOGLE_ID: 'test-google-client-id',
        AUTH_GOOGLE_SECRET: 'test-google-client-secret',
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: 'https://app-staging.duet.so',
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('magic-link verification needs only the high-entropy one-time code', async () => {
    const email = uniqueEmail('code-only')
    await convex.action('auth:signIn', {
      provider: 'email',
      params: { email, name: 'Code Only' },
    })

    const result = (await convex.action('auth:signIn', {
      params: { code: TEST_AUTH_CODE },
    })) as { tokens?: { token: string; refreshToken: string } | null }

    expect(result.tokens?.token).toBeString()
    expect(result.tokens?.refreshToken).toBeString()
    const replay = (await convex.action('auth:signIn', {
      params: { code: TEST_AUTH_CODE },
    })) as { tokens?: { token: string; refreshToken: string } | null }
    expect(replay.tokens).toBeNull()
  })

  test('shared staging auth accepts a magic-link callback to localhost', async () => {
    const result = await convex.action('auth:signIn', {
      provider: 'email',
      params: {
        email: uniqueEmail('localhost-callback'),
        redirectTo: 'http://localhost:3000/auth/magic-link/callback?intent=local-browser',
      },
    })

    expect(result).toEqual({ started: true })
    await convex.action('auth:signIn', { params: { code: TEST_AUTH_CODE } })
  })

  test('shared staging auth accepts the Google return destination on localhost', async () => {
    const redirectTo = 'http://localhost:3000/sign-in?returnTo=%2Fw%2Facme'
    const result = (await convex.action('auth:signIn', {
      provider: 'google',
      params: {
        redirectTo,
      },
    })) as { redirect?: string; verifier?: string }

    expect(result.verifier).toBeString()
    expect(result.redirect).toBeString()
    if (result.verifier === undefined || result.redirect === undefined) {
      throw new Error('Google sign-in did not return redirect metadata')
    }
    const start = new URL(result.redirect)
    expect(start.pathname).toBe('/api/auth/signin/google')
    expect(start.searchParams.get('code')).toBe(result.verifier)
    expect(start.searchParams.get('redirectTo')).toBe(redirectTo)
  })

  test('shared staging auth rejects a magic-link callback to an untrusted origin', async () => {
    await expect(
      convex.action('auth:signIn', {
        provider: 'email',
        params: {
          email: uniqueEmail('untrusted-callback'),
          redirectTo: 'https://attacker.example/auth/magic-link/callback',
        },
      }),
    ).rejects.toThrow('Invalid auth redirect destination')
    await convex.action('auth:signIn', { params: { code: TEST_AUTH_CODE } })
  })

  test('shared staging auth rejects non-callback paths on localhost', async () => {
    await expect(
      convex.action('auth:signIn', {
        provider: 'email',
        params: {
          email: uniqueEmail('localhost-non-callback'),
          redirectTo: 'http://localhost:3000/sign-out?code=secret',
        },
      }),
    ).rejects.toThrow('Invalid auth redirect destination')
    await convex.action('auth:signIn', { params: { code: TEST_AUTH_CODE } })
  })

  test('magic-link and Google identities create or link users and create one first workspace', async () => {
    const email = uniqueEmail('link')
    const magic = await signInWithMagicLink<UserRow>(convex, email, 'Link Person')
    const magicUser = await currentUser(magic.client)
    const firstWorkspaces = await listMine(magic.client)

    expect(magicUser.email).toBe(email)
    expect(firstWorkspaces).toHaveLength(1)
    expect(firstWorkspaces[0]?.role).toBe('owner')
    expect(firstWorkspaces[0]?.workspace.name).toBe(`${email.split('@')[0]}'s Workspace`)
    expect(firstWorkspaces[0]?.workspace.status).toBe('provisioning')
    expect(await auditEvents(magic.client, firstWorkspaces[0]!.workspace._id)).toContainEqual(
      expect.objectContaining({
        event: 'workspace.created',
        actorId: magicUser._id,
        provenance: { source: 'workspace_birth' },
      }),
    )
    expect(
      (await auditEvents(magic.client, firstWorkspaces[0]!.workspace._id)).filter(
        event => event.event === 'workspace.vm_attach_scheduled',
      ),
    ).toHaveLength(0)

    const repeatedMagic = await signInWithMagicLink<UserRow>(
      convex,
      email.toUpperCase(),
      'Link Person Updated',
    )
    expect((await currentUser(repeatedMagic.client))._id).toBe(magicUser._id)
    expect(await listMine(repeatedMagic.client)).toHaveLength(1)

    const googleAccountId = `google-${email}`
    const google = await signInWithTestGoogle({
      providerAccountId: googleAccountId,
      email,
      name: 'Google Link',
    })
    expect((await currentUser(google.client))._id).toBe(magicUser._id)
    expect(await listMine(google.client)).toHaveLength(1)

    const repeatedGoogle = await signInWithTestGoogle({
      providerAccountId: googleAccountId,
      email,
      name: 'Google Link Again',
    })
    expect((await currentUser(repeatedGoogle.client))._id).toBe(magicUser._id)
    expect(await listMine(repeatedGoogle.client)).toHaveLength(1)

    await expect(
      signInWithTestGoogle({
        providerAccountId: `${googleAccountId}-unverified`,
        email,
        name: 'Unverified Link',
        emailVerified: false,
      }),
    ).rejects.toThrow('Cannot link unverified email to an existing user')
  })

  test('internal-key staging fixtures activate a subscription by email and delete through workspace teardown scheduling', async () => {
    const email = uniqueEmail('staging-fixture')
    const owner = await signInWithMagicLink<UserRow>(convex, email, 'Staging Fixture')
    const workspace = (await listMine(owner.client))[0]!.workspace
    const firstPaidAt = Date.now() - 1_000

    await convex.mutation('testing/workspaces:activateSyntheticSubscriptionByEmailForTest', {
      internalKey: INTERNAL_KEY,
      email: email.toUpperCase(),
      now: firstPaidAt,
    })
    const rawUser = (await convex.query('testing/workspaces:rawUserByEmailForTest', {
      internalKey: INTERNAL_KEY,
      email,
    })) as { billing?: { firstPaidAt?: number } }
    expect(rawUser.billing?.firstPaidAt).toBe(firstPaidAt)
    expect(
      await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace._id,
      }),
    ).toMatchObject({ _id: workspace._id, slug: workspace.slug })
    expect(
      await convex.query('testing/workspaces:newestNonDeletedWorkspaceBySlugForTest', {
        internalKey: INTERNAL_KEY,
        slug: workspace.slug,
      }),
    ).toMatchObject({ _id: workspace._id })

    await convex.mutation('testing/workspaces:deleteWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now: firstPaidAt,
    })
    const rows = (await convex.query('testing/workspaces:rawWorkspacesForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ _id: string; status: string; vmTeardownRunId?: string }>
    expect(rows.find(row => row._id === workspace._id)).toMatchObject({
      status: 'deleted',
      vmTeardownRunId: expect.any(String),
    })
    expect(
      await convex.query('testing/workspaces:newestNonDeletedWorkspaceBySlugForTest', {
        internalKey: INTERNAL_KEY,
        slug: workspace.slug,
      }),
    ).toBeNull()
  })

  test('workspace role matrix keeps non-owners from administrative mutations', async () => {
    const owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('owner'), 'Owner User')
    const editor = await signInWithMagicLink<UserRow>(convex, uniqueEmail('editor'), 'Editor User')
    const viewer = await signInWithMagicLink<UserRow>(convex, uniqueEmail('viewer'), 'Viewer User')
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id

    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: editor.user._id,
      role: 'editor',
    })
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: viewer.user._id,
      role: 'viewer',
    })

    await expect(
      mutate(editor.client, 'domains/workspaces/mutations:deleteWorkspace', { workspaceId }),
    ).rejects.toThrow('Requires owner access')

    await mutate(owner.client, 'domains/workspaces/mutations:deleteWorkspace', { workspaceId })
  })

  test('deleted workspaces reject member mutations while delete replay and audit reads remain valid', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('deleted-liveness'),
      'Deleted Liveness Owner',
    )
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id
    await mutate(owner.client, 'domains/workspaces/mutations:deleteWorkspace', { workspaceId })

    await expect(
      mutate(owner.client, 'domains/workspaces/mutations:rename', {
        workspaceId,
        slug: uniqueSlug('deleted-rename'),
        name: 'Must Stay Deleted',
        publicUrlBreakAcknowledged: true,
      }),
    ).rejects.toThrow('Workspace not found')

    await mutate(owner.client, 'domains/workspaces/mutations:deleteWorkspace', { workspaceId })
    expect(await auditEvents(owner.client, workspaceId)).toContainEqual(
      expect.objectContaining({ event: 'workspace.deleted', actorId: owner.user._id }),
    )
  })

  test('the testing birth seam persists one provisioning row, owner membership, and attributed audit', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('birth-owner'),
      'Birth Owner',
    )
    await activateSyntheticSubscription(owner.client)
    const slug = uniqueSlug('birth')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: ' Birth Workspace ',
    })) as string

    const matchingRows = (
      (await query(convex, 'testing/workspaces:rawWorkspacesForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<WorkspaceRow['workspace'] & { createdByUserId?: string }>
    ).filter(workspace => workspace._id === workspaceId)
    expect(matchingRows).toEqual([
      expect.objectContaining({
        _id: workspaceId,
        slug,
        name: 'Birth Workspace',
        status: 'provisioning',
        createdByUserId: owner.user._id,
        billingUserId: owner.user._id,
      }),
    ])

    const members = (await query(convex, 'testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ workspaceId: string; userId: string; role: string }>
    expect(members).toEqual([
      expect.objectContaining({ workspaceId, userId: owner.user._id, role: 'owner' }),
    ])
    expect(await auditEvents(owner.client, workspaceId)).toEqual([
      expect.objectContaining({
        event: 'workspace.created',
        actorId: owner.user._id,
        provenance: { source: 'workspace_birth' },
      }),
    ])
  })

  test('member directory writers preserve page order, complete search, rename, and rejoin generations', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('directory-owner'),
      'Directory Owner',
    )
    await activateSyntheticSubscription(owner.client)
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: uniqueSlug('directory'),
      name: 'Directory Workspace',
    })) as string
    const zoe = await signInWithMagicLink<UserRow>(convex, uniqueEmail('directory-zoe'), 'Zoe Last')
    const mia = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('directory-mia'),
      'Mia Middle',
    )
    for (const user of [zoe, mia]) {
      await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        userId: user.user._id,
        role: 'viewer',
      })
    }
    await mutate(convex, 'domains/users/api:updateProfile', {
      internalKey: INTERNAL_KEY,
      actorId: zoe.user._id,
      firstName: 'Zoe',
      lastName: 'Last',
      now: Date.now(),
    })
    await waitForMemberDirectoryRefresh(zoe.user._id, 'Zoe Last')
    await mutate(convex, 'domains/users/api:updateProfile', {
      internalKey: INTERNAL_KEY,
      actorId: mia.user._id,
      firstName: 'Mia',
      lastName: 'Middle',
      now: Date.now(),
    })
    await waitForMemberDirectoryRefresh(mia.user._id, 'Mia Middle')

    const first = (await query(convex, 'domains/workspaces/queries:listMembersPage', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      paginationOpts: { numItems: 2, cursor: null },
    })) as { page: Array<{ id: string }>; continueCursor: string; isDone: boolean }
    expect(first.page.map(member => member.id)).toEqual([owner.user._id, mia.user._id])
    expect(first.isDone).toBe(false)
    const second = (await query(convex, 'domains/workspaces/queries:listMembersPage', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    })) as { page: Array<{ id: string }> }
    expect(second.page.map(member => member.id)).toEqual([zoe.user._id])

    const search = (await query(convex, 'domains/workspaces/queries:listMembersPage', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      search: zoe.user.email.slice(0, 12),
      paginationOpts: { numItems: 1, cursor: null },
    })) as { page: Array<{ id: string }> }
    expect(search.page.map(member => member.id)).toEqual([zoe.user._id])

    const tokenSearch = (await query(convex, 'domains/workspaces/queries:listMembersPage', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      search: 'middle',
      paginationOpts: { numItems: 1, cursor: null },
    })) as { page: Array<{ id: string }> }
    expect(tokenSearch.page.map(member => member.id)).toEqual([mia.user._id])

    await mutate(convex, 'domains/users/api:updateProfile', {
      internalKey: INTERNAL_KEY,
      actorId: zoe.user._id,
      firstName: 'Aaron',
      lastName: 'First',
      now: Date.now(),
    })
    await waitForMemberDirectoryRefresh(zoe.user._id, 'Aaron First')
    const renamed = (await query(convex, 'domains/workspaces/queries:listMembersPage', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      paginationOpts: { numItems: 3, cursor: null },
    })) as { page: Array<{ id: string; name?: string }> }
    expect(renamed.page.map(member => member.name)).toEqual([
      undefined,
      'Aaron First',
      'Mia Middle',
    ])
    expect(renamed.page[1]?.name).toBe('Aaron First')

    const before = (await query(convex, 'testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; userId: string }>
    const oldGeneration = before.find(member => member.userId === zoe.user._id)!._id
    await mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
      workspaceId,
      userId: zoe.user._id,
    })
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: zoe.user._id,
      role: 'viewer',
    })
    const directory = (await query(convex, 'testing/workspaces:workspaceMemberDirectoryForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ membershipId: string; userId: string }>
    const rejoined = directory.filter(member => member.userId === zoe.user._id)
    expect(rejoined).toHaveLength(1)
    expect(rejoined[0]?.membershipId).not.toBe(oldGeneration)
  })

  test('profile updates succeed and converge beyond 100 workspace memberships', async () => {
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('directory-large-fanout'),
      'Large Fanout',
    )
    await mutate(convex, 'testing/workspaces:seedMemberDirectoryMembershipsForTest', {
      internalKey: INTERNAL_KEY,
      userId: member.user._id,
      count: 101,
      now: Date.now(),
    })

    const profile = (await mutate(convex, 'domains/users/api:updateProfile', {
      internalKey: INTERNAL_KEY,
      actorId: member.user._id,
      firstName: 'Newest',
      lastName: 'Identity',
      now: Date.now(),
    })) as { name?: string }
    expect(profile.name).toBe('Newest Identity')
    await waitForMemberDirectoryRefresh(member.user._id, 'Newest Identity')

    const directory = (await query(convex, 'testing/workspaces:userMemberDirectoryForTest', {
      internalKey: INTERNAL_KEY,
      userId: member.user._id,
    })) as Array<{ name?: string }>
    expect(directory.length).toBeGreaterThan(100)
    expect(new Set(directory.map(row => row.name))).toEqual(new Set(['Newest Identity']))
  })

  test('workspace birth enforces the Starter, Pro and Max creation boundaries', async () => {
    for (const [plan, limit] of [
      ['starter', 1],
      ['pro', 3],
      ['max', 10],
    ] as const) {
      const payer = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail(`cap-${plan}`),
        `Cap ${plan}`,
      )
      await activateSyntheticSubscription(payer.client, undefined, plan)
      const initialWorkspace = (await listMine(payer.client))[0]!.workspace
      if (plan === 'starter') {
        await mutate(payer.client, 'domains/workspaces/mutations:deleteWorkspace', {
          workspaceId: initialWorkspace._id,
        })
      }
      const existing = plan === 'starter' ? 0 : 1
      for (let index = existing; index < limit; index += 1) {
        await mutate(payer.client, 'testing/workspaces:createWorkspaceForTest', {
          internalKey: INTERNAL_KEY,
          slug: uniqueSlug(`cap-${plan}-allowed`),
          name: `${plan} workspace ${index + 1}`,
          bypassWorkspaceLimit: false,
        })
      }
      await expect(
        mutate(payer.client, 'testing/workspaces:createWorkspaceForTest', {
          internalKey: INTERNAL_KEY,
          slug: uniqueSlug(`cap-${plan}-refused`),
          name: `${plan} over capacity`,
          bypassWorkspaceLimit: false,
        }),
      ).rejects.toThrow(/workspace_limit_reached/)
    }
  })

  test('creation counts every membership regardless of payer and leaving releases capacity', async () => {
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('membership-cap'),
      'Member',
    )
    const host = await signInWithMagicLink<UserRow>(convex, uniqueEmail('membership-host'), 'Host')
    await activateSyntheticSubscription(member.client, undefined, 'pro')
    const joined: string[] = []
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      const workspaceId = (await mutate(host.client, 'testing/workspaces:createWorkspaceForTest', {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug(`joined-${role}`),
        name: `Joined as ${role}`,
      })) as string
      await mutate(host.client, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        userId: member.user._id,
        role,
      })
      joined.push(workspaceId)
    }
    const create = () =>
      mutate(member.client, 'testing/workspaces:createWorkspaceForTest', {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('membership-cap-create'),
        name: 'Created workspace',
        bypassWorkspaceLimit: false,
      })
    await expect(create()).rejects.toThrow(/workspace_limit_reached/)
    for (const workspaceId of joined.slice(0, 2)) {
      await mutate(host.client, 'domains/workspaces/mutations:removeMember', {
        workspaceId,
        userId: member.user._id,
      })
    }
    const createdId = (await create()) as string
    expect((await listMine(member.client)).map(row => row.workspace._id)).toContain(createdId)
  })

  test('deleted and retired workspaces release creation capacity while archived workspaces do not', async () => {
    for (const status of ['deleted', 'retired', 'archived'] as const) {
      const payer = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail(`cap-${status}`),
        `Cap ${status}`,
      )
      const firstWorkspaceId = (await listMine(payer.client))[0]!.workspace._id
      await mutate(payer.client, 'testing/workspaces:setWorkspaceStatusForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: firstWorkspaceId,
        status,
      })
      const create = mutate(payer.client, 'testing/workspaces:createWorkspaceForTest', {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug(`cap-after-${status}`),
        name: `Workspace after ${status}`,
        bypassWorkspaceLimit: false,
      })
      if (status === 'archived') {
        await expect(create).rejects.toThrow(/workspace_limit_reached/)
      } else {
        expect(await create).toBeString()
      }
    }
  })

  test('the audited system-workspace bypass skips the creation capacity gate', async () => {
    const payer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('cap-bypass'),
      'Cap Bypass',
    )
    expect(
      await mutate(payer.client, 'testing/workspaces:createWorkspaceForTest', {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('cap-bypass-created'),
        name: 'Bypassed Workspace',
        bypassWorkspaceLimit: true,
      }),
    ).toBeString()
  })

  test('a downgrade gates only new workspace creation for an existing over-limit member', async () => {
    const payer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('cap-downgrade'),
      'Cap Downgrade',
    )
    await activateSyntheticSubscription(payer.client, undefined, 'pro')
    for (let index = 1; index < 3; index += 1) {
      await mutate(payer.client, 'testing/workspaces:createWorkspaceForTest', {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('cap-downgrade-existing'),
        name: `Existing workspace ${index + 1}`,
        bypassWorkspaceLimit: false,
      })
    }
    await mutate(payer.client, 'testing/workspaces:lapseCurrentUserSyntheticSubscriptionForTest', {
      internalKey: INTERNAL_KEY,
    })
    const existing = (await listMine(payer.client))[0]!.workspace
    const renamedSlug = uniqueSlug('cap-downgrade-renamed')
    await mutate(payer.client, 'domains/workspaces/mutations:rename', {
      workspaceId: existing._id,
      slug: renamedSlug,
      publicUrlBreakAcknowledged: true,
    })
    expect(
      (await listMine(payer.client)).find(row => row.workspace._id === existing._id)?.workspace
        .slug,
    ).toBe(renamedSlug)
    await expect(
      mutate(payer.client, 'testing/workspaces:createWorkspaceForTest', {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('cap-downgrade-refused'),
        name: 'New workspace after downgrade',
        bypassWorkspaceLimit: false,
      }),
    ).rejects.toThrow(/workspace_limit_reached/)
  })

  test('concurrent creates cannot both take the final creation slot', async () => {
    const payer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('cap-concurrent'),
      'Cap Concurrent',
    )
    await activateSyntheticSubscription(payer.client, undefined, 'pro')
    await mutate(payer.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: uniqueSlug('cap-concurrent-seed'),
      name: 'Second workspace',
      bypassWorkspaceLimit: false,
    })

    const results = await Promise.allSettled([
      mutate(payer.client, 'testing/workspaces:createWorkspaceForTest', {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('cap-concurrent-a'),
        name: 'Boundary workspace A',
        bypassWorkspaceLimit: false,
      }),
      mutate(payer.client, 'testing/workspaces:createWorkspaceForTest', {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('cap-concurrent-b'),
        name: 'Boundary workspace B',
        bypassWorkspaceLimit: false,
      }),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejection = results.find(result => result.status === 'rejected')
    expect(rejection?.reason).toBeInstanceOf(Error)
    expect(String(rejection?.reason)).toContain('workspace_limit_reached')
  })

  test('workspace create and rename reject reserved slugs and collisions', async () => {
    const owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('slug'), 'Slug Owner')
    await activateSyntheticSubscription(owner.client)
    const firstSlug = uniqueSlug('team')
    const secondSlug = uniqueSlug('other')
    const reusableSlug = uniqueSlug('reusable')

    await expect(
      mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
        internalKey: INTERNAL_KEY,
        slug: 'api',
        name: 'Reserved',
      }),
    ).rejects.toThrow('reserved')

    const firstWorkspaceId = (await mutate(
      owner.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: firstSlug,
        name: 'First',
      },
    )) as string
    const secondWorkspaceId = (await mutate(
      owner.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: secondSlug,
        name: 'Second',
      },
    )) as string

    await expect(
      mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
        internalKey: INTERNAL_KEY,
        slug: firstSlug,
        name: 'Duplicate',
      }),
    ).rejects.toThrow('already taken')

    await expect(
      mutate(owner.client, 'domains/workspaces/mutations:rename', {
        workspaceId: secondWorkspaceId,
        slug: 'robots-txt',
      }),
    ).rejects.toThrow('reserved')

    await expect(
      mutate(owner.client, 'domains/workspaces/mutations:rename', {
        workspaceId: secondWorkspaceId,
        slug: firstSlug,
      }),
    ).rejects.toThrow('already taken')

    await mutate(owner.client, 'domains/workspaces/mutations:rename', {
      workspaceId: firstWorkspaceId,
      slug: uniqueSlug('renamed'),
    })

    const deletedWorkspaceId = (await mutate(
      owner.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: reusableSlug,
        name: 'Deleted',
      },
    )) as string
    await mutate(owner.client, 'domains/workspaces/mutations:deleteWorkspace', {
      workspaceId: deletedWorkspaceId,
    })
    await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: reusableSlug,
      name: 'Reused',
    })
    await expect(
      mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
        internalKey: INTERNAL_KEY,
        slug: reusableSlug,
        name: 'Duplicate After Reuse',
      }),
    ).rejects.toThrow('already taken')
  })

  test('the canonical admission seam is idempotent at capacity and serializes the final slot', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('member-capacity-owner'),
      'Member Capacity Owner',
    )
    const existing = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('member-capacity-existing'),
      'Existing Member',
    )
    const outsider = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('member-capacity-outsider'),
      'Outside Member',
    )
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: existing.user._id,
      role: 'viewer',
    })
    const originalMembership = (
      (await query(convex, 'testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string; role: string }>
    ).find(row => row.userId === existing.user._id)!
    await mutate(convex, 'testing/workspaces:fillWorkspaceMemberCapacityForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })

    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: existing.user._id,
      role: 'editor',
    })
    const replayed = (
      (await query(convex, 'testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string; role: string }>
    ).find(row => row.userId === existing.user._id)!
    expect(replayed).toMatchObject({ _id: originalMembership._id, role: 'editor' })

    try {
      await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        userId: outsider.user._id,
        role: 'viewer',
      })
      throw new Error('capacity admission unexpectedly succeeded')
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError)
      if (!(error instanceof ConvexError)) throw error
      expect(WorkspaceMemberAdmissionRefusalSchema.parse(error.data)).toEqual({
        error: 'workspace_member_limit_reached',
        limit: 100,
      })
    }

    await mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
      workspaceId,
      userId: existing.user._id,
    })
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: outsider.user._id,
      role: 'viewer',
    })
    const replacement = (
      (await query(convex, 'testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === outsider.user._id)!
    expect(replacement._id).not.toBe(originalMembership._id)
    await mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
      workspaceId,
      userId: outsider.user._id,
    })
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: existing.user._id,
      role: 'viewer',
    })
    const rejoined = (
      (await query(convex, 'testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      })) as Array<{ _id: string; userId: string }>
    ).find(row => row.userId === existing.user._id)!
    expect(rejoined._id).not.toBe(originalMembership._id)

    const raceWorkspaceId = (await mutate(
      owner.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('member-capacity-race'),
        name: 'Member Capacity Race',
      },
    )) as string
    await mutate(convex, 'testing/workspaces:fillWorkspaceMemberCapacityForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: raceWorkspaceId,
      targetCount: 99,
    })
    const contenders = await Promise.allSettled([
      mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: raceWorkspaceId,
        userId: existing.user._id,
        role: 'viewer',
      }),
      mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: raceWorkspaceId,
        userId: outsider.user._id,
        role: 'viewer',
      }),
    ])
    expect(contenders.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(
      (await query(convex, 'testing/workspaces:workspaceMembersForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: raceWorkspaceId,
      })) as unknown[],
    ).toHaveLength(100)
  })

  test('owners reassign billing only to live members and payer removal requires reassignment', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('billing-owner'),
      'Billing Owner',
    )
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('billing-member'),
      'Billing Member',
    )
    const outsider = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('billing-outsider'),
      'Billing Outsider',
    )
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: member.user._id,
      role: 'viewer',
    })

    await expect(
      mutate(member.client, 'domains/workspaces/mutations:setBillingUser', {
        workspaceId,
        newBillingUserId: member.user._id,
      }),
    ).rejects.toThrow('Requires owner access')
    await expect(
      mutate(owner.client, 'domains/workspaces/mutations:setBillingUser', {
        workspaceId,
        newBillingUserId: outsider.user._id,
      }),
    ).rejects.toThrow('owner_candidate_required')
    await expect(
      mutate(owner.client, 'domains/workspaces/mutations:setBillingUser', {
        workspaceId,
        newBillingUserId: member.user._id,
      }),
    ).rejects.toThrow('owner_candidate_required')
    await expect(
      mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
        workspaceId,
        userId: owner.user._id,
      }),
    ).rejects.toThrow('reassign billing first')

    await mutate(owner.client, 'domains/workspaces/mutations:setMemberRole', {
      workspaceId,
      userId: member.user._id,
      role: 'owner',
    })
    await mutate(member.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: 0,
    })
    await expectOneAudit(
      owner.client,
      workspaceId,
      'workspace.billing_user_changed',
      owner.user._id,
      () =>
        mutate(owner.client, 'domains/workspaces/mutations:setBillingUser', {
          workspaceId,
          newBillingUserId: member.user._id,
        }),
      event =>
        expect(event.provenance).toEqual({
          oldBillingUserId: owner.user._id,
          newBillingUserId: member.user._id,
        }),
      // The member is deliberately unentitled (see the deletion above), so
      // landing billing on them pauses the workspace before the reassignment
      // itself is recorded.
      ['workspace.servicing_paused'],
    )
    await expect(
      mutate(owner.client, 'domains/workspaces/mutations:setMemberRole', {
        workspaceId,
        userId: member.user._id,
        role: 'editor',
      }),
    ).rejects.toThrow('reassign billing first')
    expect(
      (await listMine(owner.client)).find(row => row.workspace._id === workspaceId)?.workspace,
    ).toMatchObject({ servicingStatus: 'paused' })
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: outsider.user._id,
      role: 'viewer',
    })
    await mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
      workspaceId,
      userId: outsider.user._id,
    })
    const members = (await query(convex, 'testing/workspaces:workspaceMembersForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ userId: string }>
    expect(members.map(row => row.userId)).not.toContain(outsider.user._id)
    await expect(
      mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
        workspaceId,
        userId: member.user._id,
      }),
    ).rejects.toThrow('reassign billing first')

    await mutate(owner.client, 'domains/workspaces/mutations:setBillingUser', {
      workspaceId,
      newBillingUserId: owner.user._id,
    })
    expect(
      (await listMine(owner.client)).find(row => row.workspace._id === workspaceId)?.workspace,
    ).toMatchObject({ servicingStatus: 'active' })
    await mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
      workspaceId,
      userId: member.user._id,
    })
    await expect(
      mutate(owner.client, 'domains/workspaces/mutations:setMemberRole', {
        workspaceId,
        userId: owner.user._id,
        role: 'editor',
      }),
    ).rejects.toThrow('reassign billing first')
  })

  test('billing transfer to an existing owner ignores plan capacity and retries are idempotent', async () => {
    const source = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('transfer-source'),
      'Source',
    )
    const recipient = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('transfer-recipient'),
      'Recipient',
    )
    const workspaceId = (await listMine(source.client))[0]!.workspace._id
    await mutate(source.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: recipient.user._id,
      role: 'owner',
    })
    const transfer = () =>
      mutate(source.client, 'domains/workspaces/mutations:setBillingUser', {
        workspaceId,
        newBillingUserId: recipient.user._id,
      })
    await transfer()
    expect((await rawWorkspace(workspaceId)).billingUserId).toBe(recipient.user._id)
    const audit = await auditEvents(source.client, workspaceId)
    expect(audit).toContainEqual(
      expect.objectContaining({ event: 'workspace.billing_user_changed' }),
    )
    await transfer()
    expect(await auditEvents(source.client, workspaceId)).toEqual(audit)
  })

  test('mutating workspace operations write exactly one audit event with the actor', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('audit-owner'),
      'Audit Owner',
    )
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('audit-member'),
      'Audit Member',
    )
    await activateSyntheticSubscription(owner.client)
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: uniqueSlug('audit'),
      name: 'Audit Workspace',
    })) as string

    await expectAuditDelta(owner.client, workspaceId, [], 'workspace.created', owner.user._id)

    await expectOneAudit(owner.client, workspaceId, 'workspace.renamed', owner.user._id, () =>
      mutate(owner.client, 'domains/workspaces/mutations:rename', {
        workspaceId,
        slug: uniqueSlug('audit-updated'),
        name: 'Audit Workspace Updated',
        publicUrlBreakAcknowledged: true,
      }),
    )

    await expectOneAudit(
      owner.client,
      workspaceId,
      'workspace.renamed',
      owner.user._id,
      () =>
        mutate(owner.client, 'domains/workspaces/mutations:rename', {
          workspaceId,
          slug: uniqueSlug('audit-renamed'),
        }),
      event => expect(event.provenance).toEqual({ breaksPublicUrls: true, acknowledged: false }),
    )

    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: member.user._id,
      role: 'viewer',
    })

    await expectOneAudit(owner.client, workspaceId, 'workspace.deleted', owner.user._id, () =>
      mutate(owner.client, 'domains/workspaces/mutations:deleteWorkspace', { workspaceId }),
    )
  })

  test('audit readers order caller-dated events by at rather than insertion time', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('audit-order-owner'),
      'Audit Order Owner',
    )
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: uniqueSlug('audit-order'),
      name: 'Audit Order Workspace',
    })) as string

    await mutate(owner.client, 'domains/workspaces/mutations:setSuspended', {
      workspaceId,
      suspended: true,
      reason: 'newer event inserted first',
      now: 2_000,
    })
    await mutate(owner.client, 'domains/workspaces/mutations:setSuspended', {
      workspaceId,
      suspended: false,
      now: 1_000,
    })
    await mutate(owner.client, 'domains/workspaces/mutations:setSuspended', {
      workspaceId,
      suspended: true,
      now: 3_000,
    })
    await mutate(owner.client, 'domains/workspaces/mutations:setSuspended', {
      workspaceId,
      suspended: false,
      now: 3_000,
    })

    const memberEvents = (await auditEvents(owner.client, workspaceId)).filter(
      event => event.event === 'workspace.suspended' || event.event === 'workspace.unsuspended',
    )
    expect(memberEvents.map(event => event.at)).toEqual([1_000, 2_000, 3_000, 3_000])
    const sameTimeAscending = memberEvents.filter(event => event.at === 3_000)
    expect(sameTimeAscending.map(event => event.id)).toEqual(
      sameTimeAscending.map(event => event.id).toSorted(),
    )

    const apiPage = (await query(convex, 'domains/workspaces/queries:listAuditEventsFromApi', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      paginationOpts: { numItems: 100, cursor: null },
    })) as { page: Array<{ id: string; event: string; at: number }> }
    const apiEvents = apiPage.page.filter(
      event => event.event === 'workspace.suspended' || event.event === 'workspace.unsuspended',
    )
    expect(apiEvents.map(event => event.at)).toEqual([3_000, 3_000, 2_000, 1_000])
    expect(apiEvents.filter(event => event.at === 3_000).map(event => event.id)).toEqual(
      sameTimeAscending.map(event => event.id).toReversed(),
    )
  })

  test('session-scoped queries return projections, never raw user or workspace rows', async () => {
    const probe = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('projection'),
      'Projection Probe',
    )

    const user = (await query(probe.client, 'domains/users/queries:current', {})) as Record<
      string,
      unknown
    >
    const allowedUserKeys = [
      '_id',
      'email',
      'name',
      'paidCreditBalanceMicroUsd',
      'monthlyCreditBalanceMicroUsd',
      'billing',
    ]
    expect(Object.keys(user).filter(key => !allowedUserKeys.includes(key))).toEqual([])
    expect(user._id).toEqual(expect.any(String))
    expect(user.email).toEqual(expect.any(String))
    expect('stripeCustomerId' in ((user.billing ?? {}) as object)).toBe(false)

    const rows = (await query(probe.client, 'domains/workspaces/queries:listMine', {})) as Array<{
      role: string
      workspace: Record<string, unknown>
    }>
    expect(rows.length).toBeGreaterThan(0)
    const allowedWorkspaceKeys = [
      '_id',
      'billingUserId',
      'name',
      'servicingStatus',
      'servicingStatusChangedAt',
      'slug',
      'status',
    ]
    for (const row of rows) {
      expect(Object.keys(row.workspace).filter(key => !allowedWorkspaceKeys.includes(key))).toEqual(
        [],
      )
      expect(row.workspace._id).toEqual(expect.any(String))
      expect(row.workspace.slug).toEqual(expect.any(String))
    }

    const audit = (await query(probe.client, 'domains/workspaces/queries:getAuditEvents', {
      workspaceId: rows[0]!.workspace._id,
    })) as Array<Record<string, unknown>>
    expect(audit.length).toBeGreaterThan(0)
    const allowedAuditKeys = ['actorId', 'at', 'event', 'id', 'provenance']
    for (const event of audit) {
      expect(Object.keys(event).filter(key => !allowedAuditKeys.includes(key))).toEqual([])
      expect(event.event).toEqual(expect.any(String))
      expect(event.actorId).toEqual(expect.any(String))
    }
  })
})

async function signInWithTestGoogle(args: {
  providerAccountId: string
  email: string
  name: string
  emailVerified?: boolean
}): Promise<SignedInUser> {
  const result = await convex.action('auth:signIn', {
    provider: 'test-google',
    params: args,
  })
  return signedInUserFromResult(result)
}

async function signedInUserFromResult(result: unknown): Promise<SignedInUser> {
  const tokens = (result as { tokens?: { token: string; refreshToken: string } | null }).tokens
  expect(typeof tokens?.token).toBe('string')
  const client = convex.clientWithAuth(tokens!.token)
  return { client, user: await currentUser(client) }
}

async function currentUser(client: ConvexHttpClient): Promise<UserRow> {
  return (await query(client, 'domains/users/queries:current', {})) as UserRow
}

async function listMine(client: ConvexHttpClient): Promise<WorkspaceRow[]> {
  return (await query(client, 'domains/workspaces/queries:listMine', {})) as WorkspaceRow[]
}

async function rawWorkspace(workspaceId: string): Promise<{
  billingUserId: string
  servicingStatus?: string
  vmDiskGb?: number
  vmResizeRunId?: string
}> {
  const workspaces = (await query(convex, 'testing/workspaces:rawWorkspacesForTest', {
    internalKey: INTERNAL_KEY,
  })) as Array<{
    _id: string
    billingUserId: string
    servicingStatus?: string
    vmDiskGb?: number
    vmResizeRunId?: string
  }>
  const workspace = workspaces.find(candidate => candidate._id === workspaceId)
  if (workspace === undefined) throw new Error('Workspace fixture not found')
  return workspace
}

async function activateSyntheticSubscription(
  client: ConvexHttpClient,
  now?: number,
  plan?: SubscriptionPlanId,
): Promise<void> {
  await mutate(client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
    ...(now === undefined ? {} : { now }),
    ...(plan === undefined ? {} : { plan }),
  })
}

async function auditEvents(client: ConvexHttpClient, workspaceId: string): Promise<AuditRow[]> {
  return (await query(client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as AuditRow[]
}

async function waitForMemberDirectoryRefresh(userId: string, expectedName: string): Promise<void> {
  let lastDirectory: Array<{ name?: string }> = []
  for (let attempt = 0; attempt < 100; attempt += 1) {
    lastDirectory = (await query(convex, 'testing/workspaces:userMemberDirectoryForTest', {
      internalKey: INTERNAL_KEY,
      userId,
    })) as Array<{ name?: string }>
    if (lastDirectory.length > 0 && lastDirectory.every(row => row.name === expectedName)) return
    await Bun.sleep(25)
  }
  const refreshed = lastDirectory.filter(row => row.name === expectedName).length
  throw new Error(
    `Member directory refresh did not converge (${refreshed}/${lastDirectory.length} rows refreshed)`,
  )
}

async function expectOneAudit(
  client: ConvexHttpClient,
  workspaceId: string,
  eventName: string,
  actorId: string,
  mutateWorkspace: () => Promise<unknown>,
  inspect?: (event: AuditRow) => void,
  /**
   * Events the mutation also records, in order, before the one under test. A
   * mutation may legitimately audit more than its own headline — reassigning
   * billing to an unentitled owner pauses the workspace, and that pause is
   * exactly the kind of thing the log exists to hold. Naming them keeps the
   * count exact instead of loosening it to "at least one".
   */
  alsoRecords: readonly string[] = [],
): Promise<void> {
  const before = await auditEvents(client, workspaceId)
  await mutateWorkspace()
  await expectAuditDelta(client, workspaceId, before, eventName, actorId, inspect, alsoRecords)
}

async function expectAuditDelta(
  client: ConvexHttpClient,
  workspaceId: string,
  before: AuditRow[],
  eventName: string,
  actorId: string,
  inspect?: (event: AuditRow) => void,
  alsoRecords: readonly string[] = [],
): Promise<void> {
  const after = await auditEvents(client, workspaceId)
  expect(after).toHaveLength(before.length + alsoRecords.length + 1)
  const previousIds = new Set(before.map(row => row.id))
  const added = after.filter(row => !previousIds.has(row.id))
  expect(added.map(row => row.event).sort()).toEqual([...alsoRecords, eventName].sort())
  const event = added.find(row => row.event === eventName)!
  expect(event.event).toBe(eventName)
  expect(event.actorId).toBe(actorId)
  inspect?.(event)
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
  email: string
  billing?: { firstPaidAt?: number }
}

interface WorkspaceRow {
  role: 'owner' | 'editor' | 'viewer'
  workspace: {
    _id: string
    slug: string
    name: string
    status: string
  }
}

interface AuditRow {
  id: string
  event: string
  actorId: string
  at: number
  provenance?: unknown
}
