import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BROWSER_BATCH_TAB_TTL_MS, BROWSER_IDLE_DISCARD_GRACE_MS } from '@repo/contract'

import { createBrowserWindowLedgerStore } from './browser-ledger'
import {
  createBrowserReconciliationTrigger,
  createDesktopBrowserManager,
  type BrowserReconciliationResult,
} from './browser-manager'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => (resolve = done)), resolve }
}

test('a new Chrome generation adopts only its sole bootstrap window as root', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  const manager = createDesktopBrowserManager({
    store,
    now: () => 100,
    createLogicalId: () => 'logical-root',
    extension: {
      request: async () => ({
        windows: [
          {
            windowId: 7,
            focused: true,
            state: 'normal',
            tabs: [
              {
                tabId: 8,
                windowId: 7,
                active: true,
                discarded: false,
                targetId: 'target-bootstrap',
              },
            ],
          },
        ],
      }),
    },
  })

  const adopted = {
    verdict: 'adopted-root',
    ledger: {
      version: 1,
      browserGeneration: 'chrome-generation-1',
      windows: [
        {
          logicalWindowId: 'logical-root',
          owner: { kind: 'root' },
          chromeWindowId: 7,
          identityTabId: 8,
          identityTargetId: 'target-bootstrap',
          lastActivityAt: 100,
          phase: 'active',
        },
      ],
      batches: [],
    },
  } satisfies BrowserReconciliationResult
  expect(await manager.reconcile('chrome-generation-1')).toEqual(adopted)
  expect(await manager.reconcile('chrome-generation-1')).toEqual({
    verdict: 'preserved',
    ledger: adopted.ledger,
  })
  expect(store.current()).toEqual(manager.inventory())
})

test('each root browser batch gets a fresh tab in the adopted root window and focuses it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-batch-root-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    browserGeneration: 'generation-1',
    windows: [
      {
        logicalWindowId: 'window-root',
        owner: { kind: 'root' },
        chromeWindowId: 7,
        identityTabId: 8,
        identityTargetId: 'bootstrap-target',
        lastActivityAt: 1,
        phase: 'idle',
      },
    ],
    batches: [],
  })
  const commands: unknown[] = []
  const manager = createDesktopBrowserManager({
    store,
    now: () => 100,
    createBatchId: () => 'batch-root-1',
    createLogicalId: () => 'logical-tab-1',
    extension: {
      request: async command => {
        commands.push(command)
        if (command.command === 'createTab') {
          return { windowId: 7, tabId: 9, targetId: 'target-root-1' }
        }
        if (command.command === 'focusWindow') return { windowId: 7 }
        throw new Error('unexpected command')
      },
    },
  })

  expect(await manager.startBatch({ kind: 'root' })).toEqual({
    batchId: 'batch-root-1',
    owner: { kind: 'root' },
    targetId: 'target-root-1',
  })
  expect(commands).toEqual([
    { command: 'createTab', windowId: 7, url: 'about:blank', active: true },
    { command: 'focusWindow', windowId: 7, tabId: 9 },
  ])
  expect(manager.inventory()).toMatchObject({
    windows: [{ owner: { kind: 'root' }, lastActivityAt: 100, phase: 'active' }],
    batches: [
      {
        batchId: 'batch-root-1',
        owner: { kind: 'root' },
        rootTargetId: 'target-root-1',
        tabs: [
          {
            logicalTabId: 'logical-tab-1',
            tabId: 9,
            targetId: 'target-root-1',
            discarded: false,
          },
        ],
        lastLeaseAt: 100,
        createdAt: 100,
      },
    ],
  })
})

test('an agent first use creates and durably claims one focused owner window', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-batch-agent-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    browserGeneration: 'generation-1',
    windows: [],
    batches: [],
  })
  const ids = ['window-agent-a', 'tab-agent-a']
  const commands: unknown[] = []
  const manager = createDesktopBrowserManager({
    store,
    now: () => 200,
    createBatchId: () => 'batch-agent-a',
    createLogicalId: () => ids.shift()!,
    extension: {
      request: async command => {
        commands.push(command)
        if (command.command === 'createWindow') {
          return { windowId: 20, tabId: 21, targetId: 'target-agent-a' }
        }
        if (command.command === 'focusWindow') return { windowId: 20 }
        throw new Error('unexpected command')
      },
    },
  })

  expect(await manager.startBatch({ kind: 'agent', agentId: 'agent-a' })).toEqual({
    batchId: 'batch-agent-a',
    owner: { kind: 'agent', agentId: 'agent-a' },
    targetId: 'target-agent-a',
  })
  expect(commands).toEqual([
    { command: 'createWindow', url: 'about:blank' },
    { command: 'focusWindow', windowId: 20, tabId: 21 },
  ])
  expect(manager.inventory()).toMatchObject({
    windows: [
      {
        logicalWindowId: 'window-agent-a',
        owner: { kind: 'agent', agentId: 'agent-a' },
        chromeWindowId: 20,
        identityTabId: 21,
        identityTargetId: 'target-agent-a',
      },
    ],
    batches: [
      {
        batchId: 'batch-agent-a',
        rootTargetId: 'target-agent-a',
        tabs: [{ logicalTabId: 'tab-agent-a', tabId: 21, targetId: 'target-agent-a' }],
      },
    ],
  })
})

