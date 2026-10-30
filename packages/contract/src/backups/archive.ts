import { z } from 'zod'

export const BackupWarningSchema = z.object({
  code: z.enum([
    'source_changed',
    'disappeared',
    'unreadable',
    'unsupported_node',
    'dangling_metadata',
    'missing_image',
    'incomplete_collection',
  ]),
  path: z.string().optional(),
  recordKey: z.string().optional(),
  detail: z.string(),
})
export type BackupWarning = z.infer<typeof BackupWarningSchema>

export const BackupCaptureSchema = z.object({
  backupId: z.string(),
  workspace: z.object({ name: z.string(), slug: z.string() }),
  createdAt: z.number(),
})
export type BackupCapture = z.infer<typeof BackupCaptureSchema>

export const BackupInventoryEntrySchema = z.object({
  path: z.string(),
  type: z.enum(['file', 'directory', 'symlink']),
  mode: z.number().int(),
  mtime: z.number(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().optional(),
  target: z.string().optional(),
})
export type BackupInventoryEntry = z.infer<typeof BackupInventoryEntrySchema>

export const BackupArchiveSummarySchema = z.object({
  format: z.literal('duet-workspace-backup'),
  version: z.literal(1),
  backupId: z.string(),
  workspace: z.object({ name: z.string(), slug: z.string() }),
  createdAt: z.number(),
  captureStartedAt: z.number(),
  captureEndedAt: z.number(),
  consistency: z.literal('live'),
  completeness: z.enum(['complete', 'partial']),
  counts: z.object({
    drive: z.number(),
    workspace: z.number(),
    files: z.number(),
    directories: z.number(),
    symlinks: z.number(),
    bytes: z.number(),
  }),
  warningCounts: z.partialRecord(BackupWarningSchema.shape.code, z.number()),
  inventory: z.literal('inventory.ndjson'),
  warnings: z.literal('warnings.ndjson'),
})
export type BackupArchiveSummary = z.infer<typeof BackupArchiveSummarySchema>
