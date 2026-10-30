import { describe, expect, test } from 'bun:test'

import {
  INTERNAL_ADMIN_VM_OPERATIONS,
  canonicalAppUrl,
  DUET_EDGE_HOST,
  type AppListResponse,
  type WhoamiResponse,
} from '@repo/contract'

import { DuetApiClient, ROOT_TRAIN_SCOPE, marketplaceMutationErrorPayload } from './client'

const IDENTITY: WhoamiResponse = {
  user: { id: 'user_1', email: 'owner@example.com', name: 'Owner' },
  workspaces: [
    {
      id: 'workspace_1',
      slug: 'acme',
      name: 'Acme',
      status: 'active',
      servicingStatus: 'active',
      role: 'owner',
      billingUserId: 'user_1',
      funding: { plan: null, active: true },
      creditRecovery: null,
      defaultTier: { effective: 'balanced' },
    },
  ],
  scopes: ['ws:acme:admin'],
  versions: { api: 1 },
  internalAdmin: false,
}

describe('Duet SPA API client', () => {
  test('routes user cleanup preview, start, status, and retry through the v1 seam', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const operation = {
      operationId: 'operation_1', targetUserId: 'user_1', status: 'scheduled', canRetry: false,
      resources: [], auditId: 'audit_1',
    }
    const preview = {
      user: { userId: 'user_1', email: 'owner@gmail.com' }, selfTarget: false,
      alreadyRetired: false, canStart: true, workspaces: [], blockers: [],
      identity: { kind: 'retire_identity', userId: 'user_1' },
      retainedHistory: { kind: 'retained_history', tables: [] }, auditId: 'audit_preview',
    }
    const client = new DuetApiClient(async (input, init) => {
      requests.push({ path: String(input), method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : await new Response(init.body).text() })
      const path = String(input)
      return Response.json(path.includes('/users?q=') ? preview : operation)
    })
    await client.internalAdminUserCleanupPreview('Owner+alias@gmail.com')
    await client.internalAdminStartUserCleanup('user_1', 'Requested cleanup')
    await client.internalAdminCleanupStatus('operation_1')
    await client.internalAdminRetryUserCleanup('operation_1', 'Retry cleanup')
    expect(requests).toEqual([
      { path: '/api/duet/internal-admin/users?q=Owner%2Balias%40gmail.com', method: 'GET' },
      { path: '/api/duet/internal-admin/users/user_1/cleanup', method: 'POST', body: JSON.stringify({ reason: 'Requested cleanup' }) },
      { path: '/api/duet/internal-admin/cleanup/operation_1', method: 'GET' },
      { path: '/api/duet/internal-admin/cleanup/operation_1/retry', method: 'POST', body: JSON.stringify({ reason: 'Retry cleanup' }) },
    ])
  })

  test('limits workspace usage to the current monthly period', async () => {
    const requests: string[] = []
    const client = new DuetApiClient(async input => {
      requests.push(String(input))
      return Response.json({ period: 'monthly', group: 'workspace', rows: [] })
    })

    await client.workspaceUsage('acme')

    const request = requests[0]!
    expect(request).toMatch(
      /\/api\/duet\/ws\/acme\/billing\/usage\?period=monthly&group=workspace&start=\d{4}-\d{2}&end=\d{4}-\d{2}$/,
    )
    const params = new URL(request, 'https://duet.test').searchParams
    expect(params.get('start')).toBe(params.get('end'))
  })

  test('requests historical usage at the selected rollup period', async () => {
    const requests: string[] = []
    const client = new DuetApiClient(async input => {
      requests.push(String(input))
      return Response.json({ period: 'weekly', group: 'workspace', rows: [] })
    })

    await client.workspaceUsage('acme', { period: 'weekly', currentOnly: false })

    expect(requests).toEqual(['/api/duet/ws/acme/billing/usage?period=weekly&group=workspace'])
  })

  test('pages one session direct children through its nested collection URL', async () => {
    const requests: string[] = []
    const client = new DuetApiClient(async input => {
      requests.push(String(input))
      return Response.json({ items: [], nextCursor: 'children-next' })
    })

    await expect(
      client.listSessionChildren('acme space', 'parent/session', {
        cursor: 'child page',
        limit: 12,
        bucket: 'running',
        archived: 'exclude',
      }),
    ).resolves.toEqual({ items: [], nextCursor: 'children-next' })
    expect(requests).toEqual([
      '/api/duet/ws/acme%20space/agent/sessions/parent%2Fsession/sessions?cursor=child+page&limit=12&bucket=running&archived=exclude',
    ])
  })

  test('settings collections forward the requested continuation page', async () => {
    const requests: string[] = []
    const client = new DuetApiClient(async input => {
      requests.push(String(input))
      return Response.json({ items: [], nextCursor: null })
    })

    await client.billingHistory({ cursor: 'billing page', limit: 21 })
    await client.listOAuthGrants({ cursor: 'grant page', limit: 22 })
    await client.listSyncMachines({ cursor: 'device page', limit: 23 })
    await client.listWorkspaceInvites('acme', { cursor: 'invite page', limit: 24 })
    await client.workspaceLedger('acme', { cursor: 'ledger page', limit: 25 })

    expect(requests).toEqual([
      '/api/duet/user/billing/history?cursor=billing+page&limit=21',
      '/api/duet/user/oauth-grants?cursor=grant+page&limit=22',
      '/api/duet/user/sync-machines?cursor=device+page&limit=23',
      '/api/duet/ws/acme/invites?cursor=invite+page&limit=24',
      '/api/duet/ws/acme/billing/ledger?cursor=ledger+page&limit=25',
    ])
  })

  test('a drive-root apps page keeps its empty path on the wire', async () => {
    const requests: string[] = []
    const client = new DuetApiClient(async input => {
      requests.push(String(input))
      return Response.json({
        items: [],
        nextCursor: null,
        meta: { capabilities: { register: false } },
      })
    })

    // The drive root is path '' — a value, not an absence. The API refuses a
    // scope without a path, so dropping the empty string 400s the Files tab
    // at the root of every workspace.
    await client.listApps('acme', { path: '', scope: 'children', limit: 100 })

    expect(requests).toEqual(['/api/duet/ws/acme/apps?limit=100&scope=children&path='])
  })

  test('reads one workspace-skill page with its working-directory cursor', async () => {
    const requests: string[] = []
    const client = new DuetApiClient(async input => {
      requests.push(String(input))
      return Response.json({
        items: [{ name: 'review', path: '/drive/.agents/skills/review' }],
        nextCursor: 'skills-next',
      })
    })

    await expect(
      client.listWorkspaceSkills('acme', 'agents/scout', { limit: 25, cursor: 'page one' }),
    ).resolves.toEqual({
      items: [{ name: 'review', path: '/drive/.agents/skills/review' }],
      nextCursor: 'skills-next',
    })
    expect(requests).toEqual([
      '/api/duet/ws/acme/skills?cwd=agents%2Fscout&cursor=page+one&limit=25',
    ])
  })

  test('reads one reachable-agent page with its opaque cursor', async () => {
    const requests: string[] = []
    const client = new DuetApiClient(async input => {
      requests.push(String(input))
      return Response.json({
        items: [
          {
            slug: 'scout',
            name: 'Scout',
            path: 'agents/scout',
            locked: false,
            relationship: 'child',
          },
        ],
        nextCursor: 'roster-next',
      })
    })

    await expect(
      client.readAgentRoster('acme', 'root', { limit: 25, cursor: 'page one' }),
    ).resolves.toEqual({
      items: [
        {
          slug: 'scout',
          name: 'Scout',
          path: 'agents/scout',
          locked: false,
          relationship: 'child',
        },
      ],
      nextCursor: 'roster-next',
    })
    expect(requests).toEqual(['/api/duet/ws/acme/agents/root/roster?cursor=page+one&limit=25'])
  })

  test('mints a direct upload grant for the folder it names', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const client = new DuetApiClient(async (path, init) => {
      requests.push({
        path: String(path),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      return Response.json({
        vmBaseUrl: 'https://vm.example/',
        uploadPath: '/v1/files/agents/research/uploads',
        uploadToken: 'token',
        expiresAt: 61_000,
      })
    })

    await expect(
      client.mintDriveUploadSession('acme space', 'agents/research/uploads'),
    ).resolves.toEqual({
      vmBaseUrl: 'https://vm.example/',
      uploadPath: '/v1/files/agents/research/uploads',
      uploadToken: 'token',
      expiresAt: 61_000,
    })
    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme%20space/file-uploads',
        method: 'POST',
        body: JSON.stringify({ pathPrefix: 'agents/research/uploads' }),
      },
    ])
  })

  test('mints, polls, and independently focuses the workspace desktop', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const client = new DuetApiClient(async (path, init) => {
      requests.push({
        path: String(path),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      if (String(path).endsWith('/desktop/focus')) return Response.json({ focused: true })
      return String(path).endsWith('/session')
        ? Response.json({
            entryUrl: 'https://vm.example/v1/desktop/grant.token/',
            expiresAt: 123_000,
            phase: 'starting',
            screen: { width: 1440, height: 900 },
          })
        : Response.json({ phase: 'ready', viewers: 1, owners: [] })
    })

    await expect(
      client.mintDesktopSession('acme space', 'https://customer.example'),
    ).resolves.toMatchObject({
      phase: 'starting',
      screen: { width: 1440, height: 900 },
    })
    await expect(client.readDesktopStatus('acme space')).resolves.toEqual({
      phase: 'ready',
      viewers: 1,
      owners: [],
    })
    await expect(
      client.focusDesktopOwner('acme space', 'research agent', 'request-1'),
    ).resolves.toEqual({ focused: true })
    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme%20space/desktop/session',
        method: 'POST',
        body: JSON.stringify({ embedOrigin: 'https://customer.example' }),
      },
      { path: '/api/duet/ws/acme%20space/desktop/status', method: 'GET' },
      {
        path: '/api/duet/ws/acme%20space/agents/research%20agent/desktop/focus',
        method: 'POST',
        body: JSON.stringify({ requestId: 'request-1' }),
      },
    ])
  })

  test('sets the workspace default tier through the existing admin endpoint', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const client = new DuetApiClient(async (path, init) => {
      requests.push({
        path: String(path),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      return Response.json({ tier: 'frontier' })
    })

    await expect(client.setWorkspaceDefaultTier('acme', 'frontier')).resolves.toEqual({
      tier: 'frontier',
    })
    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme/default-model',
        method: 'PUT',
        body: JSON.stringify({ tier: 'frontier' }),
      },
    ])
  })

  test('requests onboarding recommendations and refuses a partial (non-4) list', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const picks = [
      { agentName: 'research-assistant', reason: 'Digs into your market questions.' },
      { agentName: 'writing-editor', reason: 'Polishes your outreach drafts.' },
      { agentName: 'data-analyst', reason: 'Reads the numbers behind your leads.' },
      { agentName: 'seo-optimizer', reason: 'Grows your search visibility.' },
    ]
    const client = new DuetApiClient(async (path, init) => {
      requests.push({
        path: String(path),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      return Response.json({ recommendations: picks })
    })

    await expect(
      client.recommendOnboardingAgents('acme space', {
        purpose: 'Goal: grow my business.',
        tagHints: ['sales', 'marketing'],
      }),
    ).resolves.toEqual({ recommendations: picks })
    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme%20space/onboarding/recommendations',
        method: 'POST',
        body: JSON.stringify({
          purpose: 'Goal: grow my business.',
          tagHints: ['sales', 'marketing'],
        }),
      },
    ])

    // The exactly-4-or-nothing wire contract holds at the client edge too.
    const partial = new DuetApiClient(async () =>
      Response.json({ recommendations: picks.slice(0, 2) }),
    )
    await expect(
      partial.recommendOnboardingAgents('acme', { purpose: 'Goal: grow my business.' }),
    ).rejects.toThrow()
  })

  test('records an allowed product-browser analytics event through the private proxy', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const client = new DuetApiClient(async (path, init) => {
      requests.push({
        path: String(path),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      return Response.json({})
    })
    const event = {
      id: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
      name: 'onboarding.started' as const,
      workspaceId: 'workspace_1',
      properties: {},
    }

    await client.recordAnalyticsEvent(event)

    expect(requests).toEqual([
      {
        path: '/api/duet/analytics/events',
        method: 'POST',
        body: JSON.stringify(event),
      },
    ])
  })

  test('lists, connects, polls, and disconnects providers through workspace browser routes', async () => {
    const requests: Array<{ path: string; method: string }> = []
    const responses = [
      [
        {
          provider: 'openai-codex',
          state: 'connected',
          connectedAt: 1,
          connectedByUserId: 'user_1',
          connectedByLabel: 'David',
          canDisconnect: true,
        },
      ],
      {
        sessionId: 'session-1',
        intervalMs: 1_000,
      },
      { status: 'pending' },
      { ok: true },
    ]
    const client = new DuetApiClient(async (input, init) => {
      requests.push({ path: String(input), method: init?.method ?? 'GET' })
      return Response.json(responses.shift())
    })

    await expect(client.listConnectedProviders('acme')).resolves.toMatchObject([
      { provider: 'openai-codex', canDisconnect: true },
    ])
    await expect(client.connectConnectedProvider('acme', 'github-copilot')).resolves.toMatchObject({
      sessionId: 'session-1',
    })
    await expect(client.pollConnectedProvider('acme', 'session-1')).resolves.toEqual({
      status: 'pending',
    })
    await expect(client.disconnectConnectedProvider('acme', 'openai-codex')).resolves.toEqual({
      ok: true,
    })

    expect(requests).toEqual([
      { path: '/api/duet/ws/acme/connected-providers', method: 'GET' },
      {
        path: '/api/duet/ws/acme/connected-providers/github-copilot/connect',
        method: 'POST',
      },
      {
        path: '/api/duet/ws/acme/connected-providers/connect/session-1',
        method: 'GET',
      },
      {
        path: '/api/duet/ws/acme/connected-providers/openai-codex',
        method: 'DELETE',
      },
    ])
  })

  test('creates and lists workspace shares through the typed browser REST seam', async () => {
    const share = {
      id: 'share_1',
      anchorId: 'anchor_1',
      originWorkspaceId: 'workspace_1',
      fromWorkspaceId: 'workspace_1',
      toEmail: 'teammate@example.com',
      mode: 'write' as const,
      ignorePatterns: ['**/.git', '(?d)**/node_modules', '**/.duet-anchor', '.env'],
      state: 'pending' as const,
      createdByUserId: 'user_1',
      createdAt: 1,
      expiresAt: 2,
      tokenPrefix: 'duet_share_abcd',
    }
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const listedShare = { ...share, sourcePath: 'launch' }
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      return init?.method === 'POST'
        ? Response.json({ share }, { status: 201 })
        : Response.json({
            items: [{ ...listedShare, direction: 'outgoing' }],
            nextCursor: null,
          })
    })

    await expect(
      client.createShare('acme', {
        path: 'launch',
        toEmail: 'teammate@example.com',
        mode: 'write',
        ignorePatterns: ['.env'],
      }),
    ).resolves.toEqual({ share })
    await expect(client.listShares('acme')).resolves.toEqual({
      items: [{ ...listedShare, direction: 'outgoing' }],
      nextCursor: null,
    })
    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme/shares',
        method: 'POST',
        body: JSON.stringify({
          path: 'launch',
          toEmail: 'teammate@example.com',
          mode: 'write',
          ignorePatterns: ['.env'],
        }),
      },
      {
        path: '/api/duet/ws/acme/shares',
        method: 'GET',
      },
    ])
  })

  test('unlinks incoming shares and revokes outgoing shares through workspace-scoped routes', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      return Response.json(
        init?.method === 'DELETE'
          ? { ok: true, revokedShareIds: ['share_outgoing'] }
          : { ok: true, unlinkedShareIds: ['share_incoming'] },
      )
    })

    await expect(client.unlinkShare('acme', 'share_incoming')).resolves.toEqual({
      ok: true,
      unlinkedShareIds: ['share_incoming'],
    })
    await expect(client.revokeShare('acme', 'share_outgoing')).resolves.toEqual({
      ok: true,
      revokedShareIds: ['share_outgoing'],
    })
    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme/shares/share_incoming/unlink',
        method: 'POST',
        body: '{}',
      },
      {
        path: '/api/duet/ws/acme/shares/share_outgoing',
        method: 'DELETE',
      },
    ])
  })

  test('lists publishes and changes publish and share pause state through workspace REST paths', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const publish = {
      id: 'publish_1',
      workspaceId: 'workspace_1',
      anchorId: 'anchor_1',
      anchorPath: 'Reports',
      slug: 'reports',
      kind: 'folder' as const,
      createdByUserId: 'user_1',
      createdAt: 1,
      updatedAt: 2,
    }
    const share = {
      id: 'share_1',
      anchorId: 'anchor_1',
      originWorkspaceId: 'workspace_1',
      fromWorkspaceId: 'workspace_1',
      toEmail: 'teammate@example.com',
      mode: 'read' as const,
      ignorePatterns: [],
      state: 'active' as const,
      createdByUserId: 'user_1',
      createdAt: 1,
      expiresAt: 2_000_000_000_000,
      tokenPrefix: 'duet_share_abcd',
    }
    const responses = [{ items: [publish], nextCursor: null }, { publish }, { share }]
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      return Response.json(responses.shift())
    })

    await client.listPublishes('acme')
    await client.setPublishPaused('acme', 'reports', true)
    await client.setSharePaused('acme', 'share_1', false)

    expect(requests).toEqual([
      { path: '/api/duet/ws/acme/publishes', method: 'GET' },
      {
        path: '/api/duet/ws/acme/publishes/reports/pause',
        method: 'POST',
        body: JSON.stringify({ paused: true }),
      },
      {
        path: '/api/duet/ws/acme/shares/share_1/pause',
        method: 'POST',
        body: JSON.stringify({ paused: false }),
      },
    ])
  })

  // Where the recipient mounted a share is theirs, not the sharer's. The
  // server owns that guarantee and is tested for it directly
  // (packages/backend/src/shares.test.ts asserts outgoing projections carry no
  // mountPath). This pins the client's half: even handed a leaking payload, the
  // path never reaches calling code. It used to reject the whole response
  // instead, which was a louder canary but also meant one new server-side field
  // could 502 a user's entire share list.
  test('an outgoing share list payload cannot deliver a recipient mount path to callers', async () => {
    const client = new DuetApiClient(async () =>
      Response.json({
        items: [
          {
            direction: 'outgoing',
            id: 'share_1',
            anchorId: 'anchor_1',
            originWorkspaceId: 'workspace_1',
            fromWorkspaceId: 'workspace_1',
            toEmail: 'teammate@example.com',
            toWorkspaceId: 'workspace_2',
            mode: 'read',
            ignorePatterns: [],
            state: 'active',
            createdByUserId: 'user_1',
            createdAt: 1,
            expiresAt: 2,
            acceptedAt: 2,
            tokenPrefix: 'duet_share_abcd',
            sourcePath: 'launch',
            mountPath: 'private/recipient/path',
          },
        ],
        nextCursor: null,
      }),
    )

    const listed = await client.listShares('acme')
    expect(listed.items[0]).not.toHaveProperty('mountPath')
    expect(JSON.stringify(listed)).not.toContain('private/recipient/path')
    // The legitimate origin-side field still arrives.
    expect(listed.items[0]).toMatchObject({ tokenPrefix: 'duet_share_abcd' })
  })

  test('invokes browser fetch without binding the API client as its receiver', async () => {
    function browserFetch(this: unknown) {
      expect(this).toBeUndefined()
      return Promise.resolve(Response.json(IDENTITY))
    }

    await expect(new DuetApiClient(browserFetch).whoami()).resolves.toEqual(IDENTITY)
  })

  test('loads identity through one same-origin whoami GET', async () => {
    const requests: Array<{ path: string; method: string; credentials?: RequestCredentials }> = []
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        credentials: init?.credentials,
      })
      return Response.json(IDENTITY)
    })

    await expect(client.whoami()).resolves.toEqual(IDENTITY)
    expect(requests).toEqual([
      { path: '/api/duet/whoami', method: 'GET', credentials: 'same-origin' },
    ])
  })

  test('posts minimal workspace creation and parses the provisioning result', async () => {
    let request: { path: string; init?: RequestInit } | undefined
    const client = new DuetApiClient(async (input, init) => {
      request = { path: String(input), init }
      return Response.json(
        { workspaceId: 'workspace_2', slug: 'new-space', status: 'provisioning' },
        { status: 202 },
      )
    })

    await expect(client.createWorkspace({ name: 'New Space', slug: 'new-space' })).resolves.toEqual(
      { workspaceId: 'workspace_2', slug: 'new-space', status: 'provisioning' },
    )
    expect(request?.path).toBe('/api/duet/workspaces')
    expect(request?.init?.body).toBe(JSON.stringify({ name: 'New Space', slug: 'new-space' }))
  })

  test('drives recipient share requests through the user-scoped browser session seam', async () => {
    const requests: Array<{ path: string; method: string; body?: BodyInit | null }> = []
    const pendingShare = {
      id: 'share_1',
      anchorId: 'anchor_1',
      originWorkspaceId: 'workspace_origin',
      fromWorkspaceId: 'workspace_origin',
      toEmail: 'owner@example.com',
      mode: 'read',
      ignorePatterns: [],
      state: 'pending',
      createdByUserId: 'user_sharer',
      createdAt: 1,
      expiresAt: 2_000_000_000_000,
      source: {
        workspaceName: 'Research Lab',
        path: 'research',
        folderName: 'research',
        sharerName: 'Ada',
        originLive: true,
        apps: [],
      },
    }
    const responses = [
      { items: [pendingShare], nextCursor: null },
      { share: pendingShare },
      {
        share: {
          ...pendingShare,
          source: undefined,
          state: 'active',
          toWorkspaceId: 'workspace_1',
        },
      },
      { ok: true },
    ]
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        body: init?.body,
      })
      return Response.json(responses.shift())
    })

    await client.listShareRequests()
    await client.resolveShareToken('duet_share_secret')
    await client.acceptShare('share_1', {
      toWorkspaceId: 'workspace_1',
      mountPath: 'shared/research',
    })
    await client.declineShare('share_2')

    expect(requests).toEqual([
      { path: '/api/duet/share-requests', method: 'GET', body: undefined },
      {
        path: '/api/duet/share-requests/duet_share_secret',
        method: 'GET',
        body: undefined,
      },
      {
        path: '/api/duet/share-requests/share_1/accept',
        method: 'POST',
        body: JSON.stringify({
          toWorkspaceId: 'workspace_1',
          mountPath: 'shared/research',
        }),
      },
      {
        path: '/api/duet/share-requests/share_2/decline',
        method: 'POST',
        body: '{}',
      },
    ])
  })

  test('consumes a parked share request without exposing its token to browser code', async () => {
    const paths: string[] = []
    const client = new DuetApiClient(async input => {
      paths.push(String(input))
      return Response.json({
        share: {
          id: 'share_1',
          anchorId: 'anchor_1',
          originWorkspaceId: 'workspace_origin',
          fromWorkspaceId: 'workspace_origin',
          toEmail: 'owner@example.com',
          mode: 'read',
          ignorePatterns: [],
          state: 'pending',
          createdByUserId: 'user_sharer',
          createdAt: 1,
          expiresAt: 2_000_000_000_000,
          source: {
            workspaceName: 'Research Lab',
            path: 'research',
            folderName: 'research',
            sharerName: 'Ada',
            originLive: true,
            apps: [],
          },
        },
      })
    })

    await expect(client.consumePendingShare()).resolves.toMatchObject({
      id: 'share_1',
      source: { folderName: 'research' },
    })
    expect(paths).toEqual(['/api/duet/pending-share'])

    const empty = new DuetApiClient(async () => new Response(null, { status: 204 }))
    await expect(empty.consumePendingShare()).resolves.toBeNull()

    const unavailable = new DuetApiClient(async () =>
      Response.json({ error: 'request_failed' }, { status: 404 }),
    )
    await expect(unavailable.consumePendingShare()).resolves.toBe('unavailable')
  })

  test('runs device approval through the browser-session API surface', async () => {
    let request: { path: string; init?: RequestInit } | undefined
    const client = new DuetApiClient(async (input, init) => {
      request = { path: String(input), init }
      return Response.json({
        userCode: 'DJ7K-MP4Q',
        status: 'approved',
        expiresAt: 2_000_000_000_000,
      })
    })

    await expect(client.deviceApproval('approve', 'DJ7K-MP4Q')).resolves.toMatchObject({
      userCode: 'DJ7K-MP4Q',
      status: 'approved',
    })
    expect(request?.path).toBe('/api/duet/device/approve')
    expect(request?.init?.body).toBe(JSON.stringify({ userCode: 'DJ7K-MP4Q' }))
  })

  test('inspects and completes OAuth consent through the opaque browser-session handle', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const responses = [
      {
        status: 'pending',
        client: { id: 'client_1', name: 'Example CLI' },
        redirect: { hostname: 'client.example', localhost: false },
        capabilities: ['files:read'],
        workspaces: [{ slug: 'personal', name: 'Personal', role: 'owner' }],
        expiresAt: 2_000_000_000_000,
      },
      { redirectUrl: 'https://client.example/callback?code=approved' },
      { redirectUrl: 'https://client.example/callback?error=access_denied' },
    ]
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      return Response.json(responses.shift())
    })

    await expect(client.inspectOAuthAuthorization('opaque/request')).resolves.toMatchObject({
      client: { name: 'Example CLI' },
      workspaces: [{ slug: 'personal' }],
    })
    await expect(client.approveOAuthAuthorization('opaque/request', 'personal')).resolves.toEqual({
      redirectUrl: 'https://client.example/callback?code=approved',
    })
    await expect(client.denyOAuthAuthorization('opaque/request')).resolves.toEqual({
      redirectUrl: 'https://client.example/callback?error=access_denied',
    })
    expect(requests).toEqual([
      {
        path: '/api/duet/oauth/authorization/opaque%2Frequest',
        method: 'GET',
      },
      {
        path: '/api/duet/oauth/authorization/opaque%2Frequest/approve',
        method: 'POST',
        body: JSON.stringify({ workspaceSlug: 'personal' }),
      },
      {
        path: '/api/duet/oauth/authorization/opaque%2Frequest/deny',
        method: 'POST',
        body: '{}',
      },
    ])
  })

  test('classifies authorization failures and rejects invalid successful payloads', async () => {
    const unauthorized = new DuetApiClient(async () =>
      Response.json({ error: 'unauthorized' }, { status: 401 }),
    )
    await expect(unauthorized.whoami()).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })

    const invalid = new DuetApiClient(async () => Response.json({ user: null }))
    await expect(invalid.whoami()).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
    })
  })

  test('drives the session lifecycle through the same-origin REST surface', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const projection = {
      audience: { kind: 'workspace' as const },
      archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
      permissions: {
        send: true,
        answer: true,
        interrupt: true,
        rename: true,
        manageAudience: false,
        personalArchive: true,
        globalArchive: true,
        delete: true,
      },
    }
    const createdSnapshot = {
      id: 'session_1',
      workspaceId: 'workspace_1',
      ...projection,
      turnStatus: 'running' as const,
      bucket: 'running' as const,
      title: 'Review release',
      titleOrigin: 'excerpt' as const,
      titleStatus: 'generating' as const,
      createdAt: 1,
      updatedAt: 1,
      lastEventSeq: 2,
      unread: false,
      lastDeliveredInputSeq: 0,
    }
    const createdHistory = {
      events: [
        {
          seq: 1,
          createdAt: 1,
          event: {
            type: 'session_created' as const,
            prompt: 'Review release',
            createdAt: '2026-07-19T12:34:56.000Z',
          },
        },
        {
          seq: 2,
          createdAt: 1,
          event: {
            type: 'prompt_submitted' as const,
            prompt: 'Review release',
            inputKind: 'initial' as const,
            behavior: 'steer' as const,
            sender: { kind: 'user' as const, userId: 'user_1' },
          },
        },
      ],
    }
    const responses = [
      { items: [], nextCursor: null },
      {
        session: {
          sessionId: 'session_1',
          status: 'running',
          lastEventSeq: 2,
          lastDeliveredInputSeq: 0,
        },
        snapshot: createdSnapshot,
        history: createdHistory,
        dispatched: false,
        delivery: 'accepted',
      },
      { ok: true, delivery: 'accepted' },
      { seq: 3 },
      { ok: true, delivery: 'accepted' },
      { sessionId: 'session_default', ok: true, delivery: 'accepted' },
      { ok: true },
      {
        id: 'session_1',
        ...projection,
        turnStatus: 'running',
        bucket: 'running',
        title: 'Release review',
        titleOrigin: 'manual',
        titleStatus: 'complete',
        createdAt: 1,
        updatedAt: 2,
        lastEventSeq: 3,
        unread: false,
      },
      {
        id: 'session_1',
        ...projection,
        turnStatus: 'running',
        bucket: 'running',
        title: 'Release review',
        titleOrigin: 'manual',
        titleStatus: 'complete',
        archive: { ...projection.archive, globalArchivedAt: 2, reason: 'global' as const },
        createdAt: 1,
        updatedAt: 2,
        lastEventSeq: 3,
        unread: false,
      },
      { owners: [] },
    ]
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json(responses.shift())
    })

    await client.listSessions('acme', { search: 'release', archived: 'only' })
    const attachments = [
      {
        path: 'agents/research/uploads/brief.pdf',
        name: 'brief.pdf',
        bytes: 42,
        mimeType: 'application/pdf',
      },
    ]
    const created = await client.createSession('acme', {
      prompt: 'Review release',
      tier: 'balanced',
      attachments,
    })
    await client.sendSessionMessage('acme', created.session.sessionId, {
      prompt: 'Continue',
      tier: 'frontier',
      attachments,
    })
    await client.addSessionNote('acme', created.session.sessionId, {
      note: 'Use staging data',
      attachments,
    })
    await client.answerSession('acme', created.session.sessionId, { answer: 'Ada', attachments })
    await client.sendDefaultSessionMessage('acme', 'research', {
      prompt: 'Default owner',
      attachments,
    })
    await client.interruptSession('acme', created.session.sessionId)
    await client.renameSession('acme', created.session.sessionId, 'Release review')
    await client.archiveSession('acme', created.session.sessionId, 'global', true)
    await client.deleteSession('acme', created.session.sessionId)
    await client.listSessionActivity('acme')

    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme/agent/sessions?search=release&archived=only',
        method: 'GET',
      },
      {
        path: '/api/duet/ws/acme/agent/sessions',
        method: 'POST',
        body: JSON.stringify({ prompt: 'Review release', tier: 'balanced', attachments }),
      },
      {
        path: '/api/duet/ws/acme/agent/sessions/session_1/messages',
        method: 'POST',
        body: JSON.stringify({ prompt: 'Continue', tier: 'frontier', attachments }),
      },
      {
        path: '/api/duet/ws/acme/agent/sessions/session_1/note',
        method: 'POST',
        body: JSON.stringify({ note: 'Use staging data', attachments }),
      },
      {
        path: '/api/duet/ws/acme/agent/sessions/session_1/answer',
        method: 'POST',
        body: JSON.stringify({ answer: 'Ada', attachments }),
      },
      {
        path: '/api/duet/ws/acme/agents/research/sessions/default/messages',
        method: 'POST',
        body: JSON.stringify({ prompt: 'Default owner', attachments }),
      },
      {
        path: '/api/duet/ws/acme/agent/sessions/session_1/interrupt',
        method: 'POST',
      },
      {
        path: '/api/duet/ws/acme/agent/sessions/session_1',
        method: 'PATCH',
        body: JSON.stringify({ title: 'Release review' }),
      },
      {
        path: '/api/duet/ws/acme/agent/sessions/session_1/archive',
        method: 'PUT',
        body: JSON.stringify({ kind: 'global', archived: true }),
      },
      {
        path: '/api/duet/ws/acme/agent/sessions/session_1',
        method: 'DELETE',
      },
      {
        // The URL, not a stubbed method: this call once built a bare `/v1/...`
        // path that no Next route serves, and every method-level stub passed.
        path: '/api/duet/ws/acme/agent/sessions/activity',
        method: 'GET',
      },
    ])
  })

  test('pages and updates a session audience through the public REST surface', async () => {
    const requests: Array<{ path: string; method: string; body?: BodyInit | null }> = []
    const client = new DuetApiClient(async (input, init) => {
      requests.push({ path: String(input), method: init?.method ?? 'GET', body: init?.body })
      if (init?.method === 'PATCH') return new Response(null, { status: 204 })
      return Response.json({
        items: [
          {
            memberId: 'membership_1',
            userId: 'user_1',
            name: 'Ada',
            email: 'ada@example.com',
            role: 'viewer',
          },
        ],
        nextCursor: 'next',
      })
    })

    expect(await client.getSessionAudience('acme', 'session_1', { limit: 1 })).toMatchObject({
      items: [{ userId: 'user_1' }],
      nextCursor: 'next',
    })
    expect(
      await client.updateSessionAudience('acme', 'session_1', { remove: ['user_1'] }),
    ).toBeNull()
    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme/agent/sessions/session_1/audience?limit=1',
        method: 'GET',
        body: undefined,
      },
      {
        path: '/api/duet/ws/acme/agent/sessions/session_1/audience',
        method: 'PATCH',
        body: JSON.stringify({ remove: ['user_1'] }),
      },
    ])
  })

  test('sends each archive cause exactly and accepts an empty delete response', async () => {
    const requests: Array<{ method: string; body?: BodyInit | null }> = []
    const lifecycleProjection = {
      audience: { kind: 'workspace' as const },
      archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
      permissions: {
        send: true,
        answer: true,
        interrupt: true,
        rename: true,
        manageAudience: false,
        personalArchive: true,
        globalArchive: true,
        delete: true,
      },
    }
    const client = new DuetApiClient(async (_input, init) => {
      requests.push({ method: init?.method ?? 'GET', body: init?.body })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({
        id: 'session_1',
        ...lifecycleProjection,
        archive: {
          ...lifecycleProjection.archive,
          globalArchivedAt: 2,
          reason: 'global' as const,
        },
        turnStatus: 'running',
        bucket: 'running',
        title: 'Archive contract',
        titleOrigin: 'manual',
        titleStatus: 'complete',
        createdAt: 1,
        updatedAt: 2,
        lastEventSeq: 3,
        unread: false,
      })
    })

    await client.archiveSession('acme', 'session_1', 'personal', true)
    await client.archiveSession('acme', 'session_1', 'global', false)
    await client.deleteSession('acme', 'session_1')

    expect(requests).toEqual([
      { method: 'PUT', body: JSON.stringify({ kind: 'personal', archived: true }) },
      { method: 'PUT', body: JSON.stringify({ kind: 'global', archived: false }) },
      { method: 'DELETE', body: undefined },
    ])
  })

  test('parses a 200 audience summary and rejects a malformed 200 body', async () => {
    const response = {
      id: 'session_1',
      audience: { kind: 'specific' as const, count: 0, preview: [] },
      archive: { globalArchivedAt: 2, personalArchivedAt: null, reason: 'global' as const },
      permissions: {
        send: true,
        answer: true,
        interrupt: true,
        rename: true,
        manageAudience: true,
        personalArchive: true,
        globalArchive: true,
        delete: true,
      },
      turnStatus: 'complete' as const,
      bucket: 'done' as const,
      title: 'Finished',
      titleOrigin: 'manual' as const,
      titleStatus: 'complete' as const,
      createdAt: 1,
      updatedAt: 2,
      lastEventSeq: 1,
      unread: false,
    }
    const valid = new DuetApiClient(async () => Response.json(response))
    expect(await valid.updateSessionAudience('acme', 'session_1', { remove: ['user_1'] })).toEqual(
      response,
    )

    const malformed = new DuetApiClient(async () => Response.json({ id: 'session_1' }))
    await expect(
      malformed.updateSessionAudience('acme', 'session_1', { remove: ['user_1'] }),
    ).rejects.toMatchObject({ status: 502, code: 'invalid_response' })
  })

  test('serializes supplied Train root and agent requests and parses successful responses', async () => {
    const requests: Array<{ path: string; method: string; body?: BodyInit | null }> = []
    const client = new DuetApiClient(async (input, init) => {
      requests.push({ path: String(input), method: init?.method ?? 'GET', body: init?.body })
      const path = String(input)
      if (path.endsWith('/train') && init?.method === 'POST') {
        return Response.json({
          jobId: 'train_1',
          job: {
            jobId: 'train_1',
            workspaceId: 'workspace_1',
            userId: 'user_1',
            state: 'queued',
            phase: 'preparing',
            createdAt: 1,
            updatedAt: 1,
          },
        })
      }
      if (path.includes('/jobs')) return Response.json({ items: [], nextCursor: null })
      if (path.endsWith('/train/train_1')) {
        return Response.json({
          job: {
            jobId: 'train_1',
            workspaceId: 'workspace_1',
            userId: 'user_1',
            state: 'done',
            phase: 'done',
            createdAt: 1,
            updatedAt: 2,
          },
        })
      }
      if (path.endsWith('/records') && init?.method === undefined) {
        return Response.json({ items: [], nextCursor: null })
      }
      if (path.endsWith('/memory-counts')) {
        return Response.json({ rootCount: 73, counts: { research: 2 }, trainableAgents: [] })
      }
      if (init?.method === 'DELETE') {
        return Response.json({
          deleted: true,
          slug: 'handbook',
          memoryId: 'mem_1',
        })
      }
      return Response.json({
        record: {
          slug: 'handbook',
          memoryId: 'mem_1',
          createdAt: '2026-07-11T00:00:00Z',
          observedDate: '2026-07-11',
          hasArchive: true,
          content: init?.method === 'PATCH' ? 'updated' : 'original',
        },
      })
    })

    await client.startTraining('acme', { urls: ['https://example.com'] }, ROOT_TRAIN_SCOPE)
    await client.listTrainJobs('acme', ROOT_TRAIN_SCOPE)
    await client.getTrainJob('acme', 'train_1', ROOT_TRAIN_SCOPE)
    await client.listTrainRecords('acme', ROOT_TRAIN_SCOPE)
    await client.listTrainMemoryCounts('acme')
    await client.getTrainRecord('acme', 'handbook', ROOT_TRAIN_SCOPE)
    await client.updateTrainRecord('acme', 'handbook', 'updated', ROOT_TRAIN_SCOPE)
    await client.deleteTrainRecord('acme', 'handbook', ROOT_TRAIN_SCOPE)
    const agentScope = { kind: 'agent' as const, agentSlug: 'research' }
    await client.startTraining('acme', { urls: ['https://example.com'] }, agentScope)
    await client.listTrainJobs('acme', agentScope, { cursor: 'next', limit: 25 })
    await client.getTrainJob('acme', 'train_1', agentScope)
    await client.listTrainRecords('acme', agentScope)
    await client.getTrainRecord('acme', 'handbook', agentScope)
    await client.updateTrainRecord('acme', 'handbook', 'updated', agentScope)
    await client.deleteTrainRecord('acme', 'handbook', agentScope)

    expect(requests.map(request => [request.method, request.path])).toEqual([
      ['POST', '/api/duet/ws/acme/train'],
      ['GET', '/api/duet/ws/acme/train/jobs'],
      ['GET', '/api/duet/ws/acme/train/train_1'],
      ['GET', '/api/duet/ws/acme/train/records'],
      ['GET', '/api/duet/ws/acme/train/memory-counts'],
      ['GET', '/api/duet/ws/acme/train/records/handbook'],
      ['PATCH', '/api/duet/ws/acme/train/records/handbook'],
      ['DELETE', '/api/duet/ws/acme/train/records/handbook'],
      ['POST', '/api/duet/ws/acme/agents/research/train'],
      ['GET', '/api/duet/ws/acme/agents/research/train/jobs?cursor=next&limit=25'],
      ['GET', '/api/duet/ws/acme/agents/research/train/train_1'],
      ['GET', '/api/duet/ws/acme/agents/research/train/records'],
      ['GET', '/api/duet/ws/acme/agents/research/train/records/handbook'],
      ['PATCH', '/api/duet/ws/acme/agents/research/train/records/handbook'],
      ['DELETE', '/api/duet/ws/acme/agents/research/train/records/handbook'],
    ])
    expect(requests[6]?.body).toBe(JSON.stringify({ content: 'updated' }))
    expect(requests[13]?.body).toBe(JSON.stringify({ content: 'updated' }))
  })

  test('opens the server-owned onboarding session instead of creating one client-side', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      return Response.json({ sessionId: 'session_existing' })
    })

    await expect(client.openAgentOnboardingSession('acme', 'research')).resolves.toEqual({
      sessionId: 'session_existing',
    })
    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme/agents/research/onboarding-session',
        method: 'POST',
      },
    ])
  })

  test('lists, renames, resets onboarding, and deletes agents through the workspace-scoped REST boundary', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const agent = {
      id: 'agent_1',
      workspaceId: 'workspace_1',
      anchorId: 'anchor_1',
      anchorPath: 'agents/research',
      anchorState: 'active' as const,
      slug: 'research',
      name: 'Research',
      createdAt: 1,
      updatedAt: 1,
    }
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      if (init?.method === 'DELETE') return Response.json({ ok: true })
      if (init?.method === 'PATCH')
        return Response.json({ agent: { ...agent, name: 'Renamed', updatedAt: 2 } })
      if (String(input).endsWith('/onboarded'))
        return Response.json({ agent: { ...agent, onboardedAt: undefined, updatedAt: 3 } })
      return Response.json({ items: [agent], nextCursor: null })
    })

    await expect(client.listAgents('acme')).resolves.toEqual({ items: [agent], nextCursor: null })
    await expect(client.listAgents('acme', { id: 'agent_1', limit: 1 })).resolves.toEqual({
      items: [agent],
      nextCursor: null,
    })
    await expect(client.listAgents('acme', { slug: 'research', limit: 1 })).resolves.toEqual({
      items: [agent],
      nextCursor: null,
    })
    await expect(client.updateAgent('acme', 'research', { name: 'Renamed' })).resolves.toEqual({
      agent: { ...agent, name: 'Renamed', updatedAt: 2 },
    })
    await expect(
      client.setAgentOnboarded('acme', 'research', { onboarded: false }),
    ).resolves.toEqual({
      agent: { ...agent, onboardedAt: undefined, updatedAt: 3 },
    })
    await expect(client.deleteAgent('acme', 'research')).resolves.toEqual({ ok: true })

    expect(requests).toEqual([
      { path: '/api/duet/ws/acme/agents', method: 'GET' },
      { path: '/api/duet/ws/acme/agents?limit=1&id=agent_1', method: 'GET' },
      { path: '/api/duet/ws/acme/agents?limit=1&slug=research', method: 'GET' },
      {
        path: '/api/duet/ws/acme/agents/research',
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed' }),
      },
      {
        path: '/api/duet/ws/acme/agents/research/onboarded',
        method: 'POST',
        body: JSON.stringify({ onboarded: false }),
      },
      { path: '/api/duet/ws/acme/agents/research', method: 'DELETE' },
    ])
  })

  // The default agent's rename is agent-shaped in its URL and workspace-shaped
  // in its answer: no `Agent` comes back, because the drive root has no row.
  test('renames the default agent at the reserved root path', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : String(init.body),
      })
      return Response.json({ name: 'Milo' })
    })

    await expect(client.updateDefaultAgent('acme', { name: 'Milo' })).resolves.toEqual({
      name: 'Milo',
    })
    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme/agents/root',
        method: 'PATCH',
        body: JSON.stringify({ name: 'Milo' }),
      },
    ])
  })

  test('drives every official-agent route through the one SPA agent transport', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const subscription = {
      id: 'subscription_1',
      agentId: 'agent_1',
      anchorId: 'anchor_1',
      listingId: 'listing-1',
      agentName: 'research',
      path: 'agents/research',
      mode: 'subscribe' as const,
      state: 'active' as const,
      appliedEtag: 'etag-2',
      acknowledgedEtag: 'etag-1',
      lastAppliedAt: 2,
    }
    const client = new DuetApiClient(async (input, init) => {
      const path = String(input)
      requests.push({
        path,
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      const listing = {
        id: 'listing-research',
        publisherSlug: 'acme-labs',
        verifiedPublisher: false,
        agentName: 'research',
        title: 'Research',
        summary: 'Investigates hard questions.',
        skills: ['web'],
        tags: ['marketing'],
        installs: 3,
        availability: 'available' as const,
      }
      if (
        path ===
        '/api/duet/marketplace?cursor=next&limit=25&q=growth&tag=marketing&availability=available&verifiedPublisher=true'
      )
        return Response.json({
          items: [listing],
          nextCursor: null,
          meta: { canPublishListings: false },
        })
      if (path === '/api/duet/marketplace/acme-labs/research')
        return Response.json({
          ...listing,
          apps: [],
          changelog: '## 2.0\n\nFaster source review.',
        })
      if (path.endsWith('/onboarding')) {
        return Response.json({
          duetName: 'Milo',
          onboardedAt: 1_700_000_000_000,
          results: [],
        })
      }
      if (init?.method === 'DELETE') return Response.json({ ok: true })
      if (init?.method === 'POST') return Response.json({ subscription })
      return Response.json({ items: [subscription], nextCursor: null })
    })

    await client.listMarketplaceCatalog({
      cursor: 'next',
      limit: 25,
      q: 'growth',
      tag: 'marketing',
      availability: 'available',
      verifiedPublisher: true,
    })
    await client.getMarketplaceListingDetail('acme-labs', 'research')
    await client.listMarketplaceAgentSubscriptions('acme space')
    await client.installMarketplaceAgent('acme space', {
      listingId: 'listing-1',
      name: 'Research Assistant',
    })
    await client.completeWorkspaceOnboarding('acme space', {
      duetName: 'Milo',
      selectedNames: ['research'],
    })
    await client.cloneMarketplaceAgent('acme space', {
      listingId: 'listing-1',
      path: 'agents/my research',
    })
    await client.acknowledgeMarketplaceAgent('acme space', 'subscription/1')
    await client.uninstallMarketplaceAgent('acme space', 'subscription/1')

    expect(requests).toEqual([
      {
        path: '/api/duet/marketplace?cursor=next&limit=25&q=growth&tag=marketing&availability=available&verifiedPublisher=true',
        method: 'GET',
      },
      { path: '/api/duet/marketplace/acme-labs/research', method: 'GET' },
      { path: '/api/duet/ws/acme%20space/marketplace/subscriptions', method: 'GET' },
      {
        path: '/api/duet/ws/acme%20space/marketplace/subscriptions',
        method: 'POST',
        body: JSON.stringify({ listingId: 'listing-1', name: 'Research Assistant' }),
      },
      {
        path: '/api/duet/ws/acme%20space/onboarding',
        method: 'POST',
        body: JSON.stringify({ duetName: 'Milo', selectedNames: ['research'] }),
      },
      {
        path: '/api/duet/ws/acme%20space/marketplace/subscriptions/clone',
        method: 'POST',
        body: JSON.stringify({ listingId: 'listing-1', path: 'agents/my research' }),
      },
      {
        path: '/api/duet/ws/acme%20space/marketplace/subscriptions/subscription%2F1/acknowledge',
        method: 'POST',
      },
      {
        path: '/api/duet/ws/acme%20space/marketplace/subscriptions/subscription%2F1',
        method: 'DELETE',
      },
    ])
  })

  test('preserves the typed path_exists payload for the collision rename prompt', async () => {
    const client = new DuetApiClient(async () =>
      Response.json(
        { error: 'path_exists', path: 'agents/research', renameRequired: true },
        { status: 409 },
      ),
    )

    const request = client.installMarketplaceAgent('acme', {
      listingId: 'listing-1',
      name: 'Research Assistant',
    })
    await expect(request).rejects.toMatchObject({
      status: 409,
      code: 'path_exists',
      data: { error: 'path_exists', path: 'agents/research', renameRequired: true },
    })
    await request.catch(error => {
      expect(marketplaceMutationErrorPayload(error)).toEqual({
        error: 'path_exists',
        path: 'agents/research',
        renameRequired: true,
      })
    })
  })

  test('drives app management through the same-origin REST boundary', async () => {
    const requests: Array<{
      path: string
      method: string
      body?: string
      signal?: AbortSignal | null
    }> = []
    const response: AppListResponse = {
      items: [
        {
          id: 'app_1',
          workspaceId: 'workspace_1',
          anchorId: 'anchor_1',
          anchorPath: 'apps/site',
          anchorState: 'active',
          command: 'bun run start',
          apiScopes: [],
          port: 4173,
          slug: 'site',
          visibility: 'folder',
          canonicalUrl: canonicalAppUrl('acme', 'site', DUET_EDGE_HOST),
          runtimeStatus: 'reconciled',
          createdByUserId: 'user_1',
          createdAt: 1,
          updatedAt: 1,
          controls: {
            manageDomain: true,
            updateRuntime: true,
            makePublic: true,
            makePrivate: true,
            delete: true,
          },
        },
      ],
      nextCursor: null,
      meta: { capabilities: { register: true } },
    }
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        ...(init?.signal === undefined ? {} : { signal: init.signal }),
      })
      if (init?.method === 'DELETE') return Response.json({ ok: true })
      if (init?.method) return Response.json({ app: response.items[0] })
      if (String(input).endsWith('/apps/site')) return Response.json({ app: response.items[0] })
      return Response.json(response)
    })

    const listController = new AbortController()
    await client.listApps('acme', { signal: listController.signal })
    await client.listApps('acme', { path: '', scope: 'children' })
    await client.listApps('acme', { path: 'welcome', signal: listController.signal })
    await client.listApps('acme', { id: 'app_101', limit: 1 })
    await client.listApps('acme', { cwd: 'apps/reports/deep', limit: 1 })
    await client.getApp('acme', 'site', listController.signal)
    await client.updateApp('acme', 'site', { command: 'bun run preview', port: 5173 })
    await client.setAppVisibility('acme', 'site', 'public')
    await client.deleteApp('acme', 'site')

    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme/apps',
        method: 'GET',
        signal: listController.signal,
      },
      { path: '/api/duet/ws/acme/apps?scope=children&path=', method: 'GET' },
      {
        path: '/api/duet/ws/acme/apps?path=welcome',
        method: 'GET',
        signal: listController.signal,
      },
      { path: '/api/duet/ws/acme/apps?id=app_101&limit=1', method: 'GET' },
      { path: '/api/duet/ws/acme/apps?cwd=apps%2Freports%2Fdeep&limit=1', method: 'GET' },
      {
        path: '/api/duet/ws/acme/apps/site',
        method: 'GET',
        signal: listController.signal,
      },
      {
        path: '/api/duet/ws/acme/apps/site',
        method: 'PATCH',
        body: JSON.stringify({ command: 'bun run preview', port: 5173 }),
      },
      {
        path: '/api/duet/ws/acme/apps/site/visibility',
        method: 'POST',
        body: JSON.stringify({ visibility: 'public' }),
      },
      { path: '/api/duet/ws/acme/apps/site', method: 'DELETE' },
    ])
  })

  test('loads one supplied history page without additional requests', async () => {
    const queries: string[] = []
    const client = new DuetApiClient(async input => {
      const url = new URL(String(input), 'https://duet.test')
      queries.push(url.search)
      return Response.json({
        items: [
          {
            seq: 2,
            createdAt: 2,
            event: {
              type: 'prompt_submitted',
              prompt: 'Investigate',
              inputKind: 'initial',
              behavior: 'steer',
              sender: { kind: 'user', userId: 'user_1' },
            },
          },
        ],
        nextCursor: null,
      })
    })

    const history = await client.getSessionHistory('acme', 'session_1')
    expect(queries).toEqual([''])
    expect(history).toEqual({
      items: [expect.objectContaining({ seq: 2 })],
      nextCursor: null,
    })
  })

  test('owns settings transport and validates the one-time API-key secret separately from listings', async () => {
    const requests: Array<{ path: string; method: string; body?: BodyInit | null }> = []
    const client = new DuetApiClient(async (input, init) => {
      const path = String(input)
      requests.push({ path, method: init?.method ?? 'GET', body: init?.body })
      if (path.endsWith('/members?limit=50')) {
        return Response.json({
          items: [
            {
              id: 'user_1',
              email: 'owner@example.com',
              name: 'Owner',
              role: 'owner',
              isBillingUser: true,
            },
          ],
          nextCursor: null,
        })
      }
      if (path.endsWith('/profile')) {
        return Response.json({
          id: 'user_1',
          email: 'owner@example.com',
          firstName: 'Owner',
          name: 'Owner',
        })
      }
      if (path.endsWith('/billing') && init?.method !== 'POST') {
        return Response.json({
          autoTopupEnabled: false,
          autoTopupThresholdMicroUsd: 5_000_000,
          monthlySpendMicroUsd: 0,
          paidCreditBalanceMicroUsd: 0,
          monthlyCreditBalanceMicroUsd: 0,
          balanceMicroUsd: 0,
          consecutiveTopupFailures: 0,
          subscription: null,
          trial: { status: 'available' },
          hasPaymentMethod: false,
          workspaces: [
            {
              id: 'workspace_1',
              slug: 'acme',
              name: 'Acme',
              storage: {
                usableGb: 20,
                plan: 'starter',
                nextPlan: 'pro',
                nextUsableGb: 50,
              },
            },
          ],
        })
      }
      if (path.endsWith('/api-keys') && init?.method === 'POST') {
        return Response.json(
          {
            key: 'duet_sk_one_time_secret',
            record: {
              id: 'key_1',
              name: 'CLI',
              prefix: 'duet_sk_one',
              createdAt: 1,
            },
          },
          { status: 201 },
        )
      }
      if (path.endsWith('/api-keys?limit=100')) {
        return Response.json({ items: [], nextCursor: null })
      }
      throw new Error(`Unexpected settings request: ${path}`)
    })

    await client.listWorkspaceMembers('acme')
    await client.userProfile()
    await client.userBilling()
    const issued = await client.issueUserApiKey({
      name: 'CLI',
    })
    const listed = await client.listUserApiKeys({ limit: 100 })

    expect(issued.key).toBe('duet_sk_one_time_secret')
    expect(listed).toEqual({ items: [], nextCursor: null })
    expect(requests.map(request => [request.method, request.path])).toEqual([
      ['GET', '/api/duet/ws/acme/members?limit=50'],
      ['GET', '/api/duet/user/profile'],
      ['GET', '/api/duet/user/billing'],
      ['POST', '/api/duet/user/api-keys'],
      ['GET', '/api/duet/user/api-keys?limit=100'],
    ])
    expect(requests[3]?.body).toBe(JSON.stringify({ name: 'CLI' }))
  })

  test('starts subscription checkout with a plan id through the payer billing route', async () => {
    let request: { path: string; method: string; body?: BodyInit | null } | undefined
    const client = new DuetApiClient(async (input, init) => {
      request = {
        path: String(input),
        method: init?.method ?? 'GET',
        body: init?.body,
      }
      return Response.json({ url: 'https://checkout.stripe.test/session' })
    })

    await expect(
      client.createSubscriptionCheckout({ workspaceSlug: 'acme', plan: 'pro' }),
    ).resolves.toEqual({ url: 'https://checkout.stripe.test/session' })
    expect(request).toEqual({
      path: '/api/duet/user/billing/subscription/checkout',
      method: 'POST',
      body: JSON.stringify({ workspaceSlug: 'acme', plan: 'pro' }),
    })
  })

  test('lists and revokes OAuth grants through their separate user cache resource', async () => {
    const requests: Array<{ path: string; method: string }> = []
    const client = new DuetApiClient(async (input, init) => {
      const path = String(input)
      requests.push({ path, method: init?.method ?? 'GET' })
      if (init?.method === 'DELETE') {
        return Response.json({ grantId: 'grant/one', revokedAt: 2 })
      }
      return Response.json({
        items: [
          {
            id: 'grant/one',
            clientId: 'https://client.example/oauth.json',
            clientName: 'Example client',
            redirectHost: 'client.example',
            workspace: { slug: 'acme', name: 'Acme' },
            scopes: ['ws:acme:files:read'],
            createdAt: 1,
            hashedToken: 'must-not-survive',
            generation: 9,
          },
        ],
        nextCursor: null,
      })
    })

    expect(await client.listOAuthGrants()).toEqual({
      items: [
        {
          id: 'grant/one',
          clientId: 'https://client.example/oauth.json',
          clientName: 'Example client',
          redirectHost: 'client.example',
          workspace: { slug: 'acme', name: 'Acme' },
          scopes: ['ws:acme:files:read'],
          createdAt: 1,
        },
      ],
      nextCursor: null,
    })
    expect(await client.revokeOAuthGrant('grant/one')).toEqual({
      grantId: 'grant/one',
      revokedAt: 2,
    })
    expect(requests).toEqual([
      { path: '/api/duet/user/oauth-grants', method: 'GET' },
      { path: '/api/duet/user/oauth-grants/grant%2Fone', method: 'DELETE' },
    ])
  })

  test('changes, cancels, or resumes a subscription through the same plan-change route', async () => {
    const requests: Array<{ path: string; method: string; body?: BodyInit | null }> = []
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        body: init?.body,
      })
      return Response.json({ ok: true })
    })

    await expect(
      client.changeSubscriptionPlan({ workspaceSlug: 'acme', plan: 'max' }),
    ).resolves.toEqual({ ok: true })
    await expect(
      client.changeSubscriptionPlan({ workspaceSlug: 'acme', cancel: true }),
    ).resolves.toEqual({ ok: true })
    await expect(
      client.changeSubscriptionPlan({ workspaceSlug: 'acme', resume: true }),
    ).resolves.toEqual({ ok: true })
    expect(requests).toEqual([
      {
        path: '/api/duet/user/billing/subscription/plan',
        method: 'POST',
        body: JSON.stringify({ workspaceSlug: 'acme', plan: 'max' }),
      },
      {
        path: '/api/duet/user/billing/subscription/plan',
        method: 'POST',
        body: JSON.stringify({ workspaceSlug: 'acme', cancel: true }),
      },
      {
        path: '/api/duet/user/billing/subscription/plan',
        method: 'POST',
        body: JSON.stringify({ workspaceSlug: 'acme', resume: true }),
      },
    ])
  })

  test('serializes integration list, connect and disconnect requests', async () => {
    const requests: Array<{ path: string; method: string }> = []
    const client = new DuetApiClient(async (input, init) => {
      const path = String(input)
      requests.push({ path, method: init?.method ?? 'GET' })
      if (path.includes('/catalog'))
        return Response.json({
          items: [{ integration: 'notion', name: 'Notion', connected: false }],
          nextCursor: null,
        })
      if (path.endsWith('/connections') && init?.method === undefined)
        return Response.json({ items: [], nextCursor: null })
      if (path.endsWith('/connect'))
        return Response.json({
          integration: 'notion',
          authorizeUrl: 'https://connect.example.test/notion',
        })
      if (path.includes('/connections/') && init?.method === 'DELETE')
        return Response.json({ id: 'connection_1', disconnected: true })
      throw new Error(`Unexpected integration request: ${path}`)
    })

    await client.listIntegrationCatalog('acme')
    await client.listIntegrationConnections('acme')
    const connection = await client.connectIntegration('acme', {
      integration: 'notion',
      redirectTo: '/w/acme/integrations',
    })
    expect(connection.authorizeUrl).toBe('https://connect.example.test/notion')
    await client.disconnectIntegration('acme', 'connection_1')

    expect(requests.map(request => [request.method, request.path])).toEqual([
      ['GET', '/api/duet/ws/acme/integrations/catalog'],
      ['GET', '/api/duet/ws/acme/integrations/connections'],
      ['POST', '/api/duet/ws/acme/integrations/connect'],
      ['DELETE', '/api/duet/ws/acme/integrations/connections/connection_1'],
    ])
  })

  test('writes every integration agent-policy state with its exact absent-or-list body', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = []
    const client = new DuetApiClient(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      return Response.json({ integration: 'gmail', ...body })
    })

    await client.setIntegrationAgentPolicy('acme', 'gmail', {})
    await client.setIntegrationAgentPolicy('acme', 'gmail', { allowedAgentIds: [] })
    await client.setIntegrationAgentPolicy('acme', 'gmail', { allowedAgentIds: ['root'] })
    await client.setIntegrationAgentPolicy('acme', 'gmail', {
      allowedAgentIds: ['agent_research'],
    })

    expect(requests).toEqual([
      {
        path: '/api/duet/ws/acme/integrations/gmail/agent-policy',
        method: 'PUT',
        body: '{}',
      },
      {
        path: '/api/duet/ws/acme/integrations/gmail/agent-policy',
        method: 'PUT',
        body: '{"allowedAgentIds":[]}',
      },
      {
        path: '/api/duet/ws/acme/integrations/gmail/agent-policy',
        method: 'PUT',
        body: '{"allowedAgentIds":["root"]}',
      },
      {
        path: '/api/duet/ws/acme/integrations/gmail/agent-policy',
        method: 'PUT',
        body: '{"allowedAgentIds":["agent_research"]}',
      },
    ])
  })

  test('owns the custom MCP server lifecycle on its own endpoint family', async () => {
    const requests: Array<{ method: string; path: string; body?: string }> = []
    const server = {
      name: 'acme_internal',
      label: 'Acme Internal',
      url: 'https://mcp.acme.test/mcp',
      authKind: 'static',
      state: 'ready',
      toolCount: 24,
      estimatedPromptBytes: 9800,
      createdAt: 1,
      updatedAt: 2,
    } as const
    const client = new DuetApiClient(async (input, init) => {
      const path = String(input)
      requests.push({
        path,
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      if (path.endsWith('/probe'))
        return Response.json({ auth: 'none', toolCount: 24, estimatedPromptBytes: 9800 })
      if (path.endsWith('/connect'))
        return Response.json({ authorizeUrl: 'https://as.acme.test/authorize?state=abc' })
      if (path.endsWith('/agent-policy'))
        return Response.json({ name: 'acme_internal', allowedAgentIds: ['root'] })
      if (init?.method === 'DELETE')
        return Response.json({
          name: 'acme_internal',
          removed: true,
          revoked: 'revoked',
          registration: 'deleted',
        })
      if (init?.method === 'POST') return Response.json(server)
      return Response.json({ items: [server], nextCursor: null })
    })

    const probe = await client.probeMcpServer('acme', {
      name: 'acme_internal',
      url: 'https://mcp.acme.test/mcp',
      auth: { kind: 'static', token: 'paste-me' },
    })
    expect(probe.toolCount).toBe(24)
    const added = await client.addMcpServer('acme', {
      name: 'acme_internal',
      url: 'https://mcp.acme.test/mcp',
      label: 'Acme Internal',
      auth: { kind: 'static', token: 'paste-me' },
    })
    expect(added.state).toBe('ready')
    expect(await client.listMcpServers('acme')).toEqual({ items: [server], nextCursor: null })
    // The consent leg answers a URL rather than redirecting, because only a
    // top-level navigation can reach a third party's consent page.
    expect(
      await client.connectMcpServer('acme', 'acme_internal', {
        redirectTo: '/w/acme/integrations',
      }),
    ).toEqual({ authorizeUrl: 'https://as.acme.test/authorize?state=abc' })
    await client.setMcpServerAgentPolicy('acme', 'acme_internal', { allowedAgentIds: ['root'] })
    await client.setMcpServerAgentPolicy('acme', 'acme_internal', {})
    expect(await client.removeMcpServer('acme', 'acme_internal')).toEqual({
      name: 'acme_internal',
      removed: true,
      revoked: 'revoked',
      registration: 'deleted',
    })

    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/duet/ws/acme/mcp-servers/probe',
        body: '{"name":"acme_internal","url":"https://mcp.acme.test/mcp","auth":{"kind":"static","token":"paste-me"}}',
      },
      {
        method: 'POST',
        path: '/api/duet/ws/acme/mcp-servers',
        body: '{"name":"acme_internal","url":"https://mcp.acme.test/mcp","label":"Acme Internal","auth":{"kind":"static","token":"paste-me"}}',
      },
      { method: 'GET', path: '/api/duet/ws/acme/mcp-servers' },
      {
        method: 'POST',
        path: '/api/duet/ws/acme/mcp-servers/acme_internal/connect',
        body: '{"redirectTo":"/w/acme/integrations"}',
      },
      {
        method: 'PUT',
        path: '/api/duet/ws/acme/mcp-servers/acme_internal/agent-policy',
        body: '{"allowedAgentIds":["root"]}',
      },
      {
        method: 'PUT',
        path: '/api/duet/ws/acme/mcp-servers/acme_internal/agent-policy',
        body: '{}',
      },
      { method: 'DELETE', path: '/api/duet/ws/acme/mcp-servers/acme_internal' },
    ])
  })

  test('refuses a plaintext consent URL rather than navigating a browser to it', async () => {
    const client = new DuetApiClient(async () =>
      Response.json({ authorizeUrl: 'http://as.acme.test/authorize' }),
    )

    await expect(client.connectMcpServer('acme', 'acme_internal', {})).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  test('reads workspace telemetry history through the browser API proxy', async () => {
    const requests: string[] = []
    const client = new DuetApiClient(async input => {
      requests.push(String(input))
      return Response.json({ samples: [{ at: 123, cpuPct: 42 }] })
    })

    await expect(client.workspaceTelemetry('acme', 100)).resolves.toEqual({
      samples: [{ at: 123, cpuPct: 42 }],
    })
    expect(requests).toEqual(['/api/duet/ws/acme/telemetry?sinceAt=100'])
  })

  test('owns workspace file reads, writes, listings, stats, and operations', async () => {
    const requests: Array<{
      path: string
      method: string
      headers: Headers
      body?: string
      signal?: AbortSignal | null
    }> = []
    const client = new DuetApiClient(async (input, init) => {
      const path = String(input)
      const headers = new Headers(init?.headers)
      const body = init?.body === undefined ? undefined : await new Response(init.body).text()
      requests.push({
        path,
        method: init?.method ?? 'GET',
        headers,
        body,
        signal: init?.signal,
      })
      if (new URL(path, 'https://duet.test').searchParams.get('list') === '1') {
        return Response.json({
          items: [
            {
              name: 'a b.md',
              path: 'docs/a b.md',
              type: 'file',
              size: 4,
              mtime: '2026-07-11T08:30:00.000Z',
            },
          ],
          nextCursor: null,
        })
      }
      if (path.endsWith('?stat=1')) {
        return Response.json({
          entry: {
            name: 'a b.md',
            path: 'docs/a b.md',
            type: 'file',
            size: 4,
            mtime: '2026-07-11T08:30:00.000Z',
          },
          etag: '"stat-v1"',
        })
      }
      if (init?.method === 'PUT') {
        return Response.json({ ok: true, etag: '"next"', size: 4 })
      }
      if (init?.method === 'POST') return Response.json({ ok: true, affectedEntries: 1 })
      return new Response(new Uint8Array([2, 3]), {
        status: 206,
        headers: {
          etag: '"v1"',
          'content-range': 'bytes 2-3/10',
          'content-type': 'application/octet-stream',
        },
      })
    })
    const controller = new AbortController()

    await expect(
      client.listWorkspaceFiles('acme space', 'docs', {
        cursor: 'after one',
        limit: 25,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      items: [{ path: 'docs/a b.md', size: 4 }],
      nextCursor: null,
    })
    await expect(client.statWorkspaceFile('acme space', 'docs/a b.md')).resolves.toMatchObject({
      entry: { path: 'docs/a b.md', size: 4 },
      etag: '"stat-v1"',
    })
    await expect(
      client.readWorkspaceFile('acme space', 'docs/a b.md', {
        range: { start: 2, end: 3 },
      }),
    ).resolves.toEqual({
      data: new Uint8Array([2, 3]),
      etag: '"v1"',
      contentType: 'application/octet-stream',
      size: 10,
    })
    await expect(
      client.writeWorkspaceFile('acme space', 'docs/a b.md', new TextEncoder().encode('next'), {
        ifMatch: '"v1"',
        contentType: 'text/plain',
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ etag: '"next"', size: 4 })
    await expect(
      client.operateOnWorkspaceFiles('acme space', {
        operation: 'move',
        source: 'docs/a b.md',
        destination: 'docs/b.md',
        overwrite: false,
      }),
    ).resolves.toEqual({ ok: true, affectedEntries: 1 })

    expect(requests.map(request => [request.method, request.path])).toEqual([
      ['GET', '/api/duet/ws/acme%20space/files/docs?list=1&cursor=after+one&limit=25'],
      ['GET', '/api/duet/ws/acme%20space/files/docs/a%20b.md?stat=1'],
      ['GET', '/api/duet/ws/acme%20space/files/docs/a%20b.md'],
      ['PUT', '/api/duet/ws/acme%20space/files/docs/a%20b.md'],
      ['POST', '/api/duet/ws/acme%20space/files/actions'],
    ])
    expect(requests[2]?.headers.get('range')).toBe('bytes=2-3')
    expect(requests[3]?.headers.get('if-match')).toBe('"v1"')
    expect(requests[3]?.body).toBe('next')
    expect(requests[3]?.signal).toBe(controller.signal)
    expect(JSON.parse(requests[4]!.body!)).toEqual({
      operation: 'move',
      source: 'docs/a b.md',
      destination: 'docs/b.md',
      overwrite: false,
    })

    const failing = new DuetApiClient(async () =>
      Response.json({ error: 'path_exists' }, { status: 409 }),
    )
    await expect(
      failing.operateOnWorkspaceFiles('acme', {
        operation: 'mkdir',
        path: 'docs',
        recursive: false,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'path_exists' })

    const staleWrite = new DuetApiClient(async () => new Response(null, { status: 412 }))
    await expect(
      staleWrite.writeWorkspaceFile('acme', 'docs/a.md', new TextEncoder().encode('stale')),
    ).rejects.toMatchObject({ status: 412, code: 'precondition_failed' })
  })

  test('keeps relative file URLs byte-identical and transports absolute paths with one encoded leading slash', () => {
    const client = new DuetApiClient(async () => new Response(null, { status: 404 }))

    expect(client.workspaceFileDownloadUrl('acme space', '/custom drive/media/100% #1?.mp4')).toBe(
      '/api/duet/ws/acme%20space/files/%2Fcustom%20drive/media/100%25%20%231%3F.mp4',
    )
    expect(client.workspaceFileDownloadUrl('acme space', 'media/clip 1?.mp4/')).toBe(
      '/api/duet/ws/acme%20space/files/media/clip%201%3F.mp4',
    )
    expect(
      client.workspaceFileDownloadUrl('acme space', '/custom drive/media/100% #1?.mp4', {
        version: 7,
      }),
    ).toBe('/api/duet/ws/acme%20space/files/%2Fcustom%20drive/media/100%25%20%231%3F.mp4?v=7')
  })

  test('percent-encodes an opaque string identity in a file download URL', () => {
    const client = new DuetApiClient(async () => new Response(null, { status: 404 }))

    expect(
      client.workspaceFileDownloadUrl('acme', 'docs/report.md', {
        version: '"opaque/identity?one"',
      }),
    ).toBe('/api/duet/ws/acme/files/docs/report.md?v=%22opaque%2Fidentity%3Fone%22')
  })

  test('optional reads declare themselves and take an empty 204 as "not there"', async () => {
    const requests: string[] = []
    const client = new DuetApiClient(async input => {
      const path = String(input)
      requests.push(path)
      if (path.includes('missing')) return new Response(null, { status: 204 })
      if (path.includes('list=1'))
        return Response.json({
          items: [
            {
              name: 'summarize',
              path: 'agents/x/.agents/skills/summarize',
              type: 'directory',
              size: 0,
              mtime: '2026-07-15T08:00:00.000Z',
            },
          ],
          nextCursor: null,
        })
      return new Response('{"trainable":false}', {
        headers: { etag: '"v1"', 'content-type': 'application/json' },
      })
    })

    await expect(
      client.readOptionalWorkspaceFile('acme', 'agents/x/missing.json'),
    ).resolves.toBeNull()
    await expect(client.readOptionalWorkspaceFile('acme', 'agents/x/agent.json')).resolves.toEqual({
      data: new TextEncoder().encode('{"trainable":false}'),
      etag: '"v1"',
      contentType: 'application/json',
      size: 19,
    })
    await expect(
      client.listOptionalWorkspaceFiles('acme', 'agents/x/.agents/missing', { limit: 50 }),
    ).resolves.toBeNull()
    await expect(
      client.listOptionalWorkspaceFiles('acme', 'agents/x/.agents/skills', { limit: 50 }),
    ).resolves.toMatchObject({ items: [{ name: 'summarize' }], nextCursor: null })
    await expect(
      client.statOptionalWorkspaceFile('acme', 'uploads/missing.png'),
    ).resolves.toBeNull()

    expect(requests).toEqual([
      '/api/duet/ws/acme/files/agents/x/missing.json?optional=1',
      '/api/duet/ws/acme/files/agents/x/agent.json?optional=1',
      '/api/duet/ws/acme/files/agents/x/.agents/missing?list=1&limit=50&optional=1',
      '/api/duet/ws/acme/files/agents/x/.agents/skills?list=1&limit=50&optional=1',
      '/api/duet/ws/acme/files/uploads/missing.png?stat=1&optional=1',
    ])
  })

  test('encodes percent-bearing file identities once while leaving action JSON literal', async () => {
    const requests: Array<{ path: string; body?: string }> = []
    const client = new DuetApiClient(async (input, init) => {
      const body = init?.body === undefined ? undefined : await new Response(init.body).text()
      requests.push({ path: String(input), body })
      if (init?.method === 'POST') return Response.json({ ok: true, affectedEntries: 1 })
      return new Response('fixture')
    })

    await client.readWorkspaceFile('acme', '100%.pdf')
    await client.readWorkspaceFile('acme', 'a%2Fb')
    await client.operateOnWorkspaceFiles('acme', {
      operation: 'move',
      source: '100%.pdf',
      destination: 'a%2Fb',
      overwrite: false,
    })

    expect(requests).toEqual([
      { path: '/api/duet/ws/acme/files/100%25.pdf', body: undefined },
      { path: '/api/duet/ws/acme/files/a%252Fb', body: undefined },
      {
        path: '/api/duet/ws/acme/files/actions',
        body: JSON.stringify({
          operation: 'move',
          source: '100%.pdf',
          destination: 'a%2Fb',
          overwrite: false,
        }),
      },
    ])
  })

  test('drives internal admin only through the same-origin audited REST seam', async () => {
    const requests: Array<{ path: string; method: string; body?: BodyInit | null }> = []
    const client = new DuetApiClient(async (input, init) => {
      const path = String(input)
      requests.push({ path, method: init?.method ?? 'GET', body: init?.body })
      if (path.includes('/search'))
        return Response.json({ workspaces: [], auditId: 'audit_search' })
      if (path.endsWith('/official-hub/access'))
        return Response.json({
          token: 'duet_imp_fixture',
          prefix: 'duet_imp_fixt',
          expiresAt: 2_000,
          userId: 'user_official',
          workspaceSlug: 'official-agents-hub',
          created: false,
        })
      if (path.endsWith('/feedback/feedback_1'))
        return Response.json({ ok: true, auditId: 'audit_delete' })
      if (path.includes('/files?'))
        return Response.json({
          path: 'reports',
          entries: [],
          truncated: false,
          auditId: 'audit_files',
        })
      if (path.includes('/logs?'))
        return Response.json({
          source: 'gateway',
          path: 'logs/gateway.log',
          content: '[apps] service ready',
          byteLength: 20,
          truncated: false,
          available: [{ source: 'gateway', byteLength: 20 }],
          auditId: 'audit_logs',
        })
      if (path.endsWith('/command'))
        return Response.json({
          command: 'uptime',
          stdout: 'up',
          stderr: '',
          exitCode: 0,
          durationMs: 2,
          truncated: false,
          auditId: 'audit_command',
        })
      if (path.includes('/vm/'))
        return Response.json({ ok: true, status: 'completed', auditId: 'audit_vm' })
      throw new Error(`Unexpected admin request: ${path}`)
    })

    await client.internalAdminSearch('cus_example')
    await client.internalAdminOpenOfficialHub()
    await client.internalAdminMutateFeedback('feedback_1', 'delete', 'Duplicate feedback')
    await client.internalAdminFiles('workspace_1', 'reports/July')
    await client.internalAdminLogs('workspace_1', 'gateway')
    await client.internalAdminCommand('workspace_1', 'uptime', 'Runtime investigation')
    for (const operation of INTERNAL_ADMIN_VM_OPERATIONS)
      await client.internalAdminVmOperation(
        'workspace_1',
        operation,
        'Runtime investigation',
        'workspace-slug',
      )

    expect(requests.map(request => [request.method, request.path])).toEqual([
      ['GET', '/api/duet/internal-admin/search?q=cus_example'],
      ['POST', '/api/duet/internal-admin/official-hub/access'],
      ['POST', '/api/duet/internal-admin/feedback/feedback_1'],
      ['GET', '/api/duet/internal-admin/workspaces/workspace_1/files?path=reports%2FJuly'],
      ['GET', '/api/duet/internal-admin/workspaces/workspace_1/logs?source=gateway'],
      ['POST', '/api/duet/internal-admin/workspaces/workspace_1/command'],
      ...INTERNAL_ADMIN_VM_OPERATIONS.map(operation => [
        'POST',
        `/api/duet/internal-admin/workspaces/workspace_1/vm/${operation}`,
      ]),
    ])
    expect(requests[2]?.body).toBe(
      JSON.stringify({ operation: 'delete', reason: 'Duplicate feedback', confirmation: 'DELETE' }),
    )
    expect(requests[5]?.body).toBe(
      JSON.stringify({ command: 'uptime', reason: 'Runtime investigation' }),
    )
    expect(requests.slice(6).map(request => request.body)).toEqual(
      INTERNAL_ADMIN_VM_OPERATIONS.map(() =>
        JSON.stringify({ reason: 'Runtime investigation', confirmation: 'workspace-slug' }),
      ),
    )
  })
})