test('an eleventh owner gets a retryable capacity error before Chrome is mutated', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-capacity-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    browserGeneration: 'generation-1',
    windows: Array.from({ length: 10 }, (_, index) => ({
      logicalWindowId: `window-${index}`,
      owner:
        index === 0
          ? ({ kind: 'root' } as const)
          : ({ kind: 'agent', agentId: `agent-${index}` } as const),
      chromeWindowId: index + 1,
      identityTabId: index + 101,
      identityTargetId: `target-${index}`,
      lastActivityAt: index,
      phase: 'active' as const,
    })),
    batches: [],
  })
  let requested = false
  const manager = createDesktopBrowserManager({
    store,
    now: () => 200,
    extension: {
      request: async () => {
        requested = true
        throw new Error('must not reach Chrome')
      },
    },
  })

  await expect(manager.startBatch({ kind: 'agent', agentId: 'agent-10' })).rejects.toMatchObject({
    code: 'browser_capacity',
    retryable: true,
    retryAfterMs: 60_000,
  })
  expect(requested).toBe(false)
})

test('a batch-created page is placed in its owner window and added to attribution', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-create-page-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    browserGeneration: 'generation-1',
    windows: [
      {
        logicalWindowId: 'window-agent',
        owner: { kind: 'agent', agentId: 'agent-a' },
        chromeWindowId: 20,
        identityTabId: 21,
        identityTargetId: 'root-target',
        lastActivityAt: 100,
        phase: 'active',
      },
    ],
    batches: [
      {
        batchId: 'batch-a',
        owner: { kind: 'agent', agentId: 'agent-a' },
        rootTargetId: 'root-target',
        tabs: [
          {
            logicalTabId: 'root-tab',
            tabId: 21,
            targetId: 'root-target',
            discarded: false,
          },
        ],
        lastLeaseAt: 100,
        createdAt: 100,
      },
    ],
  })
  const manager = createDesktopBrowserManager({
    store,
    now: () => 150,
    createLogicalId: () => 'second-tab',
    extension: {
      request: async command => {
        expect(command).toEqual({
          command: 'createTab',
          windowId: 20,
          url: 'https://example.com/',
          active: true,
        })
        return { windowId: 20, tabId: 22, targetId: 'second-target' }
      },
    },
  })

  expect(await manager.createBatchTab('batch-a', 'https://example.com/')).toEqual({
    targetId: 'second-target',
  })
  expect(manager.inventory().batches[0]).toMatchObject({
    lastLeaseAt: 150,
    tabs: [
      { logicalTabId: 'root-tab', targetId: 'root-target' },
      { logicalTabId: 'second-tab', tabId: 22, targetId: 'second-target', discarded: false },
    ],
  })
})

test('a popup descendant is moved into its opener batch owner window and attributed', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-popup-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    browserGeneration: 'generation-1',
    windows: [
      {
        logicalWindowId: 'window-agent',
        owner: { kind: 'agent', agentId: 'agent-a' },
        chromeWindowId: 20,
        identityTabId: 21,
        identityTargetId: 'root-target',
        lastActivityAt: 100,
        phase: 'active',
      },
    ],
    batches: [
      {
        batchId: 'batch-a',
        owner: { kind: 'agent', agentId: 'agent-a' },
        rootTargetId: 'root-target',
        tabs: [
          {
            logicalTabId: 'root-tab',
            tabId: 21,
            targetId: 'root-target',
            discarded: false,
          },
        ],
        lastLeaseAt: 100,
        createdAt: 100,
      },
    ],
  })
  const commands: unknown[] = []
  const manager = createDesktopBrowserManager({
    store,
    now: () => 160,
    createLogicalId: () => 'popup-tab',
    extension: {
      request: async command => {
        commands.push(command)
        if (command.command === 'snapshot') {
          return {
            windows: [
              {
                windowId: 99,
                focused: false,
                state: 'normal',
                tabs: [
                  {
                    tabId: 30,
                    windowId: 99,
                    active: true,
                    discarded: false,
                    targetId: 'popup-target',
                  },
                ],
              },
            ],
          }
        }
        if (command.command === 'moveTab') {
          return { windowId: 20, tabId: 30, targetId: 'popup-target' }
        }
        throw new Error('unexpected command')
      },
    },
  })

  expect(await manager.attributePopup('batch-a', 'popup-target', 'root-target')).toBe(true)
  expect(commands).toEqual([
    { command: 'snapshot' },
    { command: 'moveTab', tabId: 30, windowId: 20 },
  ])
  expect(manager.inventory().batches[0]?.tabs).toContainEqual({
    logicalTabId: 'popup-tab',
    tabId: 30,
    targetId: 'popup-target',
    discarded: false,
  })
})

