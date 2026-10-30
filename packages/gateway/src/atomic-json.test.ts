import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultAtomicJsonOperations } from './atomic-json'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'duet-atomic-json-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

// Bun 1.3.14 on Linux follows a `writeFileSync(fd, string)` of 2 MiB or more to
// an O_APPEND descriptor with an equal-length run of NUL bytes, leaving the
// file twice the size it was given and the records around the zeros
// unreadable. It tore a live workspace's relay journal in half (2026-08-17).
// macOS is unaffected, so this test cannot go red on a developer machine — it
// guards the Linux hosts, where every gateway actually runs.
test('an append writes exactly the bytes it was given, at any size', async () => {
  const path = join(directory, 'journal.ndjson')
  const line = `${'x'.repeat(4 * 1024 * 1024)}\n`

  for (const payload of [line, 'small\n']) {
    const descriptor = defaultAtomicJsonOperations.open(path, 'a', 0o600)
    try {
      defaultAtomicJsonOperations.write(descriptor, payload)
      defaultAtomicJsonOperations.fsync(descriptor)
    } finally {
      defaultAtomicJsonOperations.close(descriptor)
    }
  }

  expect((await stat(path)).size).toBe(Buffer.byteLength(line) + Buffer.byteLength('small\n'))
  expect(await readFile(path)).not.toContain(0)
})
