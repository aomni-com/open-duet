import { randomUUID } from 'node:crypto'

import {
  BROWSER_BATCH_TAB_TTL_MS,
  BROWSER_IDLE_DISCARD_GRACE_MS,
  BROWSER_MANAGED_WINDOW_LIMIT,
  browserOwnerKey,
  type BrowserOwner,
  type BrowserOwnerKey,
  type DesktopOwnerActivity,
} from '@repo/contract'

import type { BrowserWindowLedger, BrowserWindowLedgerStore } from './browser-ledger'
import type { BrowserExtensionCommand } from './extension-bridge'
import type { BrowserExtensionEvent } from './extension-bridge'

interface NativeTabSnapshot {
  tabId: number
  windowId: number
  targetId?: string
  active: boolean
}

interface NativeWindowSnapshot {
  windowId: number
  focused: boolean
  tabs: NativeTabSnapshot[]
}

interface NativeSnapshot {
  windows: NativeWindowSnapshot[]
}

interface BrowserManagerOptions {
  store: BrowserWindowLedgerStore
  extension: { request(command: BrowserExtensionCommand): Promise<unknown> }
  now: () => number
  createLogicalId?: () => string
  createBatchId?: () => string
  log?: (fields: Record<string, unknown>) => void
  agentSlugForId?: (agentId: string) => string | undefined
}

export interface BrowserReconciliationResult {
  verdict: 'adopted-root' | 'reset' | 'preserved'
  ledger: BrowserWindowLedger
}

export class BrowserCapacityReachedError extends Error {
  readonly code = 'browser_capacity' as const
  readonly retryable = true as const
  readonly retryAfterMs = BROWSER_IDLE_DISCARD_GRACE_MS

  constructor() {
    super('Managed browser window capacity reached')
  }
}

export interface DesktopBrowserManager {
  reconcile(browserGeneration: string): Promise<BrowserReconciliationResult>
  startBatch(owner: BrowserOwner): Promise<{
    batchId: string
    owner: BrowserOwner
    targetId: string
  }>
  createBatchTab(batchId: string, url: string): Promise<{ targetId: string }>
  attributePopup(batchId: string, targetId: string, openerId: string): Promise<boolean>
  removeBatchTarget(batchId: string, targetId: string): Promise<boolean>
  openBatchLease(batchId: string): Promise<void>
  closeBatchLease(batchId: string): Promise<void>
  touchBatchLease(batchId: string): void
  hasLiveBatch(batchId: string): boolean
  handleExtensionEvent(event: BrowserExtensionEvent): Promise<void>
  tick(): Promise<void>
  lastBrowserActivityAt(): number | undefined
  removeOwner(owner: BrowserOwner): Promise<boolean>
  focusOwner(owner: BrowserOwner): Promise<boolean>
  activities(): DesktopOwnerActivity[]
  inventory(): BrowserWindowLedger
}

export function createBrowserReconciliationTrigger(options: {
  discoverGeneration: () => Promise<string>
  reconcile: (generation: string) => Promise<BrowserReconciliationResult>
}): { connected(): Promise<BrowserReconciliationResult | undefined> } {
  let latestConnection = 0
  return {
    async connected() {
      const connection = ++latestConnection
      const generation = await options.discoverGeneration()
      if (connection !== latestConnection) return undefined
      return options.reconcile(generation)
    },
  }
}

