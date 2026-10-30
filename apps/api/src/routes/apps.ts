import {
  APP_ACCESS_LAUNCH_TTL_MS,
  APP_ACCESS_SESSION_TTL_MS,
  appControls,
  LaunchAppQuerySchema,
  type App,
  type AppControlsSubject,
  AppListResponseSchema,
  AppApiScopesSchema,
  AppReconciliationFailureSchema,
  AppResponseSchema,
  AppDomainSummarySchema,
  canonicalAppUrl,
  primaryAppUrl,
  canonicalAgentCwd,
  isCollectionCursorError,
  DeleteAppResponseSchema,
  DUET_APP_ACCESS_QUERY,
  ListAppsQuerySchema,
  mintAppAccessGrant,
  normalizeDrivePath,
  ReanchorRequestSchema,
  RegisterAppRequestSchema,
  SetAppDisabledRequestSchema,
  SetAppVisibilityRequestSchema,
  UpdateAppRequestSchema,
} from '@repo/contract'

import { createMaterializedCollectionPage } from '../collection-page'
import { resolveEdgeHost } from '../config'
import { type GatewayClient } from '../gateway/client'
import {
  fn,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
  type WorkspaceRef,
} from '../shared'
import { pushAffectedRecipientApps } from './apps-fanout'
import { isReanchorRequestError } from './reanchor-error'

const appPages = createMaterializedCollectionPage('apps.list')

