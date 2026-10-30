import { describe, expect, test } from 'bun:test'

import type { ConvexHttpClient } from 'convex/browser'
import { Hono } from 'hono'

import {
  API_VERSION,
  COLLECTION_PAGE_DEFAULT_LIMIT,
  COLLECTION_PAGE_MAX_LIMIT,
  type GatewayAgentRosterResponse,
} from '@repo/contract'

import type { GatewayClient } from '../gateway/client'
import { createApiApp } from '../index'
import type { ApiRouteRuntime, ApiVariables, AuthPayload } from '../shared'
import { registerAgentRosterRoutes } from './agent-roster'

const ROSTER: GatewayAgentRosterResponse = {
  rows: [
    { slug: 'writer', name: 'Writer', path: 'agents/writer', locked: false, relationship: 'self' },
    { slug: 'root', name: 'HQ', locked: false, relationship: 'parent' },
    {
      slug: 'editor',
      name: 'Editor',
      path: 'agents/editor',
      locked: false,
      relationship: 'sibling',
    },
    {
      slug: 'drafter',
      name: 'Drafter',
      path: 'agents/writer/drafter',
      locked: false,
      relationship: 'child',
    },
  ],
}

const WRITER_ROW = {
  id: 'writer-agent',
  anchorPath: 'agents/writer',
  anchorState: 'active',
}

function browserAuth(overrides: Partial<AuthPayload> = {}): AuthPayload {
  return {
    credentialKind: 'browser_session',
    user: { id: 'usr_1', email: 'member@example.com' },
    workspaces: [{ id: 'workspace-1', slug: 'acme', role: 'owner', onboardedAt: 1 }],
    scopes: ['ws:acme:sessions'],
    versions: API_VERSION,
    ...overrides,
  } as AuthPayload
}

function buildApp(input: {
  auth: AuthPayload
  agent?: Record<string, unknown> | null
  roster?: GatewayAgentRosterResponse | Response
}) {
  const queries: unknown[] = []
  const rosterCalls: { workspaceSlug: string; agentId: string | undefined }[] = []
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use('*', async (c, next) => {
    c.set('auth', input.auth)
    await next()
  })
  const runtime = {
    convex: {
      query: async (_reference: unknown, args: unknown) => {
        queries.push(args)
        if ((args as { slug?: string }).slug === 'root') throw new Error('reserved agent slug')
        return input.agent ?? null
      },
    } as unknown as ConvexHttpClient,
    internalKey: 'internal-key',
  } as ApiRouteRuntime
  const gatewayClient = {
    readAgentRoster: async (workspaceSlug: string, agentId: string | undefined) => {
      rosterCalls.push({ workspaceSlug, agentId })
      return input.roster ?? ROSTER
    },
  } as unknown as GatewayClient
  registerAgentRosterRoutes(app, runtime, gatewayClient)
  return { app, queries, rosterCalls }
}

const path = (agentSlug: string, query = '') =>
  `/v1/ws/acme/agents/${agentSlug}/roster${query.length === 0 ? '' : `?${query}`}`

