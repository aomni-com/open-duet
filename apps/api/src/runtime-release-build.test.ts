import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const SCRIPT = 'build-runtime-release.mjs'

test('runtime identity changes on helper-only and CLI-only bytes', async () => {
  const root = await mkdtemp(join(REPO_ROOT, 'apps/api/.runtime-release-test-'))
  try {
    const gateway = join(root, 'packages/gateway/dist')
    const scripts = join(root, 'apps/api/scripts')
    const payload = join(root, 'payload')
    await Promise.all([
      mkdir(gateway, { recursive: true }),
      mkdir(scripts, { recursive: true }),
      mkdir(payload),
    ])
    await copyFile(join(REPO_ROOT, 'apps/api/scripts', SCRIPT), join(scripts, SCRIPT))
    await cp(join(REPO_ROOT, 'packages/contract/src'), join(root, 'packages/contract/src'), {
      recursive: true,
    })
    await mkdir(join(root, 'packages/agent/src'), { recursive: true })
    await copyFile(
      join(REPO_ROOT, 'packages/agent/src/runtime-assets.ts'),
      join(root, 'packages/agent/src/runtime-assets.ts'),
    )
    await writeFile(
      join(root, 'packages/gateway/package.json'),
      JSON.stringify({ version: '0.0.0' }),
    )
    await writeFile(join(gateway, 'index.js'), 'gateway')
    await writeFile(join(gateway, 'helper.js'), 'helper')
    await writeFile(join(payload, 'duet-linux-x64'), 'duet')
    for (const name of [
      'pglite.data',
      'pglite.wasm',
      'initdb.wasm',
      'vector.tar.gz',
      'photon_rs_bg.wasm',
    ])
      await writeFile(join(payload, name), name)
    async function build() {
      const child = Bun.spawn(['bun', join(scripts, SCRIPT), '--payload-dir', payload], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
      if (code !== 0) throw new Error(error)
      return JSON.parse(
        await readFile(join(root, 'apps/api/dist/runtime-release/manifest.json'), 'utf8'),
      )
    }
    const first = await build()
    expect(first.formatVersion).toBe(1)
    const names = [
      'duet',
      'helper.js',
      'index.js',
      'initdb.wasm',
      'pglite.data',
      'pglite.wasm',
      'photon_rs_bg.wasm',
      'vector.tar.gz',
    ]
    expect(first.artifacts.map((artifact: { name: string }) => artifact.name)).toEqual(names)
    const release = join(root, 'apps/api/dist/runtime-release')
    expect((await readdir(release)).sort()).toEqual([...names, 'manifest.json'].sort())
    for (const artifact of first.artifacts) {
      const path = join(release, artifact.name)
      expect(artifact.byteLength).toBe((await stat(path)).size)
      expect(artifact.mode).toBe(artifact.name === 'duet' ? 0o755 : 0o644)
      expect((await stat(path)).mode & 0o777).toBe(artifact.mode)
      expect(artifact.sha256).toBe(
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      )
    }
    expect(first.version).toBe(
      '0.0.0+' +
        createHash('sha256')
          .update(JSON.stringify({ formatVersion: 1, artifacts: first.artifacts }))
          .digest('hex'),
    )
    await writeFile(join(gateway, 'helper.js'), 'changed helper')
    const helper = await build()
    expect(helper.version).not.toBe(first.version)
    await writeFile(join(payload, 'duet-linux-x64'), 'changed duet')
    const cli = await build()
    expect(cli.version).not.toBe(helper.version)
    await rm(join(payload, 'photon_rs_bg.wasm'))
    await expect(build()).rejects.toThrow('photon_rs_bg.wasm')
    expect(JSON.parse(await readFile(join(release, 'manifest.json'), 'utf8')).version).toBe(
      cli.version,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('API build emits only the complete runtime inventory', async () => {
  const build = Bun.spawn(['bun', 'run', '--cwd', 'apps/api', 'build'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ])
  if (code !== 0) throw new Error(`API build failed\n${stdout}\n${stderr}`)
  const release = join(REPO_ROOT, 'apps/api/dist/runtime-release')
  const manifest = JSON.parse(await readFile(join(release, 'manifest.json'), 'utf8'))
  expect((await readdir(release)).sort()).toEqual([
    'duet',
    'helper.js',
    'index.js',
    'initdb.wasm',
    'manifest.json',
    'pglite.data',
    'pglite.wasm',
    'photon_rs_bg.wasm',
    'vector.tar.gz',
  ])
  for (const artifact of manifest.artifacts) {
    expect(artifact.sha256).toBe(
      createHash('sha256')
        .update(await readFile(join(release, artifact.name)))
        .digest('hex'),
    )
  }
}, 120_000)
