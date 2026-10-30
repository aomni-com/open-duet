export interface ChromeProcessSample {
  rendererCpuCores: number
  totalChromeCpuCores: number
  rendererRssBytes: number
  totalChromeRssBytes: number
}

interface CandidateEvidence {
  tabId: number
  windowId: number
  url: string
  targetIdBefore: string
  timerBefore: number
  timerAfterActivation: number
  navigationBefore: number
  navigationAfter: number
  memoryMarkerBefore: string
  memoryMarkerAfter: string | null
  domMarkerBefore: string
  domMarkerAfter: string
  sessionStorageBefore: string
  sessionStorageAfter: string
  localStorageBefore: string
  localStorageAfter: string
}

export interface FreezeCandidateEvidence extends CandidateEvidence {
  targetIdFrozen: string
  targetIdAfter: string
  frozenObserved: boolean
  frozenAfterActivation: boolean
  timerAfter: number
}

export interface DiscardCandidateEvidence extends CandidateEvidence {
  tabRetained: boolean
  replacementTabId: number
  targetIdDiscarded: string | null
  targetIdAfter: string
  discardedObserved: boolean
  discardedAfterActivation: boolean
}

export interface ChromeTabSuspensionProbeResult {
  schemaVersion: 1
  imageRef: string
  chromeVersion: string
  workload: { candidateCount: number; sampleDurationMs: number }
  active: ChromeProcessSample
  frozen: ChromeProcessSample
  freeze: {
    commands?: Array<{ result?: { error?: string } }>
    candidates: FreezeCandidateEvidence[]
    activeTab: {
      tabId: number
      updateRejected: boolean
      remainedActive: boolean
      remainedUnfrozen: boolean
    }
  }
  discarded: ChromeProcessSample
  discard: {
    commands?: Array<{ result?: { tabId?: number; discarded?: boolean } }>
    candidates: DiscardCandidateEvidence[]
    activeTab: {
      tabId: number
      policySkipped: boolean
      remainedActive: boolean
      remainedUndiscarded: boolean
    }
  }
}

interface MechanismAssessment {
  passed: boolean
  failures: string[]
  cpuReductionRatio: number
}

export interface ChromeTabSuspensionAssessment {
  freeze: MechanismAssessment
  discard: MechanismAssessment & { reloadObserved: boolean; memoryLossObserved: boolean }
}

const cpuFailures = (
  active: ChromeProcessSample,
  idle: ChromeProcessSample,
): { failures: string[]; ratio: number } => {
  const reduction = active.rendererCpuCores - idle.rendererCpuCores
  const ratio = reduction / Math.max(active.rendererCpuCores, Number.EPSILON)
  const failures: string[] = []
  if (active.rendererCpuCores < 0.25)
    failures.push('active renderer workload was below 0.25 CPU cores')
  if (reduction < 0.2 || ratio < 0.6)
    failures.push('renderer CPU did not fall by at least 60% and 0.20 CPU cores')
  return { failures, ratio }
}

export function assessChromeTabSuspensionProbe(
  result: ChromeTabSuspensionProbeResult,
): ChromeTabSuspensionAssessment {
  const freezeCpu = cpuFailures(result.active, result.frozen)
  const freezeFailures = [...freezeCpu.failures]
  for (const tab of result.freeze.candidates) {
    if (!tab.frozenObserved) freezeFailures.push(`tab ${tab.tabId} did not report frozen`)
    if (tab.tabId <= 0 || tab.windowId <= 0 || !tab.url)
      freezeFailures.push('freeze lost tab/window/URL identity')
    if (tab.targetIdBefore !== tab.targetIdFrozen || tab.targetIdBefore !== tab.targetIdAfter)
      freezeFailures.push(`tab ${tab.tabId} changed CDP target across freeze`)
    if (tab.timerAfter - tab.timerBefore > 2)
      freezeFailures.push(`tab ${tab.tabId} timers advanced while frozen`)
    if (tab.frozenAfterActivation || tab.timerAfterActivation <= tab.timerAfter)
      freezeFailures.push(`tab ${tab.tabId} did not auto-unfreeze and resume on activation`)
    if (tab.navigationAfter !== tab.navigationBefore)
      freezeFailures.push(`tab ${tab.tabId} reloaded across freeze`)
    if (
      tab.memoryMarkerAfter !== tab.memoryMarkerBefore ||
      tab.domMarkerAfter !== tab.domMarkerBefore ||
      tab.sessionStorageAfter !== tab.sessionStorageBefore ||
      tab.localStorageAfter !== tab.localStorageBefore
    )
      freezeFailures.push(`tab ${tab.tabId} lost state across freeze`)
  }
  const protectedFreeze = result.freeze.activeTab
  if (
    !protectedFreeze.updateRejected ||
    !protectedFreeze.remainedActive ||
    !protectedFreeze.remainedUnfrozen
  )
    freezeFailures.push('active control was not protected from native freeze')

  const discardCpu = cpuFailures(result.active, result.discarded)
  const discardFailures = [...discardCpu.failures]
  for (const tab of result.discard.candidates) {
    if (!tab.tabRetained)
      discardFailures.push(`tab ${tab.tabId} disappeared from its Chrome window during discard`)
    if (!tab.discardedObserved) discardFailures.push(`tab ${tab.tabId} did not report discarded`)
    if (tab.discardedAfterActivation || !tab.targetIdAfter)
      discardFailures.push(`tab ${tab.tabId} did not restore deterministically`)
    if (tab.navigationAfter <= tab.navigationBefore)
      discardFailures.push(`tab ${tab.tabId} did not expose a reload boundary`)
  }
  const protectedDiscard = result.discard.activeTab
  if (
    !protectedDiscard.policySkipped ||
    !protectedDiscard.remainedActive ||
    !protectedDiscard.remainedUndiscarded
  )
    discardFailures.push('active control was not protected from discard by policy')
  const reloadObserved = result.discard.candidates.every(
    tab => tab.navigationAfter > tab.navigationBefore,
  )
  const memoryLossObserved = result.discard.candidates.every(
    tab => tab.memoryMarkerAfter !== tab.memoryMarkerBefore,
  )
  if (!reloadObserved) discardFailures.push('discard reload boundary was not observed')
  if (!memoryLossObserved) discardFailures.push('discard in-memory loss boundary was not observed')

  return {
    freeze: {
      passed: freezeFailures.length === 0,
      failures: freezeFailures,
      cpuReductionRatio: freezeCpu.ratio,
    },
    discard: {
      passed: discardFailures.length === 0,
      failures: discardFailures,
      cpuReductionRatio: discardCpu.ratio,
      reloadObserved,
      memoryLossObserved,
    },
  }
}
