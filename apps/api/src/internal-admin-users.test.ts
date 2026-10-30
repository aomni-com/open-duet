import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

import { InternalAdminCreateUserRequestSchema } from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  issueKey,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { createApiApp } from './index'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../..', 'packages/backend')
const INTERNAL_KEY = 'test-admin-internal-key'
let convex: ConvexDevFixture
let client: ConvexHttpClient
let user: { _id: string; email: string }
let app: ReturnType<typeof createApiApp>
let browserKey: string

describe('Internal admin user creation', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_FAKE_EXE: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    const signedIn = await signInWithMagicLink<{ _id: string; email: string }>(
      convex,
      uniqueEmail('admin').replace(/@[^@]+$/, '@duet.so'),
      'Admin Operator',
    )
    client = signedIn.client
    user = signedIn.user
    await mutate(client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
      internalKey: INTERNAL_KEY,
    })
    const session = (await mutate(client, 'domains/apiKeys/mutations:mintBrowserSession', {})) as {
      token: string
    }
    browserKey = session.token
    app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('creates a user and default owner workspace from an email', async () => {
    const email = uniqueEmail('admin-created')
    const response = await authed('/v1/internal-admin/users', browserKey, {
      method: 'POST',
      body: JSON.stringify({ email: `  ${email.toUpperCase()}  ` }),
    })
    expect(response.status).toBe(201)
    const created = (await response.json()) as {
      userId: string
      email: string
      workspaceId: string
      workspaceSlug: string
    }
    expect(created.email).toBe(email)
    const detail = await authed(`/v1/internal-admin/workspaces/${created.workspaceId}`, browserKey)
    const body = await detail.json()
    expect(body.workspace.slug).toBe(created.workspaceSlug)
    expect(body.workspace.billingUserId).toBe(created.userId)
    expect(body.usage.members).toContainEqual(
      expect.objectContaining({
        userId: created.userId,
        email,
        role: 'owner',
      }),
    )
    const audit = await authed(
      `/v1/internal-admin/audit?workspaceId=${created.workspaceId}`,
      browserKey,
    )
    expect((await audit.json()).events).toContainEqual(
      expect.objectContaining({
        action: 'admin.user.create',
        target: email,
        actorEmail: user.email,
      }),
    )
    const signedIn = await signInWithMagicLink<{ _id: string; email: string }>(
      convex,
      email,
      'Created User',
    )
    expect(signedIn.user._id).toBe(created.userId)
    const homes = (await query(
      signedIn.client,
      'domains/workspaces/queries:listMine',
      {},
    )) as Array<{ workspace: { _id: string } }>
    expect(homes.map(home => home.workspace._id)).toEqual([created.workspaceId])
  })

  test('rejects duplicate canonical mailboxes without changing their workspace', async () => {
    const stem = `admin${Date.now()}`
    const create = (email: string) =>
      authed('/v1/internal-admin/users', browserKey, {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
    const first = await create(`${stem}@gmail.com`)
    expect(first.status).toBe(201)
    const created = await first.json()
    const duplicate = await create(`${stem.slice(0, 5)}.${stem.slice(5)}+tag@googlemail.com`)
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'user_already_exists' })
    const search = await authed(`/v1/internal-admin/search?q=${stem}@gmail.com`, browserKey)
    expect((await search.json()).workspaces.map((row: { id: string }) => row.id)).toEqual([
      created.workspaceId,
    ])
  })

  test('user creation requires an operator and a valid email', async () => {
    const email = uniqueEmail('denied-create')
    const key = await issueKey(client)
    const denied = await authed('/v1/internal-admin/users', key.key, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'internal_admin_required' })
    for (const invalid of [
      '',
      'not-an-email',
      'a@',
      `${'a'.repeat(InternalAdminCreateUserRequestSchema.shape.email.maxLength! + 1)}@example.com`,
    ]) {
      const response = await authed('/v1/internal-admin/users', browserKey, {
        method: 'POST',
        body: JSON.stringify({ email: invalid }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request' })
    }
    const search = await authed(`/v1/internal-admin/search?q=${email}`, browserKey)
    expect((await search.json()).workspaces).toEqual([])
  })
})

function authed(path: string, key: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${key}`)
  return app.request(path, { ...init, headers })
}
