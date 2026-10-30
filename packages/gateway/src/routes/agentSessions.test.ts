import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'

import { createAgentSessionLedger, type GatewaySessionEnvelope } from '../agent-sessions/ledger'
import { DEFAULT_TURN_STARTED_TIMEOUT_MS, type AgentRunner } from '../runner/process-runner'
import type { LiveFrame, SessionEventSubscription } from '../runner/session-event-buffer'
import { createAgentSessionsRoutes, streamAgentEvents } from './agentSessions'

test('a stalled SSE reader pulls only the bounded stream window from its subscription', async () => {
  const frames = Array.from({ length: 20 }, (_, index) => sessionFrame(index + 1))
  let nextCalls = 0
  const iterator: AsyncIterator<LiveFrame> = {
    next() {
      nextCalls += 1
      const value = frames.shift()
      return Promise.resolve(
        value === undefined ? { done: true, value: undefined } : { done: false, value },
      )
    },
  }
  const subscription: SessionEventSubscription = {
    [Symbol.asyncIterator]() {
      return iterator
    },
    close() {},
  }

  const stream = streamAgentEvents(new Request('https://gateway.test/events'), subscription)
  await new Promise(resolve => setTimeout(resolve, 10))

  expect(nextCalls).toBeLessThanOrEqual(2)
  await stream.cancel()
})

// The API opens this stream the moment a turn is submitted — before the runner
// has spawned, so the subscription has nothing to say for seconds. A stream
// whose first byte is its first event holds the response headers back for
// that whole spawn; the API's hint connect gives up after 2s and the session
// falls back to 15s polling for the rest of the turn. The first byte must
// leave before the first event exists.
test('an SSE stream on a silent subscription emits a byte immediately', async () => {
  const subscription: SessionEventSubscription = {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<LiveFrame>>(() => {}) }
    },
    close() {},
  }

  const reader = streamAgentEvents(
    new Request('https://gateway.test/events'),
    subscription,
  ).getReader()
  const first = await Promise.race([
    reader.read().then(chunk => new TextDecoder().decode(chunk.value)),
    new Promise<string>(resolve => setTimeout(() => resolve('nothing within 500ms'), 500)),
  ])

  expect(first).toMatch(/^:[^\n]*\n\n$/)
  await reader.cancel()
})

