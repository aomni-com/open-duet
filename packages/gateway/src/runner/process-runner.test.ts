import { describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'

import type { AgentStateMachineSession, AgentTurnEvent, AgentTurnState } from '@repo/contract'
import type { GatewayAnchor } from '@repo/contract'

import { createAgentSessionsController } from '../agent-sessions/coordinator'
import { createAgentSessionLedger, sessionEnvelopePath } from '../agent-sessions/ledger'
import {
  deliverAnswer,
  deliverPrompt,
  deliverPromptWithReceipt,
} from '../agent-sessions/test-input.test-helper'
import { DEVELOPER_SYSTEM_PROMPT } from './developer-system-prompt'
import { RUNNER_OWNER_ENV, RUNNER_RPC_FLAG, sweepOrphanRunners } from './orphan-sweep'
import {
  ProcessAgentRunner,
  RUNNER_STDERR_MAX_BYTES,
  RUNNER_STDOUT_RECORD_MAX_BYTES,
  defaultRunnerFactory,
  type AgentRunner,
  type AgentRunnerEventListener,
  type AgentRunnerFactoryArgs,
  type ProcessRunnerOptions,
} from './process-runner'
import type { AgentRunnerCommand, AgentRunnerEvent, AgentRunnerStartedEvent } from './protocol'

describe('agent session coordinator and process transport', () => {
  test('accepts one complete NDJSON record at the byte limit', async () => {
    const runner = new ProcessAgentRunner({
      command: process.execPath,
      args: [
        '-e',
        `const prefix = '{"type":"diagnostic","padding":"'; const suffix = '"}'; process.stdout.write(prefix + 'x'.repeat(${RUNNER_STDOUT_RECORD_MAX_BYTES} - Buffer.byteLength(prefix + suffix)) + suffix + '\\n')`,
      ],
    })
    let received = false
    const unsubscribe = runner.onEvent(() => {
      received = true
    })

    await runner.start()
    try {
      await waitFor(() => received || !runner.isAlive())
      expect(received).toBe(true)
      expect(runner.getStderr()).not.toContain('stdout exceeded')
    } finally {
      unsubscribe()
      if (runner.isAlive()) runner.kill()
    }
  })

  test('a spawned runner is told not to self-upgrade — the rail owns the binary', async () => {
    // 2026-08-18 staging saturation: every runner launch ran the agent CLI's
    // own registry probe and fired an unstaggered global install that the
    // cgroup teardown then killed mid-flight, forever. On a VM the npm rail is
    // the only installer, so every child the gateway spawns gets the CLI's
    // upgrade kill switch.
    const runner = new ProcessAgentRunner({
      command: process.execPath,
      args: [
        '-e',
        `process.stdout.write(JSON.stringify({ type: 'diagnostic', upgrade: process.env.DUET_NO_AUTO_UPGRADE ?? 'unset' }) + '\\n')`,
      ],
    })
    const events: Array<Record<string, unknown>> = []
    const unsubscribe = runner.onEvent(event => {
      events.push(event as unknown as Record<string, unknown>)
    })

    await runner.start()
    try {
      await waitFor(() => events.length > 0 || !runner.isAlive())
      expect(events[0]?.upgrade).toBe('1')
    } finally {
      unsubscribe()
      if (runner.isAlive()) runner.kill()
    }
  })

  test('terminates a runner whose stdout never reaches an NDJSON delimiter', async () => {
    const limitEvents: unknown[] = []
    const runner = new ProcessAgentRunner({
      command: process.execPath,
      args: [
        '-e',
        `process.stdout.write('x'.repeat(${RUNNER_STDOUT_RECORD_MAX_BYTES + 1})); setInterval(() => {}, 1_000)`,
      ],
      onOutputLimit: event => limitEvents.push(event),
    })

    await runner.start()
    try {
      await waitFor(() => !runner.isAlive())
      expect(runner.getStderr()).toContain('stdout exceeded its NDJSON fragment limit')
      expect(limitEvents).toEqual([
        {
          stream: 'stdout',
          action: 'turn_terminated',
          maxBytes: RUNNER_STDOUT_RECORD_MAX_BYTES,
        },
      ])
    } finally {
      if (runner.isAlive()) runner.kill()
    }
  })

  test('terminates a runner whose completed NDJSON record exceeds the byte limit', async () => {
    const runner = new ProcessAgentRunner({
      command: process.execPath,
      args: [
        '-e',
        `process.stdout.write('x'.repeat(${RUNNER_STDOUT_RECORD_MAX_BYTES + 1}) + '\\n'); setInterval(() => {}, 1_000)`,
      ],
    })

    await runner.start()
    try {
      await waitFor(() => !runner.isAlive())
      expect(runner.getStderr()).toContain('stdout exceeded its NDJSON record limit')
    } finally {
      if (runner.isAlive()) runner.kill()
    }
  })

  /* The runtime's verdict on a process is not the runner's death: it can
     report an exit for a process that is still streaming. The one fact a
     runtime cannot get wrong is the pipe — the kernel closes a dead process's
     stdout and a live one keeps it open — so a runner is dead when its stdout
     closes, and the handle's `exit` is diagnostics, never the verdict. */
  test('a handle that reports exit while stdout is still open does not end the runner', async () => {
    const child = fakeChildProcess()
    const runner = new ProcessAgentRunner({ command: 'duet', args: [], spawn: () => child.process })
    const events: unknown[] = []
    const exits: Array<number | null> = []
    runner.onEvent(event => events.push(event))
    runner.onExit(code => exits.push(code))
    await runner.start()

    child.process.emit('exit', 0, null)
    child.stdout.write('{"type":"task_output","taskId":"t8","chunk":"still here"}\n')
    await waitFor(() => events.length > 0)
    expect(events).toEqual([{ type: 'task_output', taskId: 't8', chunk: 'still here' }])
    expect(runner.isAlive()).toBe(true)
    expect(exits).toEqual([])

    child.stdout.end()
    await waitFor(() => exits.length > 0)
    expect(exits).toEqual([0])
    expect(runner.isAlive()).toBe(false)
    // What the handle said is kept for whoever reads the exit, not acted on.
    expect(runner.getStderr()).toContain('exit code=0')
  })

  test("a handle 'error' while stdout is still open is recorded, not obeyed", async () => {
    const child = fakeChildProcess()
    const runner = new ProcessAgentRunner({ command: 'duet', args: [], spawn: () => child.process })
    const exits: Array<number | null> = []
    runner.onExit(code => exits.push(code))
    await runner.start()

    child.process.emit('error', new Error('EBADF: rewatch failed'))
    child.stdout.write('{"type":"task_output","taskId":"t8","chunk":"still here"}\n')
    await waitFor(() => runner.getStderr().includes('rewatch failed'))
    expect(runner.isAlive()).toBe(true)
    expect(exits).toEqual([])

    child.stdout.end()
    await waitFor(() => exits.length > 0)
    expect(exits).toEqual([null])
  })

  test('a process that really dies closes its stdout, and that is when the runner ends', async () => {
    const runner = new ProcessAgentRunner({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(\'{"type":"turn_started"}\\n\'); process.exit(3)'],
    })
    const exits: Array<number | null> = []
    runner.onExit(code => exits.push(code))
    await runner.start()
    await waitFor(() => exits.length > 0)
    expect(exits).toHaveLength(1)
    expect(runner.isAlive()).toBe(false)
    // The pipe and the handle race on a real death; the code is diagnostics and
    // lands in the stderr tail whichever order they arrive in.
    await waitFor(() => runner.getStderr().includes('exit code=3'))
  })

  test('stdout-close remains relay-busy until its durable exit report settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const child = fakeChildProcess()
    const runner = new ProcessAgentRunner({ command: 'duet', args: [], spawn: () => child.process })
    let releaseExitRelay: () => void = () => undefined
    let exitRelayStarted = false
    let exitRelaySettled = false
    const exitRelayBlocked = new Promise<void>(resolve => {
      releaseExitRelay = resolve
    })
    let nextSeq = 0
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async (_sessionId, _relayId, event) => {
        if (event.type === 'system') {
          exitRelayStarted = true
          await exitRelayBlocked
          exitRelaySettled = true
        }
        return { seq: (nextSeq += 1) }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    const delivery = deliverPrompt(controller, {
      sessionId: 'sess_stdout_close_relay',
      prompt: 'work until stdout closes',
      behavior: 'steer',
      tier: 'balanced',
    })
    await waitFor(() => runner.isAlive())
    child.stdout.write(`${JSON.stringify({ type: 'turn_started', state: runningTurnState() })}\n`)
    await Bun.sleep(5)
    child.stdout.write(
      `${JSON.stringify({ type: 'command_accepted', requestId: 'test:sess_stdout_close_relay:1', commandType: 'prompt' })}\n`,
    )
    await delivery
    child.stdout.end()
    await waitFor(() => controller.activeCount() === 0)
    await waitFor(() => exitRelayStarted)
    expect(exitRelaySettled).toBe(false)

    releaseExitRelay()
    await waitFor(() => exitRelaySettled)
    expect(controller.activeCount()).toBe(0)
  })

  test('retains a bounded, explicitly truncated tail of sustained runner stderr', async () => {
    const limitEvents: unknown[] = []
    const runner = new ProcessAgentRunner({
      command: process.execPath,
      args: [
        '-e',
        `process.stderr.write('discarded-start\\n' + 'x'.repeat(${RUNNER_STDERR_MAX_BYTES * 2}) + '\\nuseful-tail\\n')`,
      ],
      onOutputLimit: event => limitEvents.push(event),
    })

    await runner.start()
    await waitFor(() => !runner.isAlive())
    const stderr = runner.getStderr()

    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(RUNNER_STDERR_MAX_BYTES)
    expect(stderr).toContain('stderr truncated')
    expect(stderr).toContain('useful-tail')
    expect(stderr).not.toContain('discarded-start')
    expect(limitEvents).toEqual([
      {
        stream: 'stderr',
        action: 'older_output_truncated',
        maxBytes: RUNNER_STDERR_MAX_BYTES,
      },
    ])
  })

  test('relays the frozen accepted boundary on the API wire', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    let posted: unknown
    const controller = createAgentSessionsController({
      apiUrl: 'https://ctl.test',
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => 'vm-token',
      diskGuard: { ensureWritable: async () => 'full' },
      fetch: async (_input, init) => {
        posted = JSON.parse(String(init?.body))
        return Response.json({ seq: 1 })
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_relay_boundary',
      prompt: 'work',
      behavior: 'steer',
      tier: 'balanced',
      throughSeq: 3,
    })

    expect(posted).toMatchObject({
      relayId: expect.any(String),
      acceptedThroughSeq: 3,
      event: { type: 'system', metadata: { code: 'storage_full' } },
    })
  })

  test('settles a new input with one durable storage-full event without spawning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    let factoryCalls = 0
    const relayed: AgentTurnEvent[] = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      diskGuard: { ensureWritable: async () => 'full' },
      runnerFactory: () => {
        factoryCalls += 1
        return new FakeRunner()
      },
      relayEvent: async (_sessionId, _relayId, event) => {
        relayed.push(event)
        return { seq: 1 }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })
    const input = {
      attemptId: 'full-attempt',
      throughSeq: 3,
      input: { kind: 'prompt' as const, message: 'start', behavior: 'steer' as const },
      launch: { tier: 'balanced' as const },
    }

    await expect(controller.deliverInput('sess_full', input)).resolves.toEqual({
      acceptedThroughSeq: 3,
      disposition: 'settled',
    })
    await expect(controller.deliverInput('sess_full', input)).resolves.toEqual({
      acceptedThroughSeq: 3,
      disposition: 'duplicate',
    })

    expect(factoryCalls).toBe(0)
    expect(relayed).toEqual([
      {
        type: 'system',
        level: 'error',
        message: 'Your workspace is full. Delete files to free up space, then try again.',
        metadata: { code: 'storage_full' },
      },
    ])
    const envelope = await createAgentSessionLedger({ stateDir, now: Date.now }).read('sess_full')
    expect(envelope?.acceptedThroughSeq).toBe(3)
    expect(envelope?.inFlightCommands).toEqual([])
    expect(controller.has('sess_full')).toBe(false)
  })

  test('an answer to a session waiting at ask is refused below the reserve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const runner = new FakeRunner()
    let available: 'ok' | 'full' = 'ok'
    const relayed: AgentTurnEvent[] = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      diskGuard: { ensureWritable: async () => available },
      runnerFactory: () => runner,
      relayEvent: async (_sessionId, _relayId, event) => {
        relayed.push(event)
        return { seq: 1 }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_ask_full',
      attemptId: 'question',
      prompt: 'start',
      behavior: 'steer',
      throughSeq: 1,
      tier: 'balanced' as const,
    })
    runner.emitEvent({
      type: 'ask',
      state: {
        status: 'waiting_for_human' as const,
        mode: 'agent' as const,
        agent: { status: 'waiting' as const, messages: [] },
      },
      questions: [{ question: 'Approve?', options: [] }],
    })
    await Bun.sleep(10)
    available = 'full'

    await expect(
      controller.deliverInput('sess_ask_full', {
        attemptId: 'answer',
        throughSeq: 2,
        input: { kind: 'prompt' as const, message: 'yes', behavior: 'follow_up' as const },
        launch: { tier: 'balanced' },
      }),
    ).resolves.toMatchObject({ disposition: 'settled' })

    // Terminal means terminal: the ask event already killed its runner, so
    // the refused answer settles against the durable checkpoint and no
    // process ever receives it.
    expect(runner.isAlive()).toBe(false)
    expect(runner.commands.filter(command => command.type === 'prompt')).toHaveLength(1)
    expect(relayed.at(-1)).toMatchObject({
      type: 'system',
      metadata: { code: 'storage_full' },
    })
  })

  test('does not consult the reserve again for a turn that is already running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const runner = new FakeRunner()
    let available: 'ok' | 'full' = 'ok'
    let guardCalls = 0
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      diskGuard: {
        ensureWritable: async () => {
          guardCalls += 1
          return available
        },
      },
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_crossing',
      attemptId: 'first',
      prompt: 'start',
      behavior: 'steer',
      throughSeq: 1,
      tier: 'balanced' as const,
    })
    available = 'full'
    await deliverPrompt(controller, {
      sessionId: 'sess_crossing',
      attemptId: 'second',
      prompt: 'continue',
      behavior: 'follow_up',
      throughSeq: 2,
      tier: 'balanced' as const,
    })

    expect(guardCalls).toBe(1)
    expect(runner.commands.filter(command => command.type === 'prompt')).toEqual([
      { type: 'prompt', requestId: 'first', message: 'start', behavior: 'steer' },
      {
        type: 'prompt',
        requestId: 'second',
        message: 'continue',
        behavior: 'follow_up',
      },
    ])
  })

  test('delivers one input seam with hydrated, live, and duplicate receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const runner = new FakeRunner()
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await expect(
      controller.deliverInput('sess_receipt', {
        attemptId: 'attempt-1',
        throughSeq: 3,
        input: { kind: 'prompt', message: 'start', behavior: 'steer' },
        launch: { tier: 'balanced' },
      }),
    ).resolves.toEqual({ acceptedThroughSeq: 3, disposition: 'hydrated' })
    await expect(
      controller.deliverInput('sess_receipt', {
        attemptId: 'attempt-2',
        throughSeq: 4,
        input: { kind: 'prompt', message: 'continue', behavior: 'follow_up' },
        launch: { tier: 'balanced' },
      }),
    ).resolves.toEqual({ acceptedThroughSeq: 4, disposition: 'live' })
    await expect(
      controller.deliverInput('sess_receipt', {
        attemptId: 'attempt-retry',
        throughSeq: 4,
        input: { kind: 'prompt', message: 'must not repeat', behavior: 'steer' },
        launch: { tier: 'balanced' },
      }),
    ).resolves.toEqual({ acceptedThroughSeq: 4, disposition: 'duplicate' })

    expect(runner.commands.filter(command => command.type === 'prompt')).toEqual([
      {
        type: 'prompt',
        requestId: 'attempt-1',
        message: 'start',
        behavior: 'steer',
      },
      {
        type: 'prompt',
        requestId: 'attempt-2',
        message: 'continue',
        behavior: 'follow_up',
      },
    ])
  })

  test('prompt delivery resolves only after its RPC receipt and hides the receipt from listeners', async () => {
    const runner = new ProcessAgentRunner({
      command: process.execPath,
      args: [
        '-e',
        `
          process.stdin.setEncoding('utf8')
          let buffer = ''
          process.stdin.on('data', chunk => {
            buffer += chunk
            const lines = buffer.split('\\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              const command = JSON.parse(line)
              if (command.type !== 'prompt') continue
              setTimeout(() => {
                console.log(JSON.stringify({
                  type: 'command_accepted',
                  requestId: command.requestId,
                  commandType: 'prompt',
                }))
              }, 25)
            }
          })
        `,
      ],
    })
    const listenerEvents: string[] = []
    runner.onEvent(event => listenerEvents.push(event.type))
    await runner.start()
    let settled = false

    const delivery = runner
      .send({
        type: 'prompt',
        requestId: 'request-correlated',
        message: 'Continue',
        behavior: 'steer',
      } as AgentRunnerCommand)
      .then(() => {
        settled = true
      })
    await Bun.sleep(10)

    expect(settled).toBe(false)
    await delivery
    expect(listenerEvents).toEqual([])
    runner.kill()
  })

  test('puts locally composed MCP servers on the runner start frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const runner = new FakeRunner()
    const resolvedSessionIds: Array<string | undefined> = []
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 1 }),
      mcpServers: (sessionId, launch) => {
        resolvedSessionIds.push(launch.integrations === true ? sessionId : undefined)
        return {
          integrations: {
            type: 'http',
            url: `https://api.duet.test/v1/ws/acme/agent/sessions/${sessionId}/integrations/mcp`,
            headers: { authorization: 'Bearer duet-key' },
          },
        }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_mcp',
      prompt: 'list integrations',
      behavior: 'steer',
      tier: 'balanced' as const,
      integrations: true,
    })

    expect(runner.commands[0]).toEqual({
      type: 'start',
      options: { model: 'balanced' },
      mode: 'auto',
      mcpServers: {
        integrations: {
          type: 'http',
          url: 'https://api.duet.test/v1/ws/acme/agent/sessions/sess_mcp/integrations/mcp',
          headers: { authorization: 'Bearer duet-key' },
        },
      },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_mcp',
      prompt: 'continue with changed access',
      behavior: 'steer',
      tier: 'balanced' as const,
      integrations: true,
    })
    expect(resolvedSessionIds).toEqual(['sess_mcp'])
  })

  test('a spawn failure releases the turn lock for the retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    let attempts = 0
    const healthy = new FakeRunner()
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => {
        attempts += 1
        if (attempts === 1) {
          const failing = new FakeRunner()
          failing.start = async () => {
            throw new Error('spawn ENOENT')
          }
          return failing
        }
        return healthy
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await expect(
      deliverPromptWithReceipt(controller, {
        sessionId: 'sess_leak',
        prompt: 'first attempt',
        behavior: 'steer',
        tier: 'balanced',
      }),
    ).rejects.toThrow('spawn ENOENT')

    await deliverPrompt(controller, {
      sessionId: 'sess_leak',
      prompt: 'second attempt',
      behavior: 'steer',
      tier: 'balanced',
    })
    expect(attempts).toBe(2)
    expect(healthy.commands.some(command => command.type === 'prompt')).toBe(true)
  })

  test('a dead runner without a terminal event yields the turn lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const zombie = new FakeRunner()
    const healthy = new FakeRunner()
    let attempts = 0
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => {
        attempts += 1
        return attempts === 1 ? zombie : healthy
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_zombie',
      prompt: 'doomed turn',
      behavior: 'steer',
      tier: 'balanced',
    })
    // The runner process dies without ever emitting a terminal event.
    zombie.kill()

    await deliverPrompt(controller, {
      sessionId: 'sess_zombie',
      prompt: 'recovery turn',
      behavior: 'steer',
      tier: 'balanced',
    })
    expect(attempts).toBe(2)
    expect(healthy.commands.some(command => command.type === 'prompt')).toBe(true)
  })

  test('dead-runner answer respawns with the resume cwd, cursor, and tier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const driveDir = join(root, 'drive')
    await mkdir(join(driveDir, 'sub'), { recursive: true })
    const factoryCalls: AgentRunnerFactoryArgs[] = []
    const runners: FakeRunner[] = []
    let nextSeq = 40
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir,
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryCalls.push(args)
        const runner = new FakeRunner()
        runners.push(runner)
        return runner
      },
      relayEvent: async () => ({ seq: (nextSeq += 1) }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_resume',
      prompt: 'begin',
      behavior: 'steer',
      cwd: 'sub',
      throughSeq: 41,
      tier: 'balanced',
    })
    await waitFor(() => nextSeq === 41)
    // Killing it directly, with no terminal event, is exactly a crash: the
    // coordinator's own exit listener now reports that as seq 42 before the
    // answer below ever gets a chance to respawn anything.
    runners[0]!.kill()
    await waitFor(() => nextSeq === 42)

    await deliverAnswer(controller, 'sess_resume', {
      answer: 'continue',
      throughSeq: 42,
      launch: { cwd: 'sub', tier: 'openai-frontier' },
    })
    await waitFor(() => nextSeq === 43)

    expect(factoryCalls).toHaveLength(2)
    expect(factoryCalls[1]!.cwd).toBe('sub')
    const respawn = defaultRunnerFactory(factoryCalls[1]!, driveDir)
    const argv = (respawn as unknown as { options: ProcessRunnerOptions }).options.args
    expect(argv).toContain('--model')
    expect(argv[argv.indexOf('--model') + 1]).toBe('openai-frontier')

    const replay = controller.subscribeToEvents('sess_resume', 0)
    expect((await replay[Symbol.asyncIterator]().next()).value?.seq).toBe(43)
    replay.close()
  })

  test('a bound session with a deleted cwd respawns at its anchor and durably warns before answering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-cwd-fallback-'))
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    const requestedCwd = 'agents/reviewer/deleted'
    await mkdir(join(driveDir, requestedCwd), { recursive: true })
    const factoryCalls: AgentRunnerFactoryArgs[] = []
    const firstRunner = new FakeRunner()
    const fallbackRunner = new FakeRunner()
    const runners = [firstRunner, fallbackRunner]
    const relayed: AgentTurnEvent[] = []
    let relaySeq = 0
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => [projectedAgentAnchor('reviewer', 'agents/reviewer', 'agent_reviewer')],
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryCalls.push(args)
        return runners.shift()!
      },
      relayEvent: async (_sessionId, _relayId, event) => {
        relayed.push(event)
        return { seq: (relaySeq += 1) }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_bound_deleted',
      prompt: 'first',
      behavior: 'steer',
      cwd: requestedCwd,
      tier: 'balanced',
      throughSeq: 1,
    })
    expect(factoryCalls[0]?.cwd).toBe(requestedCwd)
    expect(relayed.some(event => event.type === 'system')).toBe(false)
    firstRunner.kill()
    await rm(join(driveDir, requestedCwd), { recursive: true })

    await deliverPrompt(controller, {
      sessionId: 'sess_bound_deleted',
      prompt: 'second',
      behavior: 'follow_up',
      cwd: requestedCwd,
      tier: 'balanced',
      throughSeq: 2,
    })
    fallbackRunner.emitEvent({
      type: 'complete',
      state: runningTurnState(),
      status: 'completed',
      result: 'fallback answer',
    })
    await waitFor(() => relayed.some(event => event.type === 'complete'))

    expect(factoryCalls[1]?.cwd).toBe('agents/reviewer')
    expect(relayed).toContainEqual({
      type: 'system',
      level: 'warn',
      message:
        'The session folder "agents/reviewer/deleted" is unavailable. Continuing from "agents/reviewer".',
      metadata: { code: 'session_cwd_fallback' },
    })
    expect(relayed).toContainEqual(
      expect.objectContaining({ type: 'complete', result: 'fallback answer' }),
    )
  })

  test('a default session with a deleted cwd respawns at drive root with a warning and answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-default-fallback-'))
    const driveDir = join(root, 'drive')
    const requestedCwd = 'deleted'
    await mkdir(join(driveDir, requestedCwd), { recursive: true })
    const firstRunner = new FakeRunner()
    const fallbackRunner = new FakeRunner()
    const runners = [firstRunner, fallbackRunner]
    const factoryCalls: AgentRunnerFactoryArgs[] = []
    const relayed: AgentTurnEvent[] = []
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir,
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryCalls.push(args)
        return runners.shift()!
      },
      relayEvent: async (_sessionId, _relayId, event) => {
        relayed.push(event)
        return { seq: relayed.length }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_default_deleted',
      prompt: 'first',
      behavior: 'steer',
      cwd: requestedCwd,
      tier: 'balanced',
      throughSeq: 1,
    })
    firstRunner.kill()
    await rm(join(driveDir, requestedCwd), { recursive: true })
    await deliverPrompt(controller, {
      sessionId: 'sess_default_deleted',
      prompt: 'second',
      behavior: 'follow_up',
      cwd: requestedCwd,
      tier: 'balanced',
      throughSeq: 2,
    })
    fallbackRunner.emitEvent({
      type: 'complete',
      state: runningTurnState(),
      status: 'completed',
      result: 'root answer',
    })
    await waitFor(() => relayed.some(event => event.type === 'complete'))

    expect(factoryCalls[1]?.cwd).toBeUndefined()
    expect(relayed).toContainEqual({
      type: 'system',
      level: 'warn',
      message: 'The session folder "deleted" is unavailable. Continuing from "/".',
      metadata: { code: 'session_cwd_fallback' },
    })
    expect(relayed).toContainEqual(expect.objectContaining({ result: 'root answer' }))
  })

  test('a bound session settles without spawning when its anchor leaves the registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-missing-anchor-'))
    const driveDir = join(root, 'drive')
    await mkdir(join(driveDir, 'agents', 'reviewer'), { recursive: true })
    let anchors = [projectedAgentAnchor('reviewer', 'agents/reviewer', 'agent_reviewer')]
    const firstRunner = new FakeRunner()
    const relayed: AgentTurnEvent[] = []
    let factoryCalls = 0
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir,
      memoryDbPath: join(root, 'memory.db'),
      anchors: () => anchors,
      getVmToken: async () => null,
      runnerFactory: () => {
        factoryCalls += 1
        return firstRunner
      },
      relayEvent: async (_sessionId, _relayId, event) => {
        relayed.push(event)
        return { seq: relayed.length }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_missing_bound_anchor',
      prompt: 'first',
      behavior: 'steer',
      cwd: 'agents/reviewer',
      tier: 'balanced',
      throughSeq: 1,
    })
    firstRunner.kill()
    anchors = []

    await expect(
      deliverPromptWithReceipt(controller, {
        sessionId: 'sess_missing_bound_anchor',
        prompt: 'second',
        behavior: 'follow_up',
        cwd: 'agents/reviewer',
        tier: 'balanced',
        throughSeq: 2,
      }),
    ).resolves.toMatchObject({ acceptedThroughSeq: 2, disposition: 'settled' })
    expect(factoryCalls).toBe(1)
    expect(relayed).toContainEqual({
      type: 'system',
      level: 'error',
      message: 'This session’s bound agent folder is unavailable on the new workspace VM.',
      metadata: { code: 'bound_agent_root_unavailable' },
    })
  })

  test('a fresh VM derives a missing bound-agent root from the durable cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-fresh-missing-agent-'))
    const driveDir = join(root, 'drive')
    await mkdir(driveDir, { recursive: true })
    const relayed: AgentTurnEvent[] = []
    let factoryCalls = 0
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir,
      memoryDbPath: join(root, 'memory.db'),
      anchors: () => [projectedAgentAnchor('reviewer', 'agents/reviewer', 'agent_reviewer')],
      getVmToken: async () => null,
      runnerFactory: () => {
        factoryCalls += 1
        return new FakeRunner()
      },
      relayEvent: async (_sessionId, _relayId, event) => {
        relayed.push(event)
        return { seq: relayed.length }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await expect(
      deliverPromptWithReceipt(controller, {
        sessionId: 'sess_fresh_missing_agent',
        prompt: 'continue',
        behavior: 'steer',
        cwd: 'agents/reviewer/deleted-project',
        tier: 'balanced',
      }),
    ).resolves.toMatchObject({ acceptedThroughSeq: 1, disposition: 'settled' })
    expect(factoryCalls).toBe(0)
    expect(relayed).toContainEqual(
      expect.objectContaining({
        type: 'system',
        metadata: { code: 'bound_agent_root_unavailable' },
      }),
    )
  })

  test('a scheduled wake spawns from the accepted cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-cwd-wake-'))
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    await mkdir(join(driveDir, 'before'), { recursive: true })
    await mkdir(join(driveDir, 'after'), { recursive: true })
    await createAgentSessionLedger({ stateDir, now: () => 1 }).write({
      version: 1,
      sessionId: 'sess_cwd_wake',
      launch: { cwd: 'before', tier: 'balanced' },
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
      updatedAt: 1,
    })
    let now = 1
    const timers: Array<() => void> = []
    const factoryCalls: AgentRunnerFactoryArgs[] = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryCalls.push(args)
        return new FakeRunner()
      },
      relayEvent: async () => ({ seq: 2 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => now,
      setTimer: callback => {
        timers.push(callback)
        return callback
      },
      clearTimer: () => undefined,
    })

    await expect(controller.setCwd('sess_cwd_wake', 'after')).resolves.toEqual({ cwd: 'after' })
    now = 100
    timers[0]?.()
    await waitFor(() => factoryCalls.length === 1)

    expect(factoryCalls[0]?.cwd).toBe('after')
  })

  test('moving a parked ask kills it and the answer rehydrates under the accepted cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-cwd-ask-'))
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    await mkdir(join(driveDir, 'before'), { recursive: true })
    await mkdir(join(driveDir, 'after'), { recursive: true })
    const firstRunner = new FakeRunner()
    const resumedRunner = new FakeRunner()
    const runners = [firstRunner, resumedRunner]
    const factoryCalls: AgentRunnerFactoryArgs[] = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryCalls.push(args)
        return runners.shift()!
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })
    await deliverPrompt(controller, {
      sessionId: 'sess_cwd_ask',
      prompt: 'start',
      behavior: 'steer',
      cwd: 'before',
      throughSeq: 1,
      tier: 'balanced',
    })
    firstRunner.emitEvent({
      type: 'ask',
      state: {
        status: 'waiting_for_human',
        mode: 'agent',
        agent: { status: 'waiting', messages: [] },
      },
      questions: [{ question: 'Approve?', options: [] }],
    })
    await waitFor(async () => {
      const envelope = await createAgentSessionLedger({ stateDir, now: Date.now }).read(
        'sess_cwd_ask',
      )
      return envelope?.checkpoint?.terminalType === 'ask'
    })

    await controller.setCwd('sess_cwd_ask', 'after')

    expect(firstRunner.isAlive()).toBe(false)
    expect(controller.has('sess_cwd_ask')).toBe(false)
    await deliverAnswer(controller, 'sess_cwd_ask', {
      answer: 'approved',
      throughSeq: 2,
      launch: { cwd: 'after', tier: 'balanced' },
    })
    expect(factoryCalls.map(call => call.cwd)).toEqual(['before', 'after'])
    expect(resumedRunner.commands).toContainEqual({
      type: 'prompt',
      requestId: 'test:sess_cwd_ask:2',
      message: 'approved',
      behavior: 'follow_up',
    })
  })

  test('a move during a running turn retires the runner once it parks at ask', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-cwd-midturn-'))
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    await mkdir(join(driveDir, 'before'), { recursive: true })
    await mkdir(join(driveDir, 'after'), { recursive: true })
    const firstRunner = new FakeRunner()
    const resumedRunner = new FakeRunner()
    const runners = [firstRunner, resumedRunner]
    const factoryCalls: AgentRunnerFactoryArgs[] = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryCalls.push(args)
        return runners.shift()!
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })
    await deliverPrompt(controller, {
      sessionId: 'sess_cwd_midturn',
      prompt: 'start',
      behavior: 'steer',
      cwd: 'before',
      throughSeq: 1,
      tier: 'balanced',
    })

    // The move lands while the turn is still running: no checkpoint yet, so
    // the runner survives — the agent that issued the curl must finish.
    await expect(controller.setCwd('sess_cwd_midturn', 'after')).resolves.toEqual({ cwd: 'after' })
    expect(firstRunner.isAlive()).toBe(true)

    firstRunner.emitEvent({
      type: 'ask',
      state: {
        status: 'waiting_for_human',
        mode: 'agent',
        agent: { status: 'waiting', messages: [] },
      },
      questions: [{ question: 'Approve?', options: [] }],
    })
    await waitFor(async () => {
      const envelope = await createAgentSessionLedger({ stateDir, now: Date.now }).read(
        'sess_cwd_midturn',
      )
      return envelope?.checkpoint?.terminalType === 'ask'
    })

    // The answer must not reach the stale-cwd runner: it retires and the
    // checkpoint rehydrates a fresh spawn under the accepted directory.
    await deliverAnswer(controller, 'sess_cwd_midturn', {
      answer: 'approved',
      throughSeq: 2,
      launch: { cwd: 'after', tier: 'balanced' },
    })
    expect(firstRunner.isAlive()).toBe(false)
    expect(factoryCalls.map(call => call.cwd)).toEqual(['before', 'after'])
    expect(resumedRunner.commands).toContainEqual({
      type: 'prompt',
      requestId: 'test:sess_cwd_midturn:2',
      message: 'approved',
      behavior: 'follow_up',
    })
  })

  test('serializes two concurrent cwd updates to one session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-cwd-concurrent-'))
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    await mkdir(join(driveDir, 'one'), { recursive: true })
    await mkdir(join(driveDir, 'two'), { recursive: true })
    await createAgentSessionLedger({ stateDir, now: () => 1 }).write({
      version: 1,
      sessionId: 'sess_cwd_concurrent',
      launch: { cwd: 'one', tier: 'balanced' },
      acceptedThroughSeq: 0,
      inFlightCommands: [],
      relayOutbox: [],
      updatedAt: 1,
    })
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
    })

    await expect(
      Promise.all([
        controller.setCwd('sess_cwd_concurrent', 'one'),
        controller.setCwd('sess_cwd_concurrent', 'two'),
      ]),
    ).resolves.toEqual([{ cwd: 'one' }, { cwd: 'two' }])
    expect(
      (await createAgentSessionLedger({ stateDir, now: Date.now }).read('sess_cwd_concurrent'))
        ?.launch.cwd,
    ).toBe('two')
  })

  test('a cwd fallback warning survives a gateway reconnect in durable relay history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-fallback-reconnect-'))
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    const requestedCwd = 'deleted'
    await mkdir(join(driveDir, requestedCwd), { recursive: true })
    const firstRunner = new FakeRunner()
    const fallbackRunner = new FakeRunner()
    const runners = [firstRunner, fallbackRunner]
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runners.shift()!,
      relayEvent: async () => {
        throw new Error('disconnected')
      },
      setTimer: callback => callback,
      clearTimer: () => undefined,
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_fallback_reconnect',
      prompt: 'first',
      behavior: 'steer',
      cwd: requestedCwd,
      tier: 'balanced',
      throughSeq: 1,
    })
    firstRunner.kill()
    await rm(join(driveDir, requestedCwd), { recursive: true })
    await deliverPrompt(controller, {
      sessionId: 'sess_fallback_reconnect',
      prompt: 'second',
      behavior: 'follow_up',
      cwd: requestedCwd,
      tier: 'balanced',
      throughSeq: 2,
    })
    const reconnectedLedger = createAgentSessionLedger({ stateDir, now: () => 0 })
    const persisted = await reconnectedLedger.read('sess_fallback_reconnect')
    expect(persisted?.relayOutbox).toContainEqual(
      expect.objectContaining({
        relayId: expect.any(String),
        event: {
          type: 'system',
          level: 'warn',
          message: 'The session folder "deleted" is unavailable. Continuing from "/".',
          metadata: { code: 'session_cwd_fallback' },
        },
      }),
    )
  })

  test('default root runner includes the required tier and developer prompt in argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const driveDir = join(root, 'drive')
    const cwd = join(driveDir, 'project')
    const memoryDbPath = join(root, 'memory.db')
    await mkdir(cwd, { recursive: true })

    const runner = defaultRunnerFactory(
      {
        sessionId: 'sess_argv',
        cwd: 'project',
        tier: 'balanced',
        memoryDbPath,
        systemPromptFiles: [],
      },
      driveDir,
    )

    const argv = (runner as unknown as { options: ProcessRunnerOptions }).options.args

    expect(argv).toEqual([
      '--rpc',
      '--session',
      'sess_argv',
      '--workdir',
      cwd,
      '--db',
      memoryDbPath,
      '--model',
      'balanced',
      '--system-prompt',
      DEVELOPER_SYSTEM_PROMPT,
    ])
  })

  test('default runner names the session db so a shell command can reach it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-db-env-'))
    const driveDir = join(root, 'drive')
    await mkdir(driveDir, { recursive: true })
    const memoryDbPath = join(root, 'state', 'agents', 'anchor_1', 'memory.db')

    const runner = defaultRunnerFactory(
      {
        sessionId: 'sess_db_env',
        tier: 'balanced',
        memoryDbPath,
        systemPromptFiles: [],
        env: { DUET_SESSION_MEMORY_DB: 'caller-cannot-override' },
      },
      driveDir,
    )
    const options = (runner as unknown as { options: ProcessRunnerOptions }).options

    // `duet memory add --db` from a tool call would otherwise default to the
    // drive root's database, writing one agent's note into another's memory.
    expect(options.env?.DUET_SESSION_MEMORY_DB).toBe(memoryDbPath)
  })

  test('default runner owns DUET_SESSION_ID while preserving model environment keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-session-env-'))
    const driveDir = join(root, 'drive')
    await mkdir(driveDir, { recursive: true })

    const runner = defaultRunnerFactory(
      {
        sessionId: 'sess_environment',
        tier: 'balanced',
        memoryDbPath: join(root, 'memory.db'),
        systemPromptFiles: [],
        env: {
          DUET_SESSION_ID: 'caller-cannot-override',
          DUET_MODEL_API_KEY: 'model-key-survives',
        },
      },
      driveDir,
    )
    const options = (runner as unknown as { options: ProcessRunnerOptions }).options

    expect(options.env).toEqual({
      DUET_SESSION_ID: 'sess_environment',
      DUET_SESSION_MEMORY_DB: join(root, 'memory.db'),
      DUET_MODEL_API_KEY: 'model-key-survives',
    })
  })

  test('default runner appends one absolute boundary prompt file after the per-agent db', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-agent-'))
    const driveDir = join(root, 'drive')
    const cwd = join(driveDir, 'agents', 'reviewer', 'work')
    const systemPromptFile = join(driveDir, 'agents', 'reviewer', 'AGENTS.md')
    const memoryDbPath = join(root, 'state', 'agents', 'anchor_1', 'memory.db')
    await mkdir(cwd, { recursive: true })

    const runner = defaultRunnerFactory(
      {
        sessionId: 'sess_agent_argv',
        cwd: 'agents/reviewer/work',
        tier: 'balanced',
        memoryDbPath,
        systemPromptFiles: [systemPromptFile],
      },
      driveDir,
    )
    const argv = (runner as unknown as { options: ProcessRunnerOptions }).options.args

    expect(argv).toEqual([
      '--rpc',
      '--session',
      'sess_agent_argv',
      '--workdir',
      cwd,
      '--db',
      memoryDbPath,
      '--model',
      'balanced',
      '--system-prompt',
      DEVELOPER_SYSTEM_PROMPT,
      '--system-prompt-file',
      systemPromptFile,
    ])
  })

  test('an onboarding launch uses the contained ONBOARDING.md prompt on first spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-onboarding-'))
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(agentRoot, 'AGENTS.md'), '# Reviewer')
    await writeFile(join(agentRoot, 'ONBOARDING.md'), '# Meet your reviewer')
    const factoryCalls: AgentRunnerFactoryArgs[] = []
    const runner = new FakeRunner()
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => [projectedAgentAnchor('reviewer', 'agents/reviewer', 'agent_reviewer')],
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryCalls.push(args)
        return runner
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await controller.deliverInput('sess_onboarding', {
      attemptId: 'onboarding-first',
      throughSeq: 1,
      input: { kind: 'prompt', message: 'Introduce yourself', behavior: 'steer' },
      launch: {
        cwd: 'agents/reviewer',
        tier: 'balanced',
        onboarding: true,
        mode: {
          name: 'must-not-run',
          prompt: 'Start a machine.',
          states: [{ kind: 'timer', name: 'wait', wakeAfterMs: 1_000 }],
        },
      },
    })

    expect(factoryCalls[0]?.systemPromptFiles).toContain(join(agentRoot, 'ONBOARDING.md'))
    expect(factoryCalls[0]?.systemPromptFiles).not.toContain(join(agentRoot, 'AGENTS.md'))
    expect(runner.commands[0]).toEqual({
      type: 'start',
      options: { model: 'balanced' },
      mode: 'auto',
    })
  })

  test('an ordinary launch keeps using the contained AGENTS.md prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-ordinary-agent-'))
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(agentRoot, 'AGENTS.md'), '# Reviewer')
    await writeFile(join(agentRoot, 'ONBOARDING.md'), '# Meet your reviewer')
    const factoryCalls: AgentRunnerFactoryArgs[] = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => [projectedAgentAnchor('reviewer', 'agents/reviewer', 'agent_reviewer')],
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryCalls.push(args)
        return new FakeRunner()
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_ordinary_agent',
      prompt: 'Review this',
      behavior: 'steer',
      cwd: 'agents/reviewer',
      tier: 'balanced',
    })

    expect(factoryCalls[0]?.systemPromptFiles).toEqual([
      join(stateDir, 'agents', 'reviewer', 'your-folder.md'),
      join(stateDir, 'agents', 'reviewer', 'your-session.md'),
      expect.stringContaining('showing-files.md'),
      join(agentRoot, 'AGENTS.md'),
    ])
  })

  test('provider wiring adds the generated apps layer to runner argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-apps-prompt-'))
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(agentRoot, 'AGENTS.md'), '# Reviewer')
    let argv: readonly string[] = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => [projectedAgentAnchor('reviewer', 'agents/reviewer', 'agent_reviewer')],
      apps: () => [
        {
          appId: 'review-app',
          slug: 'review-app',
          command: 'bun run dev',
          port: 3000,
          anchorPath: 'agents/reviewer/app',
          apiScopes: [],
          visibility: 'folder',
        },
      ],
      workspaceSlug: () => 'acme',
      getVmToken: async () => null,
      runnerFactory: args => {
        const runner = defaultRunnerFactory(args, driveDir)
        argv = (runner as unknown as { options: ProcessRunnerOptions }).options.args
        return new FakeRunner()
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_apps_prompt',
      prompt: 'Review this',
      behavior: 'steer',
      cwd: 'agents/reviewer',
      tier: 'balanced',
    })

    const flags = argv.flatMap((value, index) =>
      value === '--system-prompt-file' ? [argv[index + 1]] : [],
    )
    expect(flags).toEqual([
      join(stateDir, 'agents', 'reviewer', 'your-folder.md'),
      join(stateDir, 'agents', 'reviewer', 'your-apps.md'),
      join(stateDir, 'agents', 'reviewer', 'your-session.md'),
      expect.stringContaining('showing-files.md'),
      join(agentRoot, 'AGENTS.md'),
    ])
  })

  test('binds the first resolved anchor across a respawn after a nested agent appears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-bound-agent-'))
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    await mkdir(join(driveDir, 'agents', 'reviewer', 'security', 'work'), { recursive: true })
    let anchors: GatewayAnchor[] = [projectedAgentAnchor('outer', 'agents/reviewer', 'agent_outer')]
    const factoryCalls: AgentRunnerFactoryArgs[] = []
    const runners: FakeRunner[] = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => anchors,
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryCalls.push(args)
        const runner = new FakeRunner()
        runners.push(runner)
        return runner
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_bound_agent',
      prompt: 'first',
      behavior: 'steer',
      cwd: 'agents/reviewer/security/work',
      tier: 'balanced',
      throughSeq: 1,
    })
    runners[0]!.kill()
    anchors = [...anchors, projectedAgentAnchor('inner', 'agents/reviewer/security', 'agent_inner')]
    await deliverPrompt(controller, {
      sessionId: 'sess_bound_agent',
      prompt: 'second',
      behavior: 'follow_up',
      cwd: 'agents/reviewer/security/work',
      tier: 'balanced',
      throughSeq: 2,
    })

    expect(factoryCalls.map(call => call.memoryDbPath)).toEqual([
      join(stateDir, 'agents', 'outer', 'memory.db'),
      join(stateDir, 'agents', 'outer', 'memory.db'),
    ])
    expect(
      (await createAgentSessionLedger({ stateDir, now: () => 0 }).read('sess_bound_agent'))
        ?.agentAnchorId,
    ).toBe('outer')
  })

  test('discarding an agent kills its live runners and durably tombstones them, sparing other agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-agent-discard-'))
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    await mkdir(join(driveDir, 'agents', 'reviewer'), { recursive: true })
    await mkdir(join(driveDir, 'agents', 'writer'), { recursive: true })
    const runners: FakeRunner[] = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => [
        projectedAgentAnchor('reviewer', 'agents/reviewer', 'agent_reviewer'),
        projectedAgentAnchor('writer', 'agents/writer', 'agent_writer'),
      ],
      getVmToken: async () => null,
      runnerFactory: () => {
        const runner = new FakeRunner()
        runners.push(runner)
        return runner
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_reviewer',
      prompt: 'review',
      behavior: 'steer',
      cwd: 'agents/reviewer',
      tier: 'balanced',
    })
    await deliverPrompt(controller, {
      sessionId: 'sess_writer',
      prompt: 'write',
      behavior: 'steer',
      cwd: 'agents/writer',
      tier: 'balanced',
    })
    expect(runners.map(runner => runner.isAlive())).toEqual([true, true])

    const discarded = await controller.discardAgent('reviewer')

    expect(discarded).toEqual(['sess_reviewer'])
    expect(runners[0]!.isAlive()).toBe(false)
    expect(runners[1]!.isAlive()).toBe(true)
    expect(controller.has('sess_reviewer')).toBe(false)
    expect(controller.has('sess_writer')).toBe(true)
    await expect(
      controller.deliverInput('sess_reviewer', {
        attemptId: 'late-after-agent-delete',
        throughSeq: 9,
        input: { kind: 'prompt', message: 'too late', behavior: 'steer' },
        launch: { tier: 'balanced', cwd: 'agents/reviewer' },
      }),
    ).rejects.toThrow('discarded')
  })

  test('sends the durable launch envelope mode on a fresh runner start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-agent-mode-'))
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    await mkdir(agentRoot, { recursive: true })
    const mode = {
      name: 'review',
      prompt: 'Review carefully',
      states: [{ kind: 'timer' as const, name: 'wait', wakeAfterMs: 1_000 }],
    }
    const runner = new FakeRunner()
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => [projectedAgentAnchor('reviewer', 'agents/reviewer', 'agent_reviewer')],
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await controller.deliverInput('sess_envelope_mode', {
      attemptId: 'envelope-mode',
      throughSeq: 1,
      input: { kind: 'prompt', message: 'review', behavior: 'steer' },
      launch: { cwd: 'agents/reviewer', tier: 'balanced', mode },
    })

    expect(runner.commands[0]).toEqual({ type: 'start', options: { model: 'balanced' }, mode })
  })

  test('a fresh start without a launch envelope mode sends auto', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-auto-mode-'))
    const runner = new FakeRunner()
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, '.duet', 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_auto_mode',
      prompt: 'begin',
      behavior: 'steer',
      tier: 'balanced',
    })

    expect(runner.commands[0]).toEqual({
      type: 'start',
      options: { model: 'balanced' },
      mode: 'auto',
    })
  })

  test('an agent resume sends checkpoint state without rereading or sending mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-agent-resume-'))
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    await mkdir(join(agentRoot, 'agent.json'), { recursive: true })
    const state = runningTurnState()
    await createAgentSessionLedger({ stateDir, now: () => 1 }).write({
      version: 1,
      sessionId: 'sess_agent_resume',
      agentAnchorId: 'reviewer',
      launch: {
        cwd: 'agents/reviewer',
        tier: 'balanced',
        mode: {
          name: 'resume-must-use-checkpoint',
          prompt: 'This definition must not restart.',
          states: [{ kind: 'timer', name: 'wait', wakeAfterMs: 1_000 }],
        },
      },
      checkpoint: { state },
      acceptedThroughSeq: 1,
      inFlightCommands: [],
      relayOutbox: [],
      updatedAt: 1,
    })
    const runner = new FakeRunner()
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => [projectedAgentAnchor('reviewer', 'agents/reviewer', 'agent_reviewer')],
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 2 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_agent_resume',
      prompt: 'continue',
      behavior: 'follow_up',
      cwd: 'agents/reviewer',
      tier: 'balanced',
      throughSeq: 2,
    })

    expect(runner.commands[0]).toEqual({ type: 'start', options: { model: 'balanced' }, state })
    expect(await Bun.file(join(stateDir, 'agents', 'reviewer', 'logs.log')).exists()).toBe(false)
  })

  test('live-runner answer reuses the existing process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const runners: FakeRunner[] = []
    let factoryCalls = 0
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => {
        factoryCalls += 1
        const runner = new FakeRunner()
        runners.push(runner)
        return runner
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_live',
      prompt: 'begin',
      behavior: 'steer',
      tier: 'balanced',
    })
    await deliverAnswer(controller, 'sess_live', {
      answer: 'approved',
      throughSeq: 99,
      launch: { cwd: 'ignored', tier: 'frontier' },
    })

    expect(factoryCalls).toBe(1)
    expect(runners[0]!.commands.at(-1)).toEqual({
      type: 'prompt',
      requestId: expect.any(String),
      message: 'approved',
      behavior: 'follow_up',
    })

    // Reusing the live process must not mean persisting the launch it started
    // with. Wake and crash recovery relaunch from this envelope, so a tier the
    // user switched to while the runner was alive has to be what lands on disk
    // — otherwise the switch silently reverts the next time the session wakes.
    expect(
      (
        await createAgentSessionLedger({ stateDir: join(root, '.duet'), now: () => 0 }).read(
          'sess_live',
        )
      )?.launch.tier,
    ).toBe('frontier')
  })

  test('a changed selection during a live turn is persisted without retargeting its process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const runner = new FakeRunner()
    let factoryCalls = 0
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => {
        factoryCalls += 1
        return runner
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_live_prompt',
      prompt: 'begin',
      behavior: 'steer',
      tier: 'openai-max',
    })
    await deliverPrompt(controller, {
      sessionId: 'sess_live_prompt',
      prompt: 'after this, compare staging',
      behavior: 'follow_up',
      tier: 'anthropic-frontier',
    })

    expect(factoryCalls).toBe(1)
    expect(runner.commands[0]).toMatchObject({ type: 'start', options: { model: 'openai-max' } })
    expect(
      (
        await createAgentSessionLedger({ stateDir: join(root, '.duet'), now: () => 0 }).read(
          'sess_live_prompt',
        )
      )?.launch.tier,
    ).toBe('anthropic-frontier')
    expect(runner.commands.at(-1)).toEqual({
      type: 'prompt',
      requestId: expect.any(String),
      message: 'after this, compare staging',
      behavior: 'follow_up',
    })
  })

  test('acknowledges a repeated input cursor without sending the prompt twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const runner = new FakeRunner()
    let releaseRunnerSetup: () => void = () => undefined
    const runnerSetupHeld = new Promise<void>(resolve => {
      releaseRunnerSetup = resolve
    })
    let setupCalls = 0
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => {
        setupCalls += 1
        await runnerSetupHeld
      },
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })
    const request = {
      sessionId: 'sess_idempotent',
      attemptId: 'sess_idempotent:2',
      prompt: 'send once',
      behavior: 'steer' as const,
      tier: 'balanced' as const,
    }

    const first = deliverPrompt(controller, request)
    await waitFor(() => setupCalls === 1)
    const duplicate = deliverPrompt(controller, request)
    releaseRunnerSetup()
    await Promise.all([first, duplicate])

    expect(setupCalls).toBe(1)
    expect(
      runner.commands.filter(
        command => command.type === 'prompt' && command.message === 'send once',
      ),
    ).toHaveLength(1)
    await expect(
      deliverPrompt(controller, {
        ...request,
        attemptId: 'sess_idempotent:3',
        prompt: 'next input',
      }),
    ).resolves.toBeUndefined()
    expect(
      runner.commands.filter(
        command => command.type === 'prompt' && command.message === 'next input',
      ),
    ).toHaveLength(1)
  })

  test('keeps an accepted delivery acknowledged when activity recording fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const runner = new FakeRunner()
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })
    const request = {
      sessionId: 'sess_activity_failure',
      attemptId: 'sess_activity_failure:1',
      prompt: 'send once despite bookkeeping failure',
      behavior: 'steer' as const,
      tier: 'balanced' as const,
    }

    await expect(deliverPrompt(controller, request)).resolves.toBeUndefined()
    await expect(deliverPrompt(controller, request)).resolves.toBeUndefined()

    expect(
      runner.commands.filter(
        command =>
          command.type === 'prompt' && command.message === 'send once despite bookkeeping failure',
      ),
    ).toHaveLength(1)
  })

  test('serializes canonical relays so terminal output cannot overtake earlier steps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const runner = new FakeRunner()
    const relayed: string[] = []
    let releaseFirstStep: () => void = () => undefined
    const firstStepHeld = new Promise<void>(resolve => {
      releaseFirstStep = resolve
    })
    let nextSeq = 0
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async (_sessionId, _relayId, event) => {
        if (event.type === 'step' && event.step.type === 'text' && event.step.text === 'first') {
          await firstStepHeld
        }
        relayed.push(
          event.type === 'step' && event.step.type === 'text' ? event.step.text : event.type,
        )
        return { seq: (nextSeq += 1) }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_ordered',
      prompt: 'begin',
      behavior: 'steer',
      tier: 'balanced',
    })
    await waitFor(() => relayed.includes('turn_started'))
    runner.emitEvent({ type: 'step', step: { type: 'text', text: 'first' } })
    runner.emitEvent({ type: 'step', step: { type: 'text', text: 'second' } })
    runner.emitEvent({
      type: 'complete',
      state: {
        status: 'completed',
        mode: 'agent',
        agent: { status: 'completed', messages: [] },
      },
      status: 'completed',
      result: 'done',
    })

    await Bun.sleep(10)
    expect(relayed).toEqual(['turn_started'])
    releaseFirstStep()
    await waitFor(() => relayed.includes('complete'))
    expect(relayed).toEqual(['turn_started', 'first', 'second', 'complete'])
  })

  test('relay failure cannot block a local terminal checkpoint or runner retirement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const runner = new FakeRunner()
    let relayAvailable = false
    let nextSeq = 0
    const relayAttempts: Array<{
      relayId: string
      eventType: string
      acceptedThroughSeq?: number
    }> = []
    const retryCallbacks: Array<() => void> = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async (_sessionId, relayId, event, acceptedThroughSeq) => {
        relayAttempts.push({ relayId, eventType: event.type, acceptedThroughSeq })
        if (!relayAvailable) throw new Error('backend unavailable')
        return { seq: (nextSeq += 1) }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      setTimer: callback => {
        retryCallbacks.push(callback)
        return callback
      },
      clearTimer: () => undefined,
    })
    await deliverPrompt(controller, {
      sessionId: 'sess_local_terminal',
      prompt: 'work',
      behavior: 'steer',
      tier: 'balanced',
    })
    const state = {
      status: 'completed' as const,
      mode: 'agent' as const,
      agent: { status: 'completed' as const, messages: [] },
    }

    runner.emitEvent({ type: 'complete', state, status: 'completed', result: 'done' })
    await waitFor(() => controller.activeCount() === 0)

    expect(runner.isAlive()).toBe(false)
    const ledger = createAgentSessionLedger({ stateDir, now: () => 0 })
    expect(await ledger.read('sess_local_terminal')).toMatchObject({
      checkpoint: { state, terminalType: 'complete' },
      inFlightCommands: [],
      relayOutbox: [{ event: { type: 'turn_started' } }, { event: { type: 'complete', state } }],
    })
    expect(retryCallbacks).toHaveLength(1)
    expect(new Set(relayAttempts.map(attempt => attempt.relayId)).size).toBe(1)

    relayAvailable = true
    retryCallbacks[0]?.()
    await waitFor(async () => (await ledger.read('sess_local_terminal'))?.relayOutbox.length === 0)
    expect(new Set(relayAttempts.map(attempt => attempt.relayId)).size).toBe(2)
    expect(new Set(relayAttempts.map(attempt => attempt.acceptedThroughSeq))).toEqual(new Set([1]))
    expect(
      relayAttempts
        .filter(attempt => attempt.eventType === 'turn_started')
        .map(attempt => attempt.relayId),
    ).toEqual(
      relayAttempts
        .filter(attempt => attempt.eventType === 'turn_started')
        .map(() => relayAttempts[0]!.relayId),
    )
  })

  test('quiesce cancels an absent sleeper without changing its resumable checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const sleepingState = {
      status: 'sleeping' as const,
      mode: 'agent' as const,
      agent: { status: 'waiting' as const, messages: [] },
      followUpQueue: [{ message: 'queued work' }],
    }
    await createAgentSessionLedger({ stateDir, now: () => 1 }).write({
      version: 1,
      sessionId: 'sess_sleep_interrupt',
      launch: { cwd: 'project', tier: 'balanced' },
      checkpoint: { state: sleepingState, terminalType: 'sleep' },
      acceptedThroughSeq: 4,
      inFlightCommands: [],
      wake: { wakeAt: 100, generation: 1 },
      relayOutbox: [],
      updatedAt: 1,
    })
    const runner = new FakeRunner()
    const timers = new Set<() => void>()
    let quiesced = false
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 5 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      isQuiesced: () => quiesced,
      setTimer: callback => {
        timers.add(callback)
        return callback
      },
      clearTimer: timer => {
        timers.delete(timer as () => void)
      },
    })

    quiesced = true
    controller.setQuiesced(true)
    await waitFor(async () => {
      const envelope = await createAgentSessionLedger({ stateDir, now: () => 0 }).read(
        'sess_sleep_interrupt',
      )
      return envelope !== null && envelope.wake === undefined
    })

    expect(runner.commands).toEqual([])
    const envelope = await createAgentSessionLedger({ stateDir, now: () => 0 }).read(
      'sess_sleep_interrupt',
    )
    expect(envelope).toMatchObject({
      checkpoint: { state: sleepingState, terminalType: 'sleep' },
      inFlightCommands: [],
    })
    expect(envelope?.wake).toBeUndefined()
    await Bun.sleep(0)
    expect([...timers]).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  // False means no native runner received the stop, so the API still settles
  // queued backend input. It does not mean the local wake remains scheduled.
  test('an explicit absent-runner interrupt cancels the wake and leaves backend settlement to the API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const ledger = createAgentSessionLedger({ stateDir, now: () => 1 })
    await ledger.write({
      version: 1,
      sessionId: 'sess_explicit_interrupt_failure',
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
      wake: { wakeAt: 60_000, generation: 1 },
      relayOutbox: [],
      updatedAt: 1,
    })
    let launches = 0
    const before = await ledger.read('sess_explicit_interrupt_failure')
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => {
        launches += 1
        return new FakeRunner()
      },
      relayEvent: async () => ({ seq: 2 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 1,
    })

    expect(await controller.interrupt('sess_explicit_interrupt_failure')).toBe(false)
    const after = await ledger.read('sess_explicit_interrupt_failure')
    expect(after?.wake).toBeUndefined()
    expect(after?.checkpoint).toEqual(before?.checkpoint)
    expect(after?.inFlightCommands).toEqual([])
    expect(launches).toBe(0)
    expect(await controller.interrupt('sess_explicit_interrupt_failure')).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test('an explicit interrupt resolves only after its runner checkpoint is relayed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const runner = new InterruptingFakeRunner(interruptedTurnState())
    let releaseInterruptedRelay: () => void = () => undefined
    const interruptedRelayHeld = new Promise<void>(resolve => {
      releaseInterruptedRelay = resolve
    })
    let interruptedRelayStarted = false
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async (_sessionId, _relayId, event) => {
        if (event.type === 'interrupted') {
          interruptedRelayStarted = true
          await interruptedRelayHeld
        }
        return { seq: 1 }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })
    await deliverPrompt(controller, {
      sessionId: 'sess_interrupt_relay_boundary',
      prompt: 'start',
      behavior: 'steer',
      tier: 'balanced',
    })

    let interruptResolved = false
    const interrupt = controller.interrupt('sess_interrupt_relay_boundary').then(result => {
      interruptResolved = true
      return result
    })
    await waitFor(() => interruptedRelayStarted)
    await Bun.sleep(0)
    expect(interruptResolved).toBe(false)

    releaseInterruptedRelay()
    await expect(interrupt).resolves.toBe(true)
  })

  test('quiesce bounds live interrupts and settles the cohort past one failed runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const failedSessionId = 'sess_quiesce_00_failure'
    const successfulSessionIds = Array.from(
      { length: 6 },
      (_, index) => `sess_quiesce_${String(index + 1).padStart(2, '0')}`,
    )
    const ledger = createAgentSessionLedger({ stateDir, now: () => 1 })
    let activeInterrupts = 0
    let maximumConcurrentInterrupts = 0
    let quiesced = false
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: ({ sessionId }) => {
        if (sessionId === failedSessionId) {
          const failing = new FakeRunner()
          const send = failing.send.bind(failing)
          failing.send = async command => {
            if (command.type === 'interrupt') throw new Error('fixture live interrupt failure')
            await send(command)
          }
          return failing
        }
        return new (class extends FakeRunner {
          override async send(command: AgentRunnerCommand): Promise<void> {
            await super.send(command)
            if (command.type !== 'interrupt') return
            activeInterrupts += 1
            maximumConcurrentInterrupts = Math.max(maximumConcurrentInterrupts, activeInterrupts)
            await Bun.sleep(0)
            activeInterrupts -= 1
            this.emitEvent({ type: 'interrupted', state: interruptedTurnState() })
          }
        })()
      },
      relayEvent: async () => ({ seq: 2 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 1,
      isQuiesced: () => quiesced,
      setTimer: callback => callback,
      clearTimer: () => undefined,
    })

    for (const sessionId of [failedSessionId, ...successfulSessionIds]) {
      await deliverPrompt(controller, {
        sessionId,
        prompt: 'work',
        behavior: 'steer',
        tier: 'balanced',
      })
    }
    quiesced = true
    controller.setQuiesced(true)
    await waitFor(async () => {
      const envelopes = await Promise.all(
        successfulSessionIds.map(sessionId => ledger.read(sessionId)),
      )
      return envelopes.every(envelope => envelope?.checkpoint?.terminalType === 'interrupted')
    })
    const interruptedSessionIds = (
      await Promise.all(
        successfulSessionIds.map(async sessionId => ({
          sessionId,
          envelope: await ledger.read(sessionId),
        })),
      )
    )
      .filter(item => item.envelope?.checkpoint?.terminalType === 'interrupted')
      .map(item => item.sessionId)

    expect(maximumConcurrentInterrupts).toBeGreaterThan(0)
    expect(maximumConcurrentInterrupts).toBeLessThanOrEqual(4)
    expect(interruptedSessionIds).toEqual(successfulSessionIds)
    const failedEnvelope = await ledger.read(failedSessionId)
    expect(failedEnvelope).toMatchObject({
      checkpoint: { state: { status: 'running' } },
    })
    expect(failedEnvelope?.wake).toBeUndefined()
    expect(controller.activeCount()).toBe(0)
    controller.setQuiesced(false)
    await rm(root, { recursive: true, force: true })
  })

  test('a restarted quiesced gateway interrupts an overdue sleeper without dispatching its wake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    await createAgentSessionLedger({ stateDir, now: () => 10 }).write({
      version: 1,
      sessionId: 'sess_quiesced_wake',
      launch: { tier: 'balanced' },
      checkpoint: {
        state: {
          status: 'sleeping',
          mode: 'agent',
          agent: { status: 'waiting', messages: [] },
        },
        terminalType: 'sleep',
      },
      acceptedThroughSeq: 3,
      inFlightCommands: [],
      wake: { wakeAt: 10, generation: 1 },
      relayOutbox: [],
      updatedAt: 10,
    })
    const runner = new InterruptingFakeRunner(interruptedTurnState())
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 4 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 10,
      isQuiesced: () => true,
    })

    await waitFor(async () => {
      const envelope = await createAgentSessionLedger({ stateDir, now: () => 10 }).read(
        'sess_quiesced_wake',
      )
      return envelope !== null && envelope.wake === undefined
    })

    expect(controller.activeCount()).toBe(0)
    expect(runner.commands).toEqual([])
    expect(
      (await createAgentSessionLedger({ stateDir, now: () => 10 }).read('sess_quiesced_wake'))
        ?.checkpoint?.terminalType,
    ).toBe('sleep')
    await rm(root, { recursive: true, force: true })
  })

  test('unpausing a stopped sleeper requires new input and uses its latest requested tier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    await createAgentSessionLedger({ stateDir, now: () => 10 }).write({
      version: 1,
      sessionId: 'sess_resume_wake',
      launch: { tier: 'anthropic-max' },
      checkpoint: {
        state: {
          status: 'sleeping',
          mode: 'agent',
          agent: { status: 'waiting', messages: [] },
        },
        terminalType: 'sleep',
      },
      acceptedThroughSeq: 3,
      inFlightCommands: [],
      wake: { wakeAt: 10, generation: 1 },
      relayOutbox: [],
      updatedAt: 10,
    })
    let quiesced = true
    let launches = 0
    const launchTiers: string[] = []
    const resumedRunner = new FakeRunner()
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: args => {
        launches += 1
        launchTiers.push(args.tier)
        return resumedRunner
      },
      relayEvent: async () => ({ seq: 4 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 10,
      isQuiesced: () => quiesced,
    })
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await waitFor(async () => (await ledger.read('sess_resume_wake'))?.wake === undefined)
    expect(launches).toBe(0)

    quiesced = false
    controller.setQuiesced(false)
    await Bun.sleep(0)
    expect(resumedRunner.commands).toEqual([])
    await deliverPrompt(controller, {
      sessionId: 'sess_resume_wake',
      prompt: 'resume explicitly',
      behavior: 'steer',
      tier: 'anthropic-frontier',
      throughSeq: 4,
    })
    expect(resumedRunner.commands.map(command => command.type)).toEqual(['start', 'prompt'])
    expect(resumedRunner.commands.at(-1)).toMatchObject({
      type: 'prompt',
      message: 'resume explicitly',
      behavior: 'steer',
    })
    expect(launchTiers).toEqual(['anthropic-frontier'])
    expect((await ledger.read('sess_resume_wake'))?.launch.tier).toBe('anthropic-frontier')
    await controller.discard('sess_resume_wake')
    await rm(root, { recursive: true, force: true })
  })

  test('discarding a sleeping session removes its durable wake before it can run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const sessionId = 'sess_deleted_sleeper'
    await createAgentSessionLedger({ stateDir, now: () => 10 }).write({
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
      acceptedThroughSeq: 2,
      inFlightCommands: [],
      wake: { wakeAt: 100, generation: 1 },
      relayOutbox: [],
      updatedAt: 10,
    })
    const runners: FakeRunner[] = []
    const timers: Array<{ callback: () => void; cleared: boolean }> = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => {
        const runner = new FakeRunner()
        runners.push(runner)
        return runner
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 10,
      setTimer: callback => {
        const timer = { callback, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: timer => {
        ;(timer as { cleared: boolean }).cleared = true
      },
    })
    await waitFor(() => timers.length === 1)

    await expect(controller.discard(sessionId)).resolves.toBe(true)

    expect(timers[0]?.cleared).toBe(true)
    expect(await createAgentSessionLedger({ stateDir, now: () => 10 }).read(sessionId)).toBeNull()
    timers[0]?.callback()
    await Bun.sleep(5)
    expect(runners).toEqual([])
    await expect(
      controller.deliverInput(sessionId, {
        attemptId: 'late-after-delete',
        throughSeq: 3,
        input: { kind: 'prompt', message: 'too late', behavior: 'steer' },
        launch: { tier: 'balanced' },
      }),
    ).rejects.toThrow('discarded')
    expect(runners).toEqual([])
  })

  test('a failed durable discard leaves a sleeping session armed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const sessionId = 'sess_discard_commit_failure'
    await createAgentSessionLedger({ stateDir, now: () => 10 }).write({
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
      acceptedThroughSeq: 2,
      inFlightCommands: [],
      wake: { wakeAt: 100, generation: 1 },
      relayOutbox: [],
      updatedAt: 10,
    })
    const timers: Array<{ callback: () => void; cleared: boolean }> = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => new FakeRunner(),
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 10,
      setTimer: callback => {
        const timer = { callback, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: timer => {
        ;(timer as { cleared: boolean }).cleared = true
      },
    })
    await waitFor(() => timers.length === 1)
    const ledger = (
      controller as unknown as {
        ledger: { discard(id: string): Promise<boolean> }
      }
    ).ledger
    ledger.discard = async () => {
      throw new Error('fixture tombstone commit failure')
    }

    await expect(controller.discard(sessionId)).rejects.toThrow('tombstone commit failure')

    expect(timers[0]?.cleared).toBe(false)
    expect(
      await createAgentSessionLedger({ stateDir, now: () => 10 }).read(sessionId),
    ).toMatchObject({ wake: { wakeAt: 100, generation: 1 } })
  })

  test('discarding a session does not retry a relay that fails afterward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const sessionId = 'sess_deleted_relay'
    // The outbox lives in its own per-session store, and `write` clears the
    // envelope's copy — so a pending relay has to be seeded through the event
    // seam that appends to that store, not by embedding it in the envelope.
    const seedLedger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await seedLedger.write({
      version: 1,
      sessionId,
      launch: { tier: 'balanced' },
      acceptedThroughSeq: 2,
      inFlightCommands: [],
      relayOutbox: [],
      updatedAt: 10,
    })
    await seedLedger.recordRunnerEvent(sessionId, {
      type: 'step',
      step: { type: 'text', text: 'finished before delete' },
    })
    let relayAttempts = 0
    let resolveRelayStarted: () => void = () => undefined
    const relayStarted = new Promise<void>(resolve => {
      resolveRelayStarted = resolve
    })
    let rejectPendingRelay: (error: Error) => void = () => undefined
    const pendingRelay = new Promise<never>((_resolve, reject) => {
      rejectPendingRelay = reject
    })
    const timers: Array<{ callback: () => void; cleared: boolean }> = []
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => new FakeRunner(),
      relayEvent: async () => {
        relayAttempts += 1
        resolveRelayStarted()
        return await pendingRelay
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      setTimer: callback => {
        const timer = { callback, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: timer => {
        ;(timer as { cleared: boolean }).cleared = true
      },
    })
    await relayStarted

    const ledger = (
      controller as unknown as {
        ledger: { read(id: string): Promise<unknown> }
      }
    ).ledger
    const originalRead = ledger.read.bind(ledger)
    let reportRead: () => void = () => undefined
    const readObserved = new Promise<void>(resolve => {
      reportRead = resolve
    })
    let releaseRead: () => void = () => undefined
    const readReleased = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    let pauseNextRead = true
    ledger.read = async id => {
      const envelope = await originalRead(id)
      if (pauseNextRead) {
        pauseNextRead = false
        reportRead()
        await readReleased
      }
      return envelope
    }

    rejectPendingRelay(new Error('backend deleted the session'))
    await readObserved
    const discarded = controller.discard(sessionId)
    await Promise.resolve()
    await Promise.resolve()
    releaseRead()
    await discarded
    await Bun.sleep(5)

    expect(relayAttempts).toBe(1)
    expect(timers.filter(timer => !timer.cleared)).toEqual([])
  })

  test('quiesced boot interrupts a pending turn without replaying its accepted prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    await createAgentSessionLedger({ stateDir, now: () => 10 }).write({
      version: 1,
      sessionId: 'sess_quiesced_command',
      launch: { tier: 'balanced' },
      checkpoint: {
        state: {
          status: 'running',
          mode: 'agent',
          agent: { status: 'running', messages: [] },
        },
      },
      acceptedThroughSeq: 3,
      inFlightCommands: [
        {
          requestId: 'accepted-before-restart',
          throughSeq: 3,
          command: { type: 'prompt', message: 'keep working', behavior: 'steer' },
        },
      ],
      relayOutbox: [],
      updatedAt: 10,
    })
    const runner = new InterruptingFakeRunner(interruptedTurnState())
    createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 4 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 10,
      isQuiesced: () => true,
    })

    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await waitFor(
      async () => (await ledger.read('sess_quiesced_command'))?.inFlightCommands.length === 0,
    )
    expect(runner.commands).toEqual([])
    expect((await ledger.read('sess_quiesced_command'))?.checkpoint?.state).toEqual({
      status: 'running',
      mode: 'agent',
      agent: { status: 'running', messages: [] },
    })
    expect((await ledger.read('sess_quiesced_command'))?.wake).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  test('boot dispatches an overdue durable wake through the native wake command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const sleepingState = {
      status: 'sleeping' as const,
      mode: 'agent' as const,
      agent: { status: 'waiting' as const, messages: [] },
    }
    await createAgentSessionLedger({ stateDir, now: () => 10 }).write({
      version: 1,
      sessionId: 'sess_overdue_wake',
      launch: { tier: 'balanced' },
      checkpoint: { state: sleepingState, terminalType: 'sleep' },
      acceptedThroughSeq: 3,
      inFlightCommands: [],
      wake: { wakeAt: 10, generation: 1 },
      relayOutbox: [],
      updatedAt: 10,
    })
    const runner = new FakeRunner()
    createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 4 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 20,
      createRequestId: () => 'wake-request-1',
    })

    await waitFor(() => runner.commands.some(command => command.type === 'wake'))

    expect(runner.commands).toEqual([
      { type: 'start', options: { model: 'balanced' }, state: sleepingState },
      { type: 'wake', requestId: 'wake-request-1' },
    ])
    const envelope = await createAgentSessionLedger({ stateDir, now: () => 0 }).read(
      'sess_overdue_wake',
    )
    expect(envelope?.wake).toBeUndefined()
    expect(envelope?.inFlightCommands).toEqual([
      { requestId: 'wake-request-1', command: { type: 'wake' } },
    ])
  })

  test('an overdue wake inherits bound cwd fallback before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-fallback-wake-'))
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const anchorPath = 'agents/reviewer'
    await mkdir(join(driveDir, anchorPath), { recursive: true })
    const sleepingState = {
      status: 'sleeping' as const,
      mode: 'agent' as const,
      agent: { status: 'waiting' as const, messages: [] },
    }
    await createAgentSessionLedger({ stateDir, now: () => 10 }).write({
      version: 1,
      sessionId: 'sess_fallback_wake',
      agentAnchorId: 'reviewer',
      launch: {
        cwd: 'agents/reviewer/deleted',
        tier: 'balanced',
      },
      checkpoint: { state: sleepingState, terminalType: 'sleep' },
      acceptedThroughSeq: 3,
      inFlightCommands: [],
      wake: { wakeAt: 10, generation: 1 },
      relayOutbox: [],
      updatedAt: 10,
    })
    const runner = new FakeRunner()
    const factoryCalls: AgentRunnerFactoryArgs[] = []
    const relayed: AgentTurnEvent[] = []
    createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(root, 'memory.db'),
      anchors: () => [projectedAgentAnchor('reviewer', anchorPath, 'agent_reviewer')],
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryCalls.push(args)
        return runner
      },
      relayEvent: async (_sessionId, _relayId, event) => {
        relayed.push(event)
        return { seq: relayed.length }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 20,
      createRequestId: () => 'fallback-wake-request',
    })

    await waitFor(() => runner.commands.some(command => command.type === 'wake'))

    expect(factoryCalls[0]?.cwd).toBe(anchorPath)
    expect(runner.commands).toContainEqual({
      type: 'wake',
      requestId: 'fallback-wake-request',
    })
    expect(relayed).toContainEqual(expect.objectContaining({ type: 'system', level: 'warn' }))
  })

  test('an overdue wake keeps the onboarding prompt from the durable launch envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-onboarding-wake-'))
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(agentRoot, 'AGENTS.md'), '# Reviewer')
    await writeFile(join(agentRoot, 'ONBOARDING.md'), '# Meet your reviewer')
    await createAgentSessionLedger({ stateDir, now: () => 10 }).write({
      version: 1,
      sessionId: 'sess_onboarding_wake',
      agentAnchorId: 'reviewer',
      launch: {
        cwd: 'agents/reviewer',
        tier: 'balanced',
        onboarding: true,
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
      wake: { wakeAt: 10, generation: 1 },
      relayOutbox: [],
      updatedAt: 10,
    })
    const factoryCalls: AgentRunnerFactoryArgs[] = []
    const runner = new FakeRunner()

    createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => [projectedAgentAnchor('reviewer', 'agents/reviewer', 'agent_reviewer')],
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryCalls.push(args)
        return runner
      },
      relayEvent: async () => ({ seq: 2 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 20,
      createRequestId: () => 'onboarding-wake',
    })

    await waitFor(() => runner.commands.some(command => command.type === 'wake'))

    expect(factoryCalls[0]?.systemPromptFiles).toContain(join(agentRoot, 'ONBOARDING.md'))
    expect(factoryCalls[0]?.systemPromptFiles).not.toContain(join(agentRoot, 'AGENTS.md'))
  })

  test('an overdue wake below the reserve settles idle without spawning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    await createAgentSessionLedger({ stateDir, now: () => 10 }).write({
      version: 1,
      sessionId: 'sess_full_wake',
      launch: { tier: 'balanced' },
      checkpoint: {
        state: {
          status: 'sleeping',
          mode: 'agent',
          agent: { status: 'waiting', messages: [] },
        },
        terminalType: 'sleep',
      },
      acceptedThroughSeq: 3,
      inFlightCommands: [],
      wake: { wakeAt: 10, generation: 1 },
      relayOutbox: [],
      updatedAt: 10,
    })
    let factoryCalls = 0
    const relayed: AgentTurnEvent[] = []
    createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      diskGuard: { ensureWritable: async () => 'full' },
      runnerFactory: () => {
        factoryCalls += 1
        return new FakeRunner()
      },
      relayEvent: async (_sessionId, _relayId, event) => {
        relayed.push(event)
        return { seq: 4 }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 20,
      createRequestId: () => 'wake-request-full',
    })

    await waitFor(() => relayed.length === 1)

    expect(factoryCalls).toBe(0)
    expect(relayed[0]).toMatchObject({
      type: 'system',
      level: 'error',
      metadata: { code: 'storage_full' },
    })
    const envelope = await createAgentSessionLedger({ stateDir, now: () => 0 }).read(
      'sess_full_wake',
    )
    expect(envelope?.wake).toBeUndefined()
    expect(envelope?.inFlightCommands).toEqual([])
  })

  test('a durable wake beyond the native timer horizon is re-armed instead of firing early', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const wakeAt = 30 * 24 * 60 * 60 * 1_000
    const sleepingState = {
      status: 'sleeping' as const,
      mode: 'agent' as const,
      agent: { status: 'waiting' as const, messages: [] },
    }
    await createAgentSessionLedger({ stateDir, now: () => 0 }).write({
      version: 1,
      sessionId: 'sess_long_horizon_wake',
      launch: { tier: 'balanced' },
      checkpoint: { state: sleepingState, terminalType: 'sleep' },
      acceptedThroughSeq: 3,
      inFlightCommands: [],
      wake: { wakeAt, generation: 1 },
      relayOutbox: [],
      updatedAt: 0,
    })
    let now = 0
    const timers: Array<{ callback: () => void; delayMs: number }> = []
    const runner = new FakeRunner()
    createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 4 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => now,
      createRequestId: () => 'long-horizon-wake',
      setTimer: (callback, delayMs) => {
        const timer = { callback, delayMs }
        timers.push(timer)
        return timer
      },
      clearTimer: () => undefined,
    })

    await waitFor(() => timers.length === 1)
    expect(timers[0]!.delayMs).toBeLessThanOrEqual(2_147_483_647)
    now = timers[0]!.delayMs
    timers[0]!.callback()
    await waitFor(() => timers.length === 2)

    expect(runner.commands).toEqual([])
    now = wakeAt
    timers[1]!.callback()
    await waitFor(() => runner.commands.some(command => command.type === 'wake'))
    expect(runner.commands).toEqual([
      { type: 'start', options: { model: 'balanced' }, state: sleepingState },
      { type: 'wake', requestId: 'long-horizon-wake' },
    ])
  })

  test('a wake callback observes the durable quiesce latch before timer cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    await createAgentSessionLedger({ stateDir, now: () => 10 }).write({
      version: 1,
      sessionId: 'sess_quiesce_timer_race',
      launch: { tier: 'balanced' },
      checkpoint: {
        state: {
          status: 'sleeping',
          mode: 'agent',
          agent: { status: 'waiting', messages: [] },
        },
        terminalType: 'sleep',
      },
      acceptedThroughSeq: 2,
      inFlightCommands: [],
      wake: { wakeAt: 100, generation: 3 },
      relayOutbox: [],
      updatedAt: 10,
    })
    let quiesced = false
    const timers: Array<() => void> = []
    const runner = new FakeRunner()
    createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 3 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => 100,
      isQuiesced: () => quiesced,
      setTimer: callback => {
        timers.push(callback)
        return callback
      },
      clearTimer: () => undefined,
    })
    await waitFor(() => timers.length === 1)

    quiesced = true
    timers[0]?.()
    await Bun.sleep(5)

    expect(runner.commands).toEqual([])
  })

  test('an accepted user prompt preserves a future wake through its deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const sleepingState = {
      status: 'sleeping' as const,
      mode: 'agent' as const,
      agent: { status: 'waiting' as const, messages: [] },
    }
    await createAgentSessionLedger({ stateDir, now: () => 10 }).write({
      version: 1,
      sessionId: 'sess_prompt_wake_race',
      launch: { tier: 'balanced' },
      checkpoint: { state: sleepingState, terminalType: 'sleep' },
      acceptedThroughSeq: 2,
      inFlightCommands: [],
      wake: { wakeAt: 100, generation: 3 },
      relayOutbox: [],
      updatedAt: 10,
    })
    let now = 20
    const timers: Array<{ callback: () => void; cleared: boolean }> = []
    const runner = new FakeRunner()
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 3 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => now,
      createRequestId: () => 'scheduled-wake',
      setTimer: callback => {
        const timer = { callback, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: timer => {
        ;(timer as { cleared: boolean }).cleared = true
      },
    })

    await deliverPrompt(controller, {
      sessionId: 'sess_prompt_wake_race',
      attemptId: 'user-command',
      prompt: 'Do this instead',
      behavior: 'steer',
      tier: 'balanced',
      throughSeq: 3,
    })
    expect(timers).toHaveLength(1)
    expect(timers[0]?.cleared).toBe(false)
    expect(
      (await createAgentSessionLedger({ stateDir, now: () => now }).read('sess_prompt_wake_race'))
        ?.wake,
    ).toEqual({ wakeAt: 100, generation: 3 })

    now = 100
    timers[0]?.callback()
    await waitFor(() => runner.commands.some(command => command.type === 'wake'))

    expect(runner.commands).toEqual([
      { type: 'start', options: { model: 'balanced' }, state: sleepingState },
      {
        type: 'prompt',
        requestId: 'user-command',
        message: 'Do this instead',
        behavior: 'steer',
      },
      { type: 'wake', requestId: 'scheduled-wake' },
    ])
    expect(
      (await createAgentSessionLedger({ stateDir, now: () => 0 }).read('sess_prompt_wake_race'))
        ?.wake,
    ).toBeUndefined()
  })

  test('crash recovery relaunches on the latest tier and replays each accepted prompt tier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const firstRunner = new FakeRunner()
    const common = {
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    }
    const first = createAgentSessionsController({
      ...common,
      runnerFactory: () => firstRunner,
    })
    await deliverPrompt(first, {
      sessionId: 'sess_recover_command',
      attemptId: 'accepted-command',
      prompt: 'Keep working',
      behavior: 'follow_up',
      tier: 'balanced',
    })
    await deliverPrompt(first, {
      sessionId: 'sess_recover_command',
      attemptId: 'accepted-tier-flip',
      prompt: 'Use Max next',
      behavior: 'steer',
      tier: 'frontier',
    })

    const recoveredRunner = new FakeRunner()
    const recoveryFactoryCalls: AgentRunnerFactoryArgs[] = []
    createAgentSessionsController({
      ...common,
      runnerFactory: args => {
        recoveryFactoryCalls.push(args)
        return recoveredRunner
      },
    })

    await waitFor(
      () => recoveredRunner.commands.filter(command => command.type === 'prompt').length === 2,
    )
    expect(recoveryFactoryCalls[0]?.tier).toBe('frontier')
    expect(recoveredRunner.commands).toEqual([
      { type: 'start', options: { model: 'frontier' }, state: runningTurnState() },
      {
        type: 'prompt',
        requestId: 'accepted-command',
        message: 'Keep working',
        behavior: 'follow_up',
      },
      {
        type: 'prompt',
        requestId: 'accepted-tier-flip',
        message: 'Use Max next',
        behavior: 'steer',
      },
    ])
  })

  test('quarantines a pre-tier envelope and rejects the in-flight delivery until retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-legacy-envelope-'))
    const stateDir = join(root, '.duet')
    const sessionId = 'sess_legacy_retry'
    const envelopePath = sessionEnvelopePath(stateDir, sessionId)
    await mkdir(dirname(envelopePath), { recursive: true })
    await writeFile(
      envelopePath,
      JSON.stringify({
        version: 1,
        sessionId,
        // Deliberately the retired pre-tier shape: quarantine is the point.
        launch: { gatewayModelId: 'fixture/model' },
        acceptedThroughSeq: 1,
        inFlightCommands: [
          {
            requestId: 'legacy-attempt',
            throughSeq: 1,
            command: { type: 'prompt', message: 'Do not drop me', behavior: 'steer' },
          },
        ],
        relayOutbox: [],
        updatedAt: 10,
      }),
    )
    const runner = new FakeRunner()
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })
    const delivery = {
      attemptId: 'durable-retry',
      throughSeq: 1,
      input: { kind: 'prompt' as const, message: 'Do not drop me', behavior: 'steer' as const },
      launch: { tier: 'frontier' as const },
    }

    await expect(controller.deliverInput(sessionId, delivery)).rejects.toThrow(
      'quarantined; retry delivery',
    )
    expect(await readdir(dirname(envelopePath))).toEqual(['session.pre-tier.json'])
    expect(runner.commands).toEqual([])

    await expect(controller.deliverInput(sessionId, delivery)).resolves.toEqual({
      acceptedThroughSeq: 1,
      disposition: 'hydrated',
    })
    expect(runner.commands.filter(command => command.type === 'prompt')).toEqual([
      {
        type: 'prompt',
        requestId: 'durable-retry',
        message: 'Do not drop me',
        behavior: 'steer',
      },
    ])
    expect((await readdir(dirname(envelopePath))).sort()).toEqual([
      'session.json',
      'session.pre-tier.json',
    ])
  })

  test('hard process death during a live turn terminalizes on restart and accepts the next prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const relayed: AgentTurnEvent[] = []
    const common = {
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      relayEvent: async (_sessionId: string, _relayId: string, event: AgentTurnEvent) => {
        relayed.push(event)
        return { seq: relayed.length }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    }
    const liveRunner = new FakeRunner()
    const beforeRestart = createAgentSessionsController({
      ...common,
      runnerFactory: () => liveRunner,
    })

    await expect(
      beforeRestart.deliverInput('sess_hard_restart', {
        attemptId: 'accepted-before-hard-restart',
        throughSeq: 1,
        input: { kind: 'prompt', message: 'Keep working through reboot', behavior: 'steer' },
        launch: { tier: 'balanced' },
      }),
    ).resolves.toEqual({ acceptedThroughSeq: 1, disposition: 'hydrated' })
    await waitFor(async () => {
      const envelope = await createAgentSessionLedger({ stateDir, now: Date.now }).read(
        'sess_hard_restart',
      )
      return (
        envelope?.checkpoint?.state.status === 'running' &&
        envelope.inFlightCommands.some(
          command => command.requestId === 'accepted-before-hard-restart',
        )
      )
    })
    const procDir = join(root, 'proc')
    const orphanPid = 42_424
    await mkdir(join(procDir, String(orphanPid)), { recursive: true })
    await writeFile(join(procDir, String(orphanPid), 'environ'), `${RUNNER_OWNER_ENV}=111\0`)
    await writeFile(
      join(procDir, String(orphanPid), 'cmdline'),
      `/usr/bin/duet\0${RUNNER_RPC_FLAG}\0`,
    )
    const swept = sweepOrphanRunners({
      procDir,
      isPidAlive: () => false,
      killPid: pid => {
        if (pid === orphanPid) liveRunner.kill()
      },
    })
    expect(swept).toEqual([orphanPid])

    const crashRecoveryRunner = new ScriptedFakeRunner(command => {
      if (command.type === 'prompt') {
        crashRecoveryRunner.emitEvent({
          type: 'interrupted',
          state: interruptedTurnState(),
        })
      }
    })
    const nextPromptRunner = new FakeRunner()
    const restartedRunners = [crashRecoveryRunner, nextPromptRunner]
    const restarted = createAgentSessionsController({
      ...common,
      runnerFactory: () => restartedRunners.shift()!,
    })

    await waitFor(() => relayed.some(event => event.type === 'interrupted'))
    const recovered = await createAgentSessionLedger({ stateDir, now: Date.now }).read(
      'sess_hard_restart',
    )
    expect(recovered?.checkpoint?.terminalType).toBe('interrupted')
    expect(recovered?.inFlightCommands).toEqual([])
    expect(restarted.has('sess_hard_restart')).toBe(false)
    expect(relayed.at(-1)).toMatchObject({ type: 'interrupted' })

    await expect(
      restarted.deliverInput('sess_hard_restart', {
        attemptId: 'fresh-after-hard-restart',
        throughSeq: 2,
        input: { kind: 'prompt', message: 'Fresh prompt after reboot', behavior: 'steer' },
        launch: { tier: 'balanced' },
      }),
    ).resolves.toEqual({ acceptedThroughSeq: 2, disposition: 'hydrated' })
    expect(nextPromptRunner.commands.filter(command => command.type === 'prompt')).toEqual([
      {
        type: 'prompt',
        requestId: 'fresh-after-hard-restart',
        message: 'Fresh prompt after reboot',
        behavior: 'steer',
      },
    ])
  })

  test('restart journey preserves wake, live prompt behavior, interrupt documents, and reactivation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const stateDir = join(root, '.duet')
    const relayed: AgentRunnerEvent[] = []
    let now = 1_000
    const common = {
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      relayEvent: async (_sessionId: string, _relayId: string, event: AgentRunnerEvent) => {
        relayed.push(event)
        return { seq: relayed.length }
      },
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
      now: () => now,
    }
    const sleepingMachine = continuityStateMachine('wait', now)
    const firstRunner = new ScriptedFakeRunner(command => {
      if (command.type !== 'prompt') return
      firstRunner.emitEvent({ type: 'state_machine', stateMachine: sleepingMachine })
      firstRunner.emitEvent({
        type: 'sleep',
        wakeAt: now + 100,
        state: continuityTurnState('sleeping', sleepingMachine),
      })
    })
    const preRestartTimers: Array<{ callback: () => void; cleared: boolean }> = []
    const first = createAgentSessionsController({
      ...common,
      runnerFactory: () => firstRunner,
      setTimer: callback => {
        const timer = { callback, cleared: false }
        preRestartTimers.push(timer)
        return timer
      },
      clearTimer: timer => {
        ;(timer as { cleared: boolean }).cleared = true
      },
    })

    await deliverPrompt(first, {
      sessionId: 'sess_restart_journey',
      attemptId: 'initial-steer',
      prompt: 'Remind me to get milk',
      behavior: 'steer',
      throughSeq: 1,
      tier: 'balanced',
    })
    await waitFor(async () => {
      const envelope = await createAgentSessionLedger({ stateDir, now: () => now }).read(
        'sess_restart_journey',
      )
      return envelope?.checkpoint?.terminalType === 'sleep' && envelope.wake?.wakeAt === 1_100
    })
    expect(preRestartTimers).toHaveLength(1)
    expect(preRestartTimers[0]?.cleared).toBe(false)

    now = 1_200
    const activeMachine = continuityStateMachine('deliver reminder', now)
    const interruptedMachine = continuityStateMachine('interrupted', now)
    const resumedMachine = continuityStateMachine('wait', now)
    const resumedState = continuityTurnState('running', resumedMachine)
    const interruptedState: AgentTurnState = {
      ...continuityTurnState('interrupted', interruptedMachine),
      agent: { status: 'cancelled' as const, messages: [] },
      todos: [{ id: 'deliver-reminder', content: 'Deliver reminder', status: 'failed' as const }],
      followUpQueue: [],
      tasks: [
        {
          id: 't1' as const,
          kind: 'scheduled' as const,
          name: 'milk-reminder',
          label: 'Milk reminder',
          ownerScopeId: 'turn-1' as const,
          status: 'stopped' as const,
          startedAt: 1_000,
          wakeAt: 1_100,
        },
      ],
    }
    const wakeRunner = new ScriptedFakeRunner(command => {
      if (command.type === 'wake') {
        wakeRunner.emitEvent({
          type: 'turn_started',
          state: continuityTurnState('running', activeMachine),
        })
      }
      if (command.type === 'prompt' && command.behavior === 'follow_up') {
        wakeRunner.emitEvent({
          type: 'follow_up_queue',
          followUpQueue: [{ message: command.message }],
        })
      }
      if (command.type === 'interrupt') {
        wakeRunner.emitEvent({ type: 'interrupted', state: interruptedState })
      }
    })
    const reactivatedRunner = new ScriptedFakeRunner(command => {
      if (command.type !== 'prompt') return
      reactivatedRunner.emitEvent({ type: 'turn_started', state: resumedState })
      reactivatedRunner.emitEvent({ type: 'state_machine', stateMachine: resumedMachine })
    })
    const restartedRunners = [wakeRunner, reactivatedRunner]
    const restarted = createAgentSessionsController({
      ...common,
      runnerFactory: () => restartedRunners.shift()!,
      createRequestId: () => 'overdue-wake',
    })

    await waitFor(() => wakeRunner.commands.some(command => command.type === 'wake'))
    await deliverPrompt(restarted, {
      sessionId: 'sess_restart_journey',
      attemptId: 'live-steer',
      prompt: 'Use the blue mug',
      behavior: 'steer',
      throughSeq: 2,
      tier: 'balanced',
    })
    await deliverPrompt(restarted, {
      sessionId: 'sess_restart_journey',
      attemptId: 'live-follow-up',
      prompt: 'Then buy eggs',
      behavior: 'follow_up',
      throughSeq: 3,
      tier: 'balanced',
    })

    expect(wakeRunner.commands.filter(command => command.type === 'prompt')).toEqual([
      {
        type: 'prompt',
        requestId: 'live-steer',
        message: 'Use the blue mug',
        behavior: 'steer',
      },
      {
        type: 'prompt',
        requestId: 'live-follow-up',
        message: 'Then buy eggs',
        behavior: 'follow_up',
      },
    ])
    await expect(restarted.interrupt('sess_restart_journey')).resolves.toBe(true)
    await waitFor(async () => {
      const envelope = await createAgentSessionLedger({ stateDir, now: () => now }).read(
        'sess_restart_journey',
      )
      return envelope?.checkpoint?.terminalType === 'interrupted'
    })
    const interrupted = await createAgentSessionLedger({ stateDir, now: () => now }).read(
      'sess_restart_journey',
    )
    expect(interrupted?.wake).toBeUndefined()
    expect(interrupted?.checkpoint?.state).toEqual(interruptedState)

    await deliverPrompt(restarted, {
      sessionId: 'sess_restart_journey',
      attemptId: 'reactivate-steer',
      prompt: 'Schedule it again',
      behavior: 'steer',
      throughSeq: 4,
      tier: 'balanced',
    })
    await waitFor(async () => {
      const envelope = await createAgentSessionLedger({ stateDir, now: () => now }).read(
        'sess_restart_journey',
      )
      return (
        envelope?.checkpoint?.terminalType === undefined &&
        envelope?.checkpoint?.state.stateMachine?.currentState === 'wait'
      )
    })
    await waitFor(() => relayed.some(event => event.type === 'follow_up_queue'))
    await waitFor(() => relayed.some(event => event.type === 'interrupted'))

    expect(relayed.map(event => event.type)).toEqual(
      expect.arrayContaining([
        'state_machine',
        'sleep',
        'turn_started',
        'follow_up_queue',
        'interrupted',
      ]),
    )
  })

  test('two concurrent prompts share one runner and preserve command order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-process-runner-'))
    const runner = new FakeRunner()
    const controller = createAgentSessionsController({
      stateDir: join(root, '.duet'),
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runner,
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await Promise.all([
      deliverPrompt(controller, {
        sessionId: 'sess_two_prompts',
        attemptId: 'prompt-1',
        prompt: 'First',
        behavior: 'steer',
        tier: 'balanced',
      }),
      deliverPrompt(controller, {
        sessionId: 'sess_two_prompts',
        attemptId: 'prompt-2',
        prompt: 'Second',
        behavior: 'follow_up',
        tier: 'balanced',
      }),
    ])

    expect(runner.commands.filter(command => command.type === 'start')).toHaveLength(1)
    expect(runner.commands.filter(command => command.type === 'prompt')).toEqual([
      {
        type: 'prompt',
        requestId: 'prompt-1',
        message: 'First',
        behavior: 'steer',
      },
      {
        type: 'prompt',
        requestId: 'prompt-2',
        message: 'Second',
        behavior: 'follow_up',
      },
    ])
  })
})

