import { describe, expect, test } from 'bun:test'

import { InfiniteQueryObserver } from '@tanstack/react-query'
import { createTranslator } from 'next-intl'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PUBLIC_API_ENDPOINTS } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { createDuetQueryClient } from '../api/query-client'
import {
  fileActivityQueryOptions,
  fileActivityPollInterval,
  formatActor,
  historyLabels,
  relativeTimeLabel,
  seenByOverflow,
  SeenByOverflowChip,
  TimelineScaffold,
  type ActorLookups,
} from './attribution'
import { RestAttributionSource, type FileActivityPageOptions } from './lib/attribution-source'
import { MockAttributionSource } from './lib/mock-attribution'

const labels = appEn.duetApp.filesSurface.attribution as Record<string, string>

// The tests speak the shipped English strings, interpolated the way
// next-intl does, so label regressions surface as copy diffs.
const lookups: ActorLookups = {
  t: (key, values) =>
    labels[key]!.replace(/\{(\w+)\}/g, (_match, name: string) => values?.[name] ?? `{${name}}`),
  userName: userId => ({ u1: 'Maya Chen', u2: 'Leo Okafor' })[userId],
}

describe('formatActor', () => {
  test('labels all seven actor kinds', () => {
    expect(formatActor('web:u1', 'u1', lookups)).toEqual({
      kind: 'web',
      label: 'Maya Chen',
      userName: 'Maya Chen',
    })
    expect(formatActor('session:ses_1', 'u1', lookups)).toEqual({
      kind: 'session',
      label: 'Agent · Maya Chen',
    })
    expect(formatActor('api-key:key_1', 'u2', lookups)).toEqual({
      kind: 'api-key',
      label: 'API key · Leo Okafor',
    })
    expect(formatActor('terminal', undefined, lookups)).toEqual({
      kind: 'terminal',
      label: 'Terminal',
    })
    expect(formatActor('system', undefined, lookups)).toEqual({ kind: 'system', label: 'System' })
    expect(formatActor('sync:share_1', undefined, lookups)).toEqual({
      kind: 'sync',
      label: 'Sync',
    })
    expect(formatActor('mirror:machine_1', 'u1', lookups)).toEqual({
      kind: 'mirror',
      label: 'Synced from a device',
    })
  })

  test('unknown user identities degrade to the context label', () => {
    // Unknown user: every user-backed kind falls back to its kind label.
    expect(formatActor('web:u9', 'u9', lookups).label).toBe('Member')
    expect(formatActor('session:ses_9', undefined, lookups).label).toBe('Agent')
    expect(formatActor('api-key:key_9', 'u9', lookups).label).toBe('API key')
  })

  test('web actors resolve through the context userId when the row has none', () => {
    expect(formatActor('web:u1', undefined, lookups).label).toBe('Maya Chen')
  })

  test('an unparseable context is shown raw — no product label exists', () => {
    expect(formatActor('gremlin:1:2', undefined, lookups)).toEqual({
      kind: 'unknown',
      label: 'gremlin:1:2',
    })
  })
})

describe('relativeTimeLabel', () => {
  const now = Date.UTC(2026, 6, 11, 9, 0)
  const minutes = (count: number) => now - count * 60_000

  test('scales from minutes to years', () => {
    expect(relativeTimeLabel(minutes(0), now, 'en')).toBe('1m ago')
    expect(relativeTimeLabel(minutes(45), now, 'en')).toBe('45m ago')
    expect(relativeTimeLabel(minutes(2 * 60), now, 'en')).toBe('2h ago')
    expect(relativeTimeLabel(minutes(3 * 24 * 60), now, 'en')).toBe('3d ago')
    expect(relativeTimeLabel(minutes(65 * 24 * 60), now, 'en')).toBe('2mo ago')
    expect(relativeTimeLabel(minutes(800 * 24 * 60), now, 'en')).toBe('2y ago')
  })
})

