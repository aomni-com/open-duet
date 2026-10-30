import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TurnRunner } from '@repo/agent'

import { AgentTurnStateSchema, type ModelSelectionId } from '@repo/contract'

import type { AgentRunner, AgentRunnerEventListener } from '../runner/process-runner'
import type {
  AgentRunnerCommand,
  AgentRunnerEvent,
  AgentRunnerStartedEvent,
} from '../runner/protocol'
import { createAgentSessionsController } from './coordinator'

// Use the installed agent's option resolver: a launch-only fake misses the
// checkpoint precedence that determines the tier actually used after resume.
test.each([
  ['balanced', 'frontier', 'balanced'],
  ['openai-frontier', 'balanced', 'anthropic-max'],
] as const)(
  'a completed session resumes with the requested selection (%s, %s, %s)',
  async (first, second, third) => {
    const root = await mkdtemp(join(tmpdir(), 'duet-tier-switch-'))
    try {
      const spawnedTiers: ModelSelectionId[] = []
      const resolvedIntegrationConfigs: Array<string | undefined> = []
      const runners: CompletingRunner[] = []
      const controller = createAgentSessionsController({
        stateDir: join(root, '.duet'),
        driveDir: join(root, 'drive'),
        memoryDbPath: join(root, 'memory.db'),
        getVmToken: async () => null,
        runnerFactory: args => {
          spawnedTiers.push(args.tier)
          const runner = new CompletingRunner(args.tier)
          runners.push(runner)
          return runner
        },
        relayEvent: async () => ({ seq: 1 }),
        mcpServers: (spawnedSessionId, launch) => {
          resolvedIntegrationConfigs.push(
            launch.integrations === true ? spawnedSessionId : undefined,
          )
          return null
        },
        ensureRunner: async () => undefined,
        cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      })

      const sessionId = 'session-tier-switch'
      await controller.deliverInput(sessionId, {
        attemptId: 'turn-1',
        throughSeq: 1,
        input: { kind: 'prompt', message: 'first', behavior: 'steer' },
        launch: {
          tier: first,
          integrations: true,
        },
      })
      // The first turn must be OVER before the second is delivered — that is the
      // whole premise of "next turn", and a prompt arriving mid-turn is steering
      // the running one, which correctly keeps its tier.
      await waitFor(() => runners[0]?.killed === true)

      await controller.deliverInput(sessionId, {
        attemptId: 'turn-2',
        throughSeq: 2,
        input: { kind: 'prompt', message: 'second', behavior: 'steer' },
        launch: {
          tier: second,
          integrations: true,
        },
      })
      await waitFor(() => spawnedTiers.length === 2)
      await waitFor(() => runners[1]?.killed === true)

      await controller.deliverInput('session-tier-switch', {
        attemptId: 'turn-3',
        throughSeq: 3,
        input: { kind: 'prompt', message: 'third', behavior: 'steer' },
        launch: { tier: third },
      })
      await waitFor(() => spawnedTiers.length === 3)
      await waitFor(() => runners[2]?.killed === true)

      expect(spawnedTiers).toEqual([first, second, third])
      expect(runners.map(runner => runner.state.options?.model)).toEqual([first, second, third])
      expect(resolvedIntegrationConfigs).toEqual([sessionId, sessionId, undefined])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('runner output limits reach the structured session log without output contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-runner-limit-log-'))
  try {
    const logs: Array<Record<string, unknown>> = []
    let runner: CompletingRunner | undefined
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      log: fields => logs.push(fields),
      runnerFactory: args => {
        args.onOutputLimit?.({
          stream: 'stdout',
          action: 'turn_terminated',
          maxBytes: 10 * 1024 * 1024,
        })
        runner = new CompletingRunner()
        return runner
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await controller.deliverInput('session-output-limit', {
      attemptId: 'turn-1',
      throughSeq: 1,
      input: { kind: 'prompt', message: 'secret output', behavior: 'steer' },
      launch: { tier: 'balanced' },
    })

    expect(logs).toContainEqual({
      event: 'runner_output_limit_reached',
      sessionId: 'session-output-limit',
      stream: 'stdout',
      action: 'turn_terminated',
      maxBytes: 10 * 1024 * 1024,
    })
    expect(JSON.stringify(logs)).not.toContain('secret output')
    await waitFor(() => runner?.killed === true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(10)
  }
}

const RUNNING_STATE = {
  status: 'running' as const,
  mode: 'agent' as const,
  agent: { status: 'running' as const, messages: [] },
}

/** Starts, answers one prompt, and terminates — one turn, like the real runner. */
class CompletingRunner implements AgentRunner {
  killed = false
  private readonly listeners: AgentRunnerEventListener[] = []
  private readonly exitListeners: Array<(code: number | null) => void> = []
  private alive = false
  state = AgentTurnStateSchema.parse(RUNNING_STATE)
  private readonly agent: TurnRunner

  constructor(tier: ModelSelectionId = 'balanced') {
    this.agent = new TurnRunner({ model: tier, skillDiscovery: { includeDefaults: false } })
  }

  async start(): Promise<void> {
    this.alive = true
  }

  async send(command: AgentRunnerCommand): Promise<void> {
    if (command.type === 'start') {
      const saved = AgentTurnStateSchema.parse(command.state ?? RUNNING_STATE)
      const requested = AgentTurnStateSchema.parse({
        ...RUNNING_STATE,
        options: command.options,
      }).options
      this.state = {
        ...saved,
        options: this.agent.resolveTurnOptions(requested, saved.options),
      }
      this.emit({
        type: 'turn_started',
        state: this.state,
      })
    }
    if (command.type === 'prompt') {
      this.emit({
        type: 'complete',
        state: {
          ...this.state,
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
    return { type: 'turn_started', state: this.state }
  }

  onEvent(listener: AgentRunnerEventListener): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index >= 0) this.listeners.splice(index, 1)
    }
  }

  isAlive(): boolean {
    return this.alive
  }

  getPid(): number | null {
    return null
  }

  getStderr(): string {
    return ''
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.push(listener)
    return () => {
      const index = this.exitListeners.indexOf(listener)
      if (index >= 0) this.exitListeners.splice(index, 1)
    }
  }

  kill(): void {
    if (this.killed) return
    this.killed = true
    this.alive = false
    for (const listener of this.exitListeners.slice()) listener(null)
  }

  private emit(event: AgentRunnerEvent): void {
    // Copied on purpose: `waitForTurnStarted` unsubscribes from inside its own
    // listener, and splicing the live array mid-iteration skips the next one.
    for (const listener of this.listeners.slice()) listener(event)
  }
}
