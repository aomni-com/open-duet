import Google from '@auth/core/providers/google'
import { ConvexCredentials } from '@convex-dev/auth/providers/ConvexCredentials'
import { Email } from '@convex-dev/auth/providers/Email'
import { convexAuth, createAccount, retrieveAccount } from '@convex-dev/auth/server'
import { makeFunctionReference } from 'convex/server'

import {
  generateHumanEntryCode,
  hashApiKey,
  IDENTITY_SESSION_INACTIVE_MS,
  IDENTITY_SESSION_TOTAL_MS,
  SIGN_IN_CODE_TTL_SECONDS,
} from '@repo/contract'

import {
  assertEmailedSignInLink,
  authRedirectUrl,
  testAuthEmailEnabled,
  testAuthGoogleEnabled,
} from './config'
import { isBlockedEmailDomain } from './domains/signupAbuse/blockedEmailDomains'
import { createOrLinkUserForAuth, profileFromCredentials } from './domains/users/model'

type EmailProviderConfig = Parameters<typeof Email>[0]

const sendTransactional = makeFunctionReference<'action'>('services/email:sendTransactional')
const bindSignInRequestCode = makeFunctionReference<'mutation'>(
  'domains/authRequests/mutations:bindCode',
)

const sendMagicLink = (async (
  delivery: { identifier: string; url: string; token: string },
  ctx: {
    runAction: (
      reference: typeof sendTransactional,
      args: Record<string, unknown>,
    ) => Promise<unknown>
    runMutation: (
      reference: typeof bindSignInRequestCode,
      args: Record<string, unknown>,
    ) => Promise<unknown>
  },
) => {
  // Keep blocked domains out of the paid mail rail. The caller still receives
  // the provider's normal success-shaped response so this remains an
  // enumeration-safe pre-auth decision. Convex Auth already upserted its user
  // and code before this callback; suppress delivery before binding an API
  // request or calling the paid mail service.
  if (isBlockedEmailDomain(delivery.identifier)) return

  // The only moment a minted code is visible to Duet. A sign-in the agent rail
  // started has a request record waiting for it here, and learns its code by
  // hash; a browser sign-in has none and binds nothing.
  const { bound, clientName } = (await ctx.runMutation(bindSignInRequestCode, {
    email: delivery.identifier,
    codeHash: await hashApiKey(delivery.token),
    now: Date.now(),
  })) as { bound: boolean; clientName?: string }
  // Only the agent rail, and the reason is narrower than it looks.
  //
  // A closeout review argued this should be unconditional, since the agent
  // variant of the email renders a code and no button — so the URL it validates
  // is never shown — while the browser rail is where the link IS the message.
  // True as far as it goes, and making it unconditional turns 21 of 22 fixtures
  // red: every suite that drives `auth:signIn` directly passes no `redirectTo`
  // and gets the library's bare-`SITE_URL` fallback.
  //
  // What actually protects each rail: the browser rail is guarded at the
  // source, because `apps/web` always sends the callback path as `redirectTo`.
  // This rail is the one whose `redirectTo` is chosen here, so this is where a
  // mistake in it would be silent. Throwing leaves a record holding a code
  // nobody received; the next `start` supersedes it, and no email was spent on
  // a link that finishes nothing.
  if (bound) assertEmailedSignInLink(delivery.url)
  await ctx.runAction(sendTransactional, {
    to: delivery.identifier,
    // The code rides only on the agent rail. A browser sign-in binds no record,
    // so it gets the plain link email it always got — showing a typeable code to
    // someone who never asked for one would teach them to type codes at
    // whatever asks.
    email: {
      kind: 'auth_magic_link',
      actionUrl: delivery.url,
      ...(bound ? { code: delivery.token } : {}),
      ...(bound && clientName !== undefined ? { clientName } : {}),
      ...(bound ? { expiresInMinutes: SIGN_IN_CODE_TTL_SECONDS / 60 } : {}),
    },
    idempotencyKey: `auth-magic-link:${await hashApiKey(`${delivery.identifier}:${delivery.token}`)}`,
  })
}) as unknown as EmailProviderConfig['sendVerificationRequest']

const providers = [
  Email({
    id: 'email',
    name: 'Email',
    maxAge: SIGN_IN_CODE_TTL_SECONDS,
    from: 'Duet <team@mail.duet.so>',
    authorize: undefined,
    generateVerificationToken: async () =>
      testAuthEmailEnabled() && process.env.DUET_TEST_AUTH_CODE
        ? process.env.DUET_TEST_AUTH_CODE
        : generateHumanEntryCode(),
    sendVerificationRequest: sendMagicLink,
  }),
  googleProvider(),
  testGoogleProvider(),
].filter(provider => provider !== undefined)

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers,
  // The total deadline is fixed at sign-in and never extended by use; left
  // at the library's 30-day default it signs active people out monthly.
  session: {
    totalDurationMs: IDENTITY_SESSION_TOTAL_MS,
    inactiveDurationMs: IDENTITY_SESSION_INACTIVE_MS,
  },
  callbacks: {
    createOrUpdateUser: createOrLinkUserForAuth,
    redirect: async ({ redirectTo }) => authRedirectUrl(redirectTo),
  },
})

function googleProvider() {
  const clientId = process.env.AUTH_GOOGLE_ID
  const clientSecret = process.env.AUTH_GOOGLE_SECRET
  if (!clientId || !clientSecret || clientId === 'REPLACE_ME' || clientSecret === 'REPLACE_ME') {
    return undefined
  }
  return Google({ clientId, clientSecret })
}

function testGoogleProvider() {
  if (process.env.DUET_TEST_AUTH_GOOGLE !== '1') return undefined
  return ConvexCredentials({
    id: 'test-google',
    authorize: async (credentials, ctx) => {
      if (!testAuthGoogleEnabled()) return null
      const profile = profileFromCredentials(credentials)
      const accountId = profile.providerAccountId
      const existing = await retrieveAccount(ctx, {
        provider: 'test-google',
        account: { id: accountId },
      }).catch(() => null)
      if (existing !== null) return { userId: existing.user._id }

      const accountProfile: {
        email: string
        emailVerificationTime?: number
        name?: string
        image?: string
      } = {
        email: profile.email,
      }
      if (profile.emailVerified) accountProfile.emailVerificationTime = Date.now()
      if (profile.name !== undefined) accountProfile.name = profile.name
      if (profile.image !== undefined) accountProfile.image = profile.image

      const created = await createAccount(ctx, {
        provider: 'test-google',
        account: { id: accountId },
        profile: accountProfile,
        shouldLinkViaEmail: true,
      })
      return { userId: created.user._id }
    },
  })
}
