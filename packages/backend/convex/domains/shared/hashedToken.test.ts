import { describe, expect, test } from 'bun:test'

import {
  assertNoActiveKey,
  clearActiveKey,
  lookupByToken,
  mintHashedToken,
  type ActiveKeyStore,
  type HashedTokenLookup,
} from './hashedToken'

type TokenRow = {
  tokenHash: string
  tokenPrefix: string
  activeKey?: string
  expiresAt: number
}

describe('hashed token lifecycle', () => {
  test('mints, resolves, rejects an active scope, and clears that scope without changing the token', async () => {
    const rows: TokenRow[] = []
    const lookup: HashedTokenLookup<TokenRow> = {
      byTokenHash: async tokenHash => rows.find(row => row.tokenHash === tokenHash) ?? null,
    }
    const activeKeys: ActiveKeyStore<TokenRow> = {
      byActiveKey: async activeKey => rows.find(row => row.activeKey === activeKey) ?? null,
      clear: async row => {
        row.activeKey = undefined
      },
    }
    const token = 'duet_token_0123456789abcdef'
    const activeKey = 'workspace:recipient'
    const minted = await mintHashedToken(token, 10)
    const row: TokenRow = {
      ...minted,
      activeKey,
      expiresAt: 200,
    }
    rows.push(row)

    expect(minted.tokenPrefix).toBe(token.slice(0, 10))
    expect(minted.tokenHash).not.toBe(token)
    expect(await lookupByToken(lookup, token)).toEqual(row)
    expect(await lookupByToken(lookup, 'duet_token_different')).toBeNull()
    await expect(
      assertNoActiveKey(activeKeys, activeKey, 100, 'An active token already exists'),
    ).rejects.toThrow('An active token already exists')
    const inactiveRow = await assertNoActiveKey(
      activeKeys,
      activeKey,
      row.expiresAt,
      'An active token already exists',
    )

    await clearActiveKey(activeKeys, inactiveRow)

    expect(row).toEqual({
      ...minted,
      activeKey: undefined,
      expiresAt: 200,
    })
    expect(await lookupByToken(lookup, token)).toEqual(row)
    expect(
      await assertNoActiveKey(
        activeKeys,
        'workspace:recipient',
        100,
        'An active token already exists',
      ),
    ).toBeNull()
  })
})
