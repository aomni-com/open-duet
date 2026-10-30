import { describe, expect, test } from 'bun:test'

import { shellQuote, sshExitCode } from './internal.ts'

describe('shellQuote', () => {
  test('round-trips one literal argument through a POSIX shell', () => {
    for (const value of [
      'abcXYZ_012',
      'user@example.com',
      '/tmp/duet-file:1.2-3',
      'KEY=value,other%2B',
      'hello world',
      '',
      "it's ready",
      '界\n$HOME `false` $(false); *',
    ]) {
      const run = Bun.spawnSync(['sh', '-c', `printf '%s' ${shellQuote(value)}`], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(run.exitCode).toBe(0)
      expect(run.stdout.toString()).toBe(value)
    }
  })
})

describe('sshExitCode', () => {
  test('surfaces non-zero ssh exit codes', () => {
    expect(sshExitCode({ code: 255 })).toBe(255)
    expect(sshExitCode({ code: 2 })).toBe(2)
  })

  test('maps errors without numeric exit codes to 1', () => {
    expect(sshExitCode(new Error('spawn failed'))).toBe(1)
    expect(sshExitCode({ code: 'SIGTERM' })).toBe(1)
  })

  test('maps success to 0', () => {
    expect(sshExitCode(null)).toBe(0)
    expect(sshExitCode(undefined)).toBe(0)
  })
})
