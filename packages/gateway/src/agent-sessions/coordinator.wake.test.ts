import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentRunner, AgentRunnerEventListener } from '../runner/process-runner'
import type {
  AgentRunnerCommand,
  AgentRunnerEvent,
  AgentRunnerStartedEvent,
} from '../runner/protocol'
import { createAgentSessionsController } from './coordinator'
import { createAgentSessionLedger } from './ledger'

test('an overdue wake refreshes integration access before spawning its next turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-coordinator-wake-integrations-'))
  try {
    const stateDir = join(root, '.duet')
    const sessionId = 'session-wake-integration-refresh'
    await createAgentSessionLedger({ stateDir, now: () => 100 }).write({
      version: 1,
      sessionId,
      launch: {
        tier: 'balanced',
        integrations: true,
      },
      checkpoint: {
        state: {
          status: 'sleeping',
          mode: 'agent',
          agent: { status: 'waiting', messages: [] },
        },
        terminalType: 'sleep',
      },
      acceptedThroughSeq: 1,
      inFlightCommands: [],
      wake: { wakeAt: 100, generation: 1 },
      relayOutbox: [],
      updatedAt: 0,
    })

    const timers: TestTimer[] = []
    const resolvedIntegrationConfigs: Array<string | undefined> = []
    const refreshes: string[] = []
    const options = {
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => new CompletingPromptRunner(),
      relayEvent: async () => ({ seq: 2 }),
      refreshTurnMcp: async (requestedSessionId: string) => {
        refreshes.push(requestedSessionId)
        return { integrations: true as const }
      },
      mcpServers: (spawnedSessionId: string, launch: { integrations?: true }) => {
        resolvedIntegrationConfigs.push(launch.integrations === true ? spawnedSessionId : undefined)
        return null
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 100,
      createRequestId: () => 'refreshed-wake',
      setTimer: (callback: () => void, delayMs: number) => {
        const timer = { callback, delayMs, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: (timer: unknown) => {
        ;(timer as TestTimer).cleared = true
      },
    }
    createAgentSessionsController(options)
    await waitFor(() => timers.length > 0)
    for (const timer of timers.filter(timer => !timer.cleared)) timer.callback()
    await waitFor(() => resolvedIntegrationConfigs.length > 0)

    expect({ refreshes, resolvedIntegrationConfigs }).toEqual({
      refreshes: [sessionId],
      resolvedIntegrationConfigs: [sessionId],
    })
    expect(
      (await createAgentSessionLedger({ stateDir, now: () => 100 }).read(sessionId))?.launch
        .integrations,
    ).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a rejected refreshed wake discards its runner before retrying with current access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-coordinator-wake-integration-retry-'))
  try {
    const stateDir = join(root, '.duet')
    const sessionId = 'session-wake-integration-retry'
    await createAgentSessionLedger({ stateDir, now: () => 100 }).write({
      version: 1,
      sessionId,
      launch: {
        tier: 'balanced',
        integrations: true,
      },
      checkpoint: {
        state: {
          status: 'sleeping',
          mode: 'agent',
          agent: { status: 'waiting', messages: [] },
        },
        terminalType: 'sleep',
      },
      acceptedThroughSeq: 1,
      inFlightCommands: [],
      wake: { wakeAt: 100, generation: 1 },
      relayOutbox: [],
      updatedAt: 0,
    })

    const timers: TestTimer[] = []
    const runners: CompletingPromptRunner[] = []
    const resolvedIntegrationConfigs: Array<string | undefined> = []
    let refreshCount = 0
    let requestCount = 0
    createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => {
        const runner = new CompletingPromptRunner(runners.length === 0)
        runners.push(runner)
        return runner
      },
      relayEvent: async () => ({ seq: 2 }),
      refreshTurnMcp: async () => {
        refreshCount += 1
        return { integrations: true as const }
      },
      mcpServers: (spawnedSessionId, launch) => {
        resolvedIntegrationConfigs.push(launch.integrations === true ? spawnedSessionId : undefined)
        return null
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 100,
      createRequestId: () => `retried-wake-${++requestCount}`,
      setTimer: (callback, delayMs) => {
        const timer = { callback, delayMs, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: timer => {
        ;(timer as TestTimer).cleared = true
      },
    })

    await waitFor(() => timers.length > 0)
    timers[0]!.callback()
    await waitFor(() => runners.length === 1 && timers.length > 1)
    expect(runners[0]!.isAlive()).toBe(false)

    timers.at(-1)!.callback()
    await waitFor(async () => {
      const envelope = await createAgentSessionLedger({ stateDir, now: () => 100 }).read(sessionId)
      return envelope?.wake === undefined
    })

    expect({ refreshCount, resolvedIntegrationConfigs }).toEqual({
      refreshCount: 2,
      resolvedIntegrationConfigs: [sessionId, sessionId],
    })
    expect(
      (await createAgentSessionLedger({ stateDir, now: () => 100 }).read(sessionId))?.launch
        .integrations,
    ).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed wake refresh omits every stale MCP field without burning the wake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-coordinator-wake-integrations-failure-'))
  try {
    const stateDir = join(root, '.duet')
    const sessionId = 'session-wake-integration-refresh-failure'
    await createAgentSessionLedger({ stateDir, now: () => 100 }).write({
      version: 1,
      sessionId,
      launch: {
        tier: 'balanced',
        integrations: true,
        mcpServers: [{ name: 'notes' }],
      },
      checkpoint: {
        state: {
          status: 'sleeping',
          mode: 'agent',
          agent: { status: 'waiting', messages: [] },
        },
        terminalType: 'sleep',
      },
      acceptedThroughSeq: 1,
      inFlightCommands: [],
      wake: { wakeAt: 100, generation: 1 },
      relayOutbox: [],
      updatedAt: 0,
    })

    const timers: TestTimer[] = []
    const resolvedIntegrationConfigs: Array<string | undefined> = []
    createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => new CompletingPromptRunner(),
      relayEvent: async () => ({ seq: 2 }),
      refreshTurnMcp: async () => {
        throw new Error('projection unavailable')
      },
      mcpServers: (spawnedSessionId, launch) => {
        resolvedIntegrationConfigs.push(launch.integrations === true ? spawnedSessionId : undefined)
        return null
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 100,
      createRequestId: () => 'failed-refresh-wake',
      setTimer: (callback: () => void, delayMs: number) => {
        const timer = { callback, delayMs, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: (timer: unknown) => {
        ;(timer as TestTimer).cleared = true
      },
    })
    await waitFor(() => timers.length > 0)
    for (const timer of timers.filter(timer => !timer.cleared)) timer.callback()
    await waitFor(() => resolvedIntegrationConfigs.length > 0)

    expect(resolvedIntegrationConfigs).toEqual([undefined])
    expect(
      (await createAgentSessionLedger({ stateDir, now: () => 100 }).read(sessionId))?.launch,
    ).toEqual({ tier: 'balanced' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// D16's blast radius, at the one place it matters most. A wake has no user
// behind it, and the control plane answers both kinds of MCP server in one
// call — so a Composio outage that omits `integrations` must still hand this
// turn the custom servers the workspace registered, and the stale names on
// disk must not survive the refresh either way.
test('a wake refresh replaces both MCP fields, and Composio omitting its own leaves the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-coordinator-wake-mcp-servers-'))
  try {
    const stateDir = join(root, '.duet')
    const sessionId = 'session-wake-mcp-servers'
    await createAgentSessionLedger({ stateDir, now: () => 100 }).write({
      version: 1,
      sessionId,
      launch: {
        tier: 'balanced',
        integrations: true,
        mcpServers: [{ name: 'removed' }],
      },
      checkpoint: {
        state: {
          status: 'sleeping',
          mode: 'agent',
          agent: { status: 'waiting', messages: [] },
        },
        terminalType: 'sleep',
      },
      acceptedThroughSeq: 1,
      inFlightCommands: [],
      wake: { wakeAt: 100, generation: 1 },
      relayOutbox: [],
      updatedAt: 0,
    })

    const timers: TestTimer[] = []
    const spawnedLaunches: Array<Record<string, unknown>> = []
    createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => new CompletingPromptRunner(),
      relayEvent: async () => ({ seq: 2 }),
      refreshTurnMcp: async () => ({ mcpServers: [{ name: 'notes' }] }),
      mcpServers: (_spawnedSessionId, launch) => {
        spawnedLaunches.push({ ...launch })
        return null
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 100,
      createRequestId: () => 'mcp-servers-wake',
      setTimer: (callback: () => void, delayMs: number) => {
        const timer = { callback, delayMs, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: (timer: unknown) => {
        ;(timer as TestTimer).cleared = true
      },
    })
    await waitFor(() => timers.length > 0)
    for (const timer of timers.filter(timer => !timer.cleared)) timer.callback()
    await waitFor(() => spawnedLaunches.length > 0)

    expect(spawnedLaunches).toEqual([{ tier: 'balanced', mcpServers: [{ name: 'notes' }] }])
    expect(
      (await createAgentSessionLedger({ stateDir, now: () => 100 }).read(sessionId))?.launch,
    ).toEqual({ tier: 'balanced', mcpServers: [{ name: 'notes' }] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a prompt that completes without sleeping preserves the armed wake through its deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-coordinator-wake-'))
  try {
    const stateDir = join(root, '.duet')
    const sessionId = 'session-prompt-before-wake'
    const wakeAt = 1_000
    const sleepingState = {
      status: 'sleeping' as const,
      mode: 'agent' as const,
      agent: { status: 'waiting' as const, messages: [] },
    }
    await createAgentSessionLedger({ stateDir, now: () => 0 }).write({
      version: 1,
      sessionId,
      launch: { tier: 'balanced' },
      checkpoint: { state: sleepingState, terminalType: 'sleep' },
      acceptedThroughSeq: 1,
      inFlightCommands: [],
      wake: { wakeAt, generation: 1 },
      relayOutbox: [],
      updatedAt: 0,
    })

    let now = 100
    const timers: TestTimer[] = []
    const runners: CompletingPromptRunner[] = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => {
        const runner = new CompletingPromptRunner()
        runners.push(runner)
        return runner
      },
      relayEvent: async () => ({ seq: 2 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => now,
      createRequestId: () => 'deadline-wake',
      setTimer: (callback, delayMs) => {
        const timer = { callback, delayMs, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: timer => {
        ;(timer as TestTimer).cleared = true
      },
    })

    await controller.deliverInput(sessionId, {
      attemptId: 'user-prompt',
      throughSeq: 2,
      input: { kind: 'prompt', message: 'Do this first', behavior: 'steer' },
      launch: { tier: 'balanced' },
    })
    await waitFor(async () => {
      const envelope = await createAgentSessionLedger({ stateDir, now: () => now }).read(sessionId)
      return envelope?.checkpoint?.terminalType === 'complete'
    })

    const beforeDeadline = await createAgentSessionLedger({ stateDir, now: () => now }).read(
      sessionId,
    )
    now = wakeAt
    for (const timer of timers.filter(timer => !timer.cleared)) timer.callback()
    await waitFor(
      () => runners.some(runner => runner.commands.some(command => command.type === 'wake')),
      100,
      false,
    )

    expect({
      persistedWakeBeforeDeadline: beforeDeadline?.wake,
      wakeCommandsAtDeadline: runners
        .flatMap(runner => runner.commands)
        .filter(command => command.type === 'wake'),
    }).toEqual({
      persistedWakeBeforeDeadline: { wakeAt, generation: 1 },
      wakeCommandsAtDeadline: [{ type: 'wake', requestId: 'deadline-wake' }],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a wake that fires as maintenance starts is re-armed when runner starts resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-coordinator-wake-maintenance-'))
  try {
    const stateDir = join(root, '.duet')
    const sessionId = 'session-wake-maintenance'
    await createAgentSessionLedger({ stateDir, now: () => 100 }).write({
      version: 1,
      sessionId,
      launch: { tier: 'balanced' },
      checkpoint: {
        state: {
          status: 'sleeping',
          mode: 'agent',
          agent: { status: 'waiting', messages: [] },
        },
        terminalType: 'sleep',
      },
      acceptedThroughSeq: 1,
      inFlightCommands: [],
      wake: { wakeAt: 100, generation: 1 },
      relayOutbox: [],
      updatedAt: 0,
    })

    const timers: TestTimer[] = []
    const runners: CompletingPromptRunner[] = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => {
        const runner = new CompletingPromptRunner()
        runners.push(runner)
        return runner
      },
      relayEvent: async () => ({ seq: 2 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 100,
      createRequestId: () => 'maintenance-wake',
      setTimer: (callback, delayMs) => {
        const timer = { callback, delayMs, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: timer => {
        ;(timer as TestTimer).cleared = true
      },
    })

    await waitFor(() => timers.length > 0)
    timers[0]!.callback()
    controller.setStartsBlocked(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(runners).toEqual([])

    controller.setStartsBlocked(false)
    await waitFor(() => timers.length > 1)
    timers.at(-1)!.callback()
    await waitFor(() =>
      runners.some(runner => runner.commands.some(command => command.type === 'wake')),
    )
    expect(
      runners.flatMap(runner => runner.commands).filter(command => command.type === 'wake'),
    ).toEqual([{ type: 'wake', requestId: 'maintenance-wake' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

interface TestTimer {
  callback: () => void
  delayMs: number
  cleared: boolean
}

class CompletingPromptRunner implements AgentRunner {
  private readonly listeners: AgentRunnerEventListener[] = []
  private readonly exitListeners: Array<(code: number | null) => void> = []
  private alive = false
  private exited = false
  readonly commands: AgentRunnerCommand[] = []

  constructor(private readonly failWake = false) {}

  async start(): Promise<void> {
    this.alive = true
  }

  async send(command: AgentRunnerCommand): Promise<void> {
    this.commands.push(command)
    if (command.type === 'wake' && this.failWake) throw new Error('wake rejected')
    if (command.type === 'start') {
      this.emit({
        type: 'turn_started',
        state: {
          status: 'running',
          mode: 'agent',
          agent: { status: 'running', messages: [] },
        },
      })
    }
    if (command.type === 'prompt') {
      this.emit({
        type: 'complete',
        state: {
          status: 'completed',
          mode: 'agent',
          agent: { status: 'completed', messages: [] },
        },
        status: 'completed',
        result: 'done',
      })
    }
  }

  async waitForTurnStarted(): Promise<AgentRunnerStartedEvent> {
    return {
      type: 'turn_started',
      state: {
        status: 'running',
        mode: 'agent',
        agent: { status: 'running', messages: [] },
      },
    }
  }

  onEvent(listener: AgentRunnerEventListener): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index !== -1) this.listeners.splice(index, 1)
    }
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.push(listener)
    return () => {
      const index = this.exitListeners.indexOf(listener)
      if (index !== -1) this.exitListeners.splice(index, 1)
    }
  }

  isAlive(): boolean {
    return this.alive
  }

  kill(): void {
    if (this.exited) return
    this.exited = true
    this.alive = false
    for (const listener of this.exitListeners.slice()) listener(null)
  }

  getPid(): number | null {
    return null
  }

  getStderr(): string {
    return ''
  }

  private emit(event: AgentRunnerEvent): void {
    for (const listener of this.listeners.slice()) listener(event)
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
  throwOnTimeout = true,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      if (throwOnTimeout) throw new Error('waitFor timed out')
      return
    }
    await Bun.sleep(5)
  }
}
