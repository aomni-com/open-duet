import { expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readlink, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeBootState } from './boot-health'
import { createDesiredStateStore } from './desired-state'
import { RUNTIME_RELEASE_LOCK_FILE, inspectRelease } from './runtime-release'
import { createRuntimeUpdater } from './runtime-update'
import { runtimeFixture } from './testing/runtime-release-fixture'

function descriptor(fixture: ReturnType<typeof runtimeFixture>) {
  return {
    ...fixture.manifest,
    artifacts: fixture.manifest.artifacts.map(artifact => ({
      ...artifact,
      href: `https://api.test/v1/vm/runtime-release/artifacts/${artifact.name}`,
    })),
  }
}

test('a newer desired runtime cancels staged activation and the next check installs it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-update-'))
  try {
    const old = runtimeFixture('old'),
      stale = runtimeFixture('stale'),
      next = runtimeFixture('next')
    const releasesDir = join(root, 'releases'),
      currentReleaseLink = join(root, 'current')
    const oldDir = join(releasesDir, old.manifest.version)
    await old.write(oldDir)
    await symlink(oldDir, currentReleaseLink)
    const desiredState = createDesiredStateStore(join(root, 'state'))
    await desiredState.accept({
      pollAfterMs: 1000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: false },
      runtimeRelease: descriptor(stale),
    })
    let superseded = false
    let serving = stale
    const exits: number[] = []
    const updater = createRuntimeUpdater({
      apiUrl: 'https://api.test',
      stateDir: join(root, 'state'),
      runningVersion: old.manifest.version,
      desiredState,
      releasesDir,
      currentReleaseLink,
      getVmToken: async () => 'token',
      hasActiveRunners: () => false,
      blockStartsIfIdle: () => () => {},
      exit: code => {
        exits.push(code)
      },
      fetch: async url => {
        if (!superseded) {
          superseded = true
          await desiredState.accept({
            pollAfterMs: 1000,
            anchors: [],
            mirrorMachineIds: [],
            updates: { paused: false },
            runtimeRelease: descriptor(next),
          })
        }
        return serving.fetch(url)
      },
    })
    expect(await updater.check()).toEqual({ status: 'not_needed' })
    expect(await readlink(currentReleaseLink)).toBe(oldDir)
    expect(exits).toEqual([])
    expect(await inspectRelease(join(releasesDir, stale.manifest.version))).toEqual({
      ok: true,
      version: stale.manifest.version,
    })
    serving = next
    expect(await updater.check()).toEqual({ status: 'applied', version: next.manifest.version })
    expect(await readlink(currentReleaseLink)).toBe(join(releasesDir, next.manifest.version))
    expect(exits).toEqual([0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a quarantined announced runtime stays stopped while a new content version can update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-quarantine-'))
  try {
    const good = runtimeFixture('good'),
      failed = runtimeFixture('failed'),
      fixed = runtimeFixture('fixed')
    const releasesDir = join(root, 'releases'),
      currentReleaseLink = join(root, 'current'),
      stateDir = join(root, 'state')
    const goodDir = join(releasesDir, good.manifest.version)
    await good.write(goodDir)
    await symlink(goodDir, currentReleaseLink)
    await writeBootState(stateDir, {
      attemptedVersion: good.manifest.version,
      consecutiveFailures: 0,
      quarantinedVersion: failed.manifest.version,
    })
    const desiredState = createDesiredStateStore(stateDir)
    await desiredState.accept({
      pollAfterMs: 1000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: false },
      runtimeRelease: descriptor(failed),
    })
    const exits: number[] = [],
      requests: string[] = []
    let serving = failed
    const updater = createRuntimeUpdater({
      apiUrl: 'https://api.test',
      stateDir: join(root, 'state'),
      desiredState,
      runningVersion: good.manifest.version,
      releasesDir,
      currentReleaseLink,
      getVmToken: async () => 'token',
      hasActiveRunners: () => false,
      blockStartsIfIdle: () => () => {},
      exit: code => {
        exits.push(code)
      },
      fetch: async url => {
        requests.push(String(url))
        return serving.fetch(url)
      },
    })
    const result = await updater.check()
    expect(result.status).toBe('failed')
    expect(requests).toEqual([])
    expect(exits).toEqual([])
    expect(await readlink(currentReleaseLink)).toBe(goodDir)
    serving = fixed
    await desiredState.accept({
      pollAfterMs: 1000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: false },
      runtimeRelease: descriptor(fixed),
    })
    expect(await updater.check()).toEqual({ status: 'applied', version: fixed.manifest.version })
    expect(await readlink(currentReleaseLink)).toBe(join(releasesDir, fixed.manifest.version))
    expect(exits).toEqual([0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('training work defers runtime activation past the advisory deadline and idle resumes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-active-work-'))
  try {
    const old = runtimeFixture('old'),
      next = runtimeFixture('next')
    const releasesDir = join(root, 'releases'),
      currentReleaseLink = join(root, 'current'),
      stateDir = join(root, 'state')
    const oldDir = join(releasesDir, old.manifest.version)
    await old.write(oldDir)
    await symlink(oldDir, currentReleaseLink)
    const desiredState = createDesiredStateStore(stateDir)
    await desiredState.accept({
      pollAfterMs: 1000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: false },
      runtimeRelease: descriptor(next),
    })
    let now = 100,
      trainingBusy = true
    const exits: number[] = [],
      requests: string[] = []
    const updater = createRuntimeUpdater({
      apiUrl: 'https://api.test',
      stateDir,
      desiredState,
      runningVersion: old.manifest.version,
      releasesDir,
      currentReleaseLink,
      getVmToken: async () => 'token',
      hasActiveRunners: () => trainingBusy,
      blockStartsIfIdle: () => () => {},
      maxDeferMs: 10,
      now: () => now,
      exit: code => {
        exits.push(code)
      },
      fetch: async url => {
        requests.push(String(url))
        return next.fetch(url)
      },
    })
    expect(await updater.check()).toEqual({
      status: 'deferred',
      version: next.manifest.version,
      deadlineMs: 110,
    })
    now = 111
    expect(await updater.check()).toEqual({
      status: 'deferred',
      version: next.manifest.version,
      deadlineMs: 110,
    })
    expect(requests).toEqual([])
    expect(exits).toEqual([])
    expect(await readlink(currentReleaseLink)).toBe(oldDir)
    trainingBusy = false
    expect(await updater.check()).toEqual({ status: 'applied', version: next.manifest.version })
    expect(await readlink(currentReleaseLink)).toBe(join(releasesDir, next.manifest.version))
    expect(exits).toEqual([0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('work admitted during download prevents activation until the same updater finds idle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-admission-'))
  try {
    const old = runtimeFixture('old'),
      next = runtimeFixture('next')
    const releasesDir = join(root, 'releases'),
      currentReleaseLink = join(root, 'current'),
      stateDir = join(root, 'state')
    const oldDir = join(releasesDir, old.manifest.version)
    await old.write(oldDir)
    await symlink(oldDir, currentReleaseLink)
    const desiredState = createDesiredStateStore(stateDir)
    await desiredState.accept({
      pollAfterMs: 1000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: false },
      runtimeRelease: descriptor(next),
    })
    let busy = false,
      admitted = false
    const exits: number[] = []
    const updater = createRuntimeUpdater({
      apiUrl: 'https://api.test',
      stateDir,
      desiredState,
      runningVersion: old.manifest.version,
      releasesDir,
      currentReleaseLink,
      getVmToken: async () => 'token',
      hasActiveRunners: () => busy,
      blockStartsIfIdle: () => (busy ? null : () => {}),
      exit: code => {
        exits.push(code)
      },
      fetch: async url => {
        if (!admitted) {
          admitted = true
          busy = true
        }
        return next.fetch(url)
      },
    })
    expect(await updater.check()).toEqual({ status: 'not_needed' })
    expect(await readlink(currentReleaseLink)).toBe(oldDir)
    expect(exits).toEqual([])
    expect(await inspectRelease(join(releasesDir, next.manifest.version))).toEqual({
      ok: true,
      version: next.manifest.version,
    })
    busy = false
    expect(await updater.check()).toEqual({ status: 'applied', version: next.manifest.version })
    expect(await readlink(currentReleaseLink)).toBe(join(releasesDir, next.manifest.version))
    expect(exits).toEqual([0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('post-activation lock cleanup failure reopens admission without restarting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-lock-cleanup-'))
  try {
    const old = runtimeFixture('old'),
      next = runtimeFixture('next')
    const releasesDir = join(root, 'releases'),
      currentReleaseLink = join(root, 'current'),
      stateDir = join(root, 'state')
    const oldDir = join(releasesDir, old.manifest.version)
    await old.write(oldDir)
    await symlink(oldDir, currentReleaseLink)
    const desiredState = createDesiredStateStore(stateDir)
    await desiredState.accept({
      pollAfterMs: 1000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: false },
      runtimeRelease: descriptor(next),
    })
    let admissionClosed = false
    const exits: number[] = []
    const updater = createRuntimeUpdater({
      apiUrl: 'https://api.test',
      stateDir,
      desiredState,
      runningVersion: old.manifest.version,
      releasesDir,
      currentReleaseLink,
      getVmToken: async () => 'token',
      hasActiveRunners: () => false,
      blockStartsIfIdle: () => {
        admissionClosed = true
        // A scratch-only filesystem fault makes lock release fail after activation.
        const lockPath = join(releasesDir, RUNTIME_RELEASE_LOCK_FILE)
        rmSync(lockPath, { recursive: true })
        writeFileSync(lockPath, 'unexpected file at the lock directory')
        return () => {
          admissionClosed = false
        }
      },
      exit: code => {
        exits.push(code)
      },
      fetch: next.fetch,
    })
    expect((await updater.check()).status).toBe('failed')
    expect(await readlink(currentReleaseLink)).toBe(join(releasesDir, next.manifest.version))
    expect(admissionClosed).toBe(false)
    expect(exits).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
