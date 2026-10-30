import { describe, expect, test } from 'bun:test'

import { waitForForwardProgress } from './staging-live-forward-progress.ts'

describe('waitForForwardProgress', () => {
  test('the wall-clock timeout also bounds a load that never settles', async () => {
    await expect(
      waitForForwardProgress({
        label: 'hung checkout projection',
        load: () => new Promise<never>(() => {}),
        isComplete: () => false,
        hasProgress: () => false,
        maxConsecutiveUnchangedObservations: 2,
        timeoutMs: 5,
        pollMs: 0,
      }),
    ).rejects.toThrow('Timed out waiting for hung checkout projection; last=undefined')
  })

  test('fails after the unchanged-state budget and reports the last observation', async () => {
    const state = { phase: 'pending', balance: 20 }

    await expect(
      waitForForwardProgress({
        label: 'checkout credit projection',
        load: async () => state,
        isComplete: () => false,
        hasProgress: (previous, current) => previous.phase !== current.phase,
        maxConsecutiveUnchangedObservations: 2,
        timeoutMs: 1_000,
        pollMs: 0,
      }),
    ).rejects.toThrow(
      'Stopped waiting for checkout credit projection after 2 unchanged observations; last={"phase":"pending","balance":20}',
    )
  })

  test('progress resets the consecutive unchanged-state budget', async () => {
    const observations = [
      { phase: 'pending', complete: false },
      { phase: 'pending', complete: false },
      { phase: 'processing', complete: false },
      { phase: 'processing', complete: false },
      { phase: 'complete', complete: true },
    ]
    let nextObservation = 0

    const result = await waitForForwardProgress({
      label: 'checkout credit projection',
      load: async () => observations[nextObservation++]!,
      isComplete: state => state.complete,
      hasProgress: (previous, current) => previous.phase !== current.phase,
      maxConsecutiveUnchangedObservations: 2,
      timeoutMs: 1_000,
      pollMs: 0,
    })

    expect(result).toEqual({ phase: 'complete', complete: true })
    expect(nextObservation).toBe(5)
  })
})
