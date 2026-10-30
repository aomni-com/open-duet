import { expect, test } from 'bun:test'

import type { DirectoryEntry, FileStat, Result, VersionedFile } from './lib/types'
import {
  LiveFileController,
  type LiveFileRuntime,
  type LiveFileSnapshotLoader,
} from './use-live-file'

const entry = (name = 'notes.md'): DirectoryEntry => ({
  name,
  path: `/${name}`,
  type: 'file',
  isDirectory: false,
  size: 5,
  modifiedAt: new Date('2026-08-03T00:00:00.000Z'),
})

const file = (etag: string, content = etag): VersionedFile => ({
  data: new TextEncoder().encode(content),
  etag,
  contentType: 'text/markdown',
  size: content.length,
})

const ok = <T>(data: T): Result<T> => ({ success: true, data })
const fail = (error: Error): Result<never> => ({ success: false, error })
const httpError = (status: number, message = `http_${status}`): Error =>
  Object.assign(new Error(message), { status })

class FakeRuntime implements LiveFileRuntime {
  nowMs = 100
  visible = true
  readonly timers: Array<{ callback: () => void; dueAt: number; cleared: boolean }> = []
  readonly visibilityListeners = new Set<() => void>()

  now = () => this.nowMs

  setTimer = (callback: () => void, delayMs: number): unknown => {
    const timer = { callback, dueAt: this.nowMs + delayMs, cleared: false }
    this.timers.push(timer)
    return timer
  }

  clearTimer = (timer: unknown): void => {
    ;(timer as (typeof this.timers)[number]).cleared = true
  }

  isVisible = () => this.visible

  subscribeVisibility = (listener: () => void): (() => void) => {
    this.visibilityListeners.add(listener)
    return () => this.visibilityListeners.delete(listener)
  }

  advanceTo(nowMs: number): void {
    while (true) {
      const next = this.timers
        .filter(timer => !timer.cleared && timer.dueAt <= nowMs)
        .sort((left, right) => left.dueAt - right.dueAt)[0]
      if (next === undefined) break
      this.nowMs = next.dueAt
      next.cleared = true
      next.callback()
    }
    this.nowMs = nowMs
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    for (const listener of this.visibilityListeners) listener()
  }
}

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('cold load accepts the read identity and schedules the first poll after settlement', async () => {
  const runtime = new FakeRuntime()
  const initialEntry = entry()
  const statCalls: string[] = []
  const loadCalls: DirectoryEntry[] = []
  const provider = {
    stat: async (path: string): Promise<Result<FileStat>> => {
      statCalls.push(path)
      return ok({ entry: initialEntry, etag: '"v1"' })
    },
  }
  const loadSnapshot: LiveFileSnapshotLoader = async loadedEntry => {
    loadCalls.push(loadedEntry)
    return ok(file('"v1"', 'hello'))
  }
  const controller = new LiveFileController({
    provider,
    path: '/notes.md',
    enabled: true,
    loadSnapshot,
    runtime,
  })

  controller.start()
  await settle()

  expect(controller.state).toEqual({
    phase: 'ready',
    snapshot: { entry: initialEntry, file: file('"v1"', 'hello') },
    error: null,
    lastAcceptedAt: 100,
    consecutiveNotFound: 0,
  })
  expect({ statCalls, loadCalls }).toEqual({
    statCalls: ['/notes.md'],
    loadCalls: [initialEntry],
  })
  expect(runtime.timers.filter(timer => !timer.cleared).map(timer => timer.dueAt)).toEqual([2_100])
})

test('visible polls serialize and schedule the next cadence only after settlement', async () => {
  const runtime = new FakeRuntime()
  const currentEntry = entry()
  const pendingPoll = deferred<Result<FileStat>>()
  let statCalls = 0
  const provider = {
    stat: async (): Promise<Result<FileStat>> => {
      statCalls += 1
      return statCalls === 1 ? ok({ entry: currentEntry, etag: '"v1"' }) : await pendingPoll.promise
    },
  }
  const controller = new LiveFileController({
    provider,
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => ok(file('"v1"')),
    runtime,
  })
  controller.start()
  await settle()

  runtime.advanceTo(2_100)
  expect(statCalls).toBe(2)
  expect(runtime.timers.filter(timer => !timer.cleared)).toEqual([])

  runtime.advanceTo(20_000)
  expect(statCalls).toBe(2)

  pendingPoll.resolve(ok({ entry: currentEntry, etag: '"v1"' }))
  await settle()
  expect(runtime.timers.filter(timer => !timer.cleared).map(timer => timer.dueAt)).toEqual([22_000])
})

