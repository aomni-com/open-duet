import { expect, test } from 'bun:test'

import { getFunctionName } from 'convex/server'
import { Hono } from 'hono'

import { API_VERSION } from '@repo/contract'

import type { ApiRouteRuntime, ApiVariables, AuthPayload } from '../shared'
import { registerInternalAdminRoutes } from './internal-admin'

function fixture(result: object) {
  const app = new Hono<{ Variables: ApiVariables }>()
  const audits: Array<Record<string, unknown>> = []
  app.use('*', async (c, next) => {
    c.set('auth', {
      credentialKind: 'browser_session',
      user: { id: 'operator', email: 'operator@duet.so' },
      workspaces: [],
      scopes: [],
      versions: API_VERSION,
    } as AuthPayload)
    await next()
  })
  const runtime = {
    internalKey: 'internal',
    now: () => 100,
    convex: {
      query: async () => ({
        _id: 'backup-1',
        workspaceId: 'workspace-1',
        purpose: 'archive',
        status: 'failed',
        createdAt: 100,
        updatedAt: 200,
        progress: {
          processedFiles: 0,
          processedRecords: 0,
          capturedBytes: 0,
          uploadedBytes: 0,
          warningCount: 0,
          warningSummary: [],
        },
        lifecycle: { kind: 'archive', status: 'failed', reason: 'backup_failed' },
        error: { code: 'capture_failed', message: 'Drive could not be read' },
        objectPath: 'private-secret',
        attemptId: 'attempt-secret',
      }),
      action: async () => {
        throw new Error('Lifecycle admission must be transactional')
      },
      mutation: async (
        reference: Parameters<typeof getFunctionName>[0],
        args: Record<string, unknown>,
      ) => {
        const name = getFunctionName(reference)
        if (name.endsWith(':authorizeEffect'))
          return { auditId: 'audit-1', workspace: { id: 'workspace-1', slug: 'acme' } }
        if (name.endsWith(':recordAudit')) return { auditId: 'read-audit' }
        if (name.endsWith(':finalizeEffect')) {
          audits.push(args)
          return { auditId: 'audit-1' }
        }
        if (name.startsWith('domains/workspaces/lifecycle:request')) return result
        throw new Error(`Unexpected mutation ${name}`)
      },
    },
  } as unknown as ApiRouteRuntime
  registerInternalAdminRoutes(app, runtime, {} as never, null)
  const request = (operation: string) =>
    app.request(`/v1/internal-admin/workspaces/workspace-1/vm/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Operator maintenance', confirmation: 'acme' }),
    })
  return { app, request, audits }
}

test('operator archive and reprovision acknowledge admitted backups without claiming completion', async () => {
  for (const operation of ['archive', 'reprovision']) {
    const { request, audits } = fixture({
      status: 'backup_pending',
      workspaceId: 'workspace-1',
      backupId: 'backup-1',
    })
    const response = await request(operation)
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      ok: true,
      status: 'backup_pending',
      backupId: 'backup-1',
      auditId: 'audit-1',
    })
    expect(audits).toContainEqual(
      expect.objectContaining({ outcome: 'accepted', detail: 'backup_pending:backup-1' }),
    )
  }
})

test('operator active-work deferral is returned and audited as refused instead of accepted', async () => {
  const result = {
    status: 'deferred',
    reason: 'active_workspace_work',
    activeAgentSessions: 2,
    activeTrainJobs: 1,
  }
  const { request, audits } = fixture(result)
  const response = await request('reprovision')
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject(result)
  expect(audits).toContainEqual(
    expect.objectContaining({ success: false, detail: 'active_workspace_work' }),
  )
  expect(audits.some(audit => audit.outcome === 'accepted')).toBe(false)
})

test('operators can retrieve lifecycle failure without gaining private storage authority', async () => {
  const { app } = fixture({})
  const response = await app.request(
    '/v1/internal-admin/workspaces/workspace-1/vm/backups/backup-1',
  )
  expect(response.status).toBe(200)
  const data = await response.json()
  expect(data.backup).toMatchObject({
    id: 'backup-1',
    lifecycle: { status: 'failed' },
    error: { message: 'Drive could not be read' },
  })
  expect(JSON.stringify(data)).not.toContain('private-secret')
  expect(JSON.stringify(data)).not.toContain('attempt-secret')
})
