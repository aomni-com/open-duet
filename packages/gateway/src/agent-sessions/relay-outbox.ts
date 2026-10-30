import { constants } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import { defaultAtomicJsonOperations, type AtomicJsonOperations } from '../atomic-json'

// One job: stop a runaway session from filling the drive. Nothing else.
//
// The journal holds only what the control plane has not acknowledged yet, and
// it is deleted the moment it drains empty — on a healthy production VM every
// session directory holds its snapshot and no journal at all, mid-turn
// included. So this limit bounds a BACKLOG, not a turn's output.
//
// Bytes, because bytes are what a drive runs out of, and bytes are also what
// the replay fold costs to hold. A record count alongside them would be a
// second knob for the same failure that says less: 1,024 records is anything
// from a kilobyte to half a gigabyte. Firing here is not free — it kills the
// runner and re-runs the whole turn at model cost — so the one guard that
// fires is the one measuring the resource that actually runs out.
//
// The size is the largest journal that can still be READ. `load` turns the file
// into one string, so a journal past the runtime's max string length throws
// where this guard would have stopped the runner cleanly — the cap has to bind
// first or it never binds at all. That lands near 2 GiB, which is several whole
// session snapshots: a record carries a checkpoint, so a stalled drain gets to
// hold a few before this calls an ordinary slow session a runaway.
//
// The margin is for the terminal report `admitBeyondCapacity` lets through
// AFTER the cap is reached, which must still leave the journal loadable.
const LOADER_MARGIN_BYTES = 1024 * 1024
export const AGENT_RELAY_OUTBOX_LIMITS = {
  maxBytes: constants.MAX_STRING_LENGTH - LOADER_MARGIN_BYTES,
} as const

export class AgentRelayOutboxCapacityError extends Error {
  constructor() {
    super('agent relay outbox capacity exceeded')
    this.name = 'AgentRelayOutboxCapacityError'
  }
}

type LoadedOutbox<T> = {
  records: T[]
  keys: Set<string>
  bytes: number
  stamp: string
}

export interface RelayOutboxStore<T> {
  load(sessionId: string): LoadedOutbox<T>
  append(sessionId: string, record: T): void
  replace(sessionId: string, records: T[]): void
  forget(sessionId: string): void
}

