import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BROWSER_METRICS_DIR_REL,
  BROWSER_METRICS_KEEP,
  BROWSER_METRICS_MIN_AGE_MS,
  reapBrowserMetrics,
  selectReapableMetricsFiles,
} from './browser-metrics'

const scratchDirs: string[] = []
afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const at = (name: string, modifiedAt: number) => ({ name, modifiedAt })

test('keeps the newest handful and reaps the rest of the leaked launch files', () => {
  const now = 1_000_000_000
  const files = Array.from({ length: BROWSER_METRICS_KEEP + 2 }, (_, index) =>
    at(`BrowserMetrics-${index}.pma`, now - BROWSER_METRICS_MIN_AGE_MS - index * 1_000),
  )

  const reaped = selectReapableMetricsFiles(files, { now })

  expect(reaped).toEqual([
    `BrowserMetrics-${BROWSER_METRICS_KEEP}.pma`,
    `BrowserMetrics-${BROWSER_METRICS_KEEP + 1}.pma`,
  ])
  // The survivors are the newest ones, by modification time.
  const survivors = files.filter(file => !reaped.includes(file.name))
  expect(survivors.map(file => file.name)).toEqual(
    files.slice(0, BROWSER_METRICS_KEEP).map(file => file.name),
  )
})

test('never reaps a file young enough to belong to a Chrome starting right now', () => {
  const now = 1_000_000_000
  const files = [
    at('BrowserMetrics-live.pma', now - BROWSER_METRICS_MIN_AGE_MS / 2),
    at('BrowserMetrics-recent.pma', now - BROWSER_METRICS_MIN_AGE_MS + 1),
    ...Array.from({ length: BROWSER_METRICS_KEEP }, (_, index) =>
      at(`BrowserMetrics-old-${index}.pma`, now - BROWSER_METRICS_MIN_AGE_MS - index * 1_000),
    ),
  ]

  const reaped = selectReapableMetricsFiles(files, { now })

  expect(reaped).not.toContain('BrowserMetrics-live.pma')
  expect(reaped).not.toContain('BrowserMetrics-recent.pma')
  expect(reaped).toEqual([
    `BrowserMetrics-old-${BROWSER_METRICS_KEEP - 2}.pma`,
    `BrowserMetrics-old-${BROWSER_METRICS_KEEP - 1}.pma`,
  ])
})

test('frees a leaked profile on disk and leaves the rest of it untouched', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'duet-chrome-profile-'))
  scratchDirs.push(profileDir)
  const metricsDir = join(profileDir, BROWSER_METRICS_DIR_REL)
  await mkdir(metricsDir)
  const now = Date.now()
  const stale = new Date(now - BROWSER_METRICS_MIN_AGE_MS - 60_000)
  for (let index = 0; index < BROWSER_METRICS_KEEP + 1; index += 1) {
    const path = join(metricsDir, `BrowserMetrics-${index}.pma`)
    await writeFile(path, 'x')
    const modified = new Date(stale.getTime() - index * 1000)
    await utimes(path, modified, modified)
  }
  // Things the reaper has no business touching.
  await writeFile(join(metricsDir, 'not-metrics.txt'), 'x')
  await writeFile(join(profileDir, 'Local State'), 'x')

  const result = await reapBrowserMetrics({ profileDir, now: () => now })

  expect(result).toEqual({ deleted: 1, failed: 0 })
  const left = (await readdir(metricsDir)).sort()
  expect(left.filter(name => name.endsWith('.pma'))).toEqual(
    Array.from(
      { length: BROWSER_METRICS_KEEP },
      (_, index) => `BrowserMetrics-${index}.pma`,
    ).sort(),
  )
  expect(left).toContain('not-metrics.txt')
  expect(await readdir(profileDir)).toContain('Local State')
})

test('a profile with no metrics directory is not an error', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'duet-chrome-empty-'))
  scratchDirs.push(profileDir)

  expect(await reapBrowserMetrics({ profileDir, now: () => Date.now() })).toEqual({
    deleted: 0,
    failed: 0,
  })
})

test('leaves a healthy profile completely alone', () => {
  const now = 1_000_000_000
  const files = Array.from({ length: BROWSER_METRICS_KEEP }, (_, index) =>
    at(`BrowserMetrics-${index}.pma`, now - BROWSER_METRICS_MIN_AGE_MS - index * 1_000),
  )

  expect(selectReapableMetricsFiles(files, { now })).toEqual([])
  expect(selectReapableMetricsFiles([], { now })).toEqual([])
})