// Two separate claims, kept separate because the first surprised the second.
//
// 1. Bun's idleTimeout (255s in production, packages/gateway/src/runtime/
//    http.ts) DOES kill a handler that never touches the request body before
//    a slow await — confirmed directly below with a synthetic route. That is
//    a real, general risk for any long-held unary handler.
// 2. The actual `/input` route does NOT hit this today: it reads and parses
//    the body (`await readJson(c.req.raw)`) before the slow `deliverInput`
//    call, and — confirmed directly, not assumed — Bun/Hono do not enforce
//    idleTimeout against a connection whose request body has already been
//    fully read, no matter how long the handler takes afterward. So this
//    route was not actually the source of any "socket closed unexpectedly"
//    failure observed in staging; that mechanism doesn't apply here.
//
// `extendTimeout` (wired to Bun's per-request `server.timeout()`) is kept
// anyway, as hardening rather than a proven fix: it turns an implicit,
// version-fragile protection ("we happen to read the body first") into an
// explicit one that survives a refactor of this route or a Bun/Hono version
// that changes the incidental behavior. The second test below proves the
// route actually calls it, with the right number, before the slow work
// starts — which is the property that matters regardless of which mechanism
// is protecting production today.
describe('Bun idleTimeout and a slow unary handler', () => {
  test('an unread-body request killed by idleTimeout survives once extendTimeout calls server.timeout()', async () => {
    const app = new Hono()
    let extend: ((request: Request, seconds: number) => void) | undefined
    app.post('/slow', async c => {
      extend?.(c.req.raw, 20)
      await new Promise(resolve => setTimeout(resolve, 6_000))
      return c.json({ ok: true })
    })
    const server = Bun.serve({ port: 0, idleTimeout: 3, fetch: request => app.fetch(request) })
    extend = (request, seconds) => server.timeout(request, seconds)

    try {
      const response = await fetch(`http://localhost:${server.port}/slow`, { method: 'POST' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
    } finally {
      server.stop(true)
    }
  }, 60_000)

  test('the same handler is killed without extendTimeout, proving the risk is real', async () => {
    const app = new Hono()
    app.post('/slow', async c => {
      // The sleep must exceed the idle window by a wide margin: Bun enforces
      // idleTimeout on a coarse timer, and under full-gate machine load the
      // kill can land seconds late — a 2x margin flaked while 3x+ has not.
      await new Promise(resolve => setTimeout(resolve, 10_000))
      return c.json({ ok: true })
    })
    const server = Bun.serve({ port: 0, idleTimeout: 3, fetch: request => app.fetch(request) })

    try {
      await expect(
        fetch(`http://localhost:${server.port}/slow`, { method: 'POST' }),
      ).rejects.toThrow()
    } finally {
      server.stop(true)
    }
  }, 60_000)
})

describe('the /input route calls extendTimeout before the slow work, unconditionally', () => {
  test('extendTimeout fires with a budget derived from the runner start timeout, before deliverInput resolves', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-extend-'))
    const driveDir = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-extend-drive-'))
    const calls: Array<{ seconds: number }> = []
    let deliverInputResolved = false

    const { routes } = createAgentSessionsRoutes({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      getVmToken: async () => null,
      // A runner whose start() never settles: if extendTimeout is called
      // AFTER deliverInput rather than before, this test would hang instead
      // of asserting anything, which is itself a signal something's wrong.
      runnerFactory: () => neverStartingRunner(),
      extendTimeout: (_request, seconds) => {
        calls.push({ seconds })
      },
    })

    void Promise.resolve(
      routes.request('/sessions/sess_1/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          attemptId: 'sess_1:1',
          throughSeq: 1,
          input: { kind: 'prompt', message: 'go', behavior: 'steer' },
          launch: { tier: 'balanced' },
        }),
      }),
    ).then(() => {
      deliverInputResolved = true
    })

    // Give deliverInput's internals a turn to run without ever resolving it —
    // proves ordering (extendTimeout before the wait), not just that it was
    // eventually called at some point.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(deliverInputResolved).toBe(false)
    expect(calls).toHaveLength(1)
    // Derived, not restated: this must track DEFAULT_TURN_STARTED_TIMEOUT_MS
    // (+30s headroom) automatically, because that constant has already been
    // raised three times and a hardcoded copy here would go stale on the next
    // one. What's pinned is the RELATIONSHIP — the idle budget always clears
    // the runner's own start ceiling — not a particular number.
    expect(calls[0]!.seconds).toBe(Math.ceil((DEFAULT_TURN_STARTED_TIMEOUT_MS + 30_000) / 1000))
  })
})

// The runner reaches its integrations server here. What the warmer already
// established is answered without a byte to ctl; anything it did not — a tool
// call, the standalone stream — crosses with the transport headers and ctl's
// credential for the session, never the runner's own request headers.
test('the local integrations server answers the handshake and forwards the rest', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-integrations-'))
  const driveDir = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-integrations-drive-'))
  const forwarded: Request[] = []
  const { routes } = createAgentSessionsRoutes({
    stateDir,
    driveDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    getVmToken: async () => null,
    integrationsMcp: {
      answer: async (sessionId, body) => {
        const message = JSON.parse(body) as { id?: number; method: string }
        return sessionId === 'sess_1' && message.method === 'initialize'
          ? Response.json({ jsonrpc: '2.0', id: message.id, result: { held: true } })
          : null
      },
      upstream: sessionId => ({
        url: `https://ctl.test/v1/ws/acme/agent/sessions/${sessionId}/integrations/mcp`,
        headers: { authorization: 'Bearer ctl-key' },
      }),
      fetch: async (input, init) => {
        forwarded.push(new Request(input, init))
        return Response.json({ jsonrpc: '2.0', id: 2, result: { forwarded: true } })
      },
    },
  })
  try {
    const post = (body: unknown) =>
      routes.request('/sessions/sess_1/integrations/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-sees-this',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
          'x-unrelated': 'no',
        },
        body: JSON.stringify(body),
      })

    const held = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(await held.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { held: true } })
    expect(forwarded).toHaveLength(0)

    const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } })
    expect(await call.json()).toEqual({ jsonrpc: '2.0', id: 2, result: { forwarded: true } })
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]!.url).toBe(
      'https://ctl.test/v1/ws/acme/agent/sessions/sess_1/integrations/mcp',
    )
    expect(forwarded[0]!.headers.get('authorization')).toBe('Bearer ctl-key')
    expect(forwarded[0]!.headers.get('mcp-protocol-version')).toBe('2025-03-26')
    expect(forwarded[0]!.headers.get('x-unrelated')).toBeNull()
    expect(await forwarded[0]!.text()).toBe(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } }),
    )
  } finally {
    await rm(stateDir, { recursive: true, force: true })
    await rm(driveDir, { recursive: true, force: true })
  }
})