test('visibility suspends all cadence and resumes with one immediate check', async () => {
  const runtime = new FakeRuntime()
  const currentEntry = entry()
  const statTimes: number[] = []
  const controller = new LiveFileController({
    provider: {
      stat: async () => {
        statTimes.push(runtime.nowMs)
        return ok({ entry: currentEntry, etag: '"v1"' })
      },
    },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => ok(file('"v1"')),
    runtime,
  })
  controller.start()
  await settle()

  runtime.setVisible(false)
  runtime.advanceTo(10_000)
  await settle()
  expect(statTimes).toEqual([100])
  expect(runtime.timers.filter(timer => !timer.cleared)).toEqual([])

  runtime.setVisible(true)
  await settle()
  expect(statTimes).toEqual([100, 10_000])
  expect(runtime.timers.filter(timer => !timer.cleared).map(timer => timer.dueAt)).toEqual([12_000])
})

test('Strict Mode start-stop-start cleans up and ignores the abandoned mount', async () => {
  const runtime = new FakeRuntime()
  const firstStat = deferred<Result<FileStat>>()
  const currentEntry = entry()
  const signals: AbortSignal[] = []
  let statCalls = 0
  const controller = new LiveFileController({
    provider: {
      stat: async (_path, options) => {
        statCalls += 1
        signals.push(options?.signal as AbortSignal)
        return statCalls === 1
          ? await firstStat.promise
          : ok({ entry: currentEntry, etag: '"current"' })
      },
    },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => ok(file('"current"')),
    runtime,
  })

  controller.start()
  controller.stop()
  expect(signals[0]?.aborted).toBe(true)
  expect(runtime.visibilityListeners.size).toBe(0)

  controller.start()
  await settle()
  expect(controller.state.phase).toBe('ready')
  expect(runtime.visibilityListeners.size).toBe(1)
  expect(runtime.timers.filter(timer => !timer.cleared).map(timer => timer.dueAt)).toEqual([2_100])

  firstStat.resolve(ok({ entry: entry('old.md'), etag: '"old"' }))
  await settle()
  expect(controller.state.phase === 'ready' && controller.state.snapshot.file.etag).toBe(
    '"current"',
  )
  expect(runtime.timers.filter(timer => !timer.cleared).map(timer => timer.dueAt)).toEqual([2_100])

  controller.stop()
  expect(runtime.visibilityListeners.size).toBe(0)
  expect(runtime.timers.filter(timer => !timer.cleared)).toEqual([])
})

test('same identity skips content while a changed identity reads exactly once', async () => {
  const runtime = new FakeRuntime()
  const entries = [entry(), entry(), { ...entry(), size: 8 }] as const
  const stats = ['"v1"', '"v1"', '"v2"']
  let statIndex = 0
  const loadedEtags = ['"v1"', '"v3"']
  const loadedEntries: DirectoryEntry[] = []
  let emissions = 0
  const controller = new LiveFileController({
    provider: {
      stat: async () => ok({ entry: entries[statIndex]!, etag: stats[statIndex++]! }),
    },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async loadedEntry => {
      loadedEntries.push(loadedEntry)
      return ok(file(loadedEtags.shift()!))
    },
    runtime,
  })
  controller.subscribe(() => {
    emissions += 1
  })
  controller.start()
  await settle()
  expect(emissions).toBe(1)

  runtime.advanceTo(2_100)
  await settle()
  expect(loadedEntries).toEqual([entries[0]])
  expect(controller.state.phase === 'ready' && controller.state.snapshot.entry).toBe(entries[0])
  expect(emissions).toBe(1)

  runtime.advanceTo(4_100)
  await settle()
  expect(loadedEntries).toEqual([entries[0], entries[2]])
  expect(controller.state.phase === 'ready' && controller.state.snapshot.file.etag).toBe('"v2"')
  expect(emissions).toBe(2)
})

