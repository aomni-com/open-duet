import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { GatewayAnchor } from '@repo/contract'

import { agentMemoryDbPath } from './agent-context'
import { createMemoryWarmupRail, type MemoryWarmupResult } from './memory-warmup'

const scratchDirs: string[] = []
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function scratchStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-warmup-'))
  scratchDirs.push(dir)
  return dir
}

function anchor(id: string, overrides: Partial<GatewayAnchor> = {}): GatewayAnchor {
  return {
    id,
    agentId: `agent-${id}`,
    workspaceId: 'workspace-1',
    path: `agents/${id}`,
    kind: 'agent',
    settings: {},
    state: 'active',
    markerNonce: `nonce-${id}`,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** What the agent CLI leaves behind when told to open a database at `dbPath`. */
function createDatabase(dbPath: string, marker: string): void {
  mkdirSync(dbPath, { recursive: true })
  writeFileSync(join(dbPath, 'PG_VERSION'), marker)
}

/** A state directory whose root store already exists, so only agents are in play. */
function freshStateDir(): string {
  const stateDir = scratchStateDir()
  createDatabase(join(stateDir, 'memory.db'), 'root-memories')
  return stateDir
}

function dbArg(argv: string[]): string {
  const at = argv.indexOf('--db')
  if (at === -1) throw new Error(`no --db in ${JSON.stringify(argv)}`)
  return argv[at + 1]!
}

function outcomes(results: MemoryWarmupResult[]): string[] {
  return results.map(result => `${result.key}:${result.outcome}`)
}

test('a registered agent that has never run gets its memory database built ahead of its first turn', async () => {
  const stateDir = freshStateDir()
  const argvs: string[][] = []
  const rail = createMemoryWarmupRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    busy: () => false,
    runner: async argv => {
      argvs.push(argv)
      createDatabase(dbArg(argv), 'built-by-warmup')
      return { exitCode: 0, stdout: '[]\n', stderr: '' }
    },
  })

  const results = await rail.warm([anchor('reviewer')])

  const dbPath = agentMemoryDbPath(stateDir, 'reviewer')
  expect(outcomes(results)).toEqual(['reviewer:warmed'])
  expect(argvs).toHaveLength(1)
  expect(argvs[0]!.slice(0, 3)).toEqual(['memory', '--json', '--db'])
  // The CLI builds into a scratch path beside the real one, so a runner that
  // spawns mid-build never opens a half-migrated store as its memory.
  expect(dbArg(argvs[0]!)).not.toBe(dbPath)
  expect(dirname(dbArg(argvs[0]!))).toBe(dirname(dbPath))
  expect(readFileSync(join(dbPath, 'PG_VERSION'), 'utf8')).toBe('built-by-warmup')
  // Nothing but the finished store is left in the agent's state directory.
  expect(readdirSync(dirname(dbPath))).toEqual(['memory.db'])
  // Once built, the same anchors cost nothing on the next cycle.
  expect(await rail.warm([anchor('reviewer')])).toEqual([])
  expect(argvs).toHaveLength(1)
  expect(existsSync(dbPath)).toBe(true)
})

test('only an active agent anchor without a store is built; the rest are left alone', async () => {
  const stateDir = freshStateDir()
  createDatabase(agentMemoryDbPath(stateDir, 'veteran'), 'real-memories')
  const argvs: string[][] = []
  const rail = createMemoryWarmupRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    busy: () => false,
    runner: async argv => {
      argvs.push(argv)
      createDatabase(dbArg(argv), 'built-by-warmup')
      return { exitCode: 0, stdout: '[]\n', stderr: '' }
    },
  })

  const results = await rail.warm([
    anchor('veteran'),
    anchor('app', { agentId: undefined, kind: 'app' }),
    anchor('orphaned', { state: 'orphaned' }),
    anchor('newcomer'),
  ])

  expect(outcomes(results)).toEqual(['newcomer:warmed'])
  expect(argvs).toHaveLength(1)
  expect(readFileSync(join(agentMemoryDbPath(stateDir, 'veteran'), 'PG_VERSION'), 'utf8')).toBe(
    'real-memories',
  )
  expect(existsSync(agentMemoryDbPath(stateDir, 'app'))).toBe(false)
  expect(existsSync(agentMemoryDbPath(stateDir, 'orphaned'))).toBe(false)
})