test('the live batch lease records its final command activity exactly once on disconnect', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-lease-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    browserGeneration: 'generation-1',
    windows: [
      {
        logicalWindowId: 'window-root',
        owner: { kind: 'root' },
        chromeWindowId: 1,
        identityTabId: 2,
        identityTargetId: 'target-root',
        lastActivityAt: 10,
        phase: 'active',
      },
    ],
    batches: [
      {
        batchId: 'batch-root',
        owner: { kind: 'root' },
        rootTargetId: 'target-root',
        tabs: [
          {
            logicalTabId: 'tab-root',
            tabId: 2,
            targetId: 'target-root',
            discarded: false,
          },
        ],
        lastLeaseAt: 10,
        createdAt: 10,
      },
    ],
  })
  let now = 20
  const manager = createDesktopBrowserManager({
    store,
    now: () => now,
    extension: { request: async () => ({ windows: [] }) },
  })

  await manager.openBatchLease('batch-root')
  expect(manager.hasLiveBatch('batch-root')).toBe(true)
  now = 30
  manager.touchBatchLease('batch-root')
  now = 40
  await manager.closeBatchLease('batch-root')
  await manager.closeBatchLease('batch-root')

  expect(manager.hasLiveBatch('batch-root')).toBe(false)
  expect(manager.inventory()).toMatchObject({
    windows: [{ lastActivityAt: 30 }],
    batches: [{ batchId: 'batch-root', lastLeaseAt: 30 }],
  })
})

test('closing the sole batch target clears attribution and lets the lease recreate its owner window', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-close-root-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    browserGeneration: 'generation-1',
    windows: [
      {
        logicalWindowId: 'window-agent',
        owner: { kind: 'agent', agentId: 'agent-a' },
        chromeWindowId: 20,
        identityTabId: 21,
        identityTargetId: 'target-root',
        lastActivityAt: 10,
        phase: 'active',
      },
    ],
    batches: [
      {
        batchId: 'batch-a',
        owner: { kind: 'agent', agentId: 'agent-a' },
        rootTargetId: 'target-root',
        tabs: [
          {
            logicalTabId: 'tab-root',
            tabId: 21,
            targetId: 'target-root',
            discarded: false,
          },
        ],
        lastLeaseAt: 10,
        createdAt: 10,
      },
    ],
  })
  const commands: unknown[] = []
  const manager = createDesktopBrowserManager({
    store,
    now: () => 20,
    createLogicalId: () => 'replacement-tab',
    extension: {
      request: async command => {
        commands.push(command)
        if (command.command === 'snapshot') return { windows: [] }
        if (command.command === 'createWindow') {
          return { windowId: 30, tabId: 31, targetId: 'target-replacement' }
        }
        throw new Error('unexpected command')
      },
    },
  })

  expect(await manager.removeBatchTarget('batch-a', 'target-root')).toBe(true)
  expect(manager.inventory()).toMatchObject({
    windows: [
      {
        logicalWindowId: 'window-agent',
        owner: { kind: 'agent', agentId: 'agent-a' },
      },
    ],
    batches: [{ batchId: 'batch-a', tabs: [] }],
  })
  expect(manager.inventory().windows[0]).not.toHaveProperty('chromeWindowId')

  expect(await manager.createBatchTab('batch-a', 'about:blank')).toEqual({
    targetId: 'target-replacement',
  })
  expect(commands).toEqual([
    { command: 'snapshot' },
    { command: 'createWindow', url: 'about:blank' },
  ])
  expect(manager.inventory()).toMatchObject({
    windows: [
      {
        chromeWindowId: 30,
        identityTabId: 31,
        identityTargetId: 'target-replacement',
      },
    ],
    batches: [
      {
        batchId: 'batch-a',
        tabs: [
          {
            logicalTabId: 'replacement-tab',
            tabId: 31,
            targetId: 'target-replacement',
          },
        ],
      },
    ],
  })
})

