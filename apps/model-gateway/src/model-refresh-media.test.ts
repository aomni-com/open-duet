import { expect, test } from 'bun:test'

import { APPROVED_MODELS, modelByRole } from '@repo/contract'

import { createModelGatewayApp } from './index'

for (const [role, prior, successor] of [
  ['image:google', 'google/gemini-3.1-flash-image-preview', 'google/gemini-3.1-flash-image'],
  ['video:google', 'google/veo-3.0-generate-001', 'google/veo-3.1-generate-001'],
  ['video:grok', 'xai/grok-imagine-video-1.5', 'spacexai/grok-imagine-video-1.5'],
  ['video:pro', 'bytedance/seedance-v1.5-pro', 'bytedance/seedance-2.5'],
  ['video:seedance', 'bytedance/seedance-2.0', 'bytedance/seedance-2.5'],
] as const) {
  test(`${role} admits successor requests while existing clients retain service`, async () => {
    const current = modelByRole(APPROVED_MODELS, role)
    expect(current).toBeDefined()
    for (const model of new Set([current!.gatewayModelId, prior, successor])) {
      const app = createModelGatewayApp({
        aiGatewayApiKey: 'fixture-upstream',
        preflight: async args => {
          expect(args.billingMode).toBe('reservation')
          return { proceed: true }
        },
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body))
          return Response.json({ model: body.model })
        },
      })
      const response = await app.request('/v4/ai/generate', {
        method: 'POST',
        headers: { authorization: 'Bearer duet_sk_fixture', 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'fixture' }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ model })
    }
  })
}