test('a build that loses the race to the first turn is discarded, not renamed over real memories', async () => {
  const stateDir = freshStateDir()
  const dbPath = agentMemoryDbPath(stateDir, 'reviewer')
  const logs: Record<string, unknown>[] = []
  const rail = createMemoryWarmupRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    busy: () => false,
    log: fields => logs.push(fields),
    runner: async argv => {
      // The runner spawned while the build ran and created the real store.
      createDatabase(dbPath, 'runner-first')
      createDatabase(dbArg(argv), 'built-by-warmup')
      return { exitCode: 0, stdout: '[]\n', stderr: '' }
    },
  })

  expect(outcomes(await rail.warm([anchor('reviewer')]))).toEqual(['reviewer:superseded'])
  expect(readFileSync(join(dbPath, 'PG_VERSION'), 'utf8')).toBe('runner-first')
  expect(readdirSync(dirname(dbPath))).toEqual(['memory.db'])
  expect(logs.map(fields => fields.status)).toEqual(['superseded'])
})

test('a failed build leaves nothing behind and is not retried every cycle', async () => {
  const stateDir = freshStateDir()
  const dbPath = agentMemoryDbPath(stateDir, 'reviewer')
  const logs: Record<string, unknown>[] = []
  let spawns = 0
  const rail = createMemoryWarmupRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    busy: () => false,
    log: fields => logs.push(fields),
    runner: async argv => {
      spawns += 1
      createDatabase(dbArg(argv), 'half-migrated')
      return { exitCode: 78, stdout: '', stderr: 'incompatible schema' }
    },
  })

  expect(outcomes(await rail.warm([anchor('reviewer')]))).toEqual(['reviewer:failed'])
  expect(existsSync(dbPath)).toBe(false)
  expect(readdirSync(dirname(dbPath))).toEqual([])
  expect(logs).toEqual([
    expect.objectContaining({
      status: 'failed',
      target: 'reviewer',
      exitCode: 78,
      error: 'incompatible schema',
    }),
  ])

  expect(await rail.warm([anchor('reviewer')])).toEqual([])
  expect(spawns).toBe(1)
})

test('a state directory that cannot be created is one failed build, not a rejection nobody awaits', async () => {
  const stateDir = freshStateDir()
  // A file where the agents directory should be: every mkdir under it fails.
  writeFileSync(join(stateDir, 'agents'), 'not a directory')
  const logs: Record<string, unknown>[] = []
  let spawns = 0
  const rail = createMemoryWarmupRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    busy: () => false,
    log: fields => logs.push(fields),
    runner: async () => {
      spawns += 1
      return { exitCode: 0, stdout: '[]\n', stderr: '' }
    },
  })

  expect(outcomes(await rail.warm([anchor('reviewer')]))).toEqual(['reviewer:failed'])
  expect(spawns).toBe(0)
  expect(logs).toEqual([
    expect.objectContaining({
      status: 'failed',
      target: 'reviewer',
      error: expect.stringMatching(/ENOTDIR|EEXIST/),
    }),
  ])
})

test('a missing agent CLI is one failed build, not a crash', async () => {
  const stateDir = freshStateDir()
  const rail = createMemoryWarmupRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    busy: () => false,
    runner: () => {
      throw new Error('spawn duet ENOENT')
    },
  })

  expect(outcomes(await rail.warm([anchor('reviewer')]))).toEqual(['reviewer:failed'])
  expect(existsSync(agentMemoryDbPath(stateDir, 'reviewer'))).toBe(false)
})

