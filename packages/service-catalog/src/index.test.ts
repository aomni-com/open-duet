import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { parseVaultPutArgs } from './service-vault'

import {
  evaluate,
  firecrawl,
  matchRoute,
  needsOf,
  priceCharge,
  SERVICE_DEFINITIONS,
  replayFixture,
  validateCatalog,
  type ServiceDefinition,
} from './index'
import { probeService } from './probe'
import { parseProbeArgs } from './probe-cli'

const service: ServiceDefinition = {
  id: 'example',
  name: 'Example',
  summary: 'Example service',
  category: 'data',
  docsUrl: 'https://example.com/docs',
  notes: '',
  baseUrl: 'https://example.com',
  auth: { kind: 'bearer' },
  unit: { name: 'unit', microUsdPerUnit: 1 },
  routes: [
    {
      id: 'item-get',
      method: 'GET',
      path: '/v1/items/:itemId',
      admission: 'ownedById',
      price: { kind: 'free' },
    },
  ],
}

describe('matchRoute', () => {
  test('matches a parameter without decoding an encoded slash', () => {
    expect(matchRoute(service, 'GET', '/v1/items/abc')).toEqual({
      route: service.routes[0]!,
      params: { itemId: 'abc' },
    })
    expect(matchRoute(service, 'GET', '/v1/items/a%2Fb')).toEqual({
      route: service.routes[0]!,
      params: { itemId: 'a%2Fb' },
    })
    expect(matchRoute(service, 'GET', '/v1/items/a/b')).toBeNull()
    expect(matchRoute(service, 'GET', '/v1/items/a/../b')).toBeNull()
  })
})

describe('pricing', () => {
  test('uses vendor units and applies the standard margin once', () => {
    const route = service.routes[0]!
    const charge = evaluate(service, {
      route,
      params: { itemId: 'abc' },
      status: 200,
      headers: new Headers(),
      elapsedMs: 0,
    })
    expect(charge).toBeNull()
    expect(priceCharge({ ...service, unit: { name: 'credit', microUsdPerUnit: 80 } }, { units: 28 })).toEqual({
      vendorCostMicroUsd: 2240,
      chargeMicroUsd: 2688,
    })
  })

  test('reads response headers, request JSON, and terminal async bodies', () => {
    const headerRoute = { ...service.routes[0]!, price: { kind: 'responseHeader' as const, header: 'x-cost', rate: 2 } }
    expect(evaluate(service, { route: headerRoute, params: {}, status: 200, headers: new Headers({ 'x-cost': '3' }), elapsedMs: 0 })).toEqual({ units: 6 })
    const requestRoute = { ...service.routes[0]!, price: { kind: 'requestJson' as const, paths: ['items[].count'], rate: 0.5 } }
    expect(evaluate(service, { route: requestRoute, params: {}, status: 200, headers: new Headers(), elapsedMs: 0, requestJson: { items: [{ count: 4 }, { count: 2 }] } })).toEqual({ units: 3 })
    const asyncRoute = { ...service.routes[0]!, price: { kind: 'asyncTerminal' as const, statusPath: 'status', terminal: ['done'], idParam: 'id', cost: { kind: 'flat' as const, units: 7 } } }
    expect(evaluate(service, { route: asyncRoute, params: { id: 'job-1' }, status: 200, headers: new Headers(), elapsedMs: 0, responseJson: { status: 'running' } })).toBeNull()
    expect(evaluate({ ...service, id: 'example' }, { route: asyncRoute, params: { id: 'job-1' }, status: 200, headers: new Headers(), elapsedMs: 0, responseJson: { status: 'done' } })).toEqual({ units: 7, reference: 'service:example:item-get:job-1:final' })
  })

  test('does not charge failed responses and reports buffering needs', () => {
    const route = { ...service.routes[0]!, price: { kind: 'responseJson' as const, path: 'cost' } }
    expect(evaluate(service, { route, params: {}, status: 422, headers: new Headers(), elapsedMs: 0, responseJson: { cost: 99 } })).toBeNull()
    expect(needsOf({ kind: 'first', rules: [{ kind: 'free' }, route.price] })).toEqual({ requestJson: false, responseJson: true })
  })
})

