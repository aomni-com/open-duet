import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the staging launcher needs no caller-pinned release revision', () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'duet-staging-launcher-'))
  temporaryDirectories.push(fakeBin)
  const fakeDocker = path.join(fakeBin, 'docker')
  writeFileSync(fakeDocker, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
  chmodSync(fakeDocker, 0o755)

  const result = Bun.spawnSync({
    cmd: ['bash', 'scripts/staging-live.sh', '--journey', 'specific-people-sessions'],
    cwd: path.resolve(import.meta.dir, '..'),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  expect(result.exitCode).toBe(0)
  const dockerArguments = result.stdout.toString().trim().split('\n')
  expect(dockerArguments).not.toContain('DUET_EXPECTED_RELEASE_REVISION')
})
