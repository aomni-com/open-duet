import { describe, expect, test } from 'bun:test'

import type { WorkspaceSummary } from '@repo/contract'

import { deriveWorkspaceBillingSurface } from './workspace-billing-boundary'

const workspace = {
  id: 'workspace_1',
  slug: 'studio',
  name: 'Studio',
  status: 'active',
  servicingStatus: 'active',
  role: 'owner',
  billingUserId: 'payer_1',
  funding: { plan: null, active: true },
  creditRecovery: null,
  defaultTier: { effective: 'balanced' },
} satisfies WorkspaceSummary

describe('deriveWorkspaceBillingSurface', () => {
  test('the existing entitlement wall wins over a low-credit projection', () => {
    const result = deriveWorkspaceBillingSurface(
      { ...workspace, servicingStatus: 'paused', creditRecovery: 'subscribe' },
      { user: { id: 'payer_1' } },
      undefined,
    )

    expect(result?.kind).toBe('entitlement')
    if (result?.kind === 'entitlement') expect(result.wall.kind).toBe('payer-loading')
  })

  test('a null projection produces no billing surface', () => {
    expect(
      deriveWorkspaceBillingSurface(workspace, { user: { id: 'payer_1' } }, undefined),
    ).toBeNull()
  })

  test('the payer receives the projected recovery kind', () => {
    for (const recovery of ['subscribe', 'topup'] as const) {
      expect(
        deriveWorkspaceBillingSurface(
          { ...workspace, creditRecovery: recovery },
          { user: { id: 'payer_1' } },
          undefined,
        ),
      ).toEqual({
        kind: 'low-credit',
        state: { kind: recovery, workspace: { ...workspace, creditRecovery: recovery } },
      })
    }
  })

  test('a member always receives the fixed owner-waiting state', () => {
    for (const recovery of ['subscribe', 'topup'] as const) {
      expect(
        deriveWorkspaceBillingSurface(
          { ...workspace, role: 'editor', creditRecovery: recovery },
          { user: { id: 'member_1' } },
          undefined,
        ),
      ).toEqual({
        kind: 'low-credit',
        state: {
          kind: 'member',
          workspace: { ...workspace, role: 'editor', creditRecovery: recovery },
        },
      })
    }
  })
})

describe('a checkout the payer just completed', () => {
  test('projects celebration ahead of payer low-credit recovery', () => {
    expect(
      deriveWorkspaceBillingSurface(
        { ...workspace, creditRecovery: 'topup' },
        { user: { id: 'payer_1' } },
        undefined,
        true,
      ),
    ).toEqual({ kind: 'celebration' })
  })

  test('projects celebration when recovery is cleared', () => {
    expect(
      deriveWorkspaceBillingSurface(workspace, { user: { id: 'payer_1' } }, undefined, true),
    ).toEqual({ kind: 'celebration' })
  })

  test('projects the entitlement wall for paused servicing despite checkout completion', () => {
    expect(
      deriveWorkspaceBillingSurface(
        { ...workspace, servicingStatus: 'paused' },
        { user: { id: 'payer_1' } },
        undefined,
        true,
      ),
    ).toMatchObject({ kind: 'entitlement' })
  })
  test('projects member waiting despite checkout completion', () => {
    expect(
      deriveWorkspaceBillingSurface(
        { ...workspace, role: 'editor', creditRecovery: 'topup' },
        { user: { id: 'member_1' } },
        undefined,
        true,
      ),
    ).toMatchObject({ kind: 'low-credit', state: { kind: 'member' } })
  })
})