describe('catalog validation', () => {
  test('keeps DataForSEO task retrieval as a POST route', () => {
    const route = SERVICE_DEFINITIONS
      .find(definition => definition.id === 'dataforseo')
      ?.routes.find(candidate => candidate.id === 'serp-task-get')
    expect(route?.method).toBe('POST')
  })

  test('uses vendor response cost for DataForSEO routes and keeps metadata free', () => {
    const definition = SERVICE_DEFINITIONS.find(item => item.id === 'dataforseo')!
    const live = matchRoute(definition, 'POST', '/v3/dataforseo_labs/google/keyword_suggestions/live')!
    expect(evaluate(definition, {
      route: live.route,
      params: live.params,
      status: 200,
      headers: new Headers(),
      elapsedMs: 0,
      responseJson: { cost: 0.01 },
    })).toEqual({ units: 0.01 })
    const metadata = matchRoute(definition, 'GET', '/v3/dataforseo_labs/locations_and_languages')!
    expect(evaluate(definition, {
      route: metadata.route,
      params: metadata.params,
      status: 200,
      headers: new Headers(),
      elapsedMs: 0,
    })).toBeNull()
  })

  test('keeps ElevenLabs voice ids reusable without exposing voice lists', () => {
    const routes = SERVICE_DEFINITIONS.find(definition => definition.id === 'elevenlabs')?.routes ?? []
    expect(routes.some(route => route.path === '/v2/voices')).toBe(false)
    expect(routes.some(route => route.id === 'shared-voices' && route.path === '/v1/shared-voices' && route.admission === 'publicRead')).toBe(true)
    expect(routes.some(route => route.id === 'voice-get' && route.path === '/v1/voices/:voiceId')).toBe(true)
  })

  test('expires workspace-created shared resources through the vendor delete/update route', () => {
    for (const serviceId of ['crustdata', 'elevenlabs']) {
      const definition = SERVICE_DEFINITIONS.find(item => item.id === serviceId)!
      const pool = definition.pools?.[0]
      expect(pool).toBeDefined()
      if (pool === undefined) continue
      expect(pool.ttlMs).toBe(24 * 60 * 60 * 1000)
      expect(definition.routes.some(route => route.method === pool.expire.method && route.path === pool.expire.path)).toBe(true)
    }
    const watcherExpiry = SERVICE_DEFINITIONS.find(item => item.id === 'crustdata')!.pools![0]!.expire
    expect(watcherExpiry.body).toEqual({ status: 'deleted' })
  })

  test('keeps a route-id lock for every catalog route', async () => {
    const lock = JSON.parse(await readFile(new URL('../routes.lock.json', import.meta.url), 'utf8')) as string[]
    const routes = SERVICE_DEFINITIONS
      .flatMap(definition => definition.routes.map(route => `${definition.id}:${route.id}`))
      .sort()
    expect(lock).toEqual(routes)
  })

  test('replays the scrubbed vendor fixtures through the catalog matcher', async () => {
    for (const definition of SERVICE_DEFINITIONS) {
      const fixtures = JSON.parse(await readFile(new URL(`../fixtures/${definition.id}.json`, import.meta.url), 'utf8')) as Array<Parameters<typeof replayFixture>[1]>
      expect(fixtures.length).toBeGreaterThan(0)
      for (const fixture of fixtures) expect(replayFixture(definition, fixture).route).not.toBe(fixture.route)
    }
  })

  test('rejects duplicate and malformed service definitions', () => {
    const invalid = {
      ...service,
      routes: [
        { ...service.routes[0]!, id: 'same' },
        { ...service.routes[0]!, id: 'same' },
      ],
    }
    const errors = validateCatalog([{ ...invalid, id: 'Not valid' }, invalid, { ...service, routes: [...service.routes] }])
    expect(errors.map(error => error.code)).toEqual(expect.arrayContaining(['invalid_service_id', 'duplicate_route_id', 'duplicate_service_id', 'ambiguous_route']))
  })

  test('rejects parameter and literal routes that can match the same request', () => {
    const errors = validateCatalog([{
      ...service,
      routes: [
        { ...service.routes[0]!, id: 'by-id', path: '/v1/items/:itemId' },
        { ...service.routes[0]!, id: 'fixed', path: '/v1/items/fixed' },
      ],
    }])
    expect(errors.map(error => error.code)).toContain('ambiguous_route')
  })

  test('allows the same path when methods differ', () => {
    const errors = validateCatalog([{
      ...service,
      routes: [
        { ...service.routes[0]!, id: 'get-item', method: 'GET', path: '/v1/items/:itemId' },
        { ...service.routes[0]!, id: 'post-item', method: 'POST', path: '/v1/items/:itemId' },
      ],
    }])
    expect(errors.map(error => error.code)).not.toContain('ambiguous_route')
  })

  test('requires complete shared-pool bindings and pool expiry', () => {
    const errors = validateCatalog([
      {
        ...service,
        pools: [{ id: 'voices', ttlMs: 0, expire: { method: 'DELETE', path: '' } }],
        routes: [{ ...service.routes[0]!, admission: 'sharedPool', pool: { pool: 'voices', role: 'mutate' } as never }],
      },
    ])
    expect(errors.map(error => error.code)).toEqual(expect.arrayContaining(['missing_id_param', 'missing_pool_ttl', 'missing_pool_expiry']))
  })

  test('rejects negative price units and pools whose expiry is not admitted', () => {
    const errors = validateCatalog([{
      ...service,
      unit: { name: 'unit', microUsdPerUnit: -1 },
      pools: [{ id: 'pool', ttlMs: 60_000, expire: { method: 'DELETE', path: '/v1/items/:itemId' } }],
      routes: [{
        ...service.routes[0]!,
        price: { kind: 'flat', units: -1 },
        admission: 'sharedPool',
        pool: { pool: 'pool', role: 'read' },
      }],
    }])
    expect(errors.map(error => error.code)).toEqual(expect.arrayContaining(['invalid_unit_rate', 'invalid_price_units', 'missing_pool_expiry_route']))
  })

  test('every proxy path documented by a registry skill is admitted by the catalog', async () => {
    const skillsRoot = new URL('../../skills-registry/skills/', import.meta.url)
    const files: string[] = []
    async function collect(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await collect(path)
        else files.push(path)
      }
    }
    await collect(skillsRoot.pathname)

    const documented: Array<{ file: string; line: number; serviceId: string; path: string }> = []
    const proxyBases = /DUET_PROXY\s*=\s*["']\$DUET_API_URL\/v1\/services\/([a-z0-9-]+)["']/g
    const directProxyPath = /\$DUET_API_URL\/v1\/services\/([a-z0-9-]+)(\/[^\s"'`\\)<>]*)?/g
    const relativeProxyPath = /\$DUET_PROXY(\/[^\s"'`\\)<>]*)/g
    const normalizePath = (path: string): string => path.split('?')[0]!.replace(/\$\{?([A-Z][A-Z0-9_]*)\}?/g, ':param').replace(/\{[^}]+\}/g, ':param')

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      const lines = source.split(/\r?\n/)
      const relativePath = relative(skillsRoot.pathname, file)
      let serviceId: string | undefined = relativePath.split('/')[0]
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!
        proxyBases.lastIndex = 0
        const base = proxyBases.exec(line)
        if (base) {
          serviceId = base[1]
          continue
        }
        directProxyPath.lastIndex = 0
        for (const match of line.matchAll(directProxyPath)) {
          if (!match[2]) continue
          documented.push({ file, line: index + 1, serviceId: match[1]!, path: normalizePath(match[2]) })
        }
        relativeProxyPath.lastIndex = 0
        if (!serviceId) continue
        for (const match of line.matchAll(relativeProxyPath)) {
          documented.push({ file, line: index + 1, serviceId, path: normalizePath(match[1]!) })
        }
      }
    }

    const admitted = SERVICE_DEFINITIONS.flatMap(definition => definition.routes.map(route => ({ serviceId: definition.id, route })))
    const misses = documented.filter(reference => !admitted.some(({ serviceId, route }) => {
      if (serviceId !== reference.serviceId) return false
      const expected = route.path.split('/').filter(Boolean)
      const actual = reference.path.split('/').filter(Boolean)
      if (expected.length !== actual.length) return false
      return expected.every((segment, index) => segment.startsWith(':') || segment === actual[index])
    }))
    expect(misses, misses.map(reference => `${relative(skillsRoot.pathname, reference.file)}:${reference.line} ${reference.serviceId}${reference.path}`).join('\n')).toEqual([])
  })

  test('skill examples use the service proxy and never vendor credentials', async () => {
    const skillsRoot = new URL('../../skills-registry/skills/', import.meta.url)
    const files: string[] = []
    async function collect(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await collect(path)
        else files.push(path)
      }
    }
    await collect(skillsRoot.pathname)

    const directVendorHost = /https?:\/\/(?:api\.crustdata\.com|app\.fullenrich\.com|api\.dataforseo\.com|api\.firecrawl\.dev|api\.elevenlabs\.io|api\.socialapi\.me)/i
    const vendorCredential = /\$(?:CRUSTDATA_API_KEY|FULLENRICH_API_KEY|DATAFORSEO_BASE64_PASSWORD)/
    const failures: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const match of source.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
        const example = match[1] ?? ''
        if (directVendorHost.test(example) || vendorCredential.test(example)) {
          const line = source.slice(0, (match.index ?? 0)).split(/\r?\n/).length
          failures.push(`${relative(skillsRoot.pathname, file)}:${line}`)
        }
      }
    }
    expect(failures).toEqual([])
  })
})

