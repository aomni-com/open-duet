import { fetchAction } from 'convex/nextjs'
import { makeFunctionReference } from 'convex/server'

import type { SendMagicLink } from './magic-link-intent'

const signIn = makeFunctionReference<'action'>('auth:signIn')

export const sendMagicLink: SendMagicLink = async ({ email, redirectTo }) => {
  const result = (await fetchAction(signIn, {
    provider: 'email',
    params: { email, redirectTo },
  })) as { started?: boolean }
  if (result.started !== true) throw new Error('Magic-link delivery did not start')
}
