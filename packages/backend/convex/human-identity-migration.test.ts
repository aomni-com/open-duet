import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'

import { beforeHumanIdentityCutoverSchema } from './human-identity-schema.test-helper'
import schema from './schema'

test('device login migration expires every legacy grant field and preserves identity-only rows', async () => {
  const t = convexTest(beforeHumanIdentityCutoverSchema, {
    './_generated/api.ts': async () => ({}),
    './migrations.ts': () => import('./migrations'),
  })
  const strictRows = convexTest(schema, { './_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const canonicalId = await ctx.db.insert('deviceCodes', {
      code: 'identity-login',
      userCode: 'IDENTITY',
      status: 'pending',
      expiresAt: 1_000_000,
      intervalSeconds: 5,
      clientName: 'Duet CLI',
    })
    const canonical = await ctx.db.get(canonicalId)
    const fields = [{ scopes: [] }, { capabilities: [] }, { workspaceIds: [] }, { deviceName: '' }]
    for (const [index, legacy] of fields.entries()) {
      const id = await ctx.db.insert('deviceCodes', {
        code: `legacy-${index}`,
        userCode: `LEGACY-${index}`,
        status: 'approved',
        expiresAt: 1,
        intervalSeconds: 5,
        ...legacy,
      })
      const before = (await ctx.db.get(id))!
      await ctx.runMutation(
        makeFunctionReference<'mutation'>('migrations:expireLegacyDeviceCodes031026'),
        { cursor: null, batchSize: 100, oneBatchOnly: true, dryRun: false },
      )
      const row = await ctx.db.get(id)
      const expected = { ...before, status: 'expired' as const }
      delete expected.scopes
      delete expected.capabilities
      delete expected.workspaceIds
      delete expected.deviceName
      expect(row).toEqual(expected)
      const { _id, _creationTime, ...strictFields } = expected
      await strictRows.run(async strict => {
        const accepted = await strict.db.insert('deviceCodes', strictFields)
        expect(await strict.db.get(accepted)).toMatchObject(strictFields)
      })
    }
    expect(await ctx.db.get(canonicalId)).toEqual(canonical)
  })
})
