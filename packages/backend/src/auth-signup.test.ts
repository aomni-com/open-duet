import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import { api, internal } from '../convex/_generated/api'
import schema from '../convex/schema'

test('a new Google user gets an account and exchange code without an invitation', async () => {
  const previous = { id: process.env.AUTH_GOOGLE_ID, secret: process.env.AUTH_GOOGLE_SECRET }
  process.env.AUTH_GOOGLE_ID = 'fixture-google-id'
  process.env.AUTH_GOOGLE_SECRET = 'fixture-google-secret'
  try {
    const t = convexTest(schema, {
      '../convex/_generated/api.ts': async () => ({}),
      '../convex/auth.ts': () => import('../convex/auth'),
    })
    const verifierId = await t.run(ctx =>
      ctx.db.insert('authVerifiers', { signature: 'signup-oauth-signature' }),
    )
    const result = await t.mutation(internal.auth.store, {
      args: {
        type: 'userOAuth',
        provider: 'google',
        providerAccountId: 'new-provider-account',
        profile: { email: 'new-google@example.test', emailVerified: true },
        signature: 'signup-oauth-signature',
      },
    })
    expect(result).toBeString()
    await t.run(async ctx => {
      expect(await ctx.db.get(verifierId)).toBeNull()
      const user = await ctx.db.query('users').unique()
      expect(user).toMatchObject({ email: 'new-google@example.test' })
      expect(user?.emailVerificationTime).toBeNumber()
      const account = await ctx.db.query('authAccounts').unique()
      expect(account).toMatchObject({
        userId: user?._id,
        provider: 'google',
        providerAccountId: 'new-provider-account',
      })
      expect(await ctx.db.query('authVerificationCodes').unique()).toMatchObject({
        accountId: account?._id,
        provider: 'google',
      })
    })
  } finally {
    if (previous.id === undefined) delete process.env.AUTH_GOOGLE_ID
    else process.env.AUTH_GOOGLE_ID = previous.id
    if (previous.secret === undefined) delete process.env.AUTH_GOOGLE_SECRET
    else process.env.AUTH_GOOGLE_SECRET = previous.secret
  }
})

test('a new email user gets an account and a sign-in code without an invitation', async () => {
  const t = convexTest(schema, {
    '../convex/_generated/api.ts': async () => ({}),
    '../convex/auth.ts': () => import('../convex/auth'),
  })
  const email = 'new-email@example.test'
  const identifier = await t.mutation(internal.auth.store, {
    args: {
      type: 'createVerificationCode',
      provider: 'email',
      email,
      code: 'RNP4-4Y37',
      expirationTime: Date.now() + 60_000,
      allowExtraProviders: false,
    },
  })
  expect(identifier).toBe(email)
  await t.run(async ctx => {
    const user = await ctx.db.query('users').unique()
    expect(user).toMatchObject({ email })
    const account = await ctx.db.query('authAccounts').unique()
    expect(account).toMatchObject({
      userId: user?._id,
      provider: 'email',
      providerAccountId: email,
    })
    expect(await ctx.db.query('authVerificationCodes').unique()).toMatchObject({
      accountId: account?._id,
      emailVerified: email,
    })
  })
})

test('the test-Google provider refuses sign-in on a non-local deployment', async () => {
  const previous = {
    google: process.env.DUET_TEST_AUTH_GOOGLE,
    cloud: process.env.CONVEX_CLOUD_URL,
  }
  process.env.DUET_TEST_AUTH_GOOGLE = '1'
  process.env.CONVEX_CLOUD_URL = 'https://example.convex.cloud'
  try {
    const authModule = '../convex/auth.ts?test-google-guard'
    const t = convexTest(schema, {
      '../convex/_generated/api.ts': async () => ({}),
      '../convex/auth.ts': () => import(authModule),
    })
    await expect(
      t.action(api.auth.signIn, {
        provider: 'test-google',
        params: { email: 'new-google@example.test' },
      }),
    ).rejects.toThrow('not local')
    await t.run(async ctx => {
      expect(await ctx.db.query('users').first()).toBeNull()
      expect(await ctx.db.query('authAccounts').first()).toBeNull()
    })
  } finally {
    if (previous.google === undefined) delete process.env.DUET_TEST_AUTH_GOOGLE
    else process.env.DUET_TEST_AUTH_GOOGLE = previous.google
    if (previous.cloud === undefined) delete process.env.CONVEX_CLOUD_URL
    else process.env.CONVEX_CLOUD_URL = previous.cloud
  }
})