test('session input uses the acceptance flow', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-capable-input-'))
  const driveDir = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-capable-input-drive-'))
  const ledger = createAgentSessionLedger({ stateDir, now: () => 1 })
  await ledger.write({
    version: 1,
    sessionId: 'sess_capable',
    launch: { tier: 'balanced' },
    acceptedThroughSeq: 1,
    inFlightCommands: [],
    relayOutbox: [],
    updatedAt: 1,
  })
  const { routes } = createAgentSessionsRoutes({
    stateDir,
    driveDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    getVmToken: async () => null,
  })
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      attemptId: 'sess_capable:1',
      throughSeq: 1,
      input: { kind: 'prompt', message: 'go', behavior: 'steer' },
      launch: { tier: 'balanced' },
    }),
  }

  const existing = await routes.request('/sessions/sess_capable/input', request)

  expect(existing.status).toBe(200)
  expect(await existing.json()).toEqual({ acceptedThroughSeq: 1, disposition: 'duplicate' })
})

// A discarded session's envelope is gone for good — nothing can ever be
// settled into it. That has to read as distinctly different from a runner
// that's merely unavailable right now, or a caller retries forever.
test('input to a discarded session answers 410, not the generic runner_unavailable', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-discarded-'))
  const driveDir = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-discarded-drive-'))
  const { routes, controller } = createAgentSessionsRoutes({
    stateDir,
    driveDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    getVmToken: async () => null,
  })
  await controller.discard('sess_gone')

  const response = await routes.request('/sessions/sess_gone/input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      attemptId: 'sess_gone:1',
      throughSeq: 1,
      input: { kind: 'prompt', message: 'go', behavior: 'steer' },
      launch: { tier: 'balanced' },
    }),
  })

  expect(response.status).toBe(410)
  expect(await response.json()).toEqual({ error: 'session_discarded' })
})

// The backend's durable session row owns agent binding. Anchor reconciliation
// can make that binding launchable, but cwd must never reconstruct identity.
describe('an onboarding input racing anchor reconciliation', () => {
  test('waits for the matching anchor, then derives binding from cwd', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-onboarding-race-'))
    const driveDir = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-onboarding-race-drive-'))
    await mkdir(join(driveDir, 'agents', 'scout'), { recursive: true })
    type KnownAnchors = ReturnType<
      NonNullable<Parameters<typeof createAgentSessionsRoutes>[0]['anchors']>
    >
    let anchors: KnownAnchors = []

    const { routes } = createAgentSessionsRoutes({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      getVmToken: async () => null,
      anchors: () => anchors,
      runnerFactory: () => neverStartingRunner(),
    })
    const inputRequest = () =>
      routes.request('/sessions/sess_onboarding_race/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          attemptId: 'sess_onboarding_race:1',
          throughSeq: 1,
          input: { kind: 'prompt', message: 'Begin onboarding.', behavior: 'steer' },
          launch: { tier: 'balanced', cwd: 'agents/scout', onboarding: true },
        }),
      })

    // The anchor has not reconciled yet: refuse retryably, and leave NO
    // envelope behind — a pinned root envelope would keep the wrong identity
    // for the session's whole life even after the anchor arrives.
    const refused = await inputRequest()
    expect(refused.status).toBe(503)
    const ledger = createAgentSessionLedger({ stateDir, now: () => 1 })
    expect(await ledger.read('sess_onboarding_race')).toBeNull()

    // The anchor lands; the same durable cwd now resolves the agent context.
    anchors = [
      {
        id: 'anchor_scout',
        agentId: 'agent_scout',
        workspaceId: 'workspace_1',
        path: 'agents/scout',
        kind: 'agent',
        settings: {},
        state: 'active',
        createdAt: 1,
        updatedAt: 1,
        markerNonce: 'nonce-scout',
      },
    ]
    void inputRequest()
    const deadline = Date.now() + 5_000
    let envelope = await ledger.read('sess_onboarding_race')
    while (envelope === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      envelope = await ledger.read('sess_onboarding_race')
    }
    expect(envelope?.agentAnchorId).toBe('anchor_scout')
    expect(envelope?.launch.onboarding).toBe(true)
  })
})

