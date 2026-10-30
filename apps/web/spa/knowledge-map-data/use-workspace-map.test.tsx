/* What the home surface costs, what its centre is allowed to claim, and what
   Duet answers for.

   The request count is the whole reason this module exists in the shape it
   does, so it is asserted rather than described. */
import { expect, test } from 'bun:test'

import { InfiniteQueryObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ActivitySessionSummary, Agent, App, FileEntry } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import { duetQueryOptions } from '../api/query-options'
import { SpaContext, type SpaApi, type SpaContextValue } from '../context'
import { agentSkillsQueryOptions } from '../drive/agent-profile'
import { agentFilesQueryOptions, useAgentReads, type AgentReads } from './use-agent-reads'
import {
  useMapClock,
  useWorkspaceMap,
  type WorkspaceMapOptions,
  type WorkspaceMapState,
} from './use-workspace-map'

function session(id: string, bucket: ActivitySessionSummary['bucket']): ActivitySessionSummary {
  return {
    id,
    bucket,
    title: id,
    updatedAt: 2,
    unread: false,
  }
}

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

/** Runs the two reads opening an agent makes, and reports the paths they asked for. */
async function pathsFor(anchorPath: string): Promise<string[]> {
  const paths: string[] = []
  const list = async (_slug: string, path: string) => {
    paths.push(path)
    return { items: [], nextCursor: null }
  }
  // The folder is a required read, the skills folder an optional one.
  const api = { listWorkspaceFiles: list, listOptionalWorkspaceFiles: list } as unknown as SpaApi
  const signal = new AbortController().signal
  const run = async (options: { queryFn?: unknown }) =>
    (options.queryFn as (ctx: { signal: AbortSignal }) => Promise<unknown>)({ signal })

  await run(agentFilesQueryOptions(api, 'acme', anchorPath))
  await run(agentSkillsQueryOptions(api, 'acme', { id: 'a0', anchorPath }))
  return paths
}

/* The ring draws no counts off an agent's folder any more, so nothing is read
   until a face is opened — and then it is two reads for one agent, never a fan
   across the fleet. */
test('opening an agent reads its own folder and its own skills, and nothing else', async () => {
  expect(await pathsFor('agents/a0')).toEqual(['agents/a0', 'agents/a0/.agents/skills'])
})

/* Duet is the drive root, so its anchor is the empty path. Joined the naive way
   that yields a leading slash, which the file client reads as an *absolute*
   path and sends as `%2F…` — so the drive's own skills came back empty rather
   than missing, which is the exact shape of lie this surface must not tell. */
test('Duet reads the drive root itself, not a path hanging off it', async () => {
  expect(await pathsFor('')).toEqual(['', '.agents/skills'])
})

function renderAgentReads(queryClient: QueryClient, api: SpaApi): AgentReads {
  let reads: AgentReads | undefined
  function Probe() {
    reads = useAgentReads(
      'acme',
      { id: 'agent_research', anchorPath: 'agents/research' },
      Date.UTC(2026, 6, 15),
      { when: () => 'today' },
    )
    return null
  }
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        SpaContext.Provider,
        { value: { api } as unknown as SpaContextValue },
        createElement(Probe),
      ),
    ),
  )
  if (reads === undefined) throw new Error('the reads probe never rendered')
  return reads
}

test('a Files refresh failure retains the loaded folder through the production read', async () => {
  let failFiles = false
  const file: FileEntry = {
    name: 'brief.md',
    path: 'agents/research/brief.md',
    type: 'file',
    size: 42,
    mtime: '2026-07-15T08:00:00.000Z',
  }
  const api = {
    listWorkspaceFiles: async (_slug: string, path: string) => {
      if (path === 'agents/research') {
        if (failFiles) throw new Error('folder refresh unavailable')
        return { items: [file], nextCursor: null }
      }
      return { items: [], nextCursor: null }
    },
  } as unknown as SpaApi
  const queryClient = client()
  const options = agentFilesQueryOptions(api, 'acme', 'agents/research')
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})
  await observer.refetch()
  failFiles = true
  await observer.refetch()

  const reads = renderAgentReads(queryClient, api)

  expect(reads.files.phase).toBe('ready')
  expect(reads.files.items.map(item => item.title)).toEqual(['brief.md'])
  unsubscribe()
})