export function registerAppsRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: { edgeSecret?: string } = {},
): void {
  app.get('/v1/ws/:workspaceSlug/apps', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    const query = ListAppsQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const normalizedPath =
      query.data.path === undefined
        ? undefined
        : normalizeDrivePath(query.data.path, { allowRoot: true })
    if (normalizedPath !== undefined && !normalizedPath.ok) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const normalizedCwd =
      query.data.cwd === undefined ? undefined : canonicalAgentCwd(query.data.cwd)
    if (query.data.cwd !== undefined && normalizedCwd === undefined) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const rows = await runtime.convex.query(fnQuery('domains/apps/model:listByWorkspace'), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      ...(query.data.id === undefined ? {} : { id: query.data.id }),
      ...(normalizedCwd === undefined ? {} : { cwd: normalizedCwd }),
      ...(normalizedPath === undefined
        ? {}
        : {
            path: normalizedPath.relativePath,
            scope: query.data.scope ?? 'subtree',
          }),
    })
    try {
      const page = await appPages.response(
        query.data,
        {
          subject: `workspace:${workspace.id}`,
          filters: {
            id: query.data.id,
            cwd: normalizedCwd,
            path: normalizedPath?.relativePath,
            scope: normalizedPath === undefined ? undefined : (query.data.scope ?? 'subtree'),
          },
          order: 'slug asc, app id asc',
        },
        (rows as unknown[]).map(row => appWire(workspace, row)),
        row => {
          const app = AppResponseSchema.shape.app.parse(row)
          return [app.slug, app.id]
        },
      )
      return c.json(
        AppListResponseSchema.parse({
          ...page,
          meta: { capabilities: { register: canRegisterApps(workspace.role) } },
        }),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
  })

  app.get('/v1/ws/:workspaceSlug/apps/:slug', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    const row = await runtime.convex.query(fnQuery('domains/apps/model:getBySlug'), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      slug: c.req.param('slug'),
    })
    if (row === null) return c.json({ error: 'not_found' }, 404)
    return c.json(AppResponseSchema.parse({ app: appWire(workspace, row) }))
  })

  app.get('/v1/ws/:workspaceSlug/apps/:slug/launch', async c => {
    c.header('x-robots-tag', 'noindex, nofollow')
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    if (options.edgeSecret === undefined || options.edgeSecret.length === 0) {
      return c.json({ error: 'app_launch_not_configured' }, 503)
    }
    const returnTarget = LaunchAppQuerySchema.safeParse(c.req.query())
    if (!returnTarget.success) return c.json({ error: 'invalid_request' }, 400)
    const slug = c.req.param('slug')
    const row = await runtime.convex.query(fnQuery('domains/apps/model:getBySlug'), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      slug,
    })
    if (row === null) return c.json({ error: 'not_found' }, 404)
    const metadata = row as Pick<App, 'id' | 'customDomain'>
    const standard = new URL(canonicalAppUrl(workspace.slug, slug, resolveEdgeHost()))
    const { host, path } = returnTarget.data
    const customBinding =
      host !== undefined && host !== standard.host
        ? metadata.customDomain?.status === 'active' && metadata.customDomain.hostname === host
          ? { hostname: host, appId: metadata.id }
          : null
        : undefined
    if (customBinding === null) return c.json({ error: 'invalid_request' }, 400)
    const admission = (await runtime.convex.query(fnQuery('domains/apps/model:resolveForEdge'), {
      internalKey: runtime.internalKey,
      workspaceSlug: workspace.slug,
      appSlug: slug,
      viewerUserId: c.get('auth').user.id,
      viewerAppId: metadata.id,
      customBinding,
    })) as { denied?: boolean; suspended?: boolean } | null
    if (admission === null) return c.json({ error: 'not_found' }, 404)
    if (admission.denied || admission.suspended) return c.json({ error: 'forbidden' }, 403)
    const now = runtime.now()
    const grant = await mintAppAccessGrant(options.edgeSecret, {
      appId: metadata.id,
      userId: c.get('auth').user.id,
      workspaceSlug: workspace.slug,
      appSlug: slug,
      launchExpiresAt: now + APP_ACCESS_LAUNCH_TTL_MS,
      expiresAt: now + APP_ACCESS_SESSION_TTL_MS,
      nonce: randomHex(16),
    })
    const target = host === undefined ? standard : new URL(path!, `https://${host}`)
    target.searchParams.delete(DUET_APP_ACCESS_QUERY)
    target.searchParams.set(DUET_APP_ACCESS_QUERY, grant)
    c.header('cache-control', 'private, no-store')
    c.header('referrer-policy', 'no-referrer')
    return c.redirect(target.toString(), 302)
  })

  app.post('/v1/ws/:workspaceSlug/apps', async c => {
    const body = RegisterAppRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    try {
      // The rollback snapshot comes from the row at the registration's PATH:
      // the requested slug may name a different app (a collision suffixes the
      // new one) or no app at all (an existing path keeps its born slug).
      const previousRows = (await runtime.convex.query(
        fnQuery('domains/apps/model:listByWorkspace'),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          path: body.data.path,
          scope: 'self',
        },
      )) as unknown[]
      const appRow = await runtime.convex.mutation(fn('domains/apps/model:registerApp'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        path: body.data.path,
        command: body.data.command,
        apiScopes: body.data.apiScopes,
        installCommand: body.data.installCommand,
        port: body.data.port,
        slug: body.data.slug,
        name: body.data.name,
        icon: body.data.icon,
      })
      const settled = await settleAppRegistrations(
        c,
        runtime,
        gatewayClient,
        workspace,
        'register',
        [{ row: appRow, previous: previousRows[0] }],
      )
      if (!settled.ok) return settled.response
      return c.json(AppResponseSchema.parse({ app: appWire(workspace, settled.rows[0]) }), 201)
    } catch (error) {
      return appMutationError(c, error)
    }
  })

  app.patch('/v1/ws/:workspaceSlug/apps/:slug', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    const rawBody = await readJson(c.req.raw)
    if (typeof rawBody === 'object' && rawBody !== null && 'slug' in rawBody) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const body = UpdateAppRequestSchema.safeParse(rawBody)
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const updatesRuntime =
      body.data.command !== undefined ||
      body.data.apiScopes !== undefined ||
      body.data.installCommand !== undefined ||
      body.data.port !== undefined
    try {
      const previous = updatesRuntime
        ? await runtime.convex.query(fnQuery('domains/apps/model:getBySlug'), {
            internalKey: runtime.internalKey,
            workspaceId: workspace.id,
            slug: c.req.param('slug'),
          })
        : undefined
      const appRow = await runtime.convex.mutation(fn('domains/apps/model:updateApp'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
        command: body.data.command,
        apiScopes: body.data.apiScopes,
        installCommand: body.data.installCommand,
        port: body.data.port,
        name: body.data.name,
        icon: body.data.icon,
      })
      if (!updatesRuntime) {
        return c.json(AppResponseSchema.parse({ app: appWire(workspace, appRow) }))
      }
      const settled = await settleAppRegistrations(c, runtime, gatewayClient, workspace, 'update', [
        { row: appRow, previous },
      ])
      if (!settled.ok) return settled.response
      return c.json(AppResponseSchema.parse({ app: appWire(workspace, settled.rows[0]) }))
    } catch (error) {
      return appMutationError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/apps/:slug/visibility', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    const body = SetAppVisibilityRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const appRow = await runtime.convex.mutation(fn('domains/apps/model:setVisibility'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
        visibility: body.data.visibility,
      })
      return c.json(AppResponseSchema.parse({ app: appWire(workspace, appRow) }))
    } catch (error) {
      return appMutationError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/apps/:slug/disabled', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    const body = SetAppDisabledRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const appRow = await runtime.convex.mutation(fn('domains/apps/model:setReplicaDisabled'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
        disabled: body.data.disabled,
        now: runtime.now(),
      })
      const settled = await settleAppRegistrations(
        c,
        runtime,
        gatewayClient,
        workspace,
        'disable',
        [{ row: appRow }],
      )
      if (!settled.ok) return settled.response
      return c.json(AppResponseSchema.parse({ app: appWire(workspace, settled.rows[0]) }))
    } catch (error) {
      return appMutationError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/apps/:slug/reanchor', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    const body = ReanchorRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const slug = c.req.param('slug')
    const existing = await runtime.convex.query(fnQuery('domains/apps/model:getBySlug'), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      slug,
    })
    if (existing === null) return c.json({ error: 'not_found' }, 404)
    const anchorId = appRowAnchorId(existing)
    if (anchorId === undefined) throw new Error('App row is missing its anchor id')
    try {
      const repaired = await runtime.convex.mutation(fn('domains/anchors/model:reanchor'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        anchorId,
        path: body.data.path,
      })
      await pushAffectedRecipientApps(runtime, gatewayClient, repaired)
      const appRow = await runtime.convex.query(fnQuery('domains/apps/model:getBySlug'), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        slug,
      })
      if (appRow === null) throw new Error('Reanchored app disappeared')
      return c.json(AppResponseSchema.parse({ app: appWire(workspace, appRow) }))
    } catch (error) {
      if (isReanchorRequestError(error)) return c.json({ error: 'invalid_request' }, 400)
      throw error
    }
  })

  app.delete('/v1/ws/:workspaceSlug/apps/:slug', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    if (workspace.role === 'viewer') return c.json({ error: 'forbidden' }, 403)
    const slug = c.req.param('slug')
    try {
      const existing = await runtime.convex.query(fnQuery('domains/apps/model:getBySlug'), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        slug,
      })
      if (isReplicaAppRow(existing)) return c.json({ error: 'forbidden' }, 403)
      const reconcile = await gatewayClient.pushAppsReconcile(
        workspace.slug,
        workspace.id,
        existing === null
          ? { requiredReadySlugs: [] }
          : { excludeSlug: slug, requiredReadySlugs: [] },
      )
      if (!reconcile.ok) {
        return c.json(
          AppReconciliationFailureSchema.parse({
            error: 'app_reconcile_failed' as const,
            operation: 'delete' as const,
            reason: await reconciliationReason(reconcile.response),
            ...(existing === null ? {} : { app: appWire(workspace, existing) }),
          }),
          502,
        )
      }
      if (existing === null) return c.json(DeleteAppResponseSchema.parse({ ok: true }))
      const result = await runtime.convex.mutation(fn('domains/apps/model:deleteApp'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        slug,
      })
      await pushAffectedRecipientApps(runtime, gatewayClient, result)
      return c.json(DeleteAppResponseSchema.parse(result))
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        const reconcile = await gatewayClient.pushAppsReconcile(workspace.slug, workspace.id, {
          requiredReadySlugs: [],
        })
        if (!reconcile.ok) return reconcile.response
        return c.json(DeleteAppResponseSchema.parse({ ok: true }))
      }
      return appMutationError(c, error)
    }
  })
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

