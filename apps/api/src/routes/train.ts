import {
  AppSlugSchema,
  GatewayTrainRestageResponseSchema,
  GatewayTrainRecordListResponseSchema,
  isCollectionCursorError,
  TrainMemoryCountsResponseSchema,
  TrainRecordListResponseSchema,
  TrainRecordListQuerySchema,
  TrainRecordResponseSchema,
  TrainJobListQuerySchema,
  TrainJobListResponseSchema,
  TrainJobResponseSchema,
  TrainRecordUpdateRequestSchema,
  TrainRestageResponseSchema,
  TrainStartRequestSchema,
  TrainStartResponseSchema,
  TrainUploadSessionRequestSchema,
  TrainUploadsListQuerySchema,
  TrainUploadsListResponseSchema,
  TrainSourceFetchErrorResponseSchema,
  TrainUrlUploadRequestSchema,
  type Agent,
} from '@repo/contract'

import { createContinuationCollectionPage, createConvexCollectionPage } from '../collection-page'
import {
  FILES_REQUEST_HEADERS,
  GatewayClient,
  TRAIN_REQUEST_HEADERS,
  gatewayAgentTrainRecordsUrl,
  gatewayAgentTrainStartUrl,
  gatewayAgentTrainUploadsUrl,
  gatewayTrainStartUrl,
  gatewayTrainMemoryCountsUrl,
  gatewayTrainRecordActionUrl,
  gatewayTrainRecordsUrl,
  gatewayTrainUploadsUrl,
  gatewayRefusalResponse,
  type GatewayResolution,
} from '../gateway/client'
import {
  fn,
  fnQuery,
  readJson,
  readResponseJson,
  requireAuthedWorkspace,
  requireWorkspaceMember,
  type ApiApp,
  type ApiContext,
  type ApiAppOptions,
  type ApiRouteRuntime,
} from '../shared'
import { scrapeTrainUrl, TrainSourceFetchError } from '../train/scraper'

const trainJobPages = createConvexCollectionPage('train.jobs.list')
const trainUploadPages = createContinuationCollectionPage('train.uploads.list')
const trainRecordPages = createContinuationCollectionPage('train.records.list')

export function registerTrainRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: Pick<ApiAppOptions, 'firecrawlKey' | 'firecrawlTimeoutMs'>,
): void {
  app.get('/v1/ws/:workspaceSlug/train/memory-counts', async c => {
    const workspace = requireAuthedWorkspace(c, 'memory')
    if ('response' in workspace) return workspace.response
    const agentAccess = requireAuthedWorkspace(c, 'agents')
    if ('response' in agentAccess) return agentAccess.response
    const [agents, response] = await Promise.all([
      runtime.convex.query(fnQuery('domains/agents/model:listByWorkspace'), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
      }) as Promise<Agent[]>,
      gatewayClient.proxyRequest(c, {
        workspaceSlug: workspace.slug,
        requiredScope: `ws:${workspace.slug}:memory`,
        url: gatewayTrainMemoryCountsUrl,
        forwardedHeaders: TRAIN_REQUEST_HEADERS,
      }),
    ])
    if (!response.ok) return response
    const gatewayCounts = TrainMemoryCountsResponseSchema.safeParse(
      await response.json().catch(() => null),
    )
    if (!gatewayCounts.success) return c.json({ error: 'gateway_failed' }, 502)
    const counts: Record<string, number | null> = {}
    const slugsByAnchorId = new Map(agents.map(agent => [agent.anchorId, agent.slug]))
    for (const agent of agents) {
      const count = gatewayCounts.data.counts[agent.anchorId]
      counts[agent.slug] = count ?? null
    }
    const trainableAgents = gatewayCounts.data.trainableAgents.flatMap(anchorId => {
      const slug = slugsByAnchorId.get(anchorId)
      return slug === undefined ? [] : [slug]
    })
    return c.json(
      TrainMemoryCountsResponseSchema.parse({
        rootCount: gatewayCounts.data.rootCount,
        counts,
        trainableAgents,
      }),
    )
  })

  registerTrainRouteFamily(app, runtime, gatewayClient, options, {
    basePath: '/v1/ws/:workspaceSlug/train',
    agentScoped: false,
  })
  registerTrainRouteFamily(app, runtime, gatewayClient, options, {
    basePath: '/v1/ws/:workspaceSlug/agents/:agentSlug/train',
    agentScoped: true,
  })
}