test('a stat-read race carries the stat identity through every reconciliation', async () => {
  const runtime = new FakeRuntime()
  const initial = entry()
  const raced = { ...entry(), size: 6 }
  const reconciled = { ...entry(), size: 7 }
  const stats = [
    { entry: initial, etag: '"v1"' },
    { entry: raced, etag: '"v2"' },
    { entry: reconciled, etag: '"v3"' },
  ]
  /* One read per identity the drive reports. The old shape skipped this last
     one by trusting the ETag the read's own response carried — an identity a
     proxy can rewrite, so it is no longer allowed to decide anything. A stat
     that races ahead of a read costs one extra read; conditional writes that
     can never match cost the reader their document. */
  const reads = ['"v1"', '"v3"', '"v3"']
  const trace: Array<{ at: number; etag: string | null; size: number | undefined }> = []
  const controller = new LiveFileController({
    provider: { stat: async () => ok(stats.shift()!) },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => ok(file(reads.shift()!)),
    runtime,
  })
  controller.subscribe(() => {
    if (controller.state.snapshot !== null) {
      trace.push({
        at: runtime.nowMs,
        etag: controller.state.snapshot.file.etag,
        size: controller.state.snapshot.entry.size,
      })
    }
  })
  controller.start()
  await settle()
  runtime.advanceTo(2_100)
  await settle()
  runtime.advanceTo(4_100)
  await settle()

  expect(trace).toEqual([
    { at: 100, etag: '"v1"', size: 5 },
    { at: 2_100, etag: '"v2"', size: 6 },
    { at: 4_100, etag: '"v3"', size: 7 },
  ])
  expect(reads).toEqual([])
  // Every accepted identity is an acceptance, including the last one.
  expect(controller.state.lastAcceptedAt).toBe(4_100)
})

test('a changed identity is accepted even when the bytes come back unchanged', async () => {
  const runtime = new FakeRuntime()
  const initial = entry()
  const raced = { ...entry(), size: 9 }
  const stats = [
    { entry: initial, etag: '"v1"' },
    { entry: raced, etag: '"v2"' },
  ]
  let emissions = 0
  const controller = new LiveFileController({
    provider: { stat: async () => ok(stats.shift()!) },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => ok(file('"v1"')),
    runtime,
  })
  controller.subscribe(() => {
    emissions += 1
  })
  controller.start()
  await settle()

  runtime.advanceTo(2_100)
  await settle()

  /* The drive re-minted this file's identity over bytes nobody changed — an
     atomic rewrite, a metadata touch, a sync round trip. The controller carries
     the identity the drive is serving now, so the next conditional write is
     compared against something the drive will accept; deciding that identical
     bytes are not a conflict belongs to the draft, not here. */
  expect(controller.state.phase === 'ready' && controller.state.snapshot).toEqual({
    entry: raced,
    file: file('"v2"', '"v1"'),
  })
  expect(controller.state.lastAcceptedAt).toBe(2_100)
  expect(emissions).toBe(2)
})

test('accepting a local save invalidates an older remote read', async () => {
  const runtime = new FakeRuntime()
  const currentEntry = entry()
  const remoteRead = deferred<Result<VersionedFile>>()
  const readSignals: AbortSignal[] = []
  let statCalls = 0
  let readCalls = 0
  const controller = new LiveFileController({
    provider: {
      stat: async () => {
        statCalls += 1
        return ok({ entry: currentEntry, etag: statCalls === 1 ? '"v1"' : '"remote"' })
      },
    },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async (_entry, signal) => {
      readSignals.push(signal)
      readCalls += 1
      return readCalls === 1 ? ok(file('"v1"')) : await remoteRead.promise
    },
    runtime,
  })
  controller.start()
  await settle()
  runtime.advanceTo(2_100)
  await settle()

  const saved = { entry: { ...currentEntry, size: 11 }, file: file('"saved"', 'local draft') }
  controller.acceptLocalSave(saved)
  expect(readSignals[1]?.aborted).toBe(true)
  expect(controller.state.phase === 'ready' && controller.state.snapshot).toEqual(saved)
  expect(controller.state.lastAcceptedAt).toBe(100)

  remoteRead.resolve(ok(file('"remote"', 'remote bytes')))
  await settle()
  expect(controller.state.phase === 'ready' && controller.state.snapshot).toEqual(saved)
  expect(runtime.timers.filter(timer => !timer.cleared).map(timer => timer.dueAt)).toEqual([4_100])
})