// Every app leaves the API already carrying its public URL and what this
// caller may do to it, so no consumer re-derives either from role and row.
function appWire(workspace: Pick<WorkspaceRef, 'slug' | 'role'>, row: unknown): unknown {
  if (typeof row !== 'object' || row === null) return row
  const slug = appRowSlug(row)
  const domain = AppDomainSummarySchema.optional().parse(
    (row as Record<string, unknown>).customDomain,
  )
  return {
    ...row,
    ...(slug === undefined
      ? {}
      : {
          canonicalUrl: primaryAppUrl(workspace.slug, slug, resolveEdgeHost(), domain),
        }),
    controls: appControls(workspace.role, appControlsSubject(row)),
  }
}

function appControlsSubject(row: object): AppControlsSubject {
  const { anchorState, sourceShareId, sourceShareMode, listingSubscriptionId, disabledAt } =
    row as Record<string, unknown>
  return {
    ...(anchorState === 'active' || anchorState === 'broken' || anchorState === 'orphaned'
      ? { anchorState }
      : {}),
    ...(typeof sourceShareId === 'string' ? { sourceShareId } : {}),
    ...(sourceShareMode === 'read' || sourceShareMode === 'write' ? { sourceShareMode } : {}),
    ...(typeof listingSubscriptionId === 'string' ? { listingSubscriptionId } : {}),
    ...(typeof disabledAt === 'number' ? { disabledAt } : {}),
  }
}

