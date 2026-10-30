import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'

import { Hono, type Context } from 'hono'

import {
  GatewayTrainRestageResponseSchema,
  GatewayTrainRecordListResponseSchema,
  InvalidCollectionCursorError,
  TrainRecordListQuerySchema,
  TrainRecordUpdateRequestSchema,
  TrainStartRequestSchema,
  DUET_ACTOR_CONTEXT_HEADER,
  parseActorContext,
  redactImportMemoryText,
  resolveAgentConfig,
  type DriveFileEvent,
} from '@repo/contract'

import { uploadScopeKey } from './auth/upload-scope'
import { trainScopeErrorResponse, type TrainScope } from './train/agent-scope'
import { runDuetTrain } from './train/duet-cli-runner'
import type { TrainJobLedger } from './train/job-ledger'
import {
  MemoryStoreError,
  deleteMemoryRecord,
  listArchivedSources,
  openArchivedSource,
  readScopedMemoryRecord,
  updateMemoryRecord,
} from './train/memory-store'
import {
  assembleTrainCorpus,
  emitTrainFileEvent,
  runGatewayTrainPipeline,
  TrainCorpusError,
  type TrainRunner,
} from './train/pipeline'
import {
  countIndexedTrainRecords,
  indexTrainRecord,
  listIndexedTrainRecords,
  markTrainRecordRepair,
  removeTrainRecordFromIndex,
  TrainRecordIndexError,
} from './train/record-index'
import { UploadStoreError, type UploadsStoreFactory } from './train/uploads-store'

export { runDuetTrain }
export type { TrainRunner, TrainRunnerInput, TrainRunnerResult } from './train/pipeline'

export interface TrainRoutesOptions {
  stateDir: string
  driveDir: string
  uploadsStores: UploadsStoreFactory
  resolveScope: (c: Context) => TrainScope
  listAgentScopes?: () => Array<{ key: string; scope: TrainScope }>
  runner?: TrainRunner
  modelEnv?: () => Record<string, string> | null
  ensureRunner?: () => Promise<void>
  emitFileEvent?: (event: DriveFileEvent) => void
  jobLedger: TrainJobLedger
  recordIndexesReady?: Promise<void>
  assertRecordIndexReady?: (scope: TrainScope) => void
  isStartBlocked?: () => boolean
}

