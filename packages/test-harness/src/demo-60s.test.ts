import { describe, expect, test } from 'bun:test'

import {
  bootDemoModelGatewayLeg,
  createDemoModelGatewayFixture,
  demo60sProbeCanRun,
  findReconciledLedgerDebitRows,
  queryReconciledLedgerDebit,
  runDemo60sProbe,
  selectDemoModelGatewayPlan,
} from './demo-60s.ts'

describe('demo model-gateway mode selection', () => {
  test('keeps mock mode unchanged and selects local or external gateway only for real mode', () => {
    expect(selectDemoModelGatewayPlan({})).toEqual({ kind: 'disabled' })
    expect(selectDemoModelGatewayPlan({ DUET_DEMO_AGENT_MODE: 'mock' })).toEqual({
      kind: 'disabled',
    })
    expect(selectDemoModelGatewayPlan({ DUET_DEMO_AGENT_MODE: 'real' })).toEqual({
      kind: 'local',
    })
    expect(
      selectDemoModelGatewayPlan({
        DUET_DEMO_AGENT_MODE: 'real',
        DUET_MODEL_GATEWAY_URL: 'https://gateway.example/',
      }),
    ).toEqual({ kind: 'external', url: 'https://gateway.example' })
  })
})

describe('demo model-gateway local leg', () => {
  test('boots a local gateway against the fake VAG without requiring a public tunnel', async () => {
    const fixture = await createDemoModelGatewayFixture({
      aiGatewayApiKey: 'demo-test-platform-key',
      catalogModelId: 'fixture-provider/fixture-model',
      readyAfterPolls: 0,
    })
    let exposureFailure = false
    let leg: Awaited<ReturnType<typeof bootDemoModelGatewayLeg>> | undefined
    try {
      leg = await bootDemoModelGatewayLeg({
        convexUrl: 'http://127.0.0.1:1',
        internalKey: 'demo-internal',
        aiGatewayApiKey: fixture.convexEnv.AI_GATEWAY_API_KEY,
        upstreamBaseUrl: fixture.upstreamBaseUrl,
        fakeVag: fixture.fakeVag,
        expose: async port => ({
          publicUrl: `http://127.0.0.1:${port}`,
          stop: () => {
            if (exposureFailure) throw new Error('fixture tunnel stop failed')
          },
        }),
        gatewayOptions: {
          preflight: async () => ({ proceed: true }),
        },
      })

      const response = await fetch(`${leg.url}/v1/models`, {
        headers: { authorization: 'Bearer duet_sk_demo' },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        object: 'list',
        data: [
          {
            id: 'fixture-provider/fixture-model',
            type: 'language',
            object: 'model',
          },
        ],
      })
      expect(fixture.fakeVag.requests.map(request => request.url.pathname)).toContain('/v1/models')
      exposureFailure = true
      await expect(leg.stop()).rejects.toThrow('fixture tunnel stop failed')
      await expect(fetch(`${leg.localUrl}/v1/models`)).rejects.toThrow()
    } finally {
      exposureFailure = false
      try {
        await leg?.stop()
      } finally {
        fixture.stop()
      }
    }
  })
})

