import { z } from 'zod'

import { CollectionPageQuerySchema } from '../pagination'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const BackupPurposeSchema = z.enum(['export', 'archive', 'reprovision'])
export const BackupStatusSchema = z.enum(['queued', 'running', 'ready', 'failed', 'deleting'])
export const BackupPhaseSchema = z.enum(['metadata', 'files', 'upload', 'finalizing'])
export const BackupProgressSchema = z
  .object({
    processedFiles: count,
    processedRecords: count,
    capturedBytes: count,
    uploadedBytes: count,
    warningCount: count,
    warningSummary: z.array(z.object({ code: z.string().min(1).max(80), count })).max(32),
  })
  .strict()
export const BackupErrorSchema = z
  .object({
    code: z.enum([
      'vm_unavailable',
      'interrupted',
      'stalled',
      'capture_failed',
      'upload_failed',
      'object_mismatch',
      'cleanup_failed',
    ]),
    message: z.string().max(1024),
  })
  .strict()
export const BackupLifecycleSchema = z.object({
  kind: z.enum(['reprovision', 'archive', 'servicing']),
  status: z.enum(['capturing', 'restoring', 'complete', 'failed', 'deferred', 'abandoned']),
  reason: z.string().optional(),
})
export const BackupSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    purpose: BackupPurposeSchema,
    status: BackupStatusSchema,
    phase: BackupPhaseSchema.optional(),
    createdAt: count,
    updatedAt: count,
    startedAt: count.optional(),
    completedAt: count.optional(),
    progress: BackupProgressSchema,
    completeness: z.enum(['complete', 'partial']).optional(),
    bytes: count.optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    error: BackupErrorSchema.optional(),
    lifecycle: BackupLifecycleSchema.optional(),
  })
  .strict()
export const BackupCreateRequestSchema = z
  .object({ requestId: z.string().min(1).max(128) })
  .strict()
export const BackupResponseSchema = z.object({ backup: BackupSchema }).strict()
export const BackupListQuerySchema = CollectionPageQuerySchema
export const BackupListResponseSchema = z
  .object({ items: z.array(BackupSchema), nextCursor: z.string().nullable() })
  .strict()
export const BackupDownloadResponseSchema = z
  .object({
    url: z.string().url(),
    expiresAt: count,
    filename: z.string(),
    bytes: count,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export const BackupDeleteResponseSchema = z
  .object({ deleted: z.boolean(), emptyDriveOnNextStart: z.boolean() })
  .strict()
export type Backup = z.infer<typeof BackupSchema>
export type BackupProgress = z.infer<typeof BackupProgressSchema>