test('seen-by overflow stays a lower bound when the first page has a cursor', () => {
  expect(seenByOverflow(3, true)).toBe(1)
  expect(seenByOverflow(5, true)).toBe(3)
  expect(seenByOverflow(3, false)).toBe(0)
})

test('an incomplete seen-by presentation labels its visible count as a lower bound', () => {
  const t = createTranslator({
    locale: 'en',
    messages: appEn,
    namespace: 'duetApp.filesSurface.attribution',
  })
  const markup = renderToStaticMarkup(
    createElement(SeenByOverflowChip, {
      incomplete: true,
      label: t('moreReadersAtLeastCompact', { count: 1 }),
      title: t('moreReadersAtLeast', { count: 1 }),
    }),
  )
  expect(markup).toContain('title="At least 1 more person has seen this file"')
  expect(markup).toContain('At least 1 more')
})

describe('RestAttributionSource', () => {
  test('member attribution requests the maximum workspace roster page', async () => {
    let requestedLimit: number | undefined
    const api = {
      listWorkspaceMembers: async (_workspaceSlug: string, options: { limit?: number } = {}) => {
        requestedLimit = options.limit
        return { items: [], nextCursor: null }
      },
    } as unknown as ConstructorParameters<typeof RestAttributionSource>[0]
    const source = new RestAttributionSource(api)

    await source.listMembers('acme')

    expect(requestedLimit).toBe(100)
  })

  test('seen-by hits the slice-06 route and parses the contract shape', async () => {
    const requests: string[] = []
    const source = new RestAttributionSource(stubMembersApi(), (async (
      input: RequestInfo | URL,
    ) => {
      requests.push(String(input))
      return Response.json({
        items: [
          { actor: 'web:u1', userId: 'u1', firstAt: 1, lastAt: 9, readCount: 3, writeCount: 0 },
        ],
        nextCursor: null,
      })
    }) as typeof fetch)
    const result = await source.seenBy('acme', '/notes/plan.md')
    expect(result.items[0]).toMatchObject({ actor: 'web:u1', lastAt: 9 })
    const url = new URL(requests[0]!, 'https://app.test')
    expect(url.pathname).toBe('/api/duet/ws/acme/file-activity/seen-by')
    expect(url.searchParams.get('path')).toBe('notes/plan.md')
  })

  test('failures surface as errors for the presentation layer to isolate', async () => {
    const source = new RestAttributionSource(
      stubMembersApi(),
      (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
    )
    expect(source.seenBy('acme', '/a.md')).rejects.toThrow('attribution_request_failed:404')
  })
})

describe('MockAttributionSource', () => {
  test('failAll makes every surface throw so degradation paths are testable', async () => {
    const source = new MockAttributionSource()
    source.failAll = true
    expect(source.seenBy('acme', '/a')).rejects.toThrow('attribution_unavailable')
    expect(source.fileHistory('acme', '/a')).rejects.toThrow('attribution_unavailable')
    expect(source.workspaceActivity('acme')).rejects.toThrow('attribution_unavailable')
    expect(source.listMembers()).rejects.toThrow('attribution_unavailable')
  })

  test('fileHistory pages the seeded seq stream without duplicating the cursor row', async () => {
    const source = new MockAttributionSource()
    source.seed({
      history: {
        '/plan.md': Array.from({ length: 6 }, (_, index) => ({
          seq: index + 1,
          event: { kind: 'write', path: 'plan.md', actor: 'terminal', at: index + 1 },
        })),
      },
    })
    const first = await source.fileHistory('acme', '/plan.md')
    expect(first.items.map(row => row.seq)).toEqual([1, 2, 3, 4])
    expect(first.nextCursor).toBeDefined()
    const second = await source.fileHistory('acme', '/plan.md', {
      cursor: first.nextCursor ?? undefined,
    })
    expect(second.items.map(row => row.seq)).toEqual([5, 6])
    expect(second.nextCursor).toBeNull()
    expect(source.fileHistoryCalls).toBe(2)
  })

  test('history keeps reads by default while the feed drops them', async () => {
    const source = new MockAttributionSource()
    const events = [
      { seq: 1, event: { kind: 'write' as const, path: 'a.md', actor: 'terminal', at: 1 } },
      {
        seq: 2,
        event: { kind: 'read' as const, path: 'a.md', actor: 'web:u1', at: 2, userId: 'u1' },
      },
    ]
    source.seed({ history: { '/a.md': events }, activity: events })
    expect((await source.fileHistory('acme', '/a.md')).items.map(row => row.event.kind)).toEqual([
      'write',
      'read',
    ])
    expect((await source.workspaceActivity('acme')).items.map(row => row.event.kind)).toEqual([
      'write',
    ])
    expect(
      (await source.workspaceActivity('acme', { includeReads: true })).items.map(
        row => row.event.kind,
      ),
    ).toEqual(['write', 'read'])
  })
})

describe('RestAttributionSource history and feed', () => {
  test('fileHistory hits the slice-06 route with path, cursor, and reads flag', async () => {
    const requests: string[] = []
    const source = new RestAttributionSource(stubMembersApi(), (async (
      input: RequestInfo | URL,
    ) => {
      requests.push(String(input))
      return Response.json({ items: [], nextCursor: 'opaque-9' })
    }) as typeof fetch)
    const result = await source.fileHistory('acme', '/notes/plan.md', {
      cursor: 'opaque-4',
      includeReads: false,
    })
    expect(result.nextCursor).toBe('opaque-9')
    const url = new URL(requests[0]!, 'https://app.test')
    expect(url.pathname).toBe(proxyPathFor('file-activity.history'))
    expect(url.searchParams.get('path')).toBe('notes/plan.md')
    expect(url.searchParams.get('cursor')).toBe('opaque-4')
    expect(url.searchParams.get('reads')).toBe('0')
  })

  test('workspaceActivity hits the feed route and omits reads flag when unset', async () => {
    const requests: string[] = []
    const source = new RestAttributionSource(stubMembersApi(), (async (
      input: RequestInfo | URL,
    ) => {
      requests.push(String(input))
      return Response.json({ items: [], nextCursor: null })
    }) as typeof fetch)
    await source.workspaceActivity('acme')
    const url = new URL(requests[0]!, 'https://app.test')
    expect(url.pathname).toBe(proxyPathFor('file-activity.feed'))
    expect(url.searchParams.has('reads')).toBe(false)
  })

  test('workspaceActivity sends newest-first folder scope to the feed', async () => {
    const requests: string[] = []
    const source = new RestAttributionSource(stubMembersApi(), (async (
      input: RequestInfo | URL,
    ) => {
      requests.push(String(input))
      return Response.json({ items: [], nextCursor: null })
    }) as typeof fetch)

    await source.workspaceActivity('acme', {
      order: 'desc',
      path: '/notes',
      scope: 'subtree',
    })

    const url = new URL(requests[0]!, 'https://app.test')
    expect(url.searchParams.get('order')).toBe('desc')
    expect(url.searchParams.get('path')).toBe('notes')
    expect(url.searchParams.get('scope')).toBe('subtree')
  })
})

// Browsers brand-check fetch on the global object: calling it as a method of
// anything else throws before a request is made. Bun does not, so a source
// that calls its injected fetch as `this.fetchImpl(...)` passes every test here
// and issues zero requests in a real browser. The harness applies the browser's
// rule so that gap cannot reopen.
function browserRuleFetch(
  respond: () => Response,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return function (this: unknown) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    }
    return Promise.resolve(respond())
  }
}

