import { randomUUID } from 'node:crypto'

import { ConvexError } from 'convex/values'
import { z } from 'zod'

import {
  INTERNAL_ADMIN_VM_OPERATIONS,
  InternalAdminCreateUserRequestSchema,
  InternalAdminCreateUserResultSchema,
  InternalAdminAuditListSchema,
  InternalAdminCommandSchema,
  InternalAdminCommandRequestSchema,
  InternalAdminDirectorySchema,
  InternalAdminFeedbackListSchema,
  InternalAdminFleetHealthSchema,
  InternalAdminInferenceMarginQuerySchema,
  InternalAdminInferenceMarginSchema,
  InternalAdminModelRouterPolicyRequestSchema,
  InternalAdminModelRouterPolicySchema,
  InternalAdminFileSchema,
  InternalAdminLogSchema,
  InternalAdminFreeCreditsSchema,
  InternalAdminFreeCreditsResetRequestSchema,
  InternalAdminListingTakedownRequestSchema,
  InternalAdminListingTakedownResultSchema,
  InternalAdminFeedbackMutationRequestSchema,
  InternalAdminOperationResultSchema,
  InternalAdminOfficialHubAccessSchema,
  InternalAdminOfficialHubSyncSchema,
  InternalAdminSearchResponseSchema,
  InternalAdminVmStatusSchema,
  InternalAdminVmOperationResultSchema,
  InternalAdminVmUpdatesRequestSchema,
  InternalAdminVmUpdatesSchema,
  InternalAdminWorkspaceDetailSchema,
  InternalAdminWorkspaceMutationRequestSchema,
  InternalAdminVmOperationRequestSchema,
  InternalAdminRefusalSchema,
  InternalAdminCleanupPreviewSchema,
  InternalAdminCleanupOperationSchema,
  InternalAdminCleanupStartRequestSchema,
  InternalAdminCleanupRetryRequestSchema,
  InternalAdminUserLookupQuerySchema,
  type InternalAdminCleanupPreview,
  type InternalAdminCleanupOperation,
  matchesInternalAdminEmail,
  type InternalAdminOfficialHubAccess,
  type InternalAdminRefusal,
} from '@repo/contract'
import type { ExeClient } from '@repo/exe'
import { buildOfficialSyncPlan } from '@repo/official-agents-seed'

import type { GatewayClient, GatewayConnection } from '../gateway/client'
import {
  fn,
  fnAction,
  fnQuery,
  readJson,
  readResponseJson,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
} from '../shared'
import { publicBackup, type StoredBackup } from './backups'

type AdminExe = Pick<ExeClient, 'getStatus' | 'restart'>
type AdminAccess = {
  internalKey: string
  actorId: string
  requestId: string
  reason: string
  now: number
}
type AuthorizedEffect = {
  auditId: string
  workspace: {
    id: string
    slug: string
    vmName?: string
    sshDest?: string
    httpsUrl?: string
    vmToken?: string
  }
  access: AdminAccess
}

