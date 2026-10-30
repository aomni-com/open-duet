import { describe, expect, spyOn, test } from 'bun:test'

import { CAPABILITIES, ProtectedResourceMetadataSchema } from '@repo/contract'

import { createMcpHttpApp } from './index'

const API_BASE_URL = 'https://ctl.test'
const MCP_PUBLIC_URL = 'https://mcp.test/'
const EXPECTED_SCOPE = [...CAPABILITIES].sort().join(' ')

describe('MCP HTTP resource server', () => {
  test('serves the protected MCP transport only at the canonical root', async () => {
    const app = createMcpHttpApp({
      apiBaseUrl: API_BASE_URL,
      mcpPublicUrl: MCP_PUBLIC_URL,
    })

    const root = await app.request('/', { method: 'POST' })
    expect(root.status).toBe(401)

    const retiredPath = await app.request('/mcp', { method: 'POST' })
    expect(retiredPath.status).toBe(404)
    expect(retiredPath.headers.get('location')).toBeNull()
  })

  test('completes MCP initialization at root', async () => {
    const app = createMcpHttpApp({
      apiBaseUrl: API_BASE_URL,
      mcpPublicUrl: MCP_PUBLIC_URL,
      fetch: async () => Response.json(whoami('user')),
    })
    const response = await app.request('/', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer duet_sk_pasted',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'slice-11-test', version: '1' },
        },
      }),
    })

    expect(response.status).toBe(200)
    const event = await response.text()
    const data = event.match(/^data: (.+)$/m)?.[1]
    expect(data).toBeDefined()
    expect(JSON.parse(data!)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'duet-mcp' } },
    })
  })

  test('reports a lost whoami connection cause safely and accepts the next request', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {})
    let fail = true
    const app = createMcpHttpApp({
      apiBaseUrl: API_BASE_URL,
      mcpPublicUrl: MCP_PUBLIC_URL,
      fetch: async () => {
        if (fail) {
          throw new TypeError('fetch failed with Bearer secret', {
            cause: Object.assign(new Error('https://private.test/?token=secret'), {
              code: 'ECONNREFUSED',
            }),
          })
        }
        return Response.json(whoami('user'))
      },
    })
    const request = () =>
      app.request('/', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        }),
      })
    try {
      const failure = await request()
      expect(failure.status).toBe(503)
      expect(await failure.json()).toEqual({ error: 'auth_unavailable' })
      expect(log.mock.calls).toEqual([['[mcp] whoami transport failure', { code: 'ECONNREFUSED' }]])
      fail = false
      const success = await request()
      expect(success.status).toBe(200)
      expect(await success.text()).toContain('duet-mcp')
      expect(log.mock.calls).toHaveLength(1)
    } finally {
      log.mockRestore()
    }
  })

  test('keeps rejected credentials, upstream failures, and caller cancellation quiet', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const scenario of ['unauthorized', 'upstream', 'abort', 'aborted-request']) {
        const controller = new AbortController()
        const app = createMcpHttpApp({
          apiBaseUrl: API_BASE_URL,
          fetch: async () => {
            if (scenario === 'abort') throw new DOMException('cancelled', 'AbortError')
            if (scenario === 'aborted-request') {
              controller.abort()
              throw new Error('cancelled with private reason')
            }
            return Response.json({}, { status: scenario === 'unauthorized' ? 401 : 503 })
          },
        })
        const response = await app.request('/', {
          method: 'POST',
          headers: { authorization: 'Bearer secret' },
          signal: controller.signal,
        })
        expect(response.status).toBe(
          scenario === 'unauthorized' ? 401 : scenario === 'upstream' ? 502 : 503,
        )
        expect(await response.json()).toEqual({
          error: scenario === 'unauthorized' ? 'unauthorized' : 'auth_unavailable',
        })
      }
      expect(log.mock.calls).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  test('reports timeouts but never copies arbitrary error fields', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const error of [
        new TypeError('secret', {
          cause: Object.assign(new Error('secret'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
        }),
        Object.assign(new Error('secret'), {
          code: 'secret',
          name: 'secret',
          url: 'https://secret',
        }),
      ]) {
        const app = createMcpHttpApp({
          apiBaseUrl: API_BASE_URL,
          fetch: async () => {
            throw error
          },
        })
        const response = await app.request('/', {
          method: 'POST',
          headers: { authorization: 'Bearer secret' },
        })
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: 'auth_unavailable' })
      }
      expect(log.mock.calls).toEqual([
        ['[mcp] whoami transport failure', { code: 'UND_ERR_CONNECT_TIMEOUT' }],
      ])
    } finally {
      log.mockRestore()
    }
  })

  test('retains the unavailable response if diagnostics fail', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {
      throw new Error('sink unavailable')
    })
    try {
      const app = createMcpHttpApp({
        apiBaseUrl: API_BASE_URL,
        fetch: async () => {
          throw Object.assign(new Error('connection failed'), { code: 'ECONNREFUSED' })
        },
      })
      const response = await app.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'auth_unavailable' })
    } finally {
      log.mockRestore()
    }
  })

  test('publishes RFC 9728 metadata for the canonical MCP resource', async () => {
    const app = createMcpHttpApp({
      apiBaseUrl: API_BASE_URL,
      mcpPublicUrl: MCP_PUBLIC_URL,
    })

    const response = await app.request('/.well-known/oauth-protected-resource')
    expect(response.status).toBe(200)
    expect(ProtectedResourceMetadataSchema.parse(await response.json())).toEqual({
      resource: MCP_PUBLIC_URL,
      authorization_servers: [API_BASE_URL],
      scopes_supported: [...CAPABILITIES].sort(),
      bearer_methods_supported: ['header'],
    })
  })

  test('challenges missing, expired, and revoked bearer credentials with parseable metadata', async () => {
    const app = createMcpHttpApp({
      apiBaseUrl: API_BASE_URL,
      mcpPublicUrl: MCP_PUBLIC_URL,
      fetch: async () => Response.json({ error: 'unauthorized' }, { status: 401 }),
    })

    for (const token of [undefined, 'duet_sk_expired', 'duet_sk_revoked']) {
      const response = await app.request('/', {
        method: 'POST',
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(401)
      expect(parseBearerChallenge(response.headers.get('www-authenticate'))).toEqual({
        resource_metadata: `${MCP_PUBLIC_URL}.well-known/oauth-protected-resource`,
        scope: EXPECTED_SCOPE,
      })
    }
  })

  test('rejects OAuth credentials whose audience is missing or belongs to another environment', async () => {
    const credentials = new Map([
      ['prod', whoami('oauth', 'https://mcp.duet.so/')],
      ['staging', whoami('oauth', 'https://mcp-staging.duet.so/')],
      ['missing', whoami('oauth')],
    ])
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? ''
      return Response.json(credentials.get(token))
    }

    for (const [mcpPublicUrl, token] of [
      ['https://mcp.duet.so/', 'staging'],
      ['https://mcp.duet.so/', 'missing'],
      ['https://mcp-staging.duet.so/', 'prod'],
    ] as const) {
      const app = createMcpHttpApp({ apiBaseUrl: API_BASE_URL, mcpPublicUrl, fetch })
      const response = await app.request('/', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).not.toBeNull()
    }
    const productionApp = createMcpHttpApp({
      apiBaseUrl: API_BASE_URL,
      mcpPublicUrl: 'https://mcp.duet.so/',
      fetch,
    })
    const accepted = await productionApp.request('/', {
      method: 'POST',
      headers: {
        authorization: 'Bearer prod',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'audience-test', version: '1' },
        },
      }),
    })
    expect(accepted.status).toBe(200)
    const data = (await accepted.text()).match(/^data: (.+)$/m)?.[1]
    expect(JSON.parse(data!)).toMatchObject({ result: { serverInfo: { name: 'duet-mcp' } } })
  })

  test('accepts a pasted user key, forwards its bearer unchanged, and never logs it', async () => {
    const bearer = 'duet_sk_pasted_secret'
    const authHeaders: Array<string | null> = []
    const logs = [
      spyOn(console, 'log').mockImplementation(() => {}),
      spyOn(console, 'warn').mockImplementation(() => {}),
      spyOn(console, 'error').mockImplementation(() => {}),
    ]
    try {
      const app = createMcpHttpApp({
        apiBaseUrl: API_BASE_URL,
        mcpPublicUrl: MCP_PUBLIC_URL,
        fetch: async (input, init) => {
          const request = new Request(input, init)
          authHeaders.push(request.headers.get('authorization'))
          if (new URL(request.url).pathname === '/v1/whoami') {
            return Response.json({
              ...whoami('user'),
              scopes: ['ws:demo:files:read'],
            })
          }
          if (new URL(request.url).pathname === '/v1/ws/demo/file-downloads') {
            return Response.json({
              uri: 'https://vm.test/v1/files/hello.txt?grant=opaque',
              name: 'hello.txt',
              mimeType: 'text/plain; charset=utf-8',
              size: 15,
            })
          }
          return new Response('hello from duet')
        },
      })

      const response = await app.request('/', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'read_file',
            arguments: { workspace: 'demo', path: 'hello.txt' },
          },
        }),
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toContain('hello from duet')
      expect(authHeaders.length).toBeGreaterThan(0)
      expect(new Set(authHeaders)).toEqual(new Set([`Bearer ${bearer}`]))
      for (const log of logs) expect(log).not.toHaveBeenCalled()
    } finally {
      for (const log of logs) log.mockRestore()
    }
  })
})

function parseBearerChallenge(value: string | null): Record<string, string> {
  if (value === null || !value.startsWith('Bearer ')) throw new Error('missing Bearer challenge')
  const parameters: Record<string, string> = {}
  const source = value.slice('Bearer '.length)
  const matches = source.matchAll(/(?:^|, )([a-z_]+)="([^"]*)"/g)
  for (const match of matches) parameters[match[1]!] = match[2]!
  if (Object.keys(parameters).length === 0) throw new Error('invalid Bearer challenge')
  return parameters
}

function whoami(kind: 'oauth' | 'user', audience?: string) {
  return {
    user: { id: 'user_1', email: 'user@example.com' },
    workspaces: [],
    scopes: [],
    versions: { api: 1 as const },
    internalAdmin: false,
    credential: { kind, ...(audience === undefined ? {} : { audience }) },
  }
}