export function createTrainRoutes(options: TrainRoutesOptions): Hono {
  const app = new Hono()
  app.post('/', async c => {
    await options.recordIndexesReady
    const resolved = requestScope(options, c)
    if ('response' in resolved) return resolved.response
    const { scope } = resolved
    const parsed = TrainStartRequestSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    if ((parsed.data.urls?.length ?? 0) > 0) return c.json({ error: 'invalid_request' }, 400)
    const actor = parseActorContext(c.req.header(DUET_ACTOR_CONTEXT_HEADER) ?? '')
    const creatorUserId = actor?.kind === 'web' ? actor.userId : 'api'
    const targetSlug = parsed.data.targetSlug
    if (targetSlug !== undefined) {
      // Refused rather than tolerated: a target that does not resolve here
      // would install a NEW memory in this scope while the user believes the
      // one they pressed Retrain on was replaced.
      const target = await readScopedMemoryRecord(targetSlug, scope, options.stateDir).catch(
        () => null,
      )
      if (target === null) return c.json({ error: 'not_found' }, 404)
      if (target.inherited === true) {
        return inheritedMutationResponse(target.ownerScope ?? 'an ancestor')
      }
    }
    if (options.isStartBlocked?.()) return c.json({ error: 'runner_unavailable' }, 503)
    const jobId = randomUUID()
    const anchorId = scope.uploadsScope.kind === 'agent' ? scope.uploadsScope.anchorId : undefined
    const job = options.jobLedger.start(jobId, creatorUserId, {
      ...(anchorId === undefined ? {} : { anchorId }),
      ...(targetSlug === undefined ? {} : { targetSlug }),
    })
    const onPhase = (phase: 'snapshotting' | 'training' | 'finalizing') =>
      options.jobLedger.setPhase(jobId, phase)
    onPhase('snapshotting')
    const jobDir = resolve(scope.jobsDir, encodeURIComponent(jobId))
    try {
      await mkdir(dirname(jobDir), { recursive: true, mode: 0o700 })
      await options.uploadsStores.forScope(scope.uploadsScope).snapshotMove(jobDir)
      await assembleTrainCorpus({
        jobDir,
        driveDir: options.driveDir,
        files: parsed.data.files,
        driveFiles: parsed.data.driveFiles,
      })
    } catch (error) {
      const message = safeTrainError(error)
      options.jobLedger.fail(jobId, message)
      if (error instanceof TrainCorpusError) return c.json({ error: error.code }, 400)
      if (error instanceof UploadStoreError) return c.json({ error: error.code }, error.status)
      return c.json({ error: 'train_command_failed' }, 502)
    }

    void runGatewayTrainPipeline({
      stagingDir: jobDir,
      stateDir: options.stateDir,
      recordSlug: job.recordSlug,
      runner: options.runner ?? runDuetTrain,
      ensureRunner: options.ensureRunner,
      env: options.modelEnv?.() ?? undefined,
      driveDir: options.driveDir,
      resolveTargetScope: () => options.resolveScope(c),
      actor: c.req.header(DUET_ACTOR_CONTEXT_HEADER) ?? '',
      emitFileEvent: options.emitFileEvent,
      onPhase,
      onChildPid: pid => options.jobLedger.recordChildPid(jobId, pid),
    })
      .then(() => options.jobLedger.complete(jobId))
      .catch(error => {
        const snapshot = options.jobLedger.snapshot(jobId)
        if (snapshot !== null && snapshot.phase !== 'done' && snapshot.phase !== 'failed') {
          options.jobLedger.fail(jobId, safeTrainError(error))
        }
      })
    return c.json({ jobId }, 202)
  })
  app.get('/records', async c => {
    await options.recordIndexesReady
    const resolved = requestScope(options, c)
    if ('response' in resolved) return resolved.response
    try {
      options.assertRecordIndexReady?.(resolved.scope)
      const query = TrainRecordListQuerySchema.safeParse(c.req.query())
      if (!query.success) return c.json({ error: 'invalid_request' }, 400)
      return c.json(
        GatewayTrainRecordListResponseSchema.parse(
          await listIndexedTrainRecords(resolved.scope, options.stateDir, query.data),
        ),
      )
    } catch (error) {
      if (error instanceof InvalidCollectionCursorError) return c.json({ error: error.code }, 400)
      if (error instanceof TrainRecordIndexError) return c.json({ error: error.code }, 503)
      return trainRecordError(error)
    }
  })
  const listAgentScopes = options.listAgentScopes
  if (listAgentScopes !== undefined) {
    app.get('/memory-counts', async c => {
      await options.recordIndexesReady
      const rootScope = options.resolveScope(c)
      const indexedCount = async (scope: TrainScope): Promise<number | null> => {
        try {
          options.assertRecordIndexReady?.(scope)
          return await countIndexedTrainRecords(scope, options.stateDir)
        } catch {
          return null
        }
      }
      const entries = await Promise.all(
        listAgentScopes().map(async item => {
          const [count, trainable] = await Promise.all([
            indexedCount(item.scope),
            agentScopeIsTrainable(item.scope),
          ])
          return { key: item.key, count, trainable }
        }),
      )
      return c.json({
        rootCount: await indexedCount(rootScope),
        counts: Object.fromEntries(entries.map(item => [item.key, item.count])),
        trainableAgents: entries.filter(item => item.trainable).map(item => item.key),
      })
    })
  }
  app.get('/records/:slug', async c => {
    const resolved = requestScope(options, c)
    if ('response' in resolved) return resolved.response
    try {
      const record = await readScopedMemoryRecord(
        c.req.param('slug'),
        resolved.scope,
        options.stateDir,
      )
      return c.json({ record })
    } catch (error) {
      return trainRecordError(error)
    }
  })
  app.get('/records/:slug/sources/:relPath{.+}', async c => {
    const resolved = requestScope(options, c)
    if ('response' in resolved) return resolved.response
    try {
      const record = await readScopedMemoryRecord(
        c.req.param('slug'),
        resolved.scope,
        options.stateDir,
      )
      const source = await openArchivedSource(
        options.stateDir,
        record.archiveId,
        c.req.param('relPath'),
      )
      // One refusal for every miss — absent, escaped, or never archived — so
      // the route cannot be used to probe what exists outside the archive.
      if (source === null) return c.json({ error: 'not_found' }, 404)
      const file = Bun.file(source.path)
      const headers = archivedSourceHeaders(source.relPath, source.size)
      // Truncation applies to the preview only: the header above is what says
      // the body is a prefix, and a download must never be silently clipped.
      const body =
        headers['x-duet-source-truncated'] === 'true'
          ? file.slice(0, MAX_INLINE_SOURCE_BYTES)
          : file
      return new Response(body.stream(), { headers })
    } catch (error) {
      return trainRecordError(error)
    }
  })
  app.post('/records/:slug/restage', async c => {
    const resolved = requestScope(options, c)
    if ('response' in resolved) return resolved.response
    const { scope } = resolved
    try {
      const record = await readScopedMemoryRecord(c.req.param('slug'), scope, options.stateDir)
      // An inherited record lives in an ancestor's store and cannot be
      // retrained, so refilling this inbox from it would stage a corpus the
      // user could never train into that memory.
      if (record.inherited === true) {
        return inheritedMutationResponse(record.ownerScope ?? 'an ancestor')
      }
      // Restage clears the inbox, and a running job is reading it.
      if (options.jobLedger.hasRunningJob(uploadScopeKey(scope.uploadsScope))) {
        return c.json({ error: 'train_running' }, 409)
      }
      const sources = await listArchivedSources(options.stateDir, record.archiveId)
      if (sources.length === 0) return c.json({ error: 'not_found' }, 404)
      const store = options.uploadsStores.forScope(scope.uploadsScope)
      const staged = await store.restage(
        sources.map(source => ({
          path: source.path,
          // The archive stores a relative path; the inbox is flat, so the
          // basename is the filename. Scrapes keep the name
          // `urlToUploadFilename` produced, which is what lets a re-scrape
          // land on exactly the copy it replaces.
          filename: basename(source.relPath),
          size: source.size,
        })),
      )
      // The gateway holds no Firecrawl credential, so re-scraping is the API's
      // half. Everything archived is staged; the API then replaces what it can
      // re-fetch and reports what it could not.
      return c.json(
        GatewayTrainRestageResponseSchema.parse({
          staged,
          rescraped: 0,
          fellBack: [],
          urls: sources.flatMap(source => (source.url === undefined ? [] : [source.url])),
        }),
      )
    } catch (error) {
      if (error instanceof UploadStoreError) return c.json({ error: error.code }, error.status)
      return trainRecordError(error)
    }
  })
  app.patch('/records/:slug', async c => {
    await options.recordIndexesReady
    const resolved = requestScope(options, c)
    if ('response' in resolved) return resolved.response
    try {
      const existing = await readScopedMemoryRecord(
        c.req.param('slug'),
        resolved.scope,
        options.stateDir,
      )
      if (existing.inherited === true) {
        return inheritedMutationResponse(existing.ownerScope ?? 'an ancestor')
      }
      const body = TrainRecordUpdateRequestSchema.safeParse(await readJson(c.req.raw))
      if (!body.success) return c.json({ error: 'invalid_request' }, 400)
      const repairGeneration = await markTrainRecordRepair(
        resolved.scope,
        options.stateDir,
        c.req.param('slug'),
      )
      const record = await updateMemoryRecord(
        c.req.param('slug'),
        body.data.content,
        recordStoreOptions(resolved.scope, options.stateDir),
      )
      await indexTrainRecord(resolved.scope, options.stateDir, record.slug, repairGeneration)
      emitTrainFileEvent(options.emitFileEvent, {
        kind: 'write',
        path: recordEventPath(options.driveDir, resolved.scope, record.slug),
        actor: c.req.header(DUET_ACTOR_CONTEXT_HEADER) ?? '',
        at: Date.now(),
      })
      return c.json({ record })
    } catch (error) {
      return trainRecordError(error)
    }
  })
  app.delete('/records/:slug', async c => {
    await options.recordIndexesReady
    const resolved = requestScope(options, c)
    if ('response' in resolved) return resolved.response
    try {
      const existing = await readScopedMemoryRecord(
        c.req.param('slug'),
        resolved.scope,
        options.stateDir,
      )
      if (existing.inherited === true) {
        return inheritedMutationResponse(existing.ownerScope ?? 'an ancestor')
      }
      const repairGeneration = await markTrainRecordRepair(
        resolved.scope,
        options.stateDir,
        c.req.param('slug'),
      )
      const deleted = await deleteMemoryRecord(
        c.req.param('slug'),
        recordStoreOptions(resolved.scope, options.stateDir),
      )
      await removeTrainRecordFromIndex(
        resolved.scope,
        options.stateDir,
        deleted.slug,
        repairGeneration,
      )
      emitTrainFileEvent(options.emitFileEvent, {
        kind: 'delete',
        entryKind: 'file',
        path: recordEventPath(options.driveDir, resolved.scope, deleted.slug),
        actor: c.req.header(DUET_ACTOR_CONTEXT_HEADER) ?? '',
        at: Date.now(),
      })
      return c.json(deleted)
    } catch (error) {
      return trainRecordError(error)
    }
  })
  app.get('/jobs', c => {
    const resolved = requestScope(options, c)
    if ('response' in resolved) return resolved.response
    return c.json({ jobs: options.jobLedger.snapshots(resolved.scope.key) })
  })
  app.get('/jobs/:jobId', c => {
    const resolved = requestScope(options, c)
    if ('response' in resolved) return resolved.response
    const job = options.jobLedger.snapshot(c.req.param('jobId'), resolved.scope.key)
    return job === null ? c.json({ error: 'not_found' }, 404) : c.json({ job })
  })
  return app
}

