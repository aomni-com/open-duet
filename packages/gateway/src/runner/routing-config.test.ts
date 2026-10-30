import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROVIDER_MODEL_ALIASES } from '@repo/contract'

import { defaultAtomicJsonOperations } from '../atomic-json'
import { MANAGED_ROUTING_TABLE, prepareRoutingConfig } from './routing-config'

test('managed routing replaces a stale nearer file and leaves identical bytes untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-routing-'))
  try {
    const cwd = join(root, 'agents', 'nested')
    await mkdir(join(cwd, '.duet'), { recursive: true })
    const path = join(cwd, '.duet', 'models.json')
    await writeFile(path, '{stale malformed config')
    prepareRoutingConfig(cwd)
    const contents = await readFile(path, 'utf8')
    const table = JSON.parse(contents)
    expect(table.tiers.frontier.routes.general.target.modelName).toBeString()
    const before = await stat(path)
    prepareRoutingConfig(cwd)
    expect(await readFile(path, 'utf8')).toBe(contents)
    expect((await stat(path)).ino).toBe(before.ino)
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the spawn factory refreshes the actual nested cwd and refuses an unwritable config', async () => {
  const { defaultRunnerFactory } = await import('./process-runner')
  const root = await mkdtemp(join(tmpdir(), 'duet-routing-spawn-'))
  try {
    const nested = join(root, 'agent', 'project')
    await mkdir(nested, { recursive: true })
    const args = {
      sessionId: 'routing',
      cwd: 'agent/project',
      tier: 'balanced' as const,
      memoryDbPath: join(root, 'memory.db'),
      systemPromptFiles: [],
    }
    defaultRunnerFactory(args, root)
    const table = JSON.parse(await readFile(join(nested, '.duet/models.json'), 'utf8'))
    expect(table.defaultTier).toBeString()
    // A failed preparation must not launch using the last release's stale file.
    await rm(join(nested, '.duet'), { recursive: true })
    await writeFile(join(nested, '.duet'), 'not a directory')
    expect(() => defaultRunnerFactory(args, root)).toThrow()
    await rm(join(nested, '.duet'))
    defaultRunnerFactory(args, root)
    expect(JSON.parse(await readFile(join(nested, '.duet/models.json'), 'utf8'))).toEqual(table)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each([false, true])(
  'the installed agent keeps alias attribution and model choice (provider failure: %s)',
  async failure => {
    const root = await mkdtemp(join(tmpdir(), 'duet-alias-runtime-'))
    const children: Array<ReturnType<typeof Bun.spawn>> = []
    try {
      prepareRoutingConfig(root)
      for (const alias of Object.values(PROVIDER_MODEL_ALIASES)) {
        const selection = alias.id
        const model = alias.gatewayModelId
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, 'routing-agent.test-helper.ts'),
            root,
            selection,
            ...(failure ? ['--fail'] : []),
          ],
          {
            cwd: root,
            env: { ...process.env, HOME: root, DUET_API_KEY: 'routing-fixture-key' },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        children.push(child)
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
        const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
        expect(result.selection).toBe(selection)
        expect(result.requests).toEqual([{ model, header: { 'x-duet-tier': selection } }])
        expect(result.errors).toEqual(failure ? [model] : [])
        expect(result.classifierCalls).toBe(0)
        expect(result.status.advisorEnabled).toBe(false)
        expect(result.status.thinkingLevel).toBe(
          MANAGED_ROUTING_TABLE.tiers[selection]!.routes.general!.target!.thinkingLevel,
        )
      }
    } finally {
      for (const child of children) child.kill()
      await Promise.allSettled(children.map(child => child.exited))
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

test.each(['frontier', 'balanced'])(
  'managed %s preserves advisor policy for fresh and resumed sessions at a nested cwd',
  async tier => {
    const root = await mkdtemp(join(tmpdir(), 'duet-compound-routing-'))
    const children: Array<ReturnType<typeof Bun.spawn>> = []
    try {
      const cwd = join(root, 'agent', 'project')
      await mkdir(join(cwd, '.duet'), { recursive: true })
      const checkpoint = join(root, 'checkpoint.json')
      for (const phase of ['fresh', 'resumed']) {
        await writeFile(join(cwd, '.duet/models.json'), '{stale config')
        prepareRoutingConfig(cwd)
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, 'routing-agent.test-helper.ts'),
            cwd,
            tier,
            '--compound',
          ],
          {
            cwd,
            env: {
              ...process.env,
              HOME: root,
              DUET_API_KEY: 'routing-fixture-key',
              ROUTING_CHECKPOINT_PATH: checkpoint,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        children.push(child)
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect({ phase, code, stderr }).toEqual({ phase, code: 0, stderr: '' })
        const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
        expect(result.status.advisorEnabled).toBe(
          MANAGED_ROUTING_TABLE.tiers[tier]!.advisor.enabled,
        )
        expect(result.terminal).toBe('complete')
        expect(result.selection).toBe(tier)
        expect(result.requests.length).toBeGreaterThan(0)
        expect(
          result.requests.every(
            (request: { header: Record<string, string> }) => request.header['x-duet-tier'] === tier,
          ),
        ).toBe(true)
      }
    } finally {
      for (const child of children) child.kill()
      await Promise.allSettled(children.map(child => child.exited))
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

test('an atomic replacement failure refuses the spawn and a later attempt recovers', async () => {
  const { defaultRunnerFactory } = await import('./process-runner')
  const root = await mkdtemp(join(tmpdir(), 'duet-routing-write-failed-'))
  const rename = spyOn(defaultAtomicJsonOperations, 'rename')
  try {
    await mkdir(join(root, '.duet'))
    const path = join(root, '.duet/models.json')
    await writeFile(path, 'stale')
    const args = {
      sessionId: 'failed-write',
      tier: 'openai-max' as const,
      memoryDbPath: join(root, 'memory.db'),
      systemPromptFiles: [],
    }
    rename.mockImplementationOnce(() => {
      throw new Error('rename fixture failure')
    })
    expect(() => defaultRunnerFactory(args, root)).toThrow('rename fixture failure')
    expect(await readFile(path, 'utf8')).toBe('stale')
    rename.mockRestore()
    defaultRunnerFactory(args, root)
    expect(
      JSON.parse(await readFile(path, 'utf8')).tiers['openai-max'].routes.general.target.modelName,
    ).toBe(PROVIDER_MODEL_ALIASES['openai-max'].modelName)
  } finally {
    rename.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
