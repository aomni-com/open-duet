import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { buildSkillsBundle } from './bundle'

describe('buildSkillsBundle', () => {
  test('produces identical canonical bytes and hash regardless of input order or reruns', () => {
    const files = [
      { path: 'fixture/a.txt', content: 'first\n' },
      { path: 'fixture/Z.txt', content: 'last\n' },
    ]

    const first = buildSkillsBundle(files)
    const reordered = buildSkillsBundle([...files].reverse())
    const rerun = buildSkillsBundle(files)

    expect(first).toEqual(reordered)
    expect(first).toEqual(rerun)
    expect(first.bundle.files).toEqual([
      { path: 'fixture/Z.txt', content: 'last\n' },
      { path: 'fixture/a.txt', content: 'first\n' },
    ])
    expect(first.bytes).toBe(JSON.stringify(first.bundle))
    expect(first.hash).toBe(createHash('sha256').update(first.bytes, 'utf8').digest('hex'))
  })

  test('rejects duplicate, traversal, and absolute paths', () => {
    const invalidFileSets = [
      [
        { path: 'fixture/file.txt', content: 'one' },
        { path: 'fixture/file.txt', content: 'two' },
      ],
      [{ path: '../outside.txt', content: 'nope' }],
      [{ path: 'fixture/../../outside.txt', content: 'nope' }],
      [{ path: '/absolute.txt', content: 'nope' }],
      [{ path: 'C:/absolute.txt', content: 'nope' }],
    ]

    for (const files of invalidFileSets) {
      expect(() => buildSkillsBundle(files)).toThrow()
    }
  })

  test('changes the hash when any file path or content changes', () => {
    const original = buildSkillsBundle([{ path: 'fixture/file.txt', content: 'one' }])
    const contentChanged = buildSkillsBundle([{ path: 'fixture/file.txt', content: 'two' }])
    const pathChanged = buildSkillsBundle([{ path: 'fixture/renamed.txt', content: 'one' }])

    expect(contentChanged.hash).not.toBe(original.hash)
    expect(pathChanged.hash).not.toBe(original.hash)
  })
})
