import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RUNTIME_RELEASE_ARTIFACT_NAMES,
  type RuntimeReleaseDescriptor,
  type VmSyncResponse,
} from '@repo/contract'

import { defaultAtomicJsonOperations } from './atomic-json'
import { createDesiredStateStore } from './desired-state'

test('runtime rescue preserves pause, quiesce and workspace identity', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'desired-'))
  try {
    const store = createDesiredStateStore(stateDir)
    const base = await store.accept({
      ...syncDirective(true, '0.0.0+g1'),
      quiesce: true,
      workspaceSlug: 'acme',
    })
    const rolled = await store.acceptRuntimeRelease(release('0.0.0+g2'))
    expect(rolled.runtimeRelease?.version).toBe('0.0.0+g2')
    expect(rolled.paused).toBe(true)
    expect(rolled.quiesced).toBe(true)
    expect(rolled.workspaceSlug).toBe('acme')
    expect(Number(rolled.generation)).toBe(Number(base.generation) + 1)
    expect((await store.acceptRuntimeRelease(release('0.0.0+g2'))).generation).toBe(
      rolled.generation,
    )
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('activation follows the whole current runtime and its pause policy', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'desired-'))
  try {
    const store = createDesiredStateStore(stateDir)
    await store.accept(syncDirective(false, '1.2.3'))
    await store.accept({ ...syncDirective(false, '1.2.3'), workspaceSlug: 'moved' })
    expect(await mayActivate(store, '1.2.3')).toBe(true)
    await store.accept(syncDirective(false, '1.2.4'))
    expect(await mayActivate(store, '1.2.3')).toBe(false)
    expect(await mayActivate(store, '1.2.4')).toBe(true)
    await store.accept(syncDirective(true, '1.2.4'))
    expect(await mayActivate(store, '1.2.4')).toBe(false)
    await store.accept({
      pollAfterMs: 5000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: false },
    })
    expect(await mayActivate(store, '1.2.4')).toBe(false)
    expect(store.current().runtimeRelease).toBeUndefined()
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('legacy and malformed persisted release desires never become actionable', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'desired-'))
  try {
    const legacy = {
      generation: '4',
      paused: false,
      quiesced: true,
      workspaceSlug: 'acme',
      gatewayRelease: { version: '1.2.3' },
      agentVersion: '2.3.4',
      duetfsVersion: '3.4.5',
    }
    for (const value of [legacy, { ...legacy, runtimeRelease: { version: '1.2.3' } }]) {
      await writeFile(join(stateDir, 'desired-state.json'), JSON.stringify(value))
      const store = createDesiredStateStore(stateDir)
      expect(store.current()).toEqual({
        generation: '4',
        paused: false,
        quiesced: true,
        workspaceSlug: 'acme',
      })
      expect(await mayActivate(store, '1.2.3')).toBe(false)
      await store.accept({
        pollAfterMs: 5000,
        anchors: [],
        mirrorMachineIds: [],
        updates: { paused: false },
        gatewayRelease: legacy.gatewayRelease,
      } as unknown as VmSyncResponse)
      expect(store.current().runtimeRelease).toBeUndefined()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('workspace quiesce survives gateway restart until an active sync clears it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-desired-state-'))
  try {
    const firstProcess = createDesiredStateStore(stateDir)
    await firstProcess.accept({ ...syncDirective(false, '1.2.3'), quiesce: true })

    const restarted = createDesiredStateStore(stateDir)
    expect(restarted.current().quiesced).toBe(true)

    await restarted.accept({ ...syncDirective(false, '1.2.3'), quiesce: false })
    expect(restarted.current().quiesced).toBe(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('workspace slug survives an accepted sync and gateway restart', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-desired-state-'))
  try {
    const firstProcess = createDesiredStateStore(stateDir)
    await firstProcess.accept({ ...syncDirective(false, '1.2.3'), workspaceSlug: 'acme' })
    await firstProcess.accept(syncDirective(false, '1.2.4'))

    expect(createDesiredStateStore(stateDir).current().workspaceSlug).toBe('acme')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('an unchanged sync that carries a workspace slug and a release keeps its generation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-desired-state-'))
  try {
    const store = createDesiredStateStore(stateDir)
    // Production payloads always carry both. The generation is the install
    // rail's activation key: if an identical poll moves it, every install
    // that outlives one poll interval is thrown away.
    const payload = { ...syncDirective(false, '1.2.3'), workspaceSlug: 'acme' }
    const first = await store.accept(payload)
    const again = await store.accept(payload)

    expect(again.generation).toBe(first.generation)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a failed desired-state commit cannot clear a durable quiesce latch', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-desired-state-'))
  try {
    await createDesiredStateStore(stateDir).accept({
      ...syncDirective(false, '1.2.3'),
      quiesce: true,
    })
    const failingStore = createDesiredStateStore(stateDir, {
      ...defaultAtomicJsonOperations,
      write(fileDescriptor) {
        defaultAtomicJsonOperations.write(fileDescriptor, '{"partial":')
        throw new Error('fixture write failure')
      },
    })

    await expect(
      failingStore.accept({ ...syncDirective(false, '1.2.3'), quiesce: false }),
    ).rejects.toThrow('fixture write failure')

    expect(failingStore.current().quiesced).toBe(true)
    expect(createDesiredStateStore(stateDir).current().quiesced).toBe(true)
    expect(await readdir(stateDir)).toEqual(['desired-state.json'])
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('acceptance and the final activation section cannot interleave', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-desired-state-'))
  let finishActivation: () => void = () => undefined
  let activation: Promise<boolean> | undefined
  let pause: Promise<void> | undefined
  try {
    const store = createDesiredStateStore(stateDir)
    await store.accept(syncDirective(false, '1.2.3'))
    const activationMayFinish = new Promise<void>(resolve => {
      finishActivation = resolve
    })
    let activationStarted!: () => void
    const didStartActivation = new Promise<void>(resolve => {
      activationStarted = resolve
    })
    activation = store.activateIfCurrent('1.2.3', async () => {
      activationStarted()
      await activationMayFinish
    })
    await didStartActivation
    let pauseAccepted = false
    pause = store.accept(syncDirective(true, '1.2.3')).then(() => {
      pauseAccepted = true
    })

    await new Promise<void>(resolve => setImmediate(resolve))
    expect(pauseAccepted).toBe(false)
    finishActivation()

    expect(await activation).toBe(true)
    await pause
    expect(store.current().paused).toBe(true)
  } finally {
    finishActivation()
    await Promise.allSettled([activation, pause])
    await rm(stateDir, { recursive: true, force: true })
  }
})

function mayActivate(
  store: ReturnType<typeof createDesiredStateStore>,
  version: string,
): Promise<boolean> {
  return store.activateIfCurrent(version, async () => undefined)
}

function release(version: string): RuntimeReleaseDescriptor {
  return {
    formatVersion: 1,
    version,
    artifacts: RUNTIME_RELEASE_ARTIFACT_NAMES.map(name => ({
      name,
      sha256: 'a'.repeat(64),
      byteLength: 10,
      mode: name === 'duet' ? 0o755 : 0o644,
      href: `https://ctl.test/v1/vm/runtime-release/artifacts/${name}`,
    })),
  }
}

function syncDirective(paused: boolean, runtimeVersion: string): VmSyncResponse {
  return {
    pollAfterMs: 5000,
    anchors: [],
    mirrorMachineIds: [],
    runtimeRelease: release(runtimeVersion),
    updates: { paused },
  }
}
