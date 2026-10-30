import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import type { RegisterAgentResponse } from '@repo/contract'
import type { OfficialSeedAgent } from '@repo/official-agents-seed'

import { loadOfficialAgentsIntoWorkspace } from './official-agent-workspace.ts'

interface RequestRecord {
  method: string
  pathname: string
  body: Uint8Array
}

const servers: Bun.Server<unknown>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe('official-agent workspace loader', () => {
  test('uploads the selected agent files through the workspace files API', async () => {
    const requests: RequestRecord[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const body = new Uint8Array(await request.arrayBuffer())
        requests.push({ method: request.method, pathname: url.pathname, body })
        if (request.method === 'PUT') {
          return Response.json({ ok: true, etag: 'etag', size: body.byteLength })
        }
        return Response.json(registerResponse('api-agent', []), { status: 201 })
      },
    })
    servers.push(server)
    const agent: OfficialSeedAgent = {
      slug: 'source-agent',
      name: 'Source Agent',
      path: 'agents/source agent',
    }
    const first = new TextEncoder().encode('first bytes')
    const second = new Uint8Array([0, 1, 2, 255])

    await loadOfficialAgentsIntoWorkspace({
      apiUrl: server.url.toString(),
      workspaceSlug: 'workspace one',
      token: 'workspace-token',
      seedFiles: [
        { path: 'agents/source agent/AGENTS.md', bytes: first },
        { path: 'agents/source agent/assets/raw.bin', bytes: second },
        { path: 'agents/another/AGENTS.md', bytes: new Uint8Array([9]) },
      ],
      agents: [agent],
      reset: false,
    })

    expect(
      requests
        .filter(request => request.method === 'PUT')
        .map(request => ({ pathname: request.pathname, body: [...request.body] }))
        .sort((left, right) => left.pathname.localeCompare(right.pathname)),
    ).toEqual([
      {
        pathname: '/v1/ws/workspace%20one/files/agents/source%20agent/AGENTS.md',
        body: [...first],
      },
      {
        pathname: '/v1/ws/workspace%20one/files/agents/source%20agent/assets/raw.bin',
        body: [...second],
      },
    ])
  })

  test('finishes each selected agent before starting the next registration', async () => {
    const order: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method === 'PUT') {
          order.push(`upload:${decodeURIComponent(url.pathname.split('/').at(-2)!)}`)
          const body = await request.arrayBuffer()
          return Response.json({ ok: true, etag: 'etag', size: body.byteLength })
        }
        const declaration = (await request.json()) as { slug: string }
        order.push(`register:${declaration.slug}`)
        return Response.json(registerResponse(declaration.slug, []), { status: 201 })
      },
    })
    servers.push(server)
    const agents: OfficialSeedAgent[] = [
      { slug: 'alpha', name: 'Alpha', path: 'agents/alpha' },
      { slug: 'beta', name: 'Beta', path: 'agents/beta' },
    ]

    await loadOfficialAgentsIntoWorkspace({
      apiUrl: server.url.toString(),
      workspaceSlug: 'workspace',
      token: 'token',
      seedFiles: agents.map(agent => ({
        path: `${agent.path}/AGENTS.md`,
        bytes: new TextEncoder().encode(agent.name),
      })),
      agents,
      reset: false,
    })

    expect(order).toEqual(['upload:alpha', 'register:alpha', 'upload:beta', 'register:beta'])
  })

  test('registers every app declaration owned by the selected manifest agent', async () => {
    const seo: OfficialSeedAgent = {
      slug: 'fixture-agent',
      name: 'Fixture Agent',
      path: 'agents/fixture-agent',
      apps: ['board', 'setup'].map(slug => ({
        slug,
        path: `agents/fixture-agent/apps/${slug}`,
        command: 'bun run server.ts',
        apiScopes: [],
      })),
    }
    let registration: unknown
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === 'PUT') {
          const body = await request.arrayBuffer()
          return Response.json({ ok: true, etag: 'etag', size: body.byteLength })
        }
        registration = await request.json()
        return Response.json(
          registerResponse(
            'seo-from-api',
            (seo.apps ?? []).map(app => ({ slug: app.slug, path: app.path })),
          ),
          { status: 201 },
        )
      },
    })
    servers.push(server)

    await loadOfficialAgentsIntoWorkspace({
      apiUrl: server.url.toString(),
      workspaceSlug: 'workspace',
      token: 'token',
      seedFiles: [{ path: `${seo.path}/AGENTS.md`, bytes: new Uint8Array([1]) }],
      agents: [seo],
      reset: false,
    })

    expect(registration).toEqual({
      path: seo.path,
      slug: seo.slug,
      name: seo.name,
      apps: seo.apps,
    })
  })

  test('returns the API-authoritative agent and app identities with source context', async () => {
    const sourceAgent: OfficialSeedAgent = {
      slug: 'requested',
      name: 'Requested',
      path: 'agents/requested',
      apps: [
        {
          path: 'agents/requested/apps/board',
          slug: 'board',
          command: 'bun run server.ts',
          apiScopes: [],
        },
      ],
    }
    const authoritative = registerResponse('requested-2', [
      { slug: 'board-3', path: 'agents/requested/apps/board' },
    ])
    authoritative.apps[0]!.status = 'updated'
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === 'PUT') {
          const body = await request.arrayBuffer()
          return Response.json({ ok: true, etag: 'etag', size: body.byteLength })
        }
        return Response.json(authoritative, { status: 201 })
      },
    })
    servers.push(server)

    const results = await loadOfficialAgentsIntoWorkspace({
      apiUrl: server.url.toString(),
      workspaceSlug: 'workspace',
      token: 'token',
      seedFiles: [{ path: 'agents/requested/AGENTS.md', bytes: new TextEncoder().encode('agent') }],
      agents: [sourceAgent],
      reset: false,
    })

    expect(results).toEqual([
      { sourceAgent, reset: 'kept', fileCount: 1, registered: authoritative },
    ])
  })

  test('reports a missing reset target as fresh before uploading', async () => {
    const methods: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        methods.push(request.method)
        if (request.method === 'GET') return new Response('missing', { status: 404 })
        if (request.method === 'PUT') {
          const body = await request.arrayBuffer()
          return Response.json({ ok: true, etag: 'etag', size: body.byteLength })
        }
        return Response.json(registerResponse('agent', []), { status: 201 })
      },
    })
    servers.push(server)

    const [result] = await loadOfficialAgentsIntoWorkspace({
      apiUrl: server.url.toString(),
      workspaceSlug: 'workspace',
      token: 'token',
      seedFiles: [{ path: 'agents/agent/AGENTS.md', bytes: new Uint8Array([1]) }],
      agents: [{ slug: 'agent', name: 'Agent', path: 'agents/agent' }],
      reset: true,
    })

    expect({ reset: result?.reset, methods }).toEqual({
      reset: 'fresh',
      methods: ['GET', 'PUT', 'POST'],
    })
  })

  test('splits an oversized recursive reset into child deletes and retries the root', async () => {
    const deleteRequests: unknown[] = []
    let rootDeleteAttempts = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method === 'GET') {
          return Response.json({
            items: [
              {
                name: 'cache',
                path: 'agents/agent/cache',
                type: 'directory',
                size: 0,
                mtime: '2026-01-01T00:00:00.000Z',
              },
              {
                name: 'notes.md',
                path: 'agents/agent/notes.md',
                type: 'file',
                size: 1,
                mtime: '2026-01-01T00:00:00.000Z',
              },
            ],
            nextCursor: null,
          })
        }
        if (request.method === 'PUT') {
          const body = await request.arrayBuffer()
          return Response.json({ ok: true, etag: 'etag', size: body.byteLength })
        }
        if (url.pathname.endsWith('/files/actions')) {
          const operation = (await request.json()) as {
            operation: string
            path: string
            recursive: boolean
          }
          deleteRequests.push(operation)
          if (operation.path === 'agents/agent' && ++rootDeleteAttempts === 1) {
            return Response.json({ error: 'recursive_limit_exceeded' }, { status: 409 })
          }
          return Response.json({ ok: true })
        }
        return Response.json(registerResponse('agent', []), { status: 201 })
      },
    })
    servers.push(server)

    const [result] = await loadOfficialAgentsIntoWorkspace({
      apiUrl: server.url.toString(),
      workspaceSlug: 'workspace',
      token: 'token',
      seedFiles: [{ path: 'agents/agent/AGENTS.md', bytes: new Uint8Array([1]) }],
      agents: [{ slug: 'agent', name: 'Agent', path: 'agents/agent' }],
      reset: true,
    })

    expect({ reset: result?.reset, deleteRequests }).toEqual({
      reset: 'reset',
      deleteRequests: [
        { operation: 'delete', path: 'agents/agent', recursive: true },
        { operation: 'delete', path: 'agents/agent/cache', recursive: true },
        { operation: 'delete', path: 'agents/agent/notes.md', recursive: false },
        { operation: 'delete', path: 'agents/agent', recursive: true },
      ],
    })
  })

  test('does not register an agent after one of its file uploads fails', async () => {
    let registrations = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method === 'PUT') {
          if (url.pathname.endsWith('/broken.md')) {
            return Response.json({ error: 'write_failed' }, { status: 500 })
          }
          const body = await request.arrayBuffer()
          return Response.json({ ok: true, etag: 'etag', size: body.byteLength })
        }
        registrations += 1
        return Response.json(registerResponse('agent', []), { status: 201 })
      },
    })
    servers.push(server)

    let message = ''
    try {
      await loadOfficialAgentsIntoWorkspace({
        apiUrl: server.url.toString(),
        workspaceSlug: 'workspace',
        token: 'token',
        seedFiles: [
          { path: 'agents/agent/AGENTS.md', bytes: new Uint8Array([1]) },
          { path: 'agents/agent/broken.md', bytes: new Uint8Array([2]) },
        ],
        agents: [{ slug: 'agent', name: 'Agent', path: 'agents/agent' }],
        reset: false,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect({ registrations, message }).toEqual({
      registrations: 0,
      message: expect.stringContaining('PUT'),
    })
  })

  test('waits for uploaded bytes before registering the whole selected tree', async () => {
    const files = Array.from({ length: 9 }, (_, index) => ({
      path: `agents/agent/file-${index}.md`,
      bytes: new Uint8Array([index]),
    }))
    const uploaded: Array<{ path: string; bytes: number[] }> = []
    let releaseUploads!: () => void
    const uploadsReleased = new Promise<void>(resolve => {
      releaseUploads = resolve
    })
    const fetchEdge = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const request = new Request(input, init)
          if (request.method !== 'PUT') {
            return Response.json(registerResponse('agent', []), { status: 201 })
          }
          const bytes = new Uint8Array(await request.arrayBuffer())
          uploaded.push({ path: new URL(request.url).pathname, bytes: [...bytes] })
          await uploadsReleased
          return Response.json({ ok: true, etag: 'etag', size: bytes.byteLength })
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    let loading: Promise<unknown> | undefined
    try {
      loading = loadOfficialAgentsIntoWorkspace({
        apiUrl: 'https://fixture.invalid',
        workspaceSlug: 'workspace',
        token: 'token',
        seedFiles: files,
        agents: [{ slug: 'agent', name: 'Agent', path: 'agents/agent' }],
        reset: false,
      })
      // Block the external response rather than guessing a completion delay.
      // Worker count is private tuning; registration must wait for all writes.
      expect(fetchEdge.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
      expect(fetchEdge.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
      releaseUploads()
      await loading
      expect(fetchEdge.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
      expect(uploaded.sort((left, right) => left.path.localeCompare(right.path))).toEqual(
        files.map(file => ({
          path: `/v1/ws/workspace/files/${file.path}`,
          bytes: [...file.bytes],
        })),
      )
    } finally {
      releaseUploads()
      await loading?.catch(() => undefined)
      fetchEdge.mockRestore()
    }
  })
})

function registerResponse(
  slug: string,
  apps: Array<{ slug: string; path: string }>,
): RegisterAgentResponse {
  return {
    agent: {
      id: `agent-${slug}`,
      workspaceId: 'workspace-id',
      anchorId: `anchor-${slug}`,
      anchorPath: `agents/${slug}`,
      anchorState: 'active',
      slug,
      name: slug,
      createdAt: 1,
      updatedAt: 1,
    },
    apps: apps.map(app => ({ ...app, status: 'created' as const })),
  }
}
