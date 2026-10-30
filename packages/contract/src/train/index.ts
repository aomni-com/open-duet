import { z } from 'zod'

import { MAX_AGENTS_PER_WORKSPACE } from '../agents/index'
import { normalizeDrivePath } from '../drive/index'
import { assertPublicHttpUrl } from '../net/index'
import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'
import { AppSlugSchema } from '../slug/index'
import { utf8BoundedString } from '../utf8/index'
import { VmUploadGrantSchema } from '../vm/uploads'

export const MAX_TRAIN_URLS = 25
export const MAX_TRAIN_FILES = 200
export const MAX_TRAIN_SOURCE_FAILURE_TEXT = 2048
export const MAX_TRAIN_IDENTIFIER_UTF8_BYTES = 512
export const MAX_TRAIN_ERROR_UTF8_BYTES = 4 * 1_024
export const MAX_TRAIN_REPORTS_PER_SYNC = 100
export const MAX_TRAIN_RECORD_HEADLINE_UTF8_BYTES = 4 * 1_024
export const MAX_TRAIN_RECORD_MODEL_UTF8_BYTES = 512
export const MAX_TRAIN_RECORD_PATH_UTF8_BYTES = 4 * 1_024
export const MAX_TRAIN_RECORD_URL_UTF8_BYTES = 8 * 1_024
export const MAX_TRAIN_RECORD_DATE_UTF8_BYTES = 128
export const TRAIN_UPLOADS_CAP_BYTES = 1024 * 1024 * 1024
export const MAX_TRAIN_INLINE_BYTES = 10 * 1024 * 1024
export const DUET_TRAIN_SOURCE_URL_HEADER = 'x-duet-train-source-url'

export const TrainIdentifierSchema = utf8BoundedString(
  MAX_TRAIN_IDENTIFIER_UTF8_BYTES,
  'Train identifier',
).min(1)
export const TrainErrorSchema = utf8BoundedString(MAX_TRAIN_ERROR_UTF8_BYTES, 'Train error')

export const TrainJobStateSchema = z.enum(['queued', 'running', 'done', 'failed'])
export type TrainJobState = z.infer<typeof TrainJobStateSchema>

export const TrainSourceFailureSchema = z.object({
  source: utf8BoundedString(MAX_TRAIN_SOURCE_FAILURE_TEXT, 'Train failure source'),
  code: z.literal('source_fetch_failed'),
  message: utf8BoundedString(MAX_TRAIN_SOURCE_FAILURE_TEXT, 'Train failure message'),
})

export type TrainSourceFailure = z.infer<typeof TrainSourceFailureSchema>

export const GATEWAY_TRAIN_JOB_PHASES = [
  'preparing',
  'snapshotting',
  'training',
  'finalizing',
  'cleanup',
  'done',
  'failed',
] as const
export const GatewayTrainJobPhaseSchema = z.enum(GATEWAY_TRAIN_JOB_PHASES)
export type GatewayTrainJobPhase = z.infer<typeof GatewayTrainJobPhaseSchema>

export const GatewayTrainJobReportSchema = z.object({
  generation: TrainIdentifierSchema,
  jobId: TrainIdentifierSchema,
  creatorUserId: TrainIdentifierSchema,
  agentId: TrainIdentifierSchema.optional(),
  // The VM's native scope key. The gateway never knows Convex agent ids;
  // reconcile resolves this to agentId/agentSlug when inserting a row the
  // API has not created yet (VM-first race).
  anchorId: TrainIdentifierSchema.optional(),
  state: TrainJobStateSchema,
  phase: GatewayTrainJobPhaseSchema,
  error: TrainErrorSchema.optional(),
  sourceFailures: z.array(TrainSourceFailureSchema).max(MAX_TRAIN_URLS).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
})

export type GatewayTrainJobReport = z.infer<typeof GatewayTrainJobReportSchema>
export const GatewayTrainJobReportBatchSchema = z
  .array(GatewayTrainJobReportSchema)
  .max(MAX_TRAIN_REPORTS_PER_SYNC)