export function createRelayOutboxStore<T>(options: {
  pathForSession(sessionId: string): string
  parse(value: unknown): T
  key(record: T): string
  operations?: AtomicJsonOperations
  limits?: { maxBytes: number }
  fsyncDirectory(path: string): void
  onCacheEntriesChanged?: (entries: number) => void
  onUnreadableRecords?: (sessionId: string, dropped: number) => void
  /**
   * The shape a record must take before it is held, applied on the way in and
   * again to records read back from disk — the second is what heals a journal
   * an older gateway wrote under different rules. Returns its argument
   * unchanged when nothing needed doing, and that identity is the signal: a
   * load whose records all come back unchanged leaves the file alone.
   */
  normalize?: (record: T) => T
  /**
   * Records admitted past the capacity limit. Capacity exists to stop a
   * runner that is outrunning the control plane, and the record that REPORTS
   * that stop is the one thing refusing it makes worse: the turn ends with
   * nobody told.
   */
  admitBeyondCapacity?: (record: T) => boolean
}): RelayOutboxStore<T> {
  const operations = options.operations ?? defaultAtomicJsonOperations
  const limits = options.limits ?? AGENT_RELAY_OUTBOX_LIMITS
  const cache = new Map<string, LoadedOutbox<T>>()

  function cacheOutbox(sessionId: string, outbox: LoadedOutbox<T>): void {
    cache.set(sessionId, outbox)
    options.onCacheEntriesChanged?.(cache.size)
  }

  function forgetOutbox(sessionId: string): void {
    cache.delete(sessionId)
    options.onCacheEntriesChanged?.(cache.size)
  }

  function load(sessionId: string): LoadedOutbox<T> {
    const path = options.pathForSession(sessionId)
    const cached = cache.get(sessionId)
    if (cached !== undefined && cached.stamp === stamp(path)) return cached
    if (!existsSync(path)) {
      const empty = { records: [], keys: new Set<string>(), bytes: 0, stamp: 'missing' }
      forgetOutbox(sessionId)
      return empty
    }
    // One string for the whole journal, which is what `AGENT_RELAY_OUTBOX_LIMITS`
    // is sized against. Reading in chunks is what a larger cap would need.
    const source = readFileSync(path, 'utf8')
    const complete = source.endsWith('\n') ? source : source.slice(0, source.lastIndexOf('\n') + 1)
    const records: T[] = []
    let unreadable = 0
    let normalized = 0
    for (const line of complete.split('\n')) {
      if (line.length === 0) continue
      try {
        const parsed = options.parse(JSON.parse(line))
        const record = options.normalize?.(parsed) ?? parsed
        if (record !== parsed) normalized += 1
        records.push(record)
      } catch {
        // Damage is not always the last append: a torn write leaves a
        // committed, newline-terminated record unreadable in the MIDDLE of the
        // journal. This journal holds events waiting to be relayed, so a record
        // nothing can parse is a record nothing can ever relay, and its bytes
        // are already gone — while throwing loses the whole session with them,
        // for every route that reads it. Keep what is readable, report the rest.
        unreadable += 1
      }
    }
    const keys = new Set(records.map(options.key))
    if (keys.size !== records.length) throw new Error('duplicate agent relay id')
    const loaded = { records, keys, bytes: Buffer.byteLength(complete), stamp: stamp(path) }
    if (records.length === 0) forgetOutbox(sessionId)
    else cacheOutbox(sessionId, loaded)
    if (unreadable > 0) options.onUnreadableRecords?.(sessionId, unreadable)
    // The partial tail never committed, the unreadable records never can, and a
    // normalized record is no longer what the file says — each leaves the file
    // disagreeing with what this outbox holds. Compact it and read back the
    // compacted truth: `loaded` counts bytes the outbox is about to stop
    // holding, and that count gates the capacity of every append after it.
    if (complete.length !== source.length || unreadable > 0 || normalized > 0) {
      replace(sessionId, records)
      return load(sessionId)
    }
    return loaded
  }

  function append(sessionId: string, input: T): void {
    const record = options.normalize?.(input) ?? input
    const outbox = load(sessionId)
    const recordKey = options.key(record)
    if (outbox.keys.has(recordKey)) throw new Error('agent relay id collision')
    const line = `${JSON.stringify(record)}\n`
    const bytes = Buffer.byteLength(line)
    if (options.admitBeyondCapacity?.(record) !== true && outbox.bytes + bytes > limits.maxBytes) {
      throw new AgentRelayOutboxCapacityError()
    }
    const path = options.pathForSession(sessionId)
    const directory = dirname(path)
    const created = !existsSync(path)
    operations.mkdir(directory)
    const descriptor = operations.open(path, 'a', 0o600)
    try {
      operations.write(descriptor, line)
      operations.fsync(descriptor)
    } finally {
      operations.close(descriptor)
    }
    if (created) options.fsyncDirectory(directory)
    outbox.records.push(record)
    outbox.keys.add(recordKey)
    outbox.bytes += bytes
    outbox.stamp = stamp(path)
    cacheOutbox(sessionId, outbox)
  }

  function replace(sessionId: string, records: T[]): void {
    const path = options.pathForSession(sessionId)
    const directory = dirname(path)
    if (records.length === 0) {
      if (existsSync(path)) {
        operations.remove(path)
        options.fsyncDirectory(directory)
      }
      forgetOutbox(sessionId)
      return
    }
    const content = records.map(record => `${JSON.stringify(record)}\n`).join('')
    operations.mkdir(directory)
    const temporary = `${path}.${randomUUID()}.tmp`
    let descriptor: number | null = null
    try {
      descriptor = operations.open(temporary, 'wx', 0o600)
      operations.write(descriptor, content)
      operations.fsync(descriptor)
      operations.close(descriptor)
      descriptor = null
      operations.rename(temporary, path)
      options.fsyncDirectory(directory)
    } catch (error) {
      if (descriptor !== null) {
        try {
          operations.close(descriptor)
        } catch {
          // Preserve the compaction failure.
        }
      }
      try {
        operations.remove(temporary)
      } catch {
        // Preserve the compaction failure.
      }
      throw error
    }
    const keys = new Set(records.map(options.key))
    if (keys.size !== records.length) throw new Error('duplicate agent relay id')
    cacheOutbox(sessionId, {
      records: [...records],
      keys,
      bytes: Buffer.byteLength(content),
      stamp: stamp(path),
    })
  }

  return {
    load,
    append,
    replace,
    forget(sessionId) {
      forgetOutbox(sessionId)
    },
  }
}

function stamp(path: string): string {
  if (!existsSync(path)) return 'missing'
  const stat = statSync(path)
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
}
