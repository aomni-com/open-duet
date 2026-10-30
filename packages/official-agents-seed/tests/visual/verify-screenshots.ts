import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { OFFICIAL_APP_VISUAL_SCENARIOS } from './scenarios'

export const OFFICIAL_APP_SCREENSHOT_ROOT = path.join(import.meta.dir, '__screenshots__')
export const OFFICIAL_APP_VISUAL_PROJECTS = ['desktop', 'mobile'] as const

export function expectedOfficialAppScreenshots(): string[] {
  return OFFICIAL_APP_VISUAL_SCENARIOS.flatMap(scene =>
    OFFICIAL_APP_VISUAL_PROJECTS.map(project =>
      path.join(project, 'official-apps.spec.ts', `${scene.id}.png`),
    ),
  )
}

export async function verifyOfficialAppScreenshots(
  root = OFFICIAL_APP_SCREENSHOT_ROOT,
  expected = expectedOfficialAppScreenshots(),
): Promise<{ missing: string[]; stale: string[] }> {
  const actual = await collectPngs(root)
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  return {
    missing: expected.filter(file => !actualSet.has(file)),
    stale: actual.filter(file => !expectedSet.has(file)),
  }
}

export async function removeStaleOfficialAppScreenshots(
  root: string,
  stale: readonly string[],
  options: { filtered?: boolean } = {},
): Promise<string[]> {
  if (options.filtered) return []
  const resolvedRoot = path.resolve(root)
  for (const relativePath of stale) {
    const resolved = path.resolve(root, relativePath)
    if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`Refusing to delete outside official-app screenshot root: ${resolved}`)
    }
  }
  await Promise.all(
    stale.map(relativePath => rm(path.resolve(root, relativePath), { force: true })),
  )
  return [...stale]
}

async function collectPngs(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = (
    await Promise.all(
      entries.map(entry => {
        const target = path.join(directory, entry.name)
        return entry.isDirectory()
          ? collectPngs(root, target)
          : Promise.resolve(entry.name.endsWith('.png') ? [path.relative(root, target)] : [])
      }),
    )
  ).flat()
  return files.sort()
}

if (import.meta.main) {
  const result = await verifyOfficialAppScreenshots()
  if (result.missing.length > 0 || result.stale.length > 0) {
    for (const file of result.missing) console.error(`missing screenshot: ${file}`)
    for (const file of result.stale) console.error(`stale screenshot: ${file}`)
    process.exit(1)
  }
  console.log(`Verified ${expectedOfficialAppScreenshots().length} official-app screenshots.`)
}
