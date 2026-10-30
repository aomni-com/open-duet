import type { PaginationResult } from 'convex/server'
import { ConvexError } from 'convex/values'

import {
  AnchorListPageSchema,
  AnchorListQuerySchema,
  AnchorMoveCandidatesReportSchema,
  FILES_OPTIONAL_QUERY,
  FileDownloadRequestSchema,
  FileUploadRequestSchema,
  ReanchorResponseSchema,
  ReanchorRequestSchema,
  hashApiKey,
  scopeSetSatisfies,
  type Anchor,
  type AnchorKind,
  type Capability,
  WorkspaceMembersPageSchema,
  WorkspaceMembersQuerySchema,
  WorkspaceMemberRemovedSchema,
  WorkspaceMemberRoleRequestSchema,
  WorkspaceMemberRoleResponseSchema,
  WorkspaceAuditPageSchema,
  WorkspaceAuditQuerySchema,
  isCollectionCursorError,
  WorkspaceBillingUserRequestSchema,
  WorkspaceBillingUserResponseSchema,
  WorkspaceBillingCapRequestSchema,
  WorkspaceBillingCapResponseSchema,
  WorkspaceDefaultModelRequestSchema,
  WorkspaceDefaultModelResponseSchema,
  WorkspaceInviteCreateRequestSchema,
  WorkspaceInviteListQuerySchema,
  WorkspaceInvitePageSchema,
  WorkspaceInviteRevokedSchema,
  WorkspaceInviteSchema,
  WorkspaceCreateResultSchema,
  WorkspaceCreateRequestSchema,
  WorkspaceCreateRefusalSchema,
  type WorkspaceCreateRefusal,
  WorkspaceRenameRequestSchema,
  WorkspaceRenameResponseSchema,
  WorkspaceReprovisionResponseSchema,
  WorkspaceSuspensionRequestSchema,
  WorkspaceSuspensionResponseSchema,
} from '@repo/contract'

import { createConvexCollectionPage } from '../collection-page'
import { actorContextForAuth } from '../gateway/actor'
import {
  FILES_REQUEST_HEADERS,
  MEMORY_REQUEST_HEADERS,
  gatewayFilesUrl,
  gatewayMemoryUrl,
  type GatewayClient,
} from '../gateway/client'
import {
  fn,
  fnAction,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  requireMemberWorkspaceWithScope,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
} from '../shared'
import { pushAffectedRecipientAnchors, pushAffectedRecipientApps } from './apps-fanout'
import { isReanchorRequestError } from './reanchor-error'

const invitePages = createConvexCollectionPage('workspace-invite-list')

function workspaceRefusal(error: unknown): WorkspaceCreateRefusal | undefined {
  if (!(error instanceof ConvexError)) return undefined
  const parsed = WorkspaceCreateRefusalSchema.safeParse(error.data)
  return parsed.success ? parsed.data : undefined
}

const anchorPages = createConvexCollectionPage('anchors.list')
const auditPages = createConvexCollectionPage('workspace-audit-list')
const memberPages = createConvexCollectionPage('workspace-members-list')

