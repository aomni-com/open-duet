import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import {
  COLLECTION_PAGE_DEFAULT_LIMIT,
  COLLECTION_PAGE_MAX_LIMIT,
  CollectionPageQuerySchema,
  collectionPageSchema,
  createBoundCursorCodec,
  iterateCollectionPages,
} from './index'

describe('collection pagination', () => {
  test('owns the shared query defaults and limits', () => {
    expect(CollectionPageQuerySchema.parse({})).toEqual({ limit: COLLECTION_PAGE_DEFAULT_LIMIT })
    expect(CollectionPageQuerySchema.parse({ cursor: 'opaque', limit: String(COLLECTION_PAGE_MAX_LIMIT) })).toEqual({
      cursor: 'opaque',
      limit: COLLECTION_PAGE_MAX_LIMIT,
    })
    expect(CollectionPageQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(
      CollectionPageQuerySchema.safeParse({ limit: COLLECTION_PAGE_MAX_LIMIT + 1 }).success,
    ).toBe(false)
  })

  test('requires one page envelope and keeps page metadata typed', () => {
    const PageSchema = collectionPageSchema(
      z.object({ id: z.string() }),
      z.object({ canCreate: z.boolean() }),
    )

    expect(
      PageSchema.parse({
        items: [{ id: 'one' }],
        nextCursor: null,
        meta: { canCreate: true },
      }),
    ).toEqual({
      items: [{ id: 'one' }],
      nextCursor: null,
      meta: { canCreate: true },
    })
    expect(PageSchema.safeParse({ items: [] }).success).toBe(false)
    expect(PageSchema.safeParse({ items: [], nextCursor: undefined }).success).toBe(false)
    expect(PageSchema.parse({ items: [], nextCursor: null, futurePageFact: true })).toEqual({
      items: [],
      nextCursor: null,
    })
  })

  test('binds opaque cursors to subject, filters, order, and domain', async () => {
    const sessions = createBoundCursorCodec('sessions.list', z.object({ updatedAt: z.number() }))
    const cursor = await sessions.encode({
      subject: 'workspace:one/member:maya',
      filters: { bucket: 'running', agentId: null },
      order: 'updated-desc',
      position: { updatedAt: 42 },
    })

    expect(cursor).not.toContain('sessions.list')
    await expect(
      sessions.decode(cursor, {
        subject: 'workspace:one/member:maya',
        filters: { agentId: null, bucket: 'running' },
        order: 'updated-desc',
      }),
    ).resolves.toEqual({ updatedAt: 42 })
    await expect(
      sessions.decode(cursor, {
        subject: 'workspace:one/member:sam',
        filters: { bucket: 'running', agentId: null },
        order: 'updated-desc',
      }),
    ).rejects.toThrow('invalid_cursor')
    await expect(
      sessions.decode(cursor, {
        subject: 'workspace:one/member:maya',
        filters: { bucket: 'done', agentId: null },
        order: 'updated-desc',
      }),
    ).rejects.toThrow('invalid_cursor')
    await expect(
      sessions.decode(cursor, {
        subject: 'workspace:one/member:maya',
        filters: { bucket: 'running', agentId: null },
        order: 'updated-asc',
      }),
    ).rejects.toThrow('invalid_cursor')

    const members = createBoundCursorCodec('workspace.members', z.object({ memberId: z.string() }))
    await expect(
      members.decode(cursor, {
        subject: 'workspace:one/member:maya',
        filters: { bucket: 'running', agentId: null },
        order: 'updated-desc',
      }),
    ).rejects.toThrow('invalid_cursor')
    await expect(
      sessions.decode(cursor + 'tampered', {
        subject: 'workspace:one/member:maya',
        filters: { bucket: 'running', agentId: null },
        order: 'updated-desc',
      }),
    ).rejects.toThrow('invalid_cursor')
  })

  test('iterates pages lazily without recreating an eager array response', async () => {
    const requests: Array<{ cursor?: string; limit: number }> = []
    const pages = iterateCollectionPages(
      async query => {
        requests.push(query)
        return query.cursor === undefined
          ? { items: ['one'], nextCursor: 'next' }
          : { items: ['two'], nextCursor: null }
      },
      { limit: 1 },
    )[Symbol.asyncIterator]()

    expect(requests).toEqual([])
    await expect(pages.next()).resolves.toEqual({
      done: false,
      value: { items: ['one'], nextCursor: 'next' },
    })
    expect(requests).toEqual([{ limit: 1 }])
    await expect(pages.next()).resolves.toEqual({
      done: false,
      value: { items: ['two'], nextCursor: null },
    })
    expect(requests).toEqual([{ limit: 1 }, { cursor: 'next', limit: 1 }])
    await expect(pages.next()).resolves.toEqual({ done: true, value: undefined })
    expect(requests).toHaveLength(2)
  })

  test('stops a walk before requesting a repeated continuation cursor', async () => {
    const requests: Array<string | undefined> = []
    const pages = iterateCollectionPages(async query => {
      requests.push(query.cursor)
      return { items: [], nextCursor: 'repeat' }
    })

    await expect(Array.fromAsync(pages)).rejects.toThrow('invalid_cursor')
    expect(requests).toEqual([undefined, 'repeat'])
  })

  test('follows an empty page when it carries a continuation', async () => {
    const pages = iterateCollectionPages(async query =>
      query.cursor === undefined
        ? { items: [], nextCursor: 'after-empty' }
        : { items: ['found'], nextCursor: null },
    )

    expect((await Array.fromAsync(pages)).map(page => page.items)).toEqual([[], ['found']])
  })

  test('stops a walk before re-entering a multi-cursor cycle', async () => {
    const requests: Array<string | undefined> = []
    const pages = iterateCollectionPages(async query => {
      requests.push(query.cursor)
      const nextCursor = query.cursor === undefined ? 'a' : query.cursor === 'a' ? 'b' : 'a'
      return { items: [], nextCursor }
    })

    await expect(Array.fromAsync(pages)).rejects.toThrow('invalid_cursor')
    expect(requests).toEqual([undefined, 'a', 'b'])
  })

  test('stops before a request when aborted and preserves fetch failures', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller_cancelled'))
    let calls = 0
    const aborted = iterateCollectionPages(
      async () => {
        calls += 1
        return { items: [], nextCursor: null }
      },
      { signal: controller.signal },
    )[Symbol.asyncIterator]()

    await expect(aborted.next()).rejects.toThrow('caller_cancelled')
    expect(calls).toBe(0)

    const failed = iterateCollectionPages(async () => {
      throw new Error('page_failed')
    })[Symbol.asyncIterator]()
    await expect(failed.next()).rejects.toThrow('page_failed')
  })
})
