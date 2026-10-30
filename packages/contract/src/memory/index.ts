import { z } from 'zod'

export const DEFAULT_MEMORY_LOCK_WAIT_MS = 5_000
export const DEFAULT_TRAIN_IMPORT_LOCK_WAIT_MS = 30_000

export const MemorySourceSchema = z.enum(['user', 'agent', 'system', 'api', 'import'])
export type MemorySource = z.infer<typeof MemorySourceSchema>

const MemoryKindSchema = z.enum(['observation', 'reflection', 'manual', 'note'])

const MemoryPrioritySchema = z.enum(['high', 'medium', 'low'])

export const MemoryRecordSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  kind: MemoryKindSchema,
  source: MemorySourceSchema,
  priority: MemoryPrioritySchema,
  createdAt: z.string(),
  lastUsedAt: z.string(),
  observedDate: z.string(),
  referencedDate: z.string().optional(),
  relativeDate: z.string().optional(),
  timeOfDay: z.string().optional(),
  sessionId: z.string().optional(),
  tags: z.array(z.string()),
  packScore: z.number().optional(),
  relevanceScore: z.number().optional(),
})
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>

export const MemoryAddRequestSchema = z.object({
  content: z
    .string()
    .refine(value => value.trim().length > 0, 'Content is required')
    .refine(value => !value.includes('\0'), 'NUL is not allowed'),
  source: MemorySourceSchema,
  sessionId: z
    .string()
    .refine(value => value.trim().length > 0, 'Session ID is required')
    .refine(value => !value.includes('\0'), 'NUL is not allowed')
    .optional(),
})

export const MemorySearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .refine(value => !value.includes('\0'), 'NUL is not allowed'),
  limit: z.coerce.number().int().min(1).max(100).default(10),
})

export const MemorySearchResultSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive(),
  results: z.array(MemoryRecordSchema),
})
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>

interface MemoryAddCliInput {
  dbPath: string
  content: string
  source: MemorySource
  sessionId?: string
  tags?: string[]
  waitMs: number
}

interface MemorySearchCliInput {
  dbPath: string
  query: string
  limit: number
  waitMs: number
}

interface MemoryReflectCliInput {
  dbPath: string
  waitMs: number
}

export const MEMORY_CLI_CONTRACT = {
  binary: 'duet',
  exitCodes: {
    ok: 0,
    usage: 64,
    unavailable: 69,
    lockTimeout: 75,
    incompatible: 78,
  },
  add: {
    argv(input: MemoryAddCliInput): string[] {
      return [
        'memory',
        'add',
        '--db',
        input.dbPath,
        '--json',
        '--source',
        input.source,
        ...(input.sessionId === undefined ? [] : ['--session', input.sessionId]),
        ...(input.tags ?? []).flatMap(tag => ['--tag', tag]),
        '--wait',
        waitSeconds(input.waitMs),
        input.content,
      ]
    },
    output: 'MemoryRecord',
  },
  /**
   * Open a store and list nothing: the cheapest command that makes the CLI
   * create and migrate a database, so a gateway can build an agent's store
   * before the agent's first turn would otherwise pay for it.
   */
  open: {
    argv(input: { dbPath: string }): string[] {
      return ['memory', '--json', '--db', input.dbPath]
    },
  },
  reflect: {
    argv(input: MemoryReflectCliInput): string[] {
      return ['memory', 'reflect', '--db', input.dbPath, '--wait', waitSeconds(input.waitMs)]
    },
    output: 'text',
  },
  recall: {
    argv(input: MemorySearchCliInput): string[] {
      return [
        'memory',
        'recall',
        '--db',
        input.dbPath,
        '--query',
        input.query,
        '--json',
        '--limit',
        String(input.limit),
        '--wait',
        waitSeconds(input.waitMs),
      ]
    },
    output: 'MemorySearchResult',
  },
} as const

function waitSeconds(waitMs: number): string {
  return String(waitMs / 1000)
}