export const TrainUploadEntrySchema = z.object({
  filename: z.string().min(1),
  size: z.number().int().nonnegative(),
  uploadedAt: z.number(),
  url: z.string().optional(),
})

export type TrainUploadEntry = z.infer<typeof TrainUploadEntrySchema>

export const TrainUploadsListMetaSchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  capBytes: z.number().int().positive(),
  running: z.boolean(),
})

export const TrainUploadsListQuerySchema = CollectionPageQuerySchema
export const TrainUploadsListResponseSchema = collectionPageSchema(
  TrainUploadEntrySchema,
  TrainUploadsListMetaSchema,
)

export type TrainUploadsListResponse = z.infer<typeof TrainUploadsListResponseSchema>

export const TrainUploadSessionRequestSchema = z.object({})
export type TrainUploadSessionRequest = z.infer<typeof TrainUploadSessionRequestSchema>

export const TrainUploadSessionSchema = VmUploadGrantSchema

export type TrainUploadSession = z.infer<typeof TrainUploadSessionSchema>

export const TrainUploadDeleteResponseSchema = z.object({
  ok: z.literal(true),
})

export type TrainUploadDeleteResponse = z.infer<typeof TrainUploadDeleteResponseSchema>

export const TrainUrlUploadRequestSchema = z.object({
  // `assertPublicHttpUrl` owns the whole policy — absolute http(s), no
  // credentials, no loopback or private/reserved host. It threw for all of
  // those and was called from nowhere but its own test, so the boundary
  // accepted every one of them. This is the place a user-supplied training URL
  // is actually judged.
  url: utf8BoundedString(MAX_TRAIN_RECORD_URL_UTF8_BYTES, 'Train source URL')
    .refine(value => {
      try {
        assertPublicHttpUrl(value)
        return true
      } catch {
        return false
      }
    }, 'url must be an absolute public HTTP or HTTPS URL')
    // TRANSFORM, not just validate: the policy STRIPS credentials rather than
    // refusing them, and a refine cannot rewrite the value — so validating
    // alone would let `https://user:pass@host/` through with the credentials
    // still attached for whatever fetches it.
    .transform(value => assertPublicHttpUrl(value).toString()),
})

export type TrainUrlUploadRequest = z.infer<typeof TrainUrlUploadRequestSchema>

export const TrainSourceFetchErrorResponseSchema = z.object({
  error: z.literal('source_fetch_failed'),
  detail: z.enum(['timeout', 'malformed_response', 'non_2xx']),
  message: z.string(),
  status: z.number().int().optional(),
})

export type TrainSourceFetchErrorResponse = z.infer<typeof TrainSourceFetchErrorResponseSchema>

export function decodeTrainInlineFileContent(file: {
  content: string
  encoding?: 'utf8' | 'base64'
}): Uint8Array {
  if ((file.encoding ?? 'utf8') === 'utf8') return new TextEncoder().encode(file.content)
  return decodeBase64(file.content)
}

export interface ScrapedUrlFrontmatter {
  url: string
  title: string
  scrapedAt: string
}

export function sanitizeUploadFilename(name: string): string {
  const normalized = normalizeDrivePath(name)
  if (!normalized.ok || normalized.relativePath.includes('/')) {
    throw new Error('upload filename must be a safe single path segment')
  }
  return normalized.relativePath
}

export function serializeScrapedUrlFrontmatter(
  frontmatter: ScrapedUrlFrontmatter,
  markdown = '',
): string {
  const header = [
    '---',
    `url: ${JSON.stringify(frontmatter.url)}`,
    `title: ${JSON.stringify(frontmatter.title)}`,
    `scrapedAt: ${JSON.stringify(frontmatter.scrapedAt)}`,
    '---',
  ].join('\n')
  return markdown.length === 0 ? `${header}\n` : `${header}\n${markdown}`
}

