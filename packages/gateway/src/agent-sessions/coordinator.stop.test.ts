import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentTurnEvent } from '@repo/contract'

import { createAgentSessionsController } from './coordinator'
import { createAgentSessionLedger } from './ledger'

test('an interrupted unfinished relay stays stopped across repeated pause and controller restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-stop-settlement-'))
  const stateDir = join(root, '.duet')
  const driveDir = join(root, 'drive')
  await mkdir(driveDir)
  const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
  const sessionId = 'interrupted-relay'
  await ledger.write({
    version: 1,
    sessionId,
    launch: { tier: 'balanced' },
    checkpoint: {
      terminalType: 'interrupted',
      state: {
        status: 'interrupted',
        mode: 'agent',
        agent: { status: 'cancelled', messages: [] },
        stateMachine: {
          definition: {
            name: 'relay',
            prompt: 'work',
            states: [{ name: 'work', kind: 'agent', prompt: 'work' }],
          },
          prompt: 'work',
          currentState: 'work',
          history: [],
          createdAt: 1,
          updatedAt: 2,
        },
      },
    },
    acceptedThroughSeq: 2,
    inFlightCommands: [],
    relayOutbox: [],
    updatedAt: 10,
  })
  const events: AgentTurnEvent[] = []
  let launches = 0
  const retries: Array<() => void> = []
  const options = {
    stateDir,
    driveDir,
    memoryDbPath: join(root, 'memory.db'),
    getVmToken: async () => null,
    ensureRunner: async () => undefined,
    mcpServers: () => null,
    runnerFactory: () => {
      launches++
      throw new Error('a stopped session must not launch')
    },
    relayEvent: async (_session: string, _relay: string, event: AgentTurnEvent) => {
      events.push(event)
      return { seq: events.length }
    },
    setTimer: (callback: () => void) => {
      retries.push(callback)
      return callback
    },
    clearTimer: () => undefined,
  }
  try {
    for (let restart = 0; restart < 2; restart++) {
      const controller = createAgentSessionsController(options)
      expect(await controller.interrupt(sessionId)).toBe(false)
      controller.setQuiesced(true)
      controller.setQuiesced(true)
      await Bun.sleep(25)
      controller.setQuiesced(false)
    }
    expect((await ledger.read(sessionId))?.checkpoint?.state.status).toBe('interrupted')
    expect(events).toEqual([])
    expect(launches).toBe(0)
    expect(retries).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stopping a sleeper with a missing agent root durably cancels its wake without hydration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-missing-root-stop-'))
  const stateDir = join(root, '.duet')
  const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
  const sessionId = 'missing-root'
  const state = {
    status: 'sleeping' as const,
    mode: 'agent' as const,
    agent: { status: 'waiting' as const, messages: [] },
  }
  await ledger.write({
    version: 1,
    sessionId,
    agentAnchorId: 'deleted-anchor',
    launch: { tier: 'balanced', cwd: 'agents/deleted' },
    checkpoint: { terminalType: 'sleep', state },
    acceptedThroughSeq: 2,
    inFlightCommands: [],
    relayOutbox: [],
    wake: { wakeAt: Date.now() + 60_000, generation: 1 },
    updatedAt: 10,
  })
  const events: AgentTurnEvent[] = []
  let launches = 0
  const options = {
    stateDir,
    driveDir: join(root, 'drive'),
    memoryDbPath: join(root, 'memory.db'),
    anchors: () => [],
    getVmToken: async () => null,
    runnerFactory: () => {
      launches++
      throw new Error('no runner needed to stop absent work')
    },
    relayEvent: async (_session: string, _relay: string, event: AgentTurnEvent) => {
      events.push(event)
      return { seq: events.length }
    },
    isQuiesced: () => true,
  }
  try {
    const controller = createAgentSessionsController(options)
    expect(await controller.interrupt(sessionId)).toBe(false)
    const stored = await ledger.read(sessionId)
    expect(stored?.wake).toBeUndefined()
    expect(stored?.inFlightCommands).toEqual([])
    expect(stored?.checkpoint?.state).toEqual(state)
    const restarted = createAgentSessionsController(options)
    expect(await restarted.interrupt(sessionId)).toBe(false)
    expect(events).toEqual([
      expect.objectContaining({ type: 'system', metadata: { code: 'interrupt_undeliverable' } }),
    ])
    expect(launches).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restart repairs an interrupted checkpoint projection without launching a runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-projection-repair-'))
  const stateDir = join(root, '.duet')
  const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
  await ledger.write({
    version: 1,
    sessionId: 'old-interruption',
    launch: { tier: 'balanced' },
    checkpoint: {
      terminalType: 'interrupted',
      state: { status: 'interrupted', mode: 'agent', agent: { status: 'cancelled', messages: [] } },
    },
    acceptedThroughSeq: 2,
    inFlightCommands: [],
    relayOutbox: [],
    updatedAt: 10,
  })
  const reports: unknown[] = []
  try {
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: root,
      memoryDbPath: join(root, 'memory.db'),
      apiUrl: 'https://api.example.test',
      getVmToken: async () => 'test-token',
      runnerFactory: () => {
        throw new Error('repair must not launch a runner')
      },
      fetch: async (_input, init) => {
        if (init?.method === 'POST') {
          reports.push(JSON.parse(String(init.body)))
          return Response.json({ repaired: true })
        }
        return Response.json({ expectedLastEventSeq: 17, acceptedThroughSeq: 2 })
      },
    })
    await controller.interrupt('old-interruption')
    expect(reports).toEqual([{ expectedLastEventSeq: 17, acceptedThroughSeq: 2 }])
    expect((await ledger.read('old-interruption'))?.checkpoint?.state.status).toBe('interrupted')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('interrupted checkpoint repair retries a temporary API failure with bounded backoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-projection-retry-'))
  const stateDir = join(root, '.duet')
  const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
  await ledger.write({
    version: 1,
    sessionId: 'retry-repair',
    launch: { tier: 'balanced' },
    checkpoint: {
      terminalType: 'interrupted',
      state: { status: 'interrupted', mode: 'agent', agent: { status: 'cancelled', messages: [] } },
    },
    acceptedThroughSeq: 2,
    inFlightCommands: [],
    relayOutbox: [],
    updatedAt: 10,
  })
  const timers: Array<{ callback: () => void; delay: number }> = []
  const cleared = new Set<unknown>()
  let reads = 0
  let repaired = false
  try {
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: root,
      memoryDbPath: join(root, 'memory.db'),
      apiUrl: 'https://api.example.test',
      getVmToken: async () => 'test-token',
      setTimer: (callback, delay) => {
        timers.push({ callback, delay })
        return callback
      },
      clearTimer: timer => {
        cleared.add(timer)
      },
      runnerFactory: () => {
        throw new Error('repair must not launch a runner')
      },
      fetch: async (_input, init) => {
        if (init?.method === 'POST') {
          repaired = true
          return Response.json({ repaired: true })
        }
        if (++reads <= 2) return new Response('', { status: 503 })
        return Response.json({ expectedLastEventSeq: 17, acceptedThroughSeq: 2 })
      },
    })
    await controller.interrupt('retry-repair')
    // The fake clock drives retries; interrupt waits for each session-serialized
    // observation so assertions do not depend on wall-clock sleeps.
    expect(timers[0]!.delay).toBeGreaterThan(0)
    controller.setQuiesced(true)
    expect(cleared.has(timers[0]!.callback)).toBe(false)
    timers[0]!.callback()
    await controller.interrupt('retry-repair')
    expect(timers[1]!.delay).toBeGreaterThan(timers[0]!.delay)
    timers[1]!.callback()
    await controller.interrupt('retry-repair')
    expect(repaired).toBe(true)
    expect(timers).toHaveLength(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ambiguous legacy wakes wait for explicit action and can still be stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-ambiguous-wake-'))
  const stateDir = join(root, '.duet')
  const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
  await ledger.write({
    version: 1,
    sessionId: 'blocked-wake',
    launch: { tier: 'balanced' },
    acceptedThroughSeq: 2,
    appliedRelaySequence: 0,
    recoveryBlocked: 'ambiguous_legacy_wake',
    checkpoint: {
      terminalType: 'interrupted',
      state: {
        status: 'interrupted',
        mode: 'agent',
        agent: { status: 'cancelled', messages: [] },
      },
    },
    inFlightCommands: [{ requestId: 'ambiguous-wake', command: { type: 'wake' } }],
    relayOutbox: [],
    updatedAt: 10,
  })
  let launches = 0
  let projectionRequests = 0
  const timers: Array<() => void> = []
  const controller = createAgentSessionsController({
    stateDir,
    driveDir: join(root, 'drive'),
    memoryDbPath: join(root, 'memory.db'),
    getVmToken: async () => 'fixture',
    apiUrl: 'https://api.example.test',
    fetch: async () => {
      projectionRequests++
      return Response.json(null)
    },
    runnerFactory: () => {
      launches++
      throw new Error('blocked wake must not execute')
    },
    relayEvent: async () => ({ seq: 1 }),
    ensureRunner: async () => undefined,
    setTimer: callback => {
      timers.push(callback)
      return callback
    },
    clearTimer: () => undefined,
  })
  try {
    await controller.browserOwnerForSession('blocked-wake')
    expect(launches).toBe(0)
    expect(projectionRequests).toBe(0)
    expect(timers).toEqual([])
    expect(await controller.interrupt('blocked-wake')).toBe(false)
    const restored = await createAgentSessionLedger({ stateDir, now: () => 20 }).read(
      'blocked-wake',
    )
    expect(restored?.recoveryBlocked).toBeUndefined()
    expect(restored?.inFlightCommands).toEqual([])
    expect(restored?.wake).toBeUndefined()
    expect(launches).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
