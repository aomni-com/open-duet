import { describe, expect, spyOn, test } from 'bun:test'

import type { ConvexHttpClient } from 'convex/browser'
import { getFunctionName, type FunctionReference } from 'convex/server'

import {
  DUET_ACTOR_CONTEXT_HEADER,
  VmDesiredMarketplaceAgentsSchema,
  WORKSPACE_ARCHIVED_ERROR,
  WORKSPACE_UNHEALTHY_ERROR,
  tunnelTokenDigest,
} from '@repo/contract'
import type { FetchLike, GatewayAgentRosterResponse, GatewayAnchor } from '@repo/contract'

import { DEFAULT_GATEWAY_RESOLUTION_TTL_MS } from '../config'
import type { ApiContext } from '../shared'
import { GatewayClient, gatewayRefusalError, gatewayRefusalResponse } from './client'

describe('GatewayClient agent transport', () => {
  test('retains a consumed agent command connection refusal and resolves afresh on recovery', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    let resolutions = 0
    let failed = true
    const client = new GatewayClient({
      convex: {
        query: async () => {
          resolutions++
          return {
            workspaceId: 'workspace_1',
            vmName: 'vm',
            httpsUrl: 'https://vm.test',
            vmToken: 'secret-token',
          }
        },
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async () => {
        if (failed)
          throw new TypeError('fetch failed secret-token', {
            cause: Object.assign(new Error('private endpoint'), { code: 'ECONNREFUSED' }),
          })
        return Response.json({ cwd: '/work' })
      },
      now: () => 1_000,
    })
    const context = {
      json: (body: unknown, status?: number) => Response.json(body, { status }),
      req: { raw: new Request('https://api.test') },
    } as unknown as ApiContext
    const command = {
      path: '/v1/agent/sessions/session-1/cwd',
      method: 'POST' as const,
      body: '{}',
      failureOperation: 'session_cwd' as const,
    }
    try {
      const result = await client.callAgent(context, 'acme', command)
      if (!('response' in result)) throw new Error('expected failure')
      expect(result.response.status).toBe(502)
      expect(await result.response.json()).toEqual({ error: 'agent_gateway_unavailable' })
      expect(logged.mock.calls).toEqual([
        [
          '[agent-dispatch] transport failed',
          { operation: 'session_cwd', workspaceId: 'workspace_1', code: 'ECONNREFUSED' },
        ],
      ])
      failed = false
      expect(await client.callAgent(context, 'acme', command)).toEqual({
        ok: true,
        body: { cwd: '/work' },
      })
      expect(resolutions).toBe(2)
      expect(logged.mock.calls).toHaveLength(1)
    } finally {
      logged.mockRestore()
    }
  })

  test('returns a retryable response when a gateway agent command stalls', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    const requestSignals: AbortSignal[] = []
    const args = {
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.signal !== undefined && init.signal !== null) requestSignals.push(init.signal)
        return await new Promise<Response>(() => {})
      },
      now: () => 1_000,
      agentRequestTimeoutMs: 5,
    }
    const client = new GatewayClient(args)

    try {
      const result = await Promise.race([
        client.callAgent(
          {
            json: (body: unknown, status?: number) => Response.json(body, { status }),
            req: { raw: new Request('https://api.test') },
          } as unknown as ApiContext,
          'acme',
          {
            failureOperation: 'agent_delete',
            path: '/v1/agent/agents/agent-1/sessions',
            method: 'POST',
            body: '{}',
          },
        ),
        Bun.sleep(50).then(() => 'stalled' as const),
      ])

      expect(result).not.toBe('stalled')
      if (result === 'stalled') return
      expect('response' in result).toBe(true)
      if (!('response' in result)) throw new Error('expected retryable gateway response')
      expect(result.response.status).toBe(502)
      expect(await result.response.json()).toEqual({ error: 'agent_gateway_unavailable' })
      expect(requestSignals).toHaveLength(1)
      expect(requestSignals[0]?.aborted).toBe(true)
      expect(logged.mock.calls).toEqual([
        [
          '[agent-dispatch] transport failed',
          { operation: 'agent_delete', workspaceId: 'workspace_1', code: 'ETIMEDOUT' },
        ],
      ])
    } finally {
      logged.mockRestore()
    }
  })

  test('keeps cancellation, unknown failures and retry-rail dispatch quiet without duplicating HTTP failures', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    const controller = new AbortController()
    const context = {
      json: (body: unknown, status?: number) => Response.json(body, { status }),
      req: { raw: new Request('https://api.test', { signal: controller.signal }) },
    } as unknown as ApiContext
    const command = {
      path: '/v1/agent/sessions/session-1/cwd',
      method: 'POST' as const,
      body: '{}',
      failureOperation: 'session_cwd' as const,
    }
    try {
      for (const error of [
        new DOMException('private abort reason', 'AbortError'),
        Object.assign(new Error('private detail'), { code: 'SECRET_VALUE' }),
      ]) {
        const client = connectedProviderClient(async () => {
          throw error
        })
        const result = await client.callAgent(context, 'acme', command)
        if (!('response' in result)) throw new Error('expected failure')
        expect(await result.response.json()).toEqual({ error: 'agent_gateway_unavailable' })
      }
      const failed = connectedProviderClient(async () => {
        throw Object.assign(new Error('private'), { code: 'ECONNREFUSED' })
      })
      await failed.callAgent(context, 'acme', { ...command, failureOperation: undefined })
      controller.abort()
      await failed.callAgent(context, 'acme', command)
      expect(logged.mock.calls).toEqual([])
      const httpFailure = connectedProviderClient(async () =>
        Response.json({ error: 'agent_gateway_failed' }, { status: 500 }),
      )
      const result = await httpFailure.callAgent(context, 'acme', command)
      if (!('response' in result)) throw new Error('expected failure')
      expect(result.response.status).toBe(502)
      expect(logged.mock.calls).toEqual([
        ['[agent-dispatch] acme /v1/agent/sessions/session-1/cwd -> HTTP 500 agent_gateway_failed'],
      ])
    } finally {
      logged.mockRestore()
    }
  })

  test('a broken diagnostic sink does not replace the gateway failure response', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {
      throw new Error('sink unavailable')
    })
    const client = connectedProviderClient(async () => {
      throw Object.assign(new Error('private'), { code: 'ECONNRESET' })
    })
    try {
      const result = await client.callAgent(
        {
          json: (body: unknown, status?: number) => Response.json(body, { status }),
          req: { raw: new Request('https://api.test') },
        } as unknown as ApiContext,
        'acme',
        {
          path: '/v1/agent/agents/agent-1/sessions',
          method: 'DELETE',
          body: '{}',
          failureOperation: 'agent_delete',
        },
      )
      if (!('response' in result)) throw new Error('expected failure')
      expect(result.response.status).toBe(502)
      expect(await result.response.json()).toEqual({ error: 'agent_gateway_unavailable' })
    } finally {
      logged.mockRestore()
    }
  })

  test('discards a session without request context and validates the gateway receipt', async () => {
    let request: { url: string; method?: string; authorization: string | null } | undefined
    let resolutionArgs: unknown
    const client = new GatewayClient({
      convex: {
        query: async (_reference: unknown, args: unknown) => {
          resolutionArgs = args
          return {
            workspaceId: 'workspace_1',
            vmName: 'duet-acme',
            httpsUrl: 'https://duet-acme.example.test',
            vmToken: 'vm-token',
          }
        },
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        request = {
          url: String(input),
          method: init?.method,
          authorization: new Headers(init?.headers).get('authorization'),
        }
        return Response.json({ ok: true, discarded: false })
      },
      now: () => 1_000,
    })

    await expect(client.discardAgentSession('acme', 'session/1')).resolves.toEqual({
      ok: true,
      discarded: false,
    })
    expect(request).toEqual({
      url: 'https://duet-acme.example.test/v1/agent/sessions/session%2F1',
      method: 'DELETE',
      authorization: 'Bearer vm-token',
    })
    expect(resolutionArgs).toEqual({
      internalKey: 'internal-key',
      slug: 'acme',
      allowPaused: true,
    })
  })

  test('rejects a malformed session discard receipt', async () => {
    const client = connectedProviderClient(async () => Response.json({ ok: true }))

    await expect(client.discardAgentSession('acme', 'session-1')).resolves.toEqual({
      ok: false,
      error: 'invalid_response',
    })
  })

  test('keeps session discard transport failures and workspace HTTP refusals retryable', async () => {
    const transportFailure = connectedProviderClient(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(transportFailure.discardAgentSession('acme', 'session-1')).resolves.toEqual({
      ok: false,
      error: 'gateway_failed',
    })

    for (const status of [402, 404, 503]) {
      const refused = connectedProviderClient(async () => new Response(null, { status }))
      await expect(refused.discardAgentSession('acme', 'session-1')).resolves.toEqual({
        ok: false,
        error: 'gateway_failed',
      })
    }
  })

  test('falls back when gateway hint headers stall and keeps the VM bearer internal', async () => {
    let request: { authorization: string | null; signal: AbortSignal | null } | undefined
    const client = connectedProviderClient(async (_input, init) => {
      request = {
        authorization: new Headers(init?.headers).get('authorization'),
        signal: init?.signal ?? null,
      }
      return await new Promise<Response>(() => {})
    })

    await expect(
      client.openAgentSessionHints('acme', 'session-1', 4, new AbortController().signal, 5),
    ).resolves.toBeNull()
    expect(request?.authorization).toBe('Bearer vm-token')
    expect(request?.signal?.aborted).toBe(true)
  })

  test('detaches the header deadline after a healthy hint stream connects', async () => {
    const request: { signal: AbortSignal | null } = { signal: null }
    const client = connectedProviderClient(async (_input, init) => {
      request.signal = init?.signal ?? null
      return new Response(new ReadableStream<Uint8Array>())
    })

    const response = await client.openAgentSessionHints(
      'acme',
      'session-1',
      0,
      new AbortController().signal,
      5,
    )
    await Bun.sleep(10)
    expect(response?.status).toBe(200)
    expect(request.signal?.aborted).toBe(false)
    await response?.body?.cancel()
  })

  test('passes opted-in gateway statuses and bodies through unchanged', async () => {
    const client = connectedProviderClient(async () =>
      Response.json(
        { error: 'invalid_cwd', reason: 'outside_agent_anchor' },
        { status: 422, headers: { 'x-gateway-test': 'preserved' } },
      ),
    )

    const result = await client.callAgent({} as ApiContext, 'acme', {
      path: '/v1/agent/sessions/session-1/cwd',
      method: 'POST',
      body: JSON.stringify({ cwd: 'agents/other' }),
      passthroughStatuses: [422],
    })

    expect('response' in result).toBe(true)
    if (!('response' in result)) throw new Error('expected passthrough response')
    expect(result.response.status).toBe(422)
    expect(result.response.headers.get('x-gateway-test')).toBe('preserved')
    expect(await result.response.json()).toEqual({
      error: 'invalid_cwd',
      reason: 'outside_agent_anchor',
    })
  })

  test('waits for one authenticated session-event activity and closes the reader', async () => {
    let request:
      | { url: string; authorization: string | null; signal: AbortSignal | null }
      | undefined
    let cancelled = false
    const client = connectedProviderClient(async (input, init) => {
      request = {
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        signal: init?.signal ?? null,
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: step\ndata: {}\n\n'))
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 200 },
      )
    })
    const signal = new AbortController().signal

    await expect(client.waitForAgentSessionActivity('acme', 'session/1', 2, signal)).resolves.toBe(
      'activity',
    )
    expect(request).toEqual({
      url: 'https://duet-acme.example.test/v1/agent/sessions/session%2F1/events?since=2',
      authorization: 'Bearer vm-token',
      signal,
    })
    expect(cancelled).toBe(true)
  })
})

