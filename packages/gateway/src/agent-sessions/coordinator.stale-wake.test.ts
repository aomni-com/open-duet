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

// A checkpoint can sleep on a time it already fired (a killed run rehydrated
// with a stale timer task); left alone, wake and sleep spin at zero delay.
const NOW = 1_000_000

test('a sleep whose wake time has already passed ends the turn instead of relaunching', async () => {
  const harness = await bootSleepingSession({ wakeAt: 100, resleepAt: 100 })
  try {
    await waitFor(() => harness.relayed.some(event => event.type === 'sleep'))
    const ledger = createAgentSessionLedger({ stateDir: harness.stateDir, now: () => NOW })
    expect({
      ending: harness.relayed
        .filter(event => event.type === 'system')
        .map(event => (event as { metadata?: { code?: string } }).metadata?.code),
      storedWake: (await ledger.read(harness.sessionId))?.wake,
      armedTimers: harness.timers.filter(timer => !timer.cleared && !timer.fired).length,
      runnersSpawned: harness.spawned,
    }).toEqual({
      ending: ['runner_exited'],
      storedWake: undefined,
      armedTimers: 0,
      runnersSpawned: 1,
    })
  } finally {
    await harness.dispose()
  }
})

test('a sleep on a future wake time arms that wake and ends nothing', async () => {
  const harness = await bootSleepingSession({ wakeAt: 100, resleepAt: NOW + 60_000 })
  try {
    await waitFor(() => harness.relayed.some(event => event.type === 'sleep'))
    const ledger = createAgentSessionLedger({ stateDir: harness.stateDir, now: () => NOW })
    expect({
      ending: harness.relayed.filter(event => event.type === 'system'),
      storedWake: (await ledger.read(harness.sessionId))?.wake,
      armedDelays: harness.timers
        .filter(timer => !timer.cleared && !timer.fired)
        .map(timer => timer.delayMs),
      runnersSpawned: harness.spawned,
    }).toEqual({
      ending: [],
      storedWake: { wakeAt: NOW + 60_000, generation: 1 },
      armedDelays: [60_000],
      runnersSpawned: 1,
    })
  } finally {
    await harness.dispose()
  }
})

type TestTimer = { delayMs: number; cleared: boolean; fired: boolean; fire: () => void }

async function bootSleepingSession(input: { wakeAt: number; resleepAt: number }) {
  const root = await mkdtemp(join(tmpdir(), 'duet-coordinator-stale-wake-'))
  const stateDir = join(root, '.duet')
  const sessionId = 'session-stale-wake'
  await createAgentSessionLedger({ stateDir, now: () => NOW }).write({
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
    wake: { wakeAt: input.wakeAt, generation: 1 },
    relayOutbox: [],
    updatedAt: 0,
  })

  const timers: TestTimer[] = []
  const relayed: AgentRunnerEvent[] = []
  const harness = {
    stateDir,
    sessionId,
    timers,
    relayed,
    spawned: 0,
    dispose: () => rm(root, { recursive: true, force: true }),
  }
  const controller = createAgentSessionsController({
    stateDir,
    driveDir: join(root, 'drive'),
    memoryDbPath: join(root, 'memory.db'),
    getVmToken: async () => null,
    runnerFactory: () => {
      harness.spawned += 1
      return new ResleepingRunner(input.resleepAt)
    },
    relayEvent: async (_sessionId: string, _relayId: string, event: AgentRunnerEvent) => {
      relayed.push(event)
      return { seq: relayed.length + 1 }
    },
    ensureRunner: async () => undefined,
    cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    now: () => NOW,
    createRequestId: () => 'stale-wake',
    setTimer: (callback: () => void, delayMs: number) => {
      const timer: TestTimer = {
        delayMs,
        cleared: false,
        fired: false,
        fire: () => {
          if (timer.cleared || timer.fired) return
          timer.fired = true
          callback()
        },
      }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer: unknown) => {
      ;(timer as TestTimer).cleared = true
    },
  })
  await controller.browserOwnerForSession(sessionId)
  const dueWake = timers.find(timer => timer.delayMs === 0)
  expect(dueWake).toBeDefined()
  dueWake!.fire()
  return harness
}

/** Answers every wake by sleeping again on the same fixed wake time. */
class ResleepingRunner implements AgentRunner {
  private readonly listeners: AgentRunnerEventListener[] = []
  private readonly exitListeners: Array<(code: number | null) => void> = []
  private alive = false
  private exited = false

  constructor(private readonly wakeAt: number) {}

  async start(): Promise<void> {
    this.alive = true
  }

  async send(command: AgentRunnerCommand): Promise<void> {
    if (command.type === 'start') {
      this.emit({
        type: 'turn_started',
        state: { status: 'running', mode: 'agent', agent: { status: 'running', messages: [] } },
      })
    }
    if (command.type === 'wake') {
      this.emit({
        type: 'sleep',
        wakeAt: this.wakeAt,
        state: { status: 'sleeping', mode: 'agent', agent: { status: 'waiting', messages: [] } },
      })
    }
  }

  async waitForTurnStarted(): Promise<AgentRunnerStartedEvent> {
    return {
      type: 'turn_started',
      state: { status: 'running', mode: 'agent', agent: { status: 'running', messages: [] } },
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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(5)
  }
}
