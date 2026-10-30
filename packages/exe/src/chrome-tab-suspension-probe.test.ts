import { describe, expect, test } from 'bun:test'

import {
  assessChromeTabSuspensionProbe,
  type ChromeTabSuspensionProbeResult,
} from '../scripts/chrome-tab-suspension-probe-result.ts'

function passingResult(): ChromeTabSuspensionProbeResult {
  return {
    schemaVersion: 1,
    imageRef: 'ghcr.io/aomni-com/duet-vm-image@sha256:probe',
    chromeVersion: 'Google Chrome 151.0.7922.137',
    workload: { candidateCount: 3, sampleDurationMs: 4_000 },
    active: {
      rendererCpuCores: 1,
      totalChromeCpuCores: 1.1,
      rendererRssBytes: 1,
      totalChromeRssBytes: 2,
    },
    frozen: {
      rendererCpuCores: 0.1,
      totalChromeCpuCores: 0.2,
      rendererRssBytes: 1,
      totalChromeRssBytes: 2,
    },
    freeze: {
      candidates: [
        {
          tabId: 2,
          windowId: 3,
          url: 'http://fixture/',
          targetIdBefore: 'target-1',
          targetIdFrozen: 'target-1',
          targetIdAfter: 'target-1',
          frozenObserved: true,
          frozenAfterActivation: false,
          timerBefore: 20,
          timerAfter: 20,
          timerAfterActivation: 25,
          navigationBefore: 1,
          navigationAfter: 1,
          memoryMarkerBefore: 'memory',
          memoryMarkerAfter: 'memory',
          domMarkerBefore: 'dom',
          domMarkerAfter: 'dom',
          sessionStorageBefore: 'session',
          sessionStorageAfter: 'session',
          localStorageBefore: 'local',
          localStorageAfter: 'local',
        },
      ],
      activeTab: { tabId: 1, updateRejected: true, remainedActive: true, remainedUnfrozen: true },
    },
    discarded: {
      rendererCpuCores: 0.08,
      totalChromeCpuCores: 0.18,
      rendererRssBytes: 0,
      totalChromeRssBytes: 1,
    },
    discard: {
      candidates: [
        {
          tabId: 2,
          replacementTabId: 4,
          windowId: 3,
          url: 'http://fixture/',
          targetIdBefore: 'target-1',
          targetIdDiscarded: null,
          targetIdAfter: 'target-2',
          tabRetained: true,
          discardedObserved: true,
          discardedAfterActivation: false,
          timerBefore: 20,
          timerAfterActivation: 2,
          navigationBefore: 1,
          navigationAfter: 2,
          memoryMarkerBefore: 'memory',
          memoryMarkerAfter: null,
          domMarkerBefore: 'dom',
          domMarkerAfter: 'dom-reloaded',
          sessionStorageBefore: 'session',
          sessionStorageAfter: 'session',
          localStorageBefore: 'local',
          localStorageAfter: 'local',
        },
      ],
      activeTab: { tabId: 1, policySkipped: true, remainedActive: true, remainedUndiscarded: true },
    },
  }
}

describe('Chrome extension tab suspension probe verdict', () => {
  test('passes native freeze only when CPU, identity, state, restore, and active-tab protection all hold', () => {
    const assessment = assessChromeTabSuspensionProbe(passingResult())
    expect(assessment.freeze.passed).toBe(true)
    expect(assessment.freeze.failures).toEqual([])
  })

  test('records discard as a separate mechanism with a deterministic reload and loss boundary', () => {
    const assessment = assessChromeTabSuspensionProbe(passingResult())
    expect(assessment.discard.passed).toBe(true)
    expect(assessment.discard.reloadObserved).toBe(true)
    expect(assessment.discard.memoryLossObserved).toBe(true)
  })

  test('fails safely when the active tab is not protected by the browser API', () => {
    const result = passingResult()
    result.discard.activeTab = {
      tabId: 1,
      policySkipped: false,
      remainedActive: false,
      remainedUndiscarded: false,
    }
    expect(assessChromeTabSuspensionProbe(result).discard.failures).toContain(
      'active control was not protected from discard by policy',
    )
  })
})