describe('GatewayClient connected-provider transport', () => {
  test('uses the existing VM bearer path for start, poll, list, and disconnect', async () => {
    const requests: Array<{
      url: string
      method?: string
      body?: unknown
      authorization: string | null
    }> = []
    const responses = [
      {
        sessionId: 'session-1',
        intervalMs: 1_000,
      },
      { status: 'pending' },
      [
        {
          provider: 'openai-codex',
          state: 'connected',
          connectedAt: 9_000,
        },
      ],
      { ok: true },
    ]
    const client = connectedProviderClient(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return Response.json(responses.shift())
    })

    await expect(client.startProviderConnect('acme', 'openai-codex')).resolves.toMatchObject({
      sessionId: 'session-1',
    })
    await expect(client.pollProviderConnect('acme', 'session-1')).resolves.toEqual({
      status: 'pending',
    })
    await expect(client.listConnectedProviders('acme')).resolves.toEqual([
      expect.objectContaining({ provider: 'openai-codex', state: 'connected' }),
    ])
    await expect(client.disconnectProvider('acme', 'openai-codex')).resolves.toEqual({ ok: true })

    expect(requests).toEqual([
      {
        url: 'https://duet-acme.example.test/v1/connected-providers/connect',
        method: 'POST',
        body: { provider: 'openai-codex' },
        authorization: 'Bearer vm-token',
      },
      {
        url: 'https://duet-acme.example.test/v1/connected-providers/connect/session-1',
        method: 'GET',
        body: undefined,
        authorization: 'Bearer vm-token',
      },
      {
        url: 'https://duet-acme.example.test/v1/connected-providers',
        method: 'GET',
        body: undefined,
        authorization: 'Bearer vm-token',
      },
      {
        url: 'https://duet-acme.example.test/v1/connected-providers/disconnect',
        method: 'POST',
        body: { provider: 'openai-codex' },
        authorization: 'Bearer vm-token',
      },
    ])
  })

  test('maps a sleeping or unreachable VM to workspace_vm_unavailable', async () => {
    const client = connectedProviderClient(async () => {
      throw new TypeError('fetch failed')
    })

    const result = await client.pollProviderConnect('acme', 'session-1')
    expect(result).toBeInstanceOf(Response)
    if (!(result instanceof Response)) throw new Error('expected unavailable response')
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: 'workspace_vm_unavailable' })
  })
})

