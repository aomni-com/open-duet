import { expect, test } from 'bun:test'

import { DUET_EDGE_HOST, DUET_STAGING_EDGE_HOST } from '@repo/contract'

import { assertEmailedSignInLink, edgeHost, signupMxLookupEnabled } from '../convex/config'

test('edgeHost returns the configured host for each environment', () => {
  expect(edgeHost({ DUET_EDGE_HOST: DUET_STAGING_EDGE_HOST })).toBe(DUET_STAGING_EDGE_HOST)
  expect(edgeHost({ DUET_EDGE_HOST: DUET_EDGE_HOST })).toBe(DUET_EDGE_HOST)
})

test('edgeHost fails closed when unset rather than defaulting to production', () => {
  // The whole point of this function. The API's resolveEdgeHost defaults to the
  // production constant; if Convex did the same, an unconfigured staging
  // deployment would derive `https://edge.duet.so/...` source URLs and quietly
  // pull production content onto staging VMs.
  expect(() => edgeHost({})).toThrow(/DUET_EDGE_HOST/)
})

test('edgeHost refuses a host that is not a known edge host', () => {
  for (const value of ['', 'evil.com', 'edge.duet.so.evil.com', 'notedge.duet.so', 'app.duet.so']) {
    expect(() => edgeHost({ DUET_EDGE_HOST: value })).toThrow(/DUET_EDGE_HOST/)
  }
})

test('an emailed sign-in link must reach a page that finishes a sign-in', () => {
  const env = { DUET_APP_URL: 'https://app-staging.duet.so' }
  assertEmailedSignInLink('https://app-staging.duet.so/sign-in?code=RNP4-4Y37', env)
  assertEmailedSignInLink(
    'https://app-staging.duet.so/auth/magic-link/callback?intent=a&code=RNP4-4Y37',
    env,
  )
  // The library's fallback when nobody passes `redirectTo`: right origin, no
  // route. It is the failure this guard exists for, and the one an origin check
  // alone cannot see.
  expect(() => assertEmailedSignInLink('https://app-staging.duet.so/?code=RNP4-4Y37', env)).toThrow(
    /does not reach a sign-in page/,
  )
  expect(() => assertEmailedSignInLink('https://evil.example/sign-in', env)).toThrow(
    /Invalid auth redirect destination/,
  )
})

test('the signup MX lookup stays off in a test-auth environment', () => {
  // Fixtures sign up as `@example.com`, which publishes a Null MX and would be
  // denied as a non-functional mail domain — and no test should depend on live
  // DNS. `DUET_TEST_AUTH_EMAIL` is already this repo's "not a real environment"
  // marker, so the gate reads it rather than growing a second one.
  // Carries a local address because reading the flag is now also its guard: an
  // env that claims test-auth without saying it is local is refused outright.
  expect(
    signupMxLookupEnabled({
      DUET_TEST_AUTH_EMAIL: '1',
      CONVEX_CLOUD_URL: 'http://127.0.0.1:3210',
    }),
  ).toBe(false)
  expect(signupMxLookupEnabled({})).toBe(true)
})

test('the signup MX lookup has an operational off switch for real environments', () => {
  expect(signupMxLookupEnabled({ DUET_SIGNUP_MX_LOOKUP: 'off' })).toBe(false)
  expect(signupMxLookupEnabled({ DUET_SIGNUP_MX_LOOKUP: 'on' })).toBe(true)
})