export function registerInternalAdminRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gateway: GatewayClient,
  exe: AdminExe | null,
): void {
  app.post('/v1/internal-admin/users', async c => {
    const access = accessArgs(c, runtime, 'Create user and default workspace')
    if ('response' in access) return access.response
    const body = InternalAdminCreateUserRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const result = await runtime.convex.mutation(fn('domains/internalAdmin/model:createUser'), {
        ...access,
        ...body.data,
      })
      return c.json(InternalAdminCreateUserResultSchema.parse(result), 201)
    } catch (error) {
      return adminError(c, error)
    }
  })

  // Press it as often as you like: every call makes the hub match the deployed
  // code. There is no "already synced" answer, because the only honest one
  // would require knowing what is on the hub — which is the gateway's job, per
  // file, not this route's.
  app.post('/v1/internal-admin/official-hub/sync', async c => {
    const access = accessArgs(c, runtime, 'Sync official agents hub from the repo')
    if ('response' in access) return access.response
    try {
      // ONE plan per request. Reading the files and the registrations
      // separately would let a redeploy mid-request converge one revision's
      // bytes and then register another revision's commands.
      const plan = buildOfficialSyncPlan()
      const begun = (await runtime.convex.mutation(
        fn('domains/internalAdmin/officialHub:beginSync'),
        { ...access, ownerEmail: runtime.officialHubOwnerEmail },
      )) as { workspaceSlug: string }
      const converged = await gateway.convergeOfficialHub(begun.workspaceSlug, plan)
      // Registrations must not advance past files that failed to land.
      if (!converged.ok) return converged.response
      const completed = (await runtime.convex.mutation(
        fn('domains/internalAdmin/officialHub:completeSync'),
        { ...access, agents: plan.agents },
      )) as { workspaceSlug: string; retiredAgents: Array<{ slug: string; path: string }> }
      // The rows are gone; take the folders with them, like firing an agent
      // does. Best-effort second leg on purpose: a failure leaves an inert
      // plain folder for the next press, never rows pointing at nothing.
      for (const agent of completed.retiredAgents) {
        const removed = await gateway.deleteDriveFolder(begun.workspaceSlug, agent.path)
        if (!removed.ok) {
          console.error(
            `[internal-admin] hub sync folder delete for ${agent.path} -> ${removed.reason}`,
          )
        }
      }
      return c.json(
        InternalAdminOfficialHubSyncSchema.parse({
          ...completed,
          written: converged.written,
          deleted: converged.deleted,
        }),
      )
    } catch (error) {
      return adminError(c, error)
    }
  })

  app.post('/v1/internal-admin/official-hub/access', async c => {
    const access = accessArgs(c, runtime, 'Open official agents golden workspace')
    if ('response' in access) return access.response
    try {
      const target = (await runtime.convex.mutation(
        fn('domains/internalAdmin/officialHub:accessTarget'),
        access,
      )) as { ownerEmail: string; workspaceSlug: string }
      const ttlSeconds = 60 * 60
      const result = (await runtime.convex.mutation(
        fn('domains/apiKeys/api:mintImpersonationKey'),
        {
          internalKey: runtime.internalKey,
          email: target.ownerEmail,
          workspaceSlug: target.workspaceSlug,
          ttlSeconds,
          now: runtime.now(),
        },
      )) as InternalAdminOfficialHubAccess
      c.header(
        'set-cookie',
        `duet_session=${result.token}; Path=/; Max-Age=${ttlSeconds}; HttpOnly; Secure; SameSite=Lax`,
      )
      return c.json(InternalAdminOfficialHubAccessSchema.parse(result))
    } catch (error) {
      return adminError(c, error)
    }
  })

  app.get('/v1/internal-admin/model-router', async c => {
    const access = accessArgs(c, runtime, 'Operator model-router policy review')
    if ('response' in access) return access.response
    return await auditedRead(
      c,
      runtime,
      InternalAdminModelRouterPolicySchema,
      'domains/internalAdmin/model:modelRouterPolicy',
      access,
      {},
      () => ({ action: 'admin.model_router.read', target: 'global' }),
    )
  })

  app.post('/v1/internal-admin/model-router', async c => {
    const body = InternalAdminModelRouterPolicyRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const access = accessArgs(c, runtime, body.data.reason)
    if ('response' in access) return access.response
    return await convexJson(
      c,
      runtime,
      InternalAdminModelRouterPolicySchema,
      'domains/internalAdmin/model:setModelRouterPolicy',
      {
        ...access,
        policy: { version: 1, rules: body.data.rules, updatedAt: access.now },
      },
    )
  })

  app.get('/v1/internal-admin/search', async c => {
    const access = accessArgs(c, runtime, 'Operator workspace lookup')
    if ('response' in access) return access.response
    return await auditedRead<{ identifier: string }>(
      c,
      runtime,
      InternalAdminSearchResponseSchema,
      'domains/internalAdmin/model:search',
      access,
      { identifier: c.req.query('q') ?? '' },
      result => ({ action: 'admin.search', target: result.identifier || '(empty)' }),
    )
  })

  // User cleanup has a dedicated user-first seam. The lookup is deliberately
  // separate from the legacy workspace search above: callers get a stable
  // user id and a bounded, read-only preview before they can start anything.
  app.get('/v1/internal-admin/users', async c => {
    const query = InternalAdminUserLookupQuerySchema.safeParse({ q: c.req.query('q') ?? '' })
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const access = accessArgs(c, runtime, 'Operator user cleanup preview')
    if ('response' in access) return access.response
    return await auditedRead<InternalAdminCleanupPreview>(
      c,
      runtime,
      InternalAdminCleanupPreviewSchema,
      'domains/internalAdmin/cleanup:previewUserCleanup',
      access,
      { identifier: query.data.q },
      result => ({ action: 'admin.user.cleanup.preview', target: result.user.userId }),
    )
  })

  app.post('/v1/internal-admin/users/:userId/cleanup', async c => {
    const body = InternalAdminCleanupStartRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const access = accessArgs(c, runtime, body.data.reason)
    if ('response' in access) return access.response
    try {
      const result = InternalAdminCleanupOperationSchema.parse(
        await runtime.convex.mutation(fn('domains/internalAdmin/cleanup:startUserCleanup'), {
          ...access,
          userId: c.req.param('userId'),
        }),
      )
      return c.json(result, result.replayed === true ? 200 : 202)
    } catch (error) {
      return adminError(c, error)
    }
  })

  app.get('/v1/internal-admin/cleanup/:operationId', async c => {
    const access = accessArgs(c, runtime, 'Operator user cleanup status')
    if ('response' in access) return access.response
    return await auditedRead<InternalAdminCleanupOperation>(
      c,
      runtime,
      InternalAdminCleanupOperationSchema,
      'domains/internalAdmin/cleanup:cleanupStatus',
      access,
      { operationId: c.req.param('operationId') },
      result => ({ action: 'admin.user.cleanup.status', target: result.operationId }),
    )
  })

  app.post('/v1/internal-admin/cleanup/:operationId/retry', async c => {
    const body = InternalAdminCleanupRetryRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const access = accessArgs(c, runtime, body.data.reason)
    if ('response' in access) return access.response
    try {
      const result = InternalAdminCleanupOperationSchema.parse(
        await runtime.convex.mutation(fn('domains/internalAdmin/cleanup:retryCleanup'), {
          ...access,
          operationId: c.req.param('operationId'),
        }),
      )
      return c.json(result, 202)
    } catch (error) {
      return adminError(c, error)
    }
  })

  app.get('/v1/internal-admin/workspaces/:workspaceId', async c => {
    const access = accessArgs(c, runtime, 'Operator workspace inspection')
    if ('response' in access) return access.response
    const workspaceId = c.req.param('workspaceId')
    return await auditedRead<{ workspace: { slug: string } }>(
      c,
      runtime,
      InternalAdminWorkspaceDetailSchema,
      'domains/internalAdmin/model:workspaceDetail',
      access,
      { workspaceId, month: c.req.query('month') ?? currentMonth(runtime.now()) },
      result => ({ action: 'admin.workspace.read', target: result.workspace.slug, workspaceId }),
    )
  })

  app.get('/v1/internal-admin/audit', async c => {
    const access = accessArgs(c, runtime, 'Operator audit review')
    if ('response' in access) return access.response
    const workspaceId = c.req.query('workspaceId')
    return await auditedRead(
      c,
      runtime,
      InternalAdminAuditListSchema,
      'domains/internalAdmin/model:listAdminAudit',
      access,
      workspaceId === undefined ? {} : { workspaceId },
      () => ({
        action: 'admin.audit.list',
        target: workspaceId ?? 'global',
        ...(workspaceId === undefined ? {} : { workspaceId }),
      }),
    )
  })

  app.get('/v1/internal-admin/feedback', async c => {
    const access = accessArgs(c, runtime, 'Operator feedback triage')
    if ('response' in access) return access.response
    const archived = c.req.query('archived') === '1'
    return await auditedRead(
      c,
      runtime,
      InternalAdminFeedbackListSchema,
      'domains/internalAdmin/model:listFeedback',
      access,
      { archived },
      () => ({ action: 'admin.feedback.list', target: archived ? 'archived' : 'active' }),
    )
  })

  app.post('/v1/internal-admin/feedback/:feedbackId', async c => {
    const body = InternalAdminFeedbackMutationRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const access = accessArgs(c, runtime, body.data.reason)
    if ('response' in access) return access.response
    return await convexJson(
      c,
      runtime,
      InternalAdminOperationResultSchema,
      'domains/internalAdmin/model:mutateFeedback',
      {
        ...access,
        feedbackId: c.req.param('feedbackId'),
        ...body.data,
      },
    )
  })

  app.post('/v1/internal-admin/listings/:listingId/takedown', async c => {
    const body = InternalAdminListingTakedownRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const access = accessArgs(c, runtime, body.data.reason)
    if ('response' in access) return access.response
    return await convexJson(
      c,
      runtime,
      InternalAdminListingTakedownResultSchema,
      'domains/internalAdmin/model:takedownMarketplaceListing',
      {
        ...access,
        listingId: c.req.param('listingId'),
        confirmation: body.data.confirmation,
      },
    )
  })

  app.get('/v1/internal-admin/free-credits', async c => {
    const access = accessArgs(c, runtime, 'Operator free-credit inspection')
    if ('response' in access) return access.response
    return await auditedRead(
      c,
      runtime,
      InternalAdminFreeCreditsSchema,
      'domains/internalAdmin/model:freeCredits',
      access,
      {},
      () => ({ action: 'admin.credits.summary', target: 'unpaid-users' }),
    )
  })

  app.post('/v1/internal-admin/free-credits/reset', async c => {
    const body = InternalAdminFreeCreditsResetRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const access = accessArgs(c, runtime, body.data.reason)
    if ('response' in access) return access.response
    try {
      // An action, not a mutation: one payer per transaction, so the reset
      // never holds a fleet-wide read set open against the VM heartbeat.
      return c.json(
        InternalAdminOperationResultSchema.parse(
          await runtime.convex.action(fnAction('domains/internalAdmin/actions:resetFreeCredits'), {
            ...access,
            confirmation: body.data.confirmation,
          }),
        ),
      )
    } catch (error) {
      return adminError(c, error)
    }
  })

  app.get('/v1/internal-admin/vm-updates', async c => {
    const access = accessArgs(c, runtime, 'Operator fleet update brake inspection')
    if ('response' in access) return access.response
    return await auditedRead(
      c,
      runtime,
      InternalAdminVmUpdatesSchema,
      'domains/internalAdmin/model:vmUpdates',
      access,
      {},
      () => ({ action: 'admin.vmUpdates.read', target: 'global' }),
    )
  })

  app.get('/v1/internal-admin/fleet-health', async c => {
    const access = accessArgs(c, runtime, 'Operator fleet health review')
    if ('response' in access) return access.response
    return await auditedRead(
      c,
      runtime,
      InternalAdminFleetHealthSchema,
      'domains/internalAdmin/model:fleetHealth',
      access,
      // Request time is a query arg so age-derived health recomputes per
      // request instead of off a cached query (a query's clock is not a
      // database dependency).
      { now: runtime.now() },
      () => ({ action: 'admin.fleetHealth.read', target: 'global' }),
    )
  })

  app.get('/v1/internal-admin/inference-margin', async c => {
    const query = InternalAdminInferenceMarginQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const { granularity, through } = query.data
    const access = accessArgs(c, runtime, 'Operator inference margin review')
    if ('response' in access) return access.response
    return await auditedRead(
      c,
      runtime,
      InternalAdminInferenceMarginSchema,
      'domains/internalAdmin/model:inferenceMargin',
      access,
      // Request time caps the window; as an argument it also keys the cache.
      {
        granularity,
        now: runtime.now(),
        ...(through === undefined ? {} : { through: Number(through) }),
      },
      () => ({ action: 'admin.inferenceMargin.read', target: granularity }),
    )
  })

  app.post('/v1/internal-admin/vm-updates', async c => {
    const body = InternalAdminVmUpdatesRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const access = accessArgs(c, runtime, body.data.reason)
    if ('response' in access) return access.response
    return await convexJson(
      c,
      runtime,
      InternalAdminOperationResultSchema,
      'domains/internalAdmin/model:setVmUpdates',
      { ...access, paused: body.data.paused },
    )
  })

  app.post('/v1/internal-admin/workspaces/:workspaceId', async c => {
    const body = InternalAdminWorkspaceMutationRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const access = accessArgs(c, runtime, body.data.reason)
    if ('response' in access) return access.response
    return await convexJson(
      c,
      runtime,
      InternalAdminOperationResultSchema,
      'domains/internalAdmin/model:mutateWorkspace',
      {
        ...access,
        workspaceId: c.req.param('workspaceId'),
        ...body.data,
      },
    )
  })

  app.get('/v1/internal-admin/workspaces/:workspaceId/vm', async c => {
    const authorized = await authorizeEffect(
      c,
      runtime,
      'admin.vm.status',
      'vm/status',
      'Operator VM inspection',
    )
    if ('response' in authorized) return authorized.response
    const { workspace, auditId } = authorized
    try {
      const controlStatus =
        workspace.vmName === undefined || exe === null
          ? null
          : await exe.getStatus(workspace.vmName)
      let gatewayStatus: Record<string, unknown> | undefined
      let gatewayProbeSucceeded = true
      if (workspace.httpsUrl !== undefined) {
        const response = await gateway.internalAdminRequest(
          adminGatewayConnection(workspace),
          '/status',
        )
        const data = await readResponseJson(response)
        gatewayProbeSucceeded = response.ok && typeof data === 'object' && data !== null
        gatewayStatus = gatewayProbeSucceeded
          ? { reachable: true, ...(data as object) }
          : { reachable: false, error: 'gateway_unreachable' }
      }
      await finalizeEffect(
        runtime,
        authorized,
        gatewayProbeSucceeded,
        gatewayProbeSucceeded ? undefined : 'gateway_unreachable',
      )
      return c.json(
        InternalAdminVmStatusSchema.parse({
          workspaceId: workspace.id,
          vmName: workspace.vmName,
          controlStatus,
          gateway: gatewayStatus,
          auditId,
        }),
      )
    } catch (error) {
      await finalizeEffect(runtime, authorized, false, error)
      return c.json({ error: 'upstream_failed' }, 502)
    }
  })

  app.get('/v1/internal-admin/workspaces/:workspaceId/vm/backups/:backupId', async c => {
    const access = accessArgs(c, runtime, 'Inspect VM lifecycle backup')
    if ('response' in access) return access.response
    try {
      const backup = (await runtime.convex.query(
        fnQuery('domains/internalAdmin/model:workspaceBackup'),
        {
          internalKey: access.internalKey,
          actorId: access.actorId,
          workspaceId: c.req.param('workspaceId'),
          backupId: c.req.param('backupId'),
        },
      )) as StoredBackup
      await runtime.convex.mutation(fn('domains/internalAdmin/model:recordAudit'), {
        ...access,
        action: 'admin.vm.backup.inspect',
        target: backup._id,
        workspaceId: backup.workspaceId,
      })
      return c.json({ backup: publicBackup(backup) })
    } catch (error) {
      return adminError(c, error)
    }
  })

  app.post('/v1/internal-admin/workspaces/:workspaceId/vm/:operation', async c => {
    const operation = z.enum(INTERNAL_ADMIN_VM_OPERATIONS).safeParse(c.req.param('operation'))
    const body = InternalAdminVmOperationRequestSchema.safeParse(await readJson(c.req.raw))
    if (!operation.success || !body.success) return c.json({ error: 'invalid_request' }, 400)
    const authorized = await authorizeEffect(
      c,
      runtime,
      `admin.vm.${operation.data}`,
      `vm/${operation.data}`,
      body.data.reason,
    )
    if ('response' in authorized) return authorized.response
    if (body.data.confirmation !== authorized.workspace.slug) {
      await finalizeEffect(runtime, authorized, false, 'confirmation_mismatch')
      return c.json({ error: 'confirmation_mismatch' }, 409)
    }
    try {
      if (operation.data === 'reboot') {
        if (authorized.workspace.vmName === undefined || exe === null) {
          await finalizeEffect(runtime, authorized, false, 'vm_unavailable')
          return c.json({ error: 'vm_unavailable' }, 409)
        }
        await exe.restart(authorized.workspace.vmName)
      } else if (operation.data === 'reprovision' || operation.data === 'archive') {
        // Operator authority and provenance are on the admin audit rail. The
        // lifecycle actorId argument would instead require workspace ownership.
        const admitted = await runtime.convex.mutation(
          fn(
            `domains/workspaces/lifecycle:${operation.data === 'archive' ? 'requestArchive' : 'requestReprovision'}`,
          ),
          {
            internalKey: runtime.internalKey,
            workspaceId: authorized.workspace.id,
            now: runtime.now(),
          },
        )
        const result = InternalAdminVmOperationResultSchema.parse({
          ...admitted,
          ok: true,
          auditId: authorized.auditId,
        })
        if (result.status === 'deferred') {
          await finalizeEffect(runtime, authorized, false, result.reason)
          return c.json(result)
        }
        await finalizeEffect(
          runtime,
          authorized,
          true,
          result.status === 'backup_pending' ? `backup_pending:${result.backupId}` : result.status,
          'accepted',
        )
        return c.json(result, 202)
      } else if (operation.data === 'chrome-update') {
        const response = await gateway.internalAdminRequest(
          adminGatewayConnection(authorized.workspace),
          '/chrome-update',
          { method: 'POST' },
        )
        const data = await readResponseJson(response)
        if (!response.ok) {
          await finalizeEffect(runtime, authorized, false, `gateway_http_${response.status}`)
          return c.json(
            typeof data === 'object' && data !== null ? data : { error: 'upstream_failed' },
            response.status as 400,
          )
        }
        if (typeof data !== 'object' || data === null || !('ok' in data) || data.ok !== true) {
          throw new Error('invalid_chrome_update_response')
        }
      } else {
        await runtime.convex.mutation(fn('domains/workspaces/provisioning:markAdminArchived'), {
          internalKey: runtime.internalKey,
          workspaceId: authorized.workspace.id,
          now: runtime.now(),
        })
      }
      await finalizeEffect(runtime, authorized, true)
      return c.json(
        InternalAdminVmOperationResultSchema.parse({
          ok: true,
          status: 'completed',
          auditId: authorized.auditId,
        }),
      )
    } catch (error) {
      await finalizeEffect(runtime, authorized, false, error)
      if (
        error instanceof ConvexError &&
        typeof error.data === 'object' &&
        error.data !== null &&
        'code' in error.data &&
        error.data.code === 'backup_in_progress'
      ) {
        return c.json({ error: 'backup_in_progress' }, 409)
      }
      return c.json({ error: 'upstream_failed' }, 502)
    }
  })

  app.get('/v1/internal-admin/workspaces/:workspaceId/files', async c => {
    return await proxyGatewayRead(
      c,
      runtime,
      gateway,
      '/files',
      `files:${c.req.query('path') ?? ''}`,
      'Operator filesystem browse',
      InternalAdminDirectorySchema,
      'admin.files.list',
    )
  })
  app.get('/v1/internal-admin/workspaces/:workspaceId/file', async c => {
    return await proxyGatewayRead(
      c,
      runtime,
      gateway,
      '/file',
      `file:${c.req.query('path') ?? ''}`,
      'Operator filesystem read',
      InternalAdminFileSchema,
      'admin.file.read',
    )
  })
  // Reads gateway and per-agent logs, which `/file` cannot: it is contained to
  // the drive and every log lives under the state dir, outside it.
  app.get('/v1/internal-admin/workspaces/:workspaceId/logs', async c => {
    const source = c.req.query('source') ?? 'gateway'
    const anchorId = c.req.query('anchorId')
    return await proxyGatewayRead(
      c,
      runtime,
      gateway,
      '/logs',
      `logs:${source}${anchorId === undefined ? '' : `:${anchorId}`}`,
      'Operator log read',
      InternalAdminLogSchema,
      'admin.logs.read',
      { source, ...(anchorId === undefined ? {} : { anchorId }) },
    )
  })

  app.post('/v1/internal-admin/workspaces/:workspaceId/command', async c => {
    const body = InternalAdminCommandRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const authorized = await authorizeEffect(
      c,
      runtime,
      'admin.command.run',
      `command:${body.data.command}`,
      body.data.reason,
    )
    if ('response' in authorized) return authorized.response
    let response: Response
    try {
      response = await gateway.internalAdminRequest(
        adminGatewayConnection(authorized.workspace),
        '/command',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: body.data.command }),
        },
      )
    } catch (error) {
      await finalizeEffect(runtime, authorized, false, error)
      return c.json({ error: 'upstream_failed' }, 502)
    }
    const data = await readResponseJson(response)
    if (!response.ok) {
      await finalizeEffect(runtime, authorized, false, `gateway_http_${response.status}`)
      return c.json(
        typeof data === 'object' && data !== null ? data : { error: 'upstream_failed' },
        response.status as 400,
      )
    }
    try {
      const result = InternalAdminCommandSchema.parse({
        ...(data as object),
        auditId: authorized.auditId,
      })
      await finalizeEffect(runtime, authorized, true)
      return c.json(result)
    } catch (error) {
      await finalizeEffect(runtime, authorized, false, error)
      return c.json({ error: 'invalid_upstream_response' }, 502)
    }
  })
}