function connectedProviderClient(fetchImpl: FetchLike): GatewayClient {
  return new GatewayClient({
    convex: {
      query: async () => ({
        workspaceId: 'workspace_1',
        vmName: 'duet-acme',
        httpsUrl: 'https://duet-acme.example.test',
        vmToken: 'vm-token',
      }),
    } as unknown as ConvexHttpClient,
    internalKey: 'internal-key',
    fetchImpl,
    now: () => 1_000,
  })
}

describe('GatewayClient skills transport', () => {
  test('carries the agent folder to the VM as a query and returns the listing', async () => {
    const requests: string[] = []
    const client = connectedProviderClient(async input => {
      requests.push(String(input))
      return Response.json({
        skills: [{ name: 'review', path: '/drive/.agents/skills/review', scope: 'project' }],
      })
    })

    const result = await client.listSkills('acme', 'agents/scout')

    expect(requests).toEqual(['https://duet-acme.example.test/v1/skills?cwd=agents%2Fscout'])
    expect(result).toEqual({
      skills: [{ name: 'review', path: '/drive/.agents/skills/review', scope: 'project' }],
    })
  })

  test('omits the query entirely when the session runs at the drive root', async () => {
    const requests: string[] = []
    const client = connectedProviderClient(async input => {
      requests.push(String(input))
      return Response.json({ skills: [] })
    })

    await client.listSkills('acme', undefined)

    expect(requests).toEqual(['https://duet-acme.example.test/v1/skills'])
  })

  test('maps a sleeping or unreachable VM to workspace_vm_unavailable', async () => {
    const client = connectedProviderClient(async () => {
      throw new TypeError('fetch failed')
    })

    const result = await client.listSkills('acme', undefined)
    expect(result).toBeInstanceOf(Response)
    if (!(result instanceof Response)) throw new Error('expected unavailable response')
    expect(result.status).toBe(503)
  })
})

describe('GatewayClient agent roster transport', () => {
  test('names whose roster to read by agent id, and omits the query for the drive root', async () => {
    const requests: string[] = []
    const roster: GatewayAgentRosterResponse = {
      rows: [
        {
          slug: 'writer',
          name: 'Writer',
          path: 'agents/writer',
          locked: false,
          relationship: 'self',
        },
        { slug: 'root', name: 'HQ', locked: false, relationship: 'parent' },
        {
          slug: 'drafter',
          name: 'Drafter',
          path: 'agents/writer/drafter',
          locked: true,
          relationship: 'child',
        },
      ],
    }
    const client = connectedProviderClient(async input => {
      requests.push(String(input))
      return Response.json(roster)
    })

    await expect(client.readAgentRoster('acme', 'agent/1')).resolves.toEqual(roster)
    await client.readAgentRoster('acme', undefined)

    expect(requests).toEqual([
      'https://duet-acme.example.test/v1/agents/roster?agentId=agent%2F1',
      'https://duet-acme.example.test/v1/agents/roster',
    ])
  })

  /* A body this reader cannot parse is not a roster, and half of one is worse
     than none: the picker would offer rows the agent cannot address. */
  test('an unreadable roster body is a 502, never a partial roster', async () => {
    const client = connectedProviderClient(async () =>
      Response.json({ rows: [{ slug: 'drafter', relationship: 'child' }] }),
    )

    const result = await client.readAgentRoster('acme', undefined)

    expect(result).toBeInstanceOf(Response)
    if (!(result instanceof Response)) throw new Error('expected an invalid-response')
    expect(result.status).toBe(502)
    expect(await result.json()).toEqual({ error: 'agent_roster_gateway_invalid_response' })
  })

  /* The gateway's own 503 (`roster_unavailable`) and a sleeping VM are the same
     answer to the picker — we could not ask — and both must stay distinct from
     an empty roster. */
  test('an unreachable VM answers 503 rather than an empty roster', async () => {
    const client = connectedProviderClient(async () => {
      throw new TypeError('fetch failed')
    })

    const result = await client.readAgentRoster('acme', undefined)

    expect(result).toBeInstanceOf(Response)
    if (!(result instanceof Response)) throw new Error('expected unavailable response')
    expect(result.status).toBe(503)
  })
})