export function createDesktopBrowserManager(options: BrowserManagerOptions): DesktopBrowserManager {
  const createLogicalId = options.createLogicalId ?? randomUUID
  const createBatchId = options.createBatchId ?? randomUUID
  const liveBatches = new Set<string>()
  const liveActivityAt = new Map<string, number>()
  const log = options.log ?? (() => undefined)
  let operation = Promise.resolve<unknown>(undefined)
  let focusedWindowId: number | undefined
  let maintenanceFocusedWindowId: number | undefined
  let maintenanceRestorePending = false

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = operation.then(work, work)
    operation = next.catch(() => undefined)
    return next
  }

  return {
    reconcile(browserGeneration) {
      if (browserGeneration.length === 0) {
        return Promise.reject(new Error('Browser generation is required'))
      }
      return serialized(async () => {
        const snapshot = parseSnapshot(await options.extension.request({ command: 'snapshot' }))
        focusedWindowId = snapshot.windows.find(window => window.focused)?.windowId
        const current = options.store.current()
        if (current.browserGeneration !== browserGeneration) {
          const next = resetForGeneration(
            browserGeneration,
            snapshot,
            options.now(),
            createLogicalId,
          )
          return {
            verdict: next.windows.length === 1 ? 'adopted-root' : 'reset',
            ledger: options.store.replace(next),
          }
        }

        const next = reconcileSameGeneration(current, snapshot)
        return { verdict: 'preserved', ledger: options.store.replace(next) }
      })
    },
    startBatch(owner) {
      return serialized(async () => {
        let current = options.store.current()
        let existingWindow = current.windows.find(
          candidate => browserOwnerKey(candidate.owner) === browserOwnerKey(owner),
        )
        if (
          existingWindow === undefined &&
          current.windows.length >= BROWSER_MANAGED_WINDOW_LIMIT
        ) {
          const beforeEviction = current
          const liveOwners = new Set(
            current.batches
              .filter(batch => liveBatches.has(batch.batchId))
              .map(batch => browserOwnerKey(batch.owner)),
          )
          const victim = [...current.windows]
            .filter(
              window => window.phase === 'idle' && !liveOwners.has(browserOwnerKey(window.owner)),
            )
            .sort(
              (left, right) =>
                left.lastActivityAt - right.lastActivityAt ||
                browserOwnerKey(left.owner).localeCompare(browserOwnerKey(right.owner)),
            )[0]
          if (victim === undefined) throw new BrowserCapacityReachedError()
          const victimKey = browserOwnerKey(victim.owner)
          current = options.store.replace({
            ...current,
            windows: current.windows.filter(window => browserOwnerKey(window.owner) !== victimKey),
            batches: current.batches.filter(batch => browserOwnerKey(batch.owner) !== victimKey),
          })
          if (victim.chromeWindowId !== undefined) {
            try {
              await options.extension.request({
                command: 'closeWindow',
                windowId: victim.chromeWindowId,
              })
            } catch (error) {
              log({
                operation: 'browser_window_evict_close',
                owner: victimKey,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
              })
              options.store.replace(beforeEviction)
              throw new BrowserCapacityReachedError()
            }
          }
          existingWindow = undefined
        }
        const created = parseCreatedTab(
          await options.extension.request(
            existingWindow?.chromeWindowId === undefined
              ? { command: 'createWindow', url: 'about:blank' }
              : {
                  command: 'createTab',
                  windowId: existingWindow.chromeWindowId,
                  url: 'about:blank',
                  active: true,
                },
          ),
        )
        if (
          existingWindow?.chromeWindowId !== undefined &&
          created.windowId !== existingWindow.chromeWindowId
        ) {
          throw new Error('Browser extension created tab in the wrong window')
        }
        await options.extension.request({
          command: 'focusWindow',
          windowId: created.windowId,
          tabId: created.tabId,
        })
        focusedWindowId = created.windowId

        const at = options.now()
        const batchId = createBatchId()
        const createdWindow = existingWindow?.chromeWindowId === undefined
        const windows = current.windows.map(candidate =>
          browserOwnerKey(candidate.owner) === browserOwnerKey(owner)
            ? {
                ...candidate,
                ...(createdWindow
                  ? {
                      chromeWindowId: created.windowId,
                      identityTabId: created.tabId,
                      identityTargetId: created.targetId,
                    }
                  : {}),
                lastActivityAt: at,
                phase: 'active' as const,
              }
            : candidate.phase === 'active'
              ? { ...candidate, phase: 'cooling' as const, lastActivityAt: at }
              : candidate,
        )
        if (existingWindow === undefined) {
          windows.push({
            logicalWindowId: createLogicalId(),
            owner,
            chromeWindowId: created.windowId,
            identityTabId: created.tabId,
            identityTargetId: created.targetId,
            lastActivityAt: at,
            phase: 'active',
          })
        }
        options.store.replace({
          ...current,
          windows,
          batches: [
            ...current.batches,
            {
              batchId,
              owner,
              rootTargetId: created.targetId,
              tabs: [
                {
                  logicalTabId: createLogicalId(),
                  tabId: created.tabId,
                  targetId: created.targetId,
                  discarded: false,
                },
              ],
              lastLeaseAt: at,
              createdAt: at,
            },
          ],
        })
        return { batchId, owner, targetId: created.targetId }
      })
    },
    createBatchTab(batchId, url) {
      return serialized(async () => {
        if (url.length === 0) throw new Error('Browser tab URL is required')
        const current = options.store.current()
        const batch = current.batches.find(candidate => candidate.batchId === batchId)
        if (batch === undefined) throw new Error('Browser batch is unavailable')
        const window = current.windows.find(
          candidate => browserOwnerKey(candidate.owner) === browserOwnerKey(batch.owner),
        )
        if (window === undefined) {
          throw new Error('Browser owner window is unavailable')
        }
        const created = parseCreatedTab(
          await options.extension.request(
            window.chromeWindowId === undefined
              ? { command: 'createWindow', url }
              : {
                  command: 'createTab',
                  windowId: window.chromeWindowId,
                  url,
                  active: true,
                },
          ),
        )
        if (window.chromeWindowId !== undefined && created.windowId !== window.chromeWindowId) {
          throw new Error('Browser extension created tab in the wrong window')
        }
        const at = options.now()
        options.store.replace({
          ...current,
          windows: current.windows.map(candidate =>
            browserOwnerKey(candidate.owner) === browserOwnerKey(batch.owner)
              ? {
                  ...candidate,
                  ...(candidate.chromeWindowId === undefined
                    ? {
                        chromeWindowId: created.windowId,
                        identityTabId: created.tabId,
                        identityTargetId: created.targetId,
                      }
                    : {}),
                  lastActivityAt: at,
                }
              : candidate,
          ),
          batches: current.batches.map(candidate =>
            candidate.batchId === batchId
              ? {
                  ...candidate,
                  lastLeaseAt: at,
                  tabs: [
                    ...candidate.tabs,
                    {
                      logicalTabId: createLogicalId(),
                      tabId: created.tabId,
                      targetId: created.targetId,
                      discarded: false,
                    },
                  ],
                }
              : candidate,
          ),
        })
        return { targetId: created.targetId }
      })
    },
    attributePopup(batchId, targetId, openerId) {
      return serialized(async () => {
        const current = options.store.current()
        const batch = current.batches.find(candidate => candidate.batchId === batchId)
        if (
          batch === undefined ||
          !batch.tabs.some(tab => tab.targetId === openerId) ||
          current.batches.some(candidate => candidate.rootTargetId === targetId) ||
          batch.tabs.some(tab => tab.targetId === targetId)
        ) {
          return false
        }
        const window = current.windows.find(
          candidate => browserOwnerKey(candidate.owner) === browserOwnerKey(batch.owner),
        )
        if (window?.chromeWindowId === undefined) return false
        const snapshot = parseSnapshot(await options.extension.request({ command: 'snapshot' }))
        const nativeTab = snapshot.windows
          .flatMap(candidate => candidate.tabs)
          .find(tab => tab.targetId === targetId)
        if (nativeTab === undefined) return false
        const placed =
          nativeTab.windowId === window.chromeWindowId
            ? { windowId: nativeTab.windowId, tabId: nativeTab.tabId, targetId }
            : parseCreatedTab(
                await options.extension.request({
                  command: 'moveTab',
                  tabId: nativeTab.tabId,
                  windowId: window.chromeWindowId,
                }),
              )
        if (placed.windowId !== window.chromeWindowId || placed.targetId !== targetId) {
          throw new Error('Browser extension moved the wrong popup tab')
        }
        const at = options.now()
        options.store.replace({
          ...current,
          windows: current.windows.map(candidate =>
            browserOwnerKey(candidate.owner) === browserOwnerKey(batch.owner)
              ? { ...candidate, lastActivityAt: at }
              : candidate,
          ),
          batches: current.batches.map(candidate =>
            candidate.batchId === batchId
              ? {
                  ...candidate,
                  lastLeaseAt: at,
                  tabs: [
                    ...candidate.tabs,
                    {
                      logicalTabId: createLogicalId(),
                      tabId: placed.tabId,
                      targetId,
                      discarded: false,
                    },
                  ],
                }
              : candidate,
          ),
        })
        return true
      })
    },
    removeBatchTarget(batchId, targetId) {
      return serialized(async () => {
        const current = options.store.current()
        const batch = current.batches.find(candidate => candidate.batchId === batchId)
        if (batch === undefined || !batch.tabs.some(tab => tab.targetId === targetId)) {
          return false
        }
        const ownerKey = browserOwnerKey(batch.owner)
        const ownerWindow = current.windows.find(
          candidate => browserOwnerKey(candidate.owner) === ownerKey,
        )
        const snapshot = parseSnapshot(await options.extension.request({ command: 'snapshot' }))
        const nativeWindow = snapshot.windows.find(
          candidate => candidate.windowId === ownerWindow?.chromeWindowId,
        )
        const replacement =
          nativeWindow?.tabs.find(tab => tab.active && tab.targetId !== undefined) ??
          nativeWindow?.tabs.find(tab => tab.targetId !== undefined)
        const at = options.now()
        options.store.replace({
          ...current,
          windows: current.windows.map(candidate => {
            if (browserOwnerKey(candidate.owner) !== ownerKey) return candidate
            const logical = {
              logicalWindowId: candidate.logicalWindowId,
              owner: candidate.owner,
              lastActivityAt: candidate.lastActivityAt,
              phase: candidate.phase,
            }
            return replacement?.targetId === undefined
              ? { ...logical, lastActivityAt: at }
              : {
                  ...logical,
                  chromeWindowId: nativeWindow!.windowId,
                  identityTabId: replacement.tabId,
                  identityTargetId: replacement.targetId,
                  lastActivityAt: at,
                }
          }),
          batches: current.batches.map(candidate =>
            candidate.batchId === batchId
              ? {
                  ...candidate,
                  ...(candidate.rootTargetId === targetId ? { rootTargetId: undefined } : {}),
                  tabs: candidate.tabs.filter(tab => tab.targetId !== targetId),
                  lastLeaseAt: at,
                }
              : candidate,
          ),
        })
        return true
      })
    },
    openBatchLease(batchId) {
      if (!options.store.current().batches.some(batch => batch.batchId === batchId)) {
        return Promise.reject(new Error('Browser batch is unavailable'))
      }
      liveBatches.add(batchId)
      liveActivityAt.set(batchId, options.now())
      return serialized(async () => {
        if (!options.store.current().batches.some(batch => batch.batchId === batchId)) {
          liveBatches.delete(batchId)
          liveActivityAt.delete(batchId)
          throw new Error('Browser batch is unavailable')
        }
      })
    },
    closeBatchLease(batchId) {
      return serialized(async () => {
        if (!liveBatches.delete(batchId)) return
        const at = liveActivityAt.get(batchId) ?? options.now()
        liveActivityAt.delete(batchId)
        const current = options.store.current()
        const batch = current.batches.find(candidate => candidate.batchId === batchId)
        if (batch === undefined) return
        options.store.replace({
          ...current,
          windows: current.windows.map(candidate =>
            browserOwnerKey(candidate.owner) === browserOwnerKey(batch.owner)
              ? { ...candidate, lastActivityAt: at }
              : candidate,
          ),
          batches: current.batches.map(candidate =>
            candidate.batchId === batchId ? { ...candidate, lastLeaseAt: at } : candidate,
          ),
        })
      })
    },
    touchBatchLease(batchId) {
      if (liveBatches.has(batchId)) liveActivityAt.set(batchId, options.now())
    },
    hasLiveBatch(batchId) {
      return liveBatches.has(batchId)
    },
    handleExtensionEvent(event) {
      return serialized(async () => {
        if (event.event === 'focusTransient') return
        const current = options.store.current()
        if (event.event === 'windowRemoved') {
          if (focusedWindowId === event.windowId) focusedWindowId = undefined
          const removed = current.windows.find(window => window.chromeWindowId === event.windowId)
          if (removed === undefined) return
          const key = browserOwnerKey(removed.owner)
          options.store.replace({
            ...current,
            windows: current.windows.filter(window => browserOwnerKey(window.owner) !== key),
            batches: current.batches.filter(batch => browserOwnerKey(batch.owner) !== key),
          })
          return
        }
        if (event.event === 'tabRemoved') {
          const identityWindow = current.windows.find(
            window => window.identityTabId === event.tabId,
          )
          const binding = current.batches
            .flatMap(batch => batch.tabs.map(tab => ({ batch, tab })))
            .find(candidate => candidate.tab.tabId === event.tabId)
          if (binding === undefined && identityWindow === undefined) return
          let replacement: NativeTabSnapshot | undefined
          let nativeWindowExists = true
          if (identityWindow?.chromeWindowId !== undefined) {
            const snapshot = parseSnapshot(await options.extension.request({ command: 'snapshot' }))
            const nativeWindow = snapshot.windows.find(
              window => window.windowId === identityWindow.chromeWindowId,
            )
            nativeWindowExists = nativeWindow !== undefined
            replacement = nativeWindow?.tabs.find(tab => tab.targetId !== undefined)
          }
          let next =
            binding === undefined
              ? current
              : removeLogicalTab(
                  current,
                  binding.batch.batchId,
                  binding.tab.logicalTabId,
                  replacement,
                )
          if (identityWindow !== undefined && binding === undefined) {
            const key = browserOwnerKey(identityWindow.owner)
            next = nativeWindowExists
              ? {
                  ...next,
                  windows: next.windows.map(window =>
                    browserOwnerKey(window.owner) === key && replacement?.targetId !== undefined
                      ? {
                          ...window,
                          identityTabId: replacement.tabId,
                          identityTargetId: replacement.targetId,
                        }
                      : window,
                  ),
                }
              : {
                  ...next,
                  windows: next.windows.filter(window => browserOwnerKey(window.owner) !== key),
                  batches: next.batches.filter(batch => browserOwnerKey(batch.owner) !== key),
                }
          }
          options.store.replace(next)
          return
        }
        if (event.event === 'tabReplaced') {
          const binding = current.batches
            .flatMap(batch => batch.tabs.map(tab => ({ batch, tab })))
            .find(candidate => candidate.tab.tabId === event.removedTabId)
          if (binding === undefined) return
          const snapshot = parseSnapshot(await options.extension.request({ command: 'snapshot' }))
          const replacement = snapshot.windows
            .flatMap(window => window.tabs)
            .find(tab => tab.tabId === event.addedTabId)
          if (replacement?.targetId === undefined) return
          options.store.replace(
            rebindLogicalTab(
              current,
              binding.batch.batchId,
              binding.tab.logicalTabId,
              event.removedTabId,
              replacement.tabId,
              replacement.targetId,
              false,
            ),
          )
          return
        }
        if (event.event !== 'focusSettled') return
        // Selecting a keeper tab briefly focuses its background window. That is
        // maintenance, not human activity, so it must not restart the idle grace.
        if (event.windowId === maintenanceFocusedWindowId) {
          maintenanceFocusedWindowId = undefined
          return
        }
        if (maintenanceRestorePending) {
          maintenanceFocusedWindowId = undefined
          maintenanceRestorePending = false
        }
        focusedWindowId = event.windowId
        const focused = current.windows.find(window => window.chromeWindowId === event.windowId)
        options.store.replace({
          ...current,
          windows: current.windows.map(window => {
            if (window.chromeWindowId === event.windowId) {
              return { ...window, phase: 'active' as const, lastActivityAt: event.at }
            }
            if (
              window.phase === 'active' &&
              !ownerHasLiveLease(current, window.owner, liveBatches)
            ) {
              return { ...window, phase: 'cooling' as const, lastActivityAt: event.at }
            }
            return window
          }),
        })
        if (focused === undefined) return
      })
    },
    tick() {
      return serialized(async () => {
        const now = options.now()
        let current = options.store.current()
        const snapshot = parseSnapshot(await options.extension.request({ command: 'snapshot' }))
        const nativeFocusedWindowId = snapshot.windows.find(window => window.focused)?.windowId
        focusedWindowId = nativeFocusedWindowId
        const nativeTabs = new Map(
          snapshot.windows.flatMap(window => window.tabs.map(tab => [tab.tabId, tab] as const)),
        )
        const liveOwners = new Set(
          current.batches
            .filter(batch => liveBatches.has(batch.batchId))
            .map(batch => browserOwnerKey(batch.owner)),
        )
        current = options.store.replace({
          ...current,
          windows: current.windows.map(window => {
            const key = browserOwnerKey(window.owner)
            if (window.chromeWindowId === nativeFocusedWindowId || liveOwners.has(key)) {
              return { ...window, phase: 'active' as const }
            }
            if (window.phase === 'active')
              return { ...window, phase: 'cooling' as const, lastActivityAt: now }
            if (
              window.phase === 'cooling' &&
              now - window.lastActivityAt >= BROWSER_IDLE_DISCARD_GRACE_MS
            ) {
              return { ...window, phase: 'idle' as const }
            }
            return window
          }),
        })

        for (const batch of current.batches) {
          if (liveBatches.has(batch.batchId)) continue
          const ownerWindow = current.windows.find(
            window => browserOwnerKey(window.owner) === browserOwnerKey(batch.owner),
          )
          const focused = ownerWindow?.chromeWindowId === nativeFocusedWindowId
          const expired = now - batch.lastLeaseAt >= BROWSER_BATCH_TAB_TTL_MS
          for (const tab of batch.tabs) {
            if (tab.tabId === undefined) continue
            const native = nativeTabs.get(tab.tabId)
            if (native === undefined) continue
            if (expired && !(focused && native.active)) {
              try {
                await options.extension.request({ command: 'closeTab', tabId: tab.tabId })
                const afterClose = parseSnapshot(
                  await options.extension.request({ command: 'snapshot' }),
                )
                const replacementIdentity = afterClose.windows
                  .find(window => window.windowId === ownerWindow?.chromeWindowId)
                  ?.tabs.find(candidate => candidate.targetId !== undefined)
                current = removeLogicalTab(
                  current,
                  batch.batchId,
                  tab.logicalTabId,
                  replacementIdentity,
                )
                options.store.replace(current)
              } catch (error) {
                log({
                  operation: 'browser_tab_expire',
                  logicalTabId: tab.logicalTabId,
                  status: 'failed',
                  error: error instanceof Error ? error.message : String(error),
                })
              }
              continue
            }
            if (ownerWindow?.phase !== 'idle' || tab.discarded) continue
            let restoreFocusWindowId: number | undefined
            try {
              const protection = parseSnapshot(
                await options.extension.request({ command: 'snapshot' }),
              )
              const protectedWindow = protection.windows.find(
                window => window.windowId === ownerWindow.chromeWindowId,
              )
              const protectedTab = protectedWindow?.tabs.find(
                candidate => candidate.tabId === tab.tabId,
              )
              if (
                ownerHasLiveLease(current, batch.owner, liveBatches) ||
                protectedWindow === undefined ||
                protectedWindow.focused ||
                protectedTab === undefined
              ) {
                continue
              }
              if (protectedTab.active) {
                const foregroundWindow = protection.windows.find(window => window.focused)
                if (
                  foregroundWindow !== undefined &&
                  foregroundWindow.windowId !== ownerWindow.chromeWindowId
                ) {
                  restoreFocusWindowId = foregroundWindow.windowId
                  maintenanceFocusedWindowId = protectedWindow.windowId
                  maintenanceRestorePending = true
                }
                const attributedTabIds = new Set(
                  current.batches
                    .filter(
                      candidate =>
                        browserOwnerKey(candidate.owner) === browserOwnerKey(batch.owner),
                    )
                    .flatMap(candidate => candidate.tabs.map(candidateTab => candidateTab.tabId))
                    .filter(candidateTabId => candidateTabId !== undefined),
                )
                const existingKeeper = protectedWindow.tabs.find(
                  candidate =>
                    candidate.tabId !== protectedTab.tabId &&
                    candidate.targetId !== undefined &&
                    !attributedTabIds.has(candidate.tabId),
                )
                const keeper = parseCreatedTab(
                  await options.extension.request(
                    existingKeeper === undefined
                      ? {
                          command: 'createTab',
                          windowId: protectedWindow.windowId,
                          url: 'about:blank',
                          active: true,
                        }
                      : { command: 'activateTab', tabId: existingKeeper.tabId },
                  ),
                )
                current = options.store.replace({
                  ...current,
                  windows: current.windows.map(candidate =>
                    browserOwnerKey(candidate.owner) === browserOwnerKey(batch.owner)
                      ? {
                          ...candidate,
                          identityTabId: keeper.tabId,
                          identityTargetId: keeper.targetId,
                        }
                      : candidate,
                  ),
                })
              }
              const discarded = parseDiscardedTab(
                await options.extension.request({ command: 'discardTab', tabId: tab.tabId }),
                tab.tabId,
              )
              if (discarded.windowId !== ownerWindow.chromeWindowId) {
                throw new Error('Browser extension discarded a tab in the wrong window')
              }
              current = rebindLogicalTab(
                current,
                batch.batchId,
                tab.logicalTabId,
                tab.tabId,
                discarded.replacementTabId,
                discarded.targetId,
              )
              options.store.replace(current)
            } catch (error) {
              log({
                operation: 'browser_tab_discard',
                logicalTabId: tab.logicalTabId,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
              })
            } finally {
              if (restoreFocusWindowId !== undefined) {
                try {
                  await options.extension.request({
                    command: 'focusWindow',
                    windowId: restoreFocusWindowId,
                  })
                  focusedWindowId = restoreFocusWindowId
                } catch (error) {
                  maintenanceFocusedWindowId = undefined
                  maintenanceRestorePending = false
                  log({
                    operation: 'browser_discard_focus_restore',
                    windowId: restoreFocusWindowId,
                    status: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                  })
                }
              }
            }
          }
        }
      })
    },
    lastBrowserActivityAt() {
      const values = [
        ...options.store.current().windows.map(window => window.lastActivityAt),
        ...liveActivityAt.values(),
      ]
      return values.length === 0 ? undefined : Math.max(...values)
    },
    removeOwner(owner) {
      return serialized(async () => {
        const current = options.store.current()
        const key = browserOwnerKey(owner)
        const window = current.windows.find(candidate => browserOwnerKey(candidate.owner) === key)
        if (window === undefined) return false
        options.store.replace({
          ...current,
          windows: current.windows.filter(candidate => browserOwnerKey(candidate.owner) !== key),
          batches: current.batches.filter(batch => browserOwnerKey(batch.owner) !== key),
        })
        for (const batch of current.batches) {
          if (browserOwnerKey(batch.owner) === key) {
            liveBatches.delete(batch.batchId)
            liveActivityAt.delete(batch.batchId)
          }
        }
        if (window.chromeWindowId !== undefined) {
          try {
            await options.extension.request({
              command: 'closeWindow',
              windowId: window.chromeWindowId,
            })
          } catch (error) {
            log({
              operation: 'browser_owner_close',
              owner: key,
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        return true
      })
    },
    focusOwner(owner) {
      return serialized(async () => {
        const current = options.store.current()
        const key = browserOwnerKey(owner)
        const window = current.windows.find(candidate => browserOwnerKey(candidate.owner) === key)
        if (window?.chromeWindowId === undefined) return false
        const snapshot = parseSnapshot(await options.extension.request({ command: 'snapshot' }))
        const native = snapshot.windows.find(
          candidate => candidate.windowId === window.chromeWindowId,
        )
        const identity = native?.tabs.find(
          tab => tab.tabId === window.identityTabId && tab.targetId === window.identityTargetId,
        )
        if (identity === undefined) {
          options.store.replace({
            ...current,
            windows: current.windows.filter(candidate => browserOwnerKey(candidate.owner) !== key),
            batches: current.batches.filter(batch => browserOwnerKey(batch.owner) !== key),
          })
          return false
        }
        await options.extension.request({
          command: 'focusWindow',
          windowId: window.chromeWindowId,
        })
        focusedWindowId = window.chromeWindowId
        const at = options.now()
        options.store.replace({
          ...current,
          windows: current.windows.map(candidate =>
            browserOwnerKey(candidate.owner) === key
              ? { ...candidate, phase: 'active' as const, lastActivityAt: at }
              : candidate.phase === 'active' &&
                  !ownerHasLiveLease(current, candidate.owner, liveBatches)
                ? { ...candidate, phase: 'cooling' as const, lastActivityAt: at }
                : candidate,
          ),
        })
        return true
      })
    },
    activities() {
      const current = options.store.current()
      return current.windows
        .map(window => {
          const key = browserOwnerKey(window.owner)
          const batches = current.batches.filter(batch => browserOwnerKey(batch.owner) === key)
          return {
            owner: window.owner,
            ...(window.owner.kind === 'agent'
              ? { agentSlug: options.agentSlugForId?.(window.owner.agentId) }
              : {}),
            phase: window.phase,
            focused: window.chromeWindowId === focusedWindowId,
            liveBatchCount: batches.filter(batch => liveBatches.has(batch.batchId)).length,
            batchTabCount: batches.reduce((count, batch) => count + batch.tabs.length, 0),
            discardedBatchTabCount: batches.reduce(
              (count, batch) => count + batch.tabs.filter(tab => tab.discarded).length,
              0,
            ),
            lastActiveAt: window.lastActivityAt,
          }
        })
        .sort(
          (left, right) =>
            Number(right.focused) - Number(left.focused) ||
            right.lastActiveAt - left.lastActiveAt ||
            browserOwnerKey(left.owner).localeCompare(browserOwnerKey(right.owner)),
        )
    },
    inventory: () => options.store.current(),
  }
}

function ownerHasLiveLease(
  current: BrowserWindowLedger,
  owner: BrowserOwner,
  live: Set<string>,
): boolean {
  const key = browserOwnerKey(owner)
  return current.batches.some(
    batch => browserOwnerKey(batch.owner) === key && live.has(batch.batchId),
  )
}

function removeLogicalTab(
  current: BrowserWindowLedger,
  batchId: string,
  logicalTabId: string,
  replacement?: NativeTabSnapshot,
): BrowserWindowLedger {
  const batch = current.batches.find(candidate => candidate.batchId === batchId)
  const removed = batch?.tabs.find(tab => tab.logicalTabId === logicalTabId)
  const ownerKey = batch === undefined ? undefined : browserOwnerKey(batch.owner)
  return {
    ...current,
    windows: current.windows.map(window =>
      ownerKey !== undefined &&
      browserOwnerKey(window.owner) === ownerKey &&
      window.identityTabId === removed?.tabId
        ? replacement?.targetId === undefined
          ? {
              logicalWindowId: window.logicalWindowId,
              owner: window.owner,
              lastActivityAt: window.lastActivityAt,
              phase: window.phase,
            }
          : {
              ...window,
              identityTabId: replacement.tabId,
              identityTargetId: replacement.targetId,
            }
        : window,
    ),
    batches: current.batches.map(batch =>
      batch.batchId === batchId
        ? {
            ...batch,
            rootTargetId:
              batch.tabs.find(tab => tab.logicalTabId === logicalTabId)?.targetId ===
              batch.rootTargetId
                ? undefined
                : batch.rootTargetId,
            tabs: batch.tabs.filter(tab => tab.logicalTabId !== logicalTabId),
          }
        : batch,
    ),
  }
}

function rebindLogicalTab(
  current: BrowserWindowLedger,
  batchId: string,
  logicalTabId: string,
  oldTabId: number,
  tabId: number,
  targetId: string,
  discarded = true,
): BrowserWindowLedger {
  return {
    ...current,
    windows: current.windows.map(window =>
      window.identityTabId === oldTabId
        ? { ...window, identityTabId: tabId, identityTargetId: targetId }
        : window,
    ),
    batches: current.batches.map(batch =>
      batch.batchId === batchId
        ? {
            ...batch,
            rootTargetId:
              batch.tabs.find(tab => tab.logicalTabId === logicalTabId)?.targetId ===
              batch.rootTargetId
                ? targetId
                : batch.rootTargetId,
            tabs: batch.tabs.map(tab =>
              tab.logicalTabId === logicalTabId ? { ...tab, tabId, targetId, discarded } : tab,
            ),
          }
        : batch,
    ),
  }
}

function parseDiscardedTab(
  value: unknown,
  removedTabId: number,
): { replacementTabId: number; windowId: number; targetId: string } {
  if (
    !isRecord(value) ||
    value.removedTabId !== removedTabId ||
    !nonnegativeInteger(value.replacementTabId) ||
    !nonnegativeInteger(value.windowId) ||
    typeof value.targetId !== 'string' ||
    value.targetId.length === 0 ||
    value.discarded !== true
  ) {
    throw new Error('Invalid browser extension discard response')
  }
  return {
    replacementTabId: value.replacementTabId,
    windowId: value.windowId,
    targetId: value.targetId,
  }
}

function parseCreatedTab(value: unknown): { windowId: number; tabId: number; targetId: string } {
  if (
    !isRecord(value) ||
    !nonnegativeInteger(value.windowId) ||
    !nonnegativeInteger(value.tabId) ||
    typeof value.targetId !== 'string' ||
    value.targetId.length === 0
  ) {
    throw new Error('Invalid browser extension tab response')
  }
  return { windowId: value.windowId, tabId: value.tabId, targetId: value.targetId }
}

function resetForGeneration(
  browserGeneration: string,
  snapshot: NativeSnapshot,
  at: number,
  createLogicalId: () => string,
): BrowserWindowLedger {
  const bootstrap = snapshot.windows.length === 1 ? snapshot.windows[0] : undefined
  const identity =
    bootstrap?.tabs.find(tab => tab.active && tab.targetId !== undefined) ??
    bootstrap?.tabs.find(tab => tab.targetId !== undefined)
  return {
    version: 1,
    browserGeneration,
    windows:
      bootstrap === undefined || identity?.targetId === undefined
        ? []
        : [
            {
              logicalWindowId: createLogicalId(),
              owner: { kind: 'root' },
              chromeWindowId: bootstrap.windowId,
              identityTabId: identity.tabId,
              identityTargetId: identity.targetId,
              lastActivityAt: at,
              phase: bootstrap.focused ? 'active' : 'idle',
            },
          ],
    batches: [],
  }
}

function reconcileSameGeneration(
  current: BrowserWindowLedger,
  snapshot: NativeSnapshot,
): BrowserWindowLedger {
  const nativeWindows = new Map(snapshot.windows.map(window => [window.windowId, window]))
  const windows = current.windows.flatMap(window => {
    if (
      window.chromeWindowId === undefined ||
      window.identityTabId === undefined ||
      window.identityTargetId === undefined
    ) {
      return []
    }
    const native = nativeWindows.get(window.chromeWindowId)
    if (native === undefined) return []
    const bindingAgrees = native.tabs.some(
      candidate =>
        candidate.tabId === window.identityTabId && candidate.targetId === window.identityTargetId,
    )
    if (!bindingAgrees) return []
    return [
      {
        ...window,
        phase: native.focused
          ? ('active' as const)
          : window.phase === 'active'
            ? 'cooling'
            : window.phase,
      },
    ]
  })
  const retainedOwners = new Set(windows.map(window => browserOwnerKey(window.owner)))
  const nativeByOwner = new Map<BrowserOwnerKey, NativeWindowSnapshot>()
  for (const window of windows) {
    const native = nativeWindows.get(window.chromeWindowId!)
    if (native !== undefined) nativeByOwner.set(browserOwnerKey(window.owner), native)
  }

  const batches = current.batches.flatMap(batch => {
    const ownerKey = browserOwnerKey(batch.owner)
    if (!retainedOwners.has(ownerKey)) return []
    const native = nativeByOwner.get(ownerKey)
    if (native === undefined) return []
    const tabs = batch.tabs.filter(tab =>
      native.tabs.some(
        candidate =>
          candidate.tabId === tab.tabId &&
          (tab.targetId === undefined || candidate.targetId === tab.targetId),
      ),
    )
    return [
      {
        ...batch,
        ...(batch.rootTargetId !== undefined &&
        !tabs.some(tab => tab.targetId === batch.rootTargetId)
          ? { rootTargetId: undefined }
          : {}),
        tabs,
      },
    ]
  })

  return { ...current, windows, batches }
}

function parseSnapshot(value: unknown): NativeSnapshot {
  if (!isRecord(value) || !Array.isArray(value.windows)) {
    throw new Error('Invalid browser extension snapshot')
  }
  const windows: NativeWindowSnapshot[] = value.windows.map(window => {
    if (
      !isRecord(window) ||
      !nonnegativeInteger(window.windowId) ||
      typeof window.focused !== 'boolean' ||
      !Array.isArray(window.tabs)
    ) {
      throw new Error('Invalid browser extension snapshot')
    }
    const tabs = window.tabs.map(tab => {
      if (
        !isRecord(tab) ||
        !nonnegativeInteger(tab.tabId) ||
        !nonnegativeInteger(tab.windowId) ||
        tab.windowId !== window.windowId ||
        typeof tab.active !== 'boolean' ||
        (tab.targetId !== undefined && typeof tab.targetId !== 'string')
      ) {
        throw new Error('Invalid browser extension snapshot')
      }
      return {
        tabId: tab.tabId,
        windowId: tab.windowId,
        active: tab.active,
        ...(tab.targetId === undefined ? {} : { targetId: tab.targetId }),
      }
    })
    return { windowId: window.windowId, focused: window.focused, tabs }
  })
  const windowIds = new Set(windows.map(window => window.windowId))
  const tabIds = new Set(windows.flatMap(window => window.tabs.map(tab => tab.tabId)))
  if (
    windowIds.size !== windows.length ||
    tabIds.size !== windows.reduce((count, window) => count + window.tabs.length, 0)
  ) {
    throw new Error('Invalid browser extension snapshot')
  }
  return { windows }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
