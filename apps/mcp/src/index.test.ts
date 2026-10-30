import { describe, expect, test } from 'bun:test'

import { createApprovedModelCatalog, type FetchLike } from '@repo/contract'
import { mcpHarness } from '@repo/test-harness'

import { createMcpHttpApp, createMcpServer, createMcpToolRegistry } from './index'

const API_BASE_URL = 'https://api.test'

const MEDIA_MODEL_CATALOG = createApprovedModelCatalog([
  {
    id: 'image',
    gatewayModelId: 'fixture/image-default',
    kind: 'image',
    name: 'Fixture image default',
    simpleName: 'Image default',
    description: 'Fixture default image model',
    pricing: { perImage: 0.01 },
  },
  {
    id: 'fixture-image',
    gatewayModelId: 'fixture/image-explicit',
    kind: 'image',
    name: 'Fixture image explicit',
    simpleName: 'Image explicit',
    description: 'Fixture explicit image model',
    pricing: { perImage: 0.02 },
  },
  {
    id: 'fixture-image-hidden',
    gatewayModelId: 'fixture/image-hidden',
    kind: 'image',
    name: 'Fixture hidden image',
    simpleName: 'Hidden image',
    description: 'Fixture hidden image model',
    hidden: true,
    pricing: { perImage: 0.03 },
  },
  {
    id: 'fixture-language-image',
    gatewayModelId: 'future-provider/image-chat',
    kind: 'image',
    name: 'Language image',
    simpleName: 'Image',
    description: 'Image-producing language model',
    pricing: { perImage: 0.01 },
  },
  {
    id: 'video',
    gatewayModelId: 'fixture/video-default',
    kind: 'video',
    name: 'Fixture video default',
    simpleName: 'Video default',
    description: 'Fixture default video model',
    pricing: { perSecond: 0.04 },
  },
  {
    id: 'fixture-video',
    gatewayModelId: 'fixture/video-explicit',
    kind: 'video',
    name: 'Fixture video explicit',
    simpleName: 'Video explicit',
    description: 'Fixture explicit video model',
    pricing: { perSecond: 0.05 },
  },
])

