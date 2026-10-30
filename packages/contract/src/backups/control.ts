import { z } from 'zod'

import { BackupErrorSchema, BackupPhaseSchema, BackupProgressSchema } from './jobs'

export const BackupWorkerAttemptSchema = z
  .object({ attemptId: z.string().min(1).max(128) })
  .strict()
export const BackupWorkerClaimResponseSchema = z.object({
  backup: z.object({
    id: z.string(),
    attemptId: z.string(),
    objectPath: z.string(),
    createdAt: z.number(),
  }),
  workspace: z.object({ name: z.string(), slug: z.string() }),
})
export const BackupWorkerProgressRequestSchema = BackupWorkerAttemptSchema.extend({
  phase: BackupPhaseSchema,
  progress: BackupProgressSchema,
})
export const BackupWorkerCompleteRequestSchema = BackupWorkerAttemptSchema.extend({
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  completeness: z.enum(['complete', 'partial']),
  progress: BackupProgressSchema,
})
export const BackupWorkerFailRequestSchema = BackupWorkerAttemptSchema.extend({
  error: BackupErrorSchema,
})
export const BackupUploadGrantSchema = z.object({
  token: z.string(),
  expiresAt: z.number(),
  pathname: z.string(),
})

export const BACKUP_UPLOAD_GRANT_MS = 15 * 60_000
// SDK operations stop within 60s; allow another minute for provider settlement.
export const BACKUP_UPLOAD_SETTLE_MS = 120_000
export const BACKUP_STALL_MS = 5 * 60_000
