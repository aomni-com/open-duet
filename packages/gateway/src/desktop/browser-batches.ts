import type { DesktopBrowserBatch, DesktopPhase } from '@repo/contract'

import type { AgentSessionsController } from '../agent-sessions/coordinator'
import type { BrowserReconciliationResult, DesktopBrowserManager } from './browser-manager'

interface BrowserBatchServiceOptions {
  resolveOwner: AgentSessionsController['browserOwnerForSession']
  ensureDesktop(): Promise<DesktopPhase>
  reconcile(): Promise<BrowserReconciliationResult>
  manager: Pick<DesktopBrowserManager, 'startBatch'>
  grants: {
    mint(payload: { batchId: string; browserGeneration: string }): Promise<{
      webSocketDebuggerUrl: string
      expiresAt: number
    }>
  }
}

export class BrowserSessionResolutionError extends Error {
  constructor(readonly code: 'browser_session_not_found' | 'browser_owner_unavailable') {
    super(code)
  }
}

export interface BrowserBatchService {
  start(sessionId: string): Promise<DesktopBrowserBatch>
}

export function createBrowserBatchService(
  options: BrowserBatchServiceOptions,
): BrowserBatchService {
  return {
    async start(sessionId) {
      const resolution = await options.resolveOwner(sessionId)
      if (!resolution.ok) throw new BrowserSessionResolutionError(resolution.error)
      await options.ensureDesktop()
      const reconciliation = await options.reconcile()
      const browserGeneration = reconciliation.ledger.browserGeneration
      if (browserGeneration === undefined) throw new Error('Browser generation is unavailable')
      const batch = await options.manager.startBatch(resolution.owner)
      const grant = await options.grants.mint({
        batchId: batch.batchId,
        browserGeneration,
      })
      return {
        batchId: batch.batchId,
        owner: batch.owner,
        targetId: batch.targetId,
        webSocketDebuggerUrl: grant.webSocketDebuggerUrl,
      }
    },
  }
}
