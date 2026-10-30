import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { check } from 'proper-lockfile'

import { canonicalRuntimeReleaseIdentityInput } from '@repo/contract'

import {
  applyRuntimeRelease,
  RUNTIME_RELEASE_LOCK_FILE,
  ensureBootableCurrent,
  inspectRelease,
  type RuntimeReleaseOperations,
} from './runtime-release'
import { runtimeFixture } from './testing/runtime-release-fixture'

async function scratch(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-release-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
function input(root: string) {
  return {
    releasesDir: join(root, 'releases'),
    currentReleaseLink: join(root, 'current'),
    previousReleaseLink: join(root, 'previous'),
    apiUrl: 'https://api.test',
    token: 'token',
  }
}

test('installs the complete runtime inventory with executable and data modes', async () => {
  await scratch(async root => {
    const fixture = runtimeFixture('installed')
    const dir = await applyRuntimeRelease({
      ...input(root),
      desiredVersion: fixture.manifest.version,
      fetch: fixture.fetch,
    })
    expect(await readlink(join(root, 'current'))).toBe(dir!)
    expect(await inspectRelease(dir!)).toEqual({ ok: true, version: fixture.manifest.version })
    for (const artifact of fixture.manifest.artifacts) {
      expect(await readFile(join(dir!, artifact.name))).toEqual(fixture.bytes.get(artifact.name)!)
      expect((await stat(join(dir!, artifact.name))).mode & 0o777).toBe(artifact.mode)
    }
    expect(JSON.parse(await readFile(join(dir!, 'manifest.json'), 'utf8'))).toEqual(
      fixture.manifest,
    )
  })
})

test('boots a complete local runtime without network or token', async () => {
  await scratch(async root => {
    const fixture = runtimeFixture('offline')
    const dir = join(input(root).releasesDir, fixture.manifest.version)
    await fixture.write(dir)
    await symlink(dir, join(root, 'current'))
    expect(
      await ensureBootableCurrent({
        ...input(root),
        token: null,
        fetch: async () => {
          throw new Error('offline')
        },
      }),
    ).toEqual({ status: 'healthy', version: fixture.manifest.version })
  })
})

for (const damaged of ['duet', 'pglite.wasm', 'photon_rs_bg.wasm', 'helper.js'] as const) {
  test(`repairs only damaged ${damaged} and preserves the complete release`, async () => {
    await scratch(async root => {
      const fixture = runtimeFixture('repair')
      const dir = join(input(root).releasesDir, fixture.manifest.version)
      await fixture.write(dir)
      if (damaged === 'pglite.wasm') await rm(join(dir, damaged))
      else if (damaged === 'duet') await chmod(join(dir, damaged), 0o644)
      else await writeFile(join(dir, damaged), Buffer.alloc(fixture.bytes.get(damaged)!.length, 0))
      expect((await inspectRelease(dir)).ok).toBe(false)
      await symlink(dir, join(root, 'current'))
      const urls: string[] = []
      const result = await ensureBootableCurrent({
        ...input(root),
        fetch: async url => {
          urls.push(String(url))
          return fixture.fetch(url)
        },
      })
      expect(result).toEqual({ status: 'repaired', version: fixture.manifest.version })
      expect(urls).toEqual([
        'https://api.test/v1/vm/runtime-release/manifest',
        `https://api.test/v1/vm/runtime-release/artifacts/${damaged}`,
      ])
      expect(await inspectRelease(dir)).toEqual({ ok: true, version: fixture.manifest.version })
    })
  })
}

test('restores a missing manifest without refetching valid runtime artifacts', async () => {
  await scratch(async root => {
    const fixture = runtimeFixture('manifest')
    const dir = join(input(root).releasesDir, fixture.manifest.version)
    await fixture.write(dir)
    await rm(join(dir, 'manifest.json'))
    await symlink(dir, join(root, 'current'))
    const urls: string[] = []
    expect(
      await ensureBootableCurrent({
        ...input(root),
        fetch: async url => {
          urls.push(String(url))
          return fixture.fetch(url)
        },
      }),
    ).toEqual({ status: 'repaired', version: fixture.manifest.version })
    expect(urls).toEqual(['https://api.test/v1/vm/runtime-release/manifest'])
    expect(await inspectRelease(dir)).toEqual({ ok: true, version: fixture.manifest.version })
  })
})

test('adopts a full runtime and retains only it and the verified previous release', async () => {
  await scratch(async root => {
    const old = runtimeFixture('corrupt-current'),
      previous = runtimeFixture('rollback'),
      next = runtimeFixture('new')
    const oldDir = join(input(root).releasesDir, old.manifest.version),
      previousDir = join(input(root).releasesDir, previous.manifest.version)
    await old.write(oldDir)
    await previous.write(previousDir)
    await writeFile(join(oldDir, 'index.js'), 'corrupt')
    await symlink(oldDir, join(root, 'current'))
    await symlink(previousDir, join(root, 'previous'))
    expect(await ensureBootableCurrent({ ...input(root), fetch: next.fetch })).toEqual({
      status: 'adopted',
      version: next.manifest.version,
    })
    expect(await readlink(join(root, 'current'))).toBe(
      join(input(root).releasesDir, next.manifest.version),
    )
    expect(await readlink(join(root, 'previous'))).toBe(previousDir)
    expect(
      (await readdir(input(root).releasesDir, { withFileTypes: true }))
        .filter(item => item.isDirectory())
        .map(item => item.name)
        .sort(),
    ).toEqual([next.manifest.version, previous.manifest.version].sort())
  })
})

test('offline recovery rolls back the complete matched runtime after asset corruption', async () => {
  await scratch(async root => {
    const bad = runtimeFixture('bad'),
      good = runtimeFixture('good')
    const badDir = join(input(root).releasesDir, bad.manifest.version),
      goodDir = join(input(root).releasesDir, good.manifest.version)
    await bad.write(badDir)
    await good.write(goodDir)
    await rm(join(badDir, 'vector.tar.gz'))
    await symlink(badDir, join(root, 'current'))
    await symlink(goodDir, join(root, 'previous'))
    expect(
      await ensureBootableCurrent({
        ...input(root),
        fetch: async () => {
          throw new Error('offline')
        },
      }),
    ).toEqual({ status: 'rolled_back', version: good.manifest.version })
    expect(await readlink(join(root, 'current'))).toBe(goodDir)
    for (const artifact of good.manifest.artifacts)
      expect(await readFile(join(root, 'current', artifact.name))).toEqual(
        good.bytes.get(artifact.name)!,
      )
  })
})

for (const stage of [
  'download',
  'hash',
  'length',
  'write',
  'fsync',
  'rename',
  'symlink',
] as const) {
  test(`failed ${stage} candidate preserves current and can be retried`, async () => {
    await scratch(async root => {
      const old = runtimeFixture('old'),
        next = runtimeFixture('next')
      const oldDir = join(input(root).releasesDir, old.manifest.version)
      await old.write(oldDir)
      await symlink(oldDir, join(root, 'current'))
      const operations: Partial<RuntimeReleaseOperations> = {}
      if (stage === 'write')
        operations.writeSyncedFile = async () => {
          throw new Error('write injected')
        }
      if (stage === 'fsync')
        operations.fsyncDir = async () => {
          throw new Error('fsync injected')
        }
      if (stage === 'rename')
        operations.rename = async () => {
          throw new Error('rename injected')
        }
      if (stage === 'symlink')
        operations.symlink = async () => {
          throw new Error('symlink injected')
        }
      await expect(
        applyRuntimeRelease({
          ...input(root),
          desiredVersion: next.manifest.version,
          operations,
          fetch: async url => {
            if (String(url).endsWith('/duet')) {
              if (stage === 'download') throw new Error('download injected')
              if (stage === 'hash')
                return new Response(Buffer.alloc(next.bytes.get('duet')!.length))
              if (stage === 'length') return new Response('truncated')
            }
            return next.fetch(url)
          },
        }),
      ).rejects.toThrow()
      expect(await readlink(join(root, 'current'))).toBe(oldDir)
      expect(await inspectRelease(oldDir)).toEqual({ ok: true, version: old.manifest.version })
      const candidateDir = join(input(root).releasesDir, next.manifest.version)
      expect((await readdir(candidateDir)).filter(name => name.endsWith('.partial'))).toEqual([])
      expect(
        await applyRuntimeRelease({
          ...input(root),
          desiredVersion: next.manifest.version,
          fetch: next.fetch,
        }),
      ).toBe(candidateDir)
      expect(await inspectRelease(candidateDir)).toEqual({
        ok: true,
        version: next.manifest.version,
      })
    })
  })
}

test('a superseding desire cancels activation after a complete descriptor is staged', async () => {
  await scratch(async root => {
    const old = runtimeFixture('old'),
      next = runtimeFixture('next')
    const oldDir = join(input(root).releasesDir, old.manifest.version)
    await old.write(oldDir)
    await symlink(oldDir, join(root, 'current'))
    let allowed = true
    const result = await applyRuntimeRelease({
      ...input(root),
      desiredVersion: next.manifest.version,
      descriptor: {
        ...next.manifest,
        artifacts: next.manifest.artifacts.map(artifact => ({
          ...artifact,
          href: `https://api.test/v1/vm/runtime-release/artifacts/${artifact.name}`,
        })),
      },
      activateIfCurrent: async activate => {
        if (!allowed) return false
        await activate()
        return true
      },
      fetch: async url => {
        allowed = false
        return next.fetch(url)
      },
    })
    expect(result).toBeNull()
    expect(await readlink(join(root, 'current'))).toBe(oldDir)
    const candidateDir = join(input(root).releasesDir, next.manifest.version)
    expect(await inspectRelease(candidateDir)).toEqual({ ok: true, version: next.manifest.version })
    expect(JSON.parse(await readFile(join(candidateDir, 'manifest.json'), 'utf8'))).toEqual(
      next.manifest,
    )
  })
})

test('update and bootstrap recovery serialize on one runtime rail', async () => {
  await scratch(async root => {
    const old = runtimeFixture('old'),
      next = runtimeFixture('next')
    const oldDir = join(input(root).releasesDir, old.manifest.version)
    await old.write(oldDir)
    await symlink(oldDir, join(root, 'current'))
    let download!: () => void, started!: () => void
    const permit = new Promise<void>(resolve => {
        download = resolve
      }),
      didStart = new Promise<void>(resolve => {
        started = resolve
      })
    const update = applyRuntimeRelease({
      ...input(root),
      desiredVersion: next.manifest.version,
      fetch: async url => {
        if (String(url).endsWith('/duet')) {
          started()
          await permit
        }
        return next.fetch(url)
      },
    })
    await didStart
    let settled = false
    const recovery = ensureBootableCurrent({
      ...input(root),
      token: null,
      fetch: async () => {
        throw new Error('offline')
      },
    }).finally(() => {
      settled = true
    })
    await Bun.sleep(10)
    expect(settled).toBe(false)
    download()
    await update
    expect(await recovery).toEqual({ status: 'healthy', version: next.manifest.version })
  })
})

test('manifest identity mismatch is rejected before any artifact can activate', async () => {
  await scratch(async root => {
    const fixture = runtimeFixture('identity')
    const changed = runtimeFixture('changed')
    const requests: string[] = []
    await expect(
      applyRuntimeRelease({
        ...input(root),
        desiredVersion: fixture.manifest.version,
        fetch: async url => {
          requests.push(String(url))
          return String(url).endsWith('/manifest')
            ? Response.json({ ...fixture.manifest, artifacts: changed.manifest.artifacts })
            : changed.fetch(url)
        },
      }),
    ).rejects.toThrow('content identity mismatch')
    expect(requests).toEqual(['https://api.test/v1/vm/runtime-release/manifest'])
    await expect(readlink(join(root, 'current'))).rejects.toThrow()
  })
})

test('an interrupted payload rename leaves no bootable partial candidate and retry converges', async () => {
  await scratch(async root => {
    const old = runtimeFixture('old'),
      candidate = runtimeFixture('candidate')
    const oldDir = join(input(root).releasesDir, old.manifest.version)
    const candidateDir = join(input(root).releasesDir, candidate.manifest.version)
    await old.write(oldDir)
    await symlink(oldDir, join(root, 'current'))
    await expect(
      applyRuntimeRelease({
        ...input(root),
        desiredVersion: candidate.manifest.version,
        fetch: candidate.fetch,
        operations: {
          rename: async (from, to) => {
            if (from.endsWith('/pglite.wasm.partial')) throw new Error('interrupted payload rename')
            await rename(from, to)
          },
        },
      }),
    ).rejects.toThrow('interrupted payload rename')
    expect(await readFile(join(candidateDir, 'duet'))).toEqual(candidate.bytes.get('duet')!)
    expect((await inspectRelease(candidateDir)).ok).toBe(false)
    expect(await readlink(join(root, 'current'))).toBe(oldDir)
    expect(
      await ensureBootableCurrent({
        ...input(root),
        token: null,
        fetch: async () => {
          throw new Error('offline')
        },
      }),
    ).toEqual({ status: 'healthy', version: old.manifest.version })
    expect(
      await applyRuntimeRelease({
        ...input(root),
        desiredVersion: candidate.manifest.version,
        fetch: candidate.fetch,
      }),
    ).toBe(candidateDir)
    expect(await inspectRelease(candidateDir)).toEqual({
      ok: true,
      version: candidate.manifest.version,
    })
  })
})

test('offline recovery never rolls back into the quarantined runtime', async () => {
  await scratch(async root => {
    const current = runtimeFixture('current'),
      failed = runtimeFixture('quarantined')
    const currentDir = join(input(root).releasesDir, current.manifest.version),
      failedDir = join(input(root).releasesDir, failed.manifest.version)
    await current.write(currentDir)
    await failed.write(failedDir)
    await rm(join(currentDir, 'duet'))
    await symlink(currentDir, join(root, 'current'))
    await symlink(failedDir, join(root, 'previous'))
    const result = await ensureBootableCurrent({
      ...input(root),
      quarantinedVersion: failed.manifest.version,
      fetch: async () => {
        throw new Error('offline')
      },
    })
    expect(result.status).toBe('retryable_failure')
    expect(await readlink(join(root, 'current'))).toBe(currentDir)
  })
})

test('matching hashes cannot activate an inventory with an incorrect byte length', async () => {
  await scratch(async root => {
    const fixture = runtimeFixture('wrong-length')
    const artifacts = fixture.manifest.artifacts.map(artifact =>
      artifact.name === 'duet' ? { ...artifact, byteLength: artifact.byteLength + 1 } : artifact,
    )
    const version = `0.0.0+${createHash('sha256').update(canonicalRuntimeReleaseIdentityInput(artifacts)).digest('hex')}`
    await expect(
      applyRuntimeRelease({
        ...input(root),
        desiredVersion: version,
        fetch: async url =>
          String(url).endsWith('/manifest')
            ? Response.json({ ...fixture.manifest, version, artifacts })
            : fixture.fetch(url),
      }),
    ).rejects.toThrow('byte length mismatch')
    await expect(readlink(join(root, 'current'))).rejects.toThrow()
  })
})

test('repair restores exact executable and data modes under a restrictive service umask', async () => {
  const previousUmask = process.umask(0o077)
  try {
    await scratch(async root => {
      const fixture = runtimeFixture('umask')
      const dir = join(input(root).releasesDir, fixture.manifest.version)
      await fixture.write(dir)
      await symlink(dir, join(root, 'current'))
      await rm(join(dir, 'duet'))
      await rm(join(dir, 'pglite.wasm'))
      expect(await ensureBootableCurrent({ ...input(root), fetch: fixture.fetch })).toEqual({
        status: 'repaired',
        version: fixture.manifest.version,
      })
      expect((await stat(join(dir, 'duet'))).mode & 0o777).toBe(0o755)
      expect((await stat(join(dir, 'pglite.wasm'))).mode & 0o777).toBe(0o644)
      expect(await inspectRelease(dir)).toEqual({ ok: true, version: fixture.manifest.version })
    })
  } finally {
    process.umask(previousUmask)
  }
})

test('retention preserves the interprocess release lock through activation', async () => {
  await scratch(async root => {
    const fixture = runtimeFixture('locked')
    const lockPath = join(input(root).releasesDir, RUNTIME_RELEASE_LOCK_FILE)
    await applyRuntimeRelease({
      ...input(root),
      desiredVersion: fixture.manifest.version,
      fetch: fixture.fetch,
      activateIfCurrent: async activate => {
        await activate()
        expect(await check(lockPath, { realpath: false, lockfilePath: lockPath })).toBe(true)
        return true
      },
    })
    expect(await check(lockPath, { realpath: false, lockfilePath: lockPath })).toBe(false)
  })
})