test('checkNow invalidates older work and accepts one immediate controller-owned refresh', async () => {
  const runtime = new FakeRuntime()
  const currentEntry = entry()
  const oldRefresh = deferred<Result<VersionedFile>>()
  const readSignals: AbortSignal[] = []
  let statCalls = 0
  let readCalls = 0
  const controller = new LiveFileController({
    provider: {
      stat: async () => {
        statCalls += 1
        const etag = statCalls === 1 ? '"v1"' : statCalls === 2 ? '"old"' : '"latest"'
        return ok({ entry: currentEntry, etag })
      },
    },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async (_entry, signal) => {
      readSignals.push(signal)
      readCalls += 1
      if (readCalls === 1) return ok(file('"v1"'))
      if (readCalls === 2) return await oldRefresh.promise
      return ok(file('"latest"', 'latest bytes'))
    },
    runtime,
  })
  controller.start()
  await settle()
  runtime.advanceTo(2_100)
  await settle()

  controller.checkNow()
  await settle()
  expect(readSignals[1]?.aborted).toBe(true)
  expect(controller.state.phase === 'ready' && controller.state.snapshot.file.etag).toBe('"latest"')

  oldRefresh.resolve(ok(file('"old"')))
  await settle()
  expect(controller.state.phase === 'ready' && controller.state.snapshot.file.etag).toBe('"latest"')
  expect(runtime.timers.filter(timer => !timer.cleared).map(timer => timer.dueAt)).toEqual([4_100])
})

test('stopping an old path prevents its late snapshot from reaching the replacement', async () => {
  const runtime = new FakeRuntime()
  const oldRead = deferred<Result<VersionedFile>>()
  const oldController = new LiveFileController({
    provider: { stat: async () => ok({ entry: entry('old.md'), etag: '"old"' }) },
    path: '/old.md',
    enabled: true,
    loadSnapshot: async () => await oldRead.promise,
    runtime,
  })
  oldController.start()
  await settle()
  oldController.stop()

  const nextEntry = entry('next.md')
  const nextController = new LiveFileController({
    provider: { stat: async () => ok({ entry: nextEntry, etag: '"next"' }) },
    path: '/next.md',
    enabled: true,
    loadSnapshot: async () => ok(file('"next"')),
    runtime,
  })
  nextController.start()
  await settle()
  oldRead.resolve(ok(file('"old"')))
  await settle()

  expect(oldController.state.phase).toBe('loading')
  expect(nextController.state.phase === 'ready' && nextController.state.snapshot).toEqual({
    entry: nextEntry,
    file: file('"next"'),
  })
  expect(runtime.visibilityListeners.size).toBe(1)
  expect(runtime.timers.filter(timer => !timer.cleared).map(timer => timer.dueAt)).toEqual([2_100])
})

test('transition trace retains the snapshot through recovery, missing, and reappearance', async () => {
  const runtime = new FakeRuntime()
  const currentEntry = entry()
  const stats: Array<Result<FileStat>> = [
    ok({ entry: currentEntry, etag: '"a"' }),
    ok({ entry: { ...currentEntry, size: 6 }, etag: '"b"' }),
    fail(httpError(503)),
    fail(httpError(404, 'not_found')),
    fail(httpError(404, 'not_found')),
    ok({ entry: { ...currentEntry, size: 7 }, etag: '"c"' }),
  ]
  const reads = [file('"a"'), file('"b"'), file('"c"')]
  const trace: Array<{ at: number; phase: string; etag: string | null; notFound: number }> = []
  const controller = new LiveFileController({
    provider: { stat: async () => stats.shift()! },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => ok(reads.shift()!),
    runtime,
  })
  controller.subscribe(() => {
    const state = controller.state
    if (state.snapshot === null) return
    trace.push({
      at: runtime.nowMs,
      phase: state.phase,
      etag: state.snapshot.file.etag,
      notFound: state.consecutiveNotFound,
    })
  })
  controller.start()
  await settle()
  for (const at of [2_100, 4_100, 6_100, 8_100, 10_100]) {
    runtime.advanceTo(at)
    await settle()
  }

  expect(trace).toEqual([
    { at: 100, phase: 'ready', etag: '"a"', notFound: 0 },
    { at: 2_100, phase: 'ready', etag: '"b"', notFound: 0 },
    { at: 4_100, phase: 'reconnecting', etag: '"b"', notFound: 0 },
    { at: 6_100, phase: 'reconnecting', etag: '"b"', notFound: 1 },
    { at: 8_100, phase: 'missing', etag: '"b"', notFound: 2 },
    { at: 10_100, phase: 'ready', etag: '"c"', notFound: 0 },
  ])
  expect(stats).toEqual([])
  expect(reads).toEqual([])
})