describe('POST /sessions/:sessionId/cwd', () => {
  test('accepts a valid directory and returns its canonical cwd receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-cwd-'))
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    await mkdir(join(driveDir, 'two'), { recursive: true })
    await createAgentSessionLedger({ stateDir, now: () => 1 }).write(cwdEnvelope('sess_cwd_valid'))
    const { routes } = createAgentSessionsRoutes({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      getVmToken: async () => null,
    })

    const response = await routes.request('/sessions/sess_cwd_valid/cwd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'one/../two' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ cwd: 'two' })
  })

  test('rejects a missing path, regular file, and symlink escape with exact reasons', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-cwd-invalid-'))
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const outsideDir = join(root, 'outside')
    await mkdir(driveDir, { recursive: true })
    await mkdir(outsideDir)
    await writeFile(join(driveDir, 'file.txt'), 'not a directory')
    await symlink(outsideDir, join(driveDir, 'escape'))
    await createAgentSessionLedger({ stateDir, now: () => 1 }).write(
      cwdEnvelope('sess_cwd_invalid'),
    )
    const { routes } = createAgentSessionsRoutes({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      getVmToken: async () => null,
    })

    for (const [cwd, reason] of [
      ['missing', 'missing'],
      ['file.txt', 'not_a_directory'],
      ['escape', 'outside_drive'],
    ] as const) {
      const response = await routes.request('/sessions/sess_cwd_invalid/cwd', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd }),
      })
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({ error: 'invalid_cwd', reason })
    }
  })

  test('confines a bound session to its anchor while a root session can move across the drive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-cwd-scope-'))
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    await mkdir(join(driveDir, 'agents', 'reviewer', 'inside'), { recursive: true })
    await mkdir(join(driveDir, 'elsewhere'), { recursive: true })
    const ledger = createAgentSessionLedger({ stateDir, now: () => 1 })
    await ledger.write(cwdEnvelope('sess_cwd_bound', { agentAnchorId: 'anchor_reviewer' }))
    await ledger.write(cwdEnvelope('sess_cwd_root'))
    const { routes } = createAgentSessionsRoutes({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => [
        {
          id: 'anchor_reviewer',
          agentId: 'agent_reviewer',
          workspaceId: 'workspace_1',
          path: 'agents/reviewer',
          kind: 'agent',
          settings: {},
          state: 'active',
          createdAt: 1,
          updatedAt: 1,
          markerNonce: 'nonce-reviewer',
        },
      ],
      getVmToken: async () => null,
    })

    const bound = await routes.request('/sessions/sess_cwd_bound/cwd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'elsewhere' }),
    })
    expect(bound.status).toBe(422)
    expect(await bound.json()).toEqual({
      error: 'invalid_cwd',
      reason: 'outside_agent_anchor',
    })

    const unbound = await routes.request('/sessions/sess_cwd_root/cwd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'elsewhere' }),
    })
    expect(unbound.status).toBe(200)
    expect(await unbound.json()).toEqual({ cwd: 'elsewhere' })
  })

  test('returns not_found without creating an envelope for an unknown session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-agent-sessions-cwd-missing-'))
    const driveDir = join(root, 'drive')
    await mkdir(join(driveDir, 'somewhere'), { recursive: true })
    const { routes } = createAgentSessionsRoutes({
      stateDir: join(root, '.duet'),
      driveDir,
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
    })

    const response = await routes.request('/sessions/unknown/cwd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'somewhere' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
  })
})

function cwdEnvelope(
  sessionId: string,
  overrides: Partial<GatewaySessionEnvelope> = {},
): GatewaySessionEnvelope {
  return {
    version: 1,
    sessionId,
    launch: { cwd: 'before', tier: 'balanced' },
    acceptedThroughSeq: 0,
    inFlightCommands: [],
    relayOutbox: [],
    updatedAt: 1,
    ...overrides,
  }
}

function neverStartingRunner(): AgentRunner {
  return {
    async start() {},
    async send() {
      await new Promise(() => undefined)
    },
    async waitForTurnStarted(): Promise<never> {
      return await new Promise(() => undefined)
    },
    onEvent: () => () => undefined,
    onExit: () => () => undefined,
    isAlive: () => true,
    getPid: () => null,
    getStderr: () => '',
    kill: () => undefined,
  }
}

function sessionFrame(seq: number): LiveFrame {
  return {
    seq,
    event: { type: 'system', level: 'info', message: `event-${seq}` },
  }
}
