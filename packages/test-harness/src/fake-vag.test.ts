import { describe, expect, test } from 'bun:test'

import { duetModels } from '@repo/agent/model-resolution/models'

import { bootDemoModelGatewayLeg } from './demo-60s'
import { createFakeVag } from './fake-vag'

describe('fake Vercel AI Gateway', () => {
  test('returns generation token usage in the production field shape', async () => {
    const fake = createFakeVag({
      aiGatewayApiKey: 'test-platform-key',
      scenarios: [
        {
          method: 'POST',
          path: '/v1/responses',
          totalCost: 0.004_321,
          inputTokens: 137,
          outputTokens: 59,
        },
      ],
    })

    await fake.fetch('https://ai-gateway.example.test/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer test-platform-key' },
      body: '{}',
    })
    const generationId = fake.generationIds[0]!
    const response = await fake.fetch(
      `https://ai-gateway.example.test/v1/generation?id=${generationId}`,
      { headers: { authorization: 'Bearer test-platform-key' } },
    )

    expect(await response.json()).toEqual({
      data: {
        total_cost: 0.004_321,
        tokens_prompt: 137,
        tokens_completion: 59,
        native_tokens_prompt: 137,
        native_tokens_completion: 59,
      },
    })
  })
})

test.each(['openai-responses', 'anthropic-messages', 'openai-completions'] as const)(
  'controlled completion is consumable by the real %s SDK',
  async api => {
    const fake = createFakeVag({
      completion: {
        text: 'controlled answer',
        inputTokens: 10,
        outputTokens: 2,
        totalCost: 0.0004,
      },
    })
    const gateway = await bootDemoModelGatewayLeg({
      convexUrl: 'http://127.0.0.1:1',
      internalKey: 'fixture-internal',
      aiGatewayApiKey: 'test-platform-key',
      upstreamBaseUrl: 'https://ai-gateway.fixture.test',
      fakeVag: fake,
      expose: async port => ({ publicUrl: `http://127.0.0.1:${port}`, stop() {} }),
      gatewayOptions: { preflight: async () => ({ proceed: true }) },
    })
    try {
      const stream = await duetModels().streamSimple(
        {
          id: api === 'anthropic-messages' ? 'anthropic/fixture-model' : 'openai/fixture-model',
          name: 'Fixture',
          api,
          provider: 'duet-gateway',
          baseUrl: api === 'anthropic-messages' ? gateway.localUrl : `${gateway.localUrl}/v1`,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 100,
        },
        { messages: [{ role: 'user', content: 'Fixture question', timestamp: 0 }] },
        {
          apiKey: 'duet_sk_fixture',
          maxRetries: 0,
        },
      )
      const result = await stream.result()
      expect(result.stopReason, result.errorMessage).toBe('stop')
      expect(result.content).toEqual([
        expect.objectContaining({ type: 'text', text: 'controlled answer' }),
      ])
      expect(result.usage).toMatchObject({ input: 10, output: 2 })
      const usage = await fake.fetch(
        `https://ai-gateway.fixture.test/v1/generation?id=${fake.generationIds[0]}`,
        {
          headers: { authorization: 'Bearer test-platform-key' },
        },
      )
      expect(await usage.json()).toEqual({
        data: {
          total_cost: 0.0004,
          tokens_prompt: 10,
          tokens_completion: 2,
          native_tokens_prompt: 10,
          native_tokens_completion: 2,
        },
      })
    } finally {
      await gateway.stop()
    }
  },
)
