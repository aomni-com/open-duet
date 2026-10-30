import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalRuntimeReleaseIdentityInput, PROVIDER_MODEL_ALIASES } from '@repo/contract'

import { applyRuntimeRelease, inspectRelease } from '../runtime-release'
import { runtimeFixture } from '../testing/runtime-release-fixture'

// Bundle the same routing owner production imports, changing only alias metadata
// through the bundler's source seam. The activation and integrity rail is real.
test('a routing change in a whole-runtime release reaches a nested cwd after reconnect and the next resumed turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-routing-release-'))
  const children: Array<ReturnType<typeof Bun.spawn>> = []
  const results: Promise<unknown>[] = []
  try {
    const entry = join(root, 'entry.ts')
    await writeFile(
      entry,
      `export { prepareRoutingConfig, MANAGED_ROUTING_TABLE } from ${JSON.stringify(join(import.meta.dir, 'routing-config.ts'))}\n`,
    )
    const release = async (replacement?: string) => {
      const outfile = join(root, replacement ? 'next.js' : 'first.js')
      const build = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'routing-build.test-helper.ts'),
          entry,
          outfile,
          ...(replacement ? [replacement] : []),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      children.push(build)
      const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()])
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      const index = await readFile(outfile, 'utf8')
      const fixture = runtimeFixture(replacement ? 'next-routing-runtime' : 'first-routing-runtime')
      fixture.bytes.set('index.js', Buffer.from(index))
      const artifact = fixture.manifest.artifacts.find(item => item.name === 'index.js')!
      artifact.sha256 = createHash('sha256').update(index).digest('hex')
      artifact.byteLength = Buffer.byteLength(index)
      fixture.manifest.version = `0.0.0+${createHash('sha256').update(canonicalRuntimeReleaseIdentityInput(fixture.manifest.artifacts)).digest('hex')}`
      return fixture
    }
    const first = await release()
    const original = PROVIDER_MODEL_ALIASES['openai-frontier']
    const replacement = original.gatewayModelId === 'openai/gpt-6-sol' ? 'gpt-6-astra' : 'gpt-6-sol'
    const next = await release(replacement)
    expect(next.manifest.version).not.toBe(first.manifest.version)
    const releasesDir = join(root, 'releases')
    const currentReleaseLink = join(root, 'current')
    const previousReleaseLink = join(root, 'previous')
    let offline = false
    const activate = (artifact: typeof first) =>
      applyRuntimeRelease({
        releasesDir,
        currentReleaseLink,
        previousReleaseLink,
        apiUrl: 'https://fixture.test',
        token: 'fixture',
        desiredVersion: artifact.manifest.version,
        descriptor: {
          ...artifact.manifest,
          artifacts: artifact.manifest.artifacts.map(item => ({
            ...item,
            href: `https://fixture.test/v1/vm/runtime-release/artifacts/${item.name}`,
          })),
        },
        fetch: async input => {
          if (offline) throw new Error('offline')
          return artifact.fetch(input)
        },
      })
    await activate(first)
    const firstDir = await readlink(currentReleaseLink)
    const oldRuntime = await import(join(firstDir, 'index.js'))
    const cwd = join(root, 'drive', 'agents', 'nested')
    await mkdir(cwd, { recursive: true })
    oldRuntime.prepareRoutingConfig(cwd)
    const checkpoint = join(root, 'checkpoint.json')
    const start = (hold: boolean) => {
      let ready: () => void = () => undefined
      const readyPromise = new Promise<void>(resolve => {
        ready = resolve
      })
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'routing-agent.test-helper.ts'),
          cwd,
          'openai-frontier',
          ...(hold ? ['--hold'] : []),
        ],
        {
          cwd,
          env: {
            ...process.env,
            HOME: root,
            DUET_API_KEY: 'fixture',
            ROUTING_CHECKPOINT_PATH: checkpoint,
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          ipc: () => ready(),
        },
      )
      children.push(child)
      const result = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).then(([stdout, stderr, code]) => {
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
        return JSON.parse(stdout.trim().split('\n').at(-1)!)
      })
      results.push(result)
      return { child, ready: readyPromise, result }
    }
    const activeTurn = start(true)
    await activeTurn.ready
    offline = true
    await expect(activate(next)).rejects.toThrow('offline')
    expect(await readlink(currentReleaseLink)).toBe(firstDir)
    offline = false
    await activate(next)
    const nextDir = await readlink(currentReleaseLink)
    expect(await inspectRelease(nextDir)).toEqual({ ok: true, version: next.manifest.version })
    const newRuntime = await import(join(nextDir, 'index.js'))
    newRuntime.prepareRoutingConfig(cwd)
    expect(
      JSON.parse(await readFile(join(cwd, '.duet/models.json'), 'utf8')).tiers['openai-frontier']
        .routes.general.target.modelName,
    ).toBe(replacement)
    activeTurn.child.stdin.end()
    const before = await activeTurn.result
    const after = await start(false).result
    expect(before.selection).toBe('openai-frontier')
    expect(after.selection).toBe('openai-frontier')
    expect(before.requests).toEqual([
      { model: original.gatewayModelId, header: { 'x-duet-tier': 'openai-frontier' } },
    ])
    expect(after.requests).toEqual([
      { model: `openai/${replacement}`, header: { 'x-duet-tier': 'openai-frontier' } },
    ])
  } finally {
    for (const child of children) child.kill()
    await Promise.allSettled(results)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