test('a gateway-only restart preserves exact owner bindings that Chrome still proves', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-restart-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  const before = store.replace({
    version: 1,
    browserGeneration: 'same-generation',
    windows: [
      {
        logicalWindowId: 'window-agent',
        owner: { kind: 'agent', agentId: 'agent-a' },
        chromeWindowId: 10,
        identityTabId: 11,
        identityTargetId: 'target-a',
        lastActivityAt: 20,
        phase: 'idle',
      },
    ],
    batches: [
      {
        batchId: 'batch-a',
        owner: { kind: 'agent', agentId: 'agent-a' },
        rootTargetId: 'target-a',
        tabs: [
          {
            logicalTabId: 'tab-a',
            tabId: 11,
            targetId: 'target-a',
            discarded: false,
          },
        ],
        lastLeaseAt: 20,
        createdAt: 10,
      },
    ],
  })
  const manager = createDesktopBrowserManager({
    store: createBrowserWindowLedgerStore(stateDir),
    now: () => 30,
    extension: {
      request: async () => ({
        windows: [
          {
            windowId: 10,
            focused: false,
            state: 'normal',
            tabs: [
              {
                tabId: 11,
                windowId: 10,
                active: false,
                discarded: false,
                targetId: 'target-a',
              },
            ],
          },
        ],
      }),
    },
  })

  expect(await manager.reconcile('same-generation')).toEqual({
    verdict: 'preserved',
    ledger: before,
  })
})

test('same-generation reconciliation drops closed or ambiguously reused owner windows', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-stale-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    browserGeneration: 'generation-1',
    windows: [
      {
        logicalWindowId: 'window-agent',
        owner: { kind: 'agent', agentId: 'agent-a' },
        chromeWindowId: 10,
        identityTabId: 11,
        identityTargetId: 'target-old',
        lastActivityAt: 20,
        phase: 'idle',
      },
    ],
    batches: [
      {
        batchId: 'batch-a',
        owner: { kind: 'agent', agentId: 'agent-a' },
        rootTargetId: 'target-old',
        tabs: [
          {
            logicalTabId: 'tab-a',
            tabId: 11,
            targetId: 'target-old',
            discarded: false,
          },
        ],
        lastLeaseAt: 20,
        createdAt: 10,
      },
    ],
  })
  const manager = createDesktopBrowserManager({
    store,
    now: () => 30,
    extension: {
      request: async () => ({
        windows: [
          {
            windowId: 10,
            focused: true,
            state: 'normal',
            tabs: [
              {
                tabId: 11,
                windowId: 10,
                active: true,
                discarded: false,
                targetId: 'target-reused',
              },
            ],
          },
        ],
      }),
    },
  })

  expect((await manager.reconcile('generation-1')).ledger).toEqual({
    version: 1,
    browserGeneration: 'generation-1',
    windows: [],
    batches: [],
  })
})

test('a Chrome restart destructively resets old ownership before root re-adoption', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-generation-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    browserGeneration: 'old-generation',
    windows: [
      {
        logicalWindowId: 'old-agent-window',
        owner: { kind: 'agent', agentId: 'agent-a' },
        chromeWindowId: 10,
        identityTabId: 11,
        identityTargetId: 'old-target',
        lastActivityAt: 20,
        phase: 'idle',
      },
    ],
    batches: [],
  })
  const manager = createDesktopBrowserManager({
    store,
    now: () => 50,
    createLogicalId: () => 'new-root-window',
    extension: {
      request: async () => ({
        windows: [
          {
            windowId: 20,
            focused: true,
            state: 'normal',
            tabs: [
              {
                tabId: 21,
                windowId: 20,
                active: true,
                discarded: false,
                targetId: 'new-root-target',
              },
            ],
          },
        ],
      }),
    },
  })

  expect((await manager.reconcile('new-generation')).ledger).toEqual({
    version: 1,
    browserGeneration: 'new-generation',
    windows: [
      {
        logicalWindowId: 'new-root-window',
        owner: { kind: 'root' },
        chromeWindowId: 20,
        identityTabId: 21,
        identityTargetId: 'new-root-target',
        lastActivityAt: 50,
        phase: 'active',
      },
    ],
    batches: [],
  })
})

test('an ambiguous native snapshot fails without replacing durable ownership', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-ambiguous-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  const before = store.replace({
    version: 1,
    browserGeneration: 'generation-1',
    windows: [],
    batches: [],
  })
  const manager = createDesktopBrowserManager({
    store,
    now: () => 50,
    extension: {
      request: async () => ({
        windows: [
          {
            windowId: 20,
            focused: true,
            state: 'normal',
            tabs: [
              {
                tabId: 21,
                windowId: 999,
                active: true,
                discarded: false,
                targetId: 'target-wrong-window',
              },
            ],
          },
        ],
      }),
    },
  })

  await expect(manager.reconcile('generation-1')).rejects.toThrow(
    'Invalid browser extension snapshot',
  )
  expect(store.current()).toEqual(before)
})

