import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_DUET_APP_URL,
  authRedirectUrl,
  isLocalDeployment,
  signupMxLookupEnabled,
  testAuthEmailEnabled,
  duetAppHref,
  duetAppUrl,
  stripeBillingPortalConfigurationId,
  stripePlanForPriceId,
  stripeSubscriptionPriceIds,
  useTestFakeStripe,
} from './config'

const stripeEnv = {
  STRIPE_STARTER_RECURRING_PRICE_ID: 'price_starter_test',
  STRIPE_PRO_RECURRING_PRICE_ID: 'price_pro_test',
  STRIPE_MAX_RECURRING_PRICE_ID: 'price_max_test',
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_test',
}

describe('Stripe subscription environment binding', () => {
  test('maps every configured recurring price in both directions', () => {
    expect(stripeSubscriptionPriceIds(stripeEnv)).toEqual({
      starter: 'price_starter_test',
      pro: 'price_pro_test',
      max: 'price_max_test',
    })
    expect(stripePlanForPriceId('price_starter_test', stripeEnv)).toBe('starter')
    expect(stripePlanForPriceId('price_pro_test', stripeEnv)).toBe('pro')
    expect(stripePlanForPriceId('price_max_test', stripeEnv)).toBe('max')
    expect(stripePlanForPriceId('price_foreign', stripeEnv)).toBeUndefined()
    expect(stripeBillingPortalConfigurationId(stripeEnv)).toBe('bpc_test')
  })

  test('rejects missing, malformed, and duplicate subscription bindings', () => {
    expect(() => stripeSubscriptionPriceIds({})).toThrow(
      'STRIPE_STARTER_RECURRING_PRICE_ID must be a Stripe price id',
    )
    expect(() =>
      stripeSubscriptionPriceIds({
        ...stripeEnv,
        STRIPE_PRO_RECURRING_PRICE_ID: 'prod_not_a_price',
      }),
    ).toThrow('STRIPE_PRO_RECURRING_PRICE_ID must be a Stripe price id')
    expect(() =>
      stripeSubscriptionPriceIds({
        ...stripeEnv,
        STRIPE_PRO_RECURRING_PRICE_ID: stripeEnv.STRIPE_STARTER_RECURRING_PRICE_ID,
      }),
    ).toThrow('Stripe subscription price ids must be unique')
    expect(() => stripeBillingPortalConfigurationId({})).toThrow(
      'STRIPE_BILLING_PORTAL_CONFIGURATION_ID must be a Stripe Billing Portal configuration id',
    )
  })
})

describe('Duet product origin', () => {
  test('uses the product host by default and trims configured trailing slashes', () => {
    expect(duetAppUrl({})).toBe(DEFAULT_DUET_APP_URL)
    expect(duetAppUrl({ DUET_APP_URL: 'https://app-staging.duet.so///' })).toBe(
      'https://app-staging.duet.so',
    )
  })

  test('builds invite and billing links only from absolute paths', () => {
    const env = { DUET_APP_URL: 'https://app-staging.duet.so' }
    expect(duetAppHref('/invite/token', env)).toBe('https://app-staging.duet.so/invite/token')
    expect(duetAppHref('/settings/billing?return=1', env)).toBe(
      'https://app-staging.duet.so/settings/billing?return=1',
    )
    for (const value of ['https://evil.example', '//evil.example', 'settings', '/\\evil']) {
      expect(() => duetAppHref(value, env)).toThrow()
    }
  })

  test('does not allow production auth to redirect to localhost', () => {
    for (const destination of [
      'http://localhost:3000/auth/magic-link/callback',
      'http://localhost:3000/sign-in?returnTo=%2Fw%2Facme',
    ]) {
      expect(() =>
        authRedirectUrl(destination, {
          DUET_APP_URL: 'https://app.duet.so',
        }),
      ).toThrow('Invalid auth redirect destination')
    }
  })

  test('allows only the two localhost auth callback paths in non-production', () => {
    const magicLinkCallback =
      'http://localhost:3000/auth/magic-link/callback?returnTo=%2Fw%2Facme&intent=local-browser'
    const oauthCallback = 'http://localhost:3000/sign-in?returnTo=%2Fw%2Facme'
    const stagingEnv = { DUET_APP_URL: 'https://app-staging.duet.so' }

    expect(authRedirectUrl(magicLinkCallback, stagingEnv)).toBe(magicLinkCallback)
    expect(authRedirectUrl(oauthCallback, stagingEnv)).toBe(oauthCallback)
    for (const destination of [
      'http://localhost:3000/sign-out?code=secret',
      'http://localhost:3000/sign-in/extra',
      'http://localhost:3001/sign-in',
      'http://127.0.0.1:3000/sign-in',
      'https://localhost:3000/sign-in',
    ]) {
      expect(() => authRedirectUrl(destination, stagingEnv)).toThrow(
        'Invalid auth redirect destination',
      )
    }
  })

  test('keeps relative OAuth redirects on the configured product origin', () => {
    expect(
      authRedirectUrl('/sign-in?returnTo=%2Fw%2Facme', {
        DUET_APP_URL: 'https://app-staging.duet.so',
      }),
    ).toBe('https://app-staging.duet.so/sign-in?returnTo=%2Fw%2Facme')
  })
})