test('a Files continuation failure retains the loaded folder through the production read', async () => {
  const file: FileEntry = {
    name: 'brief.md',
    path: 'agents/research/brief.md',
    type: 'file',
    size: 42,
    mtime: '2026-07-15T08:00:00.000Z',
  }
  const api = {
    listWorkspaceFiles: async (_slug: string, path: string, request: { cursor?: string }) => {
      if (path !== 'agents/research') return { items: [], nextCursor: null }
      if (request.cursor !== undefined) throw new Error('folder continuation unavailable')
      return { items: [file], nextCursor: 'files-page-2' }
    },
  } as unknown as SpaApi
  const queryClient = client()
  const options = agentFilesQueryOptions(api, 'acme', 'agents/research')
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})
  await observer.refetch()
  await observer.fetchNextPage().catch(() => {})

  const reads = renderAgentReads(queryClient, api)
  expect(reads.files.phase).toBe('ready')
  expect(reads.files.items.map(item => item.title)).toEqual(['brief.md'])
  expect(reads.files.moreFailed).toBe(true)
  expect(reads.files.onLoadMore).toBeFunction()
  unsubscribe()
})

test('a Skills refresh failure retains the loaded skills through the production read', async () => {
  let failSkills = false
  const api = {
    listOptionalWorkspaceFiles: async (_slug: string, path: string) => {
      if (path !== 'agents/research/.agents/skills') return { items: [], nextCursor: null }
      if (failSkills) throw new Error('skills refresh unavailable')
      return {
        items: [
          {
            name: 'research',
            path: `${path}/research`,
            type: 'directory' as const,
            size: 0,
            mtime: '2026-07-15T08:00:00.000Z',
          },
        ],
        nextCursor: null,
      }
    },
  } as unknown as SpaApi
  const queryClient = client()
  const options = agentSkillsQueryOptions(api, 'acme', {
    id: 'agent_research',
    anchorPath: 'agents/research',
  })
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})
  await observer.refetch()
  failSkills = true
  await observer.refetch()

  const reads = renderAgentReads(queryClient, api)
  expect(reads.skills.phase).toBe('ready')
  expect(reads.skills.items.map(item => item.title)).toEqual(['research'])
  unsubscribe()
})

/* ------------------------------------------------------------ the centre
   Rendered rather than called: `isError`, the counts and the clock are all
   decided from live query state, and a helper that reproduced that state by
   hand would be asserting the helper. `renderToStaticMarkup` reads the cache
   without fetching, which is exactly the seam these need. */

function app(slug: string, anchorPath: string): App {
  return {
    id: `app-${slug}`,
    workspaceId: 'ws-acme',
    anchorId: `anchor-app-${slug}`,
    anchorPath,
    anchorState: 'active',
    slug,
    name: slug,
    runtimeStatus: 'reconciled',
    createdAt: 1,
    updatedAt: 2,
  } as App
}

function appPages(items: App[] = [], nextCursor: string | null = null) {
  return {
    pages: [{ items, nextCursor, meta: { capabilities: { register: false } } }],
    pageParams: [undefined],
  }
}

function agentPages(items: Agent[] = [], nextCursor: string | null = null) {
  return { pages: [{ items, nextCursor }], pageParams: [undefined] }
}

const FAILING_API = {
  listApps: async () => {
    throw new Error('apps unavailable')
  },
} as unknown as SpaApi

/* `retryOnMount: false` is what makes a failed query observable here rather
   than a harness convenience: a fresh observer over an errored query reports an
   optimistic `pending`, because it is about to retry. On the real surface the
   apps call fails while the map is already mounted, so the observer sits in
   `error` — which is the state worth asserting against. */
function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
}

type Rendered = { state: WorkspaceMapState; nows: readonly number[]; clock: number }

