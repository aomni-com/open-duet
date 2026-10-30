import { basename, join, relative } from 'node:path'

import { Hono, type Context } from 'hono'

import {
  DUET_PUBLISH_ANCHOR_PATH_HEADER,
  DUET_PUBLISH_FREEZE_HEADER,
  DUET_PUBLISH_KIND_HEADER,
  GatewayPublishFreezeRequestSchema,
  GatewayPublishFreezeGcRequestSchema,
  PUBLISH_SELECTORS,
  isPublishExcludedDrivePath,
  isTextLikeDriveFile,
  normalizeDrivePath,
  normalizeDriveUrlPath,
  parsePublishFreezeHeader,
  type DriveFileEvent,
  type PublishSelector,
} from '@repo/contract'

import {
  createFrozenPublishSnapshot,
  pruneFrozenPublishSnapshots,
  resolveFrozenPublishRoot,
} from '../publishes/frozen-snapshot'
import { rawUrlPathname, serveDriveGet, serveDriveZip } from './files'

const PUBLIC_RAW_TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8'

export interface PublishesRouteOptions {
  driveDir: string
  stateDir: string
  /**
   * Public publish GETs stay anonymous — no actor header ever reaches them —
   * so their reads are dropped (and counted) by the pipeline, per MAP Q1.
   */
  emitFileEvent?: (event: DriveFileEvent) => void
}

export function createPublishesRoutes(options: PublishesRouteOptions): Hono {
  const app = new Hono()

  app.get('/', c => handlePublicPublishGet(c, options))
  app.get('/*', c => handlePublicPublishGet(c, options))

  return app
}

export function createPublishesControlRoutes(
  options: Pick<PublishesRouteOptions, 'driveDir' | 'stateDir'>,
): Hono {
  const app = new Hono()
  app.post('/freeze', async c => {
    const parsed = GatewayPublishFreezeRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await createFrozenPublishSnapshot({
        ...parsed.data,
        driveDir: options.driveDir,
        stateDir: options.stateDir,
      })
      return c.json({ ok: true as const })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message === 'recursive_limit_exceeded' ? 409 : 502
      return c.json({ error: message }, status)
    }
  })
  app.post('/freeze/gc', async c => {
    const parsed = GatewayPublishFreezeGcRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    await pruneFrozenPublishSnapshots({ ...parsed.data, stateDir: options.stateDir })
    return c.json({ ok: true as const })
  })
  return app
}

async function handlePublicPublishGet(
  c: Context,
  options: PublishesRouteOptions,
): Promise<Response> {
  const anchorPath = c.req.header(DUET_PUBLISH_ANCHOR_PATH_HEADER)
  const kind = c.req.header(DUET_PUBLISH_KIND_HEADER)
  if (anchorPath === undefined || (kind !== 'file' && kind !== 'folder'))
    return c.json({ error: 'not_found' }, 404)
  // Containment and the serving floor are resolved before the selector, so a
  // traversal or floor probe (.env*, .git, node_modules, .duet-anchor) is a
  // 404 whatever selector rides with it. Ordinary dotfiles serve: hiding them
  // is the viewer's presentation default, not a serving policy.
  const anchor = normalizeDrivePath(anchorPath)
  if (!anchor.ok || isPublishExcludedDrivePath(anchor.relativePath))
    return c.json({ error: 'not_found' }, 404)
  const nestedPath = publicPublishNestedPath(c.req.raw.url)
  const nested = normalizeDriveUrlPath(nestedPath, { allowRoot: true })
  if (!nested.ok || isPublishExcludedDrivePath(nested.relativePath))
    return c.json({ error: 'not_found' }, 404)
  if (kind === 'file' && nested.relativePath !== '') return c.json({ error: 'not_found' }, 404)

  let servingDriveDir = options.driveDir
  const freezeHeader = c.req.header(DUET_PUBLISH_FREEZE_HEADER)
  if (freezeHeader !== undefined) {
    const freeze = parsePublishFreezeHeader(freezeHeader)
    if (freeze === null) return c.json({ error: 'publish_snapshot_unavailable' }, 503)
    const snapshotRoot = await resolveFrozenPublishRoot({
      stateDir: options.stateDir,
      publishId: freeze.publishId,
      generation: freeze.generation,
      anchorPath: anchor.relativePath,
      kind,
    })
    if (snapshotRoot === null) return c.json({ error: 'publish_snapshot_unavailable' }, 503)
    servingDriveDir = snapshotRoot
  }

  // Exactly three anonymous read operations: `?list` (directory JSON), `?raw`
  // (file bytes), and `?zip` (the visible subtree as one archive). More than
  // one selector, or none, is a typed failure — no default request ever
  // returns published bytes, and a directory is never implicitly listed.
  const selector = publicSelector(c)
  if (selector === 'invalid') return c.json({ error: 'invalid_selector' }, 400)

  const relativePath =
    kind === 'file' ? anchor.relativePath : join(anchor.relativePath, nested.relativePath)
  if (selector === 'zip') {
    // A single-file publish has no subtree to archive — same typed refusal as
    // `?list` on a file.
    if (kind === 'file') return c.json({ error: 'not_directory' }, 409)
    return await serveDriveZip(c, {
      driveDir: servingDriveDir,
      emitFileEvent: options.emitFileEvent,
      relativePath,
      anchorRelativePath: anchor.relativePath,
      archiveName: basename(relativePath),
    })
  }
  return await serveDriveGet(c, {
    driveDir: servingDriveDir,
    emitFileEvent: options.emitFileEvent,
    relativePath,
    listDirectories: selector === 'list' ? 'always' : 'query',
    requireDirectory: selector === 'list',
    contentTypeOverride: publicRawContentType,
    listingPolicy: {
      projectPath: driveRelativePath => relative(anchor.relativePath, driveRelativePath),
    },
    publicConfinement: { anchorRelativePath: anchor.relativePath },
  })
}

// `?raw` forces text-like extensions (per the shared `isTextLikeDriveFile`,
// which includes `svg`) to `text/plain` so published source is shown, never
// rendered; media and unknown-binary types keep the mapper's detected type.
function publicRawContentType(path: string, detectedType: string): string {
  return isTextLikeDriveFile(path) ? PUBLIC_RAW_TEXT_CONTENT_TYPE : detectedType
}

// The same presence test as the contract's `classifyPublishRequest` — over the
// same shared `PUBLISH_SELECTORS` list — minus the viewer fallthrough: at the
// gateway a selector is mandatory.
function publicSelector(c: Context): PublishSelector | 'invalid' {
  const present = PUBLISH_SELECTORS.filter(name => c.req.query(name) !== undefined)
  if (present.length !== 1) return 'invalid'
  return present[0]!
}

function publicPublishNestedPath(url: string): string {
  const pathname = rawUrlPathname(url)
  if (pathname === '/public/publish') return ''
  if (pathname.startsWith('/public/publish/')) return pathname.slice('/public/publish/'.length)
  return ''
}
