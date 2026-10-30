import { afterEach, describe, expect, test } from 'bun:test'
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  applyUpstreamTree as applyUpstreamTreeWithState,
  type ApplyUpstreamTreeInput,
  type UnzippedEntry,
} from './materializer'

const roots: string[] = []
const now = new Date('2026-07-22T10:11:12.000Z')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('applyUpstreamTree', () => {
  test('restores a locally edited upstream file after preserving the edit', async () => {
    const targetDir = await makeTarget()
    await writeFile(join(targetDir, 'AGENT.md'), 'locally edited\n')

    const result = await applyUpstreamTree({
      entries: [file('AGENT.md', 'upstream v2\n')],
      previous: manifest({ 'AGENT.md': 'upstream v1\n' }),
      targetDir,
      now,
    })

    expect(await readFile(join(targetDir, 'AGENT.md'), 'utf8')).toBe('upstream v2\n')
    expect(
      await readFile(join(targetDir, 'AGENT.sync-conflict-20260722-101112-CREATOR.md'), 'utf8'),
    ).toBe('locally edited\n')
    expect(result.applied.restored).toEqual(['AGENT.md'])
    expect(result.applied.conflictRenamed).toEqual([
      'AGENT.sync-conflict-20260722-101112-CREATOR.md',
    ])
  })

  test('updates unchanged upstream files without touching local additions', async () => {
    const targetDir = await makeTarget()
    await writeFile(join(targetDir, 'AGENT.md'), 'upstream v1\n')
    await writeFile(join(targetDir, 'notes.local'), 'mine\n')

    const result = await applyUpstreamTree({
      entries: [file('AGENT.md', 'upstream v2\n')],
      previous: manifest({ 'AGENT.md': 'upstream v1\n' }),
      targetDir,
      now,
    })

    expect(await readFile(join(targetDir, 'AGENT.md'), 'utf8')).toBe('upstream v2\n')
    expect(await readFile(join(targetDir, 'notes.local'), 'utf8')).toBe('mine\n')
    expect(result.applied).toEqual({
      restored: ['AGENT.md'],
      conflictRenamed: [],
      deletedUpstream: [],
      keptLocal: 1,
    })
  })

  test('removes deleted upstream files but preserves an edited deletion as a conflict', async () => {
    const targetDir = await makeTarget()
    await mkdir(join(targetDir, 'docs'))
    await writeFile(join(targetDir, 'unchanged.md'), 'old\n')
    await writeFile(join(targetDir, 'docs', 'edited.md'), 'local edit\n')

    const result = await applyUpstreamTree({
      entries: [],
      previous: manifest({ 'unchanged.md': 'old\n', 'docs/edited.md': 'old\n' }),
      targetDir,
      now,
    })

    expect(await exists(join(targetDir, 'unchanged.md'))).toBe(false)
    expect(await exists(join(targetDir, 'docs', 'edited.md'))).toBe(false)
    expect(
      await readFile(
        join(targetDir, 'docs', 'edited.sync-conflict-20260722-101112-CREATOR.md'),
        'utf8',
      ),
    ).toBe('local edit\n')
    expect(result.applied.deletedUpstream).toEqual(['docs/edited.md', 'unchanged.md'])
  })

  test('repairs file-to-directory and directory-to-file type collisions', async () => {
    const targetDir = await makeTarget()
    await writeFile(join(targetDir, 'skills'), 'edited old file\n')
    await mkdir(join(targetDir, 'profile'))
    await writeFile(join(targetDir, 'profile', 'local.txt'), 'local child\n')

    const result = await applyUpstreamTree({
      entries: [file('skills/SKILL.md', 'new skill\n'), file('profile', 'upstream profile\n')],
      previous: manifest({ skills: 'old file\n', 'profile/old.md': 'old child\n' }),
      targetDir,
      now,
    })

    expect(await readFile(join(targetDir, 'skills', 'SKILL.md'), 'utf8')).toBe('new skill\n')
    expect(
      await readFile(join(targetDir, 'skills.sync-conflict-20260722-101112-CREATOR'), 'utf8'),
    ).toBe('edited old file\n')
    expect(await readFile(join(targetDir, 'profile'), 'utf8')).toBe('upstream profile\n')
    expect(
      await readFile(
        join(targetDir, 'profile.sync-conflict-20260722-101112-CREATOR', 'local.txt'),
        'utf8',
      ),
    ).toBe('local child\n')
    expect(result.applied.conflictRenamed).toEqual([
      'skills.sync-conflict-20260722-101112-CREATOR',
      'profile.sync-conflict-20260722-101112-CREATOR',
    ])
  })

  test('yields a persistently contended path and resumes the same journal later', async () => {
    const targetDir = await makeTarget()
    await writeFile(join(targetDir, 'AGENT.md'), 'local writer\n')
    let recreations = 0

    await expect(
      applyUpstreamTree({
        entries: [file('AGENT.md', 'upstream v2\n')],
        previous: manifest({ 'AGENT.md': 'upstream v1\n' }),
        targetDir,
        now,
        onJournalPhase: async (phase, path) => {
          if (phase === 'swapped' && path === 'AGENT.md' && recreations < 100) {
            recreations += 1
            await writeFile(join(targetDir, 'AGENT.md'), `racer ${recreations}\n`)
          }
        },
      }),
    ).rejects.toThrow(/temporarily contended/i)

    expect(recreations).toBeGreaterThan(1)
    await expect(
      applyUpstreamTree({
        entries: [file('AGENT.md', 'upstream v2\n')],
        previous: manifest({ 'AGENT.md': 'upstream v1\n' }),
        targetDir,
        now,
      }),
    ).resolves.toMatchObject({ manifest: manifest({ 'AGENT.md': 'upstream v2\n' }) })
    expect(await readFile(join(targetDir, 'AGENT.md'), 'utf8')).toBe('upstream v2\n')
  })

  test('lifts an edited nested conflict outside an ancestor replaced by a file', async () => {
    const targetDir = await makeTarget()
    await mkdir(join(targetDir, 'profile'))
    await writeFile(join(targetDir, 'profile', 'old.md'), 'locally edited child\n')

    const result = await applyUpstreamTree({
      entries: [file('profile', 'upstream profile\n')],
      previous: manifest({ 'profile/old.md': 'old child\n' }),
      targetDir,
      now,
    })

    expect(await readFile(join(targetDir, 'profile'), 'utf8')).toBe('upstream profile\n')
    const editedChildConflict = result.applied.conflictRenamed.find(path =>
      path.endsWith('/old.md'),
    )
    expect(await readFile(join(targetDir, editedChildConflict!), 'utf8')).toBe(
      'locally edited child\n',
    )
    expect(editedChildConflict).toBe('profile.sync-conflict-20260722-101112-CREATOR/old.md')
  })

  test('writes ordinary dotfiles and skill paths while never writing the publish floor', async () => {
    const targetDir = await makeTarget()
    await writeFile(join(targetDir, '.env.local'), 'recipient secret\n')

    const result = await applyUpstreamTree({
      entries: [
        file('.notes', 'visible dotfile\n'),
        file('.agents/skills/deploy/SKILL.md', 'skill\n'),
        file('.env.local', 'upstream secret\n'),
        file('.git/config', 'git config\n'),
        file('node_modules/pkg/index.js', 'dependency\n'),
        file('nested/.duet-anchor', 'anchor\n'),
      ],
      previous: null,
      targetDir,
      now,
    })

    expect(await readFile(join(targetDir, '.notes'), 'utf8')).toBe('visible dotfile\n')
    expect(await readFile(join(targetDir, '.agents/skills/deploy/SKILL.md'), 'utf8')).toBe(
      'skill\n',
    )
    expect(await readFile(join(targetDir, '.env.local'), 'utf8')).toBe('recipient secret\n')
    expect(await exists(join(targetDir, '.git'))).toBe(false)
    expect(await exists(join(targetDir, 'node_modules'))).toBe(false)
    expect(await exists(join(targetDir, 'nested'))).toBe(false)
    expect(Object.keys(result.manifest.files)).toEqual(['.agents/skills/deploy/SKILL.md', '.notes'])
  })

  test('rejects hostile archive names and duplicates before changing the live tree', async () => {
    const badEntries: UnzippedEntry[][] = [
      [file('../escape', 'bad')],
      [file('/absolute', 'bad')],
      [file('C:/absolute', 'bad')],
      [file('safe/../../escape', 'bad')],
      [file('duplicate', 'one'), file('duplicate', 'two')],
      [file('parent', 'file'), file('parent/child', 'child')],
    ]

    for (const entries of badEntries) {
      const targetDir = await makeTarget()
      await writeFile(join(targetDir, 'sentinel'), 'untouched\n')
      expect(applyUpstreamTree({ entries, previous: null, targetDir, now })).rejects.toThrow()
      expect(await readFile(join(targetDir, 'sentinel'), 'utf8')).toBe('untouched\n')
      expect((await readdirNames(targetDir)).sort()).toEqual(['sentinel'])
    }
  })

  test('does not follow or materialize archive symlinks or local symlink collisions', async () => {
    const targetDir = await makeTarget()
    const outside = join(dirname(targetDir), 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'outside\n')
    await symlink(outside, join(targetDir, 'nested'))

    await applyUpstreamTree({
      entries: [
        { path: 'archive-link', data: new TextEncoder().encode('/etc/passwd'), kind: 'symlink' },
        file('nested/inside.md', 'upstream\n'),
      ],
      previous: null,
      targetDir,
      now,
    })

    expect(await exists(join(targetDir, 'archive-link'))).toBe(false)
    expect(await readFile(join(targetDir, 'nested', 'inside.md'), 'utf8')).toBe('upstream\n')
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('outside\n')
    expect(
      (
        await lstat(join(targetDir, 'nested.sync-conflict-20260722-101112-CREATOR'))
      ).isSymbolicLink(),
    ).toBe(true)
  })

  test('increments the shared conflict-name suffix without overwriting an existing collision', async () => {
    const targetDir = await makeTarget()
    await writeFile(join(targetDir, 'note.md'), 'local edit\n')
    const firstConflict = join(targetDir, 'note.sync-conflict-20260722-101112-CREATOR.md')
    await writeFile(firstConflict, 'preexisting conflict\n')

    const result = await applyUpstreamTree({
      entries: [file('note.md', 'upstream v2\n')],
      previous: manifest({ 'note.md': 'upstream v1\n' }),
      targetDir,
      now,
    })

    expect(await readFile(firstConflict, 'utf8')).toBe('preexisting conflict\n')
    expect(
      await readFile(join(targetDir, 'note.sync-conflict-20260722-101112-CREATOR-1.md'), 'utf8'),
    ).toBe('local edit\n')
    expect(result.applied.conflictRenamed).toEqual([
      'note.sync-conflict-20260722-101112-CREATOR-1.md',
    ])
  })

  for (const killedPhase of ['staged', 'swapped', 'swept'] as const) {
    test(`resumes idempotently after a kill in the ${killedPhase} journal phase`, async () => {
      const targetDir = await makeTarget()
      await writeFile(join(targetDir, 'AGENT.md'), 'local edit\n')
      const input = {
        entries: [file('AGENT.md', 'upstream v2\n')],
        previous: manifest({ 'AGENT.md': 'upstream v1\n' }),
        targetDir,
        now,
      }
      let killed = false

      await expect(
        applyUpstreamTree({
          ...input,
          onJournalPhase(phase) {
            if (phase === killedPhase && !killed) {
              killed = true
              throw new Error('simulated process death')
            }
          },
        }),
      ).rejects.toThrow('simulated process death')

      const result = await applyUpstreamTree(input)
      expect(await readFile(join(targetDir, 'AGENT.md'), 'utf8')).toBe('upstream v2\n')
      expect(
        await readFile(join(targetDir, 'AGENT.sync-conflict-20260722-101112-CREATOR.md'), 'utf8'),
      ).toBe('local edit\n')
      expect(result.applied.conflictRenamed).toEqual([
        'AGENT.sync-conflict-20260722-101112-CREATOR.md',
      ])
      expect(result.applied.restored).toEqual(['AGENT.md'])
    })
  }

  for (const killedPhase of ['swapped', 'swept'] as const) {
    test(`restores deletion bookkeeping after a ${killedPhase}-phase kill`, async () => {
      const targetDir = await makeTarget()
      await writeFile(join(targetDir, 'removed.md'), 'upstream old\n')
      const input = {
        entries: [] as UnzippedEntry[],
        previous: manifest({ 'removed.md': 'upstream old\n' }),
        targetDir,
        now,
      }
      let killed = false

      await expect(
        applyUpstreamTree({
          ...input,
          onJournalPhase(phase) {
            if (phase === killedPhase && !killed) {
              killed = true
              throw new Error('simulated process death')
            }
          },
        }),
      ).rejects.toThrow('simulated process death')

      const result = await applyUpstreamTree(input)
      expect(await exists(join(targetDir, 'removed.md'))).toBe(false)
      expect(result.applied.deletedUpstream).toEqual(['removed.md'])
    })
  }

  test('treats a missing manifest conservatively and conflict-copies divergent content', async () => {
    const targetDir = await makeTarget()
    await writeFile(join(targetDir, 'AGENT.md'), 'unknown local content\n')

    const result = await applyUpstreamTree({
      entries: [file('AGENT.md', 'upstream\n')],
      previous: null,
      targetDir,
      now,
    })

    expect(await readFile(join(targetDir, 'AGENT.md'), 'utf8')).toBe('upstream\n')
    expect(
      await readFile(join(targetDir, 'AGENT.sync-conflict-20260722-101112-CREATOR.md'), 'utf8'),
    ).toBe('unknown local content\n')
    expect(result.applied.conflictRenamed).toEqual([
      'AGENT.sync-conflict-20260722-101112-CREATOR.md',
    ])
  })

  test('never silently loses a pathname write during the commit window', async () => {
    const targetDir = await makeTarget()
    await writeFile(join(targetDir, 'AGENT.md'), 'upstream v1\n')
    let injected = false

    const result = await applyUpstreamTree({
      entries: [file('AGENT.md', 'upstream v2\n')],
      previous: manifest({ 'AGENT.md': 'upstream v1\n' }),
      targetDir,
      now,
      async onJournalPhase(phase, path) {
        if (phase === 'swapped' && path === undefined && !injected) {
          injected = true
          await writeFile(join(targetDir, 'AGENT.md'), 'concurrent write\n')
        }
      },
    })

    expect(injected).toBe(true)
    expect(await readFile(join(targetDir, 'AGENT.md'), 'utf8')).toBe('upstream v2\n')
    const conflictContents = await Promise.all(
      result.applied.conflictRenamed.map(path => readFile(join(targetDir, path), 'utf8')),
    )
    expect(conflictContents).toContain('concurrent write\n')
  })

  test('quarantines a pathname recreated after rename but before upstream install', async () => {
    const targetDir = await makeTarget()
    const target = join(targetDir, 'AGENT.md')
    await writeFile(target, 'upstream v1\n')
    let injected = false

    const result = await applyUpstreamTree({
      entries: [file('AGENT.md', 'upstream v2\n')],
      previous: manifest({ 'AGENT.md': 'upstream v1\n' }),
      targetDir,
      now,
      async onJournalPhase(phase, path) {
        if (phase === 'swapped' && path === 'AGENT.md' && !injected) {
          injected = true
          await writeFile(target, 'rename-window write\n')
        }
      },
    })

    expect(await readFile(target, 'utf8')).toBe('upstream v2\n')
    const conflictContents = await Promise.all(
      result.applied.conflictRenamed.map(path => readFile(join(targetDir, path), 'utf8')),
    )
    expect(conflictContents).toContain('rename-window write\n')
  })

  test('serializes overlapping materializations for the same target', async () => {
    const targetDir = await makeTarget()
    const target = join(targetDir, 'AGENT.md')
    await writeFile(target, 'upstream v1\n')
    let releaseFirst!: () => void
    const firstMayContinue = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let markFirstStaged!: () => void
    const firstStaged = new Promise<void>(resolve => {
      markFirstStaged = resolve
    })

    const first = applyUpstreamTree({
      entries: [file('AGENT.md', 'upstream v2\n')],
      previous: manifest({ 'AGENT.md': 'upstream v1\n' }),
      targetDir,
      now,
      async onJournalPhase(phase) {
        if (phase === 'staged') {
          markFirstStaged()
          await firstMayContinue
        }
      },
    })
    await firstStaged
    const second = applyUpstreamTree({
      entries: [file('AGENT.md', 'upstream v3\n')],
      previous: manifest({ 'AGENT.md': 'upstream v2\n' }),
      targetDir,
      now: new Date('2026-07-22T10:12:12.000Z'),
    })
    releaseFirst()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.manifest).toEqual(manifest({ 'AGENT.md': 'upstream v2\n' }))
    expect(secondResult.manifest).toEqual(manifest({ 'AGENT.md': 'upstream v3\n' }))
    expect(await readFile(target, 'utf8')).toBe('upstream v3\n')
  })

  test('preserves content written through a handle opened before staging', async () => {
    const targetDir = await makeTarget()
    const target = join(targetDir, 'AGENT.md')
    await writeFile(target, 'upstream v1\n')
    const writer = await open(target, 'r+')

    try {
      await writer.truncate(0)
      await writer.write('pre-staging handle write\n', 0)
      await writer.sync()
      const result = await applyUpstreamTree({
        entries: [file('AGENT.md', 'upstream v2\n')],
        previous: manifest({ 'AGENT.md': 'upstream v1\n' }),
        targetDir,
        now,
      })
      expect(await readFile(join(targetDir, result.applied.conflictRenamed[0]!), 'utf8')).toBe(
        'pre-staging handle write\n',
      )
    } finally {
      await writer.close()
    }
  })

  // OA-SLICE-01-KZQ7: this is the original held-fd kill condition, now
  // injected in the binding swap-to-sweep window.
  test('preserves a held-fd write landing between swap and sweep', async () => {
    const targetDir = await makeTarget()
    const target = join(targetDir, 'AGENT.md')
    await writeFile(target, 'upstream v1\n')
    const writer = await open(target, 'r+')

    try {
      const result = await applyUpstreamTree({
        entries: [file('AGENT.md', 'upstream v2\n')],
        previous: manifest({ 'AGENT.md': 'upstream v1\n' }),
        targetDir,
        now,
        async onJournalPhase(phase) {
          if (phase === 'swapped') {
            await writer.truncate(0)
            await writer.write('between swap and sweep\n', 0)
            await writer.sync()
          }
        },
      })
      expect(await readFile(target, 'utf8')).toBe('upstream v2\n')
      expect(await readFile(join(targetDir, result.applied.conflictRenamed[0]!), 'utf8')).toBe(
        'between swap and sweep\n',
      )
    } finally {
      await writer.close()
    }
  })

  test('detects held-fd divergence immediately before deferred reap', async () => {
    const targetDir = await makeTarget()
    const target = join(targetDir, 'AGENT.md')
    await writeFile(target, 'upstream v1\n')
    const writer = await open(target, 'r+')

    try {
      await applyUpstreamTree({
        entries: [file('AGENT.md', 'upstream v2\n')],
        previous: manifest({ 'AGENT.md': 'upstream v1\n' }),
        targetDir,
        now,
      })
      await writer.truncate(0)
      await writer.write('late quarantined write\n', 0)
      await writer.sync()

      const reapRun = await applyUpstreamTree({
        entries: [file('AGENT.md', 'upstream v2\n')],
        previous: manifest({ 'AGENT.md': 'upstream v2\n' }),
        targetDir,
        now: new Date('2026-07-22T10:21:12.000Z'),
        reapBefore: new Date('2026-07-22T10:16:12.000Z'),
      })
      expect(await readFile(join(targetDir, reapRun.applied.conflictRenamed[0]!), 'utf8')).toBe(
        'late quarantined write\n',
      )
    } finally {
      await writer.close()
    }
  })

  test('reaps an unjournaled transaction directory left by a staging crash', async () => {
    const targetDir = await makeTarget()
    await applyUpstreamTree({ entries: [], previous: null, targetDir, now })
    const stateRoot = join(dirname(targetDir), 'gateway-state')
    const [materializerStateDir] = await readdir(stateRoot)
    const orphan = join(stateRoot, materializerStateDir!, 'transactions', 'orphaned-staging-run')
    await mkdir(join(orphan, 'content'), { recursive: true })
    await writeFile(join(orphan, 'content', 'payload'), 'staged bytes\n')

    await applyUpstreamTree({ entries: [], previous: null, targetDir, now })

    expect(await exists(orphan)).toBe(false)
  })
})

async function makeTarget(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'official-materializer-'))
  roots.push(root)
  const target = join(root, 'agent')
  await mkdir(target)
  return target
}

function file(path: string, contents: string): UnzippedEntry {
  return { path, data: new TextEncoder().encode(contents), kind: 'file' }
}

function manifest(files: Record<string, string>) {
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([path, contents]) => [
        path,
        { sha256: new Bun.CryptoHasher('sha256').update(contents).digest('hex') },
      ]),
    ),
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    error => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return false
      }
      throw error
    },
  )
}

async function readdirNames(path: string): Promise<string[]> {
  return readdir(path)
}

function applyUpstreamTree(
  input: Omit<ApplyUpstreamTreeInput, 'stateDir'>,
): ReturnType<typeof applyUpstreamTreeWithState> {
  return applyUpstreamTreeWithState({
    ...input,
    stateDir: join(dirname(input.targetDir), 'gateway-state'),
  })
}
