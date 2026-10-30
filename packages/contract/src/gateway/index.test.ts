import { describe, expect, test } from 'bun:test'

import {
  BLOCKED_UPSTREAM_PATHS,
  applyGatewayBlockMarker,
  GatewayBlockSchema,
  GatewayPreflightResultSchema,
  SERVICE_PROXY_STRIPPED_REQUEST_HEADERS,
  STRIPPED_UPSTREAM_REQUEST_HEADERS,
  STRIPPED_UPSTREAM_RESPONSE_HEADERS,
  X_DUET_GATEWAY_CODE_HEADER,
  X_DUET_GATEWAY_HEADER,
  type GatewayBlock,
} from './index'

describe('gateway contract', () => {
  test('pins blocked paths and hop header stripping', () => {
    expect(BLOCKED_UPSTREAM_PATHS.has('/v1/credits')).toBe(true)
    expect(STRIPPED_UPSTREAM_REQUEST_HEADERS.has('authorization')).toBe(true)
    expect(STRIPPED_UPSTREAM_REQUEST_HEADERS.has('x-api-key')).toBe(true)
    expect(STRIPPED_UPSTREAM_REQUEST_HEADERS.has('x-duet-tier')).toBe(true)
    expect(SERVICE_PROXY_STRIPPED_REQUEST_HEADERS).toEqual(
      new Set([...STRIPPED_UPSTREAM_REQUEST_HEADERS, 'xi-api-key']),
    )
    expect(STRIPPED_UPSTREAM_RESPONSE_HEADERS.has('content-encoding')).toBe(true)
    expect(STRIPPED_UPSTREAM_RESPONSE_HEADERS.has('content-length')).toBe(true)
    expect(STRIPPED_UPSTREAM_RESPONSE_HEADERS.has('transfer-encoding')).toBe(true)
  })

  test('accepts model policy block envelopes', () => {
    expect(
      GatewayPreflightResultSchema.parse({
        proceed: false,
        block: {
          status: 403,
          body: { error: 'tier_not_allowed', code: 'tier_not_allowed' },
        },
      }),
    ).toMatchObject({
      block: { status: 403, body: { code: 'tier_not_allowed' } },
    })
    expect(
      GatewayPreflightResultSchema.parse({
        proceed: false,
        block: {
          status: 403,
          body: { error: 'model_not_allowed', code: 'model_not_allowed' },
        },
      }),
    ).toEqual({
      proceed: false,
      block: {
        status: 403,
        body: { error: 'model_not_allowed', code: 'model_not_allowed' },
      },
    })
  })

  test('round-trips every exhaustively handled gateway block code', () => {
    type GatewayBlockCode = GatewayBlock['body']['code']
    const blockLabels = {
      missing_api_key: 'Missing API key',
      invalid_api_key: 'Invalid API key',
      expired_api_key: 'Expired API key',
      insufficient_credits: 'Insufficient credits',
      monthly_cap: 'Monthly cap',
      subscription_required: 'Subscription required',
      subscription_inactive: 'Workspace paused',
      payment_required: 'Payment required',
      onboarding_required: 'Onboarding required',
      model_not_allowed: 'Model not allowed',
      tier_not_allowed: 'Tier not allowed',
      endpoint_not_available: 'Endpoint unavailable',
      insufficient_scope: 'Insufficient scope',
      workspace_ambiguous: 'Workspace ambiguous',
      workspace_mismatch: 'Workspace mismatch',
      service_not_found: 'Service not found',
      service_unavailable: 'Service unavailable',
      rate_limited: 'Rate limited',
    } satisfies Record<GatewayBlockCode, string>
    const block = {
      status: 402,
      body: {
        error: 'subscription_required',
        code: 'subscription_required',
        billingUrl: 'https://app.duet.so/settings/billing',
      },
    } as const

    expect(GatewayBlockSchema.parse(block)).toEqual(block)
    expect(blockLabels[block.body.code]).toBe('Subscription required')
  })

  test('round-trips service proxy block envelopes', () => {
    for (const block of [
      {
        status: 404,
        body: { error: 'The requested service does not exist.', code: 'service_not_found' },
      },
      {
        status: 503,
        body: { error: 'The requested service is unavailable.', code: 'service_unavailable' },
      },
      {
        status: 403,
        body: { error: 'Select a workspace for this request.', code: 'workspace_ambiguous' },
      },
    ] as const) {
      expect(GatewayPreflightResultSchema.parse({ proceed: false, block })).toEqual({
        proceed: false,
        block,
      })
    }
  })

  test('marks gateway blocks without replacing existing headers', () => {
    const headers = new Headers({ 'cache-control': 'no-store' })
    applyGatewayBlockMarker(headers, {
      status: 403,
      body: { error: 'Choose a workspace.', code: 'workspace_ambiguous' },
    })

    expect(headers.get('cache-control')).toBe('no-store')
    expect(headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('workspace_ambiguous')
  })
})
