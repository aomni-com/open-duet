import { ConvexError } from 'convex/values'

import {
  BackupCreateRequestSchema,
  BackupListQuerySchema,
  BackupSchema,
  InvalidCollectionCursorError,
  type Backup,
} from '@repo/contract'

import type { BackupBlobStore } from '../backups/blob'
import { createConvexCollectionPage } from '../collection-page'
import {
  fn,
  fnQuery,
  requireAuthedWorkspace,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
} from '../shared'

export type StoredBackup = Omit<Backup, 'id'> & {
  _id: string
  attemptId: string
  objectPath: string
  sourceVmGeneration?: string
  lastProgressAt: number
  uploadGrantExpiresAt?: number
  objectCleanupPending: boolean
}
const jobs = 'domains/workspaceBackups/jobs:'
const pages = createConvexCollectionPage('workspace-backups')
export function publicBackup(stored: StoredBackup): Backup {
  return BackupSchema.parse(
    Object.fromEntries(
      Object.keys(BackupSchema.shape).map(key => [
        key,
        key === 'id' ? stored._id : stored[key as keyof StoredBackup],
      ]),
    ),
  )
}

export function registerBackupRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  blob: BackupBlobStore,
): void {
  const base = '/v1/ws/:workspaceSlug/backups'
  app.post(base, async c => {
    const workspace = requireAuthedWorkspace(c, 'admin')
    if ('response' in workspace) return workspace.response
    const body = BackupCreateRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const backup = (await runtime.convex.mutation(fn(`${jobs}create`), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        ...body.data,
      })) as StoredBackup
      return c.json({ backup: publicBackup(backup) }, 202)
    } catch (error) {
      return backupError(c, error)
    }
  })
  app.get(base, async c => {
    const workspace = requireAuthedWorkspace(c, 'admin')
    if ('response' in workspace) return workspace.response
    const query = BackupListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = { subject: workspace.id, filters: {}, order: 'newest' }
    try {
      const result = (await runtime.convex.query(fnQuery(`${jobs}list`), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        paginationOpts: await pages.paginationOpts(query.data, binding),
      })) as { page: StoredBackup[]; continueCursor: string; isDone: boolean }
      return c.json(await pages.response(result, binding, publicBackup))
    } catch (error) {
      return backupError(c, error)
    }
  })
  app.get(`${base}/:backupId`, async c => {
    const workspace = requireAuthedWorkspace(c, 'admin')
    if ('response' in workspace) return workspace.response
    const backup = (await runtime.convex.query(fnQuery(`${jobs}get`), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      backupId: c.req.param('backupId'),
    })) as StoredBackup | null
    return backup ? c.json({ backup: publicBackup(backup) }) : c.json({ error: 'not_found' }, 404)
  })
  app.post(`${base}/:backupId/download`, async c => {
    c.header('cache-control', 'private, no-store')
    c.header('referrer-policy', 'no-referrer')
    const workspace = requireAuthedWorkspace(c, 'admin')
    if ('response' in workspace) return workspace.response
    const backup = (await runtime.convex.query(fnQuery(`${jobs}get`), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      backupId: c.req.param('backupId'),
    })) as StoredBackup | null
    if (!backup) return c.json({ error: 'not_found' }, 404)
    if (backup.status !== 'ready') return c.json({ error: 'backup_not_ready' }, 409)
    return c.json({
      ...(await blob.download(backup.objectPath)),
      bytes: backup.bytes,
      sha256: backup.sha256,
      filename: `${workspace.slug}-backup-${new Date(backup.createdAt).toISOString().slice(0, 10)}.zip`,
    })
  })
  app.delete(`${base}/:backupId`, async c => {
    const workspace = requireAuthedWorkspace(c, 'admin')
    if ('response' in workspace) return workspace.response
    try {
      const result = (await runtime.convex.mutation(fn(`${jobs}requestDelete`), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        backupId: c.req.param('backupId'),
      })) as { deleted: boolean; emptyDriveOnNextStart: boolean }
      return c.json(
        { deleted: result.deleted, emptyDriveOnNextStart: result.emptyDriveOnNextStart },
        result.deleted ? 200 : 202,
      )
    } catch (error) {
      return backupError(c, error)
    }
  })
}

function backupError(c: ApiContext, error: unknown): Response {
  if (error instanceof InvalidCollectionCursorError) return c.json({ error: 'invalid_cursor' }, 400)
  if (error instanceof ConvexError && typeof error.data === 'object' && error.data !== null) {
    const data = error.data as { code?: string; backupId?: string }
    if (data.code === 'backup_in_progress' || data.code === 'backup_in_use')
      return c.json(
        { error: data.code, ...(data.backupId ? { backupId: data.backupId } : {}) },
        409,
      )
    if (data.code === 'workspace_not_found') return c.json({ error: 'not_found' }, 404)
    if (data.code === 'invalid_request') return c.json({ error: 'invalid_request' }, 400)
  }
  throw error
}