interface TrainRouteFamily {
  basePath: string
  agentScoped: boolean
}

type TrainTarget = Pick<Agent, 'id' | 'anchorId' | 'slug' | 'sourceShareId' | 'sourceAgentId'>

function registerTrainRouteFamily(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: Pick<ApiAppOptions, 'firecrawlKey' | 'firecrawlTimeoutMs'>,
  family: TrainRouteFamily,
): void {
  app.post(`${family.basePath}/uploads/session`, async c => {
    const workspace = requireWorkspaceMember(c)
    if ('response' in workspace) return workspace.response
    const target = await resolveTrainTarget(c, runtime, workspace.id, family)
    if ('response' in target) return target.response
    if (isReplica(target.agent)) return c.json({ error: 'forbidden' }, 403)
    const rawBody = await c.req.text()
    if (rawBody.trim().length > 0) {
      let body: unknown
      try {
        body = JSON.parse(rawBody)
      } catch {
        return c.json({ error: 'invalid_request' }, 400)
      }
      if (!TrainUploadSessionRequestSchema.safeParse(body).success) {
        return c.json({ error: 'invalid_request' }, 400)
      }
    }
    const result = await gatewayClient.createTrainUploadSession(
      workspace.slug,
      target.agent?.anchorId,
    )
    if ('response' in result) return result.response
    return c.json(result.session)
  })

  app.get(`${family.basePath}/uploads`, async c => {
    const workspace = requireAuthedWorkspace(c, 'memory')
    if ('response' in workspace) return workspace.response
    const target = await resolveTrainTarget(c, runtime, workspace.id, family)
    if ('response' in target) return target.response
    const query = TrainUploadsListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: `${workspace.id}:${target.agent?.id ?? 'root'}`,
      filters: {},
      order: 'filename_asc',
    } as const
    let upstreamQuery
    try {
      const options = await trainUploadPages.paginationOpts(query.data, binding)
      upstreamQuery = {
        ...(options.cursor === null ? {} : { cursor: options.cursor }),
        limit: options.numItems,
      }
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
    const upstream = await gatewayClient.listTrainUploadsPage(
      workspace.slug,
      upstreamQuery,
      target.agent?.anchorId,
    )
    if ('response' in upstream) return upstream.response
    const page = await trainUploadPages.response(
      {
        page: upstream.page.items,
        continueCursor: upstream.page.nextCursor ?? '',
        isDone: upstream.page.nextCursor === null,
      },
      binding,
    )
    return c.json(TrainUploadsListResponseSchema.parse({ ...page, meta: upstream.page.meta }))
  })

  app.post(`${family.basePath}/uploads/url`, async c => {
    const workspace = requireAuthedWorkspace(c, 'memory')
    if ('response' in workspace) return workspace.response
    const target = await resolveTrainTarget(c, runtime, workspace.id, family)
    if ('response' in target) return target.response
    if (isReplica(target.agent)) return c.json({ error: 'forbidden' }, 403)
    const body = TrainUrlUploadRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const gatewayProbe = await gatewayClient.probeTrainUploads(
      workspace.slug,
      target.agent?.anchorId,
    )
    if ('response' in gatewayProbe) return gatewayProbe.response
    const firecrawlKey = options.firecrawlKey ?? process.env.FIRECRAWL_API_KEY
    if (!firecrawlKey) {
      return c.json(
        TrainSourceFetchErrorResponseSchema.parse({
          error: 'source_fetch_failed',
          detail: 'malformed_response',
          message: 'Firecrawl is not configured',
        }),
        503,
      )
    }
    let artifact: Awaited<ReturnType<typeof scrapeTrainUrl>>
    try {
      artifact = await scrapeTrainUrl(body.data.url, {
        firecrawlKey,
        fetch: runtime.fetchImpl,
        now: () => new Date(runtime.now()),
        localTimeoutMs: options.firecrawlTimeoutMs,
        signal: c.req.raw.signal,
      })
    } catch (error) {
      if (!(error instanceof TrainSourceFetchError)) throw error
      return c.json(
        TrainSourceFetchErrorResponseSchema.parse({
          error: 'source_fetch_failed',
          detail: error.detail,
          message: error.message,
          ...(error.status === undefined ? {} : { status: error.status }),
        }),
        error.detail === 'timeout' ? 504 : 502,
      )
    }
    c.req.raw.signal.throwIfAborted()
    const result = await gatewayClient.putTrainUpload(
      workspace.slug,
      artifact.filename,
      artifact.markdown,
      target.agent?.anchorId,
      body.data.url,
      c.req.raw.signal,
    )
    if ('response' in result) return result.response
    return c.json(result.file, 201)
  })

  app.delete(`${family.basePath}/uploads/:filename`, async c => {
    const workspace = requireAuthedWorkspace(c, 'memory')
    if ('response' in workspace) return workspace.response
    const target = await resolveTrainTarget(c, runtime, workspace.id, family)
    if ('response' in target) return target.response
    if (isReplica(target.agent)) return c.json({ error: 'forbidden' }, 403)
    return await gatewayClient.proxyRequest(c, {
      workspaceSlug: workspace.slug,
      requiredScope: `ws:${workspace.slug}:memory`,
      url:
        target.agent === undefined
          ? gatewayTrainUploadsUrl(c.req.raw)
          : gatewayAgentTrainUploadsUrl(c.req.raw, target.agent.anchorId, c.req.param('filename')),
      forwardedHeaders: FILES_REQUEST_HEADERS,
    })
  })

  app.post(family.basePath, async c => {
    const workspace = requireAuthedWorkspace(c, 'memory')
    if ('response' in workspace) return workspace.response
    const target = await resolveTrainTarget(c, runtime, workspace.id, family)
    if ('response' in target) return target.response
    if (isReplica(target.agent)) return c.json({ error: 'forbidden' }, 403)
    const body = TrainStartRequestSchema.safeParse(await readOptionalJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const gateway = (await runtime.convex.query(
      fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
      {
        internalKey: runtime.internalKey,
        slug: workspace.slug,
      },
    )) as GatewayResolution
    // Membership already established the workspace exists, so a null
    // resolution here is a deletion race — report it as gone, and let the
    // typed refusal carry the provisioning/paused distinction.
    if (gateway === null) return c.json({ error: 'not_found' }, 404)
    if ('refusal' in gateway) return gatewayRefusalResponse(gateway)
    const scrapedFiles: Array<{ filename: string; content: string; encoding: 'utf8' }> = []
    if ((body.data.urls?.length ?? 0) > 0) {
      const firecrawlKey = options.firecrawlKey ?? process.env.FIRECRAWL_API_KEY
      if (!firecrawlKey) {
        return c.json(
          {
            error: 'source_fetch_failed',
            detail: 'malformed_response',
            message: 'Firecrawl is not configured',
          },
          503,
        )
      }
      try {
        const artifacts = await Promise.all(
          body.data.urls!.map(url =>
            scrapeTrainUrl(url, {
              firecrawlKey,
              fetch: runtime.fetchImpl,
              now: () => new Date(runtime.now()),
              localTimeoutMs: options.firecrawlTimeoutMs,
            }),
          ),
        )
        scrapedFiles.push(
          ...artifacts.map(artifact => ({
            filename: artifact.filename,
            content: artifact.markdown,
            encoding: 'utf8' as const,
          })),
        )
      } catch (error) {
        if (!(error instanceof TrainSourceFetchError)) throw error
        return c.json(
          TrainSourceFetchErrorResponseSchema.parse({
            error: 'source_fetch_failed',
            detail: error.detail,
            message: error.message,
            ...(error.status === undefined ? {} : { status: error.status }),
          }),
          error.detail === 'timeout' ? 504 : 502,
        )
      }
    }
    // Rebuilt rather than forwarded, because `urls` are scraped here and reach
    // the gateway as files. Every other field of the request has to be carried
    // across explicitly — a field left out is not refused anywhere, it simply
    // stops existing.
    const startBody = TrainStartRequestSchema.safeParse({
      ...((body.data.files?.length ?? 0) + scrapedFiles.length === 0
        ? {}
        : { files: [...(body.data.files ?? []), ...scrapedFiles] }),
      ...(body.data.driveFiles === undefined ? {} : { driveFiles: body.data.driveFiles }),
      ...(body.data.targetSlug === undefined ? {} : { targetSlug: body.data.targetSlug }),
    })
    if (!startBody.success) return c.json({ error: 'invalid_request' }, 400)
    const gatewayResponse = await gatewayClient.proxyRequest(c, {
      workspaceSlug: workspace.slug,
      requiredScope: `ws:${workspace.slug}:memory`,
      url:
        target.agent === undefined
          ? gatewayTrainStartUrl
          : gatewayAgentTrainStartUrl(target.agent.anchorId),
      forwardedHeaders: TRAIN_REQUEST_HEADERS,
      actorContext: { kind: 'web', userId: c.get('auth').user.id },
      body: JSON.stringify(startBody.data),
    })
    if (gatewayResponse.status !== 202) return gatewayResponse
    const gatewayBody = (await gatewayResponse.json().catch(() => null)) as {
      jobId?: unknown
    } | null
    if (typeof gatewayBody?.jobId !== 'string' || gatewayBody.jobId.length === 0) {
      return c.json({ error: 'gateway_failed' }, 502)
    }
    const jobId = gatewayBody.jobId
    const job = await runtime.convex.mutation(fn('domains/train/model:createJob'), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      jobId,
      userId: c.get('auth').user.id,
      ...(target.agent === undefined
        ? {}
        : { agentId: target.agent.id, agentSlug: target.agent.slug }),
      now: runtime.now(),
    })
    return c.json(TrainStartResponseSchema.parse({ jobId, job }), 202)
  })

  app.get(`${family.basePath}/jobs`, async c => {
    const workspace = requireAuthedWorkspace(c, 'memory')
    if ('response' in workspace) return workspace.response
    const target = await resolveTrainTarget(c, runtime, workspace.id, family)
    if ('response' in target) return target.response
    const query = TrainJobListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: `${workspace.id}:${target.agent?.id ?? 'root'}`,
      filters: {},
      order: 'created_at_desc_job_id_desc',
    } as const
    let paginationOpts
    try {
      paginationOpts = await trainJobPages.paginationOpts(query.data, binding)
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
    const jobs = await runtime.convex.query(fnQuery('domains/train/model:listJobs'), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      ...(target.agent === undefined ? {} : { agentId: target.agent.id }),
      paginationOpts,
    })
    return c.json(TrainJobListResponseSchema.parse(await trainJobPages.response(jobs, binding)))
  })

  app.get(`${family.basePath}/records`, async c => {
    const workspace = requireAuthedWorkspace(c, 'memory')
    if ('response' in workspace) return workspace.response
    const target = await resolveTrainTarget(c, runtime, workspace.id, family)
    if ('response' in target) return target.response
    const query = TrainRecordListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: `${workspace.id}:${target.agent?.id ?? 'root'}`,
      filters: {},
      order: 'created_at_desc_mtime_desc_slug_asc',
    } as const
    let pagination
    try {
      pagination = await trainRecordPages.paginationOpts(query.data, binding)
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
    const result = await gatewayClient.listTrainRecordsPage(
      workspace.slug,
      {
        limit: pagination.numItems,
        ...(pagination.cursor === null ? {} : { cursor: pagination.cursor }),
      },
      target.agent?.anchorId,
    )
    if ('response' in result) return result.response
    const publicPage = await trainRecordPages.response(
      {
        page: result.page.items,
        continueCursor: result.page.nextCursor ?? '',
        isDone: result.page.nextCursor === null,
      },
      binding,
    )
    if (target.agent === undefined) {
      return Response.json(TrainRecordListResponseSchema.parse(publicPage))
    }
    return await attributeInheritedOwners(
      runtime,
      workspace.id,
      Response.json(GatewayTrainRecordListResponseSchema.parse(publicPage)),
      'list',
    )
  })

  app.on(['GET', 'PATCH', 'DELETE'], `${family.basePath}/records/:slug`, async c => {
    const workspace = requireAuthedWorkspace(c, 'memory')
    if ('response' in workspace) return workspace.response
    const target = await resolveTrainTarget(c, runtime, workspace.id, family)
    if ('response' in target) return target.response
    if (c.req.method !== 'GET' && isReplica(target.agent)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    let body: string | undefined
    if (c.req.method === 'PATCH') {
      const parsed = TrainRecordUpdateRequestSchema.safeParse(await readJson(c.req.raw))
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
      body = JSON.stringify(parsed.data)
    }
    const response = await gatewayClient.proxyRequest(c, {
      workspaceSlug: workspace.slug,
      requiredScope: `ws:${workspace.slug}:memory`,
      url:
        target.agent === undefined
          ? gatewayTrainRecordsUrl(c.req.raw)
          : gatewayAgentTrainRecordsUrl(c.req.raw, target.agent.anchorId, c.req.param('slug')),
      forwardedHeaders: TRAIN_REQUEST_HEADERS,
      body,
    })
    if (response.status === 409) {
      return await translateInheritedConflict(runtime, workspace.id, response)
    }
    return target.agent === undefined || c.req.method === 'DELETE'
      ? response
      : await attributeInheritedOwners(runtime, workspace.id, response, 'record')
  })

  app.get(`${family.basePath}/records/:slug/sources/:relPath{.+}`, async c => {
    const workspace = requireAuthedWorkspace(c, 'memory')
    if ('response' in workspace) return workspace.response
    const target = await resolveTrainTarget(c, runtime, workspace.id, family)
    if ('response' in target) return target.response
    return await gatewayClient.proxyRequest(c, {
      workspaceSlug: workspace.slug,
      requiredScope: `ws:${workspace.slug}:memory`,
      url: gatewayTrainRecordActionUrl(target.agent?.anchorId, c.req.param('slug'), {
        kind: 'source',
        relPath: c.req.param('relPath'),
      }),
      forwardedHeaders: TRAIN_REQUEST_HEADERS,
    })
  })

  app.post(`${family.basePath}/records/:slug/restage`, async c => {
    const workspace = requireAuthedWorkspace(c, 'memory')
    if ('response' in workspace) return workspace.response
    const target = await resolveTrainTarget(c, runtime, workspace.id, family)
    if ('response' in target) return target.response
    if (isReplica(target.agent)) return c.json({ error: 'forbidden' }, 403)

    // The gateway makes the archive the inbox — every file, scrapes included,
    // as their archived copies.
    const staged = await gatewayClient.proxyRequest(c, {
      workspaceSlug: workspace.slug,
      requiredScope: `ws:${workspace.slug}:memory`,
      url: gatewayTrainRecordActionUrl(target.agent?.anchorId, c.req.param('slug'), {
        kind: 'restage',
      }),
      forwardedHeaders: TRAIN_REQUEST_HEADERS,
      body: '{}',
    })
    if (!staged.ok) return staged
    const restaged = GatewayTrainRestageResponseSchema.safeParse(await readResponseJson(staged))
    if (!restaged.success) return c.json({ error: 'gateway_failed' }, 502)

    // Then refresh what can be refreshed. Retraining a scraped page is almost
    // always motivated by the page having changed, so replaying a months-old
    // snapshot would produce the same stale memory with no sign anything was
    // skipped.
    const urls = restaged.data.urls
    const firecrawlKey = options.firecrawlKey ?? process.env.FIRECRAWL_API_KEY
    const outcomes = await Promise.all(
      urls.map(url =>
        rescrapeStagedUrl(url, {
          workspaceSlug: workspace.slug,
          anchorId: target.agent?.anchorId,
          firecrawlKey,
          gatewayClient,
          runtime,
          options,
          signal: c.req.raw.signal,
        }),
      ),
    )
    return c.json(
      TrainRestageResponseSchema.parse({
        staged: restaged.data.staged,
        rescraped: outcomes.filter(outcome => outcome.rescraped).length,
        fellBack: outcomes.filter(outcome => !outcome.rescraped).map(outcome => outcome.url),
      }),
    )
  })

  app.get(`${family.basePath}/:jobId`, async c => {
    const workspace = requireAuthedWorkspace(c, 'memory')
    if ('response' in workspace) return workspace.response
    const target = await resolveTrainTarget(c, runtime, workspace.id, family)
    if ('response' in target) return target.response
    const job = await runtime.convex.query(fnQuery('domains/train/model:getJob'), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      jobId: c.req.param('jobId'),
      ...(target.agent === undefined ? {} : { agentId: target.agent.id }),
    })
    if (job === null) return c.json({ error: 'not_found' }, 404)
    return c.json(TrainJobResponseSchema.parse({ job }))
  })
}

