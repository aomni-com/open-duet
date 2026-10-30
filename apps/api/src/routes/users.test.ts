import { expect, test } from 'bun:test'

import { Hono } from 'hono'

import { GatewayClient } from '../gateway/client'
import type { ApiRouteRuntime, ApiVariables } from '../shared'
import { registerUserRoutes } from './users'

test('OAuth grant inventory exposes one bound public page at a time', async () => {
  const cursors: Array<string | null> = []
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use('*', async (context, next) => {
    context.set('auth', {
      credentialKind: 'browser_session',
      user: { id: 'user_1', email: 'owner@example.test' },
      workspaces: [],
      scopes: [],
      versions: { api: 1 },
    })
    await next()
  })
  const rows = [grant('grant_1', 'First client'), grant('grant_2', 'Second client')]
  const runtime = {
    convex: {
      query: async (_reference: unknown, args: { paginationOpts: { cursor: string | null } }) => {
        cursors.push(args.paginationOpts.cursor)
        const index = args.paginationOpts.cursor === null ? 0 : 1
        return {
          page: [rows[index]],
          isDone: index === 1,
          continueCursor: index === 0 ? 'next-page' : 'done',
        }
      },
    },
    internalKey: 'internal',
  } as unknown as ApiRouteRuntime
  const gatewayClient = new GatewayClient({
    convex: runtime.convex,
    internalKey: runtime.internalKey,
    fetchImpl: fetch,
    now: Date.now,
  })
  registerUserRoutes(app, runtime, gatewayClient)

  const response = await app.request('/v1/user/oauth-grants?limit=1')

  expect(response.status).toBe(200)
  expect(cursors).toEqual([null])
  const first = (await response.json()) as { items: unknown[]; nextCursor: string }
  expect(first).toEqual({
    items: [expect.objectContaining({ id: 'grant_1', clientName: 'First client' })],
    nextCursor: expect.any(String),
  })

  const secondResponse = await app.request(
    `/v1/user/oauth-grants?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
  )
  expect(cursors).toEqual([null, 'next-page'])
  expect(await secondResponse.json()).toEqual({
    items: [expect.objectContaining({ id: 'grant_2', clientName: 'Second client' })],
    nextCursor: null,
  })
})

function grant(id: string, clientName: string) {
  return {
    id,
    client: { id: `client_${id}`, name: clientName },
    redirectHost: 'client.example',
    workspace: { slug: 'acme', name: 'Acme' },
    capabilities: ['files:read'],
    scopes: ['ws:acme:files:read'],
    audience: 'https://mcp.duet.so/',
    generation: 1,
    createdAt: 1,
  }
}

test('one human login registers two machine identities and removes only one without rotating the key', async () => {
  const { convexTest } = await import('convex-test')
  const { default: schema } = await import('../../../../packages/backend/convex/schema')
  const prior = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'machine-route-fixture'
  try {
    const t = convexTest(schema, {
      '../convex/_generated/api.ts': async () => ({}),
      '../convex/domains/syncMachines/api.ts': () =>
        import('../../../../packages/backend/convex/domains/syncMachines/api'),
    })
    const userId = await t.run(ctx =>
      ctx.db.insert('users', {
        email: 'machines@example.test',
        createdAt: 1,
        updatedAt: 1,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
      }),
    )
    const app = new Hono<{ Variables: ApiVariables }>()
    app.use('*', async (c, next) => {
      c.set('auth', {
        credentialKind: 'user',
        credentialId: 'same-login-key',
        user: { id: userId, email: 'machines@example.test' },
        workspaces: [],
        scopes: [],
        versions: { api: 1 },
      })
      await next()
    })
    const runtime = {
      internalKey: 'machine-route-fixture',
      now: () => 10,
      convex: {
        mutation: (reference: unknown, args: object) =>
          t.mutation(reference as Parameters<typeof t.mutation>[0], args),
        query: (reference: unknown, args: object) =>
          t.query(reference as Parameters<typeof t.query>[0], args),
      },
    } as unknown as ApiRouteRuntime
    const gateway = new GatewayClient({
      convex: runtime.convex,
      internalKey: runtime.internalKey,
      fetchImpl: fetch,
      now: Date.now,
    })
    registerUserRoutes(app, runtime, gateway)
    const register = async (name: string, syncthingDeviceId: string) => {
      const response = await app.request('/v1/user/sync-machines', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, syncthingDeviceId }),
      })
      expect(response.status).toBe(200)
      return (await response.json()) as { machineId: string; name: string }
    }
    const laptop = await register('Laptop', 'AAAAAAA-BBBBBBB')
    const desktop = await register('Desktop', 'CCCCCCC-DDDDDDD')
    expect(laptop.machineId).not.toBe(desktop.machineId)
    expect(await register('Laptop', 'AAAAAAA-BBBBBBB')).toEqual(laptop)
    const removed = await app.request(`/v1/user/sync-machines/${laptop.machineId}`, {
      method: 'DELETE',
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ ok: true, machineId: laptop.machineId, removedAt: 10 })
    const retry = await app.request(`/v1/user/sync-machines/${laptop.machineId}`, {
      method: 'DELETE',
    })
    expect(await retry.json()).toEqual({ ok: true, machineId: laptop.machineId, removedAt: 10 })
    const listed = (await (await app.request('/v1/user/sync-machines')).json()) as {
      items: Array<{ machineId: string; removedAt?: number }>
    }
    expect(listed.items.find(machine => machine.machineId === desktop.machineId)).toMatchObject({
      machineId: desktop.machineId,
      name: 'Desktop',
    })
    expect(
      listed.items.find(machine => machine.machineId === desktop.machineId)?.removedAt,
    ).toBeUndefined()
    // The API never creates or rotates a credential while managing machines.
    expect(await t.run(ctx => ctx.db.query('apiKeys').collect())).toEqual([])
  } finally {
    if (prior === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = prior
  }
})