async function agentScopeIsTrainable(scope: TrainScope): Promise<boolean> {
  const source = await readFile(resolve(scope.agentRoot, 'agent.json'), 'utf8').catch(
    () => undefined,
  )
  return resolveAgentConfig(source).trainable
}

function recordStoreOptions(scope: TrainScope, stateDir: string) {
  return {
    stateDir,
    storeDir: scope.memoriesDir,
  }
}

function requestScope(
  options: TrainRoutesOptions,
  c: Context,
): { scope: TrainScope } | { response: Response } {
  try {
    return { scope: options.resolveScope(c) }
  } catch (error) {
    return { response: trainScopeErrorResponse(error) }
  }
}

function inheritedMutationResponse(ownerScope: string): Response {
  return Response.json({ error: 'inherited_record_read_only', ownerScope }, { status: 409 })
}

function recordEventPath(driveDir: string, scope: TrainScope, slug: string): string {
  return relative(driveDir, resolve(scope.memoriesDir, `${slug}.md`))
    .split(sep)
    .join('/')
}

/**
 * Types a browser can usefully render in place. Everything else downloads —
 * a PDF or a spreadsheet has no in-app viewer, and pretending otherwise means
 * building one.
 */
const PREVIEWABLE_SOURCE_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
}

/**
 * Ceiling on an inline preview. An archived source can be as large as the 1 GiB
 * inbox cap, and streaming that into a browser tab is a hang rather than a
 * feature. Downloads stay unbounded — the browser is writing to disk, not
 * painting.
 */