async function resolveTrainTarget(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  workspaceId: string,
  family: TrainRouteFamily,
): Promise<{ agent?: TrainTarget } | { response: Response }> {
  if (!family.agentScoped) return {}
  const slug = AppSlugSchema.safeParse(c.req.param('agentSlug'))
  if (!slug.success) return { response: c.json({ error: 'not_found' }, 404) }
  const agent = (await runtime.convex.query(fnQuery('domains/agents/model:getBySlug'), {
    internalKey: runtime.internalKey,
    workspaceId,
    slug: slug.data,
  })) as TrainTarget | null
  return agent === null ? { response: c.json({ error: 'not_found' }, 404) } : { agent }
}

function isReplica(agent: TrainTarget | undefined): boolean {
  return agent?.sourceShareId !== undefined || agent?.sourceAgentId !== undefined
}

async function translateInheritedConflict(
  runtime: ApiRouteRuntime,
  workspaceId: string,
  response: Response,
): Promise<Response> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown
    ownerScope?: unknown
  } | null
  if (body?.error !== 'inherited_record_read_only') {
    return Response.json(body ?? { error: 'conflict' }, { status: 409 })
  }
  // Fail closed like attributeInheritedOwners: a malformed body or an
  // unmappable non-root owner is gateway/projection skew, not a root owner.
  if (typeof body.ownerScope !== 'string') {
    return Response.json({ error: 'gateway_failed' }, { status: 502 })
  }
  let ownerAgentSlug: string | undefined
  if (body.ownerScope !== 'root') {
    const agents = (await runtime.convex.query(fnQuery('domains/agents/model:listByWorkspace'), {
      internalKey: runtime.internalKey,
      workspaceId,
    })) as Agent[]
    ownerAgentSlug = agents.find(agent => agent.anchorId === body.ownerScope)?.slug
    if (ownerAgentSlug === undefined) {
      return Response.json({ error: 'gateway_failed' }, { status: 502 })
    }
  }
  return Response.json(
    {
      error: 'inherited_record_read_only',
      ...(ownerAgentSlug === undefined ? {} : { ownerAgentSlug }),
    },
    { status: 409 },
  )
}