function renderMap(queryClient: QueryClient, options: Partial<WorkspaceMapOptions> = {}): Rendered {
  const nows: number[] = []
  let state: WorkspaceMapState | undefined
  let clock = 0
  const spa = { api: {} as SpaApi } as unknown as SpaContextValue

  function Probe() {
    clock = useMapClock()
    state = useWorkspaceMap('acme', {
      coreLabel: 'Acme Studio',
      copy: {
        when: (_at, now) => {
          nows.push(now)
          return 'when'
        },
      },
      countsLabel: counts => JSON.stringify(counts),
      ...options,
    })
    return null
  }

  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SpaContext.Provider value={spa}>
        <Probe />
      </SpaContext.Provider>
    </QueryClientProvider>,
  )
  if (state === undefined) throw new Error('the probe never rendered')
  return { state, nows, clock }
}

/* The count is a claim about the picture beside it, and the picture now holds
   every app on the drive: the ones an agent's anchor encloses hang off that
   agent, and the ones no anchor claims — the seeded hello app is one — hang off
   the centre, because the centre is Duet and Duet is the drive. A workspace with
   three apps that read "2 apps" was the map disowning its own. */
test('the centre counts every app the drive holds, Duet’s own included', () => {
  const queryClient = client()
  queryClient.setQueryData(
    duetQueryKeys.workspaces.agents.list('acme'),
    agentPages([agent('a0'), agent('a1')]),
  )
  queryClient.setQueryData(
    duetQueryKeys.workspaces.apps.list('acme'),
    appPages([
      app('metrics', 'agents/a0/apps/metrics'),
      app('inbox', 'agents/a1/apps/inbox'),
      // outside every agent's anchor, so it is Duet's own
      app('hello', 'welcome/hello-app'),
    ]),
  )

  const { state } = renderMap(queryClient)
  expect(state.data.coreMeta).toBe(
    JSON.stringify({ agents: 2, apps: 3, agentsComplete: true, appsComplete: true }),
  )
  expect(state.data.duet.apps.map(entry => entry.id)).toEqual(['hello'])
})

/* A job asleep on a clock is unfinished work, and `seatedJobs` says so — the
   drawer draws those rows with the time they wake, and the ring seats them.
   None of that reaches production unless the map actually asks for the bucket:
   it used to read `running` and `asking` only, so "on a clock" was a state the
   fixtures could show and the product could not. The playgrounds hand the
   component its jobs directly, so no screenshot could ever have caught it. */
test('a job on a clock reaches the ring, not just the fixtures', () => {
  const queryClient = client()
  queryClient.setQueryData(duetQueryKeys.workspaces.agents.list('acme'), agentPages([agent('a0')]))
  queryClient.setQueryData(duetQueryKeys.workspaces.apps.list('acme'), appPages())
  queryClient.setQueryData(duetQueryKeys.workspaces.sessions.activity('acme'), {
    owners: [
      {
        agentId: 'agent_a0',
        sessions: [
          session('job-running', 'running'),
          session('job-asking', 'asking'),
          session('job-on-a-clock', 'scheduled'),
        ],
        truncated: false,
      },
    ],
  })

  const { state } = renderMap(queryClient)
  /* Membership, not order. This seam carries an agent's work; `seatedJobs`
     decides what a ring seats and in what order, and that is pinned where it
     lives. Asserting order here would pin it twice and in the wrong place. */
  expect([...(state.data.agents[0]?.jobs.map(job => job.id) ?? [])].sort()).toEqual([
    'job-asking',
    'job-on-a-clock',
    'job-running',
  ])
})

/* ---------------------------------------------------- the dot on the face

   The mark and the work arrive together, in the one read: `chat` is the
   conversation this owner *is*, `sessions` is what it did, and the wire tells
   them apart because only the owner's pointer can. The face wears the mark and
   the ring seats the work — the chat is never seated, because an owner's own
   conversation is not something it was put to work on. */
