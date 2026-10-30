import { describe, expect, test } from 'bun:test'

import { tunnelTokenDigest } from '@repo/contract'

import { createTunnelAcceptRegistry } from './tunnel'

describe('tunnel accept registry', () => {
  test('replaces the complete snapshot and verifies only the current digest', async () => {
    const registry = createTunnelAcceptRegistry({ now: () => 100 })
    const firstToken = 'duet_tt_first'
    const refreshedToken = 'duet_tt_refreshed'

    expect(
      registry.replace([
        {
          acceptId: 'accept-a',
          targetPort: 22_000,
          tokenDigest: await tunnelTokenDigest(firstToken),
          expiresAt: 200,
        },
      ]),
    ).toEqual({ changed: 1 })
    expect(await registry.authorize('accept-a', firstToken)).toBe(true)

    expect(
      registry.replace([
        {
          acceptId: 'accept-a',
          targetPort: 22_000,
          tokenDigest: await tunnelTokenDigest(refreshedToken),
          expiresAt: 300,
        },
      ]),
    ).toEqual({ changed: 1 })
    expect(await registry.authorize('accept-a', firstToken)).toBe(false)
    expect(await registry.authorize('accept-a', refreshedToken)).toBe(true)

    expect(registry.replace([])).toEqual({ changed: 1 })
    expect(registry.get('accept-a')).toBeUndefined()
  })

  test('treats an identical snapshot as a no-op and expires accepts', async () => {
    let now = 100
    const registry = createTunnelAcceptRegistry({ now: () => now })
    const token = 'duet_tt_current'
    const desired = [
      {
        acceptId: 'accept-a',
        targetPort: 22_000,
        tokenDigest: await tunnelTokenDigest(token),
        expiresAt: 200,
      },
    ]

    expect(registry.replace(desired)).toEqual({ changed: 1 })
    expect(registry.replace(desired)).toEqual({ changed: 0 })
    now = 201
    expect(await registry.authorize('accept-a', token)).toBe(false)
    expect(registry.get('accept-a')).toBeUndefined()
  })

  test('rail snapshots do not prune independently minted mirror accepts', async () => {
    const registry = createTunnelAcceptRegistry({ now: () => 100 })
    registry.registerMirror({
      machineId: 'device-a',
      acceptId: 'mirror-device-a',
      tokenDigest: 'a'.repeat(64),
      expiresAt: 200,
    })

    registry.replace([])

    expect(registry.get('mirror-device-a')).toMatchObject({
      targetHost: '127.0.0.1',
      targetPort: 22_000,
    })
  })
})

test('detaching one machine invalidates its mirror grants while preserving another machine', async () => {
  const registry = createTunnelAcceptRegistry({ now: () => 100 })
  const digest = await tunnelTokenDigest('token')
  registry.registerMirror({
    machineId: 'machine-a',
    acceptId: 'mirror-machine-a-one',
    tokenDigest: digest,
    expiresAt: 200,
  })
  registry.registerMirror({
    machineId: 'machine-a',
    acceptId: 'mirror-machine-a-two',
    tokenDigest: digest,
    expiresAt: 200,
  })
  registry.registerMirror({
    machineId: 'machine-b',
    acceptId: 'mirror-machine-b-one',
    tokenDigest: digest,
    expiresAt: 200,
  })
  registry.removeMirrorMachine('machine-a')
  expect(await registry.authorize('mirror-machine-a-one', 'token')).toBe(false)
  expect(await registry.authorize('mirror-machine-a-two', 'token')).toBe(false)
  expect(await registry.authorize('mirror-machine-b-one', 'token')).toBe(true)
})
