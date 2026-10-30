import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CappedLogWriter } from './capped-log-writer'

test('overflow compaction preserves the newest tail and creates append headroom', () => {
  const root = mkdtempSync(join(tmpdir(), 'duet-capped-log-'))
  const logPath = join(root, 'gateway.log')
  const writer = new CappedLogWriter(logPath, 100)

  try {
    writer.write('a'.repeat(90))
    writer.write('b'.repeat(20))

    const compactedSize = statSync(logPath).size
    expect(compactedSize).toBeGreaterThanOrEqual(20)
    expect(compactedSize).toBeLessThanOrEqual(90)
    const retained = readFileSync(logPath, 'utf8')
    expect(retained).toBe(`${'a'.repeat(90)}${'b'.repeat(20)}`.slice(-compactedSize))

    writer.write('c'.repeat(10))
    expect(statSync(logPath).size).toBe(compactedSize + 10)
    expect(readFileSync(logPath, 'utf8')).toBe(`${retained}${'c'.repeat(10)}`)
  } finally {
    writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})
