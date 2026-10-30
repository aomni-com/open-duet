import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BrowserOwnerSchema,
  browserOwnerKey,
  type BrowserOwner,
  type DesktopOwnerPhase,
} from '@repo/contract'

import {
  defaultAtomicJsonOperations,
  writeAtomicJson,
  type AtomicJsonOperations,
} from '../atomic-json'

export const BROWSER_LEDGER_RELATIVE_PATH = join('desktop', 'browser-ledger.json')

export interface BrowserLedgerWindow {
  logicalWindowId: string
  owner: BrowserOwner
  chromeWindowId?: number
  identityTabId?: number
  identityTargetId?: string
  lastActivityAt: number
  phase: DesktopOwnerPhase
}

export interface BrowserLedgerTab {
  logicalTabId: string
  tabId?: number
  targetId?: string
  discarded: boolean
}

export interface BrowserLedgerBatch {
  batchId: string
  owner: BrowserOwner
  rootTargetId?: string
  tabs: BrowserLedgerTab[]
  lastLeaseAt: number
  createdAt: number
}

export interface BrowserWindowLedger {
  version: 1
  browserGeneration?: string
  windows: BrowserLedgerWindow[]
  batches: BrowserLedgerBatch[]
}

export interface BrowserWindowLedgerStore {
  current(): BrowserWindowLedger
  replace(next: BrowserWindowLedger): BrowserWindowLedger
}

export function createBrowserWindowLedgerStore(
  stateDir: string,
  operations: AtomicJsonOperations = defaultAtomicJsonOperations,
): BrowserWindowLedgerStore {
  const path = join(stateDir, BROWSER_LEDGER_RELATIVE_PATH)
  let current = readLedger(path)

  return {
    current: () => structuredClone(current),
    replace(next) {
      const validated = parseLedger(next)
      if (validated === null) throw new Error('Invalid browser window ledger')
      try {
        writeAtomicJson(path, validated, operations)
      } catch (error) {
        // Rename commits before the directory fsync. If that final durability
        // acknowledgement fails, disk—not the previous cache—is authoritative.
        current = readLedger(path)
        throw error
      }
      current = structuredClone(validated)
      return structuredClone(current)
    },
  }
}

function readLedger(path: string): BrowserWindowLedger {
  try {
    return parseLedger(JSON.parse(readFileSync(path, 'utf8'))) ?? emptyLedger()
  } catch {
    return emptyLedger()
  }
}

function parseLedger(value: unknown): BrowserWindowLedger | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.windows)) return null
  if (!Array.isArray(value.batches)) return null
  if (
    value.browserGeneration !== undefined &&
    (typeof value.browserGeneration !== 'string' || value.browserGeneration.length === 0)
  ) {
    return null
  }

  const windows: BrowserLedgerWindow[] = []
  const ownerKeys = new Set<string>()
  const logicalWindowIds = new Set<string>()
  for (const item of value.windows) {
    if (!isRecord(item)) return null
    const owner = BrowserOwnerSchema.safeParse(item.owner)
    if (
      !owner.success ||
      !nonempty(item.logicalWindowId) ||
      !nonnegativeInteger(item.lastActivityAt) ||
      !isPhase(item.phase) ||
      (item.chromeWindowId !== undefined && !nonnegativeInteger(item.chromeWindowId)) ||
      (item.identityTabId !== undefined && !nonnegativeInteger(item.identityTabId)) ||
      (item.identityTargetId !== undefined && !nonempty(item.identityTargetId)) ||
      !sameBindingPresence(item)
    ) {
      return null
    }
    const ownerKey = browserOwnerKey(owner.data)
    if (ownerKeys.has(ownerKey) || logicalWindowIds.has(item.logicalWindowId)) return null
    ownerKeys.add(ownerKey)
    logicalWindowIds.add(item.logicalWindowId)
    windows.push({
      logicalWindowId: item.logicalWindowId,
      owner: owner.data,
      ...(item.chromeWindowId === undefined ? {} : { chromeWindowId: item.chromeWindowId }),
      ...(item.identityTabId === undefined ? {} : { identityTabId: item.identityTabId }),
      ...(item.identityTargetId === undefined ? {} : { identityTargetId: item.identityTargetId }),
      lastActivityAt: item.lastActivityAt,
      phase: item.phase,
    })
  }

  const batches: BrowserLedgerBatch[] = []
  const batchIds = new Set<string>()
  const logicalTabIds = new Set<string>()
  for (const item of value.batches) {
    if (!isRecord(item) || !Array.isArray(item.tabs)) return null
    const owner = BrowserOwnerSchema.safeParse(item.owner)
    if (
      !owner.success ||
      !ownerKeys.has(browserOwnerKey(owner.data)) ||
      !nonempty(item.batchId) ||
      batchIds.has(item.batchId) ||
      !nonnegativeInteger(item.lastLeaseAt) ||
      !nonnegativeInteger(item.createdAt) ||
      (item.rootTargetId !== undefined && !nonempty(item.rootTargetId))
    ) {
      return null
    }
    const tabs: BrowserLedgerTab[] = []
    for (const tab of item.tabs) {
      if (
        !isRecord(tab) ||
        !nonempty(tab.logicalTabId) ||
        logicalTabIds.has(tab.logicalTabId) ||
        typeof tab.discarded !== 'boolean' ||
        (tab.tabId !== undefined && !nonnegativeInteger(tab.tabId)) ||
        (tab.targetId !== undefined && !nonempty(tab.targetId))
      ) {
        return null
      }
      logicalTabIds.add(tab.logicalTabId)
      tabs.push({
        logicalTabId: tab.logicalTabId,
        ...(tab.tabId === undefined ? {} : { tabId: tab.tabId }),
        ...(tab.targetId === undefined ? {} : { targetId: tab.targetId }),
        discarded: tab.discarded,
      })
    }
    batchIds.add(item.batchId)
    batches.push({
      batchId: item.batchId,
      owner: owner.data,
      ...(item.rootTargetId === undefined ? {} : { rootTargetId: item.rootTargetId }),
      tabs,
      lastLeaseAt: item.lastLeaseAt,
      createdAt: item.createdAt,
    })
  }

  return {
    version: 1,
    ...(value.browserGeneration === undefined
      ? {}
      : { browserGeneration: value.browserGeneration }),
    windows,
    batches,
  }
}

function emptyLedger(): BrowserWindowLedger {
  return { version: 1, windows: [], batches: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPhase(value: unknown): value is DesktopOwnerPhase {
  return value === 'active' || value === 'cooling' || value === 'idle'
}

function sameBindingPresence(item: Record<string, unknown>): boolean {
  const fields = [item.chromeWindowId, item.identityTabId, item.identityTargetId]
  return fields.every(value => value === undefined) || fields.every(value => value !== undefined)
}
