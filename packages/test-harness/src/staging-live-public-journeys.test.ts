import { describe, expect, test } from 'bun:test'

import { readPublicBrowserEnv, readPublicHttpEnv } from './staging-live-public-journeys'

describe('public staging journey fixtures', () => {
  test('public forms require no browser, workspace, mail, or billing configuration', () => {
    expect(
      readPublicHttpEnv({
        DUET_LANDER_URL: 'https://staging.duet.so/',
        VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret',
      }),
    ).toMatchObject({
      landerUrl: 'https://staging.duet.so',
      vercelBypassSecret: 'bypass-secret',
    })
  })

  test('public route sweeps add only deployed browser origins', () => {
    expect(
      readPublicBrowserEnv({
        DUET_API_URL: 'https://ctl-staging.duet.so/',
        DUET_APP_URL: 'https://app-staging.duet.so/',
        DUET_LANDER_URL: 'https://staging.duet.so/',
        DUET_DOCS_URL: 'https://docs-staging.duet.so/',
        VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret',
      }),
    ).toMatchObject({
      apiUrl: 'https://ctl-staging.duet.so',
      appUrl: 'https://app-staging.duet.so',
      landerUrl: 'https://staging.duet.so',
      docsUrl: 'https://docs-staging.duet.so',
    })
  })

  test('public fixtures reject production origins', () => {
    expect(() =>
      readPublicHttpEnv({
        DUET_LANDER_URL: 'https://production.example.test',
        VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret',
      }),
    ).toThrow('must target a staging hostname')
  })
})