function canRegisterApps(role: WorkspaceRef['role']): boolean {
  return role === 'owner' || role === 'editor'
}

export interface AppRegistrationSettlement {
  /** The app row a mutation just materialised or re-ran. */
  row: unknown
  /** The row that held this path before the mutation, when one existed — its
   * runtime is restored if the gateway refuses the new configuration. */
  previous?: unknown
}

/**
 * The one wait-and-report path for app rows entering runtime reconciliation:
 * push the workspace's app config to the gateway gated on these rows becoming
 * ready, mark them reconciled on success, and on failure restore each row's
 * previous runtime (when it had one) and answer with the
 * `app_reconcile_failed` wire shape. Every route that flips rows to
 * `reconciling` — standalone register, update, replica enable, agent register
 * — settles through here; a second copy of this path is how agent-registered
 * apps once ended up never reconciled at all.
 *
 * Readiness is gated on the slug each row REPORTS, never on what a request
 * asked for: registration may answer with a different slug (an existing path
 * keeps its born slug; a taken slug gets suffixed).
 */
export async function settleAppRegistrations(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  workspace: WorkspaceRef,
  operation: 'register' | 'update' | 'disable',
  registrations: AppRegistrationSettlement[],
): Promise<{ ok: true; rows: unknown[] } | { ok: false; response: Response }> {
  if (registrations.length === 0) return { ok: true, rows: [] }
  const requiredReadySlugs = registrations
    .map(({ row }) => (appRowIsDisabled(row) ? undefined : appRowSlug(row)))
    .filter((slug): slug is string => slug !== undefined)
  const reconcile = await gatewayClient.pushAppsReconcile(workspace.slug, workspace.id, {
    requiredReadySlugs,
  })
  if (!reconcile.ok) {
    const reason = await reconciliationReason(reconcile.response)
    const failedRows: unknown[] = []
    for (const { row, previous } of registrations) {
      failedRows.push(
        await markRegistrationFailed(runtime, gatewayClient, workspace, row, previous, reason),
      )
    }
    return {
      ok: false,
      response: c.json(
        AppReconciliationFailureSchema.parse({
          error: 'app_reconcile_failed' as const,
          operation,
          reason,
          ...(failedRows[0] === undefined ? {} : { app: appWire(workspace, failedRows[0]) }),
        }),
        502,
      ),
    }
  }
  const rows: unknown[] = []
  for (const { row } of registrations) rows.push(await markReconciled(runtime, workspace, row))
  await pushAffectedRecipientApps(runtime, gatewayClient, ...registrations.map(({ row }) => row))
  return { ok: true, rows }
}

