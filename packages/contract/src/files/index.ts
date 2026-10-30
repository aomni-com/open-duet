import { z } from 'zod'

import { normalizeDrivePath } from '../drive/index'
import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'

export const MAX_RECURSIVE_FILE_ENTRIES = 1_000

export const MAX_RECURSIVE_FILE_BYTES = 512 * 1024 * 1024
export const STORAGE_FULL_ERROR = 'storage_full' as const
export const FILE_TOO_LARGE_ERROR = 'file_too_large' as const

const NormalizedDrivePathSchema = z.string().superRefine((path, ctx) => {
  const normalized = normalizeDrivePath(path)
  if (normalized.ok && normalized.relativePath === path) return
  ctx.addIssue({
    code: 'custom',
    message: 'Path must be a normalized drive path',
  })
})

export const FileResourceSchema = z.object({
  uri: z.url(),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
})

export const FileDownloadRequestSchema = z
  .object({
    path: NormalizedDrivePathSchema,
  })
  .strict()

/**
 * A folder, where the drive root is a legitimate answer.
 *
 * Distinct from the path schema above on purpose: a *file* path can never be
 * the root, but a folder prefix can, and the files tab lands there whenever
 * nobody has navigated into a folder.
 */
const NormalizedDriveFolderSchema = z.string().superRefine((path, ctx) => {
  const normalized = normalizeDrivePath(path, { allowRoot: true })
  if (normalized.ok && normalized.relativePath === path) return
  ctx.addIssue({
    code: 'custom',
    message: 'Path must be a normalized drive folder',
  })
})

export const FileUploadRequestSchema = z
  .object({
    pathPrefix: NormalizedDriveFolderSchema,
  })
  .strict()

// A symlink is its own entry, never its target (spec file-attribution slice
// 16): `target` is the link text verbatim, `size` is the byte length of that
// text, and `mtime` is the link's own mtime. Dangling and escaping links are
// legal, visible entries. The enum is additive — clients must treat unknown
// `type` values as opaque entries rather than failing a listing.
export const FileEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string(),
  type: z.enum(['file', 'directory', 'symlink']),
  size: z.number().int().nonnegative(),
  mtime: z.string().datetime(),
  target: z.string().optional(),
})

/**
 * `?optional=1` on a read, stat, or listing: the caller is asking after a
 * path that is allowed not to exist — an agent's `agent.json`, its skills
 * folder — and wants a missing one answered with an empty 204 rather than a
 * 404. Absent and empty stay different facts everywhere else: a 404 is what
 * tells the files tab a folder is gone, not merely empty.
 */
export const FILES_OPTIONAL_QUERY = 'optional'

const FileOptionalQueryShape = {
  [FILES_OPTIONAL_QUERY]: z
    .literal('1')
    .optional()
    .describe('Answer a missing path with an empty 204 instead of 404.'),
}

export const FileReadQuerySchema = z.object(FileOptionalQueryShape)

export const FileListQuerySchema = CollectionPageQuerySchema.extend({
  list: z.literal('1'),
  ...FileOptionalQueryShape,
}).strict()

export const FileListResponseSchema = collectionPageSchema(FileEntrySchema)

export const FileStatResponseSchema = z.object({
  entry: FileEntrySchema,
  etag: z.string().nullable(),
})

export const FileWriteResponseSchema = z.object({
  ok: z.literal(true),
  etag: z.string(),
  size: z.number().int().nonnegative(),
})

