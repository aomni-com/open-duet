import { expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  PROBE_REPORTS_DIR,
  PROBE_SCREENSHOTS_DIR,
  PROBE_TRANSCRIPTS_DIR,
} from '../scripts/probe-artifacts.ts'

test('probe output directories are owned by the exe package', () => {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url))

  for (const directory of [PROBE_REPORTS_DIR, PROBE_SCREENSHOTS_DIR, PROBE_TRANSCRIPTS_DIR]) {
    const path = fileURLToPath(directory)
    expect(path.startsWith(packageRoot)).toBe(true)
    expect(path.split('/')).not.toContain('specs')
  }
})

test('probe scripts do not depend on archived specs', async () => {
  const scriptsDirectory = new URL('../scripts/', import.meta.url)
  const probeScripts = (await readdir(scriptsDirectory)).filter(
    filename => filename.startsWith('probe-') && filename.endsWith('.ts'),
  )
  const offenders: string[] = []

  for (const filename of probeScripts) {
    const source = await readFile(new URL(filename, scriptsDirectory), 'utf8')
    if (source.includes('specs/')) offenders.push(filename)
  }

  expect(offenders).toEqual([])
})
