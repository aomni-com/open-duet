/* What landing in a workspace pays so that opening any agent afterwards is
   instant. The preload's whole contract is cache state: every read the agent
   page gates on must already be answered under the exact key that page will
   ask with, so these tests assert the cache through the same option factories
   the page mounts. */
import { expect, test } from 'bun:test'

import type { QueryClient } from '@tanstack/react-query'

import { ROOT_AGENT_SCOPE, type Agent } from '@repo/contract'

import { createDuetQueryClient } from '../api/query-client'
import type { SpaApi } from '../context'
import { agentConfigQueryOptions } from '../drive/agent-config'
import { agentRoleQueryOptions } from '../drive/agent-profile'
import { sessionKeys } from '../sessions/session-data'
import { preloadAgentPages } from './preload-agent-pages'
import { agentFilesQueryOptions } from './use-agent-reads'

function agent(slug: string): Agent {
  return {
    id: `agent_${slug}`,
    workspaceId: 'ws-acme',
    anchorId: `anchor-${slug}`,
    anchorPath: `agents/${slug}`,
    anchorState: 'active',
    slug,
    name: slug,
    createdAt: 1,
    updatedAt: 2,
  }
}

/* The product's own client, not a bare one: retention and refetch policy are
   what decide whether a warmed entry is still there when the reader opens that
   agent, so a harness that supplied its own defaults would be testing a warmer
   this product does not ship. */
function client(): QueryClient {
  return createDuetQueryClient()
}

/** An api whose every read answers empty — the quiet-drive baseline. */
function quietApi(overrides: Partial<SpaApi> = {}): SpaApi {
  return {
    readOptionalWorkspaceFile: async () => ({ data: new TextEncoder().encode('{}') }),
    listOptionalWorkspaceFiles: async () => null,
    listWorkspaceFiles: async (_ws: string, path: string) => ({
      items: [
        {
          name: 'brief.md',
          path: `${path}/brief.md`,
          type: 'file',
          size: 5,
          mtime: '2026-07-15T08:00:00.000Z',
        },
      ],
      nextCursor: null,
    }),
    getDefaultSession: async () => null,
    getSession: async () => {
      throw new Error('no session should be read')
    },
    getSessionHistory: async () => {
      throw new Error('no history should be read')
    },
    ...overrides,
  } as unknown as SpaApi
}

/* The full-page skeleton is gated on exactly one cold read: the agent's
   `agent.json`. After the preload, that read must already be settled for every
   agent on the drive, under the key the agent page asks with. */
test('preloading settles every agent’s config and folder contents before opening', async () => {
  const queryClient = client()
  const api = quietApi()

  await preloadAgentPages(api, queryClient, 'acme', [agent('a0'), agent('a1')])

  for (const slug of ['a0', 'a1']) {
    const state = queryClient.getQueryState(
      agentConfigQueryOptions(api, 'acme', {
        id: `agent_${slug}`,
        anchorPath: `agents/${slug}`,
      }).queryKey,
    )
    expect(state?.status).toBe('success')
    expect(
      queryClient.getQueryData(agentFilesQueryOptions(api, 'acme', `agents/${slug}`).queryKey),
    ).toMatchObject({
      pages: [{ items: [{ name: 'brief.md', path: `agents/${slug}/brief.md` }], nextCursor: null }],
    })
  }
})

/* The chat pane's skeleton waits on the session's snapshot and its transcript,
   and both are addressed by an id only the default-chat alias can answer — so
   the preload must chain: alias, then the two reads under that id. */
test('an agent with a chat gets its transcript warmed under the chat’s own id', async () => {
  const queryClient = client()
  const api = quietApi({
    getDefaultSession: async (_ws: string, agentSlug: string) =>
      agentSlug === 'a0' ? { id: 'sess-a0' } : null,
    getSession: async (_ws: string, sessionId: string) => ({ id: sessionId }),
    getSessionHistory: async () => ({ items: [], nextCursor: null }),
  } as unknown as Partial<SpaApi>)

  await preloadAgentPages(api, queryClient, 'acme', [agent('a0')])

  expect(queryClient.getQueryData<{ id: string }>(sessionKeys.detail('acme', 'sess-a0'))).toEqual({
    id: 'sess-a0',
  })
  expect(
    queryClient.getQueryData<{ events: unknown[]; nextCursor: string | null }>(
      sessionKeys.history('acme', 'sess-a0'),
    ),
  ).toMatchObject({ events: [], nextCursor: null })
})

