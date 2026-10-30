import { z } from 'zod'

import { DriveRelativePathSchema } from '../anchors/index'
import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'
import { AppSlugSchema } from '../slug/index'
import { ANCHOR_MARKER_IGNORE, VCS_AND_DEPS_IGNORE } from '../sync-ignore/index'
import { utf8BoundedString } from '../utf8/index'
import { MAX_WORKSPACE_NAME_UTF8_BYTES } from '../workspaces/name'

export const MAX_SHARE_IGNORE_PATTERNS = 64
// Incoming and outgoing active shares compete for one workspace-wide VM-sync
// budget. A share seen on both sides is counted once by durable row identity.
export const MAX_ACTIVE_SHARES_PER_WORKSPACE = 50
export const MAX_SHARE_IGNORE_PATTERN_UTF8_BYTES = 512
export const MAX_SHARE_SYNC_ERROR_CODE_UTF8_BYTES = 128
export const MAX_SHARE_SYNC_GENERATION_UTF8_BYTES = 64
export const MAX_SHARE_PERSON_NAME_UTF8_BYTES = 600
export const MAX_SHARE_EMAIL_LENGTH = 320
export const MAX_SHARE_EMAIL_UTF8_BYTES = 960
export const ShareEmailSchema = z
  .string()
  .trim()
  .max(MAX_SHARE_EMAIL_LENGTH)
  .pipe(utf8BoundedString(MAX_SHARE_EMAIL_UTF8_BYTES, 'Share email'))
  .pipe(z.email())

export const ShareSyncErrorCodeSchema = utf8BoundedString(
  MAX_SHARE_SYNC_ERROR_CODE_UTF8_BYTES,
  'Share sync error code',
)
  .min(1)
  .regex(/^[a-z0-9_]+$/)
export const ShareSyncGenerationSchema = utf8BoundedString(
  MAX_SHARE_SYNC_GENERATION_UTF8_BYTES,
  'Share sync generation',
).min(1)

export const ShareModeSchema = z.enum(['read', 'write'])
const ShareStateSchema = z.enum(['pending', 'active', 'expired', 'revoked', 'unlinked'])
export type ShareMode = z.infer<typeof ShareModeSchema>
export type ShareState = z.infer<typeof ShareStateSchema>

// The share default is deliberately LOOSE: it lists ONLY patterns that
// technically break a share if synced — a git repo under two writers corrupts,
// node_modules is compiled for the wrong architecture across machines, and
// `.duet-anchor` carries workspace-local identity that would poison the peer
// (`../sync-ignore`, the one home shared with the mirror default). Everything
// else — including `.env` (ledger #14) — is left syncable on purpose; a share
// is meant to carry the folder's real contents. Because these patterns protect
// against breakage rather than express a preference, they form an unremovable
// floor: `ignorePatterns` on createShare/reshare ADD to them (see
// `shareIgnorePatterns`), never replace them.
export const DEFAULT_SHARE_IGNORE_PATTERNS = [
  ...VCS_AND_DEPS_IGNORE,
  ...ANCHOR_MARKER_IGNORE,
] as const

export const MAX_SHARE_USER_IGNORE_PATTERNS =
  MAX_SHARE_IGNORE_PATTERNS - DEFAULT_SHARE_IGNORE_PATTERNS.length
export const ShareIgnorePatternSchema = utf8BoundedString(
  MAX_SHARE_IGNORE_PATTERN_UTF8_BYTES,
  'Share ignore pattern',
).min(1)
export const ShareUserIgnorePatternsSchema = z
  .array(ShareIgnorePatternSchema)
  .max(MAX_SHARE_USER_IGNORE_PATTERNS)
export const ShareIgnorePatternsSchema = z
  .array(ShareIgnorePatternSchema)
  .max(MAX_SHARE_IGNORE_PATTERNS)

// The one owner of "how a sharer's ignore list combines with the default."
// The default is always applied and cannot be removed (it prevents breakage,
// not taste); user patterns append to it, deduped. So a sharer can exclude more
// (e.g. `.env`, a secrets dir) but can never opt into a corrupting share.
export function shareIgnorePatterns(userPatterns: readonly string[] | undefined): string[] {
  const bounded = ShareUserIgnorePatternsSchema.parse(userPatterns ?? [])
  const merged: string[] = [...DEFAULT_SHARE_IGNORE_PATTERNS]
  for (const pattern of bounded) {
    if (!merged.includes(pattern)) merged.push(pattern)
  }
  return ShareIgnorePatternsSchema.parse(merged)
}

// `ignorePatterns` ADD to the unremovable default floor (see
// `shareIgnorePatterns`) — the sharer's opt-out to exclude MORE than the
// default (e.g. `.env`, a secrets dir). It cannot remove the floor, so a share
// can never be made to sync `.git`/`node_modules`/`.duet-anchor`.
export const CreateShareRequestSchema = z.object({
  path: DriveRelativePathSchema,
  toEmail: ShareEmailSchema,
  mode: ShareModeSchema,
  ignorePatterns: ShareUserIgnorePatternsSchema.optional(),
})

export type CreateShareRequest = z.infer<typeof CreateShareRequestSchema>

export const ReshareRequestSchema = z.object({
  toEmail: ShareEmailSchema,
  mode: ShareModeSchema,
  ignorePatterns: ShareUserIgnorePatternsSchema.optional(),
})

export const AcceptShareRequestSchema = z.object({
  toWorkspaceId: z.string().min(1),
  mountPath: DriveRelativePathSchema,
})

