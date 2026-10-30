import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

import { DISPOSABLE_EMAIL_DOMAINS } from '../convex/domains/signupAbuse/blockedEmailDomains'
import { MAX_TRIALS_PER_DEVICE } from '../convex/domains/signupAbuse/model'
import { DOMAIN_SIGNUP_VELOCITY_LIMIT } from '../convex/domains/signupAbuse/policy'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'signup-abuse-internal-key'
const TEST_INBOX = 'live-acceptance@example.com'

type UserRow = { _id: string; email: string }

let convex: ConvexDevFixture

async function signIn(email: string) {
  return await signInWithMagicLink<UserRow>(convex, email, 'Device Test')
}

async function claim(userId: string, visitorId: string) {
  return (await mutate(convex, 'testing/signupAbuse:claimDeviceForTest', {
    internalKey: INTERNAL_KEY,
    userId,
    visitorId,
  })) as { withheld: boolean; distinctMailboxes: number }
}

async function signupState(userId: string) {
  return (await query(convex, 'testing/signupAbuse:signupAbuseUserForTest', {
    internalKey: INTERNAL_KEY,
    userId,
  })) as {
    visitorId?: string
    canonicalEmail?: string
    trialGrantWithheldAt?: number
  }
}

async function signals(email: string) {
  return (await query(convex, 'testing/signupAbuse:signupSignalsForTest', {
    internalKey: INTERNAL_KEY,
    email,
  })) as { reason: string; visitorId?: string }[]
}

beforeAll(async () => {
  convex = await convexDev(BACKEND_DIR, {
    env: {
      ...generateAuthKeys(),
      DUET_API_INTERNAL_KEY: INTERNAL_KEY,
      DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
      DUET_TEST_AUTH_EMAIL: '1',
      DUET_APP_URL: 'http://localhost:3000',
      DUET_SIGNUP_TEST_IDENTITIES: TEST_INBOX,
    },
    reset: true,
  })
}, 240_000)

afterAll(async () => {
  await convex?.stop()
})

describe('signup ledger', () => {
  test('a blocked domain is refused before workspace bootstrap', async () => {
    // Blocked providers are known spam sources. They follow the same hard
    // refusal contract as controlled-domain velocity abuse.
    const email = `${uniqueEmail('blocked').split('@')[0]}@${DISPOSABLE_EMAIL_DOMAINS[0]}`

    await expect(signInWithMagicLink<UserRow>(convex, email, 'Blocked')).rejects.toThrow(
      'Signup is not allowed for this email domain',
    )
    expect(await signals(email)).toEqual([])
  })

  test('an allowed signup writes nothing', async () => {
    // The table is the exception log, not the signup log.
    const email = uniqueEmail('allowed')
    await signInWithMagicLink<UserRow>(convex, email, 'Allowed')

    expect(await signals(email)).toEqual([])
  })

  test('a controlled domain crossing its signup allowance is refused', async () => {
    // The 2026-09-02/03 farm, in miniature: one vanity domain, accounts minted
    // back to back, no device evidence on any of them. Every per-account rule
    // passes; only the rate can say no — and it says no to the sixth, not the
    // first, so a small team signing up together is untouched.
    const domain = `farm-${Date.now().toString(36)}.example`
    const minted: UserRow[] = []
    for (let i = 1; i <= DOMAIN_SIGNUP_VELOCITY_LIMIT + 1; i += 1) {
      const signup = signInWithMagicLink<UserRow>(convex, `duet${i}@${domain}`, `Farm ${i}`)
      if (i <= DOMAIN_SIGNUP_VELOCITY_LIMIT) minted.push((await signup).user)
      else await expect(signup).rejects.toThrow('Signup is not allowed for this email domain')
    }

    expect(await signals(minted[DOMAIN_SIGNUP_VELOCITY_LIMIT - 1]!.email)).toEqual([])
    expect(
      (await signupState(minted[DOMAIN_SIGNUP_VELOCITY_LIMIT - 1]!._id)).trialGrantWithheldAt,
    ).toBeUndefined()
  })
})