export function parseScrapedUrlFrontmatter(markdown: string): ScrapedUrlFrontmatter | null {
  const header = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (header === undefined) return null

  const values = new Map<string, unknown>()
  for (const line of header.split(/\r?\n/)) {
    const match = line.match(/^(url|title|scrapedAt): (.*)$/)
    if (match === null || values.has(match[1]!)) return null
    try {
      values.set(match[1]!, JSON.parse(match[2]!))
    } catch {
      return null
    }
  }

  const url = values.get('url')
  const title = values.get('title')
  const scrapedAt = values.get('scrapedAt')
  if (typeof url !== 'string' || typeof title !== 'string' || typeof scrapedAt !== 'string') {
    return null
  }
  return { url, title, scrapedAt }
}

export function urlToUploadFilename(url: string): string {
  const parsed = new URL(url)
  const slug = `${parsed.hostname}${parsed.pathname}`
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  const hash = fnv1a32(parsed.href).toString(16).padStart(8, '0')
  return `url-${slug || 'page'}-${hash}.md`
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(value)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  }
  return hash
}

// atob is the one base64 decoder available in every runtime this module
// must load in (browser, Bun, Convex isolate — node:buffer is not).
function decodeBase64(input: string): Uint8Array {
  const binary = atob(input.replace(/\s/g, ''))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

export const MAX_TRAIN_RECORD_CONTENT_BYTES = 10 * 1024 * 1024
export const TRAIN_RECORD_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const TrainRecordSlugSchema = TrainIdentifierSchema.regex(TRAIN_RECORD_SLUG_PATTERN)

const TrainCorpusFileSchema = z.object({
  filename: z.string().min(1),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
})
export type TrainCorpusFile = z.infer<typeof TrainCorpusFileSchema>

export const TrainStartRequestSchema = z
  .object({
    urls: z
      .array(utf8BoundedString(MAX_TRAIN_RECORD_URL_UTF8_BYTES, 'Train source URL').min(1))
      .max(MAX_TRAIN_URLS)
      .optional(),
    files: z.array(TrainCorpusFileSchema).max(MAX_TRAIN_FILES).optional(),
    driveFiles: z.array(z.string().min(1)).max(MAX_TRAIN_FILES).optional(),
    // Retrain: install over this existing record instead of deriving a fresh
    // slug from the job id. The slug is the identity the URL, the memory file,
    // and the archive lifecycle all key on, so retraining keeps it. Refused
    // server-side when it does not resolve in the request's scope — a
    // cross-scope target would quietly create a memory in the wrong store
    // while the user believes theirs was replaced.
    targetSlug: TrainRecordSlugSchema.optional(),
  })
  .superRefine((value, context) => {
    let totalBytes = 0
    for (const [index, file] of (value.files ?? []).entries()) {
      try {
        totalBytes += decodeTrainInlineFileContent(file).byteLength
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'content'],
          message: 'invalid base64 content',
        })
        return
      }
    }
    if (totalBytes > MAX_TRAIN_INLINE_BYTES) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: `inline files exceed ${MAX_TRAIN_INLINE_BYTES} raw bytes`,
      })
    }
  })
export type TrainStartRequest = z.infer<typeof TrainStartRequestSchema>

export const TrainJobStatusSchema = z.object({
  jobId: TrainIdentifierSchema,
  workspaceId: TrainIdentifierSchema,
  // The member who started the run.
  userId: TrainIdentifierSchema,
  agentId: TrainIdentifierSchema.optional(),
  state: TrainJobStateSchema,
  phase: GatewayTrainJobPhaseSchema,
  error: TrainErrorSchema.optional(),
  sourceFailures: z.array(TrainSourceFailureSchema).max(MAX_TRAIN_URLS).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
})
export type TrainJobStatus = z.infer<typeof TrainJobStatusSchema>

export const TrainStartResponseSchema = z.object({
  jobId: z.string(),
  job: TrainJobStatusSchema,
})
export type TrainStartResponse = z.infer<typeof TrainStartResponseSchema>

export const TrainJobResponseSchema = z.object({ job: TrainJobStatusSchema })
export type TrainJobResponse = z.infer<typeof TrainJobResponseSchema>

