import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { GatewayAnchor } from '@repo/contract'

import type { SpawnDuetCliOptions } from './duet-cli'
import {
  createMemoryReflectRail,
  MEMORY_REFLECT_INTERVAL_MS,
  MEMORY_REFLECT_STATE_FILE,
  MEMORY_REFLECT_TICK_MS,
} from './memory-reflect'

function stateWith(dbKeys: string[]): string {
  const stateDir = mkdtempSync(join(tmpdir(), 'memory-reflect-'))
  for (const key of dbKeys) {
    const path = key === 'root' ? join(stateDir, 'memory.db') : agentDb(stateDir, key)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
  }
  return stateDir
}

function readState(stateDir: string): Record<string, number> {
  return JSON.parse(readFileSync(join(stateDir, MEMORY_REFLECT_STATE_FILE), 'utf8'))
}

function agentDb(stateDir: string, anchorId: string): string {
  return join(stateDir, 'agents', anchorId, 'memory.db')
}

function anchor(id: string, agentId?: string): GatewayAnchor {
  return {
    id,
    workspaceId: 'workspace-1',
    path: `agents/${id}`,
    kind: 'agent',
    settings: {},
    state: 'active',
    markerNonce: `nonce-${id}`,
    createdAt: 1,
    updatedAt: 1,
    ...(agentId === undefined ? {} : { agentId }),
  }
}

test('every agent memory database is reflected on its own, the drive root included', async () => {
  const stateDir = stateWith(['root', 'anchor-a', 'anchor-b'])
  const argvs: string[][] = []
  let clock = MEMORY_REFLECT_INTERVAL_MS * 10
  const rail = createMemoryReflectRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    anchors: () => [anchor('anchor-a', 'agent-a'), anchor('anchor-b', 'agent-b')],
    modelEnv: () => ({ DUET_API_KEY: 'key', DUET_GATEWAY_BASE_URL: 'https://gateway.test' }),
    runner: async argv => {
      argvs.push(argv)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    now: () => clock,
  })

  // The first sight of a store starts its clock; the pass a day later folds it.
  expect(await rail.reflectDue()).toEqual([])
  clock += MEMORY_REFLECT_INTERVAL_MS
  const results = await rail.reflectDue()

  expect(results.map(result => `${result.key}:${result.outcome}`)).toEqual([
    'root:reflected',
    'anchor-a:reflected',
    'anchor-b:reflected',
  ])
  expect(argvs).toEqual([
    ['memory', 'reflect', '--db', join(stateDir, 'memory.db'), '--wait', '60'],
    ['memory', 'reflect', '--db', agentDb(stateDir, 'anchor-a'), '--wait', '60'],
    ['memory', 'reflect', '--db', agentDb(stateDir, 'anchor-b'), '--wait', '60'],
  ])
})

test('an anchor with no agent has no memory to fold, and an agent with no store is not charged for one', async () => {
  const stateDir = stateWith(['root'])
  const argvs: string[][] = []
  let clock = MEMORY_REFLECT_INTERVAL_MS * 10
  const rail = createMemoryReflectRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    anchors: () => [anchor('anchor-app'), anchor('anchor-fresh', 'agent-fresh')],
    modelEnv: () => ({ DUET_API_KEY: 'key', DUET_GATEWAY_BASE_URL: 'https://gateway.test' }),
    runner: async argv => {
      argvs.push(argv)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    now: () => clock,
  })

  await rail.reflectDue()
  clock += MEMORY_REFLECT_INTERVAL_MS
  const results = await rail.reflectDue()

  expect(results.map(result => `${result.key}:${result.outcome}`)).toEqual([
    'root:reflected',
    'anchor-fresh:no_database',
  ])
  expect(argvs.map(argv => argv[argv.indexOf('--db') + 1])).toEqual([join(stateDir, 'memory.db')])
})

