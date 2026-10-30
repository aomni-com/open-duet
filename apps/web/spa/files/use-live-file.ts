'use client'

import { useEffect, useMemo, useSyncExternalStore } from 'react'

import { isNotFoundError } from './lib/files-view'
import type {
  DirectoryEntry,
  FileStat,
  IFileSystemProvider,
  Result,
  VersionedFile,
} from './lib/types'

export const DEFAULT_LIVE_FILE_INTERVAL_MS = 2_000

export type LiveFileSnapshot = {
  entry: DirectoryEntry
  file: VersionedFile
}

type ColdState = {
  snapshot: null
  lastAcceptedAt: null
  consecutiveNotFound: 0
}

type WarmState = {
  snapshot: LiveFileSnapshot
  lastAcceptedAt: number
  consecutiveNotFound: number
}

export type LiveFileState =
  | ({ phase: 'disabled' | 'loading'; error: null } & ColdState)
  | ({ phase: 'error'; error: Error } & ColdState)
  | ({ phase: 'ready'; error: null } & WarmState)
  | ({ phase: 'reconnecting' | 'missing'; error: Error } & WarmState)

export type LiveFileSnapshotLoader = (
  entry: DirectoryEntry,
  signal: AbortSignal,
) => Promise<Result<VersionedFile>>

export interface LiveFileRuntime {
  now(): number
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(timer: unknown): void
  isVisible(): boolean
  subscribeVisibility(listener: () => void): () => void
}

type LiveFileStatProvider = Pick<IFileSystemProvider, 'stat'>

type LiveFileRequest = {
  controller: AbortController
  signal: AbortSignal
  generation: number
}

export type LiveFileControllerOptions = {
  provider: LiveFileStatProvider
  path: string
  enabled: boolean
  loadSnapshot: LiveFileSnapshotLoader
  intervalMs?: number
  runtime: LiveFileRuntime
}

const coldState = (phase: 'disabled' | 'loading'): LiveFileState => ({
  phase,
  snapshot: null,
  error: null,
  lastAcceptedAt: null,
  consecutiveNotFound: 0,
})

export class LiveFileController {
  private readonly provider: LiveFileStatProvider
  private readonly path: string
  private readonly enabled: boolean
  private readonly loadSnapshot: LiveFileSnapshotLoader
  private readonly intervalMs: number
  private readonly runtime: LiveFileRuntime
  private readonly listeners = new Set<() => void>()
  private started = false
  private generation = 0
  private activeRequest: LiveFileRequest | undefined
  private acceptedEntryEtag: string | null = null
  private timer: unknown
  private unsubscribeVisibility: (() => void) | undefined
  private visible = false
  private _state: LiveFileState

  constructor(options: LiveFileControllerOptions) {
    this.provider = options.provider
    this.path = options.path
    this.enabled = options.enabled
    this.loadSnapshot = options.loadSnapshot
    this.intervalMs = options.intervalMs ?? DEFAULT_LIVE_FILE_INTERVAL_MS
    this.runtime = options.runtime
    this._state = coldState(options.enabled ? 'loading' : 'disabled')
  }

  get state(): LiveFileState {
    return this._state
  }

  getState = (): LiveFileState => this._state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start = (): void => {
    if (this.started || !this.enabled) return
    this.started = true
    this.visible = this.runtime.isVisible()
    this.unsubscribeVisibility = this.runtime.subscribeVisibility(this.onVisibilityChange)
    if (!this.visible) return
    if (this._state.snapshot === null) void this.loadInitial()
    else this.schedulePoll()
  }

  stop = (): void => {
    if (!this.started) return
    this.started = false
    this.invalidateRequest()
    this.unsubscribeVisibility?.()
    this.unsubscribeVisibility = undefined
  }

  retry = (): void => {
    if (!this.started || !this.enabled || this._state.phase !== 'error') return
    this.emit(coldState('loading'))
    if (this.visible) void this.loadInitial()
  }

