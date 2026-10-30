import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readBootState, writeBootState } from './boot-health'
import { runRuntimeBootstrap } from './runtime-bootstrap'
import { inspectRelease } from './runtime-release'
import { runtimeFixture } from './testing/runtime-release-fixture'

async function scratch(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-bootstrap-'))
  try {
    await mkdir(join(root, 'state'))
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
function bootstrapEnv(root: string): Record<string, string> {
  return {
    DUET_STATE_DIR: join(root, 'state'),
    DUET_RELEASES_DIR: join(root, 'releases'),
    DUET_CURRENT_RELEASE_LINK: join(root, 'current'),
    DUET_PREVIOUS_RELEASE_LINK: join(root, 'previous'),
  }
}
function quietDependencies(bootId: string) {
  return { bootId: async () => bootId, log: () => undefined }
}

test('bootstrap ignores a healthy marker for a different runtime', async () => {
  await scratch(async root => {
    const a = runtimeFixture('release-a'),
      b = runtimeFixture('release-b')
    const dir = join(root, 'releases', a.manifest.version)
    await a.write(dir)
    await symlink(dir, join(root, 'current'))
    await writeBootState(join(root, 'state'), {
      attemptedVersion: a.manifest.version,
      consecutiveFailures: 0,
      healthyVersion: b.manifest.version,
      healthyAt: 123,
    })
    expect(await runRuntimeBootstrap(bootstrapEnv(root), quietDependencies('boot-1'))).toBe(0)
    expect(await readBootState(join(root, 'state'))).toEqual({
      attemptedVersion: a.manifest.version,
      consecutiveFailures: 1,
      healthyVersion: b.manifest.version,
      healthyAt: 123,
    })
  })
})

test('three pre-probation crashes roll back the whole runtime and quarantine blocks re-adoption', async () => {
  await scratch(async root => {
    const failed = runtimeFixture('failed'),
      good = runtimeFixture('good')
    const failedDir = join(root, 'releases', failed.manifest.version),
      goodDir = join(root, 'releases', good.manifest.version)
    await failed.write(failedDir)
    await good.write(goodDir)
    await symlink(failedDir, join(root, 'current'))
    await symlink(goodDir, join(root, 'previous'))
    await writeBootState(join(root, 'state'), {
      attemptedVersion: failed.manifest.version,
      consecutiveFailures: 0,
      previousVersion: good.manifest.version,
    })
    for (let crash = 1; crash <= 2; crash++) {
      expect(
        await runRuntimeBootstrap(bootstrapEnv(root), quietDependencies(`boot-${crash}`)),
      ).toBe(0)
      expect(await readlink(join(root, 'current'))).toBe(failedDir)
    }
    expect(await runRuntimeBootstrap(bootstrapEnv(root), quietDependencies('boot-3'))).toBe(0)
    expect(await readlink(join(root, 'current'))).toBe(goodDir)
    expect(await readBootState(join(root, 'state'))).toEqual({
      attemptedVersion: good.manifest.version,
      consecutiveFailures: 0,
      previousVersion: failed.manifest.version,
      quarantinedVersion: failed.manifest.version,
    })
    for (const artifact of good.manifest.artifacts)
      expect(await readFile(join(root, 'current', artifact.name))).toEqual(
        good.bytes.get(artifact.name)!,
      )
    await rm(join(goodDir, 'duet'))
    await writeFile(join(root, 'state', 'vm-token'), 'vm-token\n')
    expect(
      await runRuntimeBootstrap(
        { ...bootstrapEnv(root), DUET_API_URL: 'https://api.test' },
        { ...quietDependencies('boot-4'), fetch: failed.fetch },
      ),
    ).toBe(1)
    expect(await readlink(join(root, 'current'))).toBe(goodDir)
    expect((await readBootState(join(root, 'state')))?.quarantinedVersion).toBe(
      failed.manifest.version,
    )
  })
})

test('stable bootstrap repairs with the durable token and inherited headers', async () => {
  await scratch(async root => {
    const fixture = runtimeFixture('repair')
    const dir = join(root, 'releases', fixture.manifest.version)
    await fixture.write(dir)
    await symlink(dir, join(root, 'current'))
    await writeFile(join(dir, 'pglite.wasm'), 'corrupt')
    await writeFile(join(root, 'state', 'vm-token'), 'vm-token\n')
    expect(
      await runRuntimeBootstrap(
        {
          ...bootstrapEnv(root),
          DUET_API_URL: 'https://api.test',
          DUET_GATEWAY_EXTRA_HEADERS_JSON: '{"bypass-tunnel-reminder":"duet"}',
        },
        {
          ...quietDependencies('boot-1'),
          fetch: async (input, init) => {
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer vm-token')
            expect(new Headers(init?.headers).get('bypass-tunnel-reminder')).toBe('duet')
            return fixture.fetch(input)
          },
        },
      ),
    ).toBe(0)
    expect(await inspectRelease(dir)).toEqual({ ok: true, version: fixture.manifest.version })
  })
})

test('bootstrap refuses the old two-artifact manifest even as online rescue', async () => {
  await scratch(async root => {
    const fixture = runtimeFixture('old')
    const dir = join(root, 'releases', 'old')
    await fixture.write(dir)
    const oldManifest = {
      version: '0.0.0+old',
      sha256: fixture.manifest.artifacts.find(a => a.name === 'index.js')!.sha256,
      helperSha256: fixture.manifest.artifacts.find(a => a.name === 'helper.js')!.sha256,
    }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(oldManifest))
    await symlink(dir, join(root, 'current'))
    await writeFile(join(root, 'state', 'vm-token'), 'vm-token')
    const urls: string[] = []
    expect(
      await runRuntimeBootstrap(
        { ...bootstrapEnv(root), DUET_API_URL: 'https://api.test' },
        {
          ...quietDependencies('boot-1'),
          fetch: async url => {
            urls.push(String(url))
            return Response.json(oldManifest)
          },
        },
      ),
    ).toBe(1)
    expect(urls).toEqual(['https://api.test/v1/vm/runtime-release/manifest'])
    expect((await inspectRelease(dir)).ok).toBe(false)
    expect(await readlink(join(root, 'current'))).toBe(dir)
    expect(await readBootState(join(root, 'state'))).toBeNull()
  })
})

test('a fixed content release recovers a quarantined first runtime with no previous release', async () => {
  await scratch(async root => {
    const failed = runtimeFixture('first-image'),
      fixed = runtimeFixture('fixed')
    const failedDir = join(root, 'releases', failed.manifest.version)
    await failed.write(failedDir)
    await symlink(failedDir, join(root, 'current'))
    await writeBootState(join(root, 'state'), {
      attemptedVersion: failed.manifest.version,
      consecutiveFailures: 2,
    })
    await writeFile(join(root, 'state', 'vm-token'), 'token')
    const env = { ...bootstrapEnv(root), DUET_API_URL: 'https://api.test' }
    expect(
      await runRuntimeBootstrap(env, { ...quietDependencies('boot-3'), fetch: failed.fetch }),
    ).toBe(1)
    expect((await readBootState(join(root, 'state')))?.quarantinedVersion).toBe(
      failed.manifest.version,
    )
    expect(
      await runRuntimeBootstrap(env, { ...quietDependencies('boot-4'), fetch: fixed.fetch }),
    ).toBe(0)
    expect(await readlink(join(root, 'current'))).toBe(
      join(root, 'releases', fixed.manifest.version),
    )
    expect(await readBootState(join(root, 'state'))).toEqual({
      attemptedVersion: fixed.manifest.version,
      consecutiveFailures: 0,
      previousVersion: failed.manifest.version,
      quarantinedVersion: failed.manifest.version,
    })
    expect(await inspectRelease(join(root, 'current'))).toEqual({
      ok: true,
      version: fixed.manifest.version,
    })
  })
})
