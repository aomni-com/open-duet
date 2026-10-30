import { describe, expect, test } from 'bun:test'

import type { FilesRow } from './app-rows'
import { driveGroupCounts, driveRowMatches, sortDriveRows } from './column-rows'
import type { DirectoryEntry } from './lib/types'

function file(name: string, extras: { size?: number; modifiedAt?: Date } = {}): FilesRow {
  const entry: DirectoryEntry = {
    name,
    path: `/${name}`,
    type: 'file',
    isDirectory: false,
    ...extras,
  }
  return { entry }
}

function folder(name: string): FilesRow {
  const entry: DirectoryEntry = {
    name,
    path: `/${name}`,
    type: 'directory',
    isDirectory: true,
  }
  return { entry }
}

function names(rows: readonly FilesRow[]): string[] {
  return rows.map(row => row.entry.name)
}

describe('sortDriveRows', () => {
  test('keeps folders above files under every sort key', () => {
    const rows = [
      file('alpha.md', { size: 900 }),
      folder('zulu'),
      file('beta.md', { size: 10 }),
      folder('alpha'),
    ]

    for (const sort of ['name', 'modified', 'kind', 'size'] as const) {
      const sorted = names(sortDriveRows(rows, sort))
      expect(sorted.slice(0, 2)).toEqual(['alpha', 'zulu'])
    }
  })

  test('orders files by real bytes, largest first', () => {
    const rows = [
      file('small.md', { size: 10 }),
      file('huge.md', { size: 9_000 }),
      file('middling.md', { size: 500 }),
    ]

    expect(names(sortDriveRows(rows, 'size'))).toEqual(['huge.md', 'middling.md', 'small.md'])
  })

  test('orders files by newest modified first', () => {
    const rows = [
      file('old.md', { modifiedAt: new Date('2026-01-01T00:00:00.000Z') }),
      file('new.md', { modifiedAt: new Date('2026-08-01T00:00:00.000Z') }),
    ]

    expect(names(sortDriveRows(rows, 'modified'))).toEqual(['new.md', 'old.md'])
  })
})

describe('driveRowMatches', () => {
  test('a group narrows files by extension but never hides a folder', () => {
    const filter = { group: 'images' as const, search: '' }

    expect(driveRowMatches(file('shot.png'), filter)).toBe(true)
    expect(driveRowMatches(file('notes.md'), filter)).toBe(false)
    expect(driveRowMatches(folder('archive'), filter)).toBe(true)
  })

  test('search trims folders too, and composes with the group', () => {
    expect(driveRowMatches(folder('archive'), { group: 'all', search: 'arch' })).toBe(true)
    expect(driveRowMatches(folder('archive'), { group: 'all', search: 'zzz' })).toBe(false)
    expect(driveRowMatches(file('shot.png'), { group: 'images', search: 'zzz' })).toBe(false)
  })
})

describe('driveGroupCounts', () => {
  test('a group counts the files of that kind, and folders count only under All', () => {
    const counts = driveGroupCounts([
      folder('agents'),
      folder('welcome'),
      file('shot.png'),
      file('notes.md'),
    ])

    // Folders survive every group so the reader is never stranded — but that
    // is a navigation rule, not a claim that this folder holds two images.
    expect(counts).toEqual({ all: 4, images: 1, docs: 1, code: 0, pdfs: 0, media: 0 })
  })
})