export function registerWorkspaceRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
): void {
  app.post('/v1/workspaces', async c => {
    const body = WorkspaceCreateRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const auth = c.get('auth')
    try {
      const result = await runtime.convex.mutation(fn('domains/workspaces/birth:createWorkspace'), {
        internalKey: runtime.internalKey,
        actorId: auth.user.id,
        slug: body.data.slug,
        name: body.data.name,
      })
      return c.json(WorkspaceCreateResultSchema.parse(result), 202)
    } catch (error) {
      // 402 rather than 403: the caller is allowed to ask and can resolve the
      // refusal through their billing plan.
      const refusal = workspaceRefusal(error)
      if (refusal !== undefined) return c.json(refusal, 402)
      throw error
    }
  })

  app.post('/v1/ws/:workspaceSlug/reprovision', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'admin')
    if ('response' in workspace) return workspace.response
    const auth = c.get('auth')
    if (workspace.role !== 'owner') return c.json({ error: 'owner_required' }, 403)

    try {
      const result = WorkspaceReprovisionResponseSchema.parse(
        await runtime.convex.mutation(fn('domains/workspaces/lifecycle:requestReprovision'), {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          actorId: auth.user.id,
        }),
      )
      return c.json(result, result.status === 'deferred' ? 409 : 202)
    } catch (error) {
      if (
        error instanceof ConvexError &&
        typeof error.data === 'object' &&
        error.data !== null &&
        error.data.code === 'backup_in_progress'
      ) {
        return c.json({ error: 'backup_in_progress', backupId: error.data.backupId }, 409)
      }
      throw error
    }
  })

  app.put('/v1/ws/:workspaceSlug/billing-user', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'admin')
    if ('response' in workspace) return workspace.response
    const body = WorkspaceBillingUserRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await runtime.convex.mutation(fn('domains/workspaces/mutations:setBillingUser'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        newBillingUserId: body.data.userId,
      })
      const member = await runtime.convex.query(
        fnQuery('domains/workspaces/queries:getMemberByUser'),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          userId: body.data.userId,
        },
      )
      return c.json(
        WorkspaceBillingUserResponseSchema.parse({
          billingUserId: body.data.userId,
          member,
        }),
      )
    } catch (error) {
      return workspaceMutationError(c, error)
    }
  })

  app.put('/v1/ws/:workspaceSlug/billing-cap', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'admin')
    if ('response' in workspace) return workspace.response
    const body = WorkspaceBillingCapRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await runtime.convex.mutation(fn('domains/credits/internal:setMonthlyCap'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        maxMonthlySpendMicroUsd: body.data.monthlyCapMicroUsd ?? undefined,
      })
      return c.json(
        WorkspaceBillingCapResponseSchema.parse({
          monthlyCapMicroUsd: body.data.monthlyCapMicroUsd,
        }),
      )
    } catch (error) {
      return workspaceMutationError(c, error)
    }
  })

  app.put('/v1/ws/:workspaceSlug/default-model', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'admin')
    if ('response' in workspace) return workspace.response
    const body = WorkspaceDefaultModelRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await runtime.convex.mutation(fn('domains/workspaces/mutations:setDefaultModel'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        tier: body.data.tier,
      })
      return c.json(WorkspaceDefaultModelResponseSchema.parse(body.data))
    } catch (error) {
      return workspaceMutationError(c, error)
    }
  })

  app.delete('/v1/ws/:workspaceSlug/members/:userId', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'admin')
    if ('response' in workspace) return workspace.response
    const removedUserId = c.req.param('userId')
    try {
      await runtime.convex.mutation(fn('domains/workspaces/mutations:removeMember'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        userId: removedUserId,
      })
    } catch (error) {
      return workspaceMutationError(c, error)
    }
    // Membership-leave cascade (slice 19, bound by slice-20's docs review):
    // detach the removed user's sync machines from THIS workspace's mirror folder
    // + tunnel — the same per-workspace teardown as revocation, scoped to one
    // workspace. Best-effort; runs after the membership is gone so a stale
    // device can never reconnect regardless.
    const deviceIds = (await runtime.convex.query(fnQuery('domains/syncMachines/api:idsForUser'), {
      internalKey: runtime.internalKey,
      actorId: removedUserId,
    })) as string[]
    await Promise.all(
      deviceIds.map(deviceId => gatewayClient.detachMirrorDevice(workspace.slug, deviceId)),
    )
    return c.json(WorkspaceMemberRemovedSchema.parse({ removed: true }))
  })

  app.patch('/v1/ws/:workspaceSlug/members/:userId', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'admin')
    if ('response' in workspace) return workspace.response
    const body = WorkspaceMemberRoleRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await runtime.convex.mutation(fn('domains/workspaces/mutations:setMemberRole'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        userId: c.req.param('userId'),
        role: body.data.role,
      })
      const member = await runtime.convex.query(
        fnQuery('domains/workspaces/queries:getMemberByUser'),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          userId: c.req.param('userId'),
        },
      )
      return c.json(WorkspaceMemberRoleResponseSchema.parse({ member }))
    } catch (error) {
      return workspaceMutationError(c, error)
    }
  })

  app.get('/v1/ws/:workspaceSlug/members', async c => {
    const workspace = requireAuthedWorkspace(c, ['sessions', 'files:read'])
    if ('response' in workspace) return workspace.response
    const query = WorkspaceMembersQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: workspace.id,
      filters: { search: query.data.search ?? null },
      order: 'role_rank_name_email_membership_asc',
    }
    let paginationOpts
    try {
      paginationOpts = await memberPages.paginationOpts(query.data, binding)
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
    const result = (await runtime.convex.query(
      fnQuery('domains/workspaces/queries:listMembersPage'),
      {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        search: query.data.search,
        paginationOpts,
      },
    )) as { page: unknown[]; continueCursor: string; isDone: boolean }
    return c.json(WorkspaceMembersPageSchema.parse(await memberPages.response(result, binding)))
  })

  app.get('/v1/ws/:workspaceSlug/audit', async c => {
    const workspace = requireAuthedWorkspace(c, 'files:read')
    if ('response' in workspace) return workspace.response
    const query = WorkspaceAuditQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = { subject: workspace.id, filters: {}, order: 'at_desc_id_desc' }
    let paginationOpts
    try {
      paginationOpts = await auditPages.paginationOpts(query.data, binding)
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
    const result = (await runtime.convex.query(
      fnQuery('domains/workspaces/queries:listAuditEventsFromApi'),
      {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        paginationOpts,
      },
    )) as { page: unknown[]; continueCursor: string; isDone: boolean }
    return c.json(WorkspaceAuditPageSchema.parse(await auditPages.response(result, binding)))
  })

  app.post('/v1/ws/:workspaceSlug/invites', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'members')
    if ('response' in workspace) return workspace.response
    const body = WorkspaceInviteCreateRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const invite = await runtime.convex.action(
        fnAction('domains/invitations/actions:createAndSendFromApi'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          email: body.data.email,
          role: body.data.role ?? 'editor',
        },
      )
      return c.json(WorkspaceInviteSchema.parse(invite), 201)
    } catch (error) {
      return inviteMutationError(c, error)
    }
  })

  app.get('/v1/ws/:workspaceSlug/invites', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'members')
    if ('response' in workspace) return workspace.response
    const query = WorkspaceInviteListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = { subject: workspace.id, filters: {}, order: 'createdAt:desc,id:desc' }
    try {
      const result = (await runtime.convex.query(
        fnQuery('domains/invitations/queries:listFromApi'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          paginationOpts: await invitePages.paginationOpts(query.data, binding),
        },
      )) as PaginationResult<Record<string, unknown>>
      return c.json(
        WorkspaceInvitePageSchema.parse(await invitePages.response(result, binding, publicInvite)),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      return inviteMutationError(c, error)
    }
  })

  app.delete('/v1/ws/:workspaceSlug/invites/:inviteId', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'members')
    if ('response' in workspace) return workspace.response
    try {
      const result = await runtime.convex.mutation(
        fn('domains/invitations/mutations:revokeFromApi'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          inviteId: c.req.param('inviteId'),
          now: runtime.now(),
        },
      )
      return c.json(WorkspaceInviteRevokedSchema.parse(result))
    } catch (error) {
      return inviteMutationError(c, error)
    }
  })

  // The drive itself: every files request is the VM's to answer. The one thing
  // the API adds is `optional=1` on a read — a caller asking after a file that
  // is allowed not to exist (an agent's `agent.json`, its skills folder) gets
  // an empty 204 for a missing path instead of the 404 a browser would log as
  // an error. The flag never reaches the gateway, whose query parsing is
  // strict; see `GatewayClient.proxyRequest`.
  const proxyFilesRequest = async (c: ApiContext) => {
    const workspaceSlug = c.req.param('workspaceSlug')
    if (workspaceSlug === undefined) return c.json({ error: 'not_found' }, 404)
    const reading = c.req.method === 'GET' || c.req.method === 'HEAD'
    const optionalPath = reading && c.req.query(FILES_OPTIONAL_QUERY) === '1'
    return await gatewayClient.proxyRequest(c, {
      workspaceSlug,
      requiredScope: `ws:${workspaceSlug}:${reading ? 'files:read' : 'files:write'}`,
      url: gatewayFilesUrl(c.req.raw, [FILES_OPTIONAL_QUERY]),
      forwardedHeaders: FILES_REQUEST_HEADERS,
      actorContext: actorContextForAuth(c.get('auth')),
      optionalPath,
    })
  }
  app.on(['GET', 'HEAD', 'POST', 'PUT', 'DELETE'], '/v1/ws/:workspaceSlug/files', proxyFilesRequest)
  app.on(
    ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
    '/v1/ws/:workspaceSlug/files/*',
    proxyFilesRequest,
  )

  app.post('/v1/ws/:workspaceSlug/file-downloads', async c => {
    const workspace = requireAuthedWorkspace(c, 'files:read')
    if ('response' in workspace) return workspace.response
    const body = FileDownloadRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const result = await gatewayClient.createDriveFileResource(
      workspace.slug,
      body.data.path,
      actorContextForAuth(c.get('auth')),
    )
    if ('response' in result) return result.response
    return c.json(result.resource)
  })

  app.post('/v1/ws/:workspaceSlug/file-uploads', async c => {
    const workspace = requireAuthedWorkspace(c, 'files:write')
    if ('response' in workspace) return workspace.response
    const body = FileUploadRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const result = await gatewayClient.createDriveUploadGrant(
      workspace.slug,
      body.data.pathPrefix,
      actorContextForAuth(c.get('auth')),
    )
    if ('response' in result) return result.response
    return c.json(result.grant)
  })

  app.post('/v1/ws/:workspaceSlug/memories', async c => {
    const workspaceSlug = c.req.param('workspaceSlug')
    if (workspaceSlug === undefined) return c.json({ error: 'not_found' }, 404)
    return await gatewayClient.proxyRequest(c, {
      workspaceSlug,
      requiredScope: `ws:${workspaceSlug}:memory`,
      url: gatewayMemoryUrl(c.req.raw),
      forwardedHeaders: MEMORY_REQUEST_HEADERS,
    })
  })
  app.get('/v1/ws/:workspaceSlug/memories/search', async c => {
    const workspaceSlug = c.req.param('workspaceSlug')
    if (workspaceSlug === undefined) return c.json({ error: 'not_found' }, 404)
    return await gatewayClient.proxyRequest(c, {
      workspaceSlug,
      requiredScope: `ws:${workspaceSlug}:memory`,
      url: gatewayMemoryUrl(c.req.raw),
      forwardedHeaders: MEMORY_REQUEST_HEADERS,
    })
  })

  app.patch('/v1/workspaces/:workspaceSlug', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'admin')
    if ('response' in workspace) return workspace.response
    const auth = c.get('auth')
    const body = WorkspaceRenameRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await runtime.convex.mutation(fn('domains/workspaces/mutations:rename'), {
        workspaceId: workspace.id,
        slug: body.data.slug,
        name: body.data.name,
        publicUrlBreakAcknowledged: body.data.publicUrlBreakAcknowledged,
        internalKey: runtime.internalKey,
        actorId: auth.user.id,
      })
      return c.json(WorkspaceRenameResponseSchema.parse({ ok: true, breaksPublicUrls: true }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/Invalid|already taken|Requires/.test(message))
        return c.json({ error: 'invalid_request' }, 400)
      throw error
    }
  })

  app.get('/v1/ws/:workspaceSlug/admin/suspension', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'admin')
    if ('response' in workspace) return workspace.response
    const result = await runtime.convex.query(
      fnQuery('domains/workspaces/queries:suspensionState'),
      {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
      },
    )
    return c.json(WorkspaceSuspensionResponseSchema.parse(result))
  })

  app.put('/v1/ws/:workspaceSlug/admin/suspension', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'admin')
    if ('response' in workspace) return workspace.response
    const auth = c.get('auth')
    const body = WorkspaceSuspensionRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const result = await runtime.convex.mutation(fn('domains/workspaces/mutations:setSuspended'), {
      workspaceId: workspace.id,
      suspended: body.data.suspended,
      reason: body.data.reason,
      internalKey: runtime.internalKey,
      actorId: auth.user.id,
    })
    return c.json(WorkspaceSuspensionResponseSchema.parse(result))
  })

  app.get('/v1/ws/:workspaceSlug/anchors', async c => {
    const workspace = requireAuthedWorkspace(c, 'files:read')
    if ('response' in workspace) return workspace.response
    const query = AnchorListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = { subject: workspace.id, filters: {}, order: 'path_asc_id_asc' }
    let paginationOpts
    try {
      paginationOpts = await anchorPages.paginationOpts(query.data, binding)
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
    const result = (await runtime.convex.query(
      fnQuery('domains/anchors/model:listByWorkspacePage'),
      {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        paginationOpts,
      },
    )) as { page: Anchor[]; continueCursor: string; isDone: boolean }
    return c.json(AnchorListPageSchema.parse(await anchorPages.response(result, binding)))
  })

  app.post('/v1/ws/:workspaceSlug/anchors/:anchorId/reanchor', async c => {
    const workspaceSlug = c.req.param('workspaceSlug')
    const anchorId = c.req.param('anchorId')
    const body = ReanchorRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const auth = c.get('auth')
    let anchor: Anchor | null
    try {
      anchor = (await runtime.convex.query(fnQuery('domains/anchors/model:getById'), {
        internalKey: runtime.internalKey,
        anchorId,
      })) as Anchor | null
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }
    if (anchor === null) return c.json({ error: 'not_found' }, 404)
    const workspace = auth.workspaces.find(candidate => candidate.id === anchor.workspaceId)
    if (workspace === undefined || workspace.slug !== workspaceSlug)
      return c.json({ error: 'not_found' }, 404)
    const requiredScope = `ws:${workspaceSlug}:${repairCapability(anchor.kind)}`
    if (!scopeSetSatisfies(auth.scopes, requiredScope)) {
      return c.json({ error: 'insufficient_scope', scope: requiredScope }, 403)
    }
    try {
      const repaired = (await runtime.convex.mutation(fn('domains/anchors/model:reanchor'), {
        internalKey: runtime.internalKey,
        actorId: auth.user.id,
        anchorId,
        path: body.data.path,
      })) as Anchor
      await Promise.all([
        pushAffectedRecipientApps(runtime, gatewayClient, repaired),
        pushAffectedRecipientAnchors(runtime, gatewayClient, repaired),
      ])
      return c.json(ReanchorResponseSchema.parse({ anchor: repaired }))
    } catch (error) {
      if (isReanchorRequestError(error)) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      throw error
    }
  })
}

