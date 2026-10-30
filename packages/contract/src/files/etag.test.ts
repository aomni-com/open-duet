import { describe, expect, test } from 'bun:test'

import { FileStatResponseSchema } from './index'

describe('file stat contract', () => {
  test('stat requires an explicit ETag and preserves opaque values', () => {
    const file = {
      name: 'brief.md',
      path: 'projects/brief.md',
      type: 'file' as const,
      size: 42,
      mtime: '2026-07-11T08:30:00.000Z',
    }

    expect(FileStatResponseSchema.safeParse({ entry: file }).success).toBe(false)
    const directory = {
      ...file,
      name: 'projects',
      path: 'projects',
      type: 'directory' as const,
    }
    expect(FileStatResponseSchema.parse({ entry: directory, etag: null })).toEqual({
      entry: directory,
      etag: null,
    })
    expect(FileStatResponseSchema.parse({ entry: file, etag: '"opaque-version"' })).toEqual({
      entry: file,
      etag: '"opaque-version"',
    })
  })
})