test('a superseded extension connection cannot reconcile after the latest one', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  const discoveries = [first, second]
  const reconciled: string[] = []
  const trigger = createBrowserReconciliationTrigger({
    discoverGeneration: () => discoveries.shift()!.promise,
    reconcile: async generation => {
      reconciled.push(generation)
      return {
        verdict: 'reset',
        ledger: { version: 1, browserGeneration: generation, windows: [], batches: [] },
      }
    },
  })

  const stale = trigger.connected()
  const latest = trigger.connected()
  second.resolve('generation-new')
  expect(await latest).toMatchObject({ ledger: { browserGeneration: 'generation-new' } })
  first.resolve('generation-old')
  expect(await stale).toBeUndefined()
  expect(reconciled).toEqual(['generation-new'])
})

test('idle lifecycle discards a background batch tab at 60 seconds and atomically rebinds it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-discard-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    browserGeneration: 'generation-1',
    windows: [
      {
        logicalWindowId: 'window-a',
        owner: { kind: 'agent', agentId: 'a' },
        chromeWindowId: 10,
        identityTabId: 100,
        identityTargetId: 'human-target',
        lastActivityAt: 0,
        phase: 'cooling',
      },
    ],
    batches: [
      {
        batchId: 'batch-a',
        owner: { kind: 'agent', agentId: 'a' },
        rootTargetId: 'old-target',
        lastLeaseAt: 0,
        createdAt: 0,
        tabs: [
          { logicalTabId: 'logical-tab', tabId: 11, targetId: 'old-target', discarded: false },
        ],
      },
    ],
  })
  let now = BROWSER_IDLE_DISCARD_GRACE_MS - 1
  let activeTabId = 11
  const commands: unknown[] = []
  const snapshot = () => ({
    windows: [
      {
        windowId: 10,
        focused: false,
        state: 'normal',
        tabs: [
          {
            tabId: 100,
            windowId: 10,
            active: activeTabId === 100,
            discarded: false,
            targetId: 'human-target',
          },
          {
            tabId: 11,
            windowId: 10,
            active: activeTabId === 11,
            discarded: false,
            targetId: 'old-target',
          },
        ],
      },
      {
        windowId: 20,
        focused: true,
        state: 'normal',
        tabs: [
          {
            tabId: 200,
            windowId: 20,
            active: true,
            discarded: false,
            targetId: 'foreground-target',
          },
        ],
      },
    ],
  })
  const manager = createDesktopBrowserManager({
    store,
    now: () => now,
    extension: {
      request: async command => {
        commands.push(command)
        if (command.command === 'snapshot') return snapshot()
        if (command.command === 'activateTab') {
          activeTabId = command.tabId
          return { tabId: 100, windowId: 10, targetId: 'human-target' }
        }
        if (command.command === 'discardTab') {
          if (activeTabId === command.tabId) throw new Error('Chrome refuses active tab discard')
          return {
            removedTabId: 11,
            replacementTabId: 12,
            windowId: 10,
            targetId: 'replacement-target',
            discarded: true,
          }
        }
        if (command.command === 'focusWindow') return { windowId: command.windowId }
        throw new Error('unexpected command')
      },
    },
  })

  await manager.tick()
  expect(commands).toEqual([{ command: 'snapshot' }])
  now = BROWSER_IDLE_DISCARD_GRACE_MS
  await manager.tick()
  expect(commands.slice(-3)).toEqual([
    { command: 'activateTab', tabId: 100 },
    { command: 'discardTab', tabId: 11 },
    { command: 'focusWindow', windowId: 20 },
  ])
  expect(commands.at(-1)).toEqual({ command: 'focusWindow', windowId: 20 })
  expect(manager.inventory()).toMatchObject({
    windows: [{ phase: 'idle' }],
    batches: [
      {
        rootTargetId: 'replacement-target',
        tabs: [
          {
            logicalTabId: 'logical-tab',
            tabId: 12,
            targetId: 'replacement-target',
            discarded: true,
          },
        ],
      },
    ],
  })

  await manager.handleExtensionEvent({
    type: 'event',
    event: 'focusSettled',
    windowId: 10,
    at: now,
  })
  await manager.handleExtensionEvent({
    type: 'event',
    event: 'focusSettled',
    windowId: 20,
    at: now,
  })
  expect(manager.inventory().windows).toEqual([
    expect.objectContaining({ chromeWindowId: 10, phase: 'idle' }),
  ])
})