describe('duet hosted MCP facade', () => {
  test('every tool declares plural capability and scope requirements', () => {
    const definitions = createMcpToolRegistry().list() as unknown as Array<Record<string, unknown>>

    for (const definition of definitions) {
      expect(definition).not.toHaveProperty('capability')
      expect(definition).not.toHaveProperty('scopeRequirement')
      expect(definition.capabilities).toBeArray()
      expect(definition.scopeRequirements).toBeFunction()
      const scopes = (
        definition.scopeRequirements as (input: { workspace: string }) => readonly string[]
      )({ workspace: 'probe' })
      expect(scopes.length).toBeGreaterThan(0)
    }
    expect(definitions.find(tool => tool.name === 'generate_media')?.capabilities).toEqual([
      'services',
      'files:write',
      'files:read',
    ])
    expect(
      (
        definitions.find(tool => tool.name === 'generate_media')!.scopeRequirements as (input: {
          workspace: string
        }) => readonly string[]
      )({ workspace: 'probe' }),
    ).toEqual(['ws:probe:services', 'ws:probe:files:write', 'ws:probe:files:read'])
    expect(
      definitions
        .filter(tool => tool.name !== 'generate_media')
        .every(tool => {
          const scopes = (
            tool.scopeRequirements as (input: { workspace: string }) => readonly string[]
          )({ workspace: 'probe' })
          return (tool.capabilities as unknown[]).length === 1 && scopes.length === 1
        }),
    ).toBe(true)
  })

  test('tool list matches the registered tool registry', async () => {
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_unused',
      fetch: async () => Response.json({}),
    })
    const harness = await mcpHarness(server)
    try {
      const listed = await harness.listTools()
      expect(listed.tools.map(tool => tool.name).sort()).toEqual(registeredToolNames())
      const mediaTool = listed.tools.find(tool => tool.name === 'generate_media')
      expect(mediaTool?.description).toContain('role')
      expect(mediaTool?.description).not.toContain('audio')
      expect(mediaTool?.inputSchema).toMatchObject({
        properties: { kind: { enum: ['image', 'video'] } },
      })
      expect(mediaTool?._meta).toEqual({
        'duet/requiredCapabilities': ['services', 'files:write', 'files:read'],
      })
      expect(mediaTool?._meta).not.toHaveProperty('duet/requiredCapability')
    } finally {
      await harness.close()
    }
  })

  test('list_files rejects path traversal before building a REST URL', async () => {
    const apiCalls: string[] = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_unused',
      fetch: async input => {
        apiCalls.push(String(input))
        return Response.json({})
      },
    })
    const harness = await mcpHarness(server)
    try {
      const result = await harness.callTool('list_files', {
        workspace: 'mcp-safe',
        path: '../anchors',
      })
      expect(result.isError).toBe(true)
      expect(textContent(result)).toContain('Input validation error')
      expect(apiCalls).toEqual([])
    } finally {
      await harness.close()
    }
  })

  test('list_files preserves leading whitespace instead of creating dot segments', async () => {
    const apiCalls: string[] = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_unused',
      fetch: async (input, init) => {
        apiCalls.push(new Request(input, init).url)
        return Response.json({ items: [], nextCursor: null })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const result = await harness.callTool('list_files', {
        workspace: 'mcp-safe',
        path: ' ../anchors',
      })
      expect(result.isError).not.toBe(true)
      expect(apiCalls).toEqual([`${API_BASE_URL}/v1/ws/mcp-safe/files/%20../anchors?list=1`])
    } finally {
      await harness.close()
    }
  })

  test('file tools encode literal percent identities exactly once', async () => {
    const apiCalls: string[] = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_unused',
      fetch: async (input, init) => {
        apiCalls.push(new Request(input, init).url)
        return Response.json({ items: [], nextCursor: null })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const result = await harness.callTool('list_files', {
        workspace: 'mcp-safe',
        path: 'a%2Fb/100%',
        cursor: 'opaque page',
        limit: 2,
      })
      expect(result.isError).not.toBe(true)
      expect(apiCalls).toEqual([
        `${API_BASE_URL}/v1/ws/mcp-safe/files/a%252Fb/100%25?list=1&cursor=opaque+page&limit=2`,
      ])
    } finally {
      await harness.close()
    }
  })

  test('tools preserve upstream 401/403 scope errors at the MCP boundary', async () => {
    const workspace = 'mcp-scope'
    const unauthorizedHarness = await mcpHarness(
      createMcpServer({
        apiBaseUrl: API_BASE_URL,
        bearerToken: 'duet_sk_unknown',
        fetch: async () => Response.json({ error: 'unauthorized' }, { status: 401 }),
      }),
    )
    try {
      const unauthorized = await unauthorizedHarness.callTool('read_file', {
        workspace,
        path: 'notes/a.txt',
      })
      expect(unauthorized.isError).toBe(true)
      expect(JSON.parse(textContent(unauthorized))).toEqual({
        error: 'unauthorized',
        status: 401,
        requiredScopes: [`ws:${workspace}:files:read`],
      })
    } finally {
      await unauthorizedHarness.close()
    }

    for (const denied of [
      {
        tool: 'write_file',
        input: { workspace, path: 'notes/a.txt', content: 'blocked' },
        scope: `ws:${workspace}:files:write`,
      },
      {
        tool: 'list_files',
        input: { workspace, path: '' },
        scope: `ws:${workspace}:files:read`,
      },
    ] as const) {
      const harness = await mcpHarness(
        createMcpServer({
          apiBaseUrl: API_BASE_URL,
          bearerToken: 'duet_sk_wrong_scope',
          fetch: async () =>
            Response.json({ error: 'insufficient_scope', scope: denied.scope }, { status: 403 }),
        }),
      )
      try {
        const result = await harness.callTool(denied.tool, denied.input)
        expect(result.isError).toBe(true)
        expect(JSON.parse(textContent(result))).toEqual({
          error: 'insufficient_scope',
          status: 403,
          requiredScopes: [denied.scope],
          missingScopes: [denied.scope],
        })
      } finally {
        await harness.close()
      }
    }
  })

  test('train_start defaults to the workspace root and forwards only URL and drive references', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_train',
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        })
        return Response.json(
          { jobId: 'train_1', job: { state: 'queued', phase: 'preparing' } },
          {
            status: 202,
          },
        )
      },
    })
    const harness = await mcpHarness(server)
    try {
      const result = await harness.callTool('train_start', {
        workspace: 'mcp-train',
        urls: ['https://example.com/guide'],
        driveFiles: ['reports/q2.pdf'],
      })

      expect(result.isError).not.toBe(true)
      expect(JSON.parse(textContent(result))).toMatchObject({ jobId: 'train_1' })
      expect(requests).toEqual([
        {
          url: `${API_BASE_URL}/v1/ws/mcp-train/train`,
          body: {
            urls: ['https://example.com/guide'],
            driveFiles: ['reports/q2.pdf'],
          },
        },
      ])
    } finally {
      await harness.close()
    }
  })

  test('train_start rejects byte-bearing fields before making a REST request', async () => {
    const apiCalls: string[] = []
    const harness = await mcpHarness(
      createMcpServer({
        apiBaseUrl: API_BASE_URL,
        bearerToken: 'duet_sk_train',
        fetch: async input => {
          apiCalls.push(String(input))
          return Response.json({})
        },
      }),
    )
    try {
      for (const input of [
        { workspace: 'mcp-train', files: [] },
        { workspace: 'mcp-train', content: 'raw file bytes' },
        { workspace: 'mcp-train', encoding: 'base64' },
      ]) {
        const result = await harness.callTool('train_start', input)
        expect(result.isError).toBe(true)
        expect(textContent(result)).toContain('Input validation error')
      }
      expect(apiCalls).toEqual([])
    } finally {
      await harness.close()
    }
  })

  test('write/read files and add/search memory through the MCP HTTP boundary', async () => {
    const workspace = 'mcp-happy'
    const files = new Map<string, string>()
    const memories: Array<{ id: string; content: string; source: string }> = []
    let downloadMint = 0
    const fetch: FetchLike = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const filePrefix = `/v1/ws/${workspace}/files/`
      if (url.pathname === `/v1/ws/${workspace}/file-downloads` && request.method === 'POST') {
        const { path } = (await request.json()) as { path: string }
        const content = files.get(path)
        if (content === undefined) {
          return Response.json({ error: 'not_found' }, { status: 404 })
        }
        return Response.json({
          uri: `https://vm.test/v1/files/${path}?grant=opaque-${++downloadMint}`,
          name: path,
          mimeType: 'text/plain; charset=utf-8',
          size: new TextEncoder().encode(content).length,
        })
      }
      if (url.pathname.startsWith(filePrefix)) {
        const filePath = decodeURIComponent(url.pathname.slice(filePrefix.length))
        if (request.method === 'PUT') {
          const content = await request.text()
          files.set(filePath, content)
          return Response.json({ ok: true, size: new TextEncoder().encode(content).length })
        }
        const content = files.get(filePath)
        return content === undefined
          ? Response.json({ error: 'not_found' }, { status: 404 })
          : new Response(content, {
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            })
      }
      if (url.pathname === `/v1/ws/${workspace}/memories` && request.method === 'POST') {
        const body = (await request.json()) as { content: string; source?: string }
        const memory = {
          id: `mem_${memories.length + 1}`,
          content: body.content,
          source: body.source ?? 'api',
        }
        memories.push(memory)
        return Response.json(memory)
      }
      if (url.pathname === `/v1/ws/${workspace}/memories/search` && request.method === 'GET') {
        const query = url.searchParams.get('q') ?? ''
        const limit = Number(url.searchParams.get('limit') ?? '10')
        return Response.json({
          query,
          limit,
          results: memories
            .filter(memory => memory.content.toLowerCase().includes(query.toLowerCase()))
            .slice(0, limit)
            .map(memory => ({ ...memory, relevanceScore: 1 })),
        })
      }
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const harness = await mcpHarness(
      createMcpServer({
        apiBaseUrl: API_BASE_URL,
        bearerToken: 'duet_sk_happy',
        fetch,
      }),
    )
    try {
      const write = await harness.callTool('write_file', {
        workspace,
        path: 'notes/a.txt',
        content: 'hello from mcp',
      })
      expect(write.isError).not.toBe(true)
      expect(write.structuredContent).toEqual({ ok: true, size: 14 })

      const read = await harness.callTool('read_file', {
        workspace,
        path: 'notes/a.txt',
      })
      expect(read.isError).not.toBe(true)
      expect(read.content).toEqual([
        { type: 'text', text: 'hello from mcp' },
        {
          type: 'resource_link',
          uri: 'https://vm.test/v1/files/notes/a.txt?grant=opaque-1',
          name: 'notes/a.txt',
          mimeType: 'text/plain; charset=utf-8',
          size: 14,
        },
      ])
      expect(read.structuredContent).toBeUndefined()

      await harness.callTool('write_file', {
        workspace,
        path: 'notes/a.txt',
        content: 'new bytes',
      })
      const reread = await harness.callTool('read_file', {
        workspace,
        path: 'notes/a.txt',
      })
      expect(reread.content).toEqual([
        { type: 'text', text: 'new bytes' },
        {
          type: 'resource_link',
          uri: 'https://vm.test/v1/files/notes/a.txt?grant=opaque-2',
          name: 'notes/a.txt',
          mimeType: 'text/plain; charset=utf-8',
          size: 9,
        },
      ])

      for (const [path, content] of [
        ['notes/empty.txt', ''],
        ['notes/large.txt', 'x'.repeat(128 * 1024)],
      ] as const) {
        await harness.callTool('write_file', { workspace, path, content })
        const result = await harness.callTool('read_file', { workspace, path })
        expect(result.content[0]).toEqual({ type: 'text', text: content })
        expect(result.content[1]).toMatchObject({
          type: 'resource_link',
          name: path,
          size: new TextEncoder().encode(content).length,
        })
        expect(result.structuredContent).toBeUndefined()
      }

      const add = await harness.callTool('memory_add', {
        workspace,
        content: 'Enterprise discount cap is 20 percent',
      })
      expect(add.isError).not.toBe(true)
      expect(add.structuredContent).toEqual({
        id: 'mem_1',
        content: 'Enterprise discount cap is 20 percent',
        source: 'api',
      })

      const search = await harness.callTool('memory_search', {
        workspace,
        query: 'discount',
        limit: 5,
      })
      expect(search.isError).not.toBe(true)
      expect(search.structuredContent).toEqual({
        query: 'discount',
        limit: 5,
        results: [
          {
            id: 'mem_1',
            content: 'Enterprise discount cap is 20 percent',
            source: 'api',
            relevanceScore: 1,
          },
        ],
      })
    } finally {
      await harness.close()
    }
  })

  test('read_file returns a binary ResourceLink without downloading the file', async () => {
    const apiCalls: Array<{ method: string; path: string; body: unknown }> = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_binary',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const path = new URL(request.url).pathname
        apiCalls.push({
          method: request.method,
          path,
          body: request.method === 'POST' ? await request.json() : null,
        })
        if (path === '/v1/ws/mcp-binary/file-downloads' && request.method === 'POST') {
          return Response.json({
            uri: 'https://vm.test/v1/files/image.png?grant=opaque',
            name: 'image.png',
            mimeType: 'image/png',
            size: 4,
          })
        }
        return Response.json({ error: 'unexpected_request' }, { status: 500 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const read = await harness.callTool('read_file', {
        workspace: 'mcp-binary',
        path: 'image.png',
      })
      expect(read.isError).not.toBe(true)
      expect(read.content).toEqual([
        {
          type: 'resource_link',
          uri: 'https://vm.test/v1/files/image.png?grant=opaque',
          name: 'image.png',
          mimeType: 'image/png',
          size: 4,
        },
      ])
      expect(read.structuredContent).toBeUndefined()
      expect(apiCalls).toEqual([
        {
          method: 'POST',
          path: '/v1/ws/mcp-binary/file-downloads',
          body: { path: 'image.png' },
        },
      ])
    } finally {
      await harness.close()
    }
  })

  test('root preserves upstream auth failures but maps auth service outages to gateway errors', async () => {
    const unauthorizedApp = createMcpHttpApp({
      apiBaseUrl: API_BASE_URL,
      fetch: async () => Response.json({ error: 'unauthorized' }, { status: 401 }),
    })
    const unauthorized = await unauthorizedApp.request('/', {
      method: 'POST',
      headers: { authorization: 'Bearer duet_sk_bad' },
    })
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({ error: 'unauthorized' })
    expect(unauthorized.headers.get('www-authenticate')).not.toBeNull()

    const upstreamFailureApp = createMcpHttpApp({
      apiBaseUrl: API_BASE_URL,
      fetch: async () => Response.json({ error: 'down' }, { status: 503 }),
    })
    const upstreamFailure = await upstreamFailureApp.request('/', {
      method: 'POST',
      headers: { authorization: 'Bearer duet_sk_good' },
    })
    expect(upstreamFailure.status).toBe(502)
    expect(await upstreamFailure.json()).toEqual({ error: 'auth_unavailable' })

    const networkFailureApp = createMcpHttpApp({
      apiBaseUrl: API_BASE_URL,
      fetch: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    })
    const networkFailure = await networkFailureApp.request('/', {
      method: 'POST',
      headers: { authorization: 'Bearer duet_sk_good' },
    })
    expect(networkFailure.status).toBe(503)
    expect(await networkFailure.json()).toEqual({ error: 'auth_unavailable' })
  })

  test('structured 404 tool errors name the required scope', async () => {
    const workspace = 'mcp-404'
    const harness = await mcpHarness(
      createMcpServer({
        apiBaseUrl: API_BASE_URL,
        bearerToken: 'duet_sk_files_read',
        fetch: async () => Response.json({ error: 'not_found' }, { status: 404 }),
      }),
    )
    try {
      const missing = await harness.callTool('read_file', {
        workspace,
        path: 'missing.txt',
      })
      expect(missing.isError).toBe(true)
      expect(JSON.parse(textContent(missing))).toEqual({
        error: 'not_found',
        status: 404,
        requiredScopes: [`ws:${workspace}:files:read`],
      })
    } finally {
      await harness.close()
    }
  })

  test('read_file preserves an authenticated text GET failure after creating the link', async () => {
    const workspace = 'mcp-text-failure'
    const harness = await mcpHarness(
      createMcpServer({
        apiBaseUrl: API_BASE_URL,
        bearerToken: 'duet_sk_files_read',
        fetch: async (input, init) => {
          const request = new Request(input, init)
          const path = new URL(request.url).pathname
          if (path.endsWith('/file-downloads')) {
            return Response.json({
              uri: 'https://vm.test/v1/files/notes.txt?grant=opaque',
              name: 'notes.txt',
              mimeType: 'text/plain; charset=utf-8',
              size: 5,
            })
          }
          return Response.json({ error: 'not_found' }, { status: 404 })
        },
      }),
    )
    try {
      const result = await harness.callTool('read_file', {
        workspace,
        path: 'notes.txt',
      })
      expect(result.isError).toBe(true)
      expect(JSON.parse(textContent(result))).toEqual({
        error: 'not_found',
        status: 404,
        requiredScopes: [`ws:${workspace}:files:read`],
      })
    } finally {
      await harness.close()
    }
  })

  test('read_file keeps the resource link when declared text is not valid UTF-8', async () => {
    const harness = await mcpHarness(
      createMcpServer({
        apiBaseUrl: API_BASE_URL,
        bearerToken: 'duet_sk_files_read',
        fetch: async (input, init) => {
          const request = new Request(input, init)
          if (new URL(request.url).pathname.endsWith('/file-downloads')) {
            return Response.json({
              uri: 'https://vm.test/v1/files/broken.txt?grant=opaque',
              name: 'broken.txt',
              mimeType: 'text/plain; charset=utf-8',
              size: 2,
            })
          }
          return new Response(new Uint8Array([0xc3, 0x28]))
        },
      }),
    )
    try {
      const result = await harness.callTool('read_file', {
        workspace: 'mcp-invalid-text',
        path: 'broken.txt',
      })
      expect(result.content).toEqual([
        {
          type: 'resource_link',
          uri: 'https://vm.test/v1/files/broken.txt?grant=opaque',
          name: 'broken.txt',
          mimeType: 'text/plain; charset=utf-8',
          size: 2,
        },
      ])
      expect(result.structuredContent).toBeUndefined()
    } finally {
      await harness.close()
    }
  })

  test('run_agent is a scope-enforced REST facade over the agent session route', async () => {
    const calls: Array<{
      url: string
      method: string
      body: unknown
      authorization: string | null
    }> = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_agent',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        calls.push({
          url: request.url,
          method: request.method,
          body: await request.json(),
          authorization: request.headers.get('authorization'),
        })
        return Response.json(
          { error: 'insufficient_scope', scope: 'ws:mcp-agent:sessions' },
          { status: 403 },
        )
      },
    })
    const harness = await mcpHarness(server)
    try {
      const denied = await harness.callTool('run_agent', {
        workspace: 'mcp-agent',
        prompt: 'summarize reports',
      })
      expect(denied.isError).toBe(true)
      expect(JSON.parse(textContent(denied))).toEqual({
        error: 'insufficient_scope',
        status: 403,
        requiredScopes: ['ws:mcp-agent:sessions'],
        missingScopes: ['ws:mcp-agent:sessions'],
      })
      const deniedWithImage = await harness.callTool('run_agent', {
        workspace: 'mcp-agent',
        prompt: 'inspect screenshot',
        images: [{ data: 'cnVuLWltZw==', mimeType: 'image/webp' }],
      })
      expect(deniedWithImage.isError).toBe(true)
      expect(calls).toEqual([
        {
          url: `${API_BASE_URL}/v1/ws/mcp-agent/agent/sessions`,
          method: 'POST',
          body: { prompt: 'summarize reports' },
          authorization: 'Bearer duet_sk_agent',
        },
        {
          url: `${API_BASE_URL}/v1/ws/mcp-agent/agent/sessions`,
          method: 'POST',
          body: {
            prompt: 'inspect screenshot',
            images: [{ data: 'cnVuLWltZw==', mimeType: 'image/webp' }],
          },
          authorization: 'Bearer duet_sk_agent',
        },
      ])
    } finally {
      await harness.close()
    }
  })

  test('agent session list and notes are scope-enforced REST facades', async () => {
    const calls: Array<{
      url: string
      method: string
      body: unknown | null
      authorization: string | null
    }> = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_agent',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const text = await request.text()
        calls.push({
          url: request.url,
          method: request.method,
          body: text.length === 0 ? null : JSON.parse(text),
          authorization: request.headers.get('authorization'),
        })
        return Response.json(
          { error: 'insufficient_scope', scope: 'ws:mcp-agent:sessions' },
          { status: 403 },
        )
      },
    })
    const harness = await mcpHarness(server)
    try {
      const listed = await harness.callTool('list_agent_sessions', {
        workspace: 'mcp-agent',
        cursor: 'updated:3/session a',
        limit: 25,
      })
      expect(listed.isError).toBe(true)
      expect(JSON.parse(textContent(listed))).toEqual({
        error: 'insufficient_scope',
        status: 403,
        requiredScopes: ['ws:mcp-agent:sessions'],
        missingScopes: ['ws:mcp-agent:sessions'],
      })

      const noted = await harness.callTool('add_agent_note', {
        workspace: 'mcp-agent',
        sessionId: 'sess/one',
        note: 'Use the session timeline before answering.',
        images: [{ data: 'bm90ZQ==', mimeType: 'image/png' }],
        attachments: [{ path: 'uploads/brief.pdf', name: 'brief.pdf', bytes: 3 }],
      })
      expect(noted.isError).toBe(true)
      expect(JSON.parse(textContent(noted))).toEqual({
        error: 'insufficient_scope',
        status: 403,
        requiredScopes: ['ws:mcp-agent:sessions'],
        missingScopes: ['ws:mcp-agent:sessions'],
      })

      expect(calls).toEqual([
        {
          url: `${API_BASE_URL}/v1/ws/mcp-agent/agent/sessions?cursor=updated%3A3%2Fsession+a&limit=25`,
          method: 'GET',
          body: null,
          authorization: 'Bearer duet_sk_agent',
        },
        {
          url: `${API_BASE_URL}/v1/ws/mcp-agent/agent/sessions/sess%2Fone/note`,
          method: 'POST',
          body: {
            note: 'Use the session timeline before answering.',
            images: [{ data: 'bm90ZQ==', mimeType: 'image/png' }],
            attachments: [{ path: 'uploads/brief.pdf', name: 'brief.pdf', bytes: 3 }],
          },
          authorization: 'Bearer duet_sk_agent',
        },
      ])
    } finally {
      await harness.close()
    }
  })

  test('agent session tools reject malformed schema input before REST calls', async () => {
    const apiCalls: string[] = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_unused',
      fetch: async input => {
        apiCalls.push(String(input))
        return Response.json({})
      },
    })
    const harness = await mcpHarness(server)
    try {
      const badSlug = await harness.callTool('list_agent_sessions', {
        workspace: 'Mcp-Agent',
      })
      expect(badSlug.isError).toBe(true)
      expect(textContent(badSlug)).toContain('Input validation error')

      const emptyNote = await harness.callTool('add_agent_note', {
        workspace: 'mcp-agent',
        sessionId: 'sess-one',
        note: '',
      })
      expect(emptyNote.isError).toBe(true)
      expect(textContent(emptyNote)).toContain('Input validation error')
      expect(apiCalls).toEqual([])
    } finally {
      await harness.close()
    }
  })

  test('generate_media and use_integration are scope-enforced facades', async () => {
    const calls: Array<{
      url: string
      method: string
      body: unknown | null
      authorization: string | null
      aiModelId: string | null
    }> = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      bearerToken: 'duet_sk_slice18',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const text = await request.text()
        calls.push({
          url: request.url,
          method: request.method,
          body: text.length === 0 ? null : JSON.parse(text),
          authorization: request.headers.get('authorization'),
          aiModelId: request.headers.get('ai-model-id'),
        })
        const scope = request.url.includes('/composio/execute/')
          ? 'ws:mcp-s18:integrations'
          : 'ws:mcp-s18:services'
        return Response.json({ error: 'insufficient_scope', scope }, { status: 403 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const media = await harness.callTool('generate_media', {
        workspace: 'mcp-s18',
        kind: 'image',
        prompt: 'logo sketch',
      })
      expect(media.isError).toBe(true)
      expect(JSON.parse(textContent(media))).toEqual({
        error: 'insufficient_scope',
        status: 403,
        requiredScopes: ['ws:mcp-s18:services', 'ws:mcp-s18:files:write', 'ws:mcp-s18:files:read'],
        missingScopes: ['ws:mcp-s18:services'],
      })

      const integration = await harness.callTool('use_integration', {
        workspace: 'mcp-s18',
        toolSlug: 'GMAIL_DRAFT_EMAIL',
        arguments: { to: 'team@example.com' },
      })
      expect(integration.isError).toBe(true)
      expect(JSON.parse(textContent(integration))).toEqual({
        error: 'insufficient_scope',
        status: 403,
        requiredScopes: ['ws:mcp-s18:integrations'],
        missingScopes: ['ws:mcp-s18:integrations'],
      })
      expect(calls).toEqual([
        {
          url: `${API_BASE_URL}/v1/whoami`,
          method: 'GET',
          body: null,
          authorization: 'Bearer duet_sk_slice18',
          aiModelId: null,
        },
        {
          url: `${API_BASE_URL}/v1/integrations/composio/execute/GMAIL_DRAFT_EMAIL`,
          method: 'POST',
          body: { workspace: 'mcp-s18', arguments: { to: 'team@example.com' } },
          authorization: 'Bearer duet_sk_slice18',
          aiModelId: null,
        },
      ])
    } finally {
      await harness.close()
    }
  })

  test('generate_media preflights every required scope before model generation', async () => {
    const calls: string[] = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_partial_media',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        calls.push(request.url)
        if (new URL(request.url).pathname === '/v1/whoami') {
          return Response.json({ scopes: ['ws:mcp-media-scope:services'] })
        }
        return Response.json({ error: 'unexpected_model_call' }, { status: 500 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const result = await harness.callTool('generate_media', {
        workspace: 'mcp-media-scope',
        kind: 'image',
        prompt: 'must not be billed',
      })

      expect(result.isError).toBe(true)
      expect(JSON.parse(textContent(result))).toEqual({
        error: 'insufficient_scope',
        status: 403,
        requiredScopes: [
          'ws:mcp-media-scope:services',
          'ws:mcp-media-scope:files:write',
          'ws:mcp-media-scope:files:read',
        ],
        missingScopes: ['ws:mcp-media-scope:files:write', 'ws:mcp-media-scope:files:read'],
      })
      expect(calls).toEqual([`${API_BASE_URL}/v1/whoami`])
    } finally {
      await harness.close()
    }
  })

  test('generate_media uploads generated bytes to a durable Drive path and returns one link', async () => {
    const calls: Array<{
      url: string
      method: string
      authorization: string | null
      contentType: string | null
      body: string
    }> = []
    let generatedPath: string | undefined
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_durable_media',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        const body = await request.text()
        calls.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.get('authorization'),
          contentType: request.headers.get('content-type'),
          body,
        })
        if (url.pathname === '/v1/whoami') {
          return Response.json({
            scopes: [
              'ws:mcp-durable-media:services',
              'ws:mcp-durable-media:files:write',
              'ws:mcp-durable-media:files:read',
            ],
          })
        }
        if (url.pathname === '/v4/ai/image-model') {
          return Response.json({ images: ['aGVsbG8='] })
        }
        if (url.pathname === '/v1/ws/mcp-durable-media/file-uploads') {
          expect(JSON.parse(body)).toEqual({ pathPrefix: 'mcp/generated-media' })
          return Response.json({
            vmBaseUrl: 'https://vm.test',
            uploadPath: '/v1/files/mcp/generated-media',
            uploadToken: 'upload-token',
            expiresAt: Date.now() + 60_000,
          })
        }
        if (url.origin === 'https://vm.test' && request.method === 'PUT') {
          generatedPath = `mcp/generated-media/${decodeURIComponent(url.pathname.split('/').at(-1)!)}`
          return Response.json({ ok: true })
        }
        if (url.pathname === '/v1/ws/mcp-durable-media/file-downloads') {
          generatedPath = (JSON.parse(body) as { path: string }).path
          return Response.json({
            uri: `https://vm.test/v1/files/${generatedPath}?grant=download-token`,
            name: generatedPath,
            mimeType: 'image/png',
            size: 5,
          })
        }
        return Response.json({ error: 'not_found' }, { status: 404 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const result = await harness.callTool('generate_media', {
        workspace: 'mcp-durable-media',
        kind: 'image',
        prompt: 'durable logo',
      })

      expect(result.isError).not.toBe(true)
      expect(generatedPath).toMatch(
        /^mcp\/generated-media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/,
      )
      if (generatedPath === undefined) throw new Error('generated path was not observed')
      expect(result).toEqual({
        content: [
          {
            type: 'resource_link',
            uri: `https://vm.test/v1/files/${generatedPath}?grant=download-token`,
            name: generatedPath,
            mimeType: 'image/png',
            size: 5,
          },
        ],
      })
      expect(calls.map(call => [new URL(call.url).origin, new URL(call.url).pathname])).toEqual([
        [API_BASE_URL, '/v1/whoami'],
        ['https://gateway.test', '/v1/models'],
        ['https://gateway.test', '/v4/ai/image-model'],
        [API_BASE_URL, '/v1/ws/mcp-durable-media/file-uploads'],
        ['https://vm.test', `/v1/files/${generatedPath}`],
        [API_BASE_URL, '/v1/ws/mcp-durable-media/file-downloads'],
      ])
      expect(calls.find(call => call.method === 'PUT')).toMatchObject({
        method: 'PUT',
        authorization: 'Bearer upload-token',
        contentType: 'image/png',
        body: 'hello',
      })
    } finally {
      await harness.close()
    }
  })

  test('generated video remains visible through ordinary Drive list and read tools', async () => {
    const workspace = 'mcp-visible-media'
    const driveFiles = new Map<string, { bytes: Uint8Array; mimeType: string }>()
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_visible_media',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.pathname === '/v1/whoami') {
          return Response.json({ scopes: mediaScopes(workspace) })
        }
        if (url.pathname === '/v4/ai/video-model') {
          return new Response(
            'data: {"type":"result","videos":[{"type":"base64","data":"dmlkZW8=","mediaType":"video/mp4"}]}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        if (url.pathname === `/v1/ws/${workspace}/file-uploads`) {
          return Response.json({
            vmBaseUrl: 'https://vm.test',
            uploadPath: '/v1/files/mcp/generated-media',
            uploadToken: 'upload-token',
            expiresAt: Date.now() + 60_000,
          })
        }
        if (url.origin === 'https://vm.test' && request.method === 'PUT') {
          const path = `mcp/generated-media/${decodeURIComponent(url.pathname.split('/').at(-1)!)}`
          driveFiles.set(path, {
            bytes: new Uint8Array(await request.arrayBuffer()),
            mimeType: request.headers.get('content-type') ?? 'application/octet-stream',
          })
          return Response.json({ ok: true })
        }
        if (url.pathname === `/v1/ws/${workspace}/file-downloads`) {
          const { path } = (await request.json()) as { path: string }
          const file = driveFiles.get(path)
          return file === undefined
            ? Response.json({ error: 'not_found' }, { status: 404 })
            : Response.json({
                uri: `https://vm.test/v1/files/${path}?grant=stable-token`,
                name: path,
                mimeType: file.mimeType,
                size: file.bytes.byteLength,
              })
        }
        if (url.pathname === `/v1/ws/${workspace}/files/mcp/generated-media`) {
          return Response.json({
            items: [...driveFiles].map(([path, file]) => ({
              name: path.split('/').at(-1),
              path,
              type: 'file',
              size: file.bytes.byteLength,
              mtime: '2026-08-25T12:00:00.000Z',
            })),
            nextCursor: null,
          })
        }
        return Response.json({ error: 'not_found' }, { status: 404 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const generated = await harness.callTool('generate_media', {
        workspace,
        kind: 'video',
        prompt: 'durable motion',
      })
      const link = generated.content[0]
      expect(link?.type).toBe('resource_link')
      if (link?.type !== 'resource_link') throw new Error('generated media link missing')

      const listed = await harness.callTool('list_files', {
        workspace,
        path: 'mcp/generated-media',
      })
      expect(JSON.parse(textContent(listed))).toEqual({
        items: [
          {
            name: link.name.split('/').at(-1),
            path: link.name,
            type: 'file',
            size: 5,
            mtime: '2026-08-25T12:00:00.000Z',
          },
        ],
        nextCursor: null,
      })

      const read = await harness.callTool('read_file', { workspace, path: link.name })
      expect(read).toEqual(generated)
      expect(driveFiles.get(link.name)?.bytes).toEqual(new TextEncoder().encode('video'))
    } finally {
      await harness.close()
    }
  })

  test('generate_media returns no resource when the raw VM upload fails', async () => {
    const calls: string[] = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_failed_upload',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        calls.push(url.pathname)
        if (url.pathname === '/v1/whoami') {
          return Response.json({ scopes: mediaScopes('mcp-upload-failure') })
        }
        if (url.pathname === '/v4/ai/image-model') {
          return Response.json({ images: ['aGVsbG8='] })
        }
        if (url.pathname === '/v1/ws/mcp-upload-failure/file-uploads') {
          return Response.json({
            vmBaseUrl: 'https://vm.test',
            uploadPath: '/v1/files/mcp/generated-media',
            uploadToken: 'upload-token',
            expiresAt: Date.now() + 60_000,
          })
        }
        if (url.origin === 'https://vm.test') {
          return Response.json({ error: 'storage_full' }, { status: 507 })
        }
        return Response.json({ error: 'unexpected' }, { status: 500 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const result = await harness.callTool('generate_media', {
        workspace: 'mcp-upload-failure',
        kind: 'image',
        prompt: 'will not persist',
      })

      expect(result.isError).toBe(true)
      expect(result.content).not.toContainEqual(expect.objectContaining({ type: 'resource_link' }))
      expect(JSON.parse(textContent(result))).toEqual({
        error: 'storage_full',
        status: 507,
        requiredScopes: mediaScopes('mcp-upload-failure'),
      })
      expect(calls.some(path => path.endsWith('/file-downloads'))).toBe(false)
    } finally {
      await harness.close()
    }
  })

  test('generate_media reports the durable path when reference creation fails', async () => {
    let uploadedPath: string | undefined
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_reference_failure',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.pathname === '/v1/whoami') {
          return Response.json({ scopes: mediaScopes('mcp-reference-failure') })
        }
        if (url.pathname === '/v4/ai/image-model') {
          return Response.json({ images: ['aGVsbG8='] })
        }
        if (url.pathname === '/v1/ws/mcp-reference-failure/file-uploads') {
          return Response.json({
            vmBaseUrl: 'https://vm.test',
            uploadPath: '/v1/files/mcp/generated-media',
            uploadToken: 'upload-token',
            expiresAt: Date.now() + 60_000,
          })
        }
        if (url.origin === 'https://vm.test') {
          uploadedPath = `mcp/generated-media/${decodeURIComponent(url.pathname.split('/').at(-1)!)}`
          return Response.json({ ok: true })
        }
        if (url.pathname === '/v1/ws/mcp-reference-failure/file-downloads') {
          if (uploadedPath === undefined) throw new Error('upload was not observed')
          expect((await request.json()) as { path: string }).toEqual({ path: uploadedPath })
          return Response.json({ error: 'gateway_unavailable' }, { status: 503 })
        }
        return Response.json({ error: 'unexpected' }, { status: 500 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const result = await harness.callTool('generate_media', {
        workspace: 'mcp-reference-failure',
        kind: 'image',
        prompt: 'durable but temporarily unlinked',
      })

      expect(result.isError).toBe(true)
      expect(uploadedPath).toMatch(/^mcp\/generated-media\/.+\.png$/)
      expect(JSON.parse(textContent(result))).toEqual({
        error: 'gateway_unavailable',
        status: 503,
        requiredScopes: mediaScopes('mcp-reference-failure'),
        path: uploadedPath,
      })
    } finally {
      await harness.close()
    }
  })

  test('generate_media reports the durable path when reference creation cannot connect', async () => {
    let uploadedPath: string | undefined
    const workspace = 'mcp-reference-network-failure'
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_reference_network_failure',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.pathname === '/v1/whoami') {
          return Response.json({ scopes: mediaScopes(workspace) })
        }
        if (url.pathname === '/v4/ai/image-model') {
          return Response.json({ images: ['aGVsbG8='] })
        }
        if (url.pathname === `/v1/ws/${workspace}/file-uploads`) {
          return Response.json({
            vmBaseUrl: 'https://vm.test',
            uploadPath: '/v1/files/mcp/generated-media',
            uploadToken: 'upload-token',
            expiresAt: Date.now() + 60_000,
          })
        }
        if (url.origin === 'https://vm.test') {
          uploadedPath = `mcp/generated-media/${decodeURIComponent(url.pathname.split('/').at(-1)!)}`
          return Response.json({ ok: true })
        }
        if (url.pathname === `/v1/ws/${workspace}/file-downloads`) {
          throw new Error('control plane unavailable')
        }
        return Response.json({ error: 'unexpected' }, { status: 500 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const result = await harness.callTool('generate_media', {
        workspace,
        kind: 'image',
        prompt: 'durable but temporarily unlinked',
      })

      expect(result.isError).toBe(true)
      expect(JSON.parse(textContent(result))).toEqual({
        error: 'file_resource_request_failed',
        status: 500,
        requiredScopes: mediaScopes(workspace),
        path: uploadedPath,
      })
    } finally {
      await harness.close()
    }
  })

  test('generate_media rejects an unowned generated MIME type before minting an upload', async () => {
    const calls: string[] = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_unknown_media',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const path = new URL(request.url).pathname
        calls.push(path)
        if (path === '/v1/whoami') {
          return Response.json({ scopes: mediaScopes('mcp-unknown-media') })
        }
        if (path === '/v4/ai/video-model') {
          return new Response(
            'data: {"type":"result","videos":[{"type":"base64","data":"dmlkZW8=","mediaType":"application/x-weird"}]}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return Response.json({ error: 'unexpected' }, { status: 500 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const result = await harness.callTool('generate_media', {
        workspace: 'mcp-unknown-media',
        kind: 'video',
        prompt: 'unknown container',
      })

      expect(result.isError).toBe(true)
      expect(JSON.parse(textContent(result))).toEqual({
        error: 'unsupported_media_type',
        status: 500,
        requiredScopes: mediaScopes('mcp-unknown-media'),
        mimeType: 'application/x-weird',
      })
      expect(calls).toEqual(['/v1/whoami', '/v4/ai/video-model'])
    } finally {
      await harness.close()
    }
  })

  test('use_integration returns the raw Composio execute response', async () => {
    let executeRequest: Request | undefined
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_composio',
      fetch: async (input, init) => {
        executeRequest = new Request(input, init)
        return Response.json({ successful: true, data: { draftId: 'draft_1' }, error: null })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const result = await harness.callTool('use_integration', {
        workspace: 'mcp-s18',
        toolSlug: 'GMAIL_DRAFT_EMAIL',
        arguments: { to: 'team@example.com' },
      })

      expect(result.isError).not.toBe(true)
      expect(JSON.parse(textContent(result))).toEqual({
        successful: true,
        data: { draftId: 'draft_1' },
        error: null,
      })
      expect(executeRequest?.url).toBe(
        `${API_BASE_URL}/v1/integrations/composio/execute/GMAIL_DRAFT_EMAIL`,
      )
      expect(await executeRequest?.json()).toEqual({
        workspace: 'mcp-s18',
        arguments: { to: 'team@example.com' },
      })
    } finally {
      await harness.close()
    }
  })

  test('generate_media preserves native image role generation when capability discovery fails', async () => {
    const calls: Array<{
      url: string
      method: string
      authorization: string | null
      aiModelId: string | null
      body: string
    }> = []
    let imageStatus: 200 | 402 | 403 = 200
    const persistence = createMediaPersistenceResponder('mcp-s09')
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_gateway',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        const persistenceRequest = request.clone()
        const body = await request.text()
        calls.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.get('authorization'),
          aiModelId: request.headers.get('ai-model-id'),
          body,
        })
        if (url.pathname === '/v1/whoami') {
          return Response.json({
            scopes: mediaScopes('mcp-s09'),
          })
        }
        if (url.pathname === '/v4/ai/image-model') {
          if (imageStatus !== 200) {
            return Response.json(
              {
                error: imageStatus === 402 ? 'insufficient_credits' : 'model_not_allowed',
              },
              { status: imageStatus },
            )
          }
          return Response.json({ images: ['aGVsbG8='] })
        }
        const persistenceResponse = await persistence(persistenceRequest)
        if (persistenceResponse !== undefined) return persistenceResponse
        return Response.json({ error: 'not_found' }, { status: 404 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const media = await harness.callTool('generate_media', {
        workspace: 'mcp-s09',
        kind: 'image',
        model: 'fixture-image',
        prompt: 'logo sketch',
      })
      expect(media.isError).toBeFalsy()
      expect(media.content).toMatchObject([
        {
          type: 'resource_link',
          mimeType: 'image/png',
          size: 5,
        },
      ])
      expect(
        calls.filter(call => new URL(call.url).pathname !== '/v1/models').slice(0, 2),
      ).toMatchObject([
        {
          url: `${API_BASE_URL}/v1/whoami`,
          method: 'GET',
          authorization: 'Bearer duet_sk_gateway',
        },
        {
          url: 'https://gateway.test/v4/ai/image-model',
          method: 'POST',
          authorization: 'Bearer duet_sk_gateway',
          aiModelId: 'fixture/image-explicit',
          body: '{"prompt":"logo sketch","n":1,"providerOptions":{}}',
        },
      ])

      calls.length = 0
      imageStatus = 402
      const blocked = await harness.callTool('generate_media', {
        workspace: 'mcp-s09',
        kind: 'image',
        model: 'fixture-image',
        prompt: 'logo sketch',
      })
      expect(blocked.isError).toBe(true)
      expect(JSON.parse(textContent(blocked))).toEqual({
        error: 'insufficient_credits',
        status: 402,
        requiredScopes: ['ws:mcp-s09:services', 'ws:mcp-s09:files:write', 'ws:mcp-s09:files:read'],
      })

      calls.length = 0
      imageStatus = 403
      const forbidden = await harness.callTool('generate_media', {
        workspace: 'mcp-s09',
        kind: 'image',
        model: 'fixture-image',
        prompt: 'logo sketch',
      })
      expect(forbidden.isError).toBe(true)
      expect(JSON.parse(textContent(forbidden))).toEqual({
        error: 'model_not_allowed',
        status: 403,
        requiredScopes: ['ws:mcp-s09:services', 'ws:mcp-s09:files:write', 'ws:mcp-s09:files:read'],
      })
    } finally {
      await harness.close()
    }
  })

  test('list_models preserves all upstream metadata and pages after kind filtering with services alone', async () => {
    const models = [
      {
        id: 'upstream/a',
        type: 'image',
        name: 'Image A',
        pricing: { image: '0.03' },
        extra: { enabled: true },
      },
      { id: 'upstream/chat', type: 'language', name: 'Chat' },
      { id: 'upstream/b', type: 'image', name: 'Image B', context: 123 },
      { id: 'upstream/future', type: 'unknown-new-type', output_modalities: ['audio'] },
    ]
    const gatewayRequests: Request[] = []
    const harness = await mcpHarness(
      createMcpServer({
        apiBaseUrl: API_BASE_URL,
        modelGatewayBaseUrl: 'https://gateway.test',
        bearerToken: 'duet_sk_discovery',
        fetch: async (input, init) => {
          const request = new Request(input, init)
          if (new URL(request.url).pathname === '/v1/whoami') {
            return Response.json({ scopes: ['ws:mcp-discovery:services'] })
          }
          gatewayRequests.push(request)
          return Response.json({ data: models })
        },
      }),
    )
    try {
      const collected: unknown[] = []
      let cursor: string | undefined
      do {
        const result = await harness.callTool('list_models', {
          workspace: 'mcp-discovery',
          limit: 1,
          cursor,
        })
        expect(result.isError).not.toBe(true)
        const page = result.structuredContent as { data: unknown[]; nextCursor: string | null }
        collected.push(...page.data)
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      expect(collected).toEqual(models)
      const first = await harness.callTool('list_models', {
        workspace: 'mcp-discovery',
        kind: 'image',
        limit: 1,
      })
      expect(first.structuredContent).toEqual({ data: [models[0]], nextCursor: '1' })
      const second = await harness.callTool('list_models', {
        workspace: 'mcp-discovery',
        kind: 'image',
        limit: 1,
        cursor: '1',
      })
      expect(second.structuredContent).toEqual({ data: [models[2]], nextCursor: null })
      for (const request of gatewayRequests) {
        expect(request.url).toBe('https://gateway.test/v1/models')
        expect(request.headers.get('authorization')).toBe('Bearer duet_sk_discovery')
        expect(request.headers.get('x-duet-workspace')).toBe('mcp-discovery')
        expect(request.headers.get('x-duet-tier')).toBeNull()
      }
    } finally {
      await harness.close()
    }
  })

  test('list_models rejects missing services and propagates upstream discovery failure before recovering', async () => {
    let services = false
    let gatewayStatus = 503
    const gatewayCalls: string[] = []
    const harness = await mcpHarness(
      createMcpServer({
        apiBaseUrl: API_BASE_URL,
        modelGatewayBaseUrl: 'https://gateway.test',
        bearerToken: 'duet_sk_discovery',
        fetch: async (input, init) => {
          const request = new Request(input, init)
          if (new URL(request.url).pathname === '/v1/whoami')
            return Response.json({
              scopes: services ? ['ws:mcp-discovery:services'] : ['ws:mcp-discovery:files:read'],
            })
          gatewayCalls.push(request.url)
          return gatewayStatus === 200
            ? Response.json({ data: [{ id: 'recovered/model', type: 'video' }] })
            : Response.json({ error: 'gateway_discovery_unavailable' }, { status: gatewayStatus })
        },
      }),
    )
    try {
      const input = { workspace: 'mcp-discovery' }
      const denied = await harness.callTool('list_models', input)
      expect(denied.isError).toBe(true)
      expect(denied.structuredContent).toEqual({
        error: 'insufficient_scope',
        status: 403,
        requiredScopes: ['ws:mcp-discovery:services'],
        missingScopes: ['ws:mcp-discovery:services'],
      })
      expect(gatewayCalls).toEqual([])
      services = true
      const failed = await harness.callTool('list_models', input)
      expect(failed.isError).toBe(true)
      expect(failed.structuredContent).toEqual({
        error: 'gateway_discovery_unavailable',
        status: 503,
        requiredScopes: ['ws:mcp-discovery:services'],
      })
      gatewayStatus = 200
      const recovered = await harness.callTool('list_models', input)
      expect(recovered.isError).not.toBe(true)
      expect(recovered.structuredContent).toEqual({
        data: [{ id: 'recovered/model', type: 'video' }],
        nextCursor: null,
      })
    } finally {
      await harness.close()
    }
  })

  test('generate_media forwards an uncatalogued raw video ID and controls without tariff attribution', async () => {
    const generationRequests: Request[] = []
    const uploaded: number[][] = []
    const persistence = createMediaPersistenceResponder('mcp-raw')
    const harness = await mcpHarness(
      createMcpServer({
        apiBaseUrl: API_BASE_URL,
        modelGatewayBaseUrl: 'https://gateway.test',
        approvedModelCatalog: MEDIA_MODEL_CATALOG,
        bearerToken: 'duet_sk_raw',
        fetch: async (input, init) => {
          const request = new Request(input, init)
          const path = new URL(request.url).pathname
          if (path === '/v1/whoami') return Response.json({ scopes: mediaScopes('mcp-raw') })
          if (path === '/v4/ai/video-model') {
            generationRequests.push(request)
            return new Response(
              'data: {"type":"result","videos":[{"type":"base64","data":"AAH/","mediaType":"video/mp4"}]}\n\n',
              {
                headers: { 'content-type': 'text/event-stream' },
              },
            )
          }
          if (request.method === 'PUT')
            uploaded.push([...new Uint8Array(await request.clone().arrayBuffer())])
          return (
            (await persistence(request)) ?? Response.json({ error: 'not_found' }, { status: 404 })
          )
        },
      }),
    )
    try {
      const result = await harness.callTool('generate_media', {
        workspace: 'mcp-raw',
        kind: 'video',
        model: 'new-provider/raw-video',
        prompt: 'moving logo',
        duration: 2,
        resolution: '640x360',
      })
      expect(result.isError).not.toBe(true)
      expect(result.content).toMatchObject([
        { type: 'resource_link', mimeType: 'video/mp4', size: 3 },
      ])
      expect(uploaded).toEqual([[0, 1, 255]])
      expect(generationRequests).toHaveLength(1)
      const request = generationRequests[0]!
      expect(request.headers.get('ai-model-id')).toBe('new-provider/raw-video')
      expect(request.headers.get('authorization')).toBe('Bearer duet_sk_raw')
      expect(request.headers.get('x-duet-workspace')).toBe('mcp-raw')
      expect(request.headers.get('x-duet-tier')).toBeNull()
      expect(await request.json()).toMatchObject({
        prompt: 'moving logo',
        duration: 2,
        resolution: '640x360',
      })
    } finally {
      await harness.close()
    }
  })

  test('generate_media dispatches raw and role language-image models and persists only their image bytes', async () => {
    const model = 'future-provider/image-chat'
    const requests: Request[] = []
    const uploaded: number[][] = []
    let withImage = true
    const persistence = createMediaPersistenceResponder('mcp-language-image')
    const harness = await mcpHarness(
      createMcpServer({
        apiBaseUrl: API_BASE_URL,
        modelGatewayBaseUrl: 'https://gateway.test',
        approvedModelCatalog: MEDIA_MODEL_CATALOG,
        bearerToken: 'duet_sk_language',
        fetch: async (input, init) => {
          const request = new Request(input, init)
          const path = new URL(request.url).pathname
          if (path === '/v1/whoami')
            return Response.json({ scopes: mediaScopes('mcp-language-image') })
          if (path === '/v1/models') {
            expect(request.headers.get('x-duet-workspace')).toBe('mcp-language-image')
            return Response.json({ data: [{ id: model, type: 'language' }] })
          }
          requests.push(request.clone())
          if (path === '/v4/ai/language-model') {
            return Response.json({
              content: [
                { type: 'text', text: 'An image' },
                ...(withImage
                  ? [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AAH/' } }]
                  : []),
              ],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
              warnings: [],
            })
          }
          if (request.method === 'PUT')
            uploaded.push([...new Uint8Array(await request.clone().arrayBuffer())])
          return (
            (await persistence(request)) ?? Response.json({ error: 'not_found' }, { status: 404 })
          )
        },
      }),
    )
    try {
      const input = { workspace: 'mcp-language-image', kind: 'image', model, prompt: 'draw a logo' }
      const result = await harness.callTool('generate_media', input)
      expect(result.isError).not.toBe(true)
      expect(result.content).toMatchObject([
        { type: 'resource_link', mimeType: 'image/png', size: 3 },
      ])
      expect(uploaded).toEqual([[0, 1, 255]])
      const generation = requests[0]!
      expect(new URL(generation.url).pathname).toBe('/v4/ai/language-model')
      expect(generation.headers.get('ai-language-model-id')).toBe(model)
      expect(generation.headers.get('authorization')).toBe('Bearer duet_sk_language')
      expect(generation.headers.get('x-duet-workspace')).toBe('mcp-language-image')
      expect(generation.headers.get('x-duet-tier')).toBeNull()
      expect(await generation.json()).toMatchObject({
        providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'] } },
      })
      const roleResult = await harness.callTool('generate_media', {
        ...input,
        model: 'fixture-language-image',
      })
      expect(roleResult.isError).not.toBe(true)
      expect(roleResult.content).toMatchObject([
        { type: 'resource_link', mimeType: 'image/png', size: 3 },
      ])
      expect(uploaded).toEqual([
        [0, 1, 255],
        [0, 1, 255],
      ])
      withImage = false
      requests.length = 0
      const empty = await harness.callTool('generate_media', input)
      expect(empty.isError).toBe(true)
      expect(empty.structuredContent).toMatchObject({ error: 'no_media_generated' })
      expect(requests.map(request => new URL(request.url).pathname)).toEqual([
        '/v4/ai/language-model',
      ])
    } finally {
      await harness.close()
    }
  })

  test('generate_media keeps raw image admission open when discovery metadata is absent or unavailable', async () => {
    const generatedIds: Array<string | null> = []
    const uploaded: number[][] = []
    let discoveryFails = false
    const persistence = createMediaPersistenceResponder('mcp-raw-image')
    const harness = await mcpHarness(
      createMcpServer({
        apiBaseUrl: API_BASE_URL,
        modelGatewayBaseUrl: 'https://gateway.test',
        bearerToken: 'duet_sk_image',
        approvedModelCatalog: MEDIA_MODEL_CATALOG,
        fetch: async (input, init) => {
          const request = new Request(input, init)
          const path = new URL(request.url).pathname
          if (path === '/v1/whoami') return Response.json({ scopes: mediaScopes('mcp-raw-image') })
          if (path === '/v1/models')
            return discoveryFails
              ? Response.json({ error: 'catalog_unavailable' }, { status: 503 })
              : Response.json({ data: [] })
          if (path === '/v4/ai/image-model') {
            generatedIds.push(request.headers.get('ai-model-id'))
            return Response.json({ images: ['AAH/'] })
          }
          if (request.method === 'PUT')
            uploaded.push([...new Uint8Array(await request.clone().arrayBuffer())])
          return (
            (await persistence(request)) ?? Response.json({ error: 'not_found' }, { status: 404 })
          )
        },
      }),
    )
    try {
      for (const unavailable of [false, true]) {
        discoveryFails = unavailable
        const result = await harness.callTool('generate_media', {
          workspace: 'mcp-raw-image',
          kind: 'image',
          model: 'new-provider/raw-image',
          prompt: 'draw a logo',
        })
        expect(result.isError).not.toBe(true)
        expect(result.content).toMatchObject([
          { type: 'resource_link', mimeType: 'image/png', size: 3 },
        ])
      }
      expect(generatedIds).toEqual(['new-provider/raw-image', 'new-provider/raw-image'])
      expect(uploaded).toEqual([
        [0, 1, 255],
        [0, 1, 255],
      ])
    } finally {
      await harness.close()
    }
  })

  test('generate_media resolves an explicit video role to the gateway slug', async () => {
    const calls: Array<{ path: string; aiModelId: string | null; body: string }> = []
    const persistence = createMediaPersistenceResponder('mcp-video')
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_gateway',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.pathname === '/v1/whoami') {
          return Response.json({ scopes: mediaScopes('mcp-video') })
        }
        if (url.pathname === '/v4/ai/video-model') {
          calls.push({
            path: url.pathname,
            aiModelId: request.headers.get('ai-model-id'),
            body: await request.text(),
          })
          return new Response(
            'data: {"type":"result","videos":[{"type":"base64","data":"dmlkZW8=","mediaType":"video/mp4"}]}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        const persistenceResponse = await persistence(request)
        if (persistenceResponse !== undefined) return persistenceResponse
        return Response.json({ error: 'not_found' }, { status: 404 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const media = await harness.callTool('generate_media', {
        workspace: 'mcp-video',
        kind: 'video',
        model: 'fixture-video',
        prompt: 'moving logo',
      })
      expect(media.isError).toBeFalsy()
      expect(media.content).toMatchObject([
        {
          type: 'resource_link',
          mimeType: 'video/mp4',
          size: 5,
        },
      ])
      expect(calls).toEqual([
        {
          path: '/v4/ai/video-model',
          aiModelId: 'fixture/video-explicit',
          body: '{"prompt":"moving logo","n":1,"providerOptions":{}}',
        },
      ])
    } finally {
      await harness.close()
    }
  })

  test('generate_media resolves each omitted model from the catalog role matching its kind', async () => {
    const gatewayModelIds: Array<string | null> = []
    const persistence = createMediaPersistenceResponder('mcp-defaults')
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_gateway',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const path = new URL(request.url).pathname
        if (path === '/v1/whoami') {
          return Response.json({ scopes: mediaScopes('mcp-defaults') })
        }
        if (path === '/v4/ai/image-model') {
          gatewayModelIds.push(request.headers.get('ai-model-id'))
          return Response.json({ images: ['aW1hZ2U='] })
        }
        if (path === '/v4/ai/video-model') {
          gatewayModelIds.push(request.headers.get('ai-model-id'))
          return new Response(
            'data: {"type":"result","videos":[{"type":"base64","data":"dmlkZW8=","mediaType":"video/mp4"}]}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        const persistenceResponse = await persistence(request)
        if (persistenceResponse !== undefined) return persistenceResponse
        return Response.json({ error: 'not_found' }, { status: 404 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      for (const kind of ['image', 'video'] as const) {
        const media = await harness.callTool('generate_media', {
          workspace: 'mcp-defaults',
          kind,
          prompt: `${kind} prompt`,
        })
        expect(media.isError).toBeFalsy()
      }
      expect(gatewayModelIds).toEqual(['fixture/image-default', 'fixture/video-default'])
    } finally {
      await harness.close()
    }
  })

  test('generate_media forwards unknown IDs for upstream rejection and rejects wrong-kind roles locally', async () => {
    const calls: string[] = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_gateway',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        calls.push(request.url)
        const path = new URL(request.url).pathname
        if (path === '/v1/whoami') return Response.json({ scopes: mediaScopes('mcp-validation') })
        if (path === '/v1/models') return Response.json({ data: [] })
        expect(request.headers.get('ai-model-id')).toBe('fixture-unknown')
        return Response.json({ error: 'provider_model_unknown' }, { status: 400 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const unknown = await harness.callTool('generate_media', {
        workspace: 'mcp-validation',
        kind: 'image',
        model: 'fixture-unknown',
        prompt: 'logo',
      })
      expect(unknown.isError).toBe(true)
      expect(JSON.parse(textContent(unknown))).toEqual({
        error: 'provider_model_unknown',
        status: 400,
        requiredScopes: [
          'ws:mcp-validation:services',
          'ws:mcp-validation:files:write',
          'ws:mcp-validation:files:read',
        ],
      })

      expect(calls).toEqual([
        `${API_BASE_URL}/v1/whoami`,
        'https://gateway.test/v1/models',
        'https://gateway.test/v4/ai/image-model',
      ])
      calls.length = 0

      const mismatch = await harness.callTool('generate_media', {
        workspace: 'mcp-validation',
        kind: 'image',
        model: 'fixture-video',
        prompt: 'logo',
      })
      expect(mismatch.isError).toBe(true)
      expect(JSON.parse(textContent(mismatch))).toEqual({
        error: 'unsupported_model',
        status: 500,
        requiredScopes: [
          'ws:mcp-validation:services',
          'ws:mcp-validation:files:write',
          'ws:mcp-validation:files:read',
        ],
        model: 'fixture-video',
        type: 'video',
      })
      expect(calls).toEqual([])
    } finally {
      await harness.close()
    }
  })

  test('generate_media accepts hidden catalog roles because hidden is presentation-only', async () => {
    const gatewayModelIds: Array<string | null> = []
    const persistence = createMediaPersistenceResponder('mcp-hidden')
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      approvedModelCatalog: MEDIA_MODEL_CATALOG,
      bearerToken: 'duet_sk_gateway',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        if (new URL(request.url).pathname === '/v1/whoami') {
          return Response.json({ scopes: mediaScopes('mcp-hidden') })
        }
        if (new URL(request.url).pathname === '/v4/ai/image-model') {
          gatewayModelIds.push(request.headers.get('ai-model-id'))
          return Response.json({ images: ['aGlkZGVu'] })
        }
        const persistenceResponse = await persistence(request)
        return persistenceResponse ?? Response.json({ error: 'not_found' }, { status: 404 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const media = await harness.callTool('generate_media', {
        workspace: 'mcp-hidden',
        kind: 'image',
        model: 'fixture-image-hidden',
        prompt: 'hidden role image',
      })
      expect(media.isError).toBeFalsy()
      expect(media.content).toMatchObject([
        {
          type: 'resource_link',
          mimeType: 'image/png',
          size: 6,
        },
      ])
      expect(gatewayModelIds).toEqual(['fixture/image-hidden'])
    } finally {
      await harness.close()
    }
  })

  test('generate_media rejects workspaces outside the bearer key scope before gateway calls', async () => {
    const calls: string[] = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      modelGatewayBaseUrl: 'https://gateway.test',
      bearerToken: 'duet_sk_gateway',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        calls.push(request.url)
        if (new URL(request.url).pathname === '/v1/whoami') {
          return Response.json({
            scopes: ['ws:mcp-s09:services'],
          })
        }
        return Response.json({ error: 'unexpected' }, { status: 500 })
      },
    })
    const harness = await mcpHarness(server)
    try {
      const media = await harness.callTool('generate_media', {
        workspace: 'other',
        kind: 'image',
        prompt: 'logo sketch',
      })
      expect(media.isError).toBe(true)
      expect(JSON.parse(textContent(media))).toEqual({
        error: 'insufficient_scope',
        status: 403,
        requiredScopes: ['ws:other:services', 'ws:other:files:write', 'ws:other:files:read'],
        missingScopes: ['ws:other:services', 'ws:other:files:write', 'ws:other:files:read'],
      })
      expect(calls).toEqual([`${API_BASE_URL}/v1/whoami`])
    } finally {
      await harness.close()
    }
  })

  test('file_history builds the REST query from its input and passes the page through unchanged', async () => {
    const apiCalls: string[] = []
    const page = {
      items: [
        {
          seq: 2,
          event: { kind: 'write', path: 'notes/plan.md', actor: 'session:ses1', at: 2_000 },
        },
      ],
      nextCursor: 'opaque-2',
    }
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_unused',
      fetch: async (input, init) => {
        apiCalls.push(new Request(input, init).url)
        return Response.json(page)
      },
    })
    const harness = await mcpHarness(server)
    try {
      const defaults = await harness.callTool('file_history', {
        workspace: 'demo',
        path: 'notes/plan.md',
      })
      expect(defaults.isError).not.toBe(true)
      expect(defaults.structuredContent).toEqual(page)

      const paged = await harness.callTool('file_history', {
        workspace: 'demo',
        path: 'notes/plan.md',
        cursor: 'opaque-2',
        limit: 50,
        includeReads: false,
      })
      expect(paged.isError).not.toBe(true)
      expect(apiCalls).toEqual([
        `${API_BASE_URL}/v1/ws/demo/file-activity?path=notes%2Fplan.md`,
        `${API_BASE_URL}/v1/ws/demo/file-activity?path=notes%2Fplan.md&cursor=opaque-2&limit=50&reads=0`,
      ])
    } finally {
      await harness.close()
    }
  })

  test('file_history and file_seen_by reject traversal paths before building a REST URL', async () => {
    const apiCalls: string[] = []
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_unused',
      fetch: async input => {
        apiCalls.push(String(input))
        return Response.json({})
      },
    })
    const harness = await mcpHarness(server)
    try {
      for (const tool of ['file_history', 'file_seen_by']) {
        const result = await harness.callTool(tool, { workspace: 'demo', path: '../anchors' })
        expect(result.isError).toBe(true)
        expect(textContent(result)).toContain('Input validation error')
      }
      expect(apiCalls).toEqual([])
    } finally {
      await harness.close()
    }
  })

  test('file_seen_by hits the seen-by route and surfaces insufficient scope as a tool error', async () => {
    const apiCalls: string[] = []
    const seenBy = {
      items: [
        {
          actor: 'web:user1',
          userId: 'user1',
          firstAt: 1_000,
          lastAt: 7_000,
          readCount: 1,
          writeCount: 1,
        },
      ],
      nextCursor: null,
    }
    const server = createMcpServer({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'duet_sk_unused',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        apiCalls.push(request.url)
        if (request.url.includes('/v1/ws/other/')) {
          return Response.json(
            { error: 'insufficient_scope', scope: 'ws:other:files:read' },
            { status: 403 },
          )
        }
        return Response.json(seenBy)
      },
    })
    const harness = await mcpHarness(server)
    try {
      const ok = await harness.callTool('file_seen_by', {
        workspace: 'demo',
        path: 'notes/plan.md',
        cursor: 'opaque page',
        limit: 2,
      })
      expect(ok.isError).not.toBe(true)
      expect(ok.structuredContent).toEqual(seenBy)

      const denied = await harness.callTool('file_seen_by', {
        workspace: 'other',
        path: 'notes/plan.md',
      })
      expect(denied.isError).toBe(true)
      expect(JSON.parse(textContent(denied))).toEqual({
        error: 'insufficient_scope',
        status: 403,
        requiredScopes: ['ws:other:files:read'],
        missingScopes: ['ws:other:files:read'],
      })
      expect(apiCalls).toEqual([
        `${API_BASE_URL}/v1/ws/demo/file-activity/seen-by?path=notes%2Fplan.md&cursor=opaque+page&limit=2`,
        `${API_BASE_URL}/v1/ws/other/file-activity/seen-by?path=notes%2Fplan.md`,
      ])
    } finally {
      await harness.close()
    }
  })
})

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0]
  expect(first?.type).toBe('text')
  expect(typeof first?.text).toBe('string')
  return first!.text!
}