describe('service vault command', () => {
  test('parses the explicit environment flag', () => {
    expect(parseVaultPutArgs(['put', 'elevenlabs', 'apiKey', '--env', 'staging'])).toEqual({
      serviceId: 'elevenlabs', name: 'apiKey', environment: 'staging',
    })
    expect(() => parseVaultPutArgs(['put', 'elevenlabs', 'apiKey'])).toThrow()
  })
})

describe('Firecrawl pricing', () => {
  test('charges an async crawl only when the terminal response reports credits', () => {
    const route = matchRoute(firecrawl, 'GET', '/v2/crawl/job-1')!.route
    expect(evaluate(firecrawl, {
      route, params: { crawlId: 'job-1' }, status: 200, headers: new Headers(), elapsedMs: 0,
      responseJson: { status: 'scraping', creditsUsed: 1 },
    })).toBeNull()
    expect(evaluate(firecrawl, {
      route, params: { crawlId: 'job-1' }, status: 200, headers: new Headers(), elapsedMs: 0,
      responseJson: { status: 'completed', creditsUsed: 1 },
    })).toEqual({ units: 1, reference: 'service:firecrawl:crawl-poll:job-1:final' })
  })

  test('prices browser execution by Firecrawl browser minutes', () => {
    const route = matchRoute(firecrawl, 'POST', '/v2/browser/session-1/execute')!.route
    const requestJson = { code: 'await page.goto("https://example.com")' }
    expect(evaluate(firecrawl, {
      route, params: { sessionId: 'session-1' }, status: 200, headers: new Headers(), elapsedMs: 5_000,
      requestJson,
    })).toEqual({ units: 2 })
    expect(evaluate(firecrawl, {
      route, params: { sessionId: 'session-1' }, status: 200, headers: new Headers(), elapsedMs: 90_000,
      requestJson,
    })).toEqual({ units: 3 })
    expect(evaluate(firecrawl, {
      route, params: { sessionId: 'session-1' }, status: 200, headers: new Headers(), elapsedMs: 5_000,
      requestJson: { prompt: 'click the sign in button' },
    })).toEqual({ units: 7 })
  })

  test('uses documented Firecrawl fallback units when responses omit creditsUsed', () => {
    const scrape = matchRoute(firecrawl, 'POST', '/v2/scrape')!.route
    const map = matchRoute(firecrawl, 'POST', '/v2/map')!.route
    expect(evaluate(firecrawl, { route: scrape, params: {}, status: 200, headers: new Headers(), elapsedMs: 0, requestJson: { url: 'https://example.com' }, responseJson: {} })).toEqual({ units: 1 })
    expect(evaluate(firecrawl, { route: map, params: {}, status: 200, headers: new Headers(), elapsedMs: 0, requestJson: { url: 'https://example.com' }, responseJson: {} })).toEqual({ units: 1 })
  })
})

