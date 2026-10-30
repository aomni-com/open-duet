import { afterEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentSessionsController } from '../agent-sessions/coordinator'
import { deliverPrompt } from '../agent-sessions/test-input.test-helper'
import {
  DRAIN_MS,
  cgroupLeafForSession,
  ensureRunnerCgroup,
  placeRunnerInCgroup,
  removeRunnerCgroupWhenDrained,
  resetRunnerCgroupStateForTests,
  sessionForCgroupLeaf,
  sweepStaleRunnerLeaves,
} from './cgroup'
import type { AgentRunner, AgentRunnerEventListener } from './process-runner'
import type { AgentRunnerCommand, AgentRunnerEvent, AgentRunnerStartedEvent } from './protocol'

const COMPLETED_TURN_STATE = {
  status: 'completed' as const,
  mode: 'agent' as const,
  agent: { status: 'completed' as const, messages: [] },
}

afterEach(() => {
  resetRunnerCgroupStateForTests()
})

async function readyCgroup(sh: (script: string) => Promise<void>): Promise<void> {
  expect(await ensureRunnerCgroup({ sh })).toBe(true)
}

describe('session cgroup leaf naming', () => {
  const hostileIds = [
    'sess_abc-123',
    'a/b',
    '../../etc/passwd',
    '.',
    '..',
    'session-session-',
    'a b;rm -rf /',
    'säss_⚡_unicode',
    'UPPER_and_lower',
    'x'.repeat(300),
    '_2f', // looks like an escape sequence itself
  ]

  test('leaves round-trip and never contain path or shell hazards', () => {
    for (const sessionId of hostileIds) {
      const leaf = cgroupLeafForSession(sessionId)
      expect(leaf.startsWith('session-')).toBe(true)
      // Safe for cgroupfs names and shell interpolation: one flat component.
      expect(leaf).toMatch(/^session-[A-Za-z0-9_-]*$/)
      expect(sessionForCgroupLeaf(leaf)).toBe(sessionId)
    }
  })

  test('ids that naively sanitize identically get distinct leaves', () => {
    // A lossy sanitizer would map all of these to something like `a_b`.
    const collidingIds = ['a/b', 'a.b', 'a_b', 'a b', 'a_2fb']
    const leaves = collidingIds.map(cgroupLeafForSession)
    expect(new Set(leaves).size).toBe(collidingIds.length)
    for (const [index, sessionId] of collidingIds.entries()) {
      expect(sessionForCgroupLeaf(leaves[index]!)).toBe(sessionId)
    }
  })

  test('non-session leaves reverse-map to null', () => {
    const nonSession = [
      '4242', // legacy pid-named leaf
      'runner',
      'session', // prefix requires the dash
      'session-a.b', // unsafe char never produced by the encoder
      'session-a_2', // truncated escape
      'session-a_2F', // non-canonical uppercase hex
      'session-a_41', // non-canonical escape of a safe char ('A')
      'session-_ff', // invalid UTF-8
    ]
    for (const leaf of nonSession) {
      expect(sessionForCgroupLeaf(leaf)).toBeNull()
    }
  })
})