  acceptLocalSave = (snapshot: LiveFileSnapshot): void => {
    if (!this.started || !this.enabled || this._state.snapshot === null) return
    this.invalidateRequest()
    if (snapshot.file.etag === null) {
      this.finishWarmFailure(this._state, missingEtagError())
      return
    }
    this.acceptedEntryEtag = snapshot.file.etag
    this.emit({
      phase: 'ready',
      snapshot,
      error: null,
      lastAcceptedAt: this._state.lastAcceptedAt,
      consecutiveNotFound: 0,
    })
    this.schedulePoll()
  }

  checkNow = (): void => {
    if (!this.started || !this.enabled || this._state.snapshot === null) return
    this.invalidateRequest()
    if (this.visible) void this.poll()
  }

  private onVisibilityChange = (): void => {
    const visible = this.runtime.isVisible()
    if (visible === this.visible) return
    this.visible = visible
    if (!visible) {
      this.invalidateRequest()
      return
    }
    if (!this.started) return
    if (this._state.snapshot === null) void this.loadInitial()
    else void this.poll()
  }

  private async loadInitial(): Promise<void> {
    const operation = this.beginRequest()
    const stat = await this.readStat(operation.signal)
    if (!this.isCurrent(operation)) return
    if (!stat.success) {
      this.finishRequest(operation)
      this.emit({
        phase: 'error',
        snapshot: null,
        error: stat.error,
        lastAcceptedAt: null,
        consecutiveNotFound: 0,
      })
      return
    }
    if (stat.data.etag === null) {
      this.finishRequest(operation)
      this.emit({
        phase: 'error',
        snapshot: null,
        error: missingEtagError(),
        lastAcceptedAt: null,
        consecutiveNotFound: 0,
      })
      return
    }
    const loaded = await this.readSnapshot(stat.data.entry, operation.signal)
    if (!this.isCurrent(operation)) return
    this.finishRequest(operation)
    if (!loaded.success) {
      this.emit({
        phase: 'error',
        snapshot: null,
        error: loaded.error,
        lastAcceptedAt: null,
        consecutiveNotFound: 0,
      })
      return
    }
    if (loaded.data.etag === null) {
      this.emit({
        phase: 'error',
        snapshot: null,
        error: missingEtagError(),
        lastAcceptedAt: null,
        consecutiveNotFound: 0,
      })
      return
    }
    this.acceptedEntryEtag = stat.data.etag
    this.emit({
      phase: 'ready',
      snapshot: { entry: stat.data.entry, file: identified(loaded.data, stat.data.etag) },
      error: null,
      lastAcceptedAt: this.runtime.now(),
      consecutiveNotFound: 0,
    })
    this.schedulePoll()
  }

  private async poll(): Promise<void> {
    const current = this._state
    if (current.snapshot === null) {
      await this.loadInitial()
      return
    }
    const operation = this.beginRequest()
    const stat = await this.readStat(operation.signal)
    if (!this.isCurrent(operation)) return
    if (!stat.success) {
      this.finishRequest(operation)
      this.finishWarmFailure(current, stat.error)
      return
    }
    if (stat.data.etag === null) {
      this.finishRequest(operation)
      this.finishWarmFailure(current, missingEtagError())
      return
    }
    if (stat.data.etag === current.snapshot.file.etag) {
      this.finishRequest(operation)
      const reconcileEntry = this.acceptedEntryEtag !== stat.data.etag
      this.acceptedEntryEtag = stat.data.etag
      if (current.phase !== 'ready' || reconcileEntry) {
        this.emit({
          phase: 'ready',
          snapshot: reconcileEntry
            ? { entry: stat.data.entry, file: current.snapshot.file }
            : current.snapshot,
          error: null,
          lastAcceptedAt: current.lastAcceptedAt,
          consecutiveNotFound: 0,
        })
      }
      this.schedulePoll()
      return
    }
    const loaded = await this.readSnapshot(stat.data.entry, operation.signal)
    if (!this.isCurrent(operation)) return
    this.finishRequest(operation)
    if (!loaded.success) {
      this.finishWarmFailure(current, loaded.error)
      return
    }
    this.acceptedEntryEtag = stat.data.etag
    this.emit({
      phase: 'ready',
      snapshot: { entry: stat.data.entry, file: identified(loaded.data, stat.data.etag) },
      error: null,
      lastAcceptedAt: this.runtime.now(),
      consecutiveNotFound: 0,
    })
    this.schedulePoll()
  }