test('an owner’s own chat reaches its face, unread and all', () => {
  const queryClient = client()
  queryClient.setQueryData(duetQueryKeys.workspaces.agents.list('acme'), agentPages([agent('a0')]))
  queryClient.setQueryData(duetQueryKeys.workspaces.apps.list('acme'), appPages())
  queryClient.setQueryData(duetQueryKeys.workspaces.sessions.activity('acme'), {
    owners: [
      {
        agentId: 'agent_a0',
        sessions: [session('job-a0', 'running')],
        truncated: false,
        chat: { ...session('chat-a0', 'running'), unread: true },
      },
    ],
  })

  const { state } = renderMap(queryClient)
  expect(state.data.agents[0]?.chat?.map(item => item.unread)).toEqual([true])
  // and it is off the ring, so the mark is said once
  expect(state.data.agents[0]?.jobs.map(job => job.id)).toEqual(['job-a0'])
})

/* The fan-out this read replaced is invisible to the request count below,
   which asks its three queries by hand. This asks what the *hook* opens: an
   alias entry per drawn face was the shape of the bug — the map could not tell
   a chat from work until N second answers landed, one per face, and drew every
   owner's conversation as work until they did. */
test('the map never opens a per-owner alias read', () => {
  const queryClient = client()
  queryClient.setQueryData(
    duetQueryKeys.workspaces.agents.list('acme'),
    agentPages([agent('a0'), agent('a1')]),
  )
  queryClient.setQueryData(duetQueryKeys.workspaces.apps.list('acme'), appPages())
  queryClient.setQueryData(duetQueryKeys.workspaces.sessions.activity('acme'), { owners: [] })

  renderMap(queryClient)

  expect(
    queryClient
      .getQueryCache()
      .findAll({ queryKey: duetQueryKeys.workspaces.sessions.defaults('acme') }),
  ).toEqual([])
})

/* The request count is the reason this module has the shape it does, so it is
   asserted rather than described. It was six — three workspace-wide session
   pages plus agents plus apps — and every extra agent made those pages *less*
   complete without making them more numerous. */
test('the ring costs three reads, and the wire does the grouping', async () => {
  const asked: string[] = []
  const api = {
    listAgents: async () => {
      asked.push('agents')
      return { items: [agent('a0'), agent('a1')], nextCursor: null }
    },
    listApps: async () => {
      asked.push('apps')
      return {
        items: [],
        nextCursor: null,
        meta: { capabilities: { register: false } },
      }
    },
    listSessionActivity: async () => {
      asked.push('activity')
      return {
        owners: [
          { agentId: 'agent_a0', sessions: [session('job-a', 'running')], truncated: false },
          /* a1's work is *older* than a0's and would have fallen off a
             workspace-wide page. It is complete here because the read is
             bounded per owner rather than per drive — L17. */
          { agentId: 'agent_a1', sessions: [session('job-b', 'asking')], truncated: false },
        ],
      }
    },
  } as unknown as SpaApi

  const queryClient = client()
  await Promise.all([
    queryClient.fetchInfiniteQuery(duetQueryOptions.workspaces.agents(api, 'acme')),
    queryClient.fetchInfiniteQuery(duetQueryOptions.workspaces.apps(api, 'acme')),
    queryClient.fetchQuery(duetQueryOptions.workspaces.sessionActivity(api, 'acme')),
  ])
  expect(asked.sort()).toEqual(['activity', 'agents', 'apps'])

  const { state } = renderMap(queryClient)
  expect(state.data.agents.map(entry => entry.jobs.map(job => job.id))).toEqual([
    ['job-a'],
    ['job-b'],
  ])
})

test('a failed app list yields no app count at all, rather than zero', async () => {
  const queryClient = client()
  queryClient.setQueryData(duetQueryKeys.workspaces.agents.list('acme'), agentPages([agent('a0')]))
  await queryClient.prefetchInfiniteQuery(duetQueryOptions.workspaces.apps(FAILING_API, 'acme'))

  const { state } = renderMap(queryClient)
  expect(state.data.coreMeta).toBe(
    JSON.stringify({ agents: 1, apps: undefined, agentsComplete: true, appsComplete: false }),
  )
})

