export interface ChromeProcessSample {
  rendererCpuCores: number
  totalChromeCpuCores: number
  rendererRssBytes: number
  totalChromeRssBytes: number
}

export interface ChromeFreezeProbeResult {
  schemaVersion: 1
  chromeVersion: string
  imageRef: string
  workload: {
    pageCount: number
    sampleDurationMs: number
    timerIntervalMs: number
  }
  active: ChromeProcessSample
  frozen: ChromeProcessSample
  thawed: ChromeProcessSample
  state: {
    markerBeforeFreeze: string
    markerAfterThaw: string
    timerCountBeforeFreeze: number
    timerCountImmediatelyAfterThaw: number
    timerCountAfterResume: number
    thawLatencyMs: number
    targetDiscoverableAfterThaw: boolean
    driveMutationObserved: boolean
    navigationCountBeforeFreeze: number
    navigationCountAfterThaw: number
  }
  boundaries: {
    media: string
    dialog: string
    popup: string
    download: string
    serviceWorker: string
  }
  diagnostics: {
    backgroundPage: ChromeFreezeTargetDiagnostic
    focusedPage: ChromeFreezeTargetDiagnostic
    minimizedBackground: ChromeMinimizedFreezeDiagnostic
  }
}

export interface ChromeFreezeTargetDiagnostic {
  timerDeltaDuringFreeze: number
  visibilityBefore: string
  visibilityAfter: string
  lifecycleEvents: string[]
}

export interface ChromeMinimizedFreezeDiagnostic {
  minimizedOnly: ChromeProcessSample
  minimizedAndFrozen: ChromeProcessSample
  timerDeltaMinimizedOnly: number
  timerDeltaMinimizedAndFrozen: number
  visibilityWhileMinimized: string[]
  visibilityAfterRestore: string[]
  chromeWindowStatesWhileMinimized: string[]
  chromeWindowStatesAfterRestore: string[]
  lifecycleEvents: string[]
  restoreResumedTimers: boolean
  stateSurvivedRestore: boolean
}

export interface ChromeFreezeProbeAssessment {
  passed: boolean
  rendererCpuReductionRatio: number
  failures: string[]
}

const MINIMUM_ACTIVE_RENDERER_CPU_CORES = 0.25
const MINIMUM_ABSOLUTE_CPU_REDUCTION_CORES = 0.2
const MINIMUM_CPU_REDUCTION_RATIO = 0.6

export function assessChromeFreezeProbe(
  result: ChromeFreezeProbeResult,
): ChromeFreezeProbeAssessment {
  const failures: string[] = []
  const absoluteReduction = result.active.rendererCpuCores - result.frozen.rendererCpuCores
  const reductionRatio =
    absoluteReduction / Math.max(result.active.rendererCpuCores, Number.EPSILON)

  if (result.active.rendererCpuCores < MINIMUM_ACTIVE_RENDERER_CPU_CORES) {
    failures.push('active renderer workload was below 0.25 CPU cores')
  }
  if (
    absoluteReduction < MINIMUM_ABSOLUTE_CPU_REDUCTION_CORES ||
    reductionRatio < MINIMUM_CPU_REDUCTION_RATIO
  ) {
    failures.push('frozen renderer CPU did not fall by at least 60% and 0.20 CPU cores')
  }
  if (result.state.timerCountImmediatelyAfterThaw - result.state.timerCountBeforeFreeze > 1) {
    failures.push('page timers advanced while frozen')
  }
  if (result.state.markerAfterThaw !== result.state.markerBeforeFreeze) {
    failures.push('DOM/JS marker did not survive thaw')
  }
  if (result.state.navigationCountAfterThaw !== result.state.navigationCountBeforeFreeze) {
    failures.push('page reloaded while frozen or thawing')
  }
  if (result.state.thawLatencyMs > 1_000) {
    failures.push('explicit focus-triggered thaw exceeded one second')
  }
  if (!result.state.targetDiscoverableAfterThaw) {
    failures.push('page target was not discoverable after thaw')
  }
  if (!result.state.driveMutationObserved) {
    failures.push('page was not driveable after thaw')
  }
  if (result.state.timerCountAfterResume <= result.state.timerCountImmediatelyAfterThaw) {
    failures.push('page timers did not resume after thaw')
  }

  return {
    passed: failures.length === 0,
    rendererCpuReductionRatio: reductionRatio,
    failures,
  }
}