describe('GatewayClient internal admin transport', () => {
  test('preserves filesystem query strings outside the gateway pathname', async () => {
    const requests: string[] = []
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async input => {
        requests.push(String(input))
        return Response.json({ ok: true })
      },
      now: () => 1_000,
    })

    await client.internalAdminRequest(
      {
        workspaceId: 'workspace_1',
        workspaceSlug: 'acme',
        vmName: 'duet-acme',
        httpsUrl: 'https://duet-acme.example.test',
        vmToken: 'vm-token',
      },
      '/files?path=projects%2Freport.md',
    )

    expect(requests).toEqual([
      'https://duet-acme.example.test/v1/internal-admin/files?path=projects%2Freport.md',
    ])
  })
})

describe('GatewayClient drive folder deletion', () => {
  // Firing an agent takes its folder with it, and an agent folder is never empty
  // — it holds at least a prompt, usually apps. A non-recursive delete would 409
  // on every real agent and leave the folder standing after the rows were gone.
  test('deletes an agent folder recursively with the VM bearer', async () => {
    let request: { url: string; headers: Headers; body: unknown } | undefined
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        request = {
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        }
        return Response.json({ ok: true })
      },
      now: () => 1_000,
    })

    expect(await client.deleteDriveFolder('acme', 'agents/fired')).toEqual({ ok: true })
    expect(request?.url).toBe('https://duet-acme.example.test/v1/files/actions')
    expect(request?.body).toEqual({ operation: 'delete', path: 'agents/fired', recursive: true })
    expect(request?.headers.get('authorization')).toBe('Bearer vm-token')
  })

  // The rows are already deleted by the time this runs, so a refusal is reported,
  // never thrown: turning it into a 502 would tell the caller the fired agent is
  // still there when it is not.
  test('reports the gateway refusal instead of throwing', async () => {
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async () => Response.json({ error: 'recursive_limit_exceeded' }, { status: 409 }),
      now: () => 1_000,
    })

    expect(await client.deleteDriveFolder('acme', 'agents/huge')).toEqual({
      ok: false,
      reason: 'recursive_limit_exceeded',
    })
  })
})

describe('GatewayClient anchor reconciliation', () => {
  test('pushes the complete typed VM projection with the VM bearer', async () => {
    const anchors: GatewayAnchor[] = [
      {
        id: 'anchor_1',
        agentId: 'agent_1',
        workspaceId: 'workspace_1',
        path: 'agents/reviewer',
        kind: 'share-mount',
        settings: {},
        state: 'active',
        createdAt: 1,
        updatedAt: 1,
        markerNonce: 'nonce_1',
      },
    ]
    let request: { url: string; headers: Headers; body: unknown } | undefined
    const client = new GatewayClient({
      convex: {
        query: async (reference: FunctionReference<'query'>) => {
          const name = getFunctionName(reference)
          if (name === 'domains/workspaces/provisioning:gatewayConnectionBySlug') {
            return {
              workspaceId: 'workspace_1',
              vmName: 'duet-acme',
              httpsUrl: 'https://duet-acme.example.test',
              vmToken: 'vm-token',
            }
          }
          if (name === 'domains/anchors/model:listForVm') return anchors
          throw new Error(`unexpected query: ${name}`)
        },
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        request = {
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        }
        return Response.json({ ok: true })
      },
      now: () => 1_000,
    })

    expect(await client.pushAnchorsReconcile('acme')).toEqual({ ok: true })
    expect(request).toEqual({
      url: 'https://duet-acme.example.test/v1/anchors/reconcile',
      headers: expect.any(Headers),
      body: { anchors },
    })
    expect(request?.headers.get('authorization')).toBe('Bearer vm-token')
  })
})

describe('GatewayClient marketplace agent pull', () => {
  test('sends the desired official-agent state and returns a typed 502 on failure', async () => {
    const desired = {
      subscriptions: [
        {
          subscriptionId: 'subscription-1',
          listingId: 'listing-1',
          sourceUrl: 'https://edge-staging.duet.so/hub/official-agents/research?zip',
          agentName: 'research',
          path: 'agents/research',
          anchorId: 'anchor-1',
          mode: 'subscribe' as const,
        },
      ],
    }
    const queries: Array<{ name: unknown; args: Record<string, unknown> }> = []
    const requests: Array<{
      url: string
      method: string | undefined
      authorization: string | null
      body: unknown
    }> = []
    const client = new GatewayClient({
      convex: {
        query: async (name: unknown, args: Record<string, unknown>) => {
          queries.push({ name, args })
          if (queries.length === 1) {
            return {
              workspaceId: 'workspace_1',
              vmName: 'duet-acme',
              httpsUrl: 'https://duet-acme.example.test',
              vmToken: 'vm-token',
            }
          }
          return desired
        },
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          authorization: new Headers(init?.headers).get('authorization'),
          body: JSON.parse(String(init?.body)),
        })
        // The real gateway validates every declared VmDesiredMarketplaceAgentsSchema field and
        // 400s on anything else; the fixture enforces the same contract.
        const parsed = VmDesiredMarketplaceAgentsSchema.safeParse(JSON.parse(String(init?.body)))
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })
        return Response.json({ error: 'offline' }, { status: 503 })
      },
      now: () => 1_000,
    })

    const result = await client.pushMarketplaceAgentsPull('acme')
    expect(requests).toEqual([
      {
        url: 'https://duet-acme.example.test/v1/marketplace/pull',
        method: 'POST',
        authorization: 'Bearer vm-token',
        body: desired,
      },
    ])
    expect(queries[1]?.args).toMatchObject({ internalKey: 'internal-key' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected pull failure')
    expect(result.response.status).toBe(502)
    expect(await result.response.json()).toEqual({ error: 'pull_failed' })
  })

  test('fails typed when no desired official-agent state exists', async () => {
    let calls = 0
    const client = new GatewayClient({
      convex: {
        query: async () => {
          calls += 1
          if (calls === 1) {
            return {
              workspaceId: 'workspace_1',
              vmName: 'duet-acme',
              httpsUrl: 'https://duet-acme.example.test',
              vmToken: 'vm-token',
            }
          }
          return null
        },
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async () => {
        throw new Error('gateway must not be called without desired state')
      },
      now: () => 1_000,
    })

    const result = await client.pushMarketplaceAgentsPull('acme')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected pull failure')
    expect(result.response.status).toBe(502)
  })
})

