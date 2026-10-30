import { expect, test } from 'bun:test'

import {
  CONNECT_STATUS_FRESH_MS,
  ConnectCommandError,
  ConnectOperationConflictError,
  createConnectSessionManager,
  type ConnectCommandChild,
  type ConnectCommandRunner,
} from './connect-session'

test('returns a pollable session before the CLI emits a device code', async () => {
  const invocations: string[][] = []
  const live = controllableCommand()
  const runCommand: ConnectCommandRunner = argv => {
    invocations.push([...argv])
    return live.child
  }
  const manager = createConnectSessionManager({ runCommand, now: () => 10_000 })

  const started = await manager.start('openai-codex')

  expect(invocations).toEqual([['duet', 'connect', 'chatgpt', '--device-code', '--json']])
  expect(started).toEqual({
    sessionId: expect.any(String),
    intervalMs: 1_000,
  })
  expect(await manager.poll(started.sessionId)).toEqual({ status: 'pending' })
  live.write({
    ...deviceCode('openai-codex'),
    expiresAt: 20_000,
    additiveField: 'future-safe',
  })
  expect(await eventuallyPollAwaitingCode(manager, started.sessionId)).toEqual({
    status: 'awaiting_code',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://example.test/device',
    expiresAt: 20_000,
  })
  live.write({ type: 'progress', provider: 'openai-codex', code: 'probing_capability' })
  live.write({ type: 'complete', provider: 'openai-codex', state: 'connected' })
  expect(await eventuallyPoll(manager, started.sessionId)).toEqual({
    status: 'connected',
    connection: {
      provider: 'openai-codex',
      state: 'connected',
      connectedAt: 10_000,
      eligibilityCheckedAt: 10_000,
    },
  })
  live.finish(0)
})

test('maps denied and expired CLI errors to stable failed states', async () => {
  for (const [code, reason] of [
    ['login_denied', 'denied'],
    ['login_expired', 'expired'],
  ] as const) {
    const manager = createConnectSessionManager({
      runCommand: () =>
        command(
          [deviceCode('github-copilot'), { type: 'error', provider: 'github-copilot', code }],
          1,
        ),
      now: () => 10_000,
    })
    const started = await manager.start('github-copilot')

    expect(await eventuallyPoll(manager, started.sessionId)).toEqual({ status: 'failed', reason })
  }
})

test('maps a plan-ineligible completion to the contract failure state', async () => {
  const manager = createConnectSessionManager({
    runCommand: () =>
      command([
        deviceCode('github-copilot'),
        { type: 'complete', provider: 'github-copilot', state: 'plan_ineligible' },
      ]),
  })

  const started = await manager.start('github-copilot')

  expect(await eventuallyPoll(manager, started.sessionId)).toEqual({
    status: 'failed',
    reason: 'plan_ineligible',
    provider: 'github-copilot',
  })
})

test('ignores malformed and oversized lines and accepts the next exact CLI event', async () => {
  const valid = `${JSON.stringify(deviceCode('openai-codex'))}\n${JSON.stringify({
    type: 'complete',
    provider: 'openai-codex',
    state: 'connected',
  })}\n`
  const manager = createConnectSessionManager({
    runCommand: () => rawCommand([`not json\n`, `${'x'.repeat(70_000)}\n`, valid]),
    now: () => 42,
  })

  const started = await manager.start('openai-codex')

  expect(await eventuallyPoll(manager, started.sessionId)).toEqual({
    status: 'connected',
    connection: {
      provider: 'openai-codex',
      state: 'connected',
      connectedAt: 42,
      eligibilityCheckedAt: 42,
    },
  })
})

test('turns a child crash into a fixed non-secret failure', async () => {
  const secret = 'sk-proj-THIS-MUST-NEVER-LEAK'
  const manager = createConnectSessionManager({
    runCommand: () =>
      rawCommand([`${JSON.stringify(deviceCode('openai-codex'))}\n`, `${secret}\n`], 9, secret),
  })
  const started = await manager.start('openai-codex')

  const result = await eventuallyPoll(manager, started.sessionId)

  expect(result).toEqual({ status: 'failed', reason: 'error' })
  expect(JSON.stringify(result)).not.toContain(secret)
})

