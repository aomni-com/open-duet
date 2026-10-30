import { z } from 'zod'

import { MAX_DRIVE_PATH_UTF8_BYTES, normalizeDrivePath } from '../drive/index'
import { collectionPageSchema, CollectionPageQuerySchema } from '../pagination/index'
import { utf8BoundedString } from '../utf8/index'

export const MAX_ANCHOR_MARKER_NONCE_UTF8_BYTES = 64
// One workspace sends its complete live topology to the VM. Apps, agents,
// publishes, and both sides of shares compete for this single budget.
export const MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE = 500
// One candidate proves a move and two prove ambiguity; the third is retained
// only as diagnostic headroom while keeping audit provenance under 32 KiB.
export const MAX_ANCHOR_RENAME_CANDIDATES = 3
export const AnchorPathStorageSchema = utf8BoundedString(MAX_DRIVE_PATH_UTF8_BYTES, 'Anchor path')

const ANCHOR_KINDS = ['app', 'agent', 'publish', 'share-root', 'share-mount'] as const
const ANCHOR_STATES = ['active', 'broken', 'orphaned'] as const

const AnchorKindSchema = z.enum(ANCHOR_KINDS)
export const AnchorStateSchema = z.enum(ANCHOR_STATES)
export type AnchorKind = z.infer<typeof AnchorKindSchema>

export const AnchorSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  path: AnchorPathStorageSchema,
  kind: AnchorKindSchema,
  settings: z.unknown(),
  state: AnchorStateSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Anchor = z.infer<typeof AnchorSchema>

export interface RenameCandidate {
  fromPath: string
  toPath: string
  confidence: number
  inodeMatch: boolean
  markerMatch: boolean
}

export interface GatewayAnchor extends Anchor {
  markerNonce: string
  agentId?: string
}

export interface AnchorMoveCandidatesReport {
  anchorId: string
  candidates: RenameCandidate[]
  anchorPathExists: boolean
  consecutiveMissingPolls: number
  markerMatches: string[]
  /** A readable mover search reached a terminal verdict for this missing path. */
  missingIsConclusive?: boolean
}

const DriveRelativePathInputSchema = z.string().superRefine((path, ctx) => {
  const normalized = normalizeDrivePath(path)
  if (!normalized.ok) {
    ctx.addIssue({ code: 'custom', message: `Invalid drive path: ${normalized.reason}` })
  }
})

export const DriveRelativePathSchema = z.codec(DriveRelativePathInputSchema, z.string(), {
  decode(path) {
    const normalized = normalizeDrivePath(path)
    if (!normalized.ok) throw new Error(`Invalid drive path: ${normalized.reason}`)
    return normalized.relativePath
  },
  encode: path => path,
})

const RenameCandidateSchema = z.object({
  fromPath: DriveRelativePathSchema,
  toPath: DriveRelativePathSchema,
  confidence: z.number().min(0).max(1),
  inodeMatch: z.boolean(),
  markerMatch: z.boolean(),
})

export const AnchorMoveCandidatesReportSchema = z.object({
  anchorId: z.string().min(1),
  candidates: z.array(RenameCandidateSchema).max(MAX_ANCHOR_RENAME_CANDIDATES),
  anchorPathExists: z.boolean(),
  consecutiveMissingPolls: z.number().int().nonnegative(),
  markerMatches: z.array(DriveRelativePathSchema).max(MAX_ANCHOR_RENAME_CANDIDATES),
  missingIsConclusive: z.boolean().optional(),
})

export const ReanchorRequestSchema = z.object({
  path: DriveRelativePathSchema,
})

export const AnchorListQuerySchema = CollectionPageQuerySchema
export const AnchorListPageSchema = collectionPageSchema(AnchorSchema)
export const ReanchorResponseSchema = z.object({ anchor: AnchorSchema })
