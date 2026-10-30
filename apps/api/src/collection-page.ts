import { z } from 'zod'

import {
  createBoundCursorCodec,
  InvalidCollectionCursorError,
  type CollectionPage,
  type CollectionPageQuery,
  type CursorFilters,
} from '@repo/contract'

type CursorBinding = {
  subject: string
  filters: CursorFilters
  order: string
}

type ConvexPage<Item> = {
  page: Item[]
  continueCursor: string
  isDone: boolean
}

export function createContinuationCollectionPage(domain: string) {
  const codec = createBoundCursorCodec(domain, z.object({ cursor: z.string().min(1) }).strict())

  return {
    async paginationOpts(query: CollectionPageQuery, binding: CursorBinding) {
      return {
        cursor:
          query.cursor === undefined ? null : (await codec.decode(query.cursor, binding)).cursor,
        numItems: query.limit,
      }
    },

    async response<Stored, Item = Stored>(
      result: ConvexPage<Stored>,
      binding: CursorBinding,
      project: (stored: Stored) => Item = stored => stored as unknown as Item,
    ): Promise<CollectionPage<Item>> {
      return {
        items: result.page.map(project),
        nextCursor: result.isDone
          ? null
          : await codec.encode({
              ...binding,
              position: { cursor: result.continueCursor },
            }),
      }
    },
  }
}

// Convex is the most common continuation provider, so routes keep the more
// specific name while gateway/provider routes share the same boundary owner.
export const createConvexCollectionPage = createContinuationCollectionPage

/**
 * Page a Convex query whose index boundary depends on the current time.
 *
 * Convex continuations are valid only for identical query arguments, so the
 * first page pins the time boundary and carries it beside the private Convex
 * cursor for the rest of that walk.
 */
export function createTemporalConvexCollectionPage(domain: string) {
  const codec = createBoundCursorCodec(
    domain,
    z.object({ cursor: z.string().min(1), asOf: z.number().finite().nonnegative() }).strict(),
  )

  return {
    async pagination(
      query: CollectionPageQuery,
      binding: CursorBinding,
      currentTime: number,
    ): Promise<{ paginationOpts: { cursor: string | null; numItems: number }; asOf: number }> {
      if (query.cursor === undefined) {
        return {
          paginationOpts: { cursor: null, numItems: query.limit },
          asOf: currentTime,
        }
      }
      const position = await codec.decode(query.cursor, binding)
      return {
        paginationOpts: { cursor: position.cursor, numItems: query.limit },
        asOf: position.asOf,
      }
    },

    async response<Item>(
      result: ConvexPage<Item>,
      binding: CursorBinding,
      asOf: number,
    ): Promise<CollectionPage<Item>> {
      return {
        items: result.page,
        nextCursor: result.isDone
          ? null
          : await codec.encode({
              ...binding,
              position: { cursor: result.continueCursor, asOf },
            }),
      }
    },
  }
}

/**
 * Page a source that is already bounded by its owning service.
 *
 * The cursor stores only the last item's stable identity. The caller owns the
 * declared order and must pass that exact ordered set on every request. This
 * keeps provider/storage internals private without reviving an offset cursor
 * that duplicates rows when an earlier item is inserted.
 */
export function createMaterializedCollectionPage(domain: string) {
  const codec = createBoundCursorCodec(
    domain,
    z.object({ tuple: z.array(z.union([z.string(), z.number().finite()])).min(1) }).strict(),
  )

  return {
    async response<Item>(
      query: CollectionPageQuery,
      binding: CursorBinding,
      orderedItems: readonly Item[],
      position: (item: Item) => readonly (string | number)[],
    ): Promise<CollectionPage<Item>> {
      let start = 0
      if (query.cursor !== undefined) {
        const boundary = await codec.decode(query.cursor, binding)
        start = orderedItems.findIndex(item => compareTuple(position(item), boundary.tuple) > 0)
        if (start < 0) start = orderedItems.length
      }
      const items = orderedItems.slice(start, start + query.limit)
      const hasMore = start + items.length < orderedItems.length
      return {
        items,
        nextCursor:
          !hasMore || items.length === 0
            ? null
            : await codec.encode({
                ...binding,
                position: { tuple: [...position(items.at(-1)!)] },
              }),
      }
    },
  }
}

function compareTuple(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index]
    const rightPart = right[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (typeof leftPart !== typeof rightPart) throw new InvalidCollectionCursorError()
    if (typeof leftPart === 'string' && typeof rightPart === 'string') {
      const comparison = leftPart.localeCompare(rightPart)
      if (comparison !== 0) return comparison
      continue
    }
    if (leftPart < rightPart) return -1
    if (leftPart > rightPart) return 1
  }
  return 0
}