test('only consecutive classified 404 failures advance the missing streak', async () => {
  const runtime = new FakeRuntime()
  const currentEntry = entry()
  const stats: Array<Result<FileStat>> = [
    ok({ entry: currentEntry, etag: '"a"' }),
    fail(httpError(404)),
    fail(httpError(503)),
    fail(httpError(404)),
    fail(httpError(404)),
  ]
  const observed: Array<[string, number]> = []
  const controller = new LiveFileController({
    provider: { stat: async () => stats.shift()! },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => ok(file('"a"')),
    runtime,
  })
  controller.subscribe(() => {
    if (controller.state.snapshot !== null) {
      observed.push([controller.state.phase, controller.state.consecutiveNotFound])
    }
  })
  controller.start()
  await settle()
  for (const at of [2_100, 4_100, 6_100, 8_100]) {
    runtime.advanceTo(at)
    await settle()
  }

  expect(observed).toEqual([
    ['ready', 0],
    ['reconnecting', 1],
    ['reconnecting', 0],
    ['reconnecting', 1],
    ['missing', 2],
  ])
})

test('same-ETag reappearance clears missing without replacing or rereading the snapshot', async () => {
  const runtime = new FakeRuntime()
  const currentEntry = entry()
  const stats: Array<Result<FileStat>> = [
    ok({ entry: currentEntry, etag: '"v1"' }),
    fail(httpError(404, 'not_found')),
    fail(httpError(404, 'not_found')),
    ok({ entry: { ...currentEntry, size: 99 }, etag: '"v1"' }),
  ]
  let reads = 0
  const controller = new LiveFileController({
    provider: { stat: async () => stats.shift()! },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => {
      reads += 1
      return ok(file('"v1"'))
    },
    runtime,
  })
  controller.start()
  await settle()
  const accepted = controller.state.snapshot

  runtime.advanceTo(2_100)
  await settle()
  runtime.advanceTo(4_100)
  await settle()
  expect(controller.state.phase).toBe('missing')

  runtime.advanceTo(6_100)
  await settle()
  expect(controller.state.phase).toBe('ready')
  expect(controller.state.snapshot).toBe(accepted)
  expect(reads).toBe(1)
})

test('retry restarts a failed cold load and accepts the recovered snapshot', async () => {
  const runtime = new FakeRuntime()
  const currentEntry = entry()
  let failed = true
  const controller = new LiveFileController({
    provider: {
      stat: async () =>
        failed ? fail(httpError(503)) : ok({ entry: currentEntry, etag: '"recovered"' }),
    },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => ok(file('"recovered"')),
    runtime,
  })
  controller.start()
  await settle()
  expect(controller.state.phase).toBe('error')
  expect(runtime.timers.filter(timer => !timer.cleared)).toEqual([])

  failed = false
  controller.retry()
  await settle()
  expect(controller.state.phase === 'ready' && controller.state.snapshot.file.etag).toBe(
    '"recovered"',
  )
  expect(runtime.timers.filter(timer => !timer.cleared).map(timer => timer.dueAt)).toEqual([2_100])
})

test('an authenticated file without an ETag fails instead of falling back to metadata', async () => {
  const runtime = new FakeRuntime()
  let loads = 0
  const controller = new LiveFileController({
    provider: { stat: async () => ok({ entry: entry(), etag: null }) },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => {
      loads += 1
      return ok(file('"unused"'))
    },
    runtime,
  })
  controller.start()
  await settle()

  expect(controller.state.phase).toBe('error')
  expect(controller.state.error?.message).toBe('live_file_missing_etag')
  expect(loads).toBe(0)
  expect(runtime.timers.filter(timer => !timer.cleared)).toEqual([])
})

