import { expect, test } from 'bun:test'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { Hono } from 'hono'
import { API_VERSION, type InternalAdminCleanupOperation } from '@repo/contract'
import type { ApiRouteRuntime, ApiVariables, AuthPayload } from '../shared'
import { registerInternalAdminRoutes } from './internal-admin'

const operation: InternalAdminCleanupOperation = {
  operationId: 'operation-1', targetUserId: 'target-1', status: 'scheduled', canRetry: false,
  resources: [{ key: 'workspace:1', kind: 'delete_workspace', status: 'scheduled',
    outcome: 'workspace_cleanup_scheduled', attempts: 0 }], auditId: 'operation-audit',
}
function fixture(options: { credentialKind?: string; email?: string; result?: object; error?: string } = {}) {
  const app = new Hono<{ Variables: ApiVariables }>()
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  app.use('*', async (c, next) => {
    c.set('auth', { credentialKind: options.credentialKind ?? 'browser_session',
      user: { id: 'operator', email: options.email ?? 'operator@duet.so' },
      workspaces: [], scopes: [], versions: API_VERSION } as AuthPayload)
    await next()
  })
  const call = async (reference: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) => {
    const name = getFunctionName(reference)
    calls.push({ name, args })
    if (name.endsWith(':recordAudit')) return { auditId: 'read-audit' }
    if (options.error) throw new ConvexError({ error: options.error })
    return options.result ?? operation
  }
  registerInternalAdminRoutes(app, { internalKey: 'internal', now: () => 100,
    convex: { query: call, mutation: call } } as unknown as ApiRouteRuntime, {} as never, null)
  const post = (path: string, body: object = { reason: 'Requested account cleanup' }) =>
    app.request(`/v1/internal-admin/${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { app, calls, post }
}

test('cleanup routes require an operator browser identity before contacting the backend', async () => {
  for (const options of [{ credentialKind: 'user' }, { email: 'person@example.com' }]) {
    const { app, post, calls } = fixture(options)
    for (const response of [await app.request('/v1/internal-admin/users?q=user@example.com'),
      await post('users/target-1/cleanup'), await app.request('/v1/internal-admin/cleanup/operation-1'),
      await post('cleanup/operation-1/retry')]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'internal_admin_required' })
    }
    expect(calls).toEqual([])
  }
})

test('start and retry require an audit reason without a confirmation phrase', async () => {
  const { post, calls } = fixture()
  for (const path of ['users/target-1/cleanup', 'cleanup/operation-1/retry']) {
    for (const body of [{}, { reason: '  ' }, { reason: 'x'.repeat(501) }]) {
      expect((await post(path, body)).status).toBe(400)
    }
    const response = await post(path, { reason: '  Requested cleanup  ' })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual(operation)
  }
  expect(calls.map(call => call.args.reason)).toEqual(['Requested cleanup', 'Requested cleanup'])
})

test('start returns the existing active or terminal operation unchanged on replay', async () => {
  for (const status of ['running', 'completed', 'blocked', 'failed'] as const) {
    const result = { ...operation, status, replayed: true, canRetry: status === 'blocked' || status === 'failed' }
    const { post } = fixture({ result })
    const response = await post('users/target-1/cleanup')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result)
  }
})

test('status keeps scheduled teardown distinct from provider cleanup pending', async () => {
  const result = { ...operation, resources: [...operation.resources,
    { key: 'provider:1', kind: 'delete_workspace', status: 'scheduled', outcome: 'provider_cleanup_pending', attempts: 1 }] }
  const { app } = fixture({ result })
  const response = await app.request('/v1/internal-admin/cleanup/operation-1')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ...result, auditId: 'read-audit' })
})

test('cleanup refusals retain the existing admin error envelope', async () => {
  for (const [error, status] of [['self_target', 409], ['cleanup_blocked', 409], ['not_found', 404]] as const) {
    const { post } = fixture({ error })
    const response = await post('users/target-1/cleanup')
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
  }
})
