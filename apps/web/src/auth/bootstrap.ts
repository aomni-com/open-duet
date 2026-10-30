import 'server-only'

import { convexAuthNextjsToken } from '@convex-dev/auth/nextjs/server'
import { fetchAction } from 'convex/nextjs'
import { makeFunctionReference } from 'convex/server'

import type {
  BrowserBootstrapTokens,
  BrowserDeviceIdentification,
} from './complete-browser-session'

// An action, not a mutation: the bootstrap mutation is internal so that a
// signed-in browser cannot call it directly and skip the signup gate.
const signUp = makeFunctionReference<
  'action',
  { tokens?: BrowserBootstrapTokens; device?: BrowserDeviceIdentification },
  { workspaceId: string; workspaceSlug: string; invited: boolean }
>('domains/signupAbuse/actions:signUp')

export async function bootstrapBrowserUser(
  tokens?: BrowserBootstrapTokens,
  device?: BrowserDeviceIdentification,
) {
  const token = await convexAuthNextjsToken()
  if (!token) throw new Error('Authentication required')
  return await fetchAction(
    signUp,
    {
      ...(tokens === undefined ? {} : { tokens }),
      ...(device === undefined ? {} : { device }),
    },
    { token },
  )
}