export const TrainJobListResponseSchema = collectionPageSchema(TrainJobStatusSchema)
export type TrainJobListResponse = z.infer<typeof TrainJobListResponseSchema>

/**
 * One file the training archive kept a copy of.
 *
 * `url`/`title`/`scrapedAt` are present exactly when the archived file is a
 * scraped page — the gateway recovers them from the copy's own YAML
 * frontmatter, so a scrape identifies itself without the manifest carrying
 * anything extra.
 */
export const TrainRecordSourceSchema = z.object({
  relPath: utf8BoundedString(MAX_TRAIN_RECORD_PATH_UTF8_BYTES, 'Train source path').min(1),
  bytes: z.number().int().nonnegative(),
  url: utf8BoundedString(MAX_TRAIN_RECORD_URL_UTF8_BYTES, 'Train source URL').optional(),
  title: utf8BoundedString(MAX_TRAIN_RECORD_HEADLINE_UTF8_BYTES, 'Train source title').optional(),
  scrapedAt: utf8BoundedString(MAX_TRAIN_RECORD_DATE_UTF8_BYTES, 'Train scrape date').optional(),
})
export type TrainRecordSource = z.infer<typeof TrainRecordSourceSchema>

export const TrainRecordSummarySchema = z.object({
  slug: TrainRecordSlugSchema,
  memoryId: TrainIdentifierSchema,
  archiveId: TrainIdentifierSchema.optional(),
  store: utf8BoundedString(MAX_TRAIN_RECORD_PATH_UTF8_BYTES, 'Train store path').optional(),
  inherited: z.boolean().optional(),
  ownerAgentSlug: TrainIdentifierSchema.optional(),
  createdAt: z.union([
    utf8BoundedString(MAX_TRAIN_RECORD_DATE_UTF8_BYTES, 'Train created date'),
    z.number(),
  ]),
  observedDate: utf8BoundedString(MAX_TRAIN_RECORD_DATE_UTF8_BYTES, 'Train observed date'),
  headline: utf8BoundedString(MAX_TRAIN_RECORD_HEADLINE_UTF8_BYTES, 'Train headline').optional(),
  model: utf8BoundedString(MAX_TRAIN_RECORD_MODEL_UTF8_BYTES, 'Train model').optional(),
  sourceFolder: utf8BoundedString(
    MAX_TRAIN_RECORD_PATH_UTF8_BYTES,
    'Train source folder',
  ).optional(),
  fileCount: z.number().int().min(0).optional(),
  hasArchive: z.boolean(),
})
export type TrainRecordSummary = z.infer<typeof TrainRecordSummarySchema>

export const TrainRecordSchema = TrainRecordSummarySchema.extend({
  content: z.string(),
  // Full record only. The summary feeds the record list, and projecting
  // sources costs one file read per archived markdown file — on a list that
  // multiplies by every memory in the store, on every render. Optional
  // forever: VM gateways upgrade on their own cadence, so a record can arrive
  // from a gateway that predates the field.
  sources: z.array(TrainRecordSourceSchema).max(MAX_TRAIN_FILES).optional(),
})
export type TrainRecord = z.infer<typeof TrainRecordSchema>

// Restage takes no arguments: the memory in the path is the whole request,
// and what gets staged is whatever its archive holds.
export const TrainRestageRequestSchema = z.object({})
export type TrainRestageRequest = z.infer<typeof TrainRestageRequestSchema>

/**
 * Reloading a memory's archive into the staging inbox.
 *
 * `fellBack` names the URLs whose re-scrape failed and whose archived copy was
 * staged instead — the page tells the user those sources are as old as the
 * original training, so it is a contract fact rather than a log line.
 */
export const TrainRestageResponseSchema = z.object({
  staged: z.number().int().nonnegative(),
  rescraped: z.number().int().nonnegative(),
  fellBack: z
    .array(utf8BoundedString(MAX_TRAIN_RECORD_URL_UTF8_BYTES, 'Train fallback URL'))
    .max(MAX_TRAIN_URLS),
})
export type TrainRestageResponse = z.infer<typeof TrainRestageResponseSchema>