describe('GatewayClient official hub seed writes', () => {
  test('writes the deterministic tree through authenticated file PUTs', async () => {
    const requests: Array<{
      url: string
      method?: string
      authorization: string | null
      body: string
    }> = []
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          workspaceSlug: 'official-agents-hub',
          vmName: 'duet-official',
          httpsUrl: 'https://duet-official.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          authorization: new Headers(init?.headers).get('authorization'),
          body: await new Response(init?.body).text(),
        })
        return Response.json({
          written: ['agents/research/AGENTS.md'],
          unchanged: 1,
          deleted: ['agents/research/dropped.md'],
        })
      },
      now: () => 1_000,
    })

    expect(
      await client.convergeOfficialHub('official-agents-hub', {
        agents: [{ path: 'agents/research' }],
        files: [
          { path: 'agents/research/AGENTS.md', bytes: new TextEncoder().encode('# Research') },
          {
            path: 'agents/research/agent.json',
            bytes: new TextEncoder().encode('{"triggers":[]}'),
          },
        ],
      }),
    ).toEqual({
      ok: true,
      written: ['agents/research/AGENTS.md'],
      // The reap travels to the caller rather than being counted and dropped:
      // a rename shows up here as the paths it removed.
      deleted: ['agents/research/dropped.md'],
    })
    // ONE request for the whole tree, not one per file: the predecessor awaited
    // a PUT per file inside a single serverless request, making the roster size
    // a latent timeout.
    expect(requests).toEqual([
      {
        url: 'https://duet-official.example.test/v1/internal-admin/converge-subtree',
        method: 'POST',
        authorization: 'Bearer vm-token',
        body: JSON.stringify({
          roots: ['agents/research'],
          files: [
            { path: 'agents/research/AGENTS.md', base64: 'IyBSZXNlYXJjaA==' },
            { path: 'agents/research/agent.json', base64: 'eyJ0cmlnZ2VycyI6W119' },
          ],
        }),
      },
    ])
  })

  test('a refused converge carries the gateway status and words to the operator', async () => {
    // Without these, every failure looks identical in internal admin and the
    // operator goes to inspect a VM that is working fine — an oversized body,
    // a refused path, and a sleeping VM must not read the same.
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-official',
          httpsUrl: 'https://duet-official.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async () =>
        new Response('Request body exceeds the configured limit', { status: 413 }),
      now: () => 1_000,
    })

    const result = await client.convergeOfficialHub('official-agents-hub', {
      agents: [{ path: 'agents/research' }],
      files: [{ path: 'agents/research/AGENTS.md', bytes: new TextEncoder().encode('#') }],
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.response.status).toBe(502)
    expect(await result.response.json()).toEqual({
      error: 'hub_sync_failed',
      gatewayStatus: 413,
      detail: 'Request body exceeds the configured limit',
    })
  })
})

describe('GatewayClient train upload grant', () => {
  test('returns the portless VM URL and requests the upload token with the VM bearer', async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) })
        return Response.json({
          uploadPath: '/v1/train/uploads',
          uploadToken: 'upload-token',
          expiresAt: 901_000,
        })
      },
      now: () => 1_000,
    })

    expect(await client.createTrainUploadSession('acme')).toEqual({
      session: {
        // Portless: browsers traverse the set-public VM proxy; the gateway's
        // own auth (upload token) is the only browser credential.
        vmBaseUrl: 'https://duet-acme.example.test/',
        uploadPath: '/v1/train/uploads',
        uploadToken: 'upload-token',
        expiresAt: 901_000,
      },
    })
    expect(requests[0]!.url).toBe('https://duet-acme.example.test/v1/train/upload-token')
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer vm-token')
  })
})

