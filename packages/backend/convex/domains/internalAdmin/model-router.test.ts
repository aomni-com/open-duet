import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'

import schema from '../../schema'

function fixture() {
  return convexTest(schema, {
    '../../_generated/api.ts': async () => ({}),
    '../../domains/internalAdmin/model.ts': () => import('./model'),
  })
}

async function seed(t: ReturnType<typeof fixture>, email = 'operator@duet.so') {
  return await t.run(
    async ctx =>
      await ctx.db.insert('users', {
        email,
        createdAt: 1,
        updatedAt: 1,
        memberDirectoryRevision: 0,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
      }),
  )
}

test('model router policy is singleton, ordered, and audited', async () => {
  const previous = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'router-test-key'
  try {
    const t = fixture()
    const actorId = await seed(t)
    const policy = {
      version: 1 as const,
      rules: [
        {
          id: 'openai',
          enabled: true,
          modelGlob: 'openai/*',
          baseUrl: 'https://upstream.example.test',
          headers: [{ name: 'authorization', value: 'Bearer secret' }],
        },
      ],
      reason: 'Enable upstream routing',
    }
    const result = await t.mutation(
      makeFunctionReference<'mutation'>('domains/internalAdmin/model:setModelRouterPolicy'),
      {
        internalKey: 'router-test-key',
        actorId,
        requestId: 'router-write-1',
        reason: policy.reason,
        now: 10,
        policy,
      },
    )
    expect(result).toMatchObject({ version: 1, updatedAt: 10, rules: policy.rules })
    const read = await t.query(
      makeFunctionReference<'query'>('domains/internalAdmin/model:modelRouterPolicy'),
      { internalKey: 'router-test-key', actorId },
    )
    expect(read).toMatchObject({ version: 1, updatedAt: 10, rules: policy.rules })
    const updatedRules = [
      { ...policy.rules[0]!, id: 'priority', modelGlob: 'openai/specific-model' },
      { ...policy.rules[0]!, id: 'fallback' },
    ]
    await t.mutation(
      makeFunctionReference<'mutation'>('domains/internalAdmin/model:setModelRouterPolicy'),
      {
        internalKey: 'router-test-key',
        actorId,
        requestId: 'router-write-update',
        reason: 'Reorder routes',
        now: 11,
        policy: { ...policy, rules: updatedRules },
      },
    )
    expect(
      await t.query(
        makeFunctionReference<'query'>('domains/internalAdmin/model:modelRouterPolicy'),
        { internalKey: 'router-test-key', actorId },
      ),
    ).toMatchObject({ rules: updatedRules, updatedAt: 11 })
    expect(await t.run(ctx => ctx.db.query('modelRouterPolicies').collect())).toHaveLength(1)
    expect(await t.run(ctx => ctx.db.query('adminAuditEvents').collect())).toContainEqual(
      expect.objectContaining({ action: 'admin.model_router.update', target: 'global' }),
    )
  } finally {
    if (previous === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previous
  }
})

test('model router policy rejects reserved and duplicate headers', async () => {
  const previous = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'router-test-key'
  try {
    const t = fixture()
    const actorId = await seed(t)
    const call = (headers: Array<{ name: string; value: string }>, requestId: string) =>
      t.mutation(
        makeFunctionReference<'mutation'>('domains/internalAdmin/model:setModelRouterPolicy'),
        {
          internalKey: 'router-test-key',
          actorId,
          requestId,
          reason: 'Reject unsafe route headers',
          now: 10,
          policy: {
            version: 1,
            rules: [
              {
                id: 'r',
                enabled: true,
                modelGlob: 'openai/*',
                baseUrl: 'https://upstream.example.test',
                headers,
              },
            ],
          },
        },
      )
    await expect(call([{ name: 'keep-alive', value: 'evil' }], 'router-write-2')).rejects.toThrow()
    await expect(
      call(
        [
          { name: 'Authorization', value: 'a' },
          { name: 'authorization', value: 'b' },
        ],
        'router-write-3',
      ),
    ).rejects.toThrow()
    expect(await t.run(ctx => ctx.db.query('modelRouterPolicies').collect())).toHaveLength(0)
  } finally {
    if (previous === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previous
  }
})

test('model router policy requires an internal-admin actor', async () => {
  const previous = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'router-test-key'
  try {
    const t = fixture()
    const actorId = await seed(t, 'ordinary@example.com')
    await expect(
      t.query(makeFunctionReference<'query'>('domains/internalAdmin/model:modelRouterPolicy'), {
        internalKey: 'router-test-key',
        actorId,
      }),
    ).rejects.toThrow()
  } finally {
    if (previous === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previous
  }
})
