import { expect, test } from 'bun:test'

import { createModelGatewayApp } from './index'

test('the production catalog admits new and still-installed memory clients through ordinary billing', async () => {
  for (const model of ['openai/gpt-5.4-mini', 'openai/gpt-5.6-luna', 'openai/gpt-6-luna']) {
    const forwarded: unknown[] = []
    let preflights = 0
    const app = createModelGatewayApp({
      aiGatewayApiKey: 'fixture-upstream-key',
      preflight: async () => {
        preflights++
        return { proceed: true }
      },
      fetch: async (_input, init) => {
        forwarded.push(JSON.parse(String(init?.body)))
        return Response.json({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'memory saved' }] }],
        })
      },
    })
    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer duet_sk_fixture_memory',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, input: 'Remember the project convention.' }),
    })
    expect(response.status).toBe(200)
    expect((await response.json()).output[0].content[0].text).toBe('memory saved')
    expect(preflights).toBe(1)
    expect(forwarded).toEqual([{ model, input: 'Remember the project convention.' }])
  }
})
