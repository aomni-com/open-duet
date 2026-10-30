import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface PersistedJsonStore<T> {
  acceptResponse(body: unknown): void
  current(): T
}

export interface PersistedJsonStoreOptions<T> {
  stateDir: string
  fileName: string
  initial: T
  parseResponse(body: unknown): T | null
  parsePersisted?(value: unknown): T | null
  snapshot?(value: T): T
  onLoad?(value: T): void
  onAccept?(value: T): void
}

export function persistedStorePath(stateDir: string, fileName: string): string {
  return resolve(stateDir, fileName)
}

export function createPersistedJsonStore<T>(
  options: PersistedJsonStoreOptions<T>,
): PersistedJsonStore<T> {
  const snapshot = options.snapshot ?? ((value: T): T => value)
  let current = readPersisted(options)
  options.onLoad?.(current)

  return {
    acceptResponse(body: unknown): void {
      const parsed = options.parseResponse(body)
      if (parsed === null) return
      current = parsed
      options.onAccept?.(parsed)
      persist(options.stateDir, options.fileName, parsed)
    },

    current(): T {
      return snapshot(current)
    },
  }
}

function readPersisted<T>(options: PersistedJsonStoreOptions<T>): T {
  try {
    const path = persistedStorePath(options.stateDir, options.fileName)
    const parsed = (options.parsePersisted ?? options.parseResponse)(
      JSON.parse(readFileSync(path, 'utf8')),
    )
    return parsed ?? options.initial
  } catch {
    return options.initial
  }
}

function persist<T>(stateDir: string, fileName: string, value: T): void {
  const path = persistedStorePath(stateDir, fileName)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}
