import { hashSecret } from '../apiKeys/model'

export interface HashedTokenLookup<Row> {
  byTokenHash: (tokenHash: string) => Promise<Row | null>
}

export interface ActiveKeyStore<Row extends { expiresAt: number }> {
  byActiveKey: (activeKey: string) => Promise<Row | null>
  clear: (row: Row) => Promise<void>
}

export async function mintHashedToken(
  token: string,
  prefixLength: number,
): Promise<{ tokenHash: string; tokenPrefix: string }> {
  return {
    tokenHash: await hashSecret(token),
    tokenPrefix: token.slice(0, prefixLength),
  }
}

export async function lookupByToken<Row>(
  lookup: HashedTokenLookup<Row>,
  token: string,
): Promise<Row | null> {
  return await lookup.byTokenHash(await hashSecret(token))
}

export async function assertNoActiveKey<Row extends { expiresAt: number }>(
  store: ActiveKeyStore<Row>,
  activeKey: string,
  now: number,
  message: string,
): Promise<Row | null> {
  const existing = await store.byActiveKey(activeKey)
  if (existing !== null && existing.expiresAt > now) throw new Error(message)
  return existing
}

export async function clearActiveKey<Row extends { expiresAt: number }>(
  store: ActiveKeyStore<Row>,
  inactiveRow: Row | null,
): Promise<void> {
  if (inactiveRow !== null) await store.clear(inactiveRow)
}
