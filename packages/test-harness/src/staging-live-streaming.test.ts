import { describe, expect, test, spyOn } from 'bun:test'

import { ConvexHttpClient } from 'convex/browser'

import { waitForDebit, waitForTrain } from './staging-live-streaming'

describe('waitForDebit', () => {
  test('reads matching settled debits through the Convex HTTP inspection seam', async () => {
    const generations = [{ _id: 'generation', status: 'settled', tier: 'balanced', upstreamGenerationId: 'upstream' }]
    const server = Bun.serve({ port: 0, async fetch(request) {
      const query = await request.json() as { path: string; args: Array<{ internalKey: string; workspaceId: string }> }
      if (query.args[0]?.internalKey !== 'internal-key' || query.args[0]?.workspaceId !== 'workspace-id') {
        return Response.json({ status: 'error', errorMessage: 'wrong inspection scope' })
      }
      const value = query.path === 'testing/credits:listWorkspaceTransactionsForTest'
        ? [{ reference: 'ai_generation:upstream', type: 'usage', amountMicroUsd: -4321 }]
        : query.path === 'testing/modelGateway:listGenerationsForTest' ? generations : null
      return Response.json({ status: 'success', value })
    } })
    try {
      await expect(waitForDebit(new ConvexHttpClient(server.url.toString()), 'internal-key', 'workspace-id', 0))
        .resolves.toEqual({ generations, debit: {
          generationId: 'generation', tier: 'balanced', upstreamGenerationId: 'upstream',
          transactionReference: 'ai_generation:upstream', transactionType: 'usage', amountMicroUsd: -4321,
        } })
    } finally { server.stop(true) }
  })
})

test('live training acceptance rejects a completion report delayed behind an idle heartbeat', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      job: {
        jobId: 'job',
        workspaceId: 'workspace',
        userId: 'user',
        state: 'done',
        phase: 'done',
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
        completedAt: Date.now() - 30_000,
      },
    }),
  )
  try {
    await expect(
      waitForTrain('https://fixture.test', 'workspace', 'job', 'token', {
        maxReportDelayMs: 15_000,
      }),
    ).rejects.toThrow('completion report')
  } finally {
    fetch.mockRestore()
  }
})

test('live training acceptance rejects a run whose running report stays queued', async () => {
  let now = 100_000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async () => {
        now += now === 100_000 ? 16_000 : 300_000
        return Response.json({
          job: {
            jobId: 'job',
            workspaceId: 'workspace',
            userId: 'user',
            state: 'queued',
            phase: 'preparing',
            createdAt: 100_000,
            updatedAt: 100_000,
          },
        })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  try {
    await expect(
      waitForTrain('https://fixture.test', 'workspace', 'job', 'token', {
        maxReportDelayMs: 15_000,
      }),
    ).rejects.toThrow('still queued')
  } finally {
    fetch.mockRestore()
    clock.mockRestore()
  }
})

test('live training acceptance records prompt completion latency', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(100_000)
  const completedAt = 99_000
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      job: {
        jobId: 'job',
        workspaceId: 'workspace',
        userId: 'user',
        state: 'done',
        phase: 'done',
        createdAt: completedAt - 1_000,
        updatedAt: completedAt,
        completedAt,
      },
    }),
  )
  try {
    const status = await waitForTrain('https://fixture.test', 'workspace', 'job', 'token', {
      maxReportDelayMs: 15_000,
    })
    expect(status.completionReportLagMs).toBe(1_000)
  } finally {
    fetch.mockRestore()
    clock.mockRestore()
  }
})