describe('RestAttributionSource under the browser fetch rule', () => {
  test('every read reaches the network instead of throwing on an illegal receiver', async () => {
    const source = new RestAttributionSource(
      stubMembersApi(),
      browserRuleFetch(() => Response.json({ items: [], nextCursor: null })),
    )
    expect((await source.workspaceActivity('acme')).items).toEqual([])
    expect((await source.fileHistory('acme', '/plan.md')).items).toEqual([])
    expect((await source.seenBy('acme', '/plan.md')).items).toEqual([])
  })
})

// The SPA reaches the API through the /api/duet proxy, which rewrites
// /api/duet/<rest> to /v1/<rest> verbatim (src/server/duet-proxy.ts). Deriving
// the expected pathname from the endpoint catalog — the one owner of API paths
// — is what keeps a client-only rename from inventing a route the API never
// serves, which is exactly how fileHistory came to call a 404.
function proxyPathFor(endpointId: string, workspaceSlug = 'acme'): string {
  const endpoint = PUBLIC_API_ENDPOINTS.find(candidate => candidate.id === endpointId)
  if (endpoint === undefined) throw new Error(`unknown endpoint: ${endpointId}`)
  return endpoint.path.replace('/v1/', '/api/duet/').replace('{workspaceSlug}', workspaceSlug)
}

