import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  formatStatusHuman,
  readStatusSnapshot,
  writeStatusSnapshot,
  type SyncStatusSnapshot,
} from './daemon-status.js'

const tmpDirs: string[] = []
afterAll(async () => {
  await Promise.all(tmpDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

function snapshot(overrides: Partial<SyncStatusSnapshot> = {}): SyncStatusSnapshot {
  return {
    version: 1,
    updatedAt: 1_000,
    daemonPid: 42,
    workspaces: [
      {
        slug: 'acme',
        state: 'up-to-date',
        localDir: '/home/me/duet/acme',
        connected: true,
        needBytes: 0,
        remoteCompletion: 100,
        conflicts: 0,
      },
      {
        slug: 'blog',
        state: 'syncing',
        localDir: '/home/me/duet/blog',
        connected: true,
        needBytes: 8_800_000,
        remoteCompletion: 62,
        conflicts: 0,
      },
      {
        slug: 'notes',
        state: 'up-to-date',
        localDir: '/home/me/duet/notes',
        connected: true,
        needBytes: 0,
        remoteCompletion: 100,
        conflicts: 2,
      },
      {
        slug: 'old-project',
        state: 'retired',
        localDir: '/home/me/duet/old-project',
        connected: false,
        needBytes: 0,
        remoteCompletion: 0,
        conflicts: 0,
      },
    ],
    ...overrides,
  }
}

describe('formatStatusHuman', () => {
  const text = formatStatusHuman(snapshot())

  test('one line per workspace, each state legible', () => {
    expect(
      text
        .trim()
        .split('\n')
        .map(line => line.trim().replace(/\s+/g, ' ')),
    ).toEqual([
      'acme up to date /home/me/duet/acme',
      'blog syncing 62% /home/me/duet/blog',
      'notes 2 conflicts /home/me/duet/notes',
      'old-project retired — not mirrored',
    ])
  })

  test('empty snapshot says nothing is mirrored yet', () => {
    expect(formatStatusHuman(snapshot({ workspaces: [] }))).toContain('No workspaces')
  })

  test('surfaces a note in parentheses', () => {
    const withNote = snapshot({
      workspaces: [
        {
          slug: 'api',
          state: 'up-to-date',
          localDir: '/home/me/duet/api',
          connected: true,
          needBytes: 0,
          remoteCompletion: 100,
          conflicts: 0,
          note: 'repo api has no git remote — add one',
        },
      ],
    })
    expect(formatStatusHuman(withNote)).toContain('(repo api has no git remote — add one)')
  })
})

describe('snapshot persistence', () => {
  test('write then read preserves the complete published snapshot', async () => {
    const home = await mkdtemp(join(tmpdir(), 'duet-status-'))
    tmpDirs.push(home)
    expect(await readStatusSnapshot(home)).toBeNull()
    const snap = snapshot()
    await writeStatusSnapshot(home, snap)
    const read = await readStatusSnapshot(home)
    expect(read).toEqual(snap)
  })

  test('a corrupt status file reads as null, not a throw', async () => {
    const home = await mkdtemp(join(tmpdir(), 'duet-status-'))
    tmpDirs.push(home)
    await writeStatusSnapshot(home, snapshot())
    await Bun.write(join(home, '.duet', 'sync', 'status.json'), '{ not json')
    expect(await readStatusSnapshot(home)).toBeNull()
  })
})
