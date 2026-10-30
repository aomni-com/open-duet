import { describe, expect, test } from 'bun:test'

import { PUBLIC_API_ENDPOINTS, type PublicApiEndpointMetadata } from '@repo/contract'

import { createApiApp } from './index'

const NON_CONTRACT_ROUTE_REASONS = [
  {
    pattern: /^\/v1\/analytics\/events$/,
    /* Ingress into Duet's own product analytics. Not withheld for auth: a
       third-party UI posting here would mix its events into our metrics, and
       the endpoint stamps `origin: 'product_browser'` on everything it takes,
       which would then be a lie. */
    reason: 'ingress for Duet\u2019s own product analytics, not a customer capability',
  },
  { pattern: /^\/v1\/admin\//, reason: 'audited test bootstrap' },
  { pattern: /^\/v1\/internal-admin(?:\/|$)/, reason: 'internal administration' },
  {
    pattern: /^\/v1\/internal\/session-deletions\/:workId\/dispose$/,
    reason: 'durable backend-owned session disposal callback',
  },
  {
    pattern: /^\/v1\/internal\/backups\/:backupId\/run$/,
    reason: 'durable backup dispatch and cleanup callback',
  },
  {
    pattern: /^\/v1\/internal\/apps\/reconcile$/,
    reason: 'backend-owned app address reconciliation callback',
  },
  { pattern: /^\/v1\/vm(?:\/|$)/, reason: 'workspace VM control plane' },
  {
    pattern: /^\/v1\/ws\/:workspaceSlug\/connected-providers(?:\/|$)/,
    /* Cookie-only today (`requireBrowserSession`), so an API key cannot reach
       it at all. Publishing it means moving it to scope auth and minting a
       capability for it — a real change, deliberately not made here. */
    reason: 'BYO provider credentials; browser-session auth, no capability yet',
  },
  {
    pattern: /^\/v1\/integrations\/composio\/oauth\/callback$/,
    reason: 'composio OAuth redirect callback',
  },
  {
    pattern: /^\/v1\/ws\/:workspaceSlug\/agent\/sessions\/:sessionId\/integrations\/mcp$/,
    reason: 'conversation-scoped composio MCP streamable-HTTP transport',
  },
  {
    pattern: /^\/v1\/ws\/:workspaceSlug\/mcp-servers\/:name\/connect$/,
    /* Answers a third party's consent URL, which only a browser performing a
       top-level navigation can act on. An API client holding a key has nothing
       to do with the response, so publishing it would promise a capability the
       endpoint cannot deliver headlessly. */
    reason: 'browser consent handoff for a custom MCP server',
  },
  {
    pattern: /^\/v1\/mcp-servers\/oauth\/callback$/,
    /* A redirect target a third-party authorization server sends a browser to,
       with no Duet credential on it. Auth-bypassed and rate-limited for that
       reason; its "request schema" is whatever RFC 6749 puts in the query. */
    reason: 'custom MCP server OAuth redirect callback',
  },
  {
    pattern: /^\/v1\/ws\/:workspaceSlug\/mcp\/:name$/,
    /* The same transport, for a workspace's own remote MCP servers. Workspace-
       scoped rather than session-scoped because a custom server has no provider
       session to be scoped to. Not a customer capability: it speaks JSON-RPC
       over SSE to whatever the third party is, so there is no request or
       response schema Duet could publish. */
    reason: 'workspace-scoped custom MCP streamable-HTTP transport',
  },
] as const

describe('public endpoint metadata coverage', () => {
  const routes = createApiApp({
    convexUrl: 'https://example.convex.cloud',
    internalKey: 'test-internal-key',
  }).routes.filter(route => route.method !== 'ALL' && route.path.startsWith('/v1/'))

  test('every published endpoint resolves to a registered API route', () => {
    const missing = PUBLIC_API_ENDPOINTS.filter(
      endpoint => !routes.some(route => routeCoversEndpoint(route, endpoint)),
    ).map(endpoint => `${endpoint.method} ${endpoint.path}`)
    expect(missing).toEqual([])
  })

  test('every versioned route is published or has one explicit private owner', () => {
    const uncovered = routes
      .filter(
        route =>
          !PUBLIC_API_ENDPOINTS.some(endpoint => routeCoversEndpoint(route, endpoint)) &&
          !NON_CONTRACT_ROUTE_REASONS.some(exclusion => exclusion.pattern.test(route.path)),
      )
      .map(route => `${route.method} ${route.path}`)
    expect(uncovered).toEqual([])

    for (const exclusion of NON_CONTRACT_ROUTE_REASONS) {
      expect(
        routes.some(route => exclusion.pattern.test(route.path)),
        exclusion.reason,
      ).toBe(true)
    }
  })

  test('app endpoint metadata publishes name and icon request fields', () => {
    const register = PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === 'apps.register')
    const update = PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === 'apps.update')

    expect(
      register?.requestSchema?.safeParse({
        path: 'apps/status',
        command: 'bun run start',
        apiScopes: ['services'],
        slug: 'status',
        name: 'Status Board',
        icon: 'assets/icon.png',
      }).success,
    ).toBe(true)
    expect(
      update?.requestSchema?.safeParse({ name: 'Status Board', icon: 'assets/icon.png' }).success,
    ).toBe(true)
  })
})

function routeCoversEndpoint(
  route: { method: string; path: string },
  endpoint: PublicApiEndpointMetadata,
): boolean {
  // HEAD is the header-only form of the corresponding published GET
  // capability, not a separate customer-facing operation.
  if (route.method !== endpoint.method && !(route.method === 'HEAD' && endpoint.method === 'GET')) {
    return false
  }
  const endpointPath = endpoint.path.split('?')[0]!.replaceAll(/\{[^}]+\}/g, ':parameter')
  const routePath = route.path.replaceAll(/:[^/]+/g, ':parameter')
  if (routePath === endpointPath) return true

  if (routePath.endsWith('/*')) {
    return endpointPath.startsWith(`${routePath.slice(0, -2)}/`)
  }

  // The files proxy registers the drive root separately from its wildcard.
  return routePath.endsWith('/files') && endpointPath.startsWith(`${routePath}/`)
}