function stubMembersApi() {
  return {
    listWorkspaceMembers: async () => ({ items: [], nextCursor: null }),
  } as unknown as ConstructorParameters<typeof RestAttributionSource>[0]
}

describe('file activity freshness', () => {
  test('a continuation failure keeps loaded timeline rows and offers a page-local retry', () => {
    const html = renderToStaticMarkup(
      TimelineScaffold({
        pending: false,
        failed: false,
        pageFailed: true,
        empty: false,
        labels: {
          empty: 'No history yet',
          emptyBody: 'Edits show here.',
          failed: 'History is unavailable',
          moreFailed: "Couldn't load more history.",
          loadMore: 'Load more',
          retryMore: 'Try loading more again',
        },
        onLoadMore: () => {},
        children: createElement('li', undefined, 'Edited roadmap.md'),
      }),
    )

    expect(html).toContain('Edited roadmap.md')
    expect(html).toContain('Couldn&#x27;t load more history.')
    expect(html).toContain('Try loading more again')
    expect(html).not.toContain('History is unavailable')
  })

  test('file timelines keep loaded events and retry the failed cursor', async () => {
    const cursors: Array<string | undefined> = []
    let failPage = true
    class PagedAttributionSource extends MockAttributionSource {
      override async workspaceActivity(
        _workspaceSlug: string,
        options: FileActivityPageOptions = {},
      ) {
        cursors.push(options.cursor)
        if (options.cursor === undefined) {
          return {
            items: [
              {
                seq: 1,
                event: { kind: 'write' as const, path: 'roadmap.md', actor: 'terminal', at: 1 },
              },
            ],
            nextCursor: 'activity-page-2',
          }
        }
        if (failPage) throw new Error('activity_page_failed')
        return {
          items: [
            {
              seq: 2,
              event: { kind: 'write' as const, path: 'launch.md', actor: 'terminal', at: 2 },
            },
          ],
          nextCursor: null,
        }
      }
    }
    const client = createDuetQueryClient()
    const observer = new InfiniteQueryObserver(
      client,
      fileActivityQueryOptions(new PagedAttributionSource(), {
        workspaceSlug: 'acme',
        enabled: true,
        kind: 'activity',
      }),
    )
    await observer.refetch()
    await observer.fetchNextPage()
    const failed = observer.getCurrentResult()

    expect(failed.isFetchNextPageError).toBe(true)
    expect(
      failed.data?.pages.flatMap(page =>
        page.items.flatMap(row => ('path' in row.event ? [row.event.path] : [])),
      ),
    ).toEqual(['roadmap.md'])

    failPage = false
    await observer.fetchNextPage()
    expect(cursors).toEqual([undefined, 'activity-page-2', 'activity-page-2'])
    expect(
      observer
        .getCurrentResult()
        .data?.pages.flatMap(page =>
          page.items.flatMap(row => ('path' in row.event ? [row.event.path] : [])),
        ),
    ).toEqual(['roadmap.md', 'launch.md'])
  })

  test('the activity query requests newest-first events for its selected folder', async () => {
    class ObservingAttributionSource extends MockAttributionSource {
      received: FileActivityPageOptions | undefined

      override async workspaceActivity(
        _workspaceSlug: string,
        options: FileActivityPageOptions = {},
      ) {
        this.received = options
        return { items: [], nextCursor: null }
      }
    }
    const source = new ObservingAttributionSource()
    const client = createDuetQueryClient()

    await client.fetchInfiniteQuery(
      fileActivityQueryOptions(source, {
        workspaceSlug: 'acme',
        enabled: true,
        kind: 'activity',
        path: '/notes',
        scope: 'subtree',
      }),
    )

    expect(source.received).toMatchObject({ order: 'desc', path: '/notes', scope: 'subtree' })
  })

  test('consecutive history fetches read the drive again inside the shared stale window', async () => {
    let reads = 0
    const source = new MockAttributionSource()
    const counting = {
      ...source,
      fileHistory: async (...args: Parameters<MockAttributionSource['fileHistory']>) => {
        reads += 1
        return await source.fileHistory(...args)
      },
    } as unknown as MockAttributionSource
    // The product's client, not a bare one: its 30s staleTime is exactly what
    // used to serve a just-edited file's history from cache.
    const client = createDuetQueryClient()
    const options = fileActivityQueryOptions(counting, {
      workspaceSlug: 'acme',
      enabled: true,
      kind: 'history',
      path: '/plan.md',
    })

    await client.fetchInfiniteQuery(options)
    await client.fetchInfiniteQuery(options)

    expect(reads).toBe(2)
  })

  test('loading older activity freezes that historical snapshot instead of polling every page', () => {
    expect(fileActivityPollInterval({ pages: [{ items: [], nextCursor: null }] })).toBe(5_000)
    expect(
      fileActivityPollInterval({
        pages: [
          { items: [], nextCursor: null },
          { items: [], nextCursor: null },
        ],
      }),
    ).toBe(false)
  })
})