/* `null` is the alias's ordinary answer — an owner nobody has written to yet,
   which on a fresh drive is most of the ring. There is no id to read under, so
   a transcript request here would be a request for nothing; prefetch swallows
   errors, so the cache is checked too, not just the throwing fakes. */
test('an owner with no chat costs no transcript reads', async () => {
  const queryClient = client()
  const reads: string[] = []
  const api = quietApi({
    getSession: async (_ws: string, sessionId: string) => {
      reads.push(sessionId)
      throw new Error('no session should be read')
    },
  } as unknown as Partial<SpaApi>)

  await preloadAgentPages(api, queryClient, 'acme', [agent('a0')])

  expect(reads).toEqual([])
  const sessionEntries = queryClient
    .getQueryCache()
    .getAll()
    .filter(query =>
      (query.queryKey as readonly unknown[]).some(part => part === 'detail' || part === 'history'),
    )
  expect(sessionEntries.map(query => query.queryKey)).toEqual([])
})

/* The roster is a permanent column, so its rows are on screen at first
   paint and every one of them reads its agent's `AGENTS.md` for the line under
   the name. Warmed here, that is one batched read per agent off the critical
   path instead of a fan-out fired by the landing itself — and it only counts if
   it lands under the key the row asks with. */
test('the line under each roster row’s name is warmed for every agent', async () => {
  const queryClient = client()
  const api = quietApi({
    readOptionalWorkspaceFile: async (_ws: string, path: string) => ({
      data: new TextEncoder().encode(`# Title\n\nThe role of ${path}\n`),
    }),
  } as unknown as Partial<SpaApi>)

  await preloadAgentPages(api, queryClient, 'acme', [agent('a0'), agent('a1')])

  for (const slug of ['a0', 'a1']) {
    expect(
      queryClient.getQueryData<string | null>(
        agentRoleQueryOptions(api, 'acme', {
          id: `agent_${slug}`,
          anchorPath: `agents/${slug}`,
        }).queryKey,
      ),
    ).toBe(`The role of agents/${slug}/AGENTS.md`)
  }
})

/* The map's centre is the drive root's own conversation — an owner like any
   agent, addressed under its reserved slug. Landing on an agent page directly
   must still leave the centre's chat warm for the flight back to the map. */
test('the drive root’s own chat is warmed alongside the fleet', async () => {
  const queryClient = client()
  const api = quietApi({
    getDefaultSession: async (_ws: string, agentSlug: string) =>
      agentSlug === 'root' ? { id: 'sess-root' } : null,
    getSession: async (_ws: string, sessionId: string) => ({ id: sessionId }),
    getSessionHistory: async () => ({ items: [], nextCursor: null }),
  } as unknown as Partial<SpaApi>)

  await preloadAgentPages(api, queryClient, 'acme', [agent('a0')])

  expect(queryClient.getQueryData<{ id: string }>(sessionKeys.detail('acme', 'sess-root'))).toEqual(
    { id: 'sess-root' },
  )
})

/* Duet is a row on the roster like any agent, and the line under its name is
   the drive root's own `AGENTS.md` — read from the empty anchor, which is the
   one path `joinDrivePath` has to special-case. Warmed with the root's chat,
   because the row is drawn whether or not the reader ever opens the drive. */
test('the drive root’s own line is warmed beside its chat', async () => {
  const queryClient = client()
  const api = quietApi({
    readOptionalWorkspaceFile: async (_ws: string, path: string) => ({
      data: new TextEncoder().encode(`The role of ${path}\n`),
    }),
  } as unknown as Partial<SpaApi>)

  await preloadAgentPages(api, queryClient, 'acme', [agent('a0')])

  expect(
    queryClient.getQueryData<string | null>(
      agentRoleQueryOptions(api, 'acme', { id: ROOT_AGENT_SCOPE, anchorPath: '' }).queryKey,
    ),
  ).toBe('The role of AGENTS.md')
})

/* One agent's broken folder is that agent's problem to retell on open. The
   preload must neither reject nor leave the rest of the fleet cold behind it. */