async function markRegistrationFailed(
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  workspace: WorkspaceRef,
  row: unknown,
  previous: unknown,
  reason: string,
): Promise<unknown> {
  const slug = appRowSlug(row)
  let failedRow = row
  if (slug !== undefined) {
    const snapshot = appRuntimeSnapshot(previous)
    failedRow =
      snapshot === undefined
        ? await runtime.convex.mutation(fn('domains/apps/model:setReconciliationStatus'), {
            internalKey: runtime.internalKey,
            workspaceId: workspace.id,
            slug,
            status: 'reconcile_failed',
            error: reason,
            now: runtime.now(),
          })
        : await runtime.convex.mutation(
            fn('domains/apps/model:restoreRuntimeAfterFailedReconciliation'),
            {
              internalKey: runtime.internalKey,
              workspaceId: workspace.id,
              slug,
              command: snapshot.command,
              apiScopes: snapshot.apiScopes,
              installCommand: snapshot.installCommand,
              port: snapshot.port,
              error: reason,
              now: runtime.now(),
            },
          )
  }
  await pushAffectedRecipientApps(runtime, gatewayClient, failedRow, row)
  return failedRow
}

async function markReconciled(
  runtime: ApiRouteRuntime,
  workspace: WorkspaceRef,
  row: unknown,
): Promise<unknown> {
  const slug = appRowSlug(row)
  if (slug === undefined) return row
  return await runtime.convex.mutation(fn('domains/apps/model:setReconciliationStatus'), {
    internalKey: runtime.internalKey,
    workspaceId: workspace.id,
    slug,
    status: 'reconciled',
    now: runtime.now(),
  })
}

function appRowSlug(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const slug = (row as { slug?: unknown }).slug
  return typeof slug === 'string' ? slug : undefined
}

function appRowAnchorId(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const anchorId = (row as { anchorId?: unknown }).anchorId
  return typeof anchorId === 'string' ? anchorId : undefined
}

export function appRowAnchorPath(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const anchorPath = (row as { anchorPath?: unknown }).anchorPath
  return typeof anchorPath === 'string' ? anchorPath : undefined
}

function appRowIsDisabled(row: unknown): boolean {
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof (row as { disabledAt?: unknown }).disabledAt === 'number'
  )
}

function isReplicaAppRow(row: unknown): boolean {
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof (row as { sourceShareId?: unknown }).sourceShareId === 'string'
  )
}

function appRuntimeSnapshot(
  row: unknown,
): { command: string; apiScopes: string[]; installCommand?: string; port: number } | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const { command, apiScopes, installCommand, port } = row as {
    command?: unknown
    apiScopes?: unknown
    installCommand?: unknown
    port?: unknown
  }
  const parsedApiScopes = AppApiScopesSchema.safeParse(apiScopes)
  return typeof command === 'string' &&
    parsedApiScopes.success &&
    (installCommand === undefined || typeof installCommand === 'string') &&
    typeof port === 'number'
    ? {
        command,
        apiScopes: parsedApiScopes.data,
        ...(installCommand === undefined ? {} : { installCommand }),
        port,
      }
    : undefined
}

async function reconciliationReason(response: Response): Promise<string> {
  const body = await response
    .clone()
    .json()
    .catch(() => null)
  return typeof body === 'object' && body !== null && typeof body.reason === 'string'
    ? body.reason
    : typeof body === 'object' && body !== null && typeof body.error === 'string'
      ? body.error
      : 'gateway_failed'
}

function appMutationError(c: ApiContext, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  if (/not found/i.test(message)) return c.json({ error: 'not_found' }, 404)
  if (/Requires|read-only|Only replica/i.test(message)) return c.json({ error: 'forbidden' }, 403)
  if (/Invalid|already exists|No app update/.test(message))
    return c.json({ error: 'invalid_request' }, 400)
  throw error
}