test('rejects a synchronous command spawn failure without reporting child output', async () => {
  const secret = 'gho_THIS_MUST_NEVER_LEAK'
  const manager = createConnectSessionManager({
    runCommand: () => {
      throw new Error(secret)
    },
  })

  const error = await manager.start('github-copilot').catch(error => error as Error)
  expect(error).toBeInstanceOf(ConnectCommandError)
  if (!(error instanceof Error)) throw new Error('expected connect command error')
  expect(error.message).not.toContain(secret)
})

test('disconnect cancels an in-flight connect before running the provider disconnect', async () => {
  const invocations: string[][] = []
  const live = controllableCommand()
  const manager = createConnectSessionManager({
    runCommand: argv => {
      invocations.push([...argv])
      if (invocations.length === 1) return live.child
      return command([{ type: 'complete', provider: 'openai-codex', state: 'disconnected' }])
    },
  })
  live.write(deviceCode('openai-codex'))
  const started = await manager.start('openai-codex')

  await manager.disconnect('openai-codex')

  expect(live.killed()).toBe(true)
  expect(invocations).toEqual([
    ['duet', 'connect', 'chatgpt', '--device-code', '--json'],
    ['duet', 'connect', '--disconnect', 'chatgpt', '--json'],
  ])
  expect(await eventuallyPoll(manager, started.sessionId)).toEqual({
    status: 'failed',
    reason: 'error',
  })
})

test('allows only one active operation for each provider', async () => {
  const live = controllableCommand()
  const manager = createConnectSessionManager({ runCommand: () => live.child })
  live.write(deviceCode('openai-codex'))
  await manager.start('openai-codex')

  await expect(manager.start('openai-codex')).rejects.toThrow(ConnectOperationConflictError)
  live.child.kill()
})

test('projects the bounded CLI status envelope without credential fields', async () => {
  const invocations: string[][] = []
  const manager = createConnectSessionManager({
    runCommand: argv => {
      invocations.push([...argv])
      return rawCommand([
        `${JSON.stringify({
          connections: [
            {
              provider: 'openai-codex',
              connectedAt: 100,
              eligibility: 'eligible',
              eligibilityCheckedAt: 110,
              lastRefreshAt: 120,
            },
            { provider: 'github-copilot', connectedAt: 200, eligibility: 'unknown' },
          ],
        })}\n`,
      ])
    },
  })

  expect(await manager.status()).toEqual([
    {
      provider: 'openai-codex',
      state: 'connected',
      connectedAt: 100,
      eligibilityCheckedAt: 110,
    },
    { provider: 'github-copilot', state: 'connected', connectedAt: 200 },
  ])
  expect(invocations).toEqual([['duet', 'connect', '--status', '--json']])
})

test('serves a fresh status observation without respawning the CLI', async () => {
  const invocations: string[][] = []
  let clock = 1_000
  const manager = createConnectSessionManager({
    runCommand: argv => {
      invocations.push([...argv])
      return statusCommand([
        { provider: 'openai-codex', connectedAt: 100, eligibility: 'eligible' },
      ])
    },
    now: () => clock,
  })

  const first = await manager.status()
  expect(first).toEqual([{ provider: 'openai-codex', state: 'connected', connectedAt: 100 }])

  clock += CONNECT_STATUS_FRESH_MS - 1
  expect(await manager.status()).toEqual(first)
  expect(invocations).toHaveLength(1)

  clock += 1
  expect(await manager.status()).toEqual(first)
  expect(invocations).toHaveLength(2)
})

test('a disconnect expires the observation so status reflects it immediately', async () => {
  const invocations: string[][] = []
  let connections: unknown[] = [
    { provider: 'openai-codex', connectedAt: 100, eligibility: 'eligible' },
  ]
  const manager = createConnectSessionManager({
    runCommand: argv => {
      invocations.push([...argv])
      if (argv.includes('--status')) return statusCommand(connections)
      return command([{ type: 'complete', provider: 'openai-codex', state: 'disconnected' }])
    },
    now: () => 1_000,
  })

  expect(await manager.status()).toEqual([
    { provider: 'openai-codex', state: 'connected', connectedAt: 100 },
  ])

  connections = []
  await manager.disconnect('openai-codex')

  // Same instant — only the disconnect can have expired the observation.
  expect(await manager.status()).toEqual([])
  expect(invocations.filter(argv => argv.includes('--status'))).toHaveLength(2)
})

