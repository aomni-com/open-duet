import { describe, expect, test } from 'bun:test'

import type { FileEventBatch } from '@repo/contract'

import { gatewayLivenessWorkload } from '../../../contract/testing/gateway-liveness'
import { createFileEventPipeline } from './pipeline'
import { cleanUpTestTimeouts } from '../testing/timeouts.test-helper'

interface PipelineHarness {
  pipeline: ReturnType<typeof createFileEventPipeline>
  admitted: ReturnType<typeof gatewayLivenessWorkload>
  deliveries: FileEventBatch[]
}

function pipelineHarness(): PipelineHarness {
  const now = 10_000
  const deliveries: FileEventBatch[] = []
  const admitted: PipelineHarness['admitted'] = []
  const pipeline = createFileEventPipeline({
    apiUrl: 'http://api',
    getVmToken: async () => 'token',
    fetch: async (_input, init) => {
      deliveries.push(JSON.parse(String(init?.body)) as FileEventBatch)
      return Response.json({ ok: true })
    },
    now: () => now,
    flushMs: 60_000,
    maxEntries: 10_000,
  })
  pipeline.onEvent(value => admitted.push(structuredClone(value)))
  return { pipeline, admitted, deliveries }
}

describe('gateway liveness workload', () => {
  cleanUpTestTimeouts()

  test('raw mixed paths remain observable while durable delivery folds noisy descendants', async () => {
    const harness = pipelineHarness()
    const workload = gatewayLivenessWorkload(8)
    workload.forEach(harness.pipeline.emit)
    await harness.pipeline.flush()

    expect(harness.admitted).toEqual(workload)
    expect(harness.deliveries.flatMap(batch => batch.events)).toEqual([
      ...workload.slice(0, 2),
      {
        kind: 'viewed-summary',
        path: 'node_modules',
        actor: 'session:risk-harness',
        at: 1,
        count: 2,
      },
      {
        kind: 'changed-summary',
        path: 'node_modules',
        actor: 'session:risk-harness',
        at: 1,
        count: 6,
      },
      { kind: 'changed-summary', path: '.git', actor: 'session:risk-harness', at: 1, count: 1 },
      ...workload.slice(11),
    ])
  })
})
