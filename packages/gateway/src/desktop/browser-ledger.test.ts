import { afterEach, expect, test } from 'bun:test'
import { fstatSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultAtomicJsonOperations } from '../atomic-json'
import { createBrowserWindowLedgerStore, type BrowserWindowLedger } from './browser-ledger'

const scratchDirs: string[] = []
afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('browser ledger persists stable logical ownership in private VM state', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-ledger-'))
  scratchDirs.push(stateDir)
  const store = createBrowserWindowLedgerStore(stateDir)

  const expected: BrowserWindowLedger = {
    version: 1,
    browserGeneration: 'generation-1',
    windows: [
      {
        logicalWindowId: 'window-root',
        owner: { kind: 'root' },
        chromeWindowId: 7,
        identityTabId: 8,
        identityTargetId: 'target-root',
        lastActivityAt: 10,
        phase: 'idle',
      },
    ],
    batches: [],
  }
  store.replace(expected)

  const path = join(stateDir, 'desktop', 'browser-ledger.json')
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(expected)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect((await stat(join(stateDir, 'desktop'))).mode & 0o777).toBe(0o700)
  expect(store.current()).toEqual(expected)
  expect(createBrowserWindowLedgerStore(stateDir).current()).toEqual(expected)
})

test('missing or corrupt browser ledger starts empty without trusting partial state', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-ledger-corrupt-'))
  scratchDirs.push(stateDir)
  const expected = { version: 1, windows: [], batches: [] } satisfies BrowserWindowLedger
  expect(createBrowserWindowLedgerStore(stateDir).current()).toEqual(expected)

  await mkdir(join(stateDir, 'desktop'), { recursive: true })
  await Bun.write(join(stateDir, 'desktop', 'browser-ledger.json'), '{"version":1')
  expect(createBrowserWindowLedgerStore(stateDir).current()).toEqual(expected)

  await writeFile(
    join(stateDir, 'desktop', 'browser-ledger.json'),
    JSON.stringify({ version: 1, windows: [{ owner: { kind: 'root' } }], batches: [] }),
  )
  expect(createBrowserWindowLedgerStore(stateDir).current()).toEqual(expected)
})

test('an interrupted atomic commit leaves the prior browser ledger authoritative', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-ledger-atomic-'))
  scratchDirs.push(stateDir)
  const stable = createBrowserWindowLedgerStore(stateDir)
  stable.replace({
    version: 1,
    browserGeneration: 'stable',
    windows: [],
    batches: [],
  })
  const interrupted = createBrowserWindowLedgerStore(stateDir, {
    ...defaultAtomicJsonOperations,
    rename() {
      throw new Error('rename interrupted')
    },
  })

  expect(() =>
    interrupted.replace({
      version: 1,
      browserGeneration: 'partial',
      windows: [],
      batches: [],
    }),
  ).toThrow('rename interrupted')
  expect(createBrowserWindowLedgerStore(stateDir).current().browserGeneration).toBe('stable')
  expect((await readdir(join(stateDir, 'desktop'))).sort()).toEqual(['browser-ledger.json'])
})

test('a post-rename fsync error refreshes the cache from the committed ledger', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-ledger-fsync-'))
  scratchDirs.push(stateDir)
  createBrowserWindowLedgerStore(stateDir).replace({
    version: 1,
    browserGeneration: 'stable',
    windows: [],
    batches: [],
  })
  const store = createBrowserWindowLedgerStore(stateDir, {
    ...defaultAtomicJsonOperations,
    fsync(fileDescriptor) {
      defaultAtomicJsonOperations.fsync(fileDescriptor)
      if (fstatSync(fileDescriptor).isDirectory()) throw new Error('directory fsync interrupted')
    },
  })

  expect(() =>
    store.replace({
      version: 1,
      browserGeneration: 'committed',
      windows: [],
      batches: [],
    }),
  ).toThrow('directory fsync interrupted')
  expect(store.current().browserGeneration).toBe('committed')
  expect(createBrowserWindowLedgerStore(stateDir).current().browserGeneration).toBe('committed')
})