describe('cgroup placement and drain teardown', () => {
  test('placement writes the pid into the session-named leaf', async () => {
    const scripts: string[] = []
    await readyCgroup(async script => {
      scripts.push(script)
    })
    await placeRunnerInCgroup(4321, 'sess_place', {
      sh: async script => {
        scripts.push(script)
      },
    })
    const leaf = cgroupLeafForSession('sess_place')
    expect(scripts.at(-1)).toBe(
      `mkdir -p /sys/fs/cgroup/runners/${leaf} && echo 4321 > /sys/fs/cgroup/runners/${leaf}/cgroup.procs`,
    )
  })

  test('hostile session ids produce shell-inert placement scripts', async () => {
    let placement = ''
    await readyCgroup(async () => {})
    await placeRunnerInCgroup(77, 'a b;$(reboot)/../x', {
      sh: async script => {
        placement = script
      },
    })
    expect(placement).toMatch(
      /^mkdir -p \/sys\/fs\/cgroup\/runners\/session-[A-Za-z0-9_-]+ && echo 77 > \/sys\/fs\/cgroup\/runners\/session-[A-Za-z0-9_-]+\/cgroup\.procs$/,
    )
  })

  test('sessions run identically when cgroup setup fails (best effort)', async () => {
    // Parent setup failed: no shell command is ever attempted.
    expect(
      await ensureRunnerCgroup({
        sh: async () => {
          throw new Error('no sudo')
        },
      }),
    ).toBe(false)
    let shellCalls = 0
    const countingSh = async () => {
      shellCalls += 1
    }
    await placeRunnerInCgroup(10, 'sess_a', { sh: countingSh })
    await removeRunnerCgroupWhenDrained('sess_a', { sh: countingSh, delay: async () => {} })
    expect(shellCalls).toBe(0)

    // Parent ready but the leaf operations fail: still resolves quietly.
    await readyCgroup(async () => {})
    const failingSh = async () => {
      throw new Error('mkdir: read-only file system')
    }
    await placeRunnerInCgroup(10, 'sess_a', { sh: failingSh })
    await removeRunnerCgroupWhenDrained('sess_a', { sh: failingSh, delay: async () => {} })
  })

  test('rmdir waits out the full drain window after exit', async () => {
    const log: string[] = []
    await readyCgroup(async () => {})
    let releaseDrain = () => {}
    const drainGate = new Promise<void>(resolve => {
      releaseDrain = resolve
    })
    const drained = removeRunnerCgroupWhenDrained('sess_drain', {
      sh: async script => {
        log.push(script)
      },
      delay: async ms => {
        log.push(`delay:${ms}`)
        await drainGate
      },
    })
    await Bun.sleep(1)
    // Mid-drain: the leaf must still exist for the watcher's final events.
    expect(log).toEqual([`delay:${DRAIN_MS}`])
    releaseDrain()
    await drained
    expect(log).toEqual([
      `delay:${DRAIN_MS}`,
      `rmdir /sys/fs/cgroup/runners/${cgroupLeafForSession('sess_drain')}`,
    ])
  })
})

describe('stale leaf sweep', () => {
  test('removes crash-leaked session leaves and legacy pid leaves only', async () => {
    const removed: string[] = []
    await sweepStaleRunnerLeaves(() => ['sess_active'], {
      listLeaves: async () => [
        cgroupLeafForSession('sess_active'),
        cgroupLeafForSession('sess_crashed'),
        cgroupLeafForSession('gone/α'),
        '31337', // legacy pid-named leaf: always stale after the orphan sweep
        'not-ours', // unknown shape: left alone
        'session-A.B', // non-canonical, reverse-maps to null: left alone
      ],
      sh: async script => {
        removed.push(script)
      },
    })
    expect(removed).toEqual([
      `rmdir /sys/fs/cgroup/runners/${cgroupLeafForSession('sess_crashed')}`,
      `rmdir /sys/fs/cgroup/runners/${cgroupLeafForSession('gone/α')}`,
      'rmdir /sys/fs/cgroup/runners/31337',
    ])
  })

  test('a failing rmdir does not stop the sweep', async () => {
    const attempted: string[] = []
    await sweepStaleRunnerLeaves(() => [], {
      listLeaves: async () => [cgroupLeafForSession('sess_busy'), cgroupLeafForSession('sess_b')],
      sh: async script => {
        attempted.push(script)
        throw new Error('rmdir: Device or resource busy')
      },
    })
    expect(attempted).toHaveLength(2)
  })
})