function registeredToolNames(): string[] {
  return createMcpToolRegistry()
    .list()
    .map(tool => tool.name)
    .sort()
}

function mediaScopes(workspace: string): string[] {
  return [`ws:${workspace}:services`, `ws:${workspace}:files:write`, `ws:${workspace}:files:read`]
}

function createMediaPersistenceResponder(workspace: string) {
  const uploaded = new Map<string, { mimeType: string; size: number }>()
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url)
    if (url.pathname === `/v1/ws/${workspace}/file-uploads`) {
      return Response.json({
        vmBaseUrl: 'https://vm.test',
        uploadPath: '/v1/files/mcp/generated-media',
        uploadToken: 'upload-token',
        expiresAt: Date.now() + 60_000,
      })
    }
    if (url.origin === 'https://vm.test' && request.method === 'PUT') {
      const path = `mcp/generated-media/${decodeURIComponent(url.pathname.split('/').at(-1)!)}`
      uploaded.set(path, {
        mimeType: request.headers.get('content-type') ?? 'application/octet-stream',
        size: (await request.arrayBuffer()).byteLength,
      })
      return Response.json({ ok: true })
    }
    if (url.pathname === `/v1/ws/${workspace}/file-downloads`) {
      const { path } = (await request.json()) as { path: string }
      const file = uploaded.get(path)
      if (file === undefined) return Response.json({ error: 'not_found' }, { status: 404 })
      return Response.json({
        uri: `https://vm.test/v1/files/${path}?grant=download-token`,
        name: path,
        mimeType: file.mimeType,
        size: file.size,
      })
    }
    return undefined
  }
}
