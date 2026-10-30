import { z } from 'zod'

import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'
import { NormalizedSlugSchema, PublishSlugSchema } from '../slug/index'
import { utf8BoundedString } from '../utf8/index'

export const PublishKindSchema = z.enum(['file', 'folder'])
export const MAX_PUBLISH_SNAPSHOT_COMPONENT_UTF8_BYTES = 512
export const PublishSnapshotComponentSchema = utf8BoundedString(
  MAX_PUBLISH_SNAPSHOT_COMPONENT_UTF8_BYTES,
  'Publish snapshot component',
).regex(/^[A-Za-z0-9_-]+$/)

export const CreatePublishRequestSchema = z.object({
  path: z.string().min(1),
  slug: NormalizedSlugSchema.optional(),
})

export const UpdatePublishSlugRequestSchema = z.object({
  slug: NormalizedSlugSchema,
})

export const SetPublishPausedRequestSchema = z.object({ paused: z.boolean() })

export const GatewayPublishFreezeRequestSchema = z.object({
  publishId: PublishSnapshotComponentSchema,
  generation: PublishSnapshotComponentSchema,
  anchorPath: z.string().min(1),
  kind: PublishKindSchema,
})

export const GatewayPublishFreezeResponseSchema = z.object({ ok: z.literal(true) })
export type GatewayPublishFreezeRequest = z.infer<typeof GatewayPublishFreezeRequestSchema>

export const GatewayPublishFreezeGcRequestSchema = z.object({
  publishId: PublishSnapshotComponentSchema,
  // Absent ⇒ the publish resumed or was deleted; every generation reaps.
  keepGeneration: PublishSnapshotComponentSchema.optional(),
})

export type GatewayPublishFreezeGcRequest = z.infer<typeof GatewayPublishFreezeGcRequestSchema>

const PublishRowSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  anchorId: z.string(),
  anchorPath: z.string(),
  slug: PublishSlugSchema,
  kind: PublishKindSchema,
  pausedAt: z.number().optional(),
  pauseGeneration: PublishSnapshotComponentSchema.optional(),
  createdByUserId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type PublishRow = z.infer<typeof PublishRowSchema>

export const PublishListQuerySchema = CollectionPageQuerySchema
export const PublishListResponseSchema = collectionPageSchema(PublishRowSchema)
export const PublishResponseSchema = z.object({ publish: PublishRowSchema })
export const PublishDeletedResponseSchema = z.object({ ok: z.literal(true) })

export function isEnvLikeDrivePath(path: string): boolean {
  // Any segment that starts with `.env` — `.env`, `.env.local`, `.envrc`,
  // `.env.keys`, … — is treated as secret-bearing and must never publish. A
  // stricter `=== '.env' || startsWith('.env.')` check leaked `.envrc`.
  return path
    .split('/')
    .filter(part => part.length > 0)
    .some(part => part.startsWith('.env'))
}

// The publish serving floor — the ONLY paths a publish never serves, at any
// depth: env-like secrets (serving policy; see the `.env` note in
// `../sync-ignore`), plus the share floor's exact segment names — `.git` and
// `node_modules` (never useful to serve, unbounded to archive) and
// `.duet-anchor` (workspace-local identity). Everything else, ordinary
// dotfiles included, is public once its folder is published; hiding dotfiles
// is UI presentation, not a serving policy.
const PUBLISH_FLOOR_SEGMENTS = new Set(['.git', 'node_modules', '.duet-anchor'])

export function isPublishExcludedDrivePath(path: string): boolean {
  if (isEnvLikeDrivePath(path)) return true
  return path
    .split('/')
    .filter(part => part.length > 0)
    .some(part => PUBLISH_FLOOR_SEGMENTS.has(part))
}
