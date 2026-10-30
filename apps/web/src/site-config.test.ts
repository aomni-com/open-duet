import { describe, expect, test } from 'bun:test'

import { browserCookieHostname, siteConfig } from './site-config'

describe('web public service origins', () => {
  test('advertises the canonical root MCP resource from its one environment owner', () => {
    expect(siteConfig({ DUET_MCP_PUBLIC_URL: 'https://mcp-staging.duet.so///' }).mcpUrl).toBe(
      'https://mcp-staging.duet.so',
    )
  })
})

describe('web browser cookie hostname', () => {
  test('uses localhost outside a real Vercel deployment', () => {
    expect(browserCookieHostname({})).toBe('localhost')
    expect(
      browserCookieHostname({ VERCEL_ENV: 'development', DUET_APP_URL: 'https://app.duet.so' }),
    ).toBe('localhost')
  })

  test('uses the configured product hostname on Vercel', () => {
    expect(
      browserCookieHostname({ VERCEL: '1', DUET_APP_URL: 'https://app-staging.duet.so/' }),
    ).toBe('app-staging.duet.so')
  })
})
