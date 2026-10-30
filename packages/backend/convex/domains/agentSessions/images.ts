import { makeFunctionReference, type FunctionReference } from 'convex/server'
import type { Infer } from 'convex/values'

import {
  AGENT_INPUT_IMAGE_MAX_COUNT,
  AgentInputImageSchema,
  type AgentEventImage,
} from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import type { ActionCtx, QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { requireSessionPointFromDb } from './access'
import type {
  deleteStoredInputImagesArgs,
  findSessionImageMetadataArgs,
  resolveSessionImageUrlsArgs,
  sessionImageUrlArgs,
  storeInputImagesArgs,
} from './model'

type QueryRef = FunctionReference<'query'>

export async function storeInputImagesImpl(
  ctx: ActionCtx,
  args: Infer<typeof storeInputImagesArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const images = parseInputImages(args.images)
  const stored: Array<{
    storageId: Id<'_storage'>
    mimeType: (typeof images)[number]['mimeType']
    bytes: number
  }> = []
  try {
    for (const image of images) {
      const bytes = base64ToBytes(image.data)
      const blobBytes = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(blobBytes).set(bytes)
      const storageId = await ctx.storage.store(new Blob([blobBytes], { type: image.mimeType }))
      stored.push({ storageId, mimeType: image.mimeType, bytes: bytes.byteLength })
    }
  } catch (error) {
    const cleanup = await Promise.allSettled(
      stored.map(image => ctx.storage.delete(image.storageId)),
    )
    logCleanupFailures(
      cleanup,
      stored.map(image => image.storageId),
    )
    throw error
  }
  return stored
}

export async function deleteStoredInputImagesImpl(
  ctx: ActionCtx,
  args: Infer<typeof deleteStoredInputImagesArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const results = await Promise.allSettled(args.storageIds.map(id => ctx.storage.delete(id)))
  const deleted = results.filter(result => result.status === 'fulfilled').length
  const failed = logCleanupFailures(results, args.storageIds)
  if (failed.length > 0) {
    throw new Error(`Failed to delete ${failed.length} stored input image(s)`)
  }
  return { deleted }
}

function logCleanupFailures(
  results: PromiseSettledResult<void>[],
  storageIds: Id<'_storage'>[],
): Array<{ storageId: Id<'_storage'>; error: string }> {
  const failed = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [{ storageId: storageIds[index]!, error: String(result.reason) }]
      : [],
  )
  if (failed.length > 0) console.error('agent input image cleanup failed', failed)
  return failed
}

export async function resolveSessionImageUrlsImpl(
  ctx: ActionCtx,
  args: Infer<typeof resolveSessionImageUrlsArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const images: Array<{ url: string; mimeType: (typeof args.images)[number]['mimeType'] }> = []
  for (const image of args.images) {
    const metadata = (await ctx.runQuery(
      fnQuery('domains/agentSessions/model:findSessionImageMetadataForDelivery'),
      {
        internalKey: args.internalKey,
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        storageId: image.storageId,
      },
    )) as { storageId: Id<'_storage'>; mimeType: string; bytes: number } | null
    if (metadata === null || metadata.mimeType !== image.mimeType) {
      throw new Error('Image not found')
    }
    const url = await ctx.storage.getUrl(image.storageId)
    if (url === null) throw new Error('Image not found')
    images.push({ url, mimeType: image.mimeType })
  }
  return images
}

export async function sessionImageUrlImpl(ctx: ActionCtx, args: Infer<typeof sessionImageUrlArgs>) {
  requireApiInternalKey(args.internalKey)
  const metadata = (await ctx.runQuery(
    fnQuery('domains/agentSessions/model:findSessionImageMetadata'),
    {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      storageId: args.storageId,
      identity: args.identity,
    },
  )) as { storageId: Id<'_storage'>; mimeType: string; bytes: number } | null
  if (metadata === null) return null
  const url = await ctx.storage.getUrl(metadata.storageId)
  if (url === null) return null
  return { url, mimeType: AgentInputImageSchema.shape.mimeType.parse(metadata.mimeType) }
}

export async function findSessionImageMetadataForDeliveryImpl(
  ctx: QueryCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    storageId: Id<'_storage'>
  },
) {
  requireApiInternalKey(args.internalKey)
  const session = await ctx.db.get(args.sessionId)
  if (
    session === null ||
    session.workspaceId !== args.workspaceId ||
    !session.visible ||
    session.archiveState === 'deleting'
  ) {
    return null
  }
  const image = await ctx.db
    .query('agentSessionImages')
    .withIndex('by_session_storage', q =>
      q.eq('sessionId', session._id).eq('storageId', args.storageId),
    )
    .unique()
  return image === null || image.workspaceId !== args.workspaceId
    ? null
    : { storageId: image.storageId, mimeType: image.mimeType, bytes: image.bytes }
}

export async function findSessionImageMetadataImpl(
  ctx: QueryCtx,
  args: Infer<typeof findSessionImageMetadataArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const { session } = await requireSessionPointFromDb(ctx, args)
  // System-table ids do not pass through the ordinary table normalizer. An
  // arbitrary opaque value cannot match a registered image, so the indexed
  // miss below is the generic not-found result.
  const storageId = args.storageId as Id<'_storage'>
  const image = await ctx.db
    .query('agentSessionImages')
    .withIndex('by_session_storage', q => q.eq('sessionId', session._id).eq('storageId', storageId))
    .unique()
  if (image === null || image.workspaceId !== args.workspaceId) return null
  return { storageId: image.storageId, mimeType: image.mimeType, bytes: image.bytes }
}

function parseInputImages(images: Array<{ data: string; mimeType: string }>): Array<{
  data: string
  mimeType: AgentEventImage['mimeType']
}> {
  if (images.length > AGENT_INPUT_IMAGE_MAX_COUNT) throw new Error('Too many images')
  return images.map(image => AgentInputImageSchema.parse(image))
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function fnQuery(name: string): QueryRef {
  return makeFunctionReference(name) as QueryRef
}