describe('demo model-gateway ledger debit assertion', () => {
  test('finds a settled generation with a matching usage debit', () => {
    expect(
      findReconciledLedgerDebitRows({
        generations: [
          {
            _id: 'gen_row_1',
            status: 'settled',
            tier: 'balanced',
            upstreamGenerationId: 'vag_generation_1',
          },
        ],
        transactions: [
          {
            reference: 'grant:test',
            type: 'grant',
            amountMicroUsd: 10_000,
          },
          {
            reference: 'ai_generation:vag_generation_1',
            type: 'usage',
            amountMicroUsd: -1234,
          },
        ],
      }),
    ).toEqual({
      generationId: 'gen_row_1',
      tier: 'balanced',
      upstreamGenerationId: 'vag_generation_1',
      transactionReference: 'ai_generation:vag_generation_1',
      transactionType: 'usage',
      amountMicroUsd: -1234,
    })
  })

  test('does not treat an unrelated reservation debit as reconciled', () => {
    expect(
      findReconciledLedgerDebitRows({
        generations: [
          {
            _id: 'gen_row_1',
            status: 'settled',
            tier: 'balanced',
            upstreamGenerationId: 'vag_generation_1',
            reservationId: 'ai_generation:matching-reservation',
          },
        ],
        transactions: [
          {
            reference: 'ai_generation:unrelated-reservation',
            type: 'reservation',
            amountMicroUsd: -1234,
          },
        ],
      }),
    ).toBeNull()
  })

  test('finds a settled reservation generation only through its reservation id', () => {
    expect(
      findReconciledLedgerDebitRows({
        generations: [
          {
            _id: 'gen_row_1',
            status: 'settled',
            tier: 'frontier',
            upstreamGenerationId: 'vag_generation_1',
            reservationId: 'ai_generation:matching-reservation',
          },
        ],
        transactions: [
          {
            reference: 'ai_generation:matching-reservation',
            type: 'reservation',
            amountMicroUsd: -1234,
          },
        ],
      }),
    ).toEqual({
      generationId: 'gen_row_1',
      tier: 'frontier',
      upstreamGenerationId: 'vag_generation_1',
      reservationId: 'ai_generation:matching-reservation',
      transactionReference: 'ai_generation:matching-reservation',
      transactionType: 'reservation',
      amountMicroUsd: -1234,
    })
  })

  test('queries Convex test surfaces before applying the debit assertion', async () => {
    const queried: string[] = []
    const convex = {
      async query(name: string, args: Record<string, unknown>) {
        expect(args).toEqual({ workspaceId: 'workspace_1', internalKey: 'internal' })
        queried.push(name)
        if (name === 'testing/modelGateway:listGenerationsForTest') {
          return [
            {
              _id: 'gen_row_2',
              status: 'settled',
              tier: 'balanced',
              upstreamGenerationId: 'vag_generation_2',
            },
          ]
        }
        if (name === 'testing/credits:listWorkspaceTransactionsForTest') {
          return [
            {
              reference: 'ai_generation:vag_generation_2',
              type: 'usage',
              amountMicroUsd: -900,
            },
          ]
        }
        throw new Error(`unexpected query ${name}`)
      },
    }

    await expect(queryReconciledLedgerDebit(convex, 'workspace_1', 'internal')).resolves.toEqual({
      generationId: 'gen_row_2',
      tier: 'balanced',
      upstreamGenerationId: 'vag_generation_2',
      transactionReference: 'ai_generation:vag_generation_2',
      transactionType: 'usage',
      amountMicroUsd: -900,
    })
    expect(queried.sort()).toEqual([
      'testing/credits:listWorkspaceTransactionsForTest',
      'testing/modelGateway:listGenerationsForTest',
    ])
  })
})

describe.skipIf(!demo60sProbeCanRun())('SLICEDEMO-9K4T 60-second demo acceptance probe', () => {
  test('runs the real VM/install/pair/publish spine with the deferred agent CLI mocked at the frozen contract', async () => {
    const previousMode = process.env.DUET_DEMO_AGENT_MODE
    delete process.env.DUET_DEMO_AGENT_MODE
    try {
      const result = await runDemo60sProbe()

      expect(result.marker).toBe('SLICEDEMO-9K4T')
      expect(result.mode).toBe('mock-agent')
      expect(result.answer).toContain('20 percent')
      expect(result.publicUrl).toContain('https://edge.duet.so/')
      expect(result.vmsCreated).toEqual(result.vmsDeleted)
      expect(result.leakCheck.createdVmLeaks).toEqual([])
      expect(result.timeline.duetInstalledAndPaired).toBeGreaterThan(0)
      expect(result.timeline.publishFetchLive!).toBeGreaterThan(
        result.timeline.businessQuestionMockAnswered!,
      )
    } finally {
      if (previousMode === undefined) delete process.env.DUET_DEMO_AGENT_MODE
      else process.env.DUET_DEMO_AGENT_MODE = previousMode
    }
  }, 900_000)
})
