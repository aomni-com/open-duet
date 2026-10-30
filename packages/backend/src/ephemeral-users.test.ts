import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { convexDev, generateAuthKeys, uniqueEmail, type ConvexDevFixture } from '@repo/test-harness'

import {
  EPHEMERAL_DEFAULT_TTL_MS,
  EPHEMERAL_MAX_TTL_MS,
} from '../convex/domains/users/ephemeralModel'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-ephemeral-internal-key'

const HOUR_MS = 60 * 60 * 1000
const T0 = 1_700_000_000_000

let convex: ConvexDevFixture

// `ephemeral` is an EXPLICIT login-as option, never inferred. The first
// version marked every workspace whose user was minted by login-as — which
// assumes login-as only ever creates test identities, and dies the moment it
// programmatically creates a real customer. Now the caller says so: `true`
// buys the 6-hour default, a timestamp picks the deletion moment, and nothing
// may outlive 24 hours.
describe('ephemeral login-as identities', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: 'http://localhost:3000',
        // Staging-only in the real topology; production never sets it, so the
        // born-disposable rule below cannot touch a real customer.
        DUET_SIGNUP_TEST_IDENTITIES: 'inbox@example.com',
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  async function mint(args: Record<string, unknown>): Promise<{
    created: boolean
    userId: string
    workspaceSlug: string
  }> {
    return (await convex.mutation('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      ttlSeconds: 3600,
      now: T0,
      ...args,
    })) as { created: boolean; userId: string; workspaceSlug: string }
  }

  async function sweep(now: number): Promise<{ retired: string[]; failed: unknown[] }> {
    return (await convex.mutation('domains/users/ephemeralModel:retireExpiredEphemeralUsers', {
      internalKey: INTERNAL_KEY,
      now,
    })) as { retired: string[]; failed: unknown[] }
  }

  test('ephemeral: true survives until its configured deadline, then is retired', async () => {
    const email = uniqueEmail('ephemeral-default')
    const minted = await mint({ email, createIfMissing: true, ephemeral: true })
    expect(minted.created).toBe(true)

    // The instant before the deadline must leave the identity live.
    const early = await sweep(T0 + EPHEMERAL_DEFAULT_TTL_MS - 1)
    expect(early.retired).toEqual([])
    expect((await mint({ email })).created).toBe(false)

    // At the deadline the identity is retired —
    // provable through the public seam, because the user can no longer be
    // found without createIfMissing.
    const due = await sweep(T0 + EPHEMERAL_DEFAULT_TTL_MS)
    expect(due.retired).toEqual([minted.userId])
    expect(due.failed).toEqual([])
    await expect(mint({ email })).rejects.toThrow(/user not found/i)

    // Idempotent: a second pass finds nothing left to do.
    expect((await sweep(T0 + EPHEMERAL_DEFAULT_TTL_MS + 1)).retired).toEqual([])
  })

  test('a timestamp beyond the maximum lifetime is capped', async () => {
    const email = uniqueEmail('ephemeral-capped')
    const minted = await mint({
      email,
      createIfMissing: true,
      ephemeral: T0 + 2 * EPHEMERAL_MAX_TTL_MS,
    })

    const beforeCap = await sweep(T0 + EPHEMERAL_MAX_TTL_MS - 1)
    expect(beforeCap.retired).toEqual([])
    expect((await mint({ email })).created).toBe(false)

    const afterCap = await sweep(T0 + EPHEMERAL_MAX_TTL_MS)
    expect(afterCap.retired).toEqual([minted.userId])
    await expect(mint({ email })).rejects.toThrow(/user not found/i)
  })

  test('an existing user can never be made ephemeral retroactively', async () => {
    const email = uniqueEmail('ephemeral-retrofit')
    await mint({ email, createIfMissing: true })
    // The user exists and is real; a later caller asking to mark them
    // disposable must be refused — deletion is not something a second caller
    // gets to bolt onto an identity it did not create.
    await expect(mint({ email, ephemeral: true })).rejects.toThrow(/existing user/i)
  })

  test('a deletion moment already in the past is refused, not honored', async () => {
    const email = uniqueEmail('ephemeral-past')
    await expect(mint({ email, createIfMissing: true, ephemeral: T0 - 1 })).rejects.toThrow(/past/i)
  })

  test('creation without the option marks nothing — no sweep ever touches it', async () => {
    const email = uniqueEmail('ephemeral-absent')
    await mint({ email, createIfMissing: true })
    const sweptFarFuture = await sweep(T0 + 100 * HOUR_MS)
    expect(sweptFarFuture.retired).toEqual([])
    expect((await mint({ email })).created).toBe(false)
  })

  // The e2e mailbox's accounts are born disposable, without anyone asking. A
  // browser-signup journey CANNOT ask: it goes through the real sign-in page,
  // where there is no `ephemeral` option to pass — so before this, every such
  // run stranded a workspace and its VM forever, and a journey that died
  // mid-run stranded them whether or not its cleanup was correct.
  test('a signup from the configured test inbox is born disposable without asking', async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const exempt = `inbox+staging-e2e-${runId}@example.com`
    // The abuse journey's deny leg: deliberately NOT exempt from the trial
    // gate, but still an account we own and must reclaim.
    const refused = `inbox+abuse-${runId}@example.com`
    for (const email of [exempt, refused]) {
      expect((await mint({ email, createIfMissing: true })).created).toBe(true)
    }

    // Nobody named a moment, so the 6-hour default runs from birth — and birth
    // is the real clock, not this file's T0.
    const born = Date.now()
    for (const email of [exempt, refused]) {
      expect((await mint({ email, now: born + EPHEMERAL_DEFAULT_TTL_MS - 1 })).created).toBe(false)
    }

    await sweep(born + EPHEMERAL_DEFAULT_TTL_MS + 60_000)
    for (const email of [exempt, refused]) {
      await expect(mint({ email })).rejects.toThrow(/user not found/i)
    }
  })

  // The mark follows the OWNER, not the bootstrap accident. Expiry deletion is
  // per-owner (every workspace the user owns), so the `ephemeral` mark — and
  // with it the VM's `duet-ephemeral` tag — must cover the same set: a second
  // workspace created mid-lifetime is equally disposable, and an untagged VM
  // is invisible to the provider-side sweep until expiry. (David: the whole
  // point is a programmatic way to clear VMs, which cost money.)
  test('every workspace an ephemeral user creates is born marked, not just the bootstrap one', async () => {
    const email = uniqueEmail('ephemeral-second-ws')
    const minted = (await mint({ email, createIfMissing: true, ephemeral: true })) as {
      userId: string
      workspaceSlug: string
    }
    const bootstrap = (
      (await convex.query('testing/workspaces:rawWorkspacesForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<{ _id: string; slug: string; ephemeral?: boolean }>
    ).find(workspace => workspace.slug === minted.workspaceSlug)
    expect(bootstrap?.ephemeral).toBe(true)

    // The workspace-capacity gate reads live subscriber state at the server's
    // wall clock, so the synthetic subscription must be active NOW — a
    // T0-anchored one is long lapsed by real time.
    await convex.mutation('testing/workspaces:activateSyntheticSubscriptionByEmailForTest', {
      internalKey: INTERNAL_KEY,
      email,
      now: Date.now(),
      plan: 'pro',
    })
    const second = (await convex.mutation('domains/workspaces/birth:createWorkspace', {
      internalKey: INTERNAL_KEY,
      actorId: minted.userId,
      // Convex ids are lowercase alphanumerics, so this always satisfies the
      // slug grammar and is unique per user.
      slug: `sec-${minted.userId.slice(-10).toLowerCase()}`,
      name: 'Second disposable',
    })) as { workspaceId: string }
    const secondRow = (await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: second.workspaceId,
    })) as { ephemeral?: boolean }
    expect(secondRow.ephemeral).toBe(true)
  })

  test("a real user's workspaces are never born marked", async () => {
    const email = uniqueEmail('ephemeral-real-ws')
    const minted = (await mint({ email, createIfMissing: true })) as {
      userId: string
      workspaceSlug: string
    }
    const bootstrap = (
      (await convex.query('testing/workspaces:rawWorkspacesForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<{ slug: string; ephemeral?: boolean }>
    ).find(workspace => workspace.slug === minted.workspaceSlug)
    expect(bootstrap?.ephemeral).toBeUndefined()
  })

  test('a blocked retirement leaves the immediately eligible sweep', async () => {
    const blockedEmail = uniqueEmail('ephemeral-blocked')
    const blocked = (await mint({
      email: blockedEmail,
      createIfMissing: true,
      ephemeral: true,
    })) as { userId: string }
    const durableEmail = uniqueEmail('ephemeral-host')
    const durable = (await mint({ email: durableEmail, createIfMissing: true })) as {
      workspaceSlug: string
    }
    const host = (
      (await convex.query('testing/workspaces:rawWorkspacesForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<{ _id: string; slug: string }>
    ).find(workspace => workspace.slug === durable.workspaceSlug)
    if (host === undefined) throw new Error('Host workspace not found')
    await convex.mutation('testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: host._id,
      userId: blocked.userId,
      role: 'viewer',
    })

    const first = await sweep(T0 + EPHEMERAL_DEFAULT_TTL_MS + 1)
    expect(first.failed).toHaveLength(1)
    const immediate = await sweep(T0 + EPHEMERAL_DEFAULT_TTL_MS + 2)
    expect(immediate.failed).toEqual([])
    const retried = await sweep(T0 + EPHEMERAL_DEFAULT_TTL_MS + 15 * 60_000 + 1)
    expect(retried.failed).toHaveLength(1)
  })
})
