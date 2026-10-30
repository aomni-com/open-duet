import { expect, test } from 'bun:test'

import { summarizeDriveUsage } from './drive-status-dialog'
import type { DirectoryEntry } from './lib/types'

const entries: DirectoryEntry[] = [
  { name: 'alpha', path: '/alpha', type: 'directory', isDirectory: true },
  { name: 'beta', path: '/beta', type: 'directory', isDirectory: true },
  { name: 'report.pdf', path: '/report.pdf', type: 'file', isDirectory: false, size: 100 },
  { name: 'deck.pptx', path: '/deck.pptx', type: 'file', isDirectory: false, size: 50 },
  { name: 'notes.md', path: '/notes.md', type: 'file', isDirectory: false, size: 30 },
  { name: 'photo.png', path: '/photo.png', type: 'file', isDirectory: false, size: 20 },
  { name: 'mystery.xyz', path: '/mystery.xyz', type: 'file', isDirectory: false, size: 5 },
]

test('summarizes the open folder into kind slices with real byte totals', () => {
  const usage = summarizeDriveUsage(entries)

  expect(usage.folders).toBe(2)
  expect(usage.documents).toBe(5)
  expect(usage.totalBytes).toBe(205)
  // Slices carry actual values (kind, bytes, count), largest first, and
  // only kinds that are present.
  expect(usage.slices.map(slice => [slice.kind, slice.bytes, slice.count])).toEqual([
    ['pdf', 100, 1],
    ['slides', 50, 1],
    ['text', 30, 1],
    ['image', 20, 1],
    ['other', 5, 1],
  ])
})

test('an empty folder summarizes to zeroes with no slices', () => {
  const usage = summarizeDriveUsage([])
  expect(usage).toEqual({ folders: 0, documents: 0, totalBytes: 0, slices: [] })
})