function accessArgs(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  reason: string,
): AdminAccess | { response: Response } {
  const auth = c.get('auth')
  if (
    (auth.credentialKind !== 'browser_session' && auth.credentialKind !== 'impersonation') ||
    !matchesInternalAdminEmail(auth.user.email)
  )
    return { response: c.json({ error: 'internal_admin_required' }, 403) }
  return {
    internalKey: runtime.internalKey,
    actorId: auth.user.id,
    requestId: randomUUID(),
    reason,
    now: runtime.now(),
  }
}

async function authorizeEffect(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  action: string,
  target: string,
  reason: string,
): Promise<AuthorizedEffect | { response: Response }> {
  const access = accessArgs(c, runtime, reason)
  if ('response' in access) return access
  try {
    const result = (await runtime.convex.mutation(
      fn('domains/internalAdmin/model:authorizeEffect'),
      {
        ...access,
        workspaceId: c.req.param('workspaceId'),
        action,
        target,
      },
    )) as Omit<AuthorizedEffect, 'access'>
    return { ...result, access }
  } catch (error) {
    return { response: adminError(c, error) }
  }
}

async function proxyGatewayRead(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gateway: GatewayClient,
  path: string,
  target: string,
  reason: string,
  schema: z.ZodType,
  // The audit action was derived from the path with a two-way ternary, so any
  // third read silently audited as a directory listing. Callers name it now.
  action: string,
  query: Record<string, string> = { path: c.req.query('path') ?? '' },
) {
  const authorized = await authorizeEffect(c, runtime, action, target, reason)
  if ('response' in authorized) return authorized.response
  const params = new URLSearchParams(query)
  let response: Response
  try {
    response = await gateway.internalAdminRequest(
      adminGatewayConnection(authorized.workspace),
      `${path}?${params}`,
    )
  } catch (error) {
    await finalizeEffect(runtime, authorized, false, error)
    return c.json({ error: 'upstream_failed' }, 502)
  }
  const data = await readResponseJson(response)
  if (!response.ok) {
    await finalizeEffect(runtime, authorized, false, `gateway_http_${response.status}`)
    return c.json(
      typeof data === 'object' && data !== null ? data : { error: 'upstream_failed' },
      response.status as 400,
    )
  }
  try {
    const result = schema.parse({ ...(data as object), auditId: authorized.auditId })
    await finalizeEffect(runtime, authorized, true)
    return c.json(result)
  } catch (error) {
    await finalizeEffect(runtime, authorized, false, error)
    return c.json({ error: 'invalid_upstream_response' }, 502)
  }
}

