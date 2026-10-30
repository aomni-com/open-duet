import { describe, expect, test } from 'bun:test'

import {
  DesktopFocusErrorSchema,
  DesktopFocusRequestSchema,
  DesktopSessionErrorSchema,
  DesktopSessionRequestSchema,
  DesktopSessionResponseSchema,
  DesktopStatusErrorSchema,
  DesktopStatusResponseSchema,
  FocusBrowserOwnerResultSchema,
} from '../desktop'
import { FileDownloadRequestSchema, FileResourceSchema, FileUploadRequestSchema } from '../files'
import { SessionSummarySchema } from '../sessions'
import { VmUploadGrantSchema } from '../vm/uploads'
import {
  DEVELOPER_API_ENDPOINTS,
  PUBLIC_API_ENDPOINT_CATEGORIES,
  PUBLIC_API_ENDPOINTS,
} from './index'

describe('public endpoint metadata', () => {
  test('marks every browsable collection for pagination', () => {
    const collectionEndpoints = PUBLIC_API_ENDPOINTS.filter(
      endpoint => endpoint.collection !== undefined,
    )

    expect(collectionEndpoints.map(endpoint => endpoint.id).sort()).toEqual(
      [
        'agents.defaultSession.history',
        'agents.list',
        'agents.reachableRoster',
        'anchors.list',
        'app-domains.list',
        'apps.list',
        'billing.ledger',
        'backups.list',
        'file-activity.feed',
        'file-activity.history',
        'file-activity.seen-by',
        'files.list',
        'integrations.catalog',
        'integrations.connections',
        'marketplace.catalog',
        'marketplace.subscriptions.list',
        'mcp-servers.list',
        'mirror-devices.list',
        'publishes.list',
        'services.list',
        'sessions.history',
        'sessions.audience',
        'sessions.children',
        'sessions.list',
        'shares.list',
        'shares.pending',
        'skills.list',
        'train.agent.jobs.list',
        'train.agent.records.list',
        'train.agent.uploads.list',
        'train.jobs.list',
        'train.records.list',
        'train.uploads.list',
        'user-billing-history',
        'user-invitations-list',
        'user-keys-list',
        'user-oauth-grants-list',
        'user-sync-machines-list',
        'workspace-audit-list',
        'workspace-invite-list',
        'workspace-members-list',
      ].sort(),
    )
    for (const endpoint of collectionEndpoints) {
      const collection = endpoint.collection
      expect(collection).toBeDefined()
      if (collection === undefined) throw new Error(`Missing collection metadata: ${endpoint.id}`)
      expect(endpoint.querySchema, `${endpoint.id} collection query schema`).toBeDefined()
      expect(endpoint.responseSchema, `${endpoint.id} collection response schema`).toBeDefined()
      expect(collection.order.length).toBeGreaterThan(0)
      expect(collection.cursorDomain.length).toBeGreaterThan(0)
      if (collection.migrationSlice !== undefined)
        expect(['02', '03', '04a', '04b', '04c', '16', '17']).toContain(collection.migrationSlice)
    }

    for (const boundedId of [
      'file-activity.latest-writers',
      'sessions.activity',
      'memory.search',
      'workspace-usage',
      'workspace-telemetry',
      'file-activity.events',
      'sessions.events',
      'identity.whoami',
      'user-billing-get',
      'apps.credentials.list',
    ]) {
      expect(PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === boundedId)?.collection).toBe(
        undefined,
      )
    }
  })

  test('publishes the shared invalid-cursor body for every collection continuation', () => {
    for (const endpoint of PUBLIC_API_ENDPOINTS.filter(candidate => candidate.collection)) {
      expect(
        endpoint.errorSchema?.safeParse({ error: 'invalid_cursor' }).success,
        endpoint.id,
      ).toBe(true)
    }
  })

  test('composes only the session errors each collection can actually return', () => {
    const errorSchema = (id: string) =>
      PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === id)?.errorSchema

    expect(errorSchema('sessions.history')?.safeParse({ error: 'not_found' }).success).toBe(true)
    expect(
      errorSchema('sessions.history')?.safeParse({ error: 'audience_kind_immutable' }).success,
    ).toBe(false)

    expect(errorSchema('sessions.audience')?.safeParse({ error: 'not_found' }).success).toBe(true)
    expect(
      errorSchema('sessions.audience')?.safeParse({ error: 'audience_kind_immutable' }).success,
    ).toBe(true)
    expect(
      errorSchema('sessions.audience')?.safeParse({ error: 'invalid_audience_member' }).success,
    ).toBe(false)

    expect(
      errorSchema('agents.defaultSession.history')?.safeParse({ error: 'no_default_session' })
        .success,
    ).toBe(true)
    expect(
      errorSchema('agents.defaultSession.history')?.safeParse({ error: 'not_found' }).success,
    ).toBe(true)
  })

  test('contains unique public ids and versioned paths when endpoints are published', () => {
    const ids = new Set<string>()
    for (const endpoint of PUBLIC_API_ENDPOINTS) {
      expect(ids.has(endpoint.id)).toBe(false)
      ids.add(endpoint.id)
      expect(endpoint.path.startsWith('/v1/')).toBe(true)
    }
  })

  test('lets sessions clients use the existing member directory for audience ids', () => {
    expect(
      PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === 'workspace-members-list')?.scope,
    ).toEqual(['ws:{workspaceSlug}:sessions', 'ws:{workspaceSlug}:files:read'])
  })

  // One family for every owner. The drive root has no aliases of its own: it is
  // `agents/root`, which the slug grammar reserves so no agent can claim it.
  test('publishes one default-session alias family with the sessions scope', () => {
    const aliases = PUBLIC_API_ENDPOINTS.filter(endpoint =>
      endpoint.path.includes('/sessions/default'),
    )
    expect(aliases.map(endpoint => [endpoint.method, endpoint.path, endpoint.scope])).toEqual([
      [
        'GET',
        '/v1/ws/{workspaceSlug}/agents/{agentSlug}/sessions/default',
        'ws:{workspaceSlug}:sessions',
      ],
      [
        'PUT',
        '/v1/ws/{workspaceSlug}/agents/{agentSlug}/sessions/default',
        'ws:{workspaceSlug}:sessions',
      ],
      [
        'GET',
        '/v1/ws/{workspaceSlug}/agents/{agentSlug}/sessions/default/history',
        'ws:{workspaceSlug}:sessions',
      ],
      [
        'POST',
        '/v1/ws/{workspaceSlug}/agents/{agentSlug}/sessions/default/messages',
        'ws:{workspaceSlug}:sessions',
      ],
      [
        'POST',
        '/v1/ws/{workspaceSlug}/agents/{agentSlug}/sessions/default/messages/wait',
        'ws:{workspaceSlug}:sessions',
      ],
    ])
  })

  test('publishes nested session creation with the sessions scope', () => {
    expect(
      PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === 'sessions.createNested'),
    ).toMatchObject({
      method: 'POST',
      path: '/v1/ws/{workspaceSlug}/agent/sessions/{sessionId}/sessions',
      scope: 'ws:{workspaceSlug}:sessions',
    })
  })

  test('publishes both successful audience-update outcomes', () => {
    const endpoint = PUBLIC_API_ENDPOINTS.find(
      candidate => candidate.id === 'sessions.audience.update',
    )

    expect(endpoint?.successResponses).toEqual([
      { status: 200, responseSchema: SessionSummarySchema },
      { status: 204, responseBody: 'none' },
    ])
  })

  test('publishes direct child pagination beside nested session creation', () => {
    expect(
      PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === 'sessions.children'),
    ).toMatchObject({
      method: 'GET',
      path: '/v1/ws/{workspaceSlug}/agent/sessions/{sessionId}/sessions',
      scope: 'ws:{workspaceSlug}:sessions',
      collection: {
        order: 'update time desc, session id desc',
        cursorDomain: 'workspace + principal discovery scope + parent + bucket/archive filters',
      },
    })
  })

  test('publishes the shared desktop session, status, and focus contract', () => {
    expect(
      PUBLIC_API_ENDPOINTS.filter(endpoint => endpoint.category === 'desktop').map(endpoint => ({
        id: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        scope: endpoint.scope,
        requestSchema: endpoint.requestSchema,
        responseSchema: endpoint.responseSchema,
        errorSchema: endpoint.errorSchema,
        idempotent: endpoint.idempotent,
      })),
    ).toEqual([
      {
        id: 'desktop.session',
        method: 'POST',
        path: '/v1/ws/{workspaceSlug}/desktop/session',
        scope: 'ws:{workspaceSlug}:sessions',
        requestSchema: DesktopSessionRequestSchema,
        responseSchema: DesktopSessionResponseSchema,
        errorSchema: DesktopSessionErrorSchema,
        idempotent: undefined,
      },
      {
        id: 'desktop.status',
        method: 'GET',
        path: '/v1/ws/{workspaceSlug}/desktop/status',
        scope: 'ws:{workspaceSlug}:sessions',
        requestSchema: undefined,
        responseSchema: DesktopStatusResponseSchema,
        errorSchema: DesktopStatusErrorSchema,
        idempotent: undefined,
      },
      {
        id: 'desktop.focus',
        method: 'POST',
        path: '/v1/ws/{workspaceSlug}/agents/{agentSlug}/desktop/focus',
        scope: 'ws:{workspaceSlug}:sessions',
        requestSchema: DesktopFocusRequestSchema,
        responseSchema: FocusBrowserOwnerResultSchema,
        errorSchema: DesktopFocusErrorSchema,
        idempotent: true,
      },
    ])
  })

  test('publishes the complete foreground wait matrix on explicit paths', () => {
    expect(
      PUBLIC_API_ENDPOINTS.filter(endpoint => endpoint.id.endsWith('.wait')).map(endpoint => [
        endpoint.id,
        endpoint.method,
        endpoint.path,
        endpoint.scope,
      ]),
    ).toEqual([
      [
        'sessions.create.wait',
        'POST',
        '/v1/ws/{workspaceSlug}/agent/sessions/wait',
        'ws:{workspaceSlug}:sessions',
      ],
      [
        'sessions.createNested.wait',
        'POST',
        '/v1/ws/{workspaceSlug}/agent/sessions/{sessionId}/sessions/wait',
        'ws:{workspaceSlug}:sessions',
      ],
      [
        'agents.defaultSession.message.wait',
        'POST',
        '/v1/ws/{workspaceSlug}/agents/{agentSlug}/sessions/default/messages/wait',
        'ws:{workspaceSlug}:sessions',
      ],
      [
        'sessions.message.wait',
        'POST',
        '/v1/ws/{workspaceSlug}/agent/sessions/{sessionId}/messages/wait',
        'ws:{workspaceSlug}:sessions',
      ],
      [
        'sessions.answer.wait',
        'POST',
        '/v1/ws/{workspaceSlug}/agent/sessions/{sessionId}/answer/wait',
        'ws:{workspaceSlug}:sessions',
      ],
    ])

    // Only endpoints with their own typed errors declare an errorSchema.
    for (const endpoint of PUBLIC_API_ENDPOINTS.filter(endpoint => endpoint.id.endsWith('.wait'))) {
      expect(endpoint.requestSchema).toBeDefined()
      expect(endpoint.responseSchema).toBeDefined()
    }
  })

  test('publishes the complete Apps management surface from shared schemas', () => {
    expect(
      PUBLIC_API_ENDPOINTS.filter(endpoint => endpoint.category === 'apps').map(endpoint => [
        endpoint.method,
        endpoint.path,
      ]),
    ).toEqual([
      ['GET', '/v1/ws/{workspaceSlug}/app-domains'],
      ['GET', '/v1/ws/{workspaceSlug}/apps/{slug}/domain'],
      ['PUT', '/v1/ws/{workspaceSlug}/apps/{slug}/domain'],
      ['POST', '/v1/ws/{workspaceSlug}/apps/{slug}/domain/recheck'],
      ['DELETE', '/v1/ws/{workspaceSlug}/apps/{slug}/domain'],
      ['GET', '/v1/ws/{workspaceSlug}/apps'],
      ['POST', '/v1/ws/{workspaceSlug}/apps/{appSlug}/credentials/export'],
      ['GET', '/v1/ws/{workspaceSlug}/apps/{appSlug}/credentials'],
      ['DELETE', '/v1/ws/{workspaceSlug}/apps/{appSlug}/credentials/{credentialId}'],
      // Answers 302 rather than JSON, which is why it was private until the
      // ledger learned to model a redirect.
      ['GET', '/v1/ws/{workspaceSlug}/apps/{slug}/launch'],
      ['POST', '/v1/ws/{workspaceSlug}/apps'],
      ['GET', '/v1/ws/{workspaceSlug}/apps/{appSlug}'],
      ['PATCH', '/v1/ws/{workspaceSlug}/apps/{appSlug}'],
      ['POST', '/v1/ws/{workspaceSlug}/apps/{appSlug}/reanchor'],
      ['POST', '/v1/ws/{workspaceSlug}/apps/{appSlug}/visibility'],
      ['POST', '/v1/ws/{workspaceSlug}/apps/{appSlug}/disabled'],
      ['DELETE', '/v1/ws/{workspaceSlug}/apps/{appSlug}'],
    ])
  })

  test('publishes the complete agent management surface from shared schemas', () => {
    expect(
      PUBLIC_API_ENDPOINTS.filter(endpoint => endpoint.category === 'agents').map(endpoint => [
        endpoint.method,
        endpoint.path,
      ]),
    ).toEqual([
      ['GET', '/v1/ws/{workspaceSlug}/agents'],
      ['GET', '/v1/ws/{workspaceSlug}/agents/{agentSlug}/roster'],
      ['POST', '/v1/ws/{workspaceSlug}/agents'],
      // Listed before `{agentSlug}` because it must be REGISTERED before it:
      // `root` is a reserved slug, and this catalog's order is the router's.
      ['PATCH', '/v1/ws/{workspaceSlug}/agents/root'],
      ['PATCH', '/v1/ws/{workspaceSlug}/agents/{agentSlug}'],
      ['POST', '/v1/ws/{workspaceSlug}/agents/{agentSlug}/disabled'],
      ['POST', '/v1/ws/{workspaceSlug}/agents/{agentSlug}/onboarded'],
      ['POST', '/v1/ws/{workspaceSlug}/agent/sessions/{sessionId}/onboarded'],
      ['POST', '/v1/ws/{workspaceSlug}/app/onboarded'],
      ['POST', '/v1/ws/{workspaceSlug}/agents/{agentSlug}/onboarding-session'],
      ['DELETE', '/v1/ws/{workspaceSlug}/agents/{agentSlug}'],
      ['GET', '/v1/marketplace'],
      ['GET', '/v1/marketplace/{publisherSlug}/{agentName}'],
      ['GET', '/v1/ws/{workspaceSlug}/marketplace/subscriptions'],
      ['POST', '/v1/ws/{workspaceSlug}/listings'],
      ['DELETE', '/v1/ws/{workspaceSlug}/listings/{listingId}'],
      ['POST', '/v1/ws/{workspaceSlug}/marketplace/subscriptions'],
      ['POST', '/v1/ws/{workspaceSlug}/onboarding'],
      ['POST', '/v1/ws/{workspaceSlug}/onboarding/recommendations'],
      ['POST', '/v1/ws/{workspaceSlug}/marketplace/subscriptions/clone'],
      ['POST', '/v1/ws/{workspaceSlug}/marketplace/subscriptions/{subscriptionId}/acknowledge'],
      ['DELETE', '/v1/ws/{workspaceSlug}/marketplace/subscriptions/{subscriptionId}'],
    ])
  })

  test('keeps scoped Train endpoints in parity and publishes counts once at the root', () => {
    const agentCounts = PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === 'train.memoryCounts')
    const rootTrain = PUBLIC_API_ENDPOINTS.filter(
      endpoint =>
        endpoint.id.startsWith('train.') &&
        !endpoint.id.startsWith('train.agent.') &&
        endpoint.id !== 'train.memoryCounts',
    )
    const agentTrain = PUBLIC_API_ENDPOINTS.filter(endpoint =>
      endpoint.id.startsWith('train.agent.'),
    )

    expect(agentCounts).toMatchObject({
      method: 'GET',
      path: '/v1/ws/{workspaceSlug}/train/memory-counts',
      scope: 'ws:{workspaceSlug}:memory',
      additionalScopes: ['ws:{workspaceSlug}:agents'],
    })
    expect(agentTrain).toHaveLength(rootTrain.length)
    for (const root of rootTrain) {
      const agent = agentTrain.find(
        endpoint => endpoint.id === root.id.replace('train.', 'train.agent.'),
      )
      expect(agent, root.id).toBeDefined()
      const agentPath = root.path.replace(
        '/v1/ws/{workspaceSlug}/train',
        '/v1/ws/{workspaceSlug}/agents/{agentSlug}/train',
      ) as `/v1/${string}`
      expect(agent?.path).toBe(agentPath)
      expect(agent?.method).toBe(root.method)
      expect(agent?.scope).toEqual(root.scope)
      expect(agent?.requestSchema).toBe(root.requestSchema)
      expect(agent?.querySchema).toBe(root.querySchema)
      expect(agent?.responseSchema).toBe(root.responseSchema)
      expect(agent?.errorSchema).toBe(root.errorSchema)
      expect(agent?.requestBody).toBe(root.requestBody)
      expect(agent?.responseBody).toBe(root.responseBody)
    }

    expect(PUBLIC_API_ENDPOINTS.some(endpoint => endpoint.id.startsWith('memory.agent.'))).toBe(
      false,
    )
  })

  test('publishes the complete files transport and explicit action seam', () => {
    expect(
      PUBLIC_API_ENDPOINTS.filter(endpoint => endpoint.category === 'files').map(endpoint => ({
        id: endpoint.id,
        method: endpoint.method,
        scope: endpoint.scope,
        requestBody: endpoint.requestBody,
        responseBody: endpoint.responseBody,
      })),
    ).toEqual([
      {
        id: 'files.list',
        method: 'GET',
        scope: 'ws:{workspaceSlug}:files:read',
        requestBody: undefined,
        responseBody: undefined,
      },
      {
        id: 'files.stat',
        method: 'GET',
        scope: 'ws:{workspaceSlug}:files:read',
        requestBody: undefined,
        responseBody: undefined,
      },
      {
        id: 'files.read',
        method: 'GET',
        scope: 'ws:{workspaceSlug}:files:read',
        requestBody: undefined,
        responseBody: 'binary',
      },
      {
        id: 'files.write',
        method: 'PUT',
        scope: 'ws:{workspaceSlug}:files:write',
        requestBody: 'binary',
        responseBody: undefined,
      },
      {
        id: 'files.delete',
        method: 'DELETE',
        scope: 'ws:{workspaceSlug}:files:write',
        requestBody: undefined,
        responseBody: undefined,
      },
      {
        id: 'files.actions',
        method: 'POST',
        scope: 'ws:{workspaceSlug}:files:write',
        requestBody: undefined,
        responseBody: undefined,
      },
      {
        id: 'files.downloads.create',
        method: 'POST',
        scope: 'ws:{workspaceSlug}:files:read',
        requestBody: undefined,
        responseBody: undefined,
      },
      {
        id: 'files.uploads.create',
        method: 'POST',
        scope: 'ws:{workspaceSlug}:files:write',
        requestBody: undefined,
        responseBody: undefined,
      },
    ])
  })

  test('publishes separate read and write transfer-capability mints', () => {
    expect(
      PUBLIC_API_ENDPOINTS.filter(endpoint =>
        ['files.downloads.create', 'files.uploads.create'].includes(endpoint.id),
      ).map(endpoint => ({
        id: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        scope: endpoint.scope,
        requestSchema: endpoint.requestSchema,
        responseSchema: endpoint.responseSchema,
      })),
    ).toEqual([
      {
        id: 'files.downloads.create',
        method: 'POST',
        path: '/v1/ws/{workspaceSlug}/file-downloads',
        scope: 'ws:{workspaceSlug}:files:read',
        requestSchema: FileDownloadRequestSchema,
        responseSchema: FileResourceSchema,
      },
      {
        id: 'files.uploads.create',
        method: 'POST',
        path: '/v1/ws/{workspaceSlug}/file-uploads',
        scope: 'ws:{workspaceSlug}:files:write',
        requestSchema: FileUploadRequestSchema,
        responseSchema: VmUploadGrantSchema,
      },
    ])
  })

  // Scoped by id rather than by category: `integrations` is now two families,
  // and this claim is about the Composio one. The custom-MCP-server family is
  // pinned by the test below, deliberately apart — sharing a docs category is
  // the only thing the two share, and a Composio outage must not be able to
  // take a workspace's own servers off its list.
  test('publishes lifecycle separately from the sole charged integration action', () => {
    expect(
      PUBLIC_API_ENDPOINTS.filter(
        endpoint => endpoint.id.startsWith('integrations.') && endpoint.scope !== 'api_key',
      ).map(endpoint => [endpoint.method, endpoint.path]),
    ).toEqual([
      ['GET', '/v1/ws/{workspaceSlug}/integrations/catalog'],
      ['POST', '/v1/ws/{workspaceSlug}/integrations/connect'],
      ['GET', '/v1/ws/{workspaceSlug}/integrations/connections'],
      ['DELETE', '/v1/ws/{workspaceSlug}/integrations/connections/{connectionId}'],
      ['PUT', '/v1/ws/{workspaceSlug}/integrations/{toolkitSlug}/agent-policy'],
    ])
    expect(
      PUBLIC_API_ENDPOINTS.filter(
        endpoint => endpoint.category === 'integrations' && endpoint.scope === 'api_key',
      ).map(endpoint => [endpoint.id, endpoint.method, endpoint.path]),
    ).toEqual([['composio.execute', 'POST', '/v1/integrations/composio/execute/{toolSlug}']])
  })

  // Custom MCP servers reuse the `integrations` capability rather than minting
  // one: the scope already exists, is already elevated, and already guards the
  // Composio routes these sit beside.
  test('publishes the custom MCP server family under the existing integrations scope', () => {
    const family = PUBLIC_API_ENDPOINTS.filter(endpoint => endpoint.id.startsWith('mcp-servers.'))
    expect(family.map(endpoint => [endpoint.id, endpoint.method, endpoint.path])).toEqual([
      ['mcp-servers.probe', 'POST', '/v1/ws/{workspaceSlug}/mcp-servers/probe'],
      ['mcp-servers.add', 'POST', '/v1/ws/{workspaceSlug}/mcp-servers'],
      ['mcp-servers.list', 'GET', '/v1/ws/{workspaceSlug}/mcp-servers'],
      ['mcp-servers.remove', 'DELETE', '/v1/ws/{workspaceSlug}/mcp-servers/{name}'],
      ['mcp-servers.agent-policy', 'PUT', '/v1/ws/{workspaceSlug}/mcp-servers/{name}/agent-policy'],
    ])
    expect(new Set(family.map(endpoint => endpoint.scope))).toEqual(
      new Set(['ws:{workspaceSlug}:integrations']),
    )
    expect(new Set(family.map(endpoint => endpoint.category))).toEqual(new Set(['integrations']))
    // Re-running a removal or a policy write must be safe: both converge on a
    // stated end state rather than toggling one.
    expect(family.filter(endpoint => endpoint.idempotent === true).map(endpoint => endpoint.id)) //
      .toEqual(['mcp-servers.remove', 'mcp-servers.agent-policy'])
  })

  test('publishes every developer category without dashboard-only credentials', () => {
    expect(new Set(DEVELOPER_API_ENDPOINTS.map(endpoint => endpoint.category))).toEqual(
      new Set(PUBLIC_API_ENDPOINT_CATEGORIES),
    )
    expect(
      DEVELOPER_API_ENDPOINTS.some(endpoint =>
        (Array.isArray(endpoint.scope) ? endpoint.scope : [endpoint.scope]).includes(
          'browser_session',
        ),
      ),
    ).toBe(false)
  })

  test('publishes the complete share and publish lifecycle', () => {
    expect(
      DEVELOPER_API_ENDPOINTS.filter(endpoint =>
        ['shares', 'publishes'].includes(endpoint.category),
      ).map(endpoint => [endpoint.method, endpoint.path]),
    ).toEqual([
      ['GET', '/v1/ws/{workspaceSlug}/shares'],
      ['POST', '/v1/ws/{workspaceSlug}/shares'],
      ['POST', '/v1/ws/{workspaceSlug}/shares/{shareId}/reshares'],
      ['POST', '/v1/share-requests/{shareId}/accept'],
      ['GET', '/v1/share-requests'],
      ['GET', '/v1/share-requests/{token}'],
      ['POST', '/v1/share-requests/{shareId}/decline'],
      ['POST', '/v1/ws/{workspaceSlug}/shares/{shareId}/pause'],
      ['POST', '/v1/ws/{workspaceSlug}/shares/{shareId}/unlink'],
      ['DELETE', '/v1/ws/{workspaceSlug}/shares/{shareId}'],
      ['GET', '/v1/ws/{workspaceSlug}/publishes'],
      ['POST', '/v1/ws/{workspaceSlug}/publishes'],
      ['PATCH', '/v1/ws/{workspaceSlug}/publishes/{slug}'],
      ['DELETE', '/v1/ws/{workspaceSlug}/publishes/{slug}'],
      ['POST', '/v1/ws/{workspaceSlug}/publishes/{slug}/pause'],
    ])
  })

  test('publishes recipient share requests for human callers', () => {
    expect(
      PUBLIC_API_ENDPOINTS.filter(
        endpoint => endpoint.category === 'shares' && endpoint.scope === 'human',
      ).map(endpoint => [endpoint.method, endpoint.path]),
    ).toEqual([
      ['POST', '/v1/share-requests/{shareId}/accept'],
      ['GET', '/v1/share-requests'],
      ['GET', '/v1/share-requests/{token}'],
      ['POST', '/v1/share-requests/{shareId}/decline'],
    ])
  })

  test('publishes human login approval and delegated OAuth consent', () => {
    expect(
      PUBLIC_API_ENDPOINTS.filter(endpoint => endpoint.id.startsWith('device-approval-')).map(
        endpoint => endpoint.id,
      ),
    ).toEqual(['device-approval-inspect', 'device-approval-approve', 'device-approval-deny'])
    expect(
      PUBLIC_API_ENDPOINTS.filter(endpoint => endpoint.id.startsWith('device-approval-'))
        .filter(
          endpoint =>
            endpoint.path.includes('/inspect') ||
            endpoint.path.includes('/approve') ||
            endpoint.path.includes('/deny'),
        )
        .map(endpoint => [endpoint.method, endpoint.path, endpoint.scope]),
    ).toEqual([
      ['POST', '/v1/device/inspect', 'human'],
      ['POST', '/v1/device/approve', 'human'],
      ['POST', '/v1/device/deny', 'human'],
    ])
    expect(
      DEVELOPER_API_ENDPOINTS.some(endpoint => endpoint.id.startsWith('device-approval-')),
    ).toBe(true)
    expect(
      PUBLIC_API_ENDPOINTS.filter(endpoint => endpoint.id.startsWith('oauth-authorization-')).map(
        endpoint => [endpoint.method, endpoint.path, endpoint.scope],
      ),
    ).toEqual([
      ['GET', '/v1/oauth/authorization/{requestId}', 'human'],
      ['POST', '/v1/oauth/authorization/{requestId}/approve', 'human'],
      ['POST', '/v1/oauth/authorization/{requestId}/deny', 'human'],
    ])
    expect(
      DEVELOPER_API_ENDPOINTS.some(endpoint => endpoint.id.startsWith('oauth-authorization-')),
    ).toBe(true)
  })

  test('owns query and resume facts instead of leaving them to prose', () => {
    for (const id of [
      'workspace-audit-list',
      'workspace-usage',
      'workspace-telemetry',
      'sessions.list',
      'sessions.history',
      'sessions.events',
      'memory.search',
      'train.jobs.list',
      'apps.list',
      'integrations.catalog',
    ]) {
      expect(
        PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === id)?.querySchema,
        id,
      ).toBeDefined()
    }
    expect(
      PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === 'sessions.events')?.requestHeaders,
    ).toEqual([
      { name: 'Last-Event-ID', description: 'Resume after the last committed numeric sequence.' },
    ])
  })

  test('collection metadata matches the production compound-index directions', () => {
    const collection = (id: string) =>
      PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === id)?.collection
    const order = (id: string) => collection(id)?.order
    expect(order('train.jobs.list')).toBe('creation time desc, job id desc')
    expect(order('train.agent.jobs.list')).toBe('creation time desc, job id desc')
    expect(order('sessions.list')).toBe('update time desc, session id desc, including search')
    expect(collection('marketplace.catalog')).toMatchObject({
      order: 'installs desc, internal creation time desc',
      cursorDomain: 'authenticated user + q/tag/availability/verifiedPublisher',
    })
    expect(collection('integrations.catalog')).toMatchObject({
      order: 'provider-native order',
      cursorDomain: 'workspace + q',
    })
    expect(collection('integrations.connections')).toMatchObject({
      order: 'provider-native order',
      cursorDomain: 'workspace',
    })
  })

  test('documents slug-based app repair as an app-shaped endpoint', () => {
    const endpoint = PUBLIC_API_ENDPOINTS.find(candidate => candidate.id === 'apps.reanchor')

    expect(endpoint).toMatchObject({
      method: 'POST',
      path: '/v1/ws/{workspaceSlug}/apps/{appSlug}/reanchor',
      scope: 'ws:{workspaceSlug}:apps',
    })
    expect(endpoint?.requestSchema).toBeDefined()
    expect(endpoint?.responseSchema).toBeDefined()
    expect(endpoint?.summary).toContain('broken')
  })

  test('publishes members only for invite management', () => {
    expect(
      PUBLIC_API_ENDPOINTS.filter(endpoint => endpoint.id.startsWith('workspace-invite-')).map(
        endpoint => endpoint.scope,
      ),
    ).toEqual([
      'ws:{workspaceSlug}:members',
      'ws:{workspaceSlug}:members',
      'ws:{workspaceSlug}:members',
    ])
    expect(
      PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === 'workspace-member-remove')?.scope,
    ).toBe('ws:{workspaceSlug}:admin')
    expect(
      PUBLIC_API_ENDPOINTS.find(endpoint => endpoint.id === 'workspace-member-role')?.scope,
    ).toBe('ws:{workspaceSlug}:admin')
  })
})

test('agents discover the complete backup lifecycle through one admin-scoped resource', () => {
  const endpoints = DEVELOPER_API_ENDPOINTS.filter(endpoint => endpoint.category === 'backups')
  expect(
    endpoints.map(endpoint => [endpoint.id, endpoint.method, endpoint.path, endpoint.scope]),
  ).toEqual([
    ['backups.create', 'POST', '/v1/ws/{workspaceSlug}/backups', 'ws:{workspaceSlug}:admin'],
    ['backups.list', 'GET', '/v1/ws/{workspaceSlug}/backups', 'ws:{workspaceSlug}:admin'],
    ['backups.get', 'GET', '/v1/ws/{workspaceSlug}/backups/{backupId}', 'ws:{workspaceSlug}:admin'],
    [
      'backups.download',
      'POST',
      '/v1/ws/{workspaceSlug}/backups/{backupId}/download',
      'ws:{workspaceSlug}:admin',
    ],
    [
      'backups.delete',
      'DELETE',
      '/v1/ws/{workspaceSlug}/backups/{backupId}',
      'ws:{workspaceSlug}:admin',
    ],
  ])
})
