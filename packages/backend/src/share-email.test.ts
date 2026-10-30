import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

import { prepareTransactionalEmail } from '@repo/email'
import { renderPreparedTransactionalEmail } from '@repo/email/render'
import {
  act,
  convexDev,
  extractMessageLink,
  generateAuthKeys,
  query,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'share-email-internal-key'

let convex: ConvexDevFixture
let sequence = 0

describe('share invitation email', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: 'https://app-staging.duet.so',
        DUET_SHARE_EMAIL_DAILY_LIMIT: '2',
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => await convex?.stop())

  test('renders an HTML link that the staging mailbox harness can extract', async () => {
    const token = `duet_share_${'a'.repeat(64)}`
    const message = prepareTransactionalEmail({
      kind: 'share_invite',
      actionUrl: `https://app-staging.duet.so/share/${token}`,
      sharerName: 'Alice Example',
      folderName: 'field-notes',
    })
    expect(message.subject).toBe('Alice Example shared “field-notes” with you')
    const html = await renderPreparedTransactionalEmail(message)
    expect(html).toContain('Open shared folder')
    expect(extractMessageLink(html)).toBe(`https://app-staging.duet.so/share/${token}`)
  })

  test('sends idempotently without returning or auditing the raw token', async () => {
    const owner = await signInTestGoogle(convex, 'delivery-owner')
    const workspaceId = await bootstrapWorkspace(owner.client)
    const recipient = `share-delivery-${Date.now()}@example.com`
    const created = (await convex.action('domains/shares/actions:createAndSendFromApi', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      fromWorkspaceId: workspaceId,
      toEmail: recipient,
      path: 'projects/field-notes',
      mode: 'read',
    })) as { share: { id: string } }

    expect(created.share.id).toEqual(expect.any(String))
    expect(created).not.toHaveProperty('invitationToken')
    expect(created.share).not.toHaveProperty('tokenHash')
    expect(JSON.stringify(created)).not.toMatch(/duet_share_[a-f0-9]{64}/)
    await convex.action('testing/shareActions:resendForTest', {
      internalKey: INTERNAL_KEY,
      shareId: created.share.id,
    })

    const deliveries = (await query(convex, 'testing/invitations:emailDeliveries', {
      internalKey: INTERNAL_KEY,
      to: recipient,
    })) as Array<{ attempts: number; status: string; subject: string }>
    expect(deliveries).toEqual([
      expect.objectContaining({
        attempts: 1,
        status: 'sent',
        subject: 'delivery-owner shared “field-notes” with you',
      }),
    ])
    const audit = await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
      workspaceId,
    })
    expect(JSON.stringify(audit)).not.toMatch(/duet_share_[a-f0-9]{64}/)
  })

  test('caps each sharer independently at the configured daily limit', async () => {
    const owner = await signInTestGoogle(convex, 'rate-owner')
    const workspaceId = await bootstrapWorkspace(owner.client)
    for (const path of ['one', 'two']) {
      await convex.action('domains/shares/actions:createAndSendFromApi', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        fromWorkspaceId: workspaceId,
        toEmail: `${path}-${Date.now()}@example.com`,
        path,
        mode: 'read',
      })
    }
    await expect(
      convex.action('domains/shares/actions:createAndSendFromApi', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        fromWorkspaceId: workspaceId,
        toEmail: `three-${Date.now()}@example.com`,
        path: 'three',
        mode: 'read',
      }),
    ).rejects.toThrow('Share email daily rate limit exceeded')
  })
})

async function signInTestGoogle(
  fixture: ConvexDevFixture,
  prefix: string,
): Promise<{ client: ConvexHttpClient; user: { _id: string } }> {
  sequence += 1
  const result = await fixture.action('auth:signIn', {
    provider: 'test-google',
    params: {
      providerAccountId: `${prefix}-${Date.now()}-${sequence}`,
      email: `${prefix}-${Date.now()}-${sequence}@example.com`,
      name: prefix,
      emailVerified: true,
    },
  })
  const token = (result as { tokens?: { token?: string } }).tokens?.token
  if (!token) throw new Error('Auth token missing')
  const client = fixture.clientWithAuth(token)
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
