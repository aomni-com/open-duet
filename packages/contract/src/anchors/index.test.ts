import { describe, expect, test } from 'bun:test'

import { COLLECTION_PAGE_DEFAULT_LIMIT, COLLECTION_PAGE_MAX_LIMIT } from '../pagination/index'

import { AnchorListPageSchema, AnchorListQuerySchema } from './index'

describe('anchor collection contract', () => {
  test('uses strict universal page requests and responses', () => {
    expect(AnchorListQuerySchema.parse({})).toEqual({ limit: COLLECTION_PAGE_DEFAULT_LIMIT })
    expect(AnchorListQuerySchema.safeParse({ limit: COLLECTION_PAGE_MAX_LIMIT + 1 }).success).toBe(false)
    expect(AnchorListQuerySchema.safeParse({ extra: true }).success).toBe(false)
    expect(AnchorListPageSchema.parse({ items: [], nextCursor: null, additive: true })).toEqual({
      items: [],
      nextCursor: null,
    })
    expect(AnchorListPageSchema.safeParse({ anchors: [] }).success).toBe(false)
  })
})