describe('service probe transport', () => {
  test('parses a single service or all services with an explicit environment', () => {
    expect(parseProbeArgs(['elevenlabs', '--env', 'staging'])).toEqual({ serviceId: 'elevenlabs', environment: 'staging' })
    expect(parseProbeArgs(['--all', '--env', 'production'])).toEqual({ serviceId: null, environment: 'production' })
    expect(() => parseProbeArgs(['elevenlabs'])).toThrow()
  })

  test('injects each definition auth scheme at the vendor boundary', async () => {
    let seenUrl = ''
    let seenHeaders: Headers | undefined
    const definition: ServiceDefinition = {
      ...service,
      id: 'probe-service',
      auth: { kind: 'query', name: 'api_key' },
      routes: [{
        id: 'lookup', method: 'GET', path: '/v1/lookup', admission: 'generate', price: { kind: 'free' },
        probe: { path: '/v1/lookup/known', query: { q: 'hello' } },
      }],
    }
    const results = await probeService(definition, {
      secret: async () => 'vendor-secret',
      fetch: async (input, init) => {
        seenUrl = String(input)
        seenHeaders = new Headers(init?.headers)
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    expect(seenUrl).toBe('https://example.com/v1/lookup/known?q=hello&api_key=vendor-secret')
    expect(seenHeaders?.get('authorization')).toBeNull()
    expect(results).toMatchObject([{ route: 'lookup', verdict: 'ok', status: 200 }])
  })

  test('reports the vendor signal selected by a route price rule', async () => {
    const definition: ServiceDefinition = {
      ...service,
      id: 'probe-price',
      routes: [{
        id: 'metered', method: 'GET', path: '/v1/metered', admission: 'generate',
        price: { kind: 'responseHeader', header: 'x-vendor-units', rate: 2 },
        probe: {},
      }],
    }
    const [result] = await probeService(definition, {
      secret: async () => 'vendor-secret',
      fetch: async () => new Response('{}', { status: 200, headers: { 'x-vendor-units': '3' } }),
    })
    expect(result).toMatchObject({ computedUnits: 6, reportedUnits: 6, verdict: 'ok' })
  })

  test('compares a metered call with the usage-ledger delta', async () => {
    const definition: ServiceDefinition = {
      ...service,
      id: 'probe-ledger',
      usage: {
        path: '/v1/usage',
        read: json => ({ total: Number((json as { total?: unknown }).total ?? 0) }),
      },
      routes: [{
        id: 'metered', method: 'POST', path: '/v1/metered', admission: 'generate',
        price: { kind: 'responseHeader', header: 'x-vendor-units' },
        probe: { json: { input: 'probe' } },
      }],
    }
    const seen: string[] = []
    const responses = [
      new Response(JSON.stringify({ total: 10 }), { status: 200 }),
      new Response('{}', { status: 200, headers: { 'x-vendor-units': '3' } }),
      new Response(JSON.stringify({ total: 13 }), { status: 200 }),
    ]
    const [result] = await probeService(definition, {
      secret: async () => 'vendor-secret',
      fetch: async input => {
        seen.push(String(input))
        return responses.shift()!
      },
    })
    expect(seen).toEqual([
      'https://example.com/v1/usage',
      'https://example.com/v1/metered',
      'https://example.com/v1/usage',
    ])
    expect(result).toMatchObject({ computedUnits: 3, reportedUnits: 3, ledgerUnits: 3, verdict: 'ok' })
  })

  test('marks a successful call as drift when the usage ledger disagrees', async () => {
    const definition: ServiceDefinition = {
      ...service,
      id: 'probe-ledger-drift',
      usage: { path: '/v1/usage', read: json => ({ total: Number((json as { total?: unknown }).total ?? 0) }) },
      routes: [{
        id: 'metered', method: 'POST', path: '/v1/metered', admission: 'generate',
        price: { kind: 'flat', units: 3 }, probe: { json: { input: 'probe' } },
      }],
    }
    const responses = [
      new Response(JSON.stringify({ total: 10 }), { status: 200 }),
      new Response('{}', { status: 200 }),
      new Response(JSON.stringify({ total: 12 }), { status: 200 }),
    ]
    const [result] = await probeService(definition, {
      secret: async () => 'vendor-secret',
      fetch: async () => responses.shift()!,
    })
    expect(result).toMatchObject({ computedUnits: 3, reportedUnits: null, ledgerUnits: 2, verdict: 'drift' })
    expect(result?.detail).toContain('usage ledger delta 2')
  })

  test('sends probe multipart fields without forcing a boundary header', async () => {
    let seenContentType: string | null = null
    let seenBody: RequestInit['body']
    const definition: ServiceDefinition = {
      ...service,
      id: 'probe-multipart',
      routes: [{
        id: 'upload', method: 'POST', path: '/v1/upload', admission: 'generate', price: { kind: 'free' },
        probe: { multipart: { file: 'fixture.txt', purpose: 'probe' } },
      }],
    }
    await probeService(definition, {
      secret: async () => 'vendor-secret',
      fetch: async (_input, init) => {
        seenContentType = new Headers(init?.headers).get('content-type')
        seenBody = init?.body
        return new Response('{}', { status: 200 })
      },
    })
    expect(seenContentType).toBeNull()
    expect(seenBody).toBeInstanceOf(FormData)
    expect((seenBody as FormData).get('file')).toBe('fixture.txt')
    expect((seenBody as FormData).get('purpose')).toBe('probe')
  })
})
