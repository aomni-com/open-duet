import { BrowserSessionCredentialSchema, hashApiKey } from '@repo/contract'

import { BrowserSessionAuthenticationError, type BrowserSessionService } from './duet-proxy'

interface BrowserSessionExchangeOptions {
  getIdentityToken: () => Promise<string | undefined>
  mint: (args: { previousHashedKey?: string }, identityToken: string) => Promise<unknown>
  revoke: (args: { hashedKey: string }, identityToken: string) => Promise<unknown>
}

export function createBrowserSessionService(
  options: BrowserSessionExchangeOptions,
): BrowserSessionService {
  const exchanges = new Map<string, Promise<unknown>>()

  async function exchange(previousToken: string | undefined): Promise<unknown> {
    const identityToken = await requireIdentityToken(options.getIdentityToken)
    const identityHash = await hashApiKey(identityToken)
    const previousHashedKey =
      previousToken === undefined ? undefined : await hashApiKey(previousToken)
    const exchangeKey = `${identityHash}:${previousHashedKey ?? 'new'}`
    const pending = exchanges.get(exchangeKey)
    if (pending !== undefined) return await pending

    const started = options.mint(
      previousHashedKey === undefined ? {} : { previousHashedKey },
      identityToken,
    )
    exchanges.set(exchangeKey, started)
    try {
      return await started
    } finally {
      if (exchanges.get(exchangeKey) === started) exchanges.delete(exchangeKey)
    }
  }

  return {
    async mint() {
      return BrowserSessionCredentialSchema.parse(await exchange(undefined))
    },

    async rotate(previousToken) {
      return BrowserSessionCredentialSchema.nullable().parse(await exchange(previousToken))
    },

    async revoke(token) {
      const identityToken = await requireIdentityToken(options.getIdentityToken)
      await options.revoke({ hashedKey: await hashApiKey(token) }, identityToken)
    },
  }
}

async function requireIdentityToken(
  getIdentityToken: () => Promise<string | undefined>,
): Promise<string> {
  const token = await getIdentityToken()
  if (token === undefined) {
    throw new BrowserSessionAuthenticationError('Convex Auth identity required')
  }
  return token
}