export async function applyVmAnchorMoveCandidates(
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  token: string,
  body: unknown,
): Promise<unknown | { invalid: true }> {
  const reports = Array.isArray((body as { reports?: unknown } | null)?.reports)
    ? (body as { reports: unknown[] }).reports
    : null
  if (reports === null) return { invalid: true }
  const parsed = reports.map(report => AnchorMoveCandidatesReportSchema.safeParse(report))
  if (parsed.some(result => !result.success)) return { invalid: true }
  const result = await runtime.convex.mutation(fn('domains/anchors/model:applyRename'), {
    internalKey: runtime.internalKey,
    vmTokenHash: await hashApiKey(token),
    reports: parsed.map(result => result.data),
  })
  await Promise.all([
    pushAffectedRecipientApps(runtime, gatewayClient, result),
    pushAffectedRecipientAnchors(runtime, gatewayClient, result),
  ])
  return result
}

function publicInvite(invite: Record<string, unknown>) {
  return {
    id: invite._id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
    ...(invite.revokedAt === undefined ? {} : { revokedAt: invite.revokedAt }),
    ...(invite.consumedAt === undefined ? {} : { consumedAt: invite.consumedAt }),
  }
}

function workspaceMutationError(c: ApiContext, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Requires owner access/.test(message)) return c.json({ error: 'owner_required' }, 403)
  const data = error instanceof ConvexError ? error.data : null
  if (
    data !== null &&
    typeof data === 'object' &&
    'error' in data &&
    data.error === 'owner_candidate_required'
  ) {
    return c.json({ error: 'owner_candidate_required' }, 422)
  }
  if (/Cannot (remove|demote) the billing user/.test(message)) {
    return c.json({ error: 'billing_user' }, 409)
  }
  if (/Workspace must retain at least one owner/.test(message)) {
    return c.json({ error: 'last_owner' }, 409)
  }
  if (/Workspace member not found/.test(message)) return c.json({ error: 'not_found' }, 404)
  if (/Workspace not found/.test(message)) return c.json({ error: 'not_found' }, 404)
  throw error
}

function inviteMutationError(c: ApiContext, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Requires owner access/.test(message)) return c.json({ error: 'owner_required' }, 403)
  if (/active invite already exists/.test(message)) return c.json({ error: 'invite_exists' }, 409)
  if (/Invite not found/.test(message)) return c.json({ error: 'not_found' }, 404)
  if (/Auth profile is missing an email/.test(message)) {
    return c.json({ error: 'invalid_request' }, 400)
  }
  throw error
}

function repairCapability(kind: AnchorKind): Capability {
  if (kind === 'app') return 'apps'
  if (kind === 'agent') return 'agents'
  if (kind === 'publish') return 'publish'
  return 'share'
}
