import { describe, expect, test } from 'bun:test'

import {
  assessChromeFreezeProbe,
  type ChromeFreezeProbeResult,
} from '../scripts/chrome-freeze-probe-result.ts'

function passingResult(): ChromeFreezeProbeResult {
  return {
    schemaVersion: 1,
    chromeVersion: 'Google Chrome 139.0.7258.154',
    imageRef: 'ghcr.io/aomni-com/duet-vm-image@sha256:probe',
    workload: { pageCount: 3, sampleDurationMs: 4_000, timerIntervalMs: 50 },
    active: {
      rendererCpuCores: 1.25,
      totalChromeCpuCores: 1.4,
      rendererRssBytes: 300_000_000,
      totalChromeRssBytes: 500_000_000,
    },
    frozen: {
      rendererCpuCores: 0.08,
      totalChromeCpuCores: 0.15,
      rendererRssBytes: 298_000_000,
      totalChromeRssBytes: 498_000_000,
    },
    thawed: {
      rendererCpuCores: 1.18,
      totalChromeCpuCores: 1.32,
      rendererRssBytes: 302_000_000,
      totalChromeRssBytes: 502_000_000,
    },
    state: {
      markerBeforeFreeze: 'survives-freeze',
      markerAfterThaw: 'survives-freeze',
      timerCountBeforeFreeze: 42,
      timerCountImmediatelyAfterThaw: 42,
      timerCountAfterResume: 55,
      thawLatencyMs: 180,
      targetDiscoverableAfterThaw: true,
      driveMutationObserved: true,
      navigationCountBeforeFreeze: 1,
      navigationCountAfterThaw: 1,
    },
    boundaries: {
      media: 'observed; telemetry only',
      dialog: 'observed; telemetry only',
      popup: 'separate page target; explicitly frozen',
      download: 'observed; telemetry only',
      serviceWorker: 'separate service_worker target; not frozen',
    },
    diagnostics: {
      backgroundPage: {
        timerDeltaDuringFreeze: 0,
        visibilityBefore: 'visible',
        visibilityAfter: 'visible',
        lifecycleEvents: ['networkIdle'],
      },
      focusedPage: {
        timerDeltaDuringFreeze: 0,
        visibilityBefore: 'visible',
        visibilityAfter: 'visible',
        lifecycleEvents: [],
      },
      minimizedBackground: {
        minimizedOnly: {
          rendererCpuCores: 0.3,
          totalChromeCpuCores: 0.35,
          rendererRssBytes: 280_000_000,
          totalChromeRssBytes: 470_000_000,
        },
        minimizedAndFrozen: {
          rendererCpuCores: 0.29,
          totalChromeCpuCores: 0.34,
          rendererRssBytes: 275_000_000,
          totalChromeRssBytes: 465_000_000,
        },
        timerDeltaMinimizedOnly: 3,
        timerDeltaMinimizedAndFrozen: 0,
        visibilityWhileMinimized: ['hidden', 'hidden', 'hidden'],
        visibilityAfterRestore: ['visible', 'visible', 'visible'],
        chromeWindowStatesWhileMinimized: ['minimized', 'minimized', 'minimized'],
        chromeWindowStatesAfterRestore: ['normal', 'normal', 'normal'],
        lifecycleEvents: ['visibilityChanged'],
        restoreResumedTimers: true,
        stateSurvivedRestore: true,
      },
    },
  }
}

describe('Chrome freeze probe verdict', () => {
  test('passes material CPU savings with lossless sub-second thaw', () => {
    const assessment = assessChromeFreezeProbe(passingResult())

    expect(assessment.passed).toBe(true)
    expect(assessment.rendererCpuReductionRatio).toBeCloseTo(0.936, 3)
    expect(assessment.failures).toEqual([])
  })

  test('fails a quiet active control because it cannot prove freeze economics', () => {
    const result = passingResult()
    result.active.rendererCpuCores = 0.05
    result.frozen.rendererCpuCores = 0.01

    expect(assessChromeFreezeProbe(result).failures).toContain(
      'active renderer workload was below 0.25 CPU cores',
    )
  })

  test('fails insufficient CPU reduction while ignoring RSS movement', () => {
    const result = passingResult()
    result.frozen.rendererCpuCores = 0.8
    result.frozen.rendererRssBytes = 1

    const assessment = assessChromeFreezeProbe(result)

    expect(assessment.passed).toBe(false)
    expect(assessment.failures).toContain(
      'frozen renderer CPU did not fall by at least 60% and 0.20 CPU cores',
    )
    expect(assessment.failures.every(failure => !failure.includes('RSS'))).toBe(true)
  })

  test('fails timer progress, reload, state loss, slow thaw, or an unusable target', () => {
    const result = passingResult()
    result.state.timerCountImmediatelyAfterThaw += 2
    result.state.navigationCountAfterThaw = 2
    result.state.markerAfterThaw = 'lost'
    result.state.thawLatencyMs = 1_001
    result.state.targetDiscoverableAfterThaw = false
    result.state.driveMutationObserved = false
    result.state.timerCountAfterResume = result.state.timerCountImmediatelyAfterThaw

    expect(assessChromeFreezeProbe(result).failures).toEqual([
      'page timers advanced while frozen',
      'DOM/JS marker did not survive thaw',
      'page reloaded while frozen or thawing',
      'explicit focus-triggered thaw exceeded one second',
      'page target was not discoverable after thaw',
      'page was not driveable after thaw',
      'page timers did not resume after thaw',
    ])
  })
})
