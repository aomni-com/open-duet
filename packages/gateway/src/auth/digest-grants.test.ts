import { describe, expect, test } from 'bun:test'

import { tunnelTokenDigest } from '@repo/contract'

import { createDigestGrantRegistry } from './digest-grants'

describe('digest grant registry', () => {
  test('sweeps an expired grant when it is read', async () => {
    let now = 100
    const registry = createDigestGrantRegistry<{ workspace: string }>({ now: () => now })
    registry.put('grant-a', {
      tokenDigest: await tunnelTokenDigest('duet_dt_current'),
      expiresAt: 200,
      payload: { workspace: 'alpha' },
    })

    expect(registry.get('grant-a')).toEqual({
      payload: { workspace: 'alpha' },
      expiresAt: 200,
    })
    now = 200
    expect(registry.get('grant-a')).toBeUndefined()
    now = 100
    expect(registry.get('grant-a')).toBeUndefined()
  })

  test('rejects a token that does not match the stored digest', async () => {
    const registry = createDigestGrantRegistry<null>({ now: () => 100 })
    registry.put('grant-a', {
      tokenDigest: await tunnelTokenDigest('duet_dt_current'),
      expiresAt: 200,
      payload: null,
    })

    expect(await registry.authorize('grant-a', 'duet_dt_wrong')).toBe(false)
    expect(await registry.authorize('grant-a', 'duet_dt_current')).toBe(true)
  })

  test('rejects a deleted grant', async () => {
    const registry = createDigestGrantRegistry<null>({ now: () => 100 })
    const token = 'duet_dt_current'
    registry.put('grant-a', {
      tokenDigest: await tunnelTokenDigest(token),
      expiresAt: 200,
      payload: null,
    })

    registry.delete('grant-a')

    expect(registry.get('grant-a')).toBeUndefined()
    expect(await registry.authorize('grant-a', token)).toBe(false)
  })

  test('sweeps unrelated expiry before refusing capacity and never evicts live grants', async () => {
    let now = 100
    const registry = createDigestGrantRegistry<string>({ now: () => now, capacity: 2 })
    const digest = await tunnelTokenDigest('duet_dt_current')
    expect(
      registry.put('expired', { tokenDigest: digest, expiresAt: 150, payload: 'expired' }),
    ).toEqual({ ok: true })
    expect(registry.put('live', { tokenDigest: digest, expiresAt: 300, payload: 'live' })).toEqual({
      ok: true,
    })
    now = 150
    expect(
      registry.put('replacement', { tokenDigest: digest, expiresAt: 300, payload: 'new' }),
    ).toEqual({ ok: true })
    expect(
      registry.put('overflow', { tokenDigest: digest, expiresAt: 300, payload: 'overflow' }),
    ).toEqual({ ok: false, error: 'capacity' })
    expect(registry.get('live')?.payload).toBe('live')
    expect(registry.get('replacement')?.payload).toBe('new')
    expect(registry.get('overflow')).toBeUndefined()
  })
})