// Internal gateway→API mutation result. Restage already opened this exact,
// bounded archive set; carrying its URLs prevents the API from draining the
// independently paginated upload collection to rediscover them.
export const GatewayTrainRestageResponseSchema = TrainRestageResponseSchema.extend({
  urls: z
    .array(utf8BoundedString(MAX_TRAIN_RECORD_URL_UTF8_BYTES, 'Train restage URL'))
    .max(MAX_TRAIN_URLS),
})

export const TrainRecordListQuerySchema = CollectionPageQuerySchema
export const TrainRecordListResponseSchema = collectionPageSchema(TrainRecordSummarySchema)
export type TrainRecordListResponse = z.infer<typeof TrainRecordListResponseSchema>

// VM-local projection. Anchor ids are resolved to public agent slugs by the
// API and never cross its public response boundary.
export const GatewayTrainRecordSummarySchema = TrainRecordSummarySchema.extend({
  ownerScope: TrainIdentifierSchema.optional(),
})
export const GatewayTrainRecordListResponseSchema = collectionPageSchema(
  GatewayTrainRecordSummarySchema,
)
export type GatewayTrainRecordListResponse = z.infer<typeof GatewayTrainRecordListResponseSchema>

export const TrainMemoryCountsResponseSchema = z.object({
  rootCount: z.number().int().nonnegative().nullable(),
  counts: z
    .record(AppSlugSchema, z.number().int().nonnegative().nullable())
    .refine(counts => Object.keys(counts).length <= MAX_AGENTS_PER_WORKSPACE),
  trainableAgents: z.array(AppSlugSchema).max(MAX_AGENTS_PER_WORKSPACE),
})
export type TrainMemoryCountsResponse = z.infer<typeof TrainMemoryCountsResponseSchema>

export const TrainRecordResponseSchema = z.object({
  record: TrainRecordSchema,
})
export type TrainRecordResponse = z.infer<typeof TrainRecordResponseSchema>

export const TrainRecordUpdateRequestSchema = z.object({
  content: z
    .string()
    .refine(value => value.trim().length > 0, { message: 'content cannot be blank' })
    .refine(value => new TextEncoder().encode(value).byteLength <= MAX_TRAIN_RECORD_CONTENT_BYTES, {
      message: `content exceeds ${MAX_TRAIN_RECORD_CONTENT_BYTES} UTF-8 bytes`,
    }),
})

export const TrainRecordDeleteResultSchema = z.object({
  deleted: z.literal(true),
  slug: z.string(),
  memoryId: z.string(),
})
export type TrainRecordDeleteResult = z.infer<typeof TrainRecordDeleteResultSchema>

export const TrainRecordDeleteResponseSchema = TrainRecordDeleteResultSchema
export type TrainRecordDeleteResponse = z.infer<typeof TrainRecordDeleteResponseSchema>

/**
 * Every training run synthesizes on the memory model, whatever the workspace
 * pays for. Training turns trusted sources into a durable memory record, so it
 * runs on the same model the agent already uses for memory work — cheap, and
 * state of the art at that job (David, 2026-08-16).
 *
 * A family selection has no tier: the agent sends no `x-duet-tier` header, the
 * gateway attributes the call as internal, and settlement bills what the model
 * actually cost rather than a tier's flat rate. That is the intent, not a
 * side effect — there is no route to cover when the model is already chosen.
 */
export const TRAIN_SYNTHESIS_MODEL = 'luna'

export const TRAIN_CLI_CONTRACT = {
  binary: 'duet',
  argv(input: { sourceDir: string; slug: string; storeDir: string }): string[] {
    return [
      'train',
      input.sourceDir,
      '--slug',
      input.slug,
      '--store',
      input.storeDir,
      '--model',
      TRAIN_SYNTHESIS_MODEL,
    ]
  },
} as const
export const TrainJobListQuerySchema = CollectionPageQuerySchema
