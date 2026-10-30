import { expect, test } from 'bun:test'
import { makeFunctionReference } from 'convex/server'
import { convexTest } from 'convex-test'

import schema from '../../schema'

const INTERNAL_KEY = 'service-vault-model-test'
const put = makeFunctionReference<'mutation'>('domains/serviceVault/model:putServiceCredential')
const get = makeFunctionReference<'query'>('domains/serviceVault/model:getServiceCredential')

function harness() {
  return convexTest(schema, {
    '../../_generated/api.ts': async () => ({}),
    '../../domains/serviceVault/model.ts': () => import('./model'),
  })
}

test('credential reads expose rotation metadata without an unused scopes field', async () => {
  const previous = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = INTERNAL_KEY
  try {
    const t = harness()
    const written = await t.mutation(put, {
      internalKey: INTERNAL_KEY,
      serviceId: 'elevenlabs',
      name: 'apiKey',
      value: 'test-secret',
      now: 1,
    })
    expect(written.generation).toBe(1)

    const credential = await t.query(get, {
      internalKey: INTERNAL_KEY,
      serviceId: 'elevenlabs',
      name: 'apiKey',
    })
    expect(credential).toMatchObject({ secret: 'test-secret', generation: 1 })
    expect(credential).not.toHaveProperty('scopes')
  } finally {
    if (previous === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previous
  }
})
