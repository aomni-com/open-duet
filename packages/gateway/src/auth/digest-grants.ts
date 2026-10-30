import { verifyTunnelTokenDigest } from '@repo/sync-tunnel'

interface StoredDigestGrant<Payload> {
  tokenDigest: string
  expiresAt: number
  payload: Payload
}

export type DigestGrantPutResult = { ok: true } | { ok: false; error: 'capacity' }

export function createDigestGrantRegistry<Payload>(options: {
  now: () => number
  capacity?: number
}) {
  const grants = new Map<string, StoredDigestGrant<Payload>>()

  return {
    put(id: string, grant: StoredDigestGrant<Payload>): DigestGrantPutResult {
      sweepExpired()
      if (!grants.has(id) && grants.size >= (options.capacity ?? Number.POSITIVE_INFINITY)) {
        return { ok: false, error: 'capacity' }
      }
      grants.set(id, grant)
      return { ok: true }
    },
    get(id: string): { payload: Payload; expiresAt: number } | undefined {
      const grant = liveGrant(id)
      if (grant === undefined) return undefined
      return { payload: grant.payload, expiresAt: grant.expiresAt }
    },
    async authorize(id: string, token: string): Promise<boolean> {
      return (await authorizeGrant(id, token)) !== undefined
    },
    async authorizeGrant(
      id: string,
      token: string,
    ): Promise<{ payload: Payload; expiresAt: number } | undefined> {
      return await authorizeGrant(id, token)
    },
    deleteWhere(matches: (payload: Payload) => boolean): void {
      for (const [id, grant] of grants) {
        if (matches(grant.payload)) grants.delete(id)
      }
    },
    delete(id: string): void {
      grants.delete(id)
    },
  }

  async function authorizeGrant(
    id: string,
    token: string,
  ): Promise<{ payload: Payload; expiresAt: number } | undefined> {
    const grant = liveGrant(id)
    if (grant === undefined) return undefined
    const authorized = await verifyTunnelTokenDigest({
      token,
      tokenDigest: grant.tokenDigest,
      expiresAt: grant.expiresAt,
      now: options.now,
    })
    return authorized ? { payload: grant.payload, expiresAt: grant.expiresAt } : undefined
  }

  function liveGrant(id: string): StoredDigestGrant<Payload> | undefined {
    const grant = grants.get(id)
    if (grant === undefined) return undefined
    if (grant.expiresAt <= options.now()) {
      grants.delete(id)
      return undefined
    }
    return grant
  }

  function sweepExpired(): void {
    const checkedAt = options.now()
    for (const [id, grant] of grants) {
      if (grant.expiresAt <= checkedAt) grants.delete(id)
    }
  }
}