describe('process-runner cgroup lifecycle', () => {
  test('spawn → place → work → terminal → drained removal, keyed by sessionId', async () => {
    const log: string[] = []
    const runner = new FakeRunner(log)
    const controller = createAgentSessionsController({
      stateDir: join(tmpdir(), `duet-cgroup-${crypto.randomUUID()}`),
      driveDir: join(tmpdir(), 'drive'),
      memoryDbPath: join(tmpdir(), 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: {
        place: async (pid, sessionId) => {
          log.push(`place:${pid}:${sessionId}`)
        },
        removeWhenDrained: async sessionId => {
          log.push(`drain-remove:${sessionId}`)
        },
      },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_order',
      prompt: 'work',
      behavior: 'steer',
      tier: 'balanced',
    })
    runner.emitEvent({
      type: 'step',
      step: { type: 'text_delta', delta: 'working' },
    } as AgentRunnerEvent)
    runner.exitWith({
      type: 'complete',
      state: COMPLETED_TURN_STATE,
      status: 'completed',
      result: 'done',
    })
    await waitFor(() => log.some(entry => entry.startsWith('drain-remove:')))

    expect(log).toEqual([
      'spawn',
      'place:4242:sess_order',
      'work',
      'exit',
      'drain-remove:sess_order',
    ])
  })

  test('runner crash without a terminal event is GCed by the stale sweep', async () => {
    const log: string[] = []
    const runner = new FakeRunner(log)
    const controller = createAgentSessionsController({
      stateDir: join(tmpdir(), `duet-cgroup-${crypto.randomUUID()}`),
      driveDir: join(tmpdir(), 'drive'),
      memoryDbPath: join(tmpdir(), 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: {
        place: async (pid, sessionId) => {
          log.push(`place:${pid}:${sessionId}`)
        },
        removeWhenDrained: async sessionId => {
          log.push(`drain-remove:${sessionId}`)
        },
      },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_crash',
      prompt: 'work',
      behavior: 'steer',
      tier: 'balanced',
    })
    runner.crash()
    expect(log).toEqual(['spawn', 'place:4242:sess_crash', 'crash'])
    expect(controller.activeSessionIds()).toEqual([])

    // Next gateway life: the startup sweep sees the leaked leaf, the session
    // is no longer active, and the leaf is removed.
    const removed: string[] = []
    await sweepStaleRunnerLeaves(() => controller.activeSessionIds(), {
      listLeaves: async () => [cgroupLeafForSession('sess_crash')],
      sh: async script => {
        removed.push(script)
      },
    })
    expect(removed).toEqual([`rmdir /sys/fs/cgroup/runners/${cgroupLeafForSession('sess_crash')}`])
  })
})

class FakeRunner implements AgentRunner {
  private readonly listeners: AgentRunnerEventListener[] = []
  private readonly exitListeners: Array<(code: number | null) => void> = []
  private alive = false
  private exited = false

  constructor(private readonly log: string[]) {}

  async start(): Promise<void> {
    this.alive = true
    this.log.push('spawn')
  }

  async send(command: AgentRunnerCommand): Promise<void> {
    if (command.type === 'start') {
      this.emitEvent({
        type: 'turn_started',
        state: {
          status: 'running',
          mode: 'agent',
          agent: { status: 'running', messages: [] },
        },
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

  emitEvent(event: AgentRunnerEvent): void {
    if (event.type === 'step') this.log.push('work')
    for (const listener of this.listeners.slice()) listener(event)
  }

  exitWith(terminal: AgentRunnerEvent): void {
    this.alive = false
    this.log.push('exit')
    this.emitEvent(terminal)
  }

  /** Dies on its own, with no terminal event — a crash, an OOM kill, a signal. */
  crash(): void {
    this.markExited()
    this.log.push('crash')
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

  getPid(): number | null {
    return 4242
  }

  getStderr(): string {
    return ''
  }

  kill(): void {
    this.markExited()
  }

  private markExited(): void {
    if (this.exited) return
    this.exited = true
    this.alive = false
    for (const listener of this.exitListeners.slice()) listener(null)
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(5)
  }
}