const MAX_INLINE_SOURCE_BYTES = 2 * 1024 * 1024

function archivedSourceHeaders(relPath: string, size: number): Record<string, string> {
  const extension = relPath.slice(relPath.lastIndexOf('.')).toLowerCase()
  const contentType = PREVIEWABLE_SOURCE_TYPES[extension]
  if (contentType === undefined) {
    return {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${encodeURIComponent(basename(relPath))}"`,
    }
  }
  return {
    'content-type': contentType,
    'content-disposition': 'inline',
    ...(size > MAX_INLINE_SOURCE_BYTES ? { 'x-duet-source-truncated': 'true' } : {}),
  }
}

function trainRecordError(error: unknown): Response {
  if (!(error instanceof MemoryStoreError)) {
    return Response.json({ error: 'train_command_failed' }, { status: 502 })
  }
  return Response.json({ error: error.code }, { status: trainRecordErrorStatus(error.code) })
}

function trainRecordErrorStatus(code: MemoryStoreError['code']): number {
  if (code === 'invalid_slug' || code === 'invalid_content') return 400
  if (code === 'not_found') return 404
  return 502
}

async function readJson(request: Request): Promise<unknown> {
  try {
    const raw = await request.text()
    return raw.trim().length === 0 ? {} : JSON.parse(raw)
  } catch {
    return null
  }
}

function safeTrainError(error: unknown): string {
  return redactImportMemoryText(error instanceof Error ? error.message : String(error)).text
}
