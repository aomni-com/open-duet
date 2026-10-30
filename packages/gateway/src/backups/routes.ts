import { Hono } from 'hono'

import { BackupWorkerAttemptSchema } from '@repo/contract'

import type { createBackupWorker } from './worker'

export function createBackupRoutes(worker: ReturnType<typeof createBackupWorker>) {
  const app = new Hono()
  app.post('/:id/start', async c => {
    const request = BackupWorkerAttemptSchema.safeParse(await c.req.json().catch(() => null))
    if (!request.success) return c.json({ error: 'invalid_request' }, 400)
    const result = worker.start(c.req.param('id'), request.data.attemptId)
    return result.accepted ? c.json(result, 202) : c.json({ error: 'backup_worker_busy' }, 409)
  })
  app.delete('/:id', async c => {
    const request = BackupWorkerAttemptSchema.safeParse(await c.req.json().catch(() => null))
    if (!request.success) return c.json({ error: 'invalid_request' }, 400)
    return c.json(await worker.cancel(c.req.param('id'), request.data.attemptId))
  })
  return app
}