test('idle discard creates one unowned keeper when the selected batch tab is alone', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-discard-keeper-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    windows: [
      {
        logicalWindowId: 'window-a',
        owner: { kind: 'agent', agentId: 'a' },
        chromeWindowId: 10,
        identityTabId: 11,
        identityTargetId: 'old-target',
        lastActivityAt: 0,
        phase: 'cooling',
      },
    ],
    batches: [
      {
        batchId: 'batch-a',
        owner: { kind: 'agent', agentId: 'a' },
        rootTargetId: 'old-target',
        lastLeaseAt: 0,
        createdAt: 0,
        tabs: [
          { logicalTabId: 'logical-tab', tabId: 11, targetId: 'old-target', discarded: false },
        ],
      },
    ],
  })
  let activeTabId = 11
  let discarded = false
  let keeperRemoved = false
  const commands: unknown[] = []
  const manager = createDesktopBrowserManager({
    store,
    now: () => BROWSER_IDLE_DISCARD_GRACE_MS,
    extension: {
      request: async command => {
        commands.push(command)
        if (command.command === 'snapshot') {
          return {
            windows: [
              {
                windowId: 10,
                focused: false,
                state: 'normal',
                tabs: discarded
                  ? [
                      ...(keeperRemoved
                        ? []
                        : [
                            {
                              tabId: 12,
                              windowId: 10,
                              active: true,
                              discarded: false,
                              targetId: 'keeper-target',
                            },
                          ]),
                      {
                        tabId: 13,
                        windowId: 10,
                        active: keeperRemoved,
                        discarded: true,
                        targetId: 'discarded-target',
                      },
                    ]
                  : [
                      {
                        tabId: 11,
                        windowId: 10,
                        active: activeTabId === 11,
                        discarded: false,
                        targetId: 'old-target',
                      },
                    ],
              },
            ],
          }
        }
        if (command.command === 'createTab') {
          activeTabId = 12
          return { tabId: 12, windowId: 10, targetId: 'keeper-target' }
        }
        if (command.command === 'discardTab') {
          if (activeTabId === command.tabId) throw new Error('Chrome refuses active tab discard')
          discarded = true
          return {
            removedTabId: 11,
            replacementTabId: 13,
            windowId: 10,
            targetId: 'discarded-target',
            discarded: true,
          }
        }
        throw new Error('unexpected command')
      },
    },
  })

  await manager.tick()
  expect(commands.slice(-2)).toEqual([
    { command: 'createTab', windowId: 10, url: 'about:blank', active: true },
    { command: 'discardTab', tabId: 11 },
  ])
  expect(manager.inventory()).toMatchObject({
    windows: [{ identityTabId: 12, identityTargetId: 'keeper-target' }],
    batches: [{ tabs: [{ tabId: 13, targetId: 'discarded-target', discarded: true }] }],
  })

  keeperRemoved = true
  await manager.handleExtensionEvent({
    type: 'event',
    event: 'tabRemoved',
    tabId: 12,
    windowId: 10,
    at: BROWSER_IDLE_DISCARD_GRACE_MS + 1,
  })
  expect(commands.at(-1)).toEqual({ command: 'snapshot' })
  expect(manager.inventory()).toMatchObject({
    windows: [{ identityTabId: 13, identityTargetId: 'discarded-target' }],
    batches: [{ tabs: [{ tabId: 13, targetId: 'discarded-target', discarded: true }] }],
  })
})

test('tab expiry closes batch tabs at 24 hours but defers the focused active tab', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-expiry-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    windows: [
      {
        logicalWindowId: 'root-window',
        owner: { kind: 'root' },
        chromeWindowId: 1,
        identityTabId: 2,
        identityTargetId: 'target',
        lastActivityAt: 0,
        phase: 'active',
      },
    ],
    batches: [
      {
        batchId: 'batch',
        owner: { kind: 'root' },
        rootTargetId: 'target',
        tabs: [{ logicalTabId: 'tab', tabId: 2, targetId: 'target', discarded: false }],
        lastLeaseAt: 0,
        createdAt: 0,
      },
    ],
  })
  let focused = true
  let closed = false
  const commands: unknown[] = []
  const manager = createDesktopBrowserManager({
    store,
    now: () => BROWSER_BATCH_TAB_TTL_MS,
    extension: {
      request: async command => {
        commands.push(command)
        if (command.command === 'snapshot')
          return {
            windows: [
              {
                windowId: 1,
                focused,
                state: 'normal',
                tabs: closed
                  ? []
                  : [
                      {
                        tabId: 2,
                        windowId: 1,
                        active: true,
                        discarded: false,
                        targetId: 'target',
                      },
                    ],
              },
            ],
          }
        if (command.command === 'closeTab') {
          closed = true
          return { tabId: 2 }
        }
        throw new Error('unexpected command')
      },
    },
  })
  await manager.tick()
  expect(commands).toEqual([{ command: 'snapshot' }])
  focused = false
  await manager.tick()
  expect(commands).toContainEqual({ command: 'closeTab', tabId: 2 })
  expect(manager.inventory().batches[0]?.tabs).toEqual([])
})

