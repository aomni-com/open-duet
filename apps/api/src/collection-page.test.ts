import { describe, expect, test } from 'bun:test'

import { InvalidCollectionCursorError, isCollectionCursorError } from '@repo/contract'

import {
  createConvexCollectionPage,
  createMaterializedCollectionPage,
  createTemporalConvexCollectionPage,
} from './collection-page'

describe('Convex collection pages', () => {
  test('wraps the continuation and rejects reuse under another subject', async () => {
    const pages = createConvexCollectionPage('credentials.test')
    const binding = { subject: 'user_1', filters: {}, order: 'created_desc_id_desc' }
    const first = await pages.response(
      { page: [{ id: 'key_2' }], continueCursor: 'convex-next', isDone: false },
      binding,
    )

    expect(first.items).toEqual([{ id: 'key_2' }])
    expect(first.nextCursor).toBeString()
    await expect(
      pages.paginationOpts(
        { cursor: first.nextCursor!, limit: 2 },
        { ...binding, subject: 'user_2' },
      ),
    ).rejects.toBeInstanceOf(InvalidCollectionCursorError)
    await expect(
      pages.paginationOpts({ cursor: first.nextCursor!, limit: 2 }, binding),
    ).resolves.toEqual({
      cursor: 'convex-next',
      numItems: 2,
    })
  })

  test('returns null at completion and projects items without draining another page', async () => {
    const pages = createConvexCollectionPage('credentials.test')
    const response = await pages.response(
      { page: [{ internal: 'key_1' }], continueCursor: '', isDone: true },
      { subject: 'user_1', filters: {}, order: 'created_desc_id_desc' },
      item => ({ id: item.internal }),
    )
    expect(response).toEqual({ items: [{ id: 'key_1' }], nextCursor: null })
  })

  test('recognizes public and provider cursor failures without swallowing unrelated errors', () => {
    expect(isCollectionCursorError(new InvalidCollectionCursorError())).toBe(true)
    expect(isCollectionCursorError(new Error('Server Error: InvalidCursor'))).toBe(false)
    expect(isCollectionCursorError(new Error('Server Error: Failed to parse cursor'))).toBe(false)
    expect(isCollectionCursorError(new Error('Server Error: invalid_cursor'))).toBe(false)
    expect(
      isCollectionCursorError(
        Object.assign(new Error('query failed'), { data: { error: 'invalid_cursor' } }),
      ),
    ).toBe(true)
    expect(
      isCollectionCursorError(
        Object.assign(new Error('pagination failed'), {
          data: { isConvexSystemError: true, paginationError: 'InvalidCursor' },
        }),
      ),
    ).toBe(true)
    expect(isCollectionCursorError(new Error('query failed'))).toBe(false)
  })
})

describe('materialized collection pages', () => {
  test('pages an ordered bounded source and binds continuation to its subject', async () => {
    const pages = createMaterializedCollectionPage('resources.test')
    const binding = { subject: 'workspace:one', filters: {}, order: 'slug asc, id asc' }
    const rows = [
      { id: '1', slug: 'alpha' },
      { id: '2', slug: 'beta' },
      { id: '3', slug: 'gamma' },
    ]
    const position = (item: (typeof rows)[number]) => [item.slug, item.id]
    const first = await pages.response({ limit: 2 }, binding, rows, position)
    expect(first.items.map(item => item.slug)).toEqual(['alpha', 'beta'])
    expect(first.nextCursor).toBeString()

    await expect(
      pages.response(
        { cursor: first.nextCursor!, limit: 2 },
        { ...binding, subject: 'workspace:two' },
        rows,
        position,
      ),
    ).rejects.toBeInstanceOf(InvalidCollectionCursorError)

    await expect(
      pages.response({ cursor: first.nextCursor!, limit: 2 }, binding, rows, position),
    ).resolves.toEqual({ items: [{ id: '3', slug: 'gamma' }], nextCursor: null })

    await expect(
      pages.response(
        { cursor: first.nextCursor!, limit: 2 },
        binding,
        rows.filter(row => row.id !== '2'),
        position,
      ),
    ).resolves.toEqual({ items: [{ id: '3', slug: 'gamma' }], nextCursor: null })
  })

  test('resumes strings with the same collation used by materialized sources', async () => {
    const pages = createMaterializedCollectionPage('resources.collation')
    const binding = { subject: 'workspace:one', filters: {}, order: 'name asc' }
    const rows = [{ name: 'a' }, { name: 'B' }].sort((left, right) =>
      left.name.localeCompare(right.name),
    )
    const first = await pages.response({ limit: 1 }, binding, rows, item => [item.name])

    await expect(
      pages.response({ cursor: first.nextCursor!, limit: 1 }, binding, rows, item => [item.name]),
    ).resolves.toEqual({ items: [{ name: 'B' }], nextCursor: null })
  })
})

describe('time-bound Convex collection pages', () => {
  test('pins the first-page time and still rejects another subject', async () => {
    const pages = createTemporalConvexCollectionPage('shares.pending')
    const binding = { subject: 'user:one', filters: {}, order: 'created asc' }
    const firstRequest = await pages.pagination({ limit: 2 }, binding, 123)
    expect(firstRequest).toEqual({
      paginationOpts: { cursor: null, numItems: 2 },
      asOf: 123,
    })
    const first = await pages.response(
      { page: [{ id: 'one' }], continueCursor: 'convex-next', isDone: false },
      binding,
      firstRequest.asOf,
    )

    await expect(
      pages.pagination({ limit: 2, cursor: first.nextCursor! }, binding, 999),
    ).resolves.toEqual({
      paginationOpts: { cursor: 'convex-next', numItems: 2 },
      asOf: 123,
    })
    await expect(
      pages.pagination(
        { limit: 2, cursor: first.nextCursor! },
        { ...binding, subject: 'user:two' },
        999,
      ),
    ).rejects.toBeInstanceOf(InvalidCollectionCursorError)
  })
})
