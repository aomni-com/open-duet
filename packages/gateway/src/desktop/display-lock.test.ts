import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearStaleDisplayLock } from './display-lock'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('removes a lock whose owning process is gone, with the socket beside it', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'duet-display-'))
  directories.push(runDir)
  // A pid this large is not in use; if it somehow were, `kill -0` would say so
  // and the test would fail loudly rather than pass for the wrong reason.
  await writeFile(join(runDir, '.X1-lock'), '       4194303\n')
  await writeFile(join(runDir, 'X1'), '')

  expect(await clearStaleDisplayLock({ display: 1, runDir, socketDir: runDir })).toBe(true)
  expect(await readdir(runDir)).toEqual([])
})

test('leaves a lock alone while its process is alive', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'duet-display-live-'))
  directories.push(runDir)
  await writeFile(join(runDir, '.X1-lock'), `${process.pid}\n`)

  expect(await clearStaleDisplayLock({ display: 1, runDir, socketDir: runDir })).toBe(false)
  expect(await readdir(runDir)).toEqual(['.X1-lock'])
})

test('an unreadable or empty lock is debris, and no lock at all is a no-op', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'duet-display-empty-'))
  directories.push(runDir)
  expect(await clearStaleDisplayLock({ display: 1, runDir, socketDir: runDir })).toBe(false)

  await writeFile(join(runDir, '.X1-lock'), '')
  expect(await clearStaleDisplayLock({ display: 1, runDir, socketDir: runDir })).toBe(true)
  expect(await readdir(runDir)).toEqual([])
})
