import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename as fsRename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SkillsBundle } from '@repo/contract'

import { createSkillsInstallGate, installSkills } from './skills-install'

const homes = new Set<string>()

afterEach(async () => {
  await Promise.all([...homes].map(home => rm(home, { recursive: true, force: true })))
  homes.clear()
})

describe('installSkills', () => {
  test('holds runner readiness through the newest in-flight installation', async () => {
    const gate = createSkillsInstallGate()
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const first = new Promise<void>(resolve => {
      resolveFirst = resolve
    })
    const second = new Promise<void>(resolve => {
      resolveSecond = resolve
    })
    gate.track('first', () => first)
    let ready = false
    const waiting = gate.wait().then(() => {
      ready = true
    })

    gate.track('second', () => second)
    resolveFirst()
    await Promise.resolve()
    await Promise.resolve()
    expect(ready).toBe(false)

    resolveSecond()
    await waiting
    expect(ready).toBe(true)
  })

  test('propagates the current installation failure to runner readiness', async () => {
    const gate = createSkillsInstallGate()
    gate.track('broken', () => Promise.reject(new Error('bundle failed')))

    await expect(gate.wait()).rejects.toThrow('bundle failed')
  })

  test('coalesces repeated syncs for one bundle while allowing a failed retry', async () => {
    const gate = createSkillsInstallGate()
    let attempts = 0
    let rejectInstall!: (error: Error) => void
    const first = gate.track('same-hash', () => {
      attempts += 1
      return new Promise<void>((_resolve, reject) => {
        rejectInstall = reject
      })
    })
    expect(
      gate.track('same-hash', async () => {
        attempts += 1
      }),
    ).toBe(first)
    expect(attempts).toBe(1)

    rejectInstall(new Error('transient'))
    await expect(first).rejects.toThrow('transient')
    await Promise.resolve()
    await gate.track('same-hash', async () => {
      attempts += 1
    })
    expect(attempts).toBe(2)
  })

  test('can hold a production runner until the first skills descriptor arrives', async () => {
    const gate = createSkillsInstallGate({ waitForFirstTrack: true })
    let ready = false
    const waiting = gate.wait().then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)

    await gate.track('first-hash', async () => undefined)
    await waiting
    expect(ready).toBe(true)
  })

  test('installs a verified bundle atomically and creates both discovery link farms', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const built = bundle([
      { path: 'github/SKILL.md', content: '# GitHub\n' },
      { path: 'models.json', content: '{"recommended":"fixture/model"}\n' },
    ])
    const requests: Request[] = []

    await installSkills({
      homeDir,
      descriptor: { hash: built.hash, url: 'https://ctl.test/v1/vm/skills/bundle' },
      token: 'vm-token',
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return new Response(built.bytes)
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer vm-token')
    expect(await readFile(join(homeDir, '.duet', '.skills-hash'), 'utf8')).toBe(`${built.hash}\n`)
    expect(await realpath(join(homeDir, '.duet', 'skills'))).toBe(
      await realpath(join(homeDir, '.duet', 'skill-releases', built.hash)),
    )
    expect(await readFile(join(homeDir, '.duet', 'skills', 'github', 'SKILL.md'), 'utf8')).toBe(
      '# GitHub\n',
    )
    expect(await readFile(join(homeDir, '.duet', 'skills', 'models.json'), 'utf8')).toContain(
      'fixture/model',
    )
    expect(await readlink(join(homeDir, '.claude', 'skills', 'github'))).toBe(
      join(homeDir, '.duet', 'skills', 'github'),
    )
    expect(await readlink(join(homeDir, '.agents', 'skills', 'github'))).toBe(
      join(homeDir, '.duet', 'skills', 'github'),
    )
  })

  test('materializes bundle files with bounded parallel durability writes', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const built = bundle(
      Array.from({ length: 16 }, (_, index) => ({
        path: `skill-${index}/SKILL.md`,
        content: `# Skill ${index}\n`,
      })).sort((left, right) => left.path.localeCompare(right.path)),
    )
    let active = 0
    let maximum = 0

    await installSkills({
      ...installInput(homeDir, built),
      operations: {
        writeSyncedFile: async (path, data, mode) => {
          active += 1
          maximum = Math.max(maximum, active)
          await Bun.sleep(5)
          await writeFile(path, data, { mode })
          active -= 1
        },
      },
    })

    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(8)
  })

  test('same-hash sync skips the download', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const built = bundle([{ path: 'github/SKILL.md', content: '# GitHub\n' }])
    let downloads = 0
    const input = {
      homeDir,
      descriptor: { hash: built.hash, url: 'https://ctl.test/bundle' },
      token: 'vm-token',
      fetch: async () => {
        downloads += 1
        return new Response(built.bytes)
      },
    }

    await installSkills(input)
    await installSkills(input)

    expect(downloads).toBe(1)
    expect(await readFile(join(homeDir, '.duet', 'skills', 'github', 'SKILL.md'), 'utf8')).toBe(
      '# GitHub\n',
    )
  })

  test('restored stamp with an excluded release downloads and repairs the active tree', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const built = bundle([{ path: 'github/SKILL.md', content: '# GitHub\n' }])
    await mkdir(join(homeDir, '.duet'), { recursive: true })
    await writeFile(join(homeDir, '.duet', '.skills-hash'), `${built.hash}\n`)
    await symlink(
      join(homeDir, '.duet', 'skill-releases', built.hash),
      join(homeDir, '.duet', 'skills'),
    )
    let downloads = 0

    await installSkills({
      ...installInput(homeDir, built),
      fetch: async () => {
        downloads += 1
        return new Response(built.bytes)
      },
    })

    expect(downloads).toBe(1)
    expect(await readFile(join(homeDir, '.duet', 'skills', 'github', 'SKILL.md'), 'utf8')).toBe(
      '# GitHub\n',
    )
  })

  test('refuses a hash-mismatched download and leaves the previous tree active', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const first = bundle([{ path: 'github/SKILL.md', content: 'first\n' }])
    const next = bundle([{ path: 'github/SKILL.md', content: 'next\n' }])
    await installSkills(installInput(homeDir, first))

    await expect(
      installSkills({ ...installInput(homeDir, next), fetch: async () => new Response('corrupt') }),
    ).rejects.toThrow('sha256 mismatch')

    expect(await readFile(join(homeDir, '.duet', 'skills', 'github', 'SKILL.md'), 'utf8')).toBe(
      'first\n',
    )
    expect(await readFile(join(homeDir, '.duet', '.skills-hash'), 'utf8')).toBe(`${first.hash}\n`)
  })

  test('refuses truncated or malformed bundle bytes after hash verification', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const first = bundle([{ path: 'github/SKILL.md', content: 'first\n' }])
    await installSkills(installInput(homeDir, first))

    for (const bytes of ['{"version":1,"files":[', '{"version":2,"files":[]}']) {
      const invalid = rawBundle(bytes)
      await expect(installSkills(installInput(homeDir, invalid))).rejects.toThrow()
    }

    expect(await readFile(join(homeDir, '.duet', 'skills', 'github', 'SKILL.md'), 'utf8')).toBe(
      'first\n',
    )
  })

  test('rejects traversal and duplicate paths before materialization at the trust boundary', async () => {
    const invalidBundles = [
      rawBundle(
        JSON.stringify({ version: 1, files: [{ path: '../outside.txt', content: 'owned' }] }),
      ),
      rawBundle(
        JSON.stringify({
          version: 1,
          files: [
            { path: 'github/SKILL.md', content: 'one' },
            { path: 'github/SKILL.md', content: 'two' },
          ],
        }),
      ),
    ]

    for (const invalid of invalidBundles) {
      const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
      homes.add(homeDir)
      const writes: string[] = []
      await expect(
        installSkills({
          ...installInput(homeDir, invalid),
          operations: {
            writeSyncedFile: async path => {
              writes.push(path)
            },
          },
        }),
      ).rejects.toThrow()
      expect(writes).toEqual([])
    }
  })

  test('failed materialization does not swap and a later retry converges', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const first = bundle([{ path: 'github/SKILL.md', content: 'first\n' }])
    const next = bundle([{ path: 'github/SKILL.md', content: 'next\n' }])
    await installSkills(installInput(homeDir, first))

    await expect(
      installSkills({
        ...installInput(homeDir, next),
        operations: {
          writeSyncedFile: async () => {
            throw new Error('disk full')
          },
        },
      }),
    ).rejects.toThrow('disk full')
    expect(await readFile(join(homeDir, '.duet', 'skills', 'github', 'SKILL.md'), 'utf8')).toBe(
      'first\n',
    )

    await installSkills(installInput(homeDir, next))
    expect(await readFile(join(homeDir, '.duet', 'skills', 'github', 'SKILL.md'), 'utf8')).toBe(
      'next\n',
    )
  })

  test('a stamp failure after swap rolls back the active tree and stamp', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const first = bundle([{ path: 'github/SKILL.md', content: 'first\n' }])
    const next = bundle([{ path: 'github/SKILL.md', content: 'next\n' }])
    await installSkills(installInput(homeDir, first))

    await expect(
      installSkills({
        ...installInput(homeDir, next),
        operations: {
          rename: async (from, to) => {
            if (to.endsWith('.skills-hash')) throw new Error('stamp disk failure')
            await fsRename(from, to)
          },
        },
      }),
    ).rejects.toThrow('stamp disk failure')

    expect(await readFile(join(homeDir, '.duet', 'skills', 'github', 'SKILL.md'), 'utf8')).toBe(
      'first\n',
    )
    expect(await readFile(join(homeDir, '.duet', '.skills-hash'), 'utf8')).toBe(`${first.hash}\n`)
  })

  test('concurrent install calls serialize under the installer lock', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const built = bundle([{ path: 'github/SKILL.md', content: '# GitHub\n' }])
    let downloads = 0
    let releaseDownload!: () => void
    const downloadMayFinish = new Promise<void>(resolve => {
      releaseDownload = resolve
    })
    let downloadStarted!: () => void
    const started = new Promise<void>(resolve => {
      downloadStarted = resolve
    })
    const input = {
      ...installInput(homeDir, built),
      fetch: async () => {
        downloads += 1
        downloadStarted()
        await downloadMayFinish
        return new Response(built.bytes)
      },
    }

    const first = installSkills(input)
    const second = installSkills(input)
    await started
    await Bun.sleep(10)
    expect(downloads).toBe(1)
    releaseDownload()
    await Promise.all([first, second])

    expect(downloads).toBe(1)
  })

  test('same-hash sync repairs a deleted managed discovery link', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const built = bundle([{ path: 'github/SKILL.md', content: '# GitHub\n' }])
    const input = installInput(homeDir, built)
    await installSkills(input)
    const link = join(homeDir, '.agents', 'skills', 'github')
    await unlink(link)

    await installSkills(input)

    expect(await readlink(link)).toBe(join(homeDir, '.duet', 'skills', 'github'))
  })

  test('preserves and logs a user-owned file at a discovery target', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const userPath = join(homeDir, '.claude', 'skills', 'github')
    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true })
    await writeFile(userPath, 'mine\n')
    const logs: Record<string, unknown>[] = []

    await installSkills({
      ...installInput(homeDir, bundle([{ path: 'github/SKILL.md', content: '# GitHub\n' }])),
      log: fields => logs.push(fields),
    })

    expect(await readFile(userPath, 'utf8')).toBe('mine\n')
    expect(logs).toContainEqual({
      operation: 'skills_link_farm',
      status: 'preserved_user_path',
      path: userPath,
    })
    expect(await readlink(join(homeDir, '.agents', 'skills', 'github'))).toBe(
      join(homeDir, '.duet', 'skills', 'github'),
    )
  })

  test('retains the active and previous releases and prunes older trees', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'duet-skills-home-'))
    homes.add(homeDir)
    const releases = ['one', 'two', 'three'].map(content =>
      bundle([{ path: 'github/SKILL.md', content: `${content}\n` }]),
    )
    for (const release of releases) await installSkills(installInput(homeDir, release))

    expect((await readdir(join(homeDir, '.duet', 'skill-releases'))).sort()).toEqual(
      [releases[1]!.hash, releases[2]!.hash].sort(),
    )
  })
})

function bundle(files: SkillsBundle['files']): { bytes: string; hash: string } {
  const bytes = JSON.stringify({ version: 1, files } satisfies SkillsBundle)
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') }
}

function rawBundle(bytes: string): { bytes: string; hash: string } {
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') }
}

function installInput(homeDir: string, built: { bytes: string; hash: string }) {
  return {
    homeDir,
    descriptor: { hash: built.hash, url: 'https://ctl.test/bundle' },
    token: 'vm-token',
    fetch: async () => new Response(built.bytes),
  }
}
