import { expect, test } from 'bun:test'

import { Hono } from 'hono'

import { MarketplaceCatalogResponseSchema } from '@repo/contract'

import { GatewayClient } from '../gateway/client'
import type { ApiRouteRuntime, ApiVariables } from '../shared'
import { registerMarketplaceAgentsRoutes } from './marketplace'

test('verified catalog cursors traverse empty first, middle, and terminal pages without losing their filter', async () => {
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
  const runtime = {
    convex: {
      query: async (_reference: unknown, args: { paginationOpts: { cursor: string | null } }) => {
        const cursor = args.paginationOpts.cursor
        return cursor === null
          ? {
              page: [listing('community', false)],
              continueCursor: 'middle',
              isDone: false,
              canPublishListings: false,
            }
          : cursor === 'middle'
            ? {
                page: [listing('community-middle', false)],
                continueCursor: 'official',
                isDone: false,
                canPublishListings: false,
              }
            : cursor === 'official'
              ? {
                  page: [listing('official', true)],
                  continueCursor: 'terminal',
                  isDone: false,
                  canPublishListings: false,
                }
              : {
                  page: [listing('community-2', false)],
                  continueCursor: 'done',
                  isDone: true,
                  canPublishListings: false,
                }
      },
    },
    internalKey: 'internal',
  } as unknown as ApiRouteRuntime
  const gateway = new GatewayClient({
    convex: runtime.convex,
    internalKey: runtime.internalKey,
    fetchImpl: fetch,
    now: Date.now,
  })
  registerMarketplaceAgentsRoutes(app, runtime, gateway)

  const first = MarketplaceCatalogResponseSchema.parse(
    await (await app.request('/v1/marketplace?verifiedPublisher=true&limit=1')).json(),
  )
  expect(first.items).toEqual([])
  expect(first.nextCursor).toBeString()

  const middle = MarketplaceCatalogResponseSchema.parse(
    await (
      await app.request(
        `/v1/marketplace?verifiedPublisher=true&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      )
    ).json(),
  )
  expect(middle.items).toEqual([])
  expect(middle.nextCursor).toBeString()

  const official = MarketplaceCatalogResponseSchema.parse(
    await (
      await app.request(
        `/v1/marketplace?verifiedPublisher=true&limit=1&cursor=${encodeURIComponent(middle.nextCursor!)}`,
      )
    ).json(),
  )
  expect(official.items.map(item => item.agentName)).toEqual(['official'])
  expect(official.nextCursor).toBeString()

  const terminal = MarketplaceCatalogResponseSchema.parse(
    await (
      await app.request(
        `/v1/marketplace?verifiedPublisher=true&limit=1&cursor=${encodeURIComponent(official.nextCursor!)}`,
      )
    ).json(),
  )
  expect(terminal).toMatchObject({ items: [], nextCursor: null })
  expect(
    (
      await app.request(
        `/v1/marketplace?verifiedPublisher=false&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      )
    ).status,
  ).toBe(400)
})

function listing(agentName: string, verifiedPublisher: boolean) {
  return {
    id: `listing-${agentName}`,
    publisherSlug: 'publisher',
    verifiedPublisher,
    agentName,
    title: agentName,
    summary: agentName,
    skills: [],
    tags: [],
    appNames: [],
    installs: 0,
    availability: 'available' as const,
  }
}