test('a build waits while a turn is running and happens on the next cycle instead', async () => {
  const stateDir = freshStateDir()
  let busy = true
  const argvs: string[][] = []
  const logs: Record<string, unknown>[] = []
  const rail = createMemoryWarmupRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    busy: () => busy,
    log: fields => logs.push(fields),
    runner: async argv => {
      argvs.push(argv)
      createDatabase(dbArg(argv), 'built-by-warmup')
      return { exitCode: 0, stdout: '[]\n', stderr: '' }
    },
  })

  // A turn runs for minutes and the reconcile ticks every few seconds: the
  // wait is logged once, not once per tick.
  expect(await rail.warm([anchor('reviewer')])).toEqual([])
  expect(await rail.warm([anchor('reviewer')])).toEqual([])
  expect(await rail.warm([anchor('reviewer')])).toEqual([])
  expect(argvs).toHaveLength(0)
  expect(logs).toEqual([
    { operation: 'agent_memory_warmup', status: 'deferred', reason: 'runners_active' },
  ])

  busy = false
  expect(outcomes(await rail.warm([anchor('reviewer')]))).toEqual(['reviewer:warmed'])
  expect(existsSync(agentMemoryDbPath(stateDir, 'reviewer'))).toBe(true)

  // The next wait is a new one and gets its own line.
  busy = true
  expect(await rail.warm([anchor('reviewer'), anchor('newcomer')])).toEqual([])
  expect(logs.map(fields => fields.status)).toEqual(['deferred', 'warmed', 'deferred'])
})

test('stores are built one at a time, and a turn starting mid-pass stops the queue behind the current build', async () => {
  const stateDir = freshStateDir()
  let busy = false
  let inFlight = 0
  let peakInFlight = 0
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const rail = createMemoryWarmupRail({
    stateDir,
    memoryDbPath: join(stateDir, 'memory.db'),
    busy: () => busy,
    runner: async argv => {
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      started.resolve()
      await finish.promise
      createDatabase(dbArg(argv), 'built-by-warmup')
      // A turn starts while the first store builds.
      busy = true
      inFlight -= 1
      return { exitCode: 0, stdout: '[]\n', stderr: '' }
    },
  })

  const pass = rail.warm([anchor('first'), anchor('second')])
  try {
    await started.promise
    expect(existsSync(agentMemoryDbPath(stateDir, 'first'))).toBe(false)
    expect(existsSync(agentMemoryDbPath(stateDir, 'second'))).toBe(false)
  } finally {
    finish.resolve()
    await pass
  }
  const results = await pass

  expect(outcomes(results)).toEqual(['first:warmed'])
  expect(peakInFlight).toBe(1)
  expect(readFileSync(join(agentMemoryDbPath(stateDir, 'first'), 'PG_VERSION'), 'utf8')).toBe(
    'built-by-warmup',
  )
  expect(existsSync(agentMemoryDbPath(stateDir, 'second'))).toBe(false)
  busy = false
  expect(outcomes(await rail.warm([anchor('first'), anchor('second')]))).toEqual(['second:warmed'])
})

test("the drive root's store — the default agent's memory — is built first, on a workspace that has none", async () => {
  const stateDir = scratchStateDir()
  const rootDb = join(stateDir, 'memory.db')
  const argvs: string[][] = []
  const rail = createMemoryWarmupRail({
    stateDir,
    memoryDbPath: rootDb,
    busy: () => false,
    runner: async argv => {
      argvs.push(argv)
      createDatabase(dbArg(argv), 'built-by-warmup')
      return { exitCode: 0, stdout: '[]\n', stderr: '' }
    },
  })

  expect(outcomes(await rail.warm([anchor('reviewer')]))).toEqual([
    'root:warmed',
    'reviewer:warmed',
  ])
  expect(readFileSync(join(rootDb, 'PG_VERSION'), 'utf8')).toBe('built-by-warmup')
  expect(dirname(dbArg(argvs[0]!))).toBe(stateDir)
  expect(readdirSync(stateDir).sort()).toEqual(['agents', 'memory.db'])
  expect(await rail.warm([anchor('reviewer')])).toEqual([])
  expect(argvs).toHaveLength(2)
})