function adminGatewayConnection(
  workspace: AuthorizedEffect['workspace'],
): GatewayConnection | null {
  if (
    workspace.vmName === undefined ||
    workspace.httpsUrl === undefined ||
    workspace.vmToken === undefined
  )
    return null
  return {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    vmName: workspace.vmName,
    httpsUrl: workspace.httpsUrl,
    vmToken: workspace.vmToken,
  }
}

async function convexJson(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  schema: z.ZodType,
  name: string,
  args: object,
) {
  try {
    return c.json(schema.parse(await runtime.convex.mutation(fn(name), args)))
  } catch (error) {
    return adminError(c, error)
  }
}

/**
 * An operator read: the Convex query, then its audit row. The admin model
 * explains why reads are queries and the audit is a separate mutation; a
 * refused read never reaches the audit, so the trail only holds served reads.
 */
async function auditedRead<Result extends object = object>(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  schema: z.ZodType,
  name: string,
  access: AdminAccess,
  args: object,
  auditOf: (result: Result) => { action: string; target: string; workspaceId?: string },
) {
  try {
    const result = (await runtime.convex.query(fnQuery(name), {
      internalKey: access.internalKey,
      actorId: access.actorId,
      ...args,
    })) as Result
    const { auditId } = (await runtime.convex.mutation(
      fn('domains/internalAdmin/model:recordAudit'),
      { ...access, ...auditOf(result) },
    )) as { auditId: string }
    return c.json(schema.parse({ ...result, auditId }))
  } catch (error) {
    return adminError(c, error)
  }
}