export const FileOperationRequestSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('mkdir'),
    path: z.string(),
    recursive: z.boolean().default(false),
  }),
  z.object({
    operation: z.literal('move'),
    source: z.string(),
    destination: z.string(),
    overwrite: z.boolean().default(false),
  }),
  z.object({
    operation: z.literal('copy'),
    source: z.string(),
    destination: z.string(),
    recursive: z.boolean().default(false),
    overwrite: z.boolean().default(false),
  }),
  z.object({
    operation: z.literal('delete'),
    path: z.string(),
    recursive: z.boolean().default(false),
  }),
  // Same-type upsert: replaces an existing symlink at `path` (retarget) and
  // conflicts with any other entry type — cross-type replacement is always an
  // explicit delete followed by a create, so there is no `overwrite` field.
  // `target` is stored verbatim; it never influences containment decisions.
  z.object({
    operation: z.literal('symlink'),
    path: z.string(),
    target: z
      .string()
      .min(1)
      .max(4096)
      .refine(value => !value.includes('\u0000'), { message: 'target must not contain NUL' }),
  }),
])

export const FileOperationResponseSchema = z.object({
  ok: z.literal(true),
  /**
   * How many entries the operation touched, when it counted them.
   *
   * A recursive delete does not count. Counting means walking the whole tree
   * before removing it, and the only thing that walk ever fed was this number,
   * which nothing reads. Walking to produce it is what forced a bound on how
   * big a folder you were allowed to throw away.
   */
  affectedEntries: z.number().int().positive().optional(),
})

export const FileDeleteResponseSchema = z.object({ ok: z.literal(true) })

// 409 bodies for link discipline (slice-16 docs-first review record):
// `symlink_unresolvable` — a content read through a dangling or escaping
// link; the body carries the link's verbatim `target`, never a silent
// fallback. `path_is_symlink` — a PUT, mkdir, or directory listing addressed
// at a link path, which never acts through the link.
export const FileLinkErrorSchema = z
  .discriminatedUnion('error', [
    z.object({ error: z.literal('symlink_unresolvable'), target: z.string() }),
    z.object({ error: z.literal('path_is_symlink') }),
  ])
  .describe('Symlink conflict (409)')

export const FileErrorSchema = z.union([
  FileLinkErrorSchema,
  z.object({ error: z.literal(STORAGE_FULL_ERROR) }),
])

/**
 * A write refused because the file is larger than the Drive accepts.
 *
 * `limitBytes` rides on the wire so a caller learns the limit rather than
 * shipping its own copy of it — the same shape the workspace archive already
 * uses when it refuses for size.
 */
export const FileTooLargeErrorSchema = z
  .object({
    error: z.literal(FILE_TOO_LARGE_ERROR),
    limitBytes: z.number().int().positive(),
  })
  .describe('File larger than the Drive accepts (413)')

/**
 * Only a write can be refused for size. `files.actions` is refused for space
 * alone, so it keeps `FileErrorSchema` — widening that would publish a reason
 * the actions endpoint cannot emit.
 */
export const FileWriteErrorSchema = z.union([FileErrorSchema, FileTooLargeErrorSchema])

// Hidden-entry policy shared by the gateway's public publish listing and the
// authenticated Drive's show-hidden toggle: hidden means leading dot, nothing
// else. `.env`/`.git`/`.duet-anchor` fall out of the same rule — no
// special-casing, so the two surfaces can never disagree.
export function isHiddenDriveEntry(name: string): boolean {
  return name.startsWith('.')
}

export function filterDriveEntries<Entry extends { name: string }>(
  entries: readonly Entry[],
  policy: 'exclude' | 'include',
): Entry[] {
  return policy === 'include'
    ? [...entries]
    : entries.filter(entry => !isHiddenDriveEntry(entry.name))
}

// Text-like classification shared by the gateway's public `?raw` content-type
// override (forced `text/plain` so published source never renders) and the
// web viewers' source-mode presentation. SVG is deliberately text — it can
// carry script, so publish shows its source. Media types (image, pdf,
// audio/video, office) stay out so their viewers keep the real content type.
const TEXT_LIKE_DRIVE_EXTENSIONS = new Set([
  'css',
  'csv',
  'html',
  'js',
  'json',
  'jsx',
  'md',
  'mdx',
  'py',
  'sh',
  'svg',
  'ts',
  'tsx',
  'txt',
  'yaml',
  'yml',
])

