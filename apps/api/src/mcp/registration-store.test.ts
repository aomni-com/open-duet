import { afterEach, beforeEach, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import type { ConvexHttpClient } from 'convex/browser'

import schema from '../../../../packages/backend/convex/schema'
import { convexMcpRegistrationStore } from './registration-store'

const previousKey = process.env.DUET_API_INTERNAL_KEY
beforeEach(() => {
  process.env.DUET_API_INTERNAL_KEY = 'internal-secret'
})
afterEach(() => {
  if (previousKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = previousKey
})

const AUTHORIZATION_SERVER = 'https://issuer.test/v1/test-only/oauth-issuer'

test('adopt persists the RFC 7592 fields through the actual Convex validator', async () => {
  const { store, t } = await fixture()

  const adoption = await store.adopt({
    authorizationServer: AUTHORIZATION_SERVER,
    clientId: 'client-1',
    tokenEndpointAuthMethod: 'none',
    registrationClientUri: `${AUTHORIZATION_SERVER}/register/client-1`,
    registrationAccessToken: 'registration-token-1',
  })

  expect(adoption.status).toBe('adopted')
  expect(adoption.registration).toMatchObject({ clientId: 'client-1' })
  expect(await t.run(ctx => ctx.db.query('mcpClientRegistrations').unique())).toMatchObject({
    authorizationServer: AUTHORIZATION_SERVER,
    clientId: 'client-1',
    tokenEndpointAuthMethod: 'none',
    registrationClientUri: `${AUTHORIZATION_SERVER}/register/client-1`,
    registrationAccessToken: 'registration-token-1',
  })
  expect(adoption.registration).not.toHaveProperty('registrationAccessToken')
})

test('adopt reports an existing registration rather than overwriting it', async () => {
  const { store, t } = await fixture()
  const first = await store.adopt({
    authorizationServer: AUTHORIZATION_SERVER,
    clientId: 'client-1',
  })

  const adoption = await store.adopt({
    authorizationServer: AUTHORIZATION_SERVER,
    clientId: 'client-2',
  })

  expect(adoption).toEqual({
    status: 'exists',
    registration: {
      id: first.registration.id,
      authorizationServer: AUTHORIZATION_SERVER,
      clientId: 'client-1',
    },
  })
  expect(
    await t.run(async ctx =>
      (await ctx.db.query('mcpClientRegistrations').collect()).map(row => row.clientId),
    ),
  ).toEqual(['client-1'])
})

test('an invalidated registration is not a registration the next connect may reuse', async () => {
  const { store } = await fixture()
  const adopted = await store.adopt({
    authorizationServer: AUTHORIZATION_SERVER,
    clientId: 'client-1',
  })

  await store.invalidate(adopted.registration.id, 'invalid_client')

  expect(await store.read(AUTHORIZATION_SERVER)).toBeNull()
})

async function fixture() {
  const t = convexTest(schema, {
    '../../../../packages/backend/convex/_generated/api.ts': async () => ({}),
    '../../../../packages/backend/convex/domains/mcpServers/credentials.ts': () =>
      import('../../../../packages/backend/convex/domains/mcpServers/credentials'),
  })
  const workspaceId = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'registrations@example.test',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    return await ctx.db.insert('workspaces', {
      slug: 'registration-fixture',
      name: 'Registration fixture',
      status: 'active',
      billingUserId: userId,
      createdAt: 1,
    })
  })
  const convex = {
    query: t.query.bind(t),
    mutation: t.mutation.bind(t),
  } as unknown as Pick<ConvexHttpClient, 'query' | 'mutation'>
  return {
    t,
    store: convexMcpRegistrationStore({
      convex: convex as ConvexHttpClient,
      internalKey: 'internal-secret',
      workspaceId,
      now: () => 1_000,
    }),
  }
}
