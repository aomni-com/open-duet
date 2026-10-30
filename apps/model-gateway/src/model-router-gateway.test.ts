import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getFunctionName } from 'convex/server'

import { MODEL_TIERS, type ModelRouterPolicy } from '@repo/contract'

import {
  MODEL_ROUTER_POLICY_QUERY,
  addOpenAiStreamUsage,
  classifyModelRouterRequest,
  configuredUpstreamRequest,
  fetchModelRouterPolicy,
} from './model-router-gateway'

const OPENAI_MODEL = 'openai/fixture-model'
const ANTHROPIC_MODEL = 'anthropic/fixture-model'
const originalClosure = MODEL_TIERS.balanced.closure
beforeEach(() => {
  MODEL_TIERS.balanced.closure = [OPENAI_MODEL, ANTHROPIC_MODEL]
})
afterEach(() => {
  MODEL_TIERS.balanced.closure = originalClosure
})

const policy: ModelRouterPolicy = {
  version: 1,
  updatedAt: 1,
  rules: [
    {
      id: 'openai',
      enabled: true,
      modelGlob: 'openai/*',
      baseUrl: 'https://configured.example',
      headers: [{ name: 'authorization', value: 'Bearer route-secret' }],
    },
    {
      id: 'anthropic',
      enabled: true,
      modelGlob: 'anthropic/*',
      baseUrl: 'https://configured.example/',
      headers: [{ name: 'x-api-key', value: 'anthropic-secret' }],
    },
  ],
}

function request(
  path: string,
  headers: Record<string, string> = {},
  method: 'POST' | 'PUT' = 'POST',
) {
  return new Request(`https://gateway.example${path}`, {
    method,
    headers: { 'x-duet-tier': 'balanced', ...headers },
    body: '{}',
  })
}

describe('model gateway model-router seam', () => {
  test('checks tier closure before glob and routes only an exact flat-rate model', () => {
    const result = classifyModelRouterRequest({
      request: request('/v1/chat/completions'),
      model: OPENAI_MODEL,
      policy,
    })
    expect(result.kind).toBe('configured')

    const outsideClosure = classifyModelRouterRequest({
      request: request('/v1/chat/completions'),
      model: 'openai/released-tomorrow',
      policy: {
        ...policy,
        rules: [
          {
            ...policy.rules[0]!,
            modelGlob: 'openai/*',
          },
        ],
      },
    })
    expect(outsideClosure).toEqual({ kind: 'vercel', reason: 'tier_not_flat_rate' })
  })

  test.each([
    [
      'invalid tier',
      request('/v1/chat/completions', { 'x-duet-tier': '' }),
      OPENAI_MODEL,
      'invalid_tier',
    ],
    [
      'services tier',
      request('/v1/chat/completions', { 'x-duet-tier': 'services' }),
      OPENAI_MODEL,
      'tier_not_flat_rate',
    ],
    // Closure gating intentionally runs before family classification.
    [
      'unsupported family',
      request('/v1/chat/completions'),
      'google/gemini-2',
      'tier_not_flat_rate',
    ],
    ['unsupported path', request('/v1/embeddings'), OPENAI_MODEL, 'unsupported_path'],
    [
      'unsupported method',
      request('/v1/chat/completions', {}, 'PUT'),
      OPENAI_MODEL,
      'unsupported_method',
    ],
    ['family mismatch', request('/v1/messages'), OPENAI_MODEL, 'family_path_mismatch'],
  ] as const)('uses Vercel for %s', (_label, req, model, reason) => {
    expect(classifyModelRouterRequest({ request: req, model, policy })).toEqual({
      kind: 'vercel',
      reason,
    })
  })

  test('uses Anthropic messages and preserves ordered first match', () => {
    const anthropic = classifyModelRouterRequest({
      request: request('/v1/messages'),
      model: ANTHROPIC_MODEL,
      policy,
    })
    expect(anthropic).toMatchObject({
      kind: 'configured',
      family: 'anthropic',
      rule: { id: 'anthropic' },
    })

    const openaiOnMessages = classifyModelRouterRequest({
      request: request('/v1/messages'),
      model: ANTHROPIC_MODEL,
      policy: {
        ...policy,
        rules: [{ ...policy.rules[0]!, modelGlob: '*' }, ...policy.rules.slice(1)],
      },
    })
    expect(openaiOnMessages).toMatchObject({ kind: 'configured', rule: { id: 'openai' } })
  })

  test('forwards only saved route headers and preserves path/query', async () => {
    const source = request('/v1/chat/completions?x=1', {
      authorization: 'Bearer caller-secret',
      'x-duet-workspace': 'private',
      'content-type': 'application/json',
    })
    const forwarded = configuredUpstreamRequest({ request: source, rule: policy.rules[0]! })
    expect(forwarded.url).toBe('https://configured.example/v1/chat/completions?x=1')
    expect(forwarded.headers.get('authorization')).toBe('Bearer route-secret')
    expect(forwarded.headers.get('x-duet-workspace')).toBeNull()
    expect(forwarded.headers.get('content-type')).toBeNull()
    expect(await forwarded.text()).toBe('{}')
  })

  test('rewrites Duet provider model ids to the native upstream id', async () => {
    const source = new Request('https://gateway.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL }),
    })
    const forwarded = configuredUpstreamRequest({
      request: source,
      rule: policy.rules[0]!,
      family: 'openai',
      body: JSON.stringify({ model: OPENAI_MODEL }),
    })
    expect(JSON.parse(await forwarded.text())).toMatchObject({ model: 'fixture-model' })
  })

  test('policy query is fail-open to an empty policy and uses the backend seam', async () => {
    let called = false
    const loaded = await fetchModelRouterPolicy({
      internalKey: 'internal',
      convex: {
        async query(ref, args) {
          called = true
          expect(getFunctionName(ref)).toBe(MODEL_ROUTER_POLICY_QUERY)
          expect(args).toEqual({ internalKey: 'internal' })
          return policy
        },
      },
    })
    expect(called).toBe(true)
    expect(loaded).toEqual(policy)

    const failed = await fetchModelRouterPolicy({
      internalKey: 'internal',
      convex: {
        async query() {
          throw new Error('backend down')
        },
      },
    })
    expect(failed.rules).toEqual([])
  })

  test('requests OpenAI stream usage without mutating non-streaming requests', () => {
    expect(addOpenAiStreamUsage({ stream: true }, '/v1/chat/completions')).toEqual({
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(
      addOpenAiStreamUsage(
        { stream: true, stream_options: { foo: 'bar' } },
        '/v1/chat/completions',
      ),
    ).toEqual({
      stream: true,
      stream_options: { foo: 'bar', include_usage: true },
    })
    const body = { stream: false }
    expect(addOpenAiStreamUsage(body, '/v1/chat/completions')).toBe(body)
    expect(addOpenAiStreamUsage({ stream: true }, '/v1/messages')).toEqual({ stream: true })
  })
})
