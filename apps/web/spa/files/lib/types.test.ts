import { describe, expect, test } from 'bun:test'

import type { FileEntry } from '@repo/contract'

import { directoryEntryFromContract } from './types'

function contractEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'notes.md',
    path: 'projects/notes.md',
    type: 'file',
    size: 12,
    mtime: '2026-08-04T12:00:00.000Z',
    ...overrides,
  }
}

describe('directoryEntryFromContract', () => {
  test('keeps a symlink opaque — its own kind, and where it points', () => {
    const entry = directoryEntryFromContract(
      contractEntry({
        name: 'latest',
        path: 'runs/latest',
        type: 'symlink',
        target: '../runs/003',
      }),
    )

    expect(entry.type).toBe('symlink')
    expect(entry.isDirectory).toBe(false)
    expect(entry.target).toBe('../runs/003')
  })
})
