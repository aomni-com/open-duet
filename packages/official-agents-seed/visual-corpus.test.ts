import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { renderOfficialAppCoverageLedger } from './tests/visual/generate-coverage-ledger'
import { isFilteredOfficialAppRun } from './tests/visual/run-visual'
import { OFFICIAL_APP_VISUAL_SCENARIOS } from './tests/visual/scenarios'
import {
  expectedOfficialAppScreenshots,
  removeStaleOfficialAppScreenshots,
  verifyOfficialAppScreenshots,
} from './tests/visual/verify-screenshots'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => rm(directory, { recursive: true, force: true })),
  )
})

describe('official app visual corpus', () => {
  test('includes both supported viewport artifacts for every registered scene', () => {
    expect(expectedOfficialAppScreenshots().map(file => file.replaceAll(path.sep, '/'))).toEqual(
      OFFICIAL_APP_VISUAL_SCENARIOS.flatMap(({ id }) => [
        `desktop/official-apps.spec.ts/${id}.png`,
        `mobile/official-apps.spec.ts/${id}.png`,
      ]),
    )
  })

  test('keeps the coverage ledger generated from manifest-owned apps', async () => {
    expect(
      await Bun.file(
        new URL('./tests/visual/coverage-ledger.generated.json', import.meta.url),
      ).text(),
    ).toBe(renderOfficialAppCoverageLedger())
  })

  test('reports missing and stale PNGs by semantic path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'official-app-shots-'))
    temporaryDirectories.push(root)
    const expected = [
      'desktop/official-apps.spec.ts/fixture.png',
      'mobile/official-apps.spec.ts/fixture.png',
    ]
    await writePng(root, expected[0]!)
    await writePng(root, 'desktop/official-apps.spec.ts/stale.png')

    expect(await verifyOfficialAppScreenshots(root, expected)).toEqual({
      missing: [expected[1]!],
      stale: ['desktop/official-apps.spec.ts/stale.png'],
    })
  })

  test('full cleanup is screenshot-root scoped', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'official-app-cleanup-'))
    temporaryDirectories.push(parent)
    const root = path.join(parent, '__screenshots__')
    const outside = path.join(parent, 'keep.png')
    await writePng(root, 'stale.png')
    await writeFile(outside, 'outside')

    await expect(removeStaleOfficialAppScreenshots(root, ['../keep.png'])).rejects.toThrow(
      'outside official-app screenshot root',
    )
    expect(await Bun.file(outside).text()).toBe('outside')
  })

  test('filtered cleanup never prunes screenshots from other scenes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'official-app-filtered-'))
    temporaryDirectories.push(root)
    await writePng(root, 'desktop/official-apps.spec.ts/current.png')
    await writePng(root, 'desktop/official-apps.spec.ts/unrelated.png')

    const removed = await removeStaleOfficialAppScreenshots(
      root,
      ['desktop/official-apps.spec.ts/unrelated.png'],
      { filtered: true },
    )
    expect(removed).toEqual([])
    expect(
      await Bun.file(path.join(root, 'desktop/official-apps.spec.ts/unrelated.png')).exists(),
    ).toBe(true)
  })

  test('distinguishes owner-wide approval from focused scene approval', () => {
    expect(isFilteredOfficialAppRun(['-g', 'official-apps/'])).toBe(false)
    expect(
      isFilteredOfficialAppRun(['-g', '(official-apps)/(agent-app-connect-repos-completed)']),
    ).toBe(true)
  })
})

async function writePng(root: string, relativePath: string): Promise<void> {
  const file = path.join(root, relativePath)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, 'png')
}
