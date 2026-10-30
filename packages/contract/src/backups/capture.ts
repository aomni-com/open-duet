import { z } from 'zod'

import {
  AgentFollowUpQueueEntrySchema,
  AgentStateMachineDefinitionSchema,
  AgentTodoSchema,
} from '../agent'
import { BackupWarningSchema } from './archive'

export const BackupCaptureCollectionSchema = z.enum([
  'settings',
  'agents',
  'apps',
  'toolkitPolicies',
  'mcpServers',
  'providers',
  'sessions',
  'events',
  'images',
])
export const BackupCaptureRequestSchema = z
  .object({
    collection: BackupCaptureCollectionSchema,
    cutoff: z.number().finite().nonnegative(),
    cursor: z.string().nullable(),
    sessionId: z.string().optional(),
    ceiling: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if ((request.collection === 'events' || request.collection === 'images') && !request.sessionId)
      ctx.addIssue({ code: 'custom', message: 'Session required', path: ['sessionId'] })
    if (request.collection === 'events' && request.ceiling === undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Captured event ceiling required',
        path: ['ceiling'],
      })
  })
export type BackupCaptureRequest = z.infer<typeof BackupCaptureRequestSchema>

const anchored = {
  key: z.string(),
  path: z.string().nullable(),
  slug: z.string(),
  name: z.string().optional(),
  icon: z.string().optional(),
  disabled: z.boolean(),
}
export const BackupCaptureRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('settings'),
    name: z.string(),
    slug: z.string(),
    assistantName: z.string().optional(),
    purpose: z.string().optional(),
    defaultModelId: z.string().optional(),
    onboardedAt: z.number().optional(),
    maxMonthlySpendMicroUsd: z.number().optional(),
  }),
  z.object({
    kind: z.literal('agent'),
    ...anchored,
    onboardedAt: z.number().optional(),
    defaultSessionKey: z.string().optional(),
  }),
  z.object({
    kind: z.literal('app'),
    ...anchored,
    command: z.string(),
    installCommand: z.string().optional(),
    port: z.number().optional(),
    apiScopes: z.array(z.string()),
    visibility: z.enum(['folder', 'public']),
  }),
  z.object({
    kind: z.literal('toolkitPolicy'),
    toolkitSlug: z.string(),
    allowedAgentIds: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('mcpServer'),
    key: z.string(),
    name: z.string(),
    label: z.string(),
    url: z.string(),
    authKind: z.enum(['none', 'oauth', 'static']),
    token: z.string().optional(),
    allowedAgentIds: z.array(z.string()).optional(),
    reconnectRequired: z.boolean(),
  }),
  z.object({
    kind: z.literal('provider'),
    provider: z.enum(['openai-codex', 'github-copilot']),
    reconnectRequired: z.boolean(),
  }),
  z.object({
    kind: z.literal('session'),
    key: z.string(),
    title: z.string(),
    prompt: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    agentKey: z.string(),
    parentKey: z.string().optional(),
    cwd: z.string().optional(),
    archived: z.boolean(),
    archivedAt: z.number().optional(),
    visible: z.boolean(),
    onboarding: z.boolean().optional(),
    modelId: z.string().optional(),
    todos: z.array(AgentTodoSchema).optional(),
    followUps: z.array(AgentFollowUpQueueEntrySchema).optional(),
    stateMachine: AgentStateMachineDefinitionSchema.optional(),
    eventCeiling: z.number().int().nonnegative(),
    capturedAt: z.number(),
  }),
  // History is durable user-authored content. Preserve fields from event versions
  // newer or older than the reader rather than stripping them with today's union.
  z.object({
    kind: z.literal('event'),
    sessionKey: z.string(),
    seq: z.number().int().nonnegative(),
    createdAt: z.number(),
    event: z.object({}).passthrough(),
  }),
  // sourceUrl is a transient fetch descriptor, never archive content.
  z.object({
    kind: z.literal('image'),
    sessionKey: z.string(),
    storageId: z.string(),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    bytes: z.number().int().nonnegative(),
    sourceUrl: z.string(),
  }),
])
export type BackupCaptureRecord = z.infer<typeof BackupCaptureRecordSchema>
export const BackupCapturePageSchema = z.object({
  records: z.array(BackupCaptureRecordSchema).max(128),
  warnings: z.array(BackupWarningSchema),
  nextCursor: z.string().nullable(),
})
export type BackupCapturePage = z.infer<typeof BackupCapturePageSchema>