async function attributeInheritedOwners(
  runtime: ApiRouteRuntime,
  workspaceId: string,
  response: Response,
  shape: 'list' | 'record',
): Promise<Response> {
  if (!response.ok) return response
  const body = (await response.json().catch(() => null)) as {
    items?: Array<Record<string, unknown>>
    nextCursor?: unknown
    record?: Record<string, unknown>
  } | null
  if (body === null) return Response.json({ error: 'gateway_failed' }, { status: 502 })
  const records = shape === 'list' ? body.items : body.record === undefined ? [] : [body.record]
  if (!Array.isArray(records)) {
    return Response.json({ error: 'gateway_failed' }, { status: 502 })
  }
  const ownerScopes = new Set(
    records.flatMap(record =>
      record.inherited === true &&
      typeof record.ownerScope === 'string' &&
      record.ownerScope !== 'root'
        ? [record.ownerScope]
        : [],
    ),
  )
  const slugByAnchor = new Map<string, string>()
  if (ownerScopes.size > 0) {
    const agents = (await runtime.convex.query(fnQuery('domains/agents/model:listByWorkspace'), {
      internalKey: runtime.internalKey,
      workspaceId,
    })) as Agent[]
    for (const agent of agents) slugByAnchor.set(agent.anchorId, agent.slug)
  }
  const attributed: Array<Record<string, unknown>> = []
  for (const record of records) {
    const ownerScope = record.ownerScope
    const publicRecord = { ...record }
    delete publicRecord.ownerScope
    delete publicRecord.ownerAgentSlug
    if (record.inherited !== true || typeof ownerScope !== 'string' || ownerScope === 'root') {
      attributed.push(publicRecord)
      continue
    }
    const ownerAgentSlug = slugByAnchor.get(ownerScope)
    if (ownerAgentSlug === undefined) {
      return Response.json({ error: 'gateway_failed' }, { status: 502 })
    }
    attributed.push({ ...publicRecord, ownerAgentSlug })
  }
  const parsed =
    shape === 'list'
      ? TrainRecordListResponseSchema.safeParse({
          items: attributed,
          nextCursor: body.nextCursor,
        })
      : TrainRecordResponseSchema.safeParse({ record: attributed[0] })
  if (!parsed.success) return Response.json({ error: 'gateway_failed' }, { status: 502 })
  return Response.json(parsed.data, { status: response.status })
}