describe('signup device claim', () => {
  test('the device allowance withholds the boundary mailbox and preserves prior grants', async () => {
    const device = 'visitor-mailbox-boundary'
    const rows = []
    for (let index = 0; index < MAX_TRIALS_PER_DEVICE; index += 1) {
      rows.push(await signIn(uniqueEmail(`device-${index}`)))
      expect(await claim(rows[index]!.user._id, device)).toEqual({
        withheld: index === MAX_TRIALS_PER_DEVICE - 1,
        distinctMailboxes: index + 1,
      })
    }
    expect((await signupState(rows[0]!.user._id)).trialGrantWithheldAt).toBeUndefined()
    expect((await signupState(rows.at(-1)!.user._id)).trialGrantWithheldAt).toEqual(
      expect.any(Number),
    )
  })

  test('aliases of one mailbox do not consume distinct device slots', async () => {
    // The false positive the canonical-mailbox count exists to prevent. These
    // are three separate user rows — auth keeps `+tag` on non-gmail domains —
    // but one inbox, and they already share a grant key, so they cannot farm
    // anything. Counting rows instead of mailboxes would withhold here.
    const device = 'visitor-one-mailbox'
    const base = uniqueEmail('aliased')
    const [local, domain] = base.split('@')

    const rows = []
    for (const tag of Array.from(
      { length: MAX_TRIALS_PER_DEVICE },
      (_, index) => `alias-${index}`,
    )) {
      rows.push(await signIn(`${local}+${tag}@${domain}`))
    }

    const claims = []
    for (const row of rows) claims.push(await claim(row.user._id, device))

    expect(claims.map(result => result.withheld)).toEqual(
      Array.from({ length: MAX_TRIALS_PER_DEVICE }, () => false),
    )
    expect(claims.at(-1)?.distinctMailboxes).toBe(1)

    // All three rows resolve to the one inbox, which is why they cannot farm.
    const canonicals = new Set(
      await Promise.all(rows.map(async row => (await signupState(row.user._id)).canonicalEmail)),
    )
    expect([...canonicals]).toEqual([base])
  })

  test('a configured test identity is exempt and never occupies a device slot', async () => {
    // Otherwise the live-acceptance inbox would fill the allowance of whichever
    // machine CI runs on, and the third journey of the day would start failing.
    const device = 'visitor-exempt'
    const [local, domain] = TEST_INBOX.split('@')

    for (const tag of ['staging-e2e-run1', 'staging-e2e-run2', 'staging-e2e-run3']) {
      const user = await signIn(`${local}+${tag}@${domain}`)
      expect(await claim(user.user._id, device)).toEqual({ withheld: false, distinctMailboxes: 0 })
      expect((await signupState(user.user._id)).visitorId).toBeUndefined()
    }
  })

  test('the device binding is fixed at first signup and never migrates', async () => {
    // Re-binding on a later sign-in from a second device would reset the count
    // for free — a farmer would just sign in once from a clean browser.
    const user = await signIn(uniqueEmail('sticky'))
    await claim(user.user._id, 'visitor-original')
    await claim(user.user._id, 'visitor-different')

    expect((await signupState(user.user._id)).visitorId).toBe('visitor-original')
  })

  test('concurrent claims at the device boundary cannot bypass the allowance', async () => {
    const device = 'visitor-race'
    for (let index = 0; index < MAX_TRIALS_PER_DEVICE - 1; index += 1) {
      await claim((await signIn(uniqueEmail(`race-before-${index}`))).user._id, device)
    }
    const crossing = [
      await signIn(uniqueEmail('race-crossing-a')),
      await signIn(uniqueEmail('race-crossing-b')),
    ]
    const results = await Promise.all(crossing.map(entry => claim(entry.user._id, device)))
    expect(results.every(result => result.withheld)).toBe(true)
    for (const entry of crossing) {
      expect((await signupState(entry.user._id)).trialGrantWithheldAt).toEqual(expect.any(Number))
    }
  })

  test('a withheld account is refused a trial from every grant call site', async () => {
    // The withhold lives on the user rather than on the workspace-birth call
    // precisely so VM registration cannot re-grant it.
    const device = 'visitor-grant-sites'
    for (const label of Array.from(
      { length: MAX_TRIALS_PER_DEVICE - 1 },
      (_, index) => `grant-${index}`,
    )) {
      await claim((await signIn(uniqueEmail(label))).user._id, device)
    }
    const withheld = await signIn(uniqueEmail('grant-three'))
    expect(await claim(withheld.user._id, device)).toMatchObject({ withheld: true })

    const workspaceId = (await mutate(
      withheld.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: `withheld-${Date.now().toString(36)}`,
        name: 'Withheld Workspace',
      },
    )) as string

    // Both call sites, because the withhold marker lives on the user rather
    // than on the birth call precisely so neither can slip past it. A withhold
    // that only guarded birth would leak the moment a VM registered.
    for (const source of ['workspace_create', 'vm_register'] as const) {
      expect(
        await mutate(convex, 'testing/signupAbuse:grantTrialForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          actorId: withheld.user._id,
          source,
        }),
      ).toEqual({ granted: false })
    }

    // Note the ordering this test cannot reproduce: `signInWithMagicLink`
    // bootstraps (and therefore grants) before the claim runs here, so this
    // user already holds a trial window. In production the claim happens inside
    // the same `signUp` action BEFORE bootstrap, so the marker is set first and
    // no window is ever opened. That end-to-end ordering is slice 07's journey;
    // what this slice owns is that a marked user is refused from every site.
  })
})
