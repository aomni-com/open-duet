import 'server-only'

import { convexAuthNextjsToken } from '@convex-dev/auth/nextjs/server'
import { fetchMutation } from 'convex/nextjs'
import { makeFunctionReference } from 'convex/server'

import type { BrowserSessionCredential } from '@repo/contract'

import { createBrowserSessionService } from './browser-session'

type MintBrowserSessionArgs = { previousHashedKey?: string }
type RevokeBrowserSessionArgs = { hashedKey: string }

const mintBrowserSession = makeFunctionReference<
  'mutation',
  MintBrowserSessionArgs,
  BrowserSessionCredential | null
>('domains/apiKeys/mutations:mintBrowserSession')
const revokeBrowserSession = makeFunctionReference<
  'mutation',
  RevokeBrowserSessionArgs,
  { revoked: boolean; revokedAt?: number }
>('domains/apiKeys/mutations:revokeBrowserSession')

export const browserSessionService = createBrowserSessionService({
  getIdentityToken: convexAuthNextjsToken,
  async mint(args, identityToken) {
    return await fetchMutation(mintBrowserSession, args, { token: identityToken })
  },
  async revoke(args, identityToken) {
    return await fetchMutation(revokeBrowserSession, args, {
      token: identityToken,
    })
  },
})