function projectedAgentAnchor(id: string, path: string, agentId: string): GatewayAnchor {
  return {
    id,
    agentId,
    workspaceId: 'workspace_1',
    path,
    kind: 'agent',
    settings: {},
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    markerNonce: `nonce-${id}`,
  }
}

class FakeRunner implements AgentRunner {
  private readonly listeners: AgentRunnerEventListener[] = []
  private readonly exitListeners: Array<(code: number | null) => void> = []
  private alive = false
  private exited = false
  readonly commands: AgentRunnerCommand[] = []

  async start(): Promise<void> {
    this.alive = true
  }

  async send(command: AgentRunnerCommand): Promise<void> {
    this.commands.push(command)
    if (command.type === 'start') {
      this.emit({ type: 'turn_started', state: runningTurnState() })
    }
  }

  async waitForTurnStarted(): Promise<AgentRunnerStartedEvent> {
    return { type: 'turn_started', state: runningTurnState() }
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

  emitEvent(event: AgentRunnerEvent): void {
    for (const listener of this.listeners.slice()) listener(event)
  }

  private emit(event: AgentRunnerEvent): void {
    this.emitEvent(event)
  }
}

class InterruptingFakeRunner extends FakeRunner {
  constructor(private readonly interruptedState: ReturnType<typeof interruptedTurnState>) {
    super()
  }

