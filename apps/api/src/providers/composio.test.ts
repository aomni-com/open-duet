import { afterEach, describe, expect, test } from 'bun:test'

import { MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES } from '@repo/contract'

import { createComposioIntegrationProvider, createComposioMcpProvider } from './composio'

const originalApiKey = process.env.COMPOSIO_API_KEY

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.COMPOSIO_API_KEY
  else process.env.COMPOSIO_API_KEY = originalApiKey
})

describe('Composio production adapter', () => {
  test('keeps a public 100-item catalog request within the provider page ceiling', async () => {
    const requests: Array<{ limit: number; search?: string; cursor?: string }> = []
    const upstream = createComposioIntegrationProvider(
      async () => {
        throw new Error('unexpected lifecycle request')
      },
      {
        resolveCatalogSession: async () => ({
          toolkits: async request => {
            requests.push(request)
            return {
              items: [
                {
                  slug: 'github',
                  name: 'GitHub',
                  logo: 'https://example.com/github.svg',
                  isNoAuth: false,
                  connection: { isActive: true },
                },
              ],
              cursor: 'provider-page-2',
            }
          },
        }),
      },
    )

    await expect(
      upstream.listCatalog({
        workspaceId: 'workspace_1',
        search: 'git',
        cursor: 'provider-page-1',
        limit: 100,
      }),
    ).resolves.toEqual({
      items: [
        {
          integration: 'github',
          name: 'GitHub',
          logoUrl: 'https://example.com/github.svg',
          connected: true,
        },
      ],
      nextCursor: 'provider-page-2',
    })
    expect(requests).toEqual([{ limit: 50, search: 'git', cursor: 'provider-page-1' }])
  })

  test('scalar-safely bounds provider display metadata before it leaves the adapter', async () => {
    const upstream = createComposioIntegrationProvider(
      async () => {
        throw new Error('unexpected lifecycle request')
      },
      {
        resolveCatalogSession: async () => ({
          toolkits: async () => ({
            items: [
              {
                slug: 'giant-provider-toolkit',
                name: `${'n'.repeat(MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES - 2)}🚀tail`,
                logo: `https://example.test/${'x'.repeat(5_000)}`,
              },
            ],
          }),
        }),
      },
    )

    const page = await upstream.listCatalog({ workspaceId: 'workspace_1', limit: 1 })

    expect(page.items).toEqual([
      {
        integration: 'giant-provider-toolkit',
        name: 'n'.repeat(MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES - 2),
        connected: false,
      },
    ])
    expect(new TextEncoder().encode(page.items[0]!.name).byteLength).toBeLessThanOrEqual(
      MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES,
    )
  })

  test('resolves a connection by asking the provider for this workspace only', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    const urls: string[] = []
    const upstream = createComposioIntegrationProvider(async input => {
      urls.push(String(input))
      return Response.json({
        items: [accountRow({ id: 'connection-on-a-later-page', user_id: 'workspace-1' })],
        total_items: 1,
        total_pages: 1,
        next_cursor: null,
      })
    })

    await expect(
      upstream.getConnection({
        workspaceId: 'workspace-1',
        providerConnectionId: 'connection-on-a-later-page',
      }),
    ).resolves.toEqual({
      id: 'connection-on-a-later-page',
      integration: 'gmail',
      status: 'active',
      connectedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      updatedAt: Date.parse('2026-01-02T00:00:00.000Z'),
    })
    // Tenancy is the provider's filter, not a value Duet reconstructs and
    // compares afterwards. The page size and sharing model are guards too: two
    // rows exposes a filter that widened, and PRIVATE keeps the lookup on the
    // same population the list shows rather than the experimental default.
    const query = new URL(urls[0]!).searchParams
    expect(query.get('user_ids')).toBe('workspace-1')
    expect(query.get('connected_account_ids')).toBe('connection-on-a-later-page')
    expect(query.get('limit')).toBe('2')
    expect(query.get('account_type')).toBe('PRIVATE')
  })

  test('lists and resolves against the same sharing model', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    const urls: string[] = []
    const upstream = createComposioIntegrationProvider(async input => {
      urls.push(String(input))
      return Response.json({ items: [], total_items: 0, total_pages: 0, next_cursor: null })
    })

    await upstream.listConnections({ workspaceId: 'workspace-1', limit: 100 })
    await upstream.getConnection({ workspaceId: 'workspace-1', providerConnectionId: 'x' })

    // If these ever differ, the page can show a row the lookup cannot find —
    // the exact drift this adapter exists to prevent.
    const sharing = urls.map(url => new URL(url).searchParams.get('account_type'))
    expect(sharing).toEqual(['PRIVATE', 'PRIVATE'])
  })

  test('treats a connection the workspace does not have as absent', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    const upstream = createComposioIntegrationProvider(async () =>
      Response.json({ items: [], total_items: 0, total_pages: 0, next_cursor: null }),
    )

    await expect(
      upstream.getConnection({ workspaceId: 'workspace-1', providerConnectionId: 'already-gone' }),
    ).resolves.toBeUndefined()
  })

  test('refuses a resolved row the provider attributes to another workspace', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    /* No vendor document states that `user_ids` and `connected_account_ids`
       compose as AND. If the id filter ever short-circuited the owner filter,
       this row is what would come back — and deleting it would be a
       cross-tenant delete, so the resolve refuses instead. */
    const upstream = createComposioIntegrationProvider(async () =>
      Response.json({
        items: [accountRow({ id: 'someone-elses', user_id: 'workspace-2' })],
        total_items: 1,
        total_pages: 1,
        next_cursor: null,
      }),
    )

    await expect(
      upstream.getConnection({ workspaceId: 'workspace-1', providerConnectionId: 'someone-elses' }),
    ).resolves.toBeUndefined()
  })

  test('refuses a single row whose id is not the one it asked for', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    // The owner matches and only one row came back — everything but the id.
    const upstream = createComposioIntegrationProvider(async () =>
      Response.json({
        items: [accountRow({ id: 'some-other-account', user_id: 'workspace-1' })],
        total_items: 1,
        total_pages: 1,
        next_cursor: null,
      }),
    )

    await expect(
      upstream.getConnection({ workspaceId: 'workspace-1', providerConnectionId: 'wanted' }),
    ).resolves.toBeUndefined()
  })

  test('resolves a row the provider no longer attributes to anyone', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    /* Composio has deprecated `user_id` on this response. When it goes, the
       `user_ids` request filter is the whole tenancy proof; the row must still
       resolve rather than every disconnect failing closed on a missing field. */
    const { user_id: _dropped, ...withoutOwner } = accountRow({
      id: 'unowned-by-response',
      user_id: 'workspace-1',
    })
    const upstream = createComposioIntegrationProvider(async () =>
      Response.json({ items: [withoutOwner], total_items: 1, total_pages: 1, next_cursor: null }),
    )

    await expect(
      upstream.getConnection({
        workspaceId: 'workspace-1',
        providerConnectionId: 'unowned-by-response',
      }),
    ).resolves.toMatchObject({ id: 'unowned-by-response', integration: 'gmail' })
  })

  test('refuses a resolve that matched more than the one id it asked for', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    const upstream = createComposioIntegrationProvider(async () =>
      Response.json({
        items: [
          accountRow({ id: 'wanted', user_id: 'workspace-1' }),
          accountRow({ id: 'unwanted', user_id: 'workspace-1' }),
        ],
        total_items: 2,
        total_pages: 1,
        next_cursor: null,
      }),
    )

    await expect(
      upstream.getConnection({ workspaceId: 'workspace-1', providerConnectionId: 'wanted' }),
    ).resolves.toBeUndefined()
  })

  test('treats an already-gone upstream connection as a successful disconnect', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    const requests: Array<{ url: string; method?: string; init?: RequestInit }> = []
    const upstream = createComposioIntegrationProvider(async (input, init) => {
      requests.push({ url: String(input), method: init?.method, init })
      return Response.json({ error: 'not found' }, { status: 404 })
    })

    await expect(
      upstream.disconnect({
        workspaceId: 'duet:workspace:user',
        providerConnectionId: 'account/already-gone',
      }),
    ).resolves.toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('DELETE')
    // The vendor client owns the API version segment; Duet no longer writes it.
    expect(new URL(requests[0]!.url).pathname).toEndWith(
      '/connected_accounts/account%2Falready-gone',
    )
    expect(new Headers(requests[0]!.init?.headers).get('x-api-key')).toBe('test-composio-key')
  })

  test('surfaces an upstream disconnect failure instead of reporting success', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    const upstream = createComposioIntegrationProvider(async () =>
      Response.json({ error: 'boom' }, { status: 500 }),
    )

    await expect(
      upstream.disconnect({ workspaceId: 'workspace-1', providerConnectionId: 'still-there' }),
    ).rejects.toThrow()
  })

  test('creates a Tool Router session with the exact disabled toolkit set and default workbench', async () => {
    const createCalls: Array<{ workspaceId: string; config: Record<string, unknown> }> = []
    const provider = createComposioMcpProvider(() => ({
      create: async (workspaceId, config) => {
        createCalls.push({ workspaceId, config })
        return {
          sessionId: 'provider-session-1',
          update: async () => undefined,
          mcp: {
            type: 'http' as const,
            url: 'https://mcp.example/session-1',
            headers: { 'x-api-key': 'ephemeral-session-key' },
          },
        }
      },
      use: async () => {
        throw new Error('unexpected rehydrate')
      },
      delete: async () => {
        throw new Error('unexpected delete')
      },
    }))

    await expect(
      provider.createToolRouterSession({
        workspaceId: 'workspace_1',
        callbackUrl: 'https://api.example/callback',
        disabledToolkitSlugs: ['github', 'gmail'],
      }),
    ).resolves.toEqual({
      providerSessionId: 'provider-session-1',
      mcp: {
        type: 'http',
        url: 'https://mcp.example/session-1',
        headers: { 'x-api-key': 'ephemeral-session-key' },
      },
    })
    expect(createCalls).toEqual([
      {
        workspaceId: 'workspace_1',
        config: {
          mcp: true,
          toolkits: { disable: ['github', 'gmail'] },
          manageConnections: {
            enable: true,
            waitForConnections: true,
            callbackUrl: 'https://api.example/callback',
          },
        },
      },
    ])
  })

  test('omits the toolkit filter when no toolkits are disabled', async () => {
    let createConfig: Record<string, unknown> | undefined
    const provider = createComposioMcpProvider(() => ({
      create: async (_workspaceId, config) => {
        createConfig = config
        return {
          sessionId: 'provider-session-open',
          update: async () => undefined,
          mcp: { type: 'http' as const, url: 'https://mcp.example/open' },
        }
      },
      use: async () => {
        throw new Error('unexpected rehydrate')
      },
      delete: async () => {
        throw new Error('unexpected delete')
      },
    }))

    await provider.createToolRouterSession({
      workspaceId: 'workspace_1',
      callbackUrl: 'https://api.example/callback',
      disabledToolkitSlugs: [],
    })

    expect(createConfig).not.toHaveProperty('toolkits')
  })

  test('rehydrates a stored provider session with MCP enabled', async () => {
    const useCalls: Array<{ providerSessionId: string; options: Record<string, unknown> }> = []
    const provider = createComposioMcpProvider(() => ({
      create: async () => {
        throw new Error('unexpected create')
      },
      use: async (providerSessionId, options) => {
        useCalls.push({ providerSessionId, options })
        return {
          sessionId: providerSessionId,
          update: async () => undefined,
          mcp: {
            type: 'http' as const,
            url: 'https://mcp.example/rehydrated',
            headers: { 'x-api-key': 'fresh-session-key' },
          },
        }
      },
      delete: async () => {
        throw new Error('unexpected delete')
      },
    }))

    await expect(
      provider.useToolRouterSession({ providerSessionId: 'provider-session-stored' }),
    ).resolves.toEqual({
      providerSessionId: 'provider-session-stored',
      mcp: {
        type: 'http',
        url: 'https://mcp.example/rehydrated',
        headers: { 'x-api-key': 'fresh-session-key' },
      },
    })
    expect(useCalls).toEqual([
      { providerSessionId: 'provider-session-stored', options: { mcp: true } },
    ])
  })

  test('updates toolkit permissions without replacing the Tool Router session', async () => {
    const updates: unknown[] = []
    const provider = createComposioMcpProvider(() => ({
      create: async () => {
        throw new Error('unexpected create')
      },
      use: async providerSessionId => ({
        sessionId: providerSessionId,
        mcp: { type: 'http' as const, url: 'https://mcp.example/preserved' },
        update: async config => {
          updates.push(config)
        },
      }),
      delete: async () => {
        throw new Error('unexpected delete')
      },
    }))

    await expect(
      provider.updateToolRouterSession({
        providerSessionId: 'provider-session-preserved',
        disabledToolkitSlugs: ['github'],
      }),
    ).resolves.toBeUndefined()
    expect(updates).toEqual([{ toolkits: { disable: ['github'] } }])
  })

  test('deletes an orphaned Tool Router session by provider ID', async () => {
    const deleted: string[] = []
    const provider = createComposioMcpProvider(() => ({
      create: async () => {
        throw new Error('unexpected create')
      },
      use: async () => {
        throw new Error('unexpected rehydrate')
      },
      delete: async providerSessionId => {
        deleted.push(providerSessionId)
      },
    }))

    await provider.deleteToolRouterSession({ providerSessionId: 'provider-session-orphaned' })

    expect(deleted).toEqual(['provider-session-orphaned'])
  })
})

function accountRow(overrides: { id: string; user_id: string; status?: string }) {
  return {
    id: overrides.id,
    user_id: overrides.user_id,
    status: overrides.status ?? 'ACTIVE',
    toolkit: { slug: 'gmail' },
    auth_config: { id: 'auth-1', is_composio_managed: true, is_disabled: false },
    alias: null,
    status_reason: null,
    is_disabled: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  }
}