test('concurrent callers share one status probe', async () => {
  let spawns = 0
  const manager = createConnectSessionManager({
    runCommand: () => {
      spawns += 1
      return statusCommand([
        { provider: 'openai-codex', connectedAt: 100, eligibility: 'eligible' },
      ])
    },
    now: () => 1_000,
  })

  const [first, second] = await Promise.all([manager.status(), manager.status()])

  expect(first).toEqual([{ provider: 'openai-codex', state: 'connected', connectedAt: 100 }])
  expect(second).toEqual(first)
  expect(spawns).toBe(1)
})

function statusCommand(connections: unknown[]) {
  return rawCommand([`${JSON.stringify({ connections })}\n`])
}

function deviceCode(provider: 'openai-codex' | 'github-copilot') {
  return {
    type: 'device_code',
    provider,
    verificationUri: 'https://example.test/device',
    userCode: 'ABCD-EFGH',
    expiresAt: 2_000_000_000_000,
  }
}

function command(events: unknown[], exitCode = 0) {
  return rawCommand(
    events.map(event => `${JSON.stringify(event)}\n`),
    exitCode,
  )
}

function rawCommand(chunks: string[], exitCode = 0, stderr = ''): ConnectCommandChild {
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return {
    stdout,
    stderr: streamOf(stderr),
    exited: Promise.resolve(exitCode),
    kill: () => undefined,
  }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: controller => controller.close() })
}

function streamOf(value: string): ReadableStream<Uint8Array> {
  if (value.length === 0) return emptyStream()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
}

function controllableCommand() {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>
  let stderrController!: ReadableStreamDefaultController<Uint8Array>
  let resolveExited!: (code: number) => void
  let wasKilled = false
  const child: ConnectCommandChild = {
    stdout: new ReadableStream({ start: controller => void (stdoutController = controller) }),
    stderr: new ReadableStream({ start: controller => void (stderrController = controller) }),
    exited: new Promise(resolve => void (resolveExited = resolve)),
    kill: () => {
      if (wasKilled) return
      wasKilled = true
      stdoutController.close()
      stderrController.close()
      resolveExited(143)
    },
  }
  return {
    child,
    write(event: unknown) {
      stdoutController.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`))
    },
    finish(code: number) {
      if (wasKilled) return
      stdoutController.close()
      stderrController.close()
      resolveExited(code)
    },
    killed: () => wasKilled,
  }
}

async function eventuallyPoll(
  manager: ReturnType<typeof createConnectSessionManager>,
  sessionId: string,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await manager.poll(sessionId)
    if (result.status === 'connected' || result.status === 'failed') return result
    await Promise.resolve()
  }
  throw new Error('session did not settle')
}

async function eventuallyPollAwaitingCode(
  manager: ReturnType<typeof createConnectSessionManager>,
  sessionId: string,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await manager.poll(sessionId)
    if (result.status === 'awaiting_code') return result
    await Promise.resolve()
  }
  throw new Error('session did not produce a device code')
}

test('a disconnect during an in-flight probe does not let the stale result stick', async () => {
  // The probe reads the credential store as it was BEFORE the disconnect. If
  // its result were still cached on arrival it would outlive the change it
  // predates — for the whole freshness window, which is hours.
  const live = controllableCommand()
  const statusCalls: number[] = []
  let call = 0
  const manager = createConnectSessionManager({
    runCommand: argv => {
      call += 1
      if (argv.includes('--disconnect')) {
        return command([{ type: 'complete', provider: 'openai-codex', state: 'disconnected' }])
      }
      statusCalls.push(call)
      if (statusCalls.length === 1) return live.child
      return statusCommand([])
    },
    now: () => 1_000,
  })

  const inFlight = manager.status()
  await manager.disconnect('openai-codex')
  // Only now does the pre-disconnect probe deliver its answer.
  live.write({
    connections: [{ provider: 'openai-codex', connectedAt: 100, eligibility: 'eligible' }],
  })
  live.finish(0)
  expect(await inFlight).toEqual([
    { provider: 'openai-codex', state: 'connected', connectedAt: 100 },
  ])

  expect(await manager.status()).toEqual([])
  expect(statusCalls).toHaveLength(2)
})
