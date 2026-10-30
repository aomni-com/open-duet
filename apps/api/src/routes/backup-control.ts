import {
  BACKUP_UPLOAD_SETTLE_MS,
  BackupCaptureRequestSchema,
  BackupWorkerAttemptSchema,
  BackupWorkerCompleteRequestSchema,
  BackupWorkerFailRequestSchema,
  BackupWorkerProgressRequestSchema,
  extractBearerToken,
  hashApiKey,
} from '@repo/contract'

import { type BackupBlobStore } from '../backups/blob'
import type { GatewayClient } from '../gateway/client'
import { constantTimeSecretMatches } from '../secret-auth'
import { fn, fnQuery, type ApiApp, type ApiRouteRuntime } from '../shared'
import type { StoredBackup } from './backups'

export const BACKUP_AUTH_BYPASS_PATTERNS = [
  /^\/v1\/vm\/backups\/[^/]+\/(claim|capture|grant|progress|complete|fail)$/,
  /^\/v1\/internal\/backups\/[^/]+\/run$/,
] as const
const jobs = 'domains/workspaceBackups/jobs:'
type ControlPlan = {
  backup: StoredBackup
  workspace: {
    _id: string
    name: string
    slug: string
    vmTokenNonce?: string
    status: string
  } | null
}
export function registerBackupControlRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gateway: Pick<GatewayClient, 'backupCommand'>,
  blob: BackupBlobStore,
): void {
  for (const operation of ['claim', 'capture', 'grant', 'progress', 'complete', 'fail'] as const) {
    app.post(`/v1/vm/backups/:backupId/${operation}`, async c => {
      c.header('cache-control', 'private, no-store')
      const bearer = extractBearerToken(c.req.header('authorization') ?? null)
      if (!bearer) return c.json({ error: 'unauthorized' }, 401)
      const plan = (await runtime.convex.query(fnQuery(`${jobs}authenticateVm`), {
        internalKey: runtime.internalKey,
        backupId: c.req.param('backupId'),
        vmTokenHash: await hashApiKey(bearer),
      })) as (Omit<ControlPlan, 'backup'> & { backup: StoredBackup | null }) | null
      if (!plan?.workspace) return c.json({ error: 'unauthorized' }, 401)
      if (!plan.backup) return c.json({ error: 'attempt_not_active' }, 409)
      const body: unknown = await c.req.json().catch(() => null)
      const identity = BackupWorkerAttemptSchema.safeParse(
        body && typeof body === 'object'
          ? { attemptId: (body as { attemptId?: unknown }).attemptId }
          : null,
      )
      if (!identity.success) return c.json({ error: 'invalid_request' }, 400)
      if (identity.data.attemptId !== plan.backup.attemptId)
        return c.json({ error: 'attempt_not_active' }, 409)
      const args = {
        internalKey: runtime.internalKey,
        workspaceId: plan.workspace._id,
        backupId: plan.backup._id,
        attemptId: identity.data.attemptId,
        sourceVmGeneration: plan.workspace.vmTokenNonce!,
      }
      if (operation === 'claim') {
        const backup = (await runtime.convex.mutation(
          fn(`${jobs}claim`),
          args,
        )) as StoredBackup | null
        if (!backup) return c.json({ error: 'attempt_not_active' }, 409)
        return c.json({
          backup: {
            id: backup._id,
            attemptId: backup.attemptId,
            objectPath: backup.objectPath,
            createdAt: backup.createdAt,
          },
          workspace: { name: plan.workspace.name, slug: plan.workspace.slug },
        })
      }
      if (operation === 'complete') {
        const request = BackupWorkerCompleteRequestSchema.safeParse(body)
        if (!request.success) return c.json({ error: 'invalid_request' }, 400)
        if (!['running', 'ready'].includes(plan.backup.status))
          return c.json({ error: 'attempt_not_active' }, 409)
        try {
          await blob.verify(plan.backup.objectPath, request.data.bytes)
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'backup_artifact_mismatch')
            return c.json({ error: 'storage_unavailable' }, 503)
          await runtime.convex.mutation(fn(`${jobs}fail`), {
            ...args,
            error: {
              code: 'object_mismatch',
              message: 'Stored backup did not match the completed upload.',
            },
          })
          return c.json({ error: 'object_mismatch' }, 409)
        }
        const { progress, ...completion } = request.data
        const accepted = await runtime.convex.mutation(fn(`${jobs}complete`), {
          ...args,
          ...completion,
          progress,
        })
        return c.json({ accepted: Boolean(accepted) }, accepted ? 200 : 409)
      }
      if (operation === 'fail') {
        const request = BackupWorkerFailRequestSchema.safeParse(body)
        if (!request.success) return c.json({ error: 'invalid_request' }, 400)
        const accepted = await runtime.convex.mutation(fn(`${jobs}fail`), {
          ...args,
          ...request.data,
        })
        return c.json({ accepted: Boolean(accepted) }, accepted ? 200 : 409)
      }
      if (
        plan.backup.status !== 'running' ||
        plan.backup.sourceVmGeneration !== args.sourceVmGeneration
      )
        return c.json({ error: 'attempt_not_active' }, 409)
      if (operation === 'grant') {
        const grant = (await runtime.convex.mutation(fn(`${jobs}authorizeUpload`), args)) as {
          expiresAt: number
        } | null
        if (!grant) return c.json({ error: 'attempt_not_active' }, 409)
        return c.json({
          ...(await blob.uploadGrant(plan.backup.objectPath, grant.expiresAt)),
          pathname: plan.backup.objectPath,
        })
      }
      if (operation === 'progress') {
        const request = BackupWorkerProgressRequestSchema.safeParse(body)
        if (!request.success) return c.json({ error: 'invalid_request' }, 400)
        const accepted = await runtime.convex.mutation(fn(`${jobs}progress`), {
          ...args,
          ...request.data,
        })
        return c.json({ accepted: Boolean(accepted) }, accepted ? 200 : 409)
      }
      const { attemptId: _, ...capture } = body as Record<string, unknown>
      const request = BackupCaptureRequestSchema.safeParse(capture)
      if (!request.success) return c.json({ error: 'invalid_request' }, 400)
      return c.json(
        await runtime.convex.query(fnQuery('domains/workspaceBackups/capture:page'), {
          internalKey: runtime.internalKey,
          workspaceId: plan.workspace._id,
          ...request.data,
        }),
      )
    })
  }
  app.post('/v1/internal/backups/:backupId/run', async c => {
    const bearer = extractBearerToken(c.req.header('authorization') ?? null)
    if (!constantTimeSecretMatches(bearer, runtime.apiInternalKey))
      return c.json({ error: 'unauthorized' }, 401)
    const plan = (await runtime.convex.mutation(fn(`${jobs}reconcile`), {
      internalKey: runtime.internalKey,
      backupId: c.req.param('backupId'),
    })) as ControlPlan | null
    if (!plan) return c.json({ retryAfterMs: null })
    const { backup, workspace } = plan
    if (backup.status === 'ready' || (backup.status === 'failed' && !backup.objectCleanupPending))
      return c.json({ retryAfterMs: null })
    if (backup.status === 'queued') {
      if (workspace)
        await gateway.backupCommand(workspace.slug, backup._id, backup.attemptId, 'start')
      return c.json({ retryAfterMs: 30_000 })
    }
    if (backup.status === 'running') return c.json({ retryAfterMs: 30_000 })
    if (workspace)
      await gateway.backupCommand(workspace.slug, backup._id, backup.attemptId, 'cancel')
    try {
      await blob.delete(backup.objectPath)
      const settled = await runtime.convex.mutation(
        fn(`${jobs}${backup.status === 'deleting' ? 'finishDelete' : 'markObjectRemoved'}`),
        {
          internalKey: runtime.internalKey,
          workspaceId: backup.workspaceId,
          backupId: backup._id,
        },
      )
      return c.json({
        retryAfterMs: settled
          ? null
          : Math.max(
              30_000,
              (backup.uploadGrantExpiresAt ?? 0) + BACKUP_UPLOAD_SETTLE_MS - runtime.now(),
            ),
      })
    } catch {
      await runtime.convex.mutation(fn(`${jobs}cleanupFailed`), {
        internalKey: runtime.internalKey,
        workspaceId: backup.workspaceId,
        backupId: backup._id,
        error: { code: 'cleanup_failed', message: 'Storage cleanup will retry automatically.' },
      })
      return c.json({ retryAfterMs: 60_000 })
    }
  })
}