test('the centre marks loaded agent and app prefixes as incomplete', () => {
  const queryClient = client()
  queryClient.setQueryData(
    duetQueryKeys.workspaces.agents.list('acme'),
    agentPages([agent('a0')], 'agent-page-2'),
  )
  queryClient.setQueryData(
    duetQueryKeys.workspaces.apps.list('acme'),
    appPages([app('metrics', 'agents/a0/apps/metrics')], 'app-page-2'),
  )

  const { state } = renderMap(queryClient)
  expect(state.data.coreMeta).toBe(
    JSON.stringify({ agents: 1, apps: 1, agentsComplete: false, appsComplete: false }),
  )
})

test('a failed app continuation keeps loaded apps usable and retryable', async () => {
  const queryClient = client()
  const api = {
    listApps: async (_workspaceSlug: string, request: { cursor?: string }) => {
      if (request.cursor !== undefined) throw new Error('next app page unavailable')
      return {
        items: [app('metrics', 'agents/a0/apps/metrics')],
        nextCursor: 'app-page-2',
        meta: { capabilities: { register: false } },
      }
    },
  } as unknown as SpaApi
  const options = duetQueryOptions.workspaces.apps(api, 'acme')
  queryClient.setQueryData(duetQueryKeys.workspaces.agents.list('acme'), agentPages([agent('a0')]))
  await queryClient.fetchInfiniteQuery(options)
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})
  await observer.fetchNextPage().catch(() => {})
  unsubscribe()

  const { state } = renderMap(queryClient)
  expect(state.phases.apps).toBe('ready')
  expect(state.data.agents[0]?.apps.map(item => item.id)).toEqual(['metrics'])
  expect(state.appsContinuation.failed).toBe(true)
  expect(state.data.coreMeta).toContain('"appsComplete":false')
})

test('a failed app refresh keeps the loaded app prefix usable', async () => {
  let failApps = false
  const api = {
    listApps: async () => {
      if (failApps) throw new Error('app refresh unavailable')
      return {
        items: [app('metrics', 'agents/a0/apps/metrics')],
        nextCursor: null,
        meta: { capabilities: { register: false } },
      }
    },
  } as unknown as SpaApi
  const queryClient = client()
  queryClient.setQueryData(duetQueryKeys.workspaces.agents.list('acme'), agentPages([agent('a0')]))
  const options = duetQueryOptions.workspaces.apps(api, 'acme')
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})
  await observer.refetch()
  failApps = true
  await observer.refetch()

  const { state } = renderMap(queryClient)
  expect(state.phases.apps).toBe('ready')
  expect(state.data.agents[0]?.apps.map(item => item.id)).toEqual(['metrics'])
  unsubscribe()
})

test('a failed roster refresh keeps the loaded agent prefix usable', async () => {
  let failAgents = false
  const api = {
    listAgents: async () => {
      if (failAgents) throw new Error('roster refresh unavailable')
      return { items: [agent('a0')], nextCursor: null }
    },
  } as unknown as SpaApi
  const queryClient = client()
  queryClient.setQueryData(duetQueryKeys.workspaces.apps.list('acme'), appPages())
  const options = duetQueryOptions.workspaces.agents(api, 'acme')
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})
  await observer.refetch()
  failAgents = true
  await observer.refetch()

  const { state } = renderMap(queryClient)
  expect(state.phases.agents).toBe('ready')
  expect(state.data.agents.map(item => item.id)).toEqual(['agent_a0'])
  unsubscribe()
})

test('an exact route lookup projects an agent beyond the browsed roster prefix', () => {
  const queryClient = client()
  const first = agent('a0')
  const routed = agent('zulu')
  queryClient.setQueryData(
    duetQueryKeys.workspaces.agents.list('acme'),
    agentPages([first], 'agent-page-2'),
  )
  queryClient.setQueryData(duetQueryKeys.workspaces.apps.list('acme'), appPages())

  const { state } = renderMap(queryClient, { includeAgent: routed })
  expect(state.routes.get(routed.id)?.slug).toBe(routed.slug)
  expect(state.agentDirectory.get(routed.id)?.name).toBe(routed.name)
  expect(state.data.coreMeta).toBe(
    JSON.stringify({ agents: 2, apps: 0, agentsComplete: false, appsComplete: true }),
  )
})