  private finishWarmFailure(previous: WarmState, error: Error): void {
    const consecutiveNotFound = isNotFoundError(error) ? previous.consecutiveNotFound + 1 : 0
    this.emit({
      phase: consecutiveNotFound >= 2 ? 'missing' : 'reconnecting',
      snapshot: previous.snapshot,
      error,
      lastAcceptedAt: previous.lastAcceptedAt,
      consecutiveNotFound,
    })
    this.schedulePoll()
  }

  private beginRequest(): LiveFileRequest {
    const controller = new AbortController()
    const request = {
      controller,
      signal: controller.signal,
      generation: ++this.generation,
    }
    this.activeRequest = request
    return request
  }

  private isCurrent(request: LiveFileRequest): boolean {
    return (
      this.started &&
      request.generation === this.generation &&
      this.activeRequest === request &&
      !request.signal.aborted
    )
  }

  private finishRequest(request: LiveFileRequest): void {
    if (this.activeRequest === request) this.activeRequest = undefined
  }

  private async readStat(signal: AbortSignal): Promise<Result<FileStat>> {
    try {
      return await this.provider.stat(this.path, { signal })
    } catch (error) {
      return { success: false, error: normalizeError(error) }
    }
  }

  private async readSnapshot(
    entry: DirectoryEntry,
    signal: AbortSignal,
  ): Promise<Result<VersionedFile>> {
    try {
      return await this.loadSnapshot(entry, signal)
    } catch (error) {
      return { success: false, error: normalizeError(error) }
    }
  }

  private schedulePoll(): void {
    if (!this.started || !this.visible) return
    this.clearTimer()
    this.timer = this.runtime.setTimer(() => {
      this.timer = undefined
      void this.poll()
    }, this.intervalMs)
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    this.runtime.clearTimer(this.timer)
    this.timer = undefined
  }

  private invalidateRequest(): void {
    this.generation += 1
    this.activeRequest?.controller.abort()
    this.activeRequest = undefined
    this.clearTimer()
  }

  private emit(state: LiveFileState): void {
    this._state = state
    for (const listener of this.listeners) listener()
  }
}

export type UseLiveFileOptions = Omit<LiveFileControllerOptions, 'runtime'> & {
  runtime?: LiveFileRuntime
}

export function useLiveFile(options: UseLiveFileOptions): {
  state: LiveFileState
  retry(): void
  checkNow(): void
  acceptLocalSave(snapshot: LiveFileSnapshot): void
} {
  const runtime = options.runtime ?? browserLiveFileRuntime
  const controller = useMemo(
    () =>
      new LiveFileController({
        provider: options.provider,
        path: options.path,
        enabled: options.enabled,
        loadSnapshot: options.loadSnapshot,
        intervalMs: options.intervalMs,
        runtime,
      }),
    [
      options.enabled,
      options.intervalMs,
      options.loadSnapshot,
      options.path,
      options.provider,
      runtime,
    ],
  )
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  useEffect(() => {
    controller.start()
    return controller.stop
  }, [controller])
  return {
    state,
    retry: controller.retry,
    checkNow: controller.checkNow,
    acceptLocalSave: controller.acceptLocalSave,
  }
}

const browserLiveFileRuntime: LiveFileRuntime = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: timer => window.clearTimeout(timer as number),
  isVisible: () => document.visibilityState === 'visible',
  subscribeVisibility: listener => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
}

/**
 * A file's identity is the one `stat` reports, not the one its content read
 * happened to carry.
 *
 * They are the same value at the drive, but they travel differently: stat's
 * rides in a JSON body, the read's in an `ETag` header — and a header is
 * rewritable by anything between the drive and the browser. Take the header's
 * and every conditional write is compared against a value the drive never
 * minted, so `If-Match` can only fail: saving becomes impossible and the
 * failure is reported as somebody else's edit. Taking stat's also stops the
 * poll from re-reading the whole file every tick because two spellings of the
 * same identity never compare equal.
 */
function identified(file: VersionedFile, etag: string): VersionedFile {
  return file.etag === etag ? file : { ...file, etag }
}

function missingEtagError(): Error {
  return new Error('live_file_missing_etag')
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
