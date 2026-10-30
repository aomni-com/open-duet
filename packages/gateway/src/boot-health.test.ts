import { expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BOOT_STATE_FILE, createBootHealth, type BootState } from './boot-health'

test('sync successes before minimum uptime do not mark a crash-looping release healthy', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'runtime-boot-health-'))
  let now = 1_000
  try {
    await writeFile(
      join(stateDir, BOOT_STATE_FILE),
      `${JSON.stringify({ attemptedVersion: 'release-a', consecutiveFailures: 2 })}\n`,
    )
    const health = createBootHealth({ stateDir, now: () => now })

    for (let syncOk = 0; syncOk < 10; syncOk += 1) await health.recordSyncOk()

    const state = JSON.parse(await readFile(join(stateDir, BOOT_STATE_FILE), 'utf8')) as BootState
    expect(state).toEqual({ attemptedVersion: 'release-a', consecutiveFailures: 2 })
    expect(health.markerWritten()).toBe(false)
    expect(health.certified()).toBe(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('both thresholds mark only the running release healthy exactly once', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'runtime-boot-health-'))
  let now = 5_000
  try {
    await writeFile(
      join(stateDir, BOOT_STATE_FILE),
      `${JSON.stringify({ attemptedVersion: 'release-b', consecutiveFailures: 1 })}\n`,
    )
    const health = createBootHealth({
      stateDir,
      now: () => now,
      minUptimeMs: 100,
      minSyncOks: 3,
    })

    await health.recordSyncOk()
    await health.recordSyncOk()
    now += 100
    expect(health.markerWritten()).toBe(false)

    await health.recordSyncOk()
    expect(health.markerWritten()).toBe(true)
    expect(health.certified()).toBe(true)
    expect(await readState(stateDir)).toEqual({
      attemptedVersion: 'release-b',
      consecutiveFailures: 0,
      healthyVersion: 'release-b',
      healthyAt: 5_100,
    })

    now += 1_000
    await health.recordSyncOk()
    expect(await readState(stateDir)).toEqual({
      attemptedVersion: 'release-b',
      consecutiveFailures: 0,
      healthyVersion: 'release-b',
      healthyAt: 5_100,
    })
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('an existing marker for the running release is never rewritten', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'runtime-boot-health-'))
  let now = 1_000
  const initial = {
    attemptedVersion: 'release-c',
    consecutiveFailures: 0,
    healthyVersion: 'release-c',
    healthyAt: 100,
  }
  try {
    await writeFile(join(stateDir, BOOT_STATE_FILE), `${JSON.stringify(initial)}\n`)
    const health = createBootHealth({ stateDir, now: () => now, minUptimeMs: 10, minSyncOks: 1 })
    now += 10

    await health.recordSyncOk()

    expect(await readState(stateDir)).toEqual(initial)
    expect(health.markerWritten()).toBe(false)
    expect(health.certified()).toBe(true)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a failed health persistence rejects its caller without poisoning later attempts', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'runtime-boot-health-retry-'))
  try {
    await writeFile(
      join(stateDir, BOOT_STATE_FILE),
      `${JSON.stringify({ attemptedVersion: 'release-retry', consecutiveFailures: 2 })}\n`,
    )
    const health = createBootHealth({
      stateDir,
      now: () => 1_000,
      minUptimeMs: 0,
      minSyncOks: 1,
    })
    await chmod(stateDir, 0o500)

    await expect(health.recordSyncOk()).rejects.toThrow()
    await chmod(stateDir, 0o700)
    await health.recordSyncOk()

    expect(await readState(stateDir)).toMatchObject({
      healthyVersion: 'release-retry',
      consecutiveFailures: 0,
    })
  } finally {
    await chmod(stateDir, 0o700).catch(() => undefined)
    await rm(stateDir, { recursive: true, force: true })
  }
})

async function readState(stateDir: string): Promise<BootState> {
  return JSON.parse(await readFile(join(stateDir, BOOT_STATE_FILE), 'utf8')) as BootState
}
