import { expect, test } from 'bun:test'

import { createBrowserBatchService } from './browser-batches'

test('a browser batch resolves trusted ownership before starting and returns a gateway lease', async () => {
  const order: string[] = []
  const service = createBrowserBatchService({
    resolveOwner: async sessionId => {
      order.push(`resolve:${sessionId}`)
      return { ok: true, owner: { kind: 'agent', agentId: 'agent-a' } }
    },
    ensureDesktop: async () => {
      order.push('start')
      return 'ready'
    },
    reconcile: async () => {
      order.push('reconcile')
      return {
        verdict: 'preserved' as const,
        ledger: {
          version: 1 as const,
          browserGeneration: 'generation-a',
          windows: [],
          batches: [],
        },
      }
    },
    manager: {
      async startBatch(owner) {
        order.push(`claim:${owner.kind}`)
        return { batchId: 'batch-a', owner, targetId: 'target-a' }
      },
    },
    grants: {
      async mint(payload) {
        order.push(`grant:${payload.batchId}:${payload.browserGeneration}`)
        return {
          webSocketDebuggerUrl: 'ws://127.0.0.1:3000/v1/desktop/browser/cdp/grant.token',
          expiresAt: 1,
        }
      },
    },
  })

  expect(await service.start('session-a')).toEqual({
    batchId: 'batch-a',
    owner: { kind: 'agent', agentId: 'agent-a' },
    targetId: 'target-a',
    webSocketDebuggerUrl: 'ws://127.0.0.1:3000/v1/desktop/browser/cdp/grant.token',
  })
  expect(order).toEqual([
    'resolve:session-a',
    'start',
    'reconcile',
    'claim:agent',
    'grant:batch-a:generation-a',
  ])
})

test('an unresolved browser session fails before starting Chrome', async () => {
  let started = false
  const service = createBrowserBatchService({
    resolveOwner: async () => ({ ok: false, error: 'browser_session_not_found' }),
    ensureDesktop: async () => {
      started = true
      return 'ready'
    },
    reconcile: async () => {
      throw new Error('must not reconcile')
    },
    manager: {
      startBatch: async () => {
        throw new Error('must not claim')
      },
    },
    grants: {
      mint: async () => {
        throw new Error('must not mint')
      },
    },
  })

  await expect(service.start('missing')).rejects.toMatchObject({
    code: 'browser_session_not_found',
  })
  expect(started).toBe(false)
})