test('capacity durably evicts the deterministic idle LRU before creating owner eleven', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-lru-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    windows: Array.from({ length: 10 }, (_, index) => ({
      logicalWindowId: `window-${index}`,
      owner:
        index === 0 ? { kind: 'root' as const } : { kind: 'agent' as const, agentId: `a${index}` },
      chromeWindowId: index + 1,
      identityTabId: index + 101,
      identityTargetId: `t${index}`,
      lastActivityAt: index,
      phase: 'idle' as const,
    })),
    batches: [],
  })
  const commands: unknown[] = []
  const ids = ['new-window', 'new-tab']
  const manager = createDesktopBrowserManager({
    store,
    now: () => 100,
    createBatchId: () => 'new-batch',
    createLogicalId: () => ids.shift()!,
    extension: {
      request: async command => {
        commands.push(command)
        if (command.command === 'closeWindow') return { windowId: 1 }
        if (command.command === 'createWindow')
          return { windowId: 20, tabId: 21, targetId: 'new-target' }
        if (command.command === 'focusWindow') return { windowId: 20 }
        throw new Error('unexpected command')
      },
    },
  })
  await manager.startBatch({ kind: 'agent', agentId: 'next' })
  expect(commands.slice(0, 2)).toEqual([
    { command: 'closeWindow', windowId: 1 },
    { command: 'createWindow', url: 'about:blank' },
  ])
  expect(manager.inventory().windows).toHaveLength(10)
  expect(manager.inventory().windows.some(window => window.owner.kind === 'root')).toBe(false)
})

test('native activation replacement rebinds a discarded logical tab as live again', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-activate-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    windows: [
      {
        logicalWindowId: 'root-window',
        owner: { kind: 'root' },
        chromeWindowId: 1,
        identityTabId: 2,
        identityTargetId: 'discarded-target',
        lastActivityAt: 0,
        phase: 'idle',
      },
    ],
    batches: [
      {
        batchId: 'batch',
        owner: { kind: 'root' },
        rootTargetId: 'discarded-target',
        tabs: [{ logicalTabId: 'tab', tabId: 2, targetId: 'discarded-target', discarded: true }],
        lastLeaseAt: 0,
        createdAt: 0,
      },
    ],
  })
  const manager = createDesktopBrowserManager({
    store,
    now: () => 10,
    extension: {
      request: async () => ({
        windows: [
          {
            windowId: 1,
            focused: true,
            state: 'normal',
            tabs: [
              {
                tabId: 3,
                windowId: 1,
                active: true,
                discarded: false,
                targetId: 'reloaded-target',
              },
            ],
          },
        ],
      }),
    },
  })

  await manager.handleExtensionEvent({
    type: 'event',
    event: 'tabReplaced',
    removedTabId: 2,
    addedTabId: 3,
    at: 10,
  })
  expect(manager.inventory()).toMatchObject({
    windows: [{ identityTabId: 3, identityTargetId: 'reloaded-target' }],
    batches: [
      {
        rootTargetId: 'reloaded-target',
        tabs: [
          {
            logicalTabId: 'tab',
            tabId: 3,
            targetId: 'reloaded-target',
            discarded: false,
          },
        ],
      },
    ],
  })
})

test('agent removal commits ownership deletion even when native close fails', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-remove-owner-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    windows: [
      {
        logicalWindowId: 'agent-window',
        owner: { kind: 'agent', agentId: 'a' },
        chromeWindowId: 1,
        identityTabId: 2,
        identityTargetId: 'target',
        lastActivityAt: 0,
        phase: 'idle',
      },
    ],
    batches: [
      {
        batchId: 'batch',
        owner: { kind: 'agent', agentId: 'a' },
        rootTargetId: 'target',
        tabs: [{ logicalTabId: 'tab', tabId: 2, targetId: 'target', discarded: false }],
        lastLeaseAt: 0,
        createdAt: 0,
      },
    ],
  })
  const manager = createDesktopBrowserManager({
    store,
    now: () => 0,
    extension: {
      request: async () => {
        throw new Error('Chrome is stopped')
      },
    },
  })

  expect(await manager.removeOwner({ kind: 'agent', agentId: 'a' })).toBe(true)
  expect(manager.inventory()).toMatchObject({ windows: [], batches: [] })
  expect(await manager.removeOwner({ kind: 'agent', agentId: 'a' })).toBe(false)
})