  override async send(command: AgentRunnerCommand): Promise<void> {
    await super.send(command)
    if (command.type === 'interrupt') {
      this.emitEvent({ type: 'interrupted', state: this.interruptedState })
    }
  }
}

class ScriptedFakeRunner extends FakeRunner {
  constructor(private readonly onCommand: (command: AgentRunnerCommand) => void) {
    super()
  }

  override async send(command: AgentRunnerCommand): Promise<void> {
    await super.send(command)
    this.onCommand(command)
  }
}

function runningTurnState() {
  return {
    status: 'running' as const,
    mode: 'agent' as const,
    agent: { status: 'running' as const, messages: [] },
  }
}

function interruptedTurnState() {
  return {
    status: 'interrupted' as const,
    mode: 'agent' as const,
    agent: { status: 'cancelled' as const, messages: [] },
    followUpQueue: [],
  }
}

function continuityStateMachine(currentState: string, updatedAt: number): AgentStateMachineSession {
  return {
    definition: {
      name: 'Milk reminder',
      prompt: 'Remind me to get milk',
      states: [
        { name: 'wait', kind: 'timer' },
        { name: 'deliver reminder', kind: 'agent', prompt: 'Deliver the milk reminder' },
        { name: 'interrupted', kind: 'terminal', status: 'cancelled' },
      ],
    },
    prompt: 'Remind me to get milk',
    currentState,
    history: [],
    createdAt: 1_000,
    updatedAt,
  }
}

function continuityTurnState(
  status: 'running' | 'sleeping' | 'interrupted',
  stateMachine: AgentStateMachineSession,
): AgentTurnState {
  return {
    status,
    mode: stateMachine.definition,
    agent: {
      status:
        status === 'running'
          ? ('running' as const)
          : status === 'sleeping'
            ? ('waiting' as const)
            : ('cancelled' as const),
      messages: [],
    },
    stateMachine,
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(5)
  }
}

/** A process handle the test drives by hand: the runtime's verdict and the pipe, separately. */
function fakeChildProcess() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  const process = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout,
    stderr,
    stdin,
    kill: () => true,
  }) as unknown as ChildProcess
  return { process, stdout, stderr }
}
