import { describe, expect, it } from 'bun:test'

import { serializeInterruptionCapture } from '../src/probe-result'

describe('serializeInterruptionCapture', () => {
  it('emits one portable PCM representation', () => {
    const result = serializeInterruptionCapture(
      {
        pcm: new Int16Array([0, 16_384, -16_384, 8_192]),
        durationMs: 1_400,
        sampleCount: 4,
        sampleRate: 48_000,
        firstSignalFrame: 960,
        boundaryFrame: 58_560,
        firstSignalPerformanceTimeMs: 1_300,
        boundaryPerformanceTimeMs: 2_500,
        playoutStoppedFrame: 68_160,
        playoutStoppedPerformanceTimeMs: 2_700,
        bargeInStartedPerformanceTimeMs: 2_500,
        muteLatencyMs: 200,
        silenceProofMs: 250,
      },
      'running',
      true,
    )

    expect(result).toEqual({
      durationMs: 1_400,
      sampleCount: 4,
      sampleRate: 48_000,
      firstSignalFrame: 960,
      boundaryFrame: 58_560,
      firstSignalPerformanceTimeMs: 1_300,
      boundaryPerformanceTimeMs: 2_500,
      playoutStoppedFrame: 68_160,
      playoutStoppedPerformanceTimeMs: 2_700,
      bargeInStartedPerformanceTimeMs: 2_500,
      muteLatencyMs: 200,
      silenceProofMs: 250,
      heardPcmBase64: 'AAAAQADAACA=',
      audioContextState: 'running',
      outputTimestampSupported: true,
    })
    expect('pcm' in result).toBe(false)
  })
})