test('freshness comparison never reads size or modified time', async () => {
  const runtime = new FakeRuntime()
  const initial = entry()
  const metadataTrap = {
    name: 'notes.md',
    path: '/notes.md',
    type: 'file',
    isDirectory: false,
    get size(): never {
      throw new Error('size must not decide freshness')
    },
    get modifiedAt(): never {
      throw new Error('mtime must not decide freshness')
    },
  } satisfies DirectoryEntry
  let statCalls = 0
  let reads = 0
  const controller = new LiveFileController({
    provider: {
      stat: async () => {
        statCalls += 1
        return ok({ entry: statCalls === 1 ? initial : metadataTrap, etag: '"same"' })
      },
    },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => {
      reads += 1
      return ok(file('"same"'))
    },
    runtime,
  })
  controller.start()
  await settle()
  runtime.advanceTo(2_100)
  await settle()

  expect(reads).toBe(1)
  expect(controller.state.phase === 'ready' && controller.state.snapshot.entry).toBe(initial)
})

test('disabled mode performs no requests, timers, or visibility work', async () => {
  const runtime = new FakeRuntime()
  let stats = 0
  let reads = 0
  const controller = new LiveFileController({
    provider: {
      stat: async () => {
        stats += 1
        return ok({ entry: entry(), etag: '"v1"' })
      },
    },
    path: '/notes.md',
    enabled: false,
    loadSnapshot: async () => {
      reads += 1
      return ok(file('"v1"'))
    },
    runtime,
  })

  controller.start()
  runtime.advanceTo(20_000)
  runtime.setVisible(false)
  runtime.setVisible(true)
  controller.retry()
  await settle()

  expect(controller.state.phase).toBe('disabled')
  expect({ stats, reads, listeners: runtime.visibilityListeners.size }).toEqual({
    stats: 0,
    reads: 0,
    listeners: 0,
  })
  expect(runtime.timers).toEqual([])
})

test('visibility trace aborts an active check and resumes once immediately', async () => {
  const runtime = new FakeRuntime()
  const currentEntry = entry()
  const hiddenPoll = deferred<Result<FileStat>>()
  const trace: Array<{ at: number; signal: AbortSignal }> = []
  let statCalls = 0
  const controller = new LiveFileController({
    provider: {
      stat: async (_path, options) => {
        statCalls += 1
        trace.push({ at: runtime.nowMs, signal: options?.signal as AbortSignal })
        if (statCalls === 2) return await hiddenPoll.promise
        return ok({ entry: currentEntry, etag: '"v1"' })
      },
    },
    path: '/notes.md',
    enabled: true,
    loadSnapshot: async () => ok(file('"v1"')),
    runtime,
  })
  controller.start()
  await settle()
  runtime.advanceTo(2_100)
  await settle()
  runtime.setVisible(false)
  expect(trace[1]!.signal.aborted).toBe(true)

  runtime.advanceTo(10_000)
  runtime.setVisible(true)
  await settle()
  hiddenPoll.resolve(ok({ entry: entry('stale.md'), etag: '"stale"' }))
  await settle()

  expect(trace.map(item => item.at)).toEqual([100, 2_100, 10_000])
  expect(controller.state.phase === 'ready' && controller.state.snapshot.file.etag).toBe('"v1"')
  expect(runtime.timers.filter(timer => !timer.cleared).map(timer => timer.dueAt)).toEqual([12_000])
})

test('the accepted identity is the one stat reports, never the one the read carried', async () => {
  const runtime = new FakeRuntime()
  const current = entry()
  let reads = 0
  const controller = new LiveFileController({
    provider: { stat: async () => ok({ entry: current, etag: '"stat-v1"' }) as Result<FileStat> },
    path: current.path,
    enabled: true,
    // A proxy between the drive and the browser may rewrite an ETag *header*;
    // a JSON body is beyond its reach, so the two spellings can disagree.
    loadSnapshot: async () => {
      reads += 1
      return ok(file('W/"stat-v1"', 'hello'))
    },
    runtime,
  })

  controller.start()
  await settle()

  expect(controller.state.phase === 'ready' && controller.state.snapshot.file.etag).toBe(
    '"stat-v1"',
  )
  // The next poll agrees with the accepted identity, so the bytes stay put.
  runtime.advanceTo(2_100)
  await settle()
  expect(reads).toBe(1)
})