test('the schedule is the database clock, not the process clock: a restarted gateway resumes it', async () => {
  const stateDir = stateWith(['root'])
  const runs: string[] = []
  let clock = MEMORY_REFLECT_INTERVAL_MS * 10
  const railWith = () =>
    createMemoryReflectRail({
      stateDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => [],
      modelEnv: () => ({ DUET_API_KEY: 'key', DUET_GATEWAY_BASE_URL: 'https://gateway.test' }),
      runner: async argv => {
        runs.push(argv[argv.indexOf('--db') + 1] ?? '')
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      now: () => clock,
    })

  await railWith().reflectDue()
  clock += MEMORY_REFLECT_INTERVAL_MS
  await railWith().reflectDue()
  clock += MEMORY_REFLECT_INTERVAL_MS / 2
  await railWith().reflectDue()

  expect(runs).toEqual([join(stateDir, 'memory.db')])
})

test('a failed fold waits for tomorrow rather than being retried every tick', async () => {
  const stateDir = stateWith(['root'])
  let attempts = 0
  let clock = MEMORY_REFLECT_INTERVAL_MS * 10
  const rail = createMemoryReflectRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    anchors: () => [],
    modelEnv: () => ({ DUET_API_KEY: 'key', DUET_GATEWAY_BASE_URL: 'https://gateway.test' }),
    runner: async () => {
      attempts += 1
      return { exitCode: 75, stdout: '', stderr: 'memory database is still locked by duet pid 42' }
    },
    now: () => clock,
  })

  await rail.reflectDue()
  clock += MEMORY_REFLECT_INTERVAL_MS
  expect((await rail.reflectDue()).map(result => result.outcome)).toEqual(['failed'])
  clock += MEMORY_REFLECT_TICK_MS
  expect(await rail.reflectDue()).toEqual([])
  expect(attempts).toBe(1)
})

test('a VM with no model credentials keeps its slot instead of spending it', async () => {
  const stateDir = stateWith(['root'])
  const runs: string[] = []
  let credentials: Record<string, string> | null = null
  let clock = MEMORY_REFLECT_INTERVAL_MS * 10
  const rail = createMemoryReflectRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    anchors: () => [],
    modelEnv: () => credentials,
    runner: async argv => {
      runs.push(argv[argv.indexOf('--db') + 1] ?? '')
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    now: () => clock,
  })

  await rail.reflectDue()
  clock += MEMORY_REFLECT_INTERVAL_MS
  expect(await rail.reflectDue()).toEqual([])
  expect(runs).toEqual([])

  credentials = { DUET_API_KEY: 'key', DUET_GATEWAY_BASE_URL: 'https://gateway.test' }
  clock += MEMORY_REFLECT_TICK_MS
  expect((await rail.reflectDue()).map(result => result.outcome)).toEqual(['reflected'])
  expect(runs).toEqual([join(stateDir, 'memory.db')])
})

test('a deleted agent stops being tracked', async () => {
  const stateDir = stateWith(['root', 'anchor-a'])
  let anchors = [anchor('anchor-a', 'agent-a')]
  let clock = MEMORY_REFLECT_INTERVAL_MS * 10
  const rail = createMemoryReflectRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    anchors: () => anchors,
    modelEnv: () => ({ DUET_API_KEY: 'key', DUET_GATEWAY_BASE_URL: 'https://gateway.test' }),
    runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    now: () => clock,
  })

  await rail.reflectDue()
  expect(Object.keys(readState(stateDir))).toEqual(['root', 'anchor-a'])

  anchors = []
  clock += MEMORY_REFLECT_INTERVAL_MS
  await rail.reflectDue()
  expect(Object.keys(readState(stateDir))).toEqual(['root'])
})

