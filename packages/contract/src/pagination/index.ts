import { z, type ZodType } from 'zod'

/** API-authenticated workspace identity forwarded to VM-local collection owners. */
export const DUET_COLLECTION_SUBJECT_HEADER = 'x-duet-collection-subject'

export const COLLECTION_PAGE_DEFAULT_LIMIT = 50
export const COLLECTION_PAGE_MAX_LIMIT = 100

export const CollectionPageQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(COLLECTION_PAGE_MAX_LIMIT)
      .default(COLLECTION_PAGE_DEFAULT_LIMIT),
  })
  .strict()

export type CollectionPageQuery = z.infer<typeof CollectionPageQuerySchema>

export type CollectionPage<Item, Meta = never> = {
  items: Item[]
  nextCursor: string | null
  meta?: Meta
}

export type CollectionPageRequest = {
  cursor?: string
  limit: number
  signal?: AbortSignal
}

export class InvalidCollectionCursorError extends Error {
  readonly code = 'invalid_cursor'

  constructor() {
    super('invalid_cursor')
    this.name = 'InvalidCollectionCursorError'
  }
}

export const CollectionCursorErrorSchema = z
  .object({ error: z.literal('invalid_cursor') })
  .describe('Opaque collection cursor is malformed or bound to another walk (400)')

const ConvexInvalidCursorSystemErrorSchema = z
  .object({
    isConvexSystemError: z.literal(true),
    paginationError: z.literal('InvalidCursor'),
  })
  .loose()

/** Recognize only the structured cursor errors owned by Duet or Convex. */
export function isCollectionCursorError(error: unknown): boolean {
  if (error instanceof InvalidCollectionCursorError) return true
  if (typeof error !== 'object' || error === null) return false
  const data = 'data' in error ? error.data : undefined
  return (
    CollectionCursorErrorSchema.safeParse(data).success ||
    ConvexInvalidCursorSystemErrorSchema.safeParse(data).success
  )
}

export async function* iterateCollectionPages<Item, Meta = never>(
  fetchPage: (request: CollectionPageRequest) => Promise<CollectionPage<Item, Meta>>,
  options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): AsyncGenerator<CollectionPage<Item, Meta>, void> {
  const initial = CollectionPageQuerySchema.parse({
    cursor: options.cursor,
    limit: options.limit,
  })
  const limit = initial.limit
  let cursor = initial.cursor
  const requestedCursors = new Set<string | undefined>()

  while (true) {
    options.signal?.throwIfAborted()
    if (requestedCursors.has(cursor)) throw new InvalidCollectionCursorError()
    requestedCursors.add(cursor)
    const page = await fetchPage({
      ...(cursor === undefined ? {} : { cursor }),
      limit,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    yield page
    if (page.nextCursor === null) return
    cursor = page.nextCursor
  }
}

export type CursorFilterValue =
  | string
  | number
  | boolean
  | null
  | readonly CursorFilterValue[]
  | { readonly [key: string]: CursorFilterValue | undefined }

export type CursorFilters = Readonly<Record<string, CursorFilterValue | undefined>>

const BoundCursorPayloadSchema = z
  .object({
    domain: z.string().min(1),
    subject: z.string().min(1),
    filtersHash: z.string().regex(/^[0-9a-f]{64}$/),
    order: z.string().min(1),
    position: z.unknown(),
  })
  .strict()

type CursorBinding = {
  subject: string
  filters: CursorFilters
  order: string
}

export function createBoundCursorCodec<PositionSchema extends ZodType>(
  domain: string,
  positionSchema: PositionSchema,
) {
  if (domain.length === 0) throw new Error('Cursor domain must not be empty')

  return {
    async encode({
      subject,
      filters,
      order,
      position,
    }: CursorBinding & { position: z.input<PositionSchema> }): Promise<string> {
      const payload = BoundCursorPayloadSchema.parse({
        domain,
        subject,
        filtersHash: await cursorFiltersHash(filters),
        order,
        position: positionSchema.parse(position),
      })
      return encodeOpaqueJson(payload)
    },

    async decode(cursor: string, expected: CursorBinding): Promise<z.output<PositionSchema>> {
      try {
        const payload = BoundCursorPayloadSchema.parse(decodeOpaqueJson(cursor))
        const expectedFiltersHash = await cursorFiltersHash(expected.filters)
        if (
          payload.domain !== domain ||
          payload.subject !== expected.subject ||
          payload.filtersHash !== expectedFiltersHash ||
          payload.order !== expected.order
        ) {
          throw new InvalidCollectionCursorError()
        }
        return positionSchema.parse(payload.position)
      } catch (error) {
        if (error instanceof InvalidCollectionCursorError) throw error
        throw new InvalidCollectionCursorError()
      }
    },
  }
}

async function cursorFiltersHash(filters: CursorFilters): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(filters))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function collectionPageSchema<Item extends ZodType>(
  itemSchema: Item,
): z.ZodObject<{
  items: z.ZodArray<Item>
  nextCursor: z.ZodNullable<z.ZodString>
}>
export function collectionPageSchema<Item extends ZodType, Meta extends z.ZodObject>(
  itemSchema: Item,
  metaSchema: Meta,
): z.ZodObject<{
  items: z.ZodArray<Item>
  nextCursor: z.ZodNullable<z.ZodString>
  meta: z.ZodOptional<Meta>
}>
export function collectionPageSchema(itemSchema: ZodType, metaSchema?: z.ZodObject) {
  const base = {
    items: z.array(itemSchema),
    nextCursor: z.string().min(1).nullable(),
  }
  return metaSchema === undefined
    ? z.object(base)
    : z.object({ ...base, meta: metaSchema.optional() })
}

function canonicalJson(value: CursorFilterValue | undefined): string {
  if (value === undefined) throw new TypeError('Cursor filters cannot be undefined at the root')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cursor filters must contain finite numbers')
    return JSON.stringify(value)
  }
  if (isCursorFilterArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('Cursor filters must be plain JSON objects')
  }
  return `{${Object.keys(value)
    .filter(key => value[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

function isCursorFilterArray(value: CursorFilterValue): value is readonly CursorFilterValue[] {
  return Array.isArray(value)
}

function encodeOpaqueJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeOpaqueJson(cursor: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCollectionCursorError()
  const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}