async function readOptionalJson(request: Request): Promise<unknown> {
  try {
    const raw = await request.text()
    return raw.trim().length === 0 ? {} : JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Re-fetch one staged URL, or leave its archived copy in place.
 *
 * A failure here is deliberately not an error: the archived copy is already
 * staged, so falling back costs nothing and the memory stays retrainable. A
 * 404'd page, a Firecrawl outage, and an unconfigured key all take this path —
 * every one of them would otherwise turn "reload my sources" into "you have no
 * sources".
 *
 * `urlToUploadFilename` is a pure function of the URL, so a successful
 * re-scrape overwrites exactly the archived copy it replaces.
 */
async function rescrapeStagedUrl(
  url: string,
  context: {
    workspaceSlug: string
    anchorId: string | undefined
    firecrawlKey: string | undefined
    gatewayClient: GatewayClient
    runtime: ApiRouteRuntime
    options: Pick<ApiAppOptions, 'firecrawlTimeoutMs'>
    signal: AbortSignal
  },
): Promise<{ url: string; rescraped: boolean }> {
  if (!context.firecrawlKey) return { url, rescraped: false }
  try {
    const artifact = await scrapeTrainUrl(url, {
      firecrawlKey: context.firecrawlKey,
      fetch: context.runtime.fetchImpl,
      now: () => new Date(context.runtime.now()),
      localTimeoutMs: context.options.firecrawlTimeoutMs,
      signal: context.signal,
    })
    const result = await context.gatewayClient.putTrainUpload(
      context.workspaceSlug,
      artifact.filename,
      artifact.markdown,
      context.anchorId,
      url,
      context.signal,
    )
    return { url, rescraped: !('response' in result) }
  } catch (error) {
    if (!(error instanceof TrainSourceFetchError)) throw error
    return { url, rescraped: false }
  }
}