export const UnlinkShareRequestSchema = z.object({})
export const SetSharePausedRequestSchema = z.object({ paused: z.boolean() })

const ShareProjectionBaseSchema = z.object({
  id: z.string(),
  anchorId: z.string(),
  originWorkspaceId: z.string(),
  fromWorkspaceId: z.string(),
  toEmail: ShareEmailSchema,
  toUserId: z.string().optional(),
  toWorkspaceId: z.string().optional(),
  mode: ShareModeSchema,
  ignorePatterns: ShareIgnorePatternsSchema,
  parentShareId: z.string().optional(),
  state: ShareStateSchema,
  createdByUserId: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  acceptedAt: z.number().optional(),
  pausedAt: z.number().optional(),
  revokedAt: z.number().optional(),
  unlinkedAt: z.number().optional(),
})

export const IncomingShareSchema = ShareProjectionBaseSchema.extend({
  mountPath: DriveRelativePathSchema.optional(),
})
export const OutgoingShareSchema = ShareProjectionBaseSchema.extend({
  tokenPrefix: z.string().max(64),
})
export type IncomingShare = z.infer<typeof IncomingShareSchema>
export type OutgoingShare = z.infer<typeof OutgoingShareSchema>
export type Share = IncomingShare | OutgoingShare

const ShareRealizationProjectionSchema = z.object({
  state: z.enum(['applying', 'ready', 'paused', 'error']),
  matchesCurrentGeneration: z.boolean(),
  errorCode: ShareSyncErrorCodeSchema.optional(),
  updatedAt: z.number(),
})

export const ShareSyncStatusSchema = z.object({
  origin: ShareRealizationProjectionSchema.optional(),
  recipient: ShareRealizationProjectionSchema.optional(),
})

export type ShareSyncStatus = z.infer<typeof ShareSyncStatusSchema>

export const IncomingShareListItemSchema = IncomingShareSchema.extend({
  sharerName: utf8BoundedString(MAX_SHARE_PERSON_NAME_UTF8_BYTES, 'Sharer name').min(1),
  sourceWorkspaceName: utf8BoundedString(
    MAX_WORKSPACE_NAME_UTF8_BYTES,
    'Source workspace name',
  ).min(1),
  syncStatus: ShareSyncStatusSchema.optional(),
})
export const OutgoingShareListItemSchema = OutgoingShareSchema.extend({
  sourcePath: DriveRelativePathSchema,
  syncStatus: ShareSyncStatusSchema.optional(),
})
export type IncomingShareListItem = z.infer<typeof IncomingShareListItemSchema>
export type OutgoingShareListItem = z.infer<typeof OutgoingShareListItemSchema>

const ShareRequestSourceSchema = z.object({
  workspaceName: utf8BoundedString(MAX_WORKSPACE_NAME_UTF8_BYTES, 'Source workspace name').min(1),
  path: DriveRelativePathSchema,
  folderName: utf8BoundedString(4_096, 'Share folder name').min(1),
  sharerName: utf8BoundedString(MAX_SHARE_PERSON_NAME_UTF8_BYTES, 'Sharer name').min(1),
  originLive: z.boolean(),
  apps: z
    .array(
      z.object({
        slug: AppSlugSchema,
        path: DriveRelativePathSchema,
      }),
    )
    .max(500),
})

export const ShareRequestSchema = IncomingShareSchema.extend({
  source: ShareRequestSourceSchema,
})
export type ShareRequest = z.infer<typeof ShareRequestSchema>

export const ShareListItemSchema = z.discriminatedUnion('direction', [
  IncomingShareListItemSchema.extend({ direction: z.literal('incoming') }),
  OutgoingShareListItemSchema.extend({ direction: z.literal('outgoing') }),
])
export type ShareListItem = z.infer<typeof ShareListItemSchema>
export const ShareListQuerySchema = CollectionPageQuerySchema
export const ShareListResponseSchema = collectionPageSchema(ShareListItemSchema)

export type ShareListResponse = z.infer<typeof ShareListResponseSchema>
export const PendingShareListQuerySchema = CollectionPageQuerySchema
export const PendingShareListResponseSchema = collectionPageSchema(ShareRequestSchema)

export const ShareRequestResponseSchema = z.object({
  share: ShareRequestSchema,
})

export const IncomingShareResponseSchema = z.object({
  share: IncomingShareSchema,
})

export const ShareResponseSchema = z.object({
  // A share read from the origin side carries `tokenPrefix`; one read from the
  // recipient side carries `mountPath`. There is no discriminant field, so this
  // union is resolved by which shape actually matches — which means the branches
  // must NOT accept each other's payloads. Merging them into one optional-both
  // object would be the wrong fix: it would let a recipient-facing projection
  // legitimately carry a `tokenPrefix` it must never see.
  share: z.union([IncomingShareSchema.strict(), OutgoingShareSchema.strict()]),
})

export type ShareResponse = z.infer<typeof ShareResponseSchema>
export const ShareRevokedResponseSchema = z.object({
  ok: z.literal(true),
  revokedShareIds: z.array(z.string()),
})

export const ShareUnlinkedResponseSchema = z.object({
  ok: z.literal(true),
  unlinkedShareIds: z.array(z.string()),
})

export const ShareDeclinedResponseSchema = z.object({
  ok: z.literal(true),
})

export const ShareMutationErrorSchema = z.union([
  z.object({ error: z.literal('already_shared') }),
  z.object({
    error: z.literal('rate_limited'),
    retryAfterSeconds: z.number(),
  }),
  z.object({
    error: z.enum(['forbidden', 'invalid_request', 'not_found', 'share_not_active']),
  }),
])
