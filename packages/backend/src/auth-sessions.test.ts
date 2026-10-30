import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  convexDev,
  generateAuthKeys,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'auth-sessions-internal-key'
const DAY_MS = 24 * 60 * 60 * 1000

let convex: ConvexDevFixture

describe('the identity session behind a browser sign-in', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => await convex?.stop())

  test('someone who keeps using the product is never signed out', async () => {
    const email = `daily-${Date.now()}@example.com`
    const signedInAt = Date.now()

    await signInWithMagicLink(convex, email, 'Daily User')

    // The library caps a session at an absolute deadline fixed at sign-in and
    // never extends it, however active the person is; the 30-day default put
    // every regular user back on the sign-in page monthly. Inactivity is the
    // only guard, and it lives on the rotating refresh token.
    const sessions = (await query(convex, 'testing/authRequests:rawAuthSessionsForTest', {
      internalKey: INTERNAL_KEY,
      email,
    })) as { expirationTime: number }[]
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.expirationTime).toBeGreaterThan(signedInAt + 50 * 365 * DAY_MS)
  })
})