test('starting the rail is what makes it recur: each tick runs a pass', async () => {
  const stateDir = stateWith(['root'])
  const runs: string[] = []
  const scheduled: { tick?: () => void } = {}
  let tickDelayMs = 0
  let clock = MEMORY_REFLECT_INTERVAL_MS * 10
  const rail = createMemoryReflectRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    anchors: () => [],
    modelEnv: () => ({ DUET_API_KEY: 'key', DUET_GATEWAY_BASE_URL: 'https://gateway.test' }),
    runner: async argv => {
      runs.push(argv[argv.indexOf('--db') + 1] ?? '')
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    now: () => clock,
    setTimer: (callback, delayMs) => {
      scheduled.tick = callback
      tickDelayMs = delayMs
      return 'timer'
    },
    clearTimer: () => {
      delete scheduled.tick
    },
  })

  rail.start()
  expect(tickDelayMs).toBe(MEMORY_REFLECT_TICK_MS)
  scheduled.tick?.()
  await rail.reflectDue()
  expect(runs).toEqual([])

  clock += MEMORY_REFLECT_INTERVAL_MS
  scheduled.tick?.()
  await rail.reflectDue()
  expect(runs).toEqual([join(stateDir, 'memory.db')])

  rail.stop()
  expect(scheduled.tick).toBeUndefined()
})

test('a tick that lands mid-pass joins it instead of folding a database twice', async () => {
  const stateDir = stateWith(['root', 'anchor-a'])
  const runs: string[] = []
  const gate: { release?: () => void } = {}
  let clock = MEMORY_REFLECT_INTERVAL_MS * 10
  const rail = createMemoryReflectRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    anchors: () => [anchor('anchor-a', 'agent-a')],
    modelEnv: () => ({ DUET_API_KEY: 'key', DUET_GATEWAY_BASE_URL: 'https://gateway.test' }),
    runner: async argv => {
      runs.push(argv[argv.indexOf('--db') + 1] ?? '')
      // The first database blocks, so the second tick arrives while the pass
      // still has an agent left to fold.
      if (runs.length === 1) await new Promise<void>(resolve => (gate.release = resolve))
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    now: () => clock,
  })

  await rail.reflectDue()
  clock += MEMORY_REFLECT_INTERVAL_MS
  const first = rail.reflectDue()
  await Bun.sleep(1)
  const second = rail.reflectDue()
  gate.release?.()
  await Promise.all([first, second])

  expect(runs).toEqual([join(stateDir, 'memory.db'), agentDb(stateDir, 'anchor-a')])
})

test('the fold runs with model credentials, a self-upgrade it cannot start, and a cap it cannot outlive', async () => {
  const stateDir = stateWith(['root'])
  const spawns: SpawnDuetCliOptions[] = []
  let clock = MEMORY_REFLECT_INTERVAL_MS * 10
  const rail = createMemoryReflectRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    anchors: () => [],
    modelEnv: () => ({ DUET_API_KEY: 'key', DUET_GATEWAY_BASE_URL: 'https://gateway.test' }),
    runner: async (_argv, spawnOptions) => {
      spawns.push(spawnOptions ?? {})
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    now: () => clock,
  })

  await rail.reflectDue()
  clock += MEMORY_REFLECT_INTERVAL_MS
  await rail.reflectDue()

  expect(spawns[0]?.env).toEqual({
    DUET_API_KEY: 'key',
    DUET_GATEWAY_BASE_URL: 'https://gateway.test',
    DUET_NO_AUTO_UPGRADE: '1',
  })
  // Minutes, not the seconds a person waits on a memory write.
  expect(spawns[0]?.timeoutMs).toBeGreaterThanOrEqual(60_000)
})

test('a missing agent CLI fails one database, not the agents queued behind it', async () => {
  const stateDir = stateWith(['root', 'anchor-a'])
  let clock = MEMORY_REFLECT_INTERVAL_MS * 10
  const rail = createMemoryReflectRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    anchors: () => [anchor('anchor-a', 'agent-a')],
    modelEnv: () => ({ DUET_API_KEY: 'key', DUET_GATEWAY_BASE_URL: 'https://gateway.test' }),
    // `Bun.spawn` throws rather than rejecting when the binary is absent.
    runner: argv => {
      if (argv.includes(join(stateDir, 'memory.db'))) throw new Error('ENOENT: duet')
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    },
    now: () => clock,
  })

  await rail.reflectDue()
  clock += MEMORY_REFLECT_INTERVAL_MS

  expect((await rail.reflectDue()).map(result => `${result.key}:${result.outcome}`)).toEqual([
    'root:failed',
    'anchor-a:reflected',
  ])
})