describe('GatewayClient drive upload grant', () => {
  test('returns the browser handoff and mints a grant for the canonical landing prefix', async () => {
    const requests: Array<{ url: string; headers: Headers; body: string }> = []
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test/internal/path?ignored=1',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        })
        return Response.json({
          uploadPath: '/v1/files/agents/research/uploads',
          uploadToken: 'upload-token',
          expiresAt: 901_000,
        })
      },
      now: () => 1_000,
    })

    expect(
      await client.createDriveUploadGrant('acme', 'agents/research/uploads', {
        kind: 'api-key',
        keyId: 'key_123',
      }),
    ).toEqual({
      grant: {
        vmBaseUrl: 'https://duet-acme.example.test/',
        uploadPath: '/v1/files/agents/research/uploads',
        uploadToken: 'upload-token',
        expiresAt: 901_000,
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://duet-acme.example.test/v1/drive-grants')
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer vm-token')
    expect(requests[0]!.headers.get('content-type')).toBe('application/json')
    expect(requests[0]!.headers.get('x-duet-actor-context')).toBe('api-key:key_123')
    expect(JSON.parse(requests[0]!.body)).toEqual({
      kind: 'upload',
      pathPrefix: 'agents/research/uploads',
    })
  })

  // The files tab uploads into whatever folder is open, and the drive root is a
  // folder — an empty prefix has to survive the round trip rather than being
  // read as a missing one.
  test('mints a grant on the drive root', async () => {
    const bodies: unknown[] = []
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test/',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({
          uploadPath: '/v1/files',
          uploadToken: 'upload-token',
          expiresAt: 901_000,
        })
      },
      now: () => 1_000,
    })

    expect(
      await client.createDriveUploadGrant('acme', '', { kind: 'web', userId: 'user_1' }),
    ).toEqual({
      grant: {
        vmBaseUrl: 'https://duet-acme.example.test/',
        uploadPath: '/v1/files',
        uploadToken: 'upload-token',
        expiresAt: 901_000,
      },
    })
    expect(bodies).toEqual([{ kind: 'upload', pathPrefix: '' }])
  })

  test('preserves typed workspace lifecycle refusals without contacting the VM', async () => {
    const refusals = [
      { refusal: 'paused', status: 402, error: 'workspace_paused' },
      { refusal: 'provisioning', status: 409, error: 'workspace_provisioning' },
      { refusal: 'unhealthy', status: 503, error: 'workspace_unhealthy' },
      { refusal: 'archived', status: 410, error: 'workspace_archived' },
    ] as const

    for (const expected of refusals) {
      let gatewayCalls = 0
      const client = new GatewayClient({
        convex: {
          query: async () => ({ refusal: expected.refusal }),
        } as unknown as ConvexHttpClient,
        internalKey: 'internal-key',
        fetchImpl: async () => {
          gatewayCalls += 1
          return Response.json({ ok: true })
        },
        now: () => 1_000,
      })

      const result = await client.createDriveUploadGrant('acme', 'uploads', { kind: 'system' })
      expect('response' in result).toBe(true)
      if (!('response' in result)) throw new Error('expected workspace refusal')
      expect(result.response.status).toBe(expected.status)
      expect(await result.response.json()).toEqual({ error: expected.error })
      expect(gatewayCalls).toBe(0)
    }
  })
})

describe('GatewayClient file resource', () => {
  test('mints an exact read grant and derives the flat resource from a headerless HEAD', async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = []
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test/internal/path?ignored=1',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        })
        if (init?.method === 'POST') {
          return Response.json({
            downloadPath: '/v1/files/docs/report%20one.pdf?grant=opaque-token',
            expiresAt: 901_000,
          })
        }
        return new Response(null, {
          headers: {
            'content-type': 'application/pdf',
            'content-length': '13',
            etag: '"ignored-etag"',
          },
        })
      },
      now: () => 1_000,
    })

    await expect(
      client.createDriveFileResource('acme', 'docs/report one.pdf', {
        kind: 'api-key',
        keyId: 'key_123',
      }),
    ).resolves.toEqual({
      resource: {
        uri: 'https://duet-acme.example.test/v1/files/docs/report%20one.pdf?grant=opaque-token',
        name: 'docs/report one.pdf',
        mimeType: 'application/pdf',
        size: 13,
      },
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      url: 'https://duet-acme.example.test/v1/drive-grants',
      method: 'POST',
      body: { kind: 'download', path: 'docs/report one.pdf' },
    })
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer vm-token')
    expect(requests[0]!.headers.get(DUET_ACTOR_CONTEXT_HEADER)).toBe('api-key:key_123')
    expect(requests[1]).toMatchObject({
      url: 'https://duet-acme.example.test/v1/files/docs/report%20one.pdf?grant=opaque-token',
      method: 'HEAD',
    })
    expect([...requests[1]!.headers]).toEqual([])
  })

  test('returns a typed not-found response when the granted path has no file', async () => {
    let calls = 0
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async () => {
        calls += 1
        return calls === 1
          ? Response.json({
              downloadPath: '/v1/files/docs/missing.pdf?grant=opaque-token',
              expiresAt: 901_000,
            })
          : new Response(null, { status: 404 })
      },
      now: () => 1_000,
    })

    const result = await client.createDriveFileResource('acme', 'docs/missing.pdf', {
      kind: 'api-key',
      keyId: 'key_123',
    })
    expect('response' in result).toBe(true)
    if (!('response' in result)) throw new Error('expected a missing-file response')
    expect(result.response.status).toBe(404)
    expect(await result.response.json()).toEqual({ error: 'not_found' })
  })
})

describe('GatewayClient train URL upload', () => {
  test('preserves a quota-full 413 from the gateway PUT', async () => {
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async () => Response.json({ error: 'quota_exceeded' }, { status: 413 }),
      now: () => 1_000,
    })

    const result = await client.putTrainUpload('acme', 'url-example.md', '# Example')
    expect('response' in result).toBe(true)
    if (!('response' in result)) throw new Error('expected gateway response')
    expect(result.response.status).toBe(413)
    expect(await result.response.json()).toEqual({ error: 'quota_exceeded' })
  })
})

describe('GatewayClient mirror tunnel minting', () => {
  test('registers only a token digest through the mirror-owned gateway route', async () => {
    let registration: { url: string; body: Record<string, unknown> } | undefined
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        registration = {
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        }
        return Response.json({ ok: true })
      },
      now: () => 1_000,
    })

    const result = await client.mintMirrorTunnel('acme', 'machine_9')
    if ('error' in result) throw new Error(`unexpected mirror error: ${result.error}`)

    expect(registration?.url).toBe('https://duet-acme.example.test/v1/tunnel/mirror-accept')
    expect(registration?.body).toEqual({
      machineId: 'machine_9',
      acceptId: expect.stringMatching(/^mirror-machine_9-/),
      tokenDigest: await tunnelTokenDigest(result.tunnelToken),
      expiresAt: result.expiresAt,
    })
    expect(JSON.stringify(registration?.body)).not.toContain('tokenSecret')
    expect(JSON.stringify(registration?.body)).not.toContain(result.tunnelToken)
    expect(result.url).toMatch(
      /^wss:\/\/duet-acme\.example\.test\/v1\/tunnel\/accept\/mirror-machine_9-/,
    )
  })

  test('does not send mirror secrets to the removed legacy registration route', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        })
        return Response.json({ error: 'not_found' }, { status: 404 })
      },
      now: () => 1_000,
    })

    expect(await client.mintMirrorTunnel('acme', 'machine_9')).toEqual({ error: 'gateway_failed' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://duet-acme.example.test/v1/tunnel/mirror-accept')
    expect(JSON.stringify(requests[0]?.body)).not.toContain('tokenSecret')
  })
})

