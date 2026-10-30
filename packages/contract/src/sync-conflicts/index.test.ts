import { describe, expect, test } from 'bun:test'

import { formatSyncConflictName } from './index'

describe('formatSyncConflictName', () => {
  test('formats the timestamp in Syncthing conflict-copy grammar', () => {
    expect(
      formatSyncConflictName('notes.txt', new Date('2026-07-15T08:29:12.345Z'), 'CREATOR'),
    ).toBe('notes.sync-conflict-20260715-082912-CREATOR.txt')
  })

  test('sanitizes and bounds device names with the creator fallback', () => {
    const at = new Date('2026-07-15T08:29:12Z')

    expect(formatSyncConflictName('notes.txt', at, 'AB-CD_EFG12')).toBe(
      'notes.sync-conflict-20260715-082912-ABCDEFG.txt',
    )
    expect(formatSyncConflictName('notes.txt', at, '---')).toBe(
      'notes.sync-conflict-20260715-082912-CREATOR.txt',
    )
  })

  test('keeps the final extension and places a collision marker before it', () => {
    const at = new Date('2026-07-15T08:29:12Z')

    expect(formatSyncConflictName('nested/archive.tar.gz', at, 'DEVICE', 2)).toBe(
      'nested/archive.tar.sync-conflict-20260715-082912-DEVICE-2.gz',
    )
    expect(formatSyncConflictName('.env', at, 'DEVICE')).toBe(
      '.env.sync-conflict-20260715-082912-DEVICE',
    )
    expect(() => formatSyncConflictName('notes.txt', at, 'DEVICE', -1)).toThrow()
  })
})
