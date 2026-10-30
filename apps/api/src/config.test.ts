import { describe, expect, test } from 'bun:test'

import { DUET_API_ORIGIN, DUET_EDGE_HOST, CONVEX_EVENT_BUDGET_BYTES } from '@repo/contract'
import {
  OFFICIAL_AGENTS_PUBLISH_SLUG,
  OFFICIAL_AGENTS_WORKSPACE_SLUG,
} from '@repo/official-agents-seed/manifest'

import {
  DEFAULT_DUET_APP_URL,
  DEFAULT_DUET_MCP_PUBLIC_URL,
  DEFAULT_MCP_TOOL_RESULT_BYTES,
  DEFAULT_OFFICIAL_HUB_OWNER_EMAIL,
  resolveApiUrl,
  resolveAppUrl,
  resolveEdgeHost,
  resolveMcpPublicUrl,
  resolveMcpToolResultBytes,
  resolveOfficialHubBaseUrl,
  resolveOfficialHubOwnerEmail,
} from './config'

describe('OAuth public origins', () => {
  test('uses canonical configured origins and never a request host', () => {
    expect(resolveApiUrl({})).toBe(DUET_API_ORIGIN)
    expect(resolveApiUrl({ DUET_API_URL: 'https://ctl-staging.duet.so///' })).toBe(
      'https://ctl-staging.duet.so',
    )
    expect(resolveMcpPublicUrl({ NODE_ENV: 'test' })).toBe(DEFAULT_DUET_MCP_PUBLIC_URL)
    expect(resolveMcpPublicUrl({ DUET_MCP_PUBLIC_URL: 'https://mcp-staging.duet.so///' })).toBe(
      'https://mcp-staging.duet.so/',
    )
  })

  test('fails closed when deployed environment-specific origins are absent', () => {
    expect(() => resolveApiUrl({ VERCEL_ENV: 'preview' })).toThrow('DUET_API_URL is required')
    expect(() => resolveMcpPublicUrl({ VERCEL_ENV: 'production' })).toThrow(
      'DUET_MCP_PUBLIC_URL is required',
    )
  })
})

describe('product app origin', () => {
  test('uses explicit app configuration without request-origin inference', () => {
    expect(resolveAppUrl(undefined, {})).toBe(DEFAULT_DUET_APP_URL)
    expect(resolveAppUrl(undefined, { DUET_APP_URL: 'https://app-staging.duet.so///' })).toBe(
      'https://app-staging.duet.so',
    )
    expect(resolveAppUrl('http://localhost:3000/', {})).toBe('http://localhost:3000')
  })
})

describe('edge host', () => {
  test('defaults to the production edge host and overrides per environment', () => {
    expect(resolveEdgeHost({})).toBe(DUET_EDGE_HOST)
    expect(resolveEdgeHost({ DUET_EDGE_HOST: 'edge-staging.duet.so' })).toBe('edge-staging.duet.so')
  })

  test('derives the hub URL from the environment edge host', () => {
    expect(resolveOfficialHubBaseUrl({})).toBe(
      `https://${DUET_EDGE_HOST}/${OFFICIAL_AGENTS_WORKSPACE_SLUG}/${OFFICIAL_AGENTS_PUBLISH_SLUG}`,
    )
    expect(resolveOfficialHubBaseUrl({ DUET_EDGE_HOST: 'edge-staging.duet.so' })).toBe(
      `https://edge-staging.duet.so/${OFFICIAL_AGENTS_WORKSPACE_SLUG}/${OFFICIAL_AGENTS_PUBLISH_SLUG}`,
    )
  })
})

describe('official hub owner', () => {
  test('has an explicit deployment placeholder and environment override', () => {
    expect(resolveOfficialHubOwnerEmail({})).toBe(DEFAULT_OFFICIAL_HUB_OWNER_EMAIL)
    expect(resolveOfficialHubOwnerEmail({ DUET_OFFICIAL_HUB_OWNER_EMAIL: 'hub@aomni.com' })).toBe(
      'hub@aomni.com',
    )
  })
})

describe('MCP tool result cap', () => {
  // An ordering, not a value. Whatever a tool is allowed to hand the model has
  // to fit in the event that carries it to the timeline, or a result the model
  // read in full would reach the reader silently shortened — and a `[truncated]`
  // marker would stop meaning anything. Two numbers in two packages that must
  // relate, with nothing that fails when they drift, is exactly the shape that
  // drifts; if these ever need to move, move them downward together.
  test('never lets the model read more than the timeline can store', () => {
    expect(DEFAULT_MCP_TOOL_RESULT_BYTES).toBeLessThanOrEqual(CONVEX_EVENT_BUDGET_BYTES)
  })

  // Pinning the default alone left the ordering open where it actually
  // matters: the override is the value the proxy uses, so an operator raising
  // it past the relay budget would invert the rule with nothing failing.
  test('clamps an override to the relay budget rather than trusting it', () => {
    expect(resolveMcpToolResultBytes({ DUET_MCP_TOOL_RESULT_BYTES: '65536' })).toBe(65_536)
    expect(resolveMcpToolResultBytes({ DUET_MCP_TOOL_RESULT_BYTES: '99999999' })).toBe(
      CONVEX_EVENT_BUDGET_BYTES,
    )
  })

  // The dangerous input is not a big number, it is a junk one. `Number('lots')`
  // is NaN, every comparison against NaN is false, and a cap that never fires
  // is the one outcome this constant exists to prevent — so it must not be
  // possible to disable the cap by typo.
  test('a junk or empty override falls back to the default instead of disabling the cap', () => {
    for (const value of ['lots', '', '0', '-1', 'NaN']) {
      expect(resolveMcpToolResultBytes({ DUET_MCP_TOOL_RESULT_BYTES: value })).toBe(
        DEFAULT_MCP_TOOL_RESULT_BYTES,
      )
    }
    expect(resolveMcpToolResultBytes({})).toBe(DEFAULT_MCP_TOOL_RESULT_BYTES)
  })
})