// The stored count means logical SAVES for a file row and DISTINCT FILES for a
// folded folder row. Rendering a raw count on every row would have shipped
// sentences like "Edited .cd.json (1,902 changes)" for a single 9 MB file
// streaming to disk — which is exactly the falsehood folding removes.
describe('historyLabels', () => {
  const base = { actor: 'session:s1', at: 0 } as const

  test('a single save names the verb and nothing else', () => {
    expect(historyLabels({ ...base, kind: 'write', path: 'a.ts' })).toEqual({
      verbKey: 'history.edited',
    })
    expect(historyLabels({ ...base, kind: 'write', path: 'a.ts', count: 1 })).toEqual({
      verbKey: 'history.edited',
    })
  })

  test('repeated saves state how many', () => {
    expect(historyLabels({ ...base, kind: 'write', path: 'a.ts', count: 6 })).toEqual({
      verbKey: 'history.edited',
      magnitude: { key: 'history.saves', count: 6 },
    })
  })

  // `count` on a summary means two different things. The gateway folds
  // regenerable trees and counts raw EVENTS; the server folds an ordinary
  // directory and counts distinct FILES. Only the server fold is marked
  // entryKind: 'folder', and stating the wrong unit would be the same class of
  // falsehood folding exists to remove.
  test('a server-folded folder states files; a gateway-folded tree states events', () => {
    expect(
      historyLabels({
        ...base,
        kind: 'changed-summary',
        path: 'ui/editor',
        count: 103,
        entryKind: 'folder',
      }),
    ).toEqual({ verbKey: 'history.edited', magnitude: { key: 'history.files', count: 103 } })

    expect(historyLabels({ ...base, kind: 'changed-summary', path: '.git', count: 487 })).toEqual({
      verbKey: 'history.edited',
      magnitude: { key: 'activity.summaryCount', count: 487 },
    })
  })
})