test('one failing agent leaves the rest of the fleet warm', async () => {
  const queryClient = client()
  const api = quietApi({
    listWorkspaceFiles: async (_ws: string, path: string) => {
      if (path.includes('a0')) throw new Error('folder unavailable')
      return { items: [], nextCursor: null }
    },
    listOptionalWorkspaceFiles: async (_ws: string, path: string) => {
      if (path.includes('a0')) throw new Error('skills folder unavailable')
      return null
    },
    getDefaultSession: async () => {
      throw new Error('alias unavailable')
    },
  } as unknown as Partial<SpaApi>)

  await preloadAgentPages(api, queryClient, 'acme', [agent('a0'), agent('a1')])

  const config = (slug: string) =>
    queryClient.getQueryState(
      agentConfigQueryOptions(api, 'acme', {
        id: `agent_${slug}`,
        anchorPath: `agents/${slug}`,
      }).queryKey,
    )
  expect(config('a0')?.status).toBe('success')
  expect(config('a1')?.status).toBe('success')
})

/* The preload shares the wire with the landing page's own critical reads, so
   its burst has an explicit ceiling: a few owners at a time, each owner at
   most five reads wide — the transcript pair waits for the owner's first wave
   rather than piling on top of it, which the deliberately fast alias next to
   deliberately slow folder reads here would expose. The whole fleet still gets
   warmed: the ceiling queues work, it never drops it. */
test('warming a large fleet keeps a bounded number of reads in flight', async () => {
  const queryClient = client()
  let inFlight = 0
  let peak = 0
  const delay = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  const tracked =
    <T>(value: T, ticks: number) =>
    async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await delay(ticks)
      inFlight -= 1
      return value
    }
  const api = quietApi({
    readOptionalWorkspaceFile: tracked({ data: new TextEncoder().encode('{}') }, 3),
    listOptionalWorkspaceFiles: tracked({ items: [], nextCursor: null }, 3),
    listWorkspaceFiles: tracked({ items: [], nextCursor: null }, 3),
    getDefaultSession: tracked({ id: 'sess' }, 1),
    getSession: tracked({ id: 'sess' }, 1),
    getSessionHistory: tracked({ items: [], nextCursor: null }, 1),
  } as unknown as Partial<SpaApi>)
  const fleet = Array.from({ length: 12 }, (_, index) => agent(`a${index}`))

  await preloadAgentPages(api, queryClient, 'acme', fleet)

  expect(peak).toBeLessThanOrEqual(20)
  const configs = fleet.map(
    member =>
      queryClient.getQueryState(agentConfigQueryOptions(api, 'acme', member).queryKey)?.status,
  )
  expect(configs).toEqual(Array.from({ length: 12 }, () => 'success' as const))
})

/* Leaving the workspace removes its cache entries wholesale; a preload that
   kept marching would recreate entries for a drive the reader just left. The
   flag is consulted before every batch, the first included. */
test('a cancelled preload warms nothing more', async () => {
  const queryClient = client()

  await preloadAgentPages(quietApi(), queryClient, 'acme', [agent('a0')], () => true)
  expect(queryClient.getQueryCache().getAll()).toEqual([])

  /* Mid-flight: cancel the moment the first request starts. Early batches may
     finish — bounded — but the fleet's tail must stay cold. (Twelve agents so
     the tail outreaches any sane batch width.) */
  let started = false
  const api = quietApi({
    readOptionalWorkspaceFile: async () => {
      started = true
      return { data: new TextEncoder().encode('{}') }
    },
  } as unknown as Partial<SpaApi>)
  const fleet = Array.from({ length: 12 }, (_, index) => agent(`a${index}`))
  await preloadAgentPages(api, queryClient, 'acme', fleet, () => started)

  const statuses = fleet.map(
    member =>
      queryClient.getQueryState(agentConfigQueryOptions(api, 'acme', member).queryKey)?.status,
  )
  expect(statuses).toContain('success')
  expect(statuses).toContain(undefined)
})

/* Warming is only worth doing if what it warmed is still there when the reader
   arrives, and how long that is has exactly one owner — the client's own
   retention. This pins the relationship rather than the number: an entry warmed
   with no observer must not be given a shorter clock than everything else in
   the cache, which is what a well-meaning `gcTime` override here would do. */
test('a warmed entry keeps the same retention as every other answer', async () => {
  const queryClient = client()

  await preloadAgentPages(quietApi(), queryClient, 'acme', [agent('a0')])

  const warmed = queryClient.getQueryCache().getAll()
  expect(warmed.length).toBeGreaterThan(0)
  const distinct: Array<number | undefined> = [...new Set(warmed.map(query => query.gcTime))]
  expect(distinct).toEqual([queryClient.getDefaultOptions().queries?.gcTime])
})
