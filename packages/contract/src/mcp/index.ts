import { z } from 'zod'

import { AgentNoteRequestSchema } from '../agent/index'
import { normalizeDrivePath } from '../drive/index'
import { MemorySourceSchema } from '../memory/index'
import { ModelTypeSchema } from '../model-catalog/index'
import { WorkspaceSlugSchema } from '../slug/index'
import { MAX_TRAIN_FILES, MAX_TRAIN_URLS, TrainUrlUploadRequestSchema } from '../train/index'

// Server naming and the namespaced-tool-name codec live in a sibling file with
// no imports but zod: this module's facade schemas depend on `../agent`, and
// the launch marker there depends on the naming rules.
export * from './naming'
export * from './wire'

export interface McpHttpServerConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export type McpServersConfig = Record<string, McpHttpServerConfig>

const DrivePathSchema = z.string().superRefine((path, ctx) => {
  if (normalizeDrivePath(path).ok) return
  ctx.addIssue({
    code: 'custom',
    message: 'Invalid drive path',
  })
})

const ListDrivePathSchema = z.string().superRefine((path, ctx) => {
  if (normalizeDrivePath(path, { allowRoot: true }).ok) return
  ctx.addIssue({
    code: 'custom',
    message: 'Invalid drive path',
  })
})

export const McpListFilesInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  path: ListDrivePathSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export const McpReadFileInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  path: DrivePathSchema,
})

export const McpWriteFileInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  path: DrivePathSchema,
  content: z.string(),
  ifMatch: z.string().optional(),
})

export const McpFileHistoryInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  path: DrivePathSchema,
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  includeReads: z.boolean().optional(),
})

export const McpFileSeenByInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  path: DrivePathSchema,
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export const McpMemoryAddInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  content: z.string().min(1),
  source: MemorySourceSchema.default('api'),
})

export const McpMemorySearchInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
})

// The hosted facade takes references — URLs and drive paths — never bytes.
// Those fields are declared-and-forbidden rather than merely absent: an unknown
// field should pass (a newer client may send one), but a caller that hands us
// `content` believes it uploaded something. Silently dropping it would start a
// train run over material that was never there, so it has to fail loudly.
const forbiddenBytes = z.never().optional()

export const McpTrainStartInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  urls: z.array(TrainUrlUploadRequestSchema.shape.url).max(MAX_TRAIN_URLS).optional(),
  driveFiles: z.array(DrivePathSchema).max(MAX_TRAIN_FILES).optional(),
  files: forbiddenBytes,
  content: forbiddenBytes,
  encoding: forbiddenBytes,
})

export const McpListAgentSessionsInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export const McpAddAgentNoteInputSchema = AgentNoteRequestSchema.safeExtend({
  workspace: WorkspaceSlugSchema,
  sessionId: z.string().min(1),
})

export const McpListModelsInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  kind: ModelTypeSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .regex(/^\d+$/)
    .refine(value => Number.isSafeInteger(Number(value)), 'Cursor must be a safe decimal offset')
    .optional(),
})
export type McpListModelsInput = z.infer<typeof McpListModelsInputSchema>

export const McpGenerateMediaInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  kind: z.enum(['image', 'video']).default('image'),
  model: z.string().min(1).optional(),
  prompt: z.string().min(1),
  duration: z.number().positive().optional(),
  resolution: z
    .templateLiteral([z.number(), 'x', z.number()])
    .refine(
      value => /^[1-9]\d*x[1-9]\d*$/.test(value),
      'Resolution must contain positive integer dimensions',
    )
    .optional(),
})
export type McpGenerateMediaInput = z.infer<typeof McpGenerateMediaInputSchema>

export const McpUseIntegrationInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  toolSlug: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
})
