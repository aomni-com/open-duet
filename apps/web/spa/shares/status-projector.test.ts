import { describe, expect, test } from 'bun:test'

import { projectShareStatus } from './status-projector'

describe('share status projector', () => {
  test('reports up to date only when both workspaces are ready on their current generations', () => {
    expect(
      projectShareStatus({
        direction: 'incoming',
        state: 'active',
        sync: {
          origin: { state: 'ready', matchesCurrentGeneration: true },
          recipient: { state: 'ready', matchesCurrentGeneration: true },
        },
      }),
    ).toEqual({
      pill: 'upToDate',
      explanation: 'currentConfigurationReady',
      actions: ['unlink'],
    })
  })

  test('keeps an active share syncing while device identity or realization data is missing', () => {
    expect(
      projectShareStatus({
        direction: 'outgoing',
        state: 'active',
      }),
    ).toEqual({
      pill: 'syncing',
      explanation: 'applyingCurrentConfiguration',
      actions: ['revoke'],
    })
  })

  test('keeps syncing when only one workspace has realized the current generation', () => {
    const ready = { state: 'ready', matchesCurrentGeneration: true } as const
    for (const sync of [{ origin: ready }, { recipient: ready }]) {
      expect(projectShareStatus({ direction: 'incoming', state: 'active', sync })).toEqual({
        pill: 'syncing',
        explanation: 'applyingCurrentConfiguration',
        actions: ['unlink'],
      })
    }
  })

  test('keeps syncing when either workspace reports a stale generation', () => {
    const ready = { state: 'ready', matchesCurrentGeneration: true } as const
    const stale = { state: 'ready', matchesCurrentGeneration: false } as const
    for (const sync of [
      { origin: stale, recipient: ready },
      { origin: ready, recipient: stale },
    ]) {
      expect(projectShareStatus({ direction: 'outgoing', state: 'active', sync })).toEqual({
        pill: 'syncing',
        explanation: 'applyingCurrentConfiguration',
        actions: ['revoke'],
      })
    }
  })

  test('keeps syncing while either workspace reports an application error', () => {
    const ready = { state: 'ready', matchesCurrentGeneration: true } as const
    const failed = { state: 'error', matchesCurrentGeneration: true } as const
    for (const sync of [
      { origin: failed, recipient: ready },
      { origin: ready, recipient: failed },
    ]) {
      expect(projectShareStatus({ direction: 'incoming', state: 'active', sync })).toEqual({
        pill: 'syncing',
        explanation: 'applyingCurrentConfiguration',
        actions: ['unlink'],
      })
    }
  })

  test('reports paused when both workspaces realize the paused generation', () => {
    expect(
      projectShareStatus({
        direction: 'incoming',
        state: 'active',
        sync: {
          origin: { state: 'paused', matchesCurrentGeneration: true },
          recipient: { state: 'paused', matchesCurrentGeneration: true },
        },
      }),
    ).toEqual({
      pill: 'paused',
      explanation: 'sharingPaused',
      actions: ['unlink'],
    })
  })

  test('projects a pending outgoing invitation with revoke available', () => {
    expect(projectShareStatus({ direction: 'outgoing', state: 'pending' })).toEqual({
      pill: 'pending',
      explanation: 'awaitingAcceptance',
      actions: ['revoke'],
    })
  })

  test('projects an expired outgoing invitation with revoke available', () => {
    expect(projectShareStatus({ direction: 'outgoing', state: 'expired' })).toEqual({
      pill: 'expired',
      explanation: 'invitationExpired',
      actions: ['revoke'],
    })
  })

  test('projects an unlinked share without further actions', () => {
    expect(projectShareStatus({ direction: 'incoming', state: 'unlinked' })).toEqual({
      pill: 'unlinked',
      explanation: 'linkEnded',
      actions: [],
    })
  })

  test('projects a revoked share without further actions', () => {
    expect(projectShareStatus({ direction: 'outgoing', state: 'revoked' })).toEqual({
      pill: 'revoked',
      explanation: 'accessRevoked',
      actions: [],
    })
  })
})
