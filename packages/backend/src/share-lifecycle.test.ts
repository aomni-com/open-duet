import { describe, expect, test } from 'bun:test'

import {
  transitionShareLifecycle,
  type ShareLifecycleAction,
  type ShareLifecycleState,
} from '../convex/domains/shares/lifecycle'

const NOW = 42_000

describe('share lifecycle', () => {
  const allowed: Array<{
    state: ShareLifecycleState
    action: ShareLifecycleAction
    expected: ReturnType<typeof transitionShareLifecycle>
  }> = [
    {
      state: 'pending',
      action: { kind: 'accept' },
      expected: {
        patch: { state: 'active', acceptedAt: NOW, declinedAt: undefined },
        intent: 'attach',
      },
    },
    {
      state: 'pending',
      action: { kind: 'decline' },
      expected: { patch: { declinedAt: NOW }, intent: 'none' },
    },
    {
      state: 'pending',
      action: { kind: 'revoke' },
      expected: { patch: { state: 'revoked', revokedAt: NOW }, intent: 'delete-replicas' },
    },
    {
      state: 'active',
      action: { kind: 'unlink' },
      expected: { patch: { state: 'unlinked', unlinkedAt: NOW }, intent: 'detach-replicas' },
    },
    {
      state: 'active',
      action: { kind: 'revoke' },
      expected: { patch: { state: 'revoked', revokedAt: NOW }, intent: 'delete-replicas' },
    },
    {
      state: 'unlinked',
      action: { kind: 'revoke' },
      expected: { patch: { state: 'revoked', revokedAt: NOW }, intent: 'delete-replicas' },
    },
    {
      state: 'revoked',
      action: { kind: 'revoke' },
      expected: { patch: {}, intent: 'none' },
    },
  ]

  for (const row of allowed) {
    test(`${row.state} + ${row.action.kind}`, () => {
      expect(transitionShareLifecycle(row.state, row.action, NOW)).toEqual(row.expected)
    })
  }

  const forbidden: Array<[ShareLifecycleState, ShareLifecycleAction]> = [
    ['pending', { kind: 'unlink' }],
    ['active', { kind: 'accept' }],
    ['active', { kind: 'decline' }],
    ['unlinked', { kind: 'accept' }],
    ['unlinked', { kind: 'decline' }],
    ['unlinked', { kind: 'unlink' }],
    ['revoked', { kind: 'accept' }],
    ['revoked', { kind: 'decline' }],
    ['revoked', { kind: 'unlink' }],
  ]

  for (const [state, action] of forbidden) {
    test(`rejects ${state} + ${action.kind}`, () => {
      expect(() => transitionShareLifecycle(state, action, NOW)).toThrow(
        `Cannot ${action.kind} a ${state} share`,
      )
    })
  }
})