describe('GatewayClient proxy refusals', () => {
  test('files proxy binds collection cursors and preserves the gateway cursor refusal', async () => {
    let upstream: Request | undefined
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.example.test',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        upstream = new Request(input, init)
        return Response.json({ error: 'invalid_cursor' }, { status: 400 })
      },
      now: () => 1_000,
    })
    const request = new Request('https://api.example.test/v1/ws/acme/files?list=1')
    const context = {
      get: () => ({ scopes: ['ws:acme:files:read'] }),
      json: (body: unknown, jsonStatus?: number) => Response.json(body, { status: jsonStatus }),
      req: { method: 'GET', raw: request },
    } as unknown as ApiContext

    const response = await client.proxyRequest(context, {
      workspaceSlug: 'acme',
      requiredScope: 'ws:acme:files:read',
      url: httpsUrl => `${httpsUrl}/v1/files?list=1`,
      forwardedHeaders: [],
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_cursor' })
    expect(upstream?.headers.get('x-duet-collection-subject')).toBe('workspace_1')
    expect(upstream?.headers.get('authorization')).toBe('Bearer vm-token')
  })

  // The three resolution outcomes must stay distinguishable to a files-proxy
  // caller: a missing workspace is `not_found`, a real one whose gateway has
  // not registered is the retryable `workspace_provisioning`, and a paused
  // one is `workspace_paused`. Collapsing the middle case into 404 forced
  // clients to guess whether waiting could ever help. A caller that declared
  // the *path* optional changes none of this: only the gateway's own
  // missing-path answer is softened, never the workspace's.
  test.each([
    [null, 404, 'not_found'],
    [{ refusal: 'provisioning' }, 409, 'workspace_provisioning'],
    [{ refusal: 'unhealthy' }, 503, 'workspace_unhealthy'],
    [{ refusal: 'paused' }, 402, 'workspace_paused'],
  ] as const)('files proxy maps resolution %j to %i %s', async (resolution, status, error) => {
    const client = new GatewayClient({
      convex: { query: async () => resolution } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async () => {
        throw new Error('a refused resolution must never reach the gateway')
      },
      now: () => 1_000,
    })
    const request = new Request('https://api.example.test/v1/ws/acme/files?list=1')
    const context = {
      get: () => ({ scopes: ['ws:acme:files:read'] }),
      json: (body: unknown, jsonStatus?: number) => Response.json(body, { status: jsonStatus }),
      req: { method: 'GET', raw: request },
    } as unknown as ApiContext

    const response = await client.proxyRequest(context, {
      workspaceSlug: 'acme',
      requiredScope: 'ws:acme:files:read',
      url: httpsUrl => `${httpsUrl}/v1/files?list=1`,
      forwardedHeaders: [],
      optionalPath: true,
    })

    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
  })
})