describe('agent roster proxy', () => {
  /* `root` is reserved in the slug grammar, so it can never name a real agent —
     and the lookup would throw on it rather than miss. Answering before the
     query is what makes the drive root an owner like any agent. */
  test('answers the drive root without asking the database for an agent', async () => {
    const { app, queries, rosterCalls } = buildApp({ auth: browserAuth() })

    const response = await app.request(path('root'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: ROSTER.rows, nextCursor: null })
    expect(queries).toEqual([])
    expect(rosterCalls).toEqual([{ workspaceSlug: 'acme', agentId: undefined }])
  })

  test('carries a launchable agent to the VM by id, never by slug', async () => {
    const { app, rosterCalls } = buildApp({ auth: browserAuth(), agent: WRITER_ROW })

    const response = await app.request(path('writer'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: ROSTER.rows, nextCursor: null })
    expect(rosterCalls).toEqual([{ workspaceSlug: 'acme', agentId: 'writer-agent' }])
  })

  test('pages the gateway order with a bound opaque continuation', async () => {
    const { app } = buildApp({ auth: browserAuth() })

    const first = await app.request(path('root', 'limit=2'))
    expect(first.status).toBe(200)
    const firstPage = (await first.json()) as { items: unknown[]; nextCursor: string | null }
    expect(firstPage.items).toEqual(ROSTER.rows.slice(0, 2))
    expect(firstPage.nextCursor).toEqual(expect.any(String))

    const second = await app.request(
      path('root', `limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`),
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ items: ROSTER.rows.slice(2), nextCursor: null })
  })

  test('uses the shared page default without hiding the final row', async () => {
    const rows: GatewayAgentRosterResponse['rows'] = [
      { slug: 'root', name: 'Duet', locked: false, relationship: 'self' },
      ...Array.from({ length: COLLECTION_PAGE_DEFAULT_LIMIT }, (_, index) => {
        const slug = `agent-${String(index).padStart(2, '0')}`
        return {
          slug,
          name: slug,
          path: `agents/${slug}`,
          locked: false,
          relationship: 'child' as const,
        }
      }),
    ]
    const { app } = buildApp({ auth: browserAuth(), roster: { rows } })

    const first = (await (await app.request(path('root'))).json()) as {
      items: unknown[]
      nextCursor: string
    }
    expect(first.items).toEqual(rows.slice(0, COLLECTION_PAGE_DEFAULT_LIMIT))
    const final = await app.request(path('root', `cursor=${encodeURIComponent(first.nextCursor)}`))
    expect(await final.json()).toEqual({
      items: rows.slice(COLLECTION_PAGE_DEFAULT_LIMIT),
      nextCursor: null,
    })
  })

  test('rejects unknown query keys and limits above the universal maximum', async () => {
    const unknown = buildApp({ auth: browserAuth() })
    expect((await unknown.app.request(path('root', 'offset=1'))).status).toBe(400)
    expect(unknown.rosterCalls).toEqual([])

    const oversized = buildApp({ auth: browserAuth() })
    expect(
      (await oversized.app.request(path('root', `limit=${COLLECTION_PAGE_MAX_LIMIT + 1}`))).status,
    ).toBe(400)
    expect(oversized.rosterCalls).toEqual([])
  })

  test('rejects a cursor from another agent roster', async () => {
    const { app } = buildApp({ auth: browserAuth(), agent: WRITER_ROW })
    const first = (await (await app.request(path('root', 'limit=1'))).json()) as {
      nextCursor: string
    }

    const response = await app.request(
      path('writer', `limit=1&cursor=${encodeURIComponent(first.nextCursor)}`),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_cursor' })
  })

  /* A disabled agent has no folder to run in, so it has no roster either — the
     same miss an unknown slug gets, rather than the VM's answer for a scope
     that should not resolve. */
  test('a disabled agent is a miss, and reaches no VM', async () => {
    const { app, rosterCalls } = buildApp({
      auth: browserAuth(),
      agent: { ...WRITER_ROW, disabledAt: 1_700_000_000_000 },
    })

    const response = await app.request(path('writer'))

    expect(response.status).toBe(404)
    expect(rosterCalls).toEqual([])
  })

  test('an unknown slug is a miss, and reaches no VM', async () => {
    const { app, rosterCalls } = buildApp({ auth: browserAuth(), agent: null })

    expect((await app.request(path('ghost'))).status).toBe(404)
    expect(rosterCalls).toEqual([])
  })

  /* "We could not ask" must survive the proxy: flattening it into 200 with an
     empty roster would tell a session it has no colleagues. */
  test('an unavailable VM keeps its status rather than becoming an empty roster', async () => {
    const { app } = buildApp({
      auth: browserAuth(),
      roster: Response.json({ error: 'workspace_vm_unavailable' }, { status: 503 }),
    })

    const response = await app.request(path('root'))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'workspace_vm_unavailable' })
  })

  test('an unauthenticated reader never reaches the route', async () => {
    const app = createApiApp({
      convexUrl: 'https://unused.convex.cloud',
      internalKey: 'internal-key',
    })
    const response = await app.request(path('root'))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  test('a user API key with sessions capability can read the same roster', async () => {
    const { app } = buildApp({ auth: browserAuth({ credentialKind: 'user' }) })

    const response = await app.request(path('root'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: ROSTER.rows, nextCursor: null })
  })

  test('an app key needs the sessions capability and can read when granted', async () => {
    const granted = buildApp({
      auth: browserAuth({ credentialKind: 'app', app: { id: 'app_1', slug: 'planner' } }),
    })
    expect((await granted.app.request(path('root'))).status).toBe(200)

    const refused = buildApp({
      auth: browserAuth({
        credentialKind: 'app',
        app: { id: 'app_1', slug: 'planner' },
        scopes: ['ws:acme:files:read'],
      }),
    })
    const response = await refused.app.request(path('root'))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'insufficient_scope',
      scope: 'ws:acme:sessions',
    })
    expect(refused.rosterCalls).toEqual([])
  })

  test('a workspace the reader is not a member of is a miss', async () => {
    const { app, rosterCalls } = buildApp({ auth: browserAuth({ workspaces: [] }) })

    expect((await app.request(path('root'))).status).toBe(404)
    expect(rosterCalls).toEqual([])
  })
})