// The probe that settled this: on a harness fixture a Convex function reports
// CONVEX_CLOUD_URL=http://127.0.0.1:<port> and CONVEX_DEPLOYMENT=null. Cloud
// reports https://<name>.convex.cloud. The URLs are the only usable signal.
const LOCAL = { CONVEX_CLOUD_URL: 'http://127.0.0.1:51852' }
const CLOUD = { CONVEX_CLOUD_URL: 'https://elated-hippopotamus-235.convex.cloud' }

describe('test-auth containment', () => {
  test('reads a deployment address as local only when it is loopback', () => {
    expect(isLocalDeployment(LOCAL)).toBe(true)
    expect(isLocalDeployment({ CONVEX_SITE_URL: 'http://localhost:51853' })).toBe(true)
    expect(isLocalDeployment(CLOUD)).toBe(false)
    expect(isLocalDeployment({ CONVEX_SITE_URL: 'https://x.convex.site' })).toBe(false)
  })

  test('fails closed when the deployment cannot say where it lives', () => {
    // Absent or unparseable is not "probably local". A deployment that cannot
    // prove it is local is treated as production.
    expect(isLocalDeployment({})).toBe(false)
    expect(isLocalDeployment({ CONVEX_CLOUD_URL: 'not-a-url' })).toBe(false)
    expect(() => testAuthEmailEnabled({ DUET_TEST_AUTH_EMAIL: '1' })).toThrow(/not local/)
  })

  test('refuses the test-auth switch on a cloud deployment', () => {
    // The switch pins the sign-in code to a constant AND suppresses the emails
    // that would warn the account owner, so on a real deployment it is an
    // unauthenticated takeover of anyone whose address you know.
    expect(() => testAuthEmailEnabled({ ...CLOUD, DUET_TEST_AUTH_EMAIL: '1' })).toThrow(/not local/)
  })

  test('allows it locally, and stays silent when it is unset', () => {
    expect(testAuthEmailEnabled({ ...LOCAL, DUET_TEST_AUTH_EMAIL: '1' })).toBe(true)
    expect(testAuthEmailEnabled(CLOUD)).toBe(false)
    expect(testAuthEmailEnabled({})).toBe(false)
  })

  test('guards every reader of the switch, not just the one that mints codes', () => {
    expect(() =>
      useTestFakeStripe({ ...CLOUD, DUET_TEST_FAKE_STRIPE: '1', DUET_TEST_AUTH_EMAIL: '1' }),
    ).toThrow(/not local/)
    expect(() => signupMxLookupEnabled({ ...CLOUD, DUET_TEST_AUTH_EMAIL: '1' })).toThrow(
      /not local/,
    )
    expect(signupMxLookupEnabled({ ...LOCAL, DUET_TEST_AUTH_EMAIL: '1' })).toBe(false)
    expect(signupMxLookupEnabled(CLOUD)).toBe(true)
  })
})