test('a lease that opens during a lifecycle tick protects the owner before queued persistence', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-race-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    windows: [
      {
        logicalWindowId: 'w',
        owner: { kind: 'root' },
        chromeWindowId: 1,
        identityTabId: 2,
        identityTargetId: 'target',
        lastActivityAt: 0,
        phase: 'idle',
      },
    ],
    batches: [
      {
        batchId: 'batch',
        owner: { kind: 'root' },
        rootTargetId: 'target',
        tabs: [{ logicalTabId: 'tab', tabId: 2, targetId: 'target', discarded: false }],
        lastLeaseAt: 0,
        createdAt: 0,
      },
    ],
  })
  const snapshot = deferred<unknown>()
  const commands: unknown[] = []
  const manager = createDesktopBrowserManager({
    store,
    now: () => BROWSER_IDLE_DISCARD_GRACE_MS,
    extension: {
      request: async command => {
        commands.push(command)
        if (command.command === 'snapshot') return snapshot.promise
        throw new Error('discard must remain protected')
      },
    },
  })
  const tick = manager.tick()
  const lease = manager.openBatchLease('batch')
  snapshot.resolve({
    windows: [
      {
        windowId: 1,
        focused: false,
        state: 'normal',
        tabs: [{ tabId: 2, windowId: 1, active: false, discarded: false, targetId: 'target' }],
      },
    ],
  })
  await tick
  await lease
  expect(commands).toEqual([{ command: 'snapshot' }])
  expect(manager.inventory().batches[0]?.tabs[0]?.discarded).toBe(false)
})

test('a failed LRU native close restores the durable victim and does not admit owner eleven', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-lru-failure-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    windows: Array.from({ length: 10 }, (_, index) => ({
      logicalWindowId: `w${index}`,
      owner:
        index === 0 ? { kind: 'root' as const } : { kind: 'agent' as const, agentId: `a${index}` },
      chromeWindowId: index + 1,
      identityTabId: index + 101,
      identityTargetId: `t${index}`,
      lastActivityAt: index,
      phase: 'idle' as const,
    })),
    batches: [],
  })
  let creates = 0
  const manager = createDesktopBrowserManager({
    store,
    now: () => 100,
    extension: {
      request: async command => {
        if (command.command === 'createWindow') creates += 1
        throw new Error('native close failed')
      },
    },
  })
  await expect(manager.startBatch({ kind: 'agent', agentId: 'next' })).rejects.toMatchObject({
    code: 'browser_capacity',
  })
  expect(creates).toBe(0)
  expect(manager.inventory().windows).toHaveLength(10)
  expect(manager.inventory().windows[0]?.owner).toEqual({ kind: 'root' })
})

test('focus-existing restores the exact owner without creating and status aggregates its batches', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-manager-focus-'))
  const store = createBrowserWindowLedgerStore(stateDir)
  store.replace({
    version: 1,
    windows: [
      {
        logicalWindowId: 'w',
        owner: { kind: 'agent', agentId: 'a' },
        chromeWindowId: 1,
        identityTabId: 2,
        identityTargetId: 'target',
        lastActivityAt: 5,
        phase: 'idle',
      },
    ],
    batches: [
      {
        batchId: 'one',
        owner: { kind: 'agent', agentId: 'a' },
        rootTargetId: 'target',
        tabs: [{ logicalTabId: 't1', tabId: 2, targetId: 'target', discarded: false }],
        lastLeaseAt: 5,
        createdAt: 1,
      },
      {
        batchId: 'two',
        owner: { kind: 'agent', agentId: 'a' },
        tabs: [{ logicalTabId: 't2', discarded: true }],
        lastLeaseAt: 5,
        createdAt: 2,
      },
    ],
  })
  const commands: unknown[] = []
  const manager = createDesktopBrowserManager({
    store,
    now: () => 10,
    agentSlugForId: () => 'researcher',
    extension: {
      request: async command => {
        commands.push(command)
        if (command.command === 'snapshot')
          return {
            windows: [
              {
                windowId: 1,
                focused: false,
                state: 'minimized',
                tabs: [
                  { tabId: 2, windowId: 1, active: true, discarded: false, targetId: 'target' },
                ],
              },
            ],
          }
        if (command.command === 'focusWindow') return { windowId: 1 }
        throw new Error('focus must not create')
      },
    },
  })
  expect(await manager.focusOwner({ kind: 'agent', agentId: 'a' })).toBe(true)
  expect(commands).toEqual([{ command: 'snapshot' }, { command: 'focusWindow', windowId: 1 }])
  expect(manager.activities()).toEqual([
    {
      owner: { kind: 'agent', agentId: 'a' },
      agentSlug: 'researcher',
      phase: 'active',
      focused: true,
      liveBatchCount: 0,
      batchTabCount: 2,
      discardedBatchTabCount: 1,
      lastActiveAt: 10,
    },
  ])
  expect(await manager.focusOwner({ kind: 'agent', agentId: 'missing' })).toBe(false)
})
