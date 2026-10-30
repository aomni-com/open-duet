import { describe, expect, test } from 'bun:test'

import { DEFAULT_DUET_MCP_PUBLIC_URL, resolveApiBaseUrl, resolveMcpPublicUrl } from './config'

test('uses the canonical API URL for upstream calls and authorization metadata', () => {
  expect(resolveApiBaseUrl(undefined, { DUET_API_URL: 'https://ctl-staging.duet.so' })).toBe(
    'https://ctl-staging.duet.so',
  )
})

describe('MCP public origin', () => {
  test('uses the production default and canonicalizes the environment-specific origin', () => {
    expect(resolveMcpPublicUrl(undefined, {})).toBe(DEFAULT_DUET_MCP_PUBLIC_URL)
    expect(
      resolveMcpPublicUrl(undefined, {
        DUET_MCP_PUBLIC_URL: 'https://mcp-staging.duet.so///',
      }),
    ).toBe('https://mcp-staging.duet.so/')
  })

  test('fails closed when a deployed environment omits its canonical origin', () => {
    expect(() => resolveMcpPublicUrl(undefined, { VERCEL_ENV: 'production' })).toThrow(
      'DUET_MCP_PUBLIC_URL is required',
    )
    expect(() => resolveMcpPublicUrl(undefined, { VERCEL_ENV: 'preview' })).toThrow(
      'DUET_MCP_PUBLIC_URL is required',
    )
  })

  test('rejects a URL containing anything beyond an HTTPS origin', () => {
    for (const value of [
      'http://mcp.duet.so',
      'https://user@mcp.duet.so',
      'https://mcp.duet.so/path',
      'https://mcp.duet.so?environment=staging',
      'https://mcp.duet.so#staging',
    ]) {
      expect(() => resolveMcpPublicUrl(value, {})).toThrow(
        'DUET_MCP_PUBLIC_URL must be an HTTPS origin',
      )
    }
  })
})