export function isTextLikeDriveFile(name: string): boolean {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? ''
  return extension !== name.toLowerCase() && TEXT_LIKE_DRIVE_EXTENSIONS.has(extension)
}

export function isTextLikeDriveResource(resource: { name: string; mimeType: string }): boolean {
  if (isTextLikeDriveFile(resource.name)) return true
  const mimeType = resource.mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType.endsWith('+json') ||
    mimeType === 'application/xml' ||
    mimeType.endsWith('+xml') ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/x-javascript'
  )
}

/**
 * What the drive serves for each extension, and the single source three
 * consumers answer to: the gateway's `content-type` header, the timeline's
 * decision to embed a link or render it as a file, and the prompt that tells
 * an agent which formats are worth linking. Those three must agree — a format
 * the timeline embeds but the drive serves as `application/octet-stream` fails
 * silently — so adding a format is one edit here rather than three in step.
 */
export const DRIVE_FILE_MIME_TYPES: Readonly<Record<string, string>> = {
  css: 'text/css; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  gif: 'image/gif',
  html: 'text/html; charset=utf-8',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json; charset=utf-8',
  m4a: 'audio/mp4',
  md: 'text/markdown; charset=utf-8',
  mdx: 'text/markdown; charset=utf-8',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
}

export const DEFAULT_DRIVE_FILE_MIME = 'application/octet-stream'

export type DriveMediaKind = 'image' | 'video' | 'audio' | 'file'

export function driveFileMimeType(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  return DRIVE_FILE_MIME_TYPES[extension] ?? DEFAULT_DRIVE_FILE_MIME
}

/**
 * The canonical Drive extension for a MIME type already owned by the shared
 * table. Aliases resolve lexically (`jpeg` over `jpg`, `yaml` over `yml`) so
 * callers never acquire their own preference list and table insertion order
 * cannot silently rename generated files.
 */
export function driveFileExtensionForMimeType(mimeType: string): string | undefined {
  const normalized = mimeType.toLowerCase().split(';', 1)[0]?.trim()
  if (normalized === undefined || normalized.length === 0) return undefined
  return Object.entries(DRIVE_FILE_MIME_TYPES)
    .filter(([, candidate]) => candidate.toLowerCase().split(';', 1)[0]?.trim() === normalized)
    .map(([extension]) => extension)
    .sort()[0]
}

/**
 * Embedding is a property of the type, not a second list of extensions: a
 * player exists for `image/*`, `video/*` and `audio/*`, and everything else —
 * PDFs and archives included — is a link.
 */
export function driveMediaKind(mime: string): DriveMediaKind {
  const [family] = mime.split('/')
  return family === 'image' || family === 'video' || family === 'audio' ? family : 'file'
}

/** The extensions that render as `kind`, sorted, for prose that lists them. */
export function inlineMediaExtensions(kind: Exclude<DriveMediaKind, 'file'>): string[] {
  return Object.entries(DRIVE_FILE_MIME_TYPES)
    .filter(([, mime]) => driveMediaKind(mime) === kind)
    .map(([extension]) => extension)
    .sort()
}

export type FileEntry = z.infer<typeof FileEntrySchema>
export type FileResource = z.infer<typeof FileResourceSchema>
export type FileDownloadRequest = z.infer<typeof FileDownloadRequestSchema>
export type FileUploadRequest = z.infer<typeof FileUploadRequestSchema>
export type FileListResponse = z.infer<typeof FileListResponseSchema>
export type FileStatResponse = z.infer<typeof FileStatResponseSchema>
export type FileWriteResponse = z.infer<typeof FileWriteResponseSchema>
export type FileOperationRequest = z.infer<typeof FileOperationRequestSchema>
export type FileOperationResponse = z.infer<typeof FileOperationResponseSchema>