describe('GatewayClient gateway resolution cache', () => {
  test('direct app pushes enrich public URLs using the configured edge host', async () => {
    let pushedBody: unknown
    const client = new GatewayClient({
      convex: {
        query: async (reference: FunctionReference<'query'>) => {
          if (
            getFunctionName(reference) === 'domains/workspaces/provisioning:gatewayConnectionBySlug'
          ) {
            return {
              workspaceId: 'workspace_1',
              vmName: 'duet-acme',
              httpsUrl: 'https://duet-acme.example.test',
              vmToken: 'vm-token',
            }
          }
          return [
            {
              appId: 'public-id',
              slug: 'status',
              command: 'bun run start',
              port: 4_173,
              anchorPath: 'apps/status',
              apiScopes: [],
              visibility: 'public',
            },
            {
              appId: 'private-id',
              slug: 'notes',
              command: 'bun run start',
              port: 4_174,
              anchorPath: 'apps/notes',
              apiScopes: [],
              visibility: 'folder',
            },
          ]
        },
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      edgeHost: 'edge-staging.duet.so',
      fetchImpl: async (_input, init) => {
        pushedBody = JSON.parse(String(init?.body))
        return Response.json({ ok: true })
      },
      now: () => 1_000,
    })

    expect(await client.pushAppsReconcile('acme', 'workspace_1')).toEqual({ ok: true })
    expect(pushedBody).toEqual({
      apps: [
        {
          appId: 'public-id',
          slug: 'status',
          command: 'bun run start',
          port: 4_173,
          anchorPath: 'apps/status',
          apiScopes: [],
          visibility: 'public',
          canonicalUrl: 'https://status--acme.edge-staging.duet.so/',
        },
        {
          appId: 'private-id',
          slug: 'notes',
          command: 'bun run start',
          port: 4_174,
          anchorPath: 'apps/notes',
          apiScopes: [],
          visibility: 'folder',
        },
      ],
    })
  })

  test('SUBS-IMPL-07 keeps servicing-pause propagation within 15 seconds', () => {
    expect(DEFAULT_GATEWAY_RESOLUTION_TTL_MS).toBeLessThanOrEqual(15_000)
  })

  function harness() {
    const state = {
      nowMs: 1_000,
      resolutions: 0,
      fetchStatus: 200,
      fetchError: null as Error | null,
    }
    const client = new GatewayClient({
      convex: {
        query: async (reference: FunctionReference<'query'>) => {
          if (
            getFunctionName(reference) === 'domains/workspaces/provisioning:gatewayConnectionBySlug'
          ) {
            state.resolutions += 1
            return {
              workspaceId: 'workspace_1',
              vmName: 'duet-acme',
              httpsUrl: 'https://duet-acme.example.test',
              vmToken: 'vm-token',
            }
          }
          return []
        },
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async () => {
        if (state.fetchError !== null) throw state.fetchError
        return Response.json({ ok: true }, { status: state.fetchStatus })
      },
      now: () => state.nowMs,
    })
    const push = () => client.pushAppsReconcile('acme', 'workspace_1')
    return { state, push }
  }

  test('a repeat request within the TTL reuses the cached resolution', async () => {
    const { state, push } = harness()
    expect(await push()).toEqual({ ok: true })
    state.nowMs += DEFAULT_GATEWAY_RESOLUTION_TTL_MS - 1
    expect(await push()).toEqual({ ok: true })
    expect(state.resolutions).toBe(1)
  })

  test('an entry past its TTL re-resolves', async () => {
    const { state, push } = harness()
    await push()
    state.nowMs += DEFAULT_GATEWAY_RESOLUTION_TTL_MS
    await push()
    expect(state.resolutions).toBe(2)
  })

  test('a paused refusal is not cached after the workspace resumes', async () => {
    let resolutions = 0
    const client = new GatewayClient({
      convex: {
        query: async (reference: FunctionReference<'query'>) => {
          if (
            getFunctionName(reference) !== 'domains/workspaces/provisioning:gatewayConnectionBySlug'
          ) {
            return []
          }
          resolutions += 1
          if (resolutions === 1) return { refusal: 'paused' }
          return {
            workspaceId: 'workspace_1',
            workspaceSlug: 'acme',
            vmName: 'duet-acme',
            httpsUrl: 'https://duet-acme.example.test',
            vmToken: 'vm-token',
          }
        },
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async () => Response.json({ ok: true }),
      now: () => 1_000,
    })

    const paused = await client.pushAppsReconcile('acme', 'workspace_1')
    expect(paused).toMatchObject({ ok: false, response: { status: 402 } })
    expect(await client.pushAppsReconcile('acme', 'workspace_1')).toEqual({ ok: true })
    expect(resolutions).toBe(2)
  })

  test('a gateway 5xx invalidates the cached resolution', async () => {
    const { state, push } = harness()
    await push()
    state.fetchStatus = 502
    expect(await push()).toMatchObject({ ok: false })
    expect(state.resolutions).toBe(1) // the failing request itself was a cache hit
    state.fetchStatus = 200
    await push()
    expect(state.resolutions).toBe(2) // 5xx dropped the entry
  })

  test('a gateway connection failure invalidates the cached resolution', async () => {
    const { state, push } = harness()
    await push()
    state.fetchError = new Error('connect ECONNREFUSED')
    await expect(push()).rejects.toThrow('ECONNREFUSED')
    state.fetchError = null
    await push()
    expect(state.resolutions).toBe(2)
  })

  test('a gateway 4xx keeps the cached resolution', async () => {
    const { state, push } = harness()
    await push()
    state.fetchStatus = 409
    expect(await push()).toMatchObject({ ok: false })
    state.fetchStatus = 200
    await push()
    expect(state.resolutions).toBe(1)
  })
})

test('an archived workspace is gone, not provisioning', () => {
  // Archiving reclaims a dormant workspace's VM; the row survives and can be
  // recommissioned by an explicit action. So "wait and retry" is false (waiting
  // never revives it) and "no such workspace" is false too (it exists). It
  // answers 410 — the code this API already uses for a thing that existed and
  // is now gone.
  expect(gatewayRefusalError({ refusal: 'archived' })).toBe(WORKSPACE_ARCHIVED_ERROR)
  const response = gatewayRefusalResponse({ refusal: 'archived' })
  expect(response.status).toBe(410)
})

test('an unhealthy workspace has a typed defensive refusal', () => {
  expect(gatewayRefusalError({ refusal: 'unhealthy' })).toBe(WORKSPACE_UNHEALTHY_ERROR)
  expect(gatewayRefusalResponse({ refusal: 'unhealthy' }).status).toBe(503)
  expect(gatewayRefusalResponse({ refusal: 'unknown-runtime-value' } as never).status).toBe(502)
})

test('backup control reaches an unhealthy VM without caching it for ordinary file traffic', async () => {
  const requests: Array<{ url: string; method?: string; authorization: string | null }> = []
  let currentToken = 'vm-token-one'
  const client = new GatewayClient({
    convex: {
      query: async (ref: FunctionReference<'query'>) => {
        if (getFunctionName(ref) === 'domains/workspaces/provisioning:gatewayConnectionForBackup')
          return {
            workspaceId: 'workspace-1',
            workspaceSlug: 'acme',
            vmName: 'vm',
            httpsUrl: 'https://vm.test',
            vmToken: currentToken,
          }
        return { refusal: 'unhealthy' }
      },
    } as unknown as ConvexHttpClient,
    internalKey: 'internal',
    now: () => 1_000,
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return Response.json({ accepted: true }, { status: 202 })
    },
  })
  expect((await client.backupCommand('acme', 'backup-1', 'attempt-1', 'start')).status).toBe(202)
  currentToken = 'vm-token-two'
  expect((await client.backupCommand('acme', 'backup-1', 'attempt-1', 'cancel')).status).toBe(202)
  const context = {
    get: () => ({ scopes: ['ws:acme:files:read'] }),
    json: (body: unknown, status?: number) => Response.json(body, { status }),
    req: { method: 'GET', raw: new Request('https://api.test/v1/ws/acme/files') },
  } as unknown as ApiContext
  const response = await client.proxyRequest(context, {
    workspaceSlug: 'acme',
    requiredScope: 'ws:acme:files:read',
    url: httpsUrl => `${httpsUrl}/v1/files`,
    forwardedHeaders: [],
  })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'workspace_unhealthy' })
  expect(requests).toEqual([
    {
      url: 'https://vm.test/v1/backups/backup-1/start',
      method: 'POST',
      authorization: 'Bearer vm-token-one',
    },
    {
      url: 'https://vm.test/v1/backups/backup-1',
      method: 'DELETE',
      authorization: 'Bearer vm-token-two',
    },
  ])
})
