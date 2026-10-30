import { expect, test } from 'bun:test'

import { DUET_CLI_TIMEOUT_MS, spawnDuetCli } from './duet-cli'

test('the default cap is short enough that a person waits, not a request', () => {
  expect(DUET_CLI_TIMEOUT_MS).toBeLessThanOrEqual(15_000)
})

test('a command that outlives its cap is killed and reported as timed out', async () => {
  const started = Date.now()
  const result = await spawnDuetCli(['-c', 'sleep 30'], {
    binary: 'bash',
    timeoutMs: 250,
  })

  expect(result.timedOut).toBe(true)
  // The point of the cap is that the caller gets its answer back near the cap,
  // not near the command's own lifetime.
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('a command that finishes in time reports its own result, untouched', async () => {
  const result = await spawnDuetCli(['-c', 'printf hello; printf oops >&2; exit 3'], {
    binary: 'bash',
    timeoutMs: 10_000,
  })

  expect(result).toEqual({ exitCode: 3, stdout: 'hello', stderr: 'oops', timedOut: false })
})

test('a caller can cap stdout before the child fills process memory', async () => {
  const result = await spawnDuetCli(['-c', 'printf abcdefghijklmnopqrstuvwxyz'], {
    binary: 'bash',
    timeoutMs: 10_000,
    maxStdoutBytes: 10,
  })

  expect(result.outputTooLarge).toBe(true)
  expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(10)
})

test('the same process boundary can cap stderr', async () => {
  const result = await spawnDuetCli(['-c', 'printf abcdefghijklmnopqrstuvwxyz >&2'], {
    binary: 'bash',
    timeoutMs: 10_000,
    maxStderrBytes: 10,
  })

  expect(result.outputTooLarge).toBe(true)
  expect(new TextEncoder().encode(result.stderr).byteLength).toBeLessThanOrEqual(10)
})

test('a byte ceiling never expands a split UTF-8 code point', async () => {
  const result = await spawnDuetCli(['-c', "printf '\\303\\251\\303\\251'"], {
    binary: 'bash',
    timeoutMs: 10_000,
    maxStdoutBytes: 3,
  })

  expect(result.outputTooLarge).toBe(true)
  expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(3)
})
