import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

import {
  act,
  convexDev,
  generateAuthKeys,
  query,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'email-delivery-failure-internal-key'

let convex: ConvexDevFixture

describe('email delivery failures', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: 'https://app-staging.duet.so',
        DUET_TEST_AUTH_EMAIL: '0',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_SIGNUP_MX_LOOKUP: 'off',
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => await convex?.stop())

  test('magic-link delivery fails loudly without capture or Resend', async () => {
    const email = uniqueEmail('no-capture')
    await expect(
      convex.action('auth:signIn', {
        provider: 'email',
        params: { email },
      }),
    ).rejects.toThrow('RESEND_API_KEY is required')
  })

  test('revokes a pending share when delivery fails', async () => {
    const owner = await signInTestGoogle('share-failure-owner')
    const workspaceId = await bootstrapWorkspace(owner.client)
    const recipient = uniqueEmail('share-failure-recipient')

    await expect(
      convex.action('domains/shares/actions:createAndSendFromApi', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        fromWorkspaceId: workspaceId,
        toEmail: recipient,
        path: 'failed-delivery',
        mode: 'read',
      }),
    ).rejects.toThrow('RESEND_API_KEY is required')

    const rows = (await query(convex, 'testing/shares:rawSharesForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ state: string; activeKey?: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe('revoked')
    expect(rows[0]).not.toHaveProperty('activeKey')

    const deliveries = (await query(convex, 'testing/invitations:emailDeliveries', {
      internalKey: INTERNAL_KEY,
      to: recipient,
    })) as Array<Record<string, unknown>>
    expect(deliveries).toEqual([
      expect.objectContaining({ kind: 'share_invite', status: 'failed', attempts: 1 }),
    ])
    expect(JSON.stringify(deliveries)).not.toContain('duet_share_')
    expect(deliveries[0]).not.toHaveProperty('html')
    expect(deliveries[0]).not.toHaveProperty('text')
  })

  test('revokes a workspace invitation when delivery fails', async () => {
    const owner = await signInTestGoogle('invite-failure-owner')
    const workspaceId = await bootstrapWorkspace(owner.client)
    const recipient = uniqueEmail('invite-failure-recipient')

    await expect(
      convex.action('domains/invitations/actions:createAndSendFromApi', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        workspaceId,
        email: recipient,
        role: 'editor',
      }),
    ).rejects.toThrow('RESEND_API_KEY is required')

    const rows = (await query(convex, 'testing/invitations:rawInvites', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<Record<string, unknown>>
    expect(rows).toEqual([
      expect.objectContaining({
        email: recipient,
        role: 'editor',
        revokedAt: expect.any(Number),
      }),
    ])
    expect(rows[0]).not.toHaveProperty('activeKey')
  })
})

async function signInTestGoogle(
  prefix: string,
): Promise<{ client: ConvexHttpClient; user: { _id: string } }> {
  const result = await convex.action('auth:signIn', {
    provider: 'test-google',
    params: {
      providerAccountId: `${prefix}-${Date.now()}`,
      email: uniqueEmail(prefix),
      name: prefix,
      emailVerified: true,
    },
  })
  const token = (result as { tokens?: { token?: string } }).tokens?.token
  if (!token) throw new Error('Auth token missing')
  const client = convex.clientWithAuth(token)
  return {
    client,
    user: (await query(client, 'domains/users/queries:current')) as { _id: string },
  }
}

async function bootstrapWorkspace(client: ConvexHttpClient): Promise<string> {
  const result = (await act(client, 'domains/signupAbuse/actions:signUp', {})) as {
    workspaceId: string
  }
  return result.workspaceId
}