test('the ring still draws when only the app list failed', async () => {
  const queryClient = client()
  queryClient.setQueryData(duetQueryKeys.workspaces.agents.list('acme'), agentPages([agent('a0')]))
  await queryClient.prefetchInfiniteQuery(duetQueryOptions.workspaces.apps(FAILING_API, 'acme'))

  const { state } = renderMap(queryClient)
  expect(state.isError).toBe(false)
  expect(state.data.agents.map(entry => entry.id)).toEqual(['agent_a0'])
})

/* ---- what "loaded" means to a surface that draws all three at once ----

   `isPending` is one read's answer, and the map is three. The ring landing first
   used to be enough to draw with, so home painted a drive whose agents carried
   nothing and framed a camera around it — twice wrong, twice re-framed, in front
   of a reader who had been looking at it since the first frame.

   `arrived` is the whole picture's answer instead: every read has said
   something. Said *something*, not succeeded — an app list that failed has
   answered as surely as one that returned, and a map that waited for a read that
   is never coming would hold the shape of itself on screen forever. */
test('the map has not arrived until every read it is drawn from has answered', async () => {
  const queryClient = client()
  queryClient.setQueryData(duetQueryKeys.workspaces.agents.list('acme'), agentPages([agent('a0')]))

  // the ring is in, the other two are still out
  expect(renderMap(queryClient).state.arrived).toBe(false)

  queryClient.setQueryData(duetQueryKeys.workspaces.apps.list('acme'), appPages())
  expect(renderMap(queryClient).state.arrived).toBe(false)

  queryClient.setQueryData(duetQueryKeys.workspaces.sessions.activity('acme'), { owners: [] })
  expect(renderMap(queryClient).state.arrived).toBe(true)
})

test('a read that failed has answered, and does not hold the map back', async () => {
  const queryClient = client()
  queryClient.setQueryData(duetQueryKeys.workspaces.agents.list('acme'), agentPages([agent('a0')]))
  queryClient.setQueryData(duetQueryKeys.workspaces.sessions.activity('acme'), { owners: [] })
  await queryClient.prefetchInfiniteQuery(duetQueryOptions.workspaces.apps(FAILING_API, 'acme'))

  const { state } = renderMap(queryClient)
  expect(state.phases.apps).toBe('error')
  expect(state.arrived).toBe(true)
})

/* The bug this guards is invisible in a single render: the projection memoises
   correctly and nothing on home polls, so a `Date.now()` taken inside the memo
   is taken once and then never again — leave the map open for an hour and every
   caption still says "2 min ago". Dating them from the clock the hook depends
   on is what makes them move. */
test('captions are dated from the shared clock, not from a fresh reading per projection', async () => {
  const queryClient = client()
  queryClient.setQueryData(duetQueryKeys.workspaces.agents.list('acme'), agentPages([agent('a0')]))
  queryClient.setQueryData(
    duetQueryKeys.workspaces.apps.list('acme'),
    appPages([app('metrics', 'agents/a0/apps/metrics')]),
  )

  // the clock moves once a minute, so by now the wall clock has left it behind
  await new Promise(resolve => setTimeout(resolve, 2))
  const { nows, clock } = renderMap(queryClient)
  expect(nows.length).toBeGreaterThan(0)
  expect([...new Set(nows)]).toEqual([clock])
})

test('the shared clock is a real wall clock, held still between ticks', () => {
  function Probe() {
    readings.push(useMapClock())
    return null
  }
  const readings: number[] = []
  renderToStaticMarkup(<Probe />)
  renderToStaticMarkup(<Probe />)
  expect(readings[0]).toBe(readings[1]!)
  // within one tick of the truth, so a caption is never dated into the future
  expect(Date.now() - readings[0]!).toBeGreaterThanOrEqual(0)
  expect(Date.now() - readings[0]!).toBeLessThan(60_000)
})