async function finalizeEffect(
  runtime: ApiRouteRuntime,
  authorized: AuthorizedEffect,
  success: boolean,
  detail?: unknown,
  outcome?: 'accepted',
): Promise<void> {
  await runtime.convex.mutation(fn('domains/internalAdmin/model:finalizeEffect'), {
    ...authorized.access,
    auditId: authorized.auditId,
    success,
    ...(outcome ? { outcome } : {}),
    ...(detail === undefined
      ? {}
      : { detail: detail instanceof Error ? detail.message : String(detail) }),
  })
}

const ADMIN_REFUSAL_STATUS: Record<InternalAdminRefusal['error'], 400 | 403 | 404 | 409 | 422> = {
  internal_admin_required: 403,
  not_found: 404,
  confirmation_mismatch: 409,
  admin_dataset_too_large: 409,
  invalid_request: 400,
  owner_candidate_required: 422,
  user_already_exists: 409,
  self_target: 409,
  cleanup_blocked: 409,
}

/**
 * A refusal arrives as `ConvexError` data and keeps its code; anything else the
 * backend threw is a failure, reported as one. Matching on the message would
 * not work: production Convex redacts plain error messages.
 */
function adminError(c: ApiContext, error: unknown): Response {
  if (error instanceof ConvexError) {
    const refusal = InternalAdminRefusalSchema.safeParse(error.data)
    if (refusal.success) return c.json(refusal.data, ADMIN_REFUSAL_STATUS[refusal.data.error])
  }
  return c.json({ error: 'admin_operation_failed' }, 500)
}

function currentMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7)
}
