import { describe, expect, it } from 'bun:test'

import {
  audioFrameToPerformanceMs,
  HeardAudioLedger,
  hasConfirmedOutputSilence,
  hasOutputClockReachedFrame,
  performanceMsToContextTime,
  scheduledContextTimeToPerformanceMs,
} from '../src/heard-audio'

describe('HeardAudioLedger', () => {
  it('finds the next audible epoch strictly after a confirmed-silence anchor', () => {
    const ledger = new HeardAudioLedger(48_000)
    ledger.capture(0, new Float32Array([0, 0.2, 0.1, 0, 0]))
    ledger.capture(5, new Float32Array([0, 0, 0.3, 0.2]))

    expect(ledger.firstSignalFrameAfter(2)).toBe(7)
    expect(ledger.firstSignalFrameAfter(8)).toBeNull()
  })

  it('freezes exactly the browser-rendered 1.2 second prefix before the captured tail', () => {
    const ledger = new HeardAudioLedger(48_000)
    const silence = new Float32Array(960)
    const quantum = new Float32Array(960).fill(0.5)
    ledger.capture(0, silence)
    for (let index = 0; index < 61; index += 1) {
      ledger.capture((index + 1) * quantum.length, quantum)
    }

    expect(ledger.hasCapturedPrefix(960, 1_200)).toBe(true)
    const prefix = ledger.freezePrefix(960, 1_200)
    expect(prefix.durationMs).toBe(1_200)
    expect(prefix.pcm).toHaveLength(57_600)
    expect(prefix.pcm[0]).toBe(16_384)
    expect(prefix.pcm.byteLength).toBeLessThan(ledger.fullPcmByteLength)
  })

  it('does not claim a prefix until every frame in its range is captured', () => {
    const ledger = new HeardAudioLedger(48_000)
    ledger.capture(960, new Float32Array(28_800).fill(0.25))

    expect(ledger.hasCapturedPrefix(960, 1_200)).toBe(false)
    expect(() => ledger.freezePrefix(960, 1_200)).toThrow('not fully captured')
  })

  it('freezes every rendered frame through the measured playout stop', () => {
    const ledger = new HeardAudioLedger(48_000)
    ledger.capture(960, new Float32Array(64_800).fill(0.25))

    const heard = ledger.freezeThroughFrame(960, 65_760)

    expect(heard.durationMs).toBe(1_350)
    expect(heard.pcm).toHaveLength(64_800)
  })

  it('projects scheduled microphone time without speaker-output latency', () => {
    expect(
      scheduledContextTimeToPerformanceMs({
        targetContextTimeSeconds: 12.5,
        currentContextTimeSeconds: 10,
        currentPerformanceTimeMs: 3_000,
      }),
    ).toBe(5_500)
  })

  it('maps signal and boundary frames from the same output timestamp pair', () => {
    const timestamp = { contextTime: 5, performanceTime: 5_120 }

    expect(audioFrameToPerformanceMs(48_000, 48_000, timestamp)).toBe(1_120)
    expect(audioFrameToPerformanceMs(105_600, 48_000, timestamp)).toBe(2_320)
  })

  it('schedules microphone input on the browser performance clock', () => {
    expect(
      performanceMsToContextTime({
        targetPerformanceTimeMs: 5_500,
        currentContextTimeSeconds: 10,
        currentPerformanceTimeMs: 3_000,
      }),
    ).toBe(12.5)
  })

  it('confirms stop only after the output clock passes a silent proof window', () => {
    expect(
      hasConfirmedOutputSilence({
        lastSignalFrame: 47_999,
        sampleRate: 48_000,
        outputContextTimeSeconds: 1.249,
        silenceDurationMs: 250,
      }),
    ).toBe(false)
    expect(
      hasConfirmedOutputSilence({
        lastSignalFrame: 47_999,
        sampleRate: 48_000,
        outputContextTimeSeconds: 1.25,
        silenceDurationMs: 250,
      }),
    ).toBe(true)
  })

  it('does not acknowledge a rendered signal before the output clock reaches it', () => {
    expect(
      hasOutputClockReachedFrame({
        frame: 48_000,
        sampleRate: 48_000,
        outputContextTimeSeconds: 1,
      }),
    ).toBe(false)
    expect(
      hasOutputClockReachedFrame({
        frame: 48_000,
        sampleRate: 48_000,
        outputContextTimeSeconds: 1 + 1 / 48_000,
      }),
    ).toBe(true)
  })
})
