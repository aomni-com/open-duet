import { expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectSeedArchive } from './bundle'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

test('inspect prints the canonical tar entry list and archive hash', async () => {
  const process = Bun.spawn(['bun', 'run', 'inspect'], {
    cwd: packageDir,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [stdout, exitCode, archive] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
    inspectSeedArchive(),
  ])

  expect(exitCode).toBe(0)
  expect(stdout.trim().split('\n')).toEqual([...archive.entries, `sha256 ${archive.sha256}`])
})
