import { describe, expect, test } from 'bun:test'

import { FAN, type FidRecord } from './fanotify-codec'
import {
  createHandlePathCache,
  pollTimeoutMs,
  createPinCache,
  unitForCgroupContent,
  type PinCacheOptions,
} from './helper-main'

// ---------------------------------------------------------------------------
// Fake /proc: the pin cache's only inputs are readCgroup/readStartTime, so a
// fake event feed is just mutations of this table between calls — pin at
// open-perm time, mutate (exit, pid reuse), then resolve at NOTIF time.
// ---------------------------------------------------------------------------

interface FakeProcess {
  cgroup: string
  startTime: number
}

function fakeProc(initial: Record<number, FakeProcess>) {
  const table = new Map<number, FakeProcess>(
    Object.entries(initial).map(([pid, proc]) => [Number(pid), proc]),
  )
  let cgroupReads = 0
  const options: Required<Pick<PinCacheOptions, 'readCgroup' | 'readStartTime'>> = {
    readCgroup: pid => {
      cgroupReads += 1
      return table.get(pid)?.cgroup ?? null
    },
    readStartTime: pid => table.get(pid)?.startTime ?? null,
  }
  return { table, options, cgroupReads: () => cgroupReads }
}

const inSession = (leaf: string): FakeProcess => ({
  cgroup: `0::/runners/${leaf}\n`,
  startTime: 10,
})

describe('createPinCache', () => {
  test('pin-before-file-event: a pinned short-lived pid resolves after it exits', () => {
    const proc = fakeProc({ 100: inSession('session-abc123') })
    const pins = createPinCache({ capacity: 8, ...proc.options })
    pins.pin(100) // perm event: opener blocked in open(2)
    proc.table.delete(100) // process exits before the async NOTIF delivery
    expect(pins.resolve(100)).toBe('session-abc123')
    expect(pins.misses()).toBe(0)
  })

  test('unpinned long-lived pid resolves via the live fallback and is then cached', () => {
    const proc = fakeProc({ 200: inSession('session-abc123') })
    const pins = createPinCache({ capacity: 8, ...proc.options })
    expect(pins.resolve(200)).toBe('session-abc123')
    const readsAfterFirst = proc.cgroupReads()
    expect(pins.resolve(200)).toBe('session-abc123')
    expect(proc.cgroupReads()).toBe(readsAfterFirst) // cache hit, no second /proc read
    expect(pins.misses()).toBe(0)
  })

  test('pid reuse: a recycled pid is pruned via start-time and re-read live', () => {
    const proc = fakeProc({ 300: { cgroup: '0::/runners/session-old1\n', startTime: 5 } })
    const pins = createPinCache({ capacity: 8, ...proc.options })
    pins.pin(300)
    expect(pins.isFresh(300)).toBe(true)
    // Same pid, different process: new start time, new cgroup.
    proc.table.set(300, { cgroup: '0::/runners/session-new2\n', startTime: 6 })
    expect(pins.isFresh(300)).toBe(false) // perm path falls through to re-pin
    pins.pin(300)
    expect(pins.resolve(300)).toBe('session-new2')
  })

  test('pid reuse detected at resolve time without an intervening pin', () => {
    const proc = fakeProc({ 310: { cgroup: '0::/runners/session-old1\n', startTime: 5 } })
    const pins = createPinCache({ capacity: 8, ...proc.options })
    pins.pin(310)
    proc.table.set(310, { cgroup: '0::/runners/session-new2\n', startTime: 9 })
    expect(pins.resolve(310)).toBe('session-new2')
  })

  test('retains the newest pins at capacity and evicts the oldest process identity', () => {
    const proc = fakeProc({
      1: inSession('session-first'),
      2: inSession('session-second'),
      3: inSession('session-third'),
    })
    const pins = createPinCache({ capacity: 2, ...proc.options })
    pins.pin(1)
    pins.pin(2)
    pins.pin(3)
    proc.table.clear()

    expect(pins.resolve(2)).toBe('session-second')
    expect(pins.resolve(3)).toBe('session-third')
    expect(pins.resolve(1)).toBeNull()
    expect(pins.misses()).toBe(1)
  })

  test('miss counting: unreadable /proc counts once per failed pin or resolve', () => {
    const proc = fakeProc({})
    const pins = createPinCache({ capacity: 8, ...proc.options })
    pins.pin(400) // opener vanished mid-handling (or /proc unreadable)
    expect(pins.misses()).toBe(1)
    expect(pins.resolve(401)).toBeNull() // dead, never pinned — the counted loss
    expect(pins.misses()).toBe(2)
  })

  test('a dead pid is negative-cached: one miss total, live reuse re-pins', () => {
    const proc = fakeProc({})
    const pins = createPinCache({ capacity: 8, ...proc.options })
    expect(pins.resolve(410)).toBeNull()
    expect(pins.resolve(410)).toBeNull() // second event of the same dead pid
    expect(pins.misses()).toBe(1)
    // The pid comes back as a live process: never "fresh", resolves live.
    proc.table.set(410, inSession('session-abc123'))
    expect(pins.isFresh(410)).toBe(false)
    expect(pins.resolve(410)).toBe('session-abc123')
    expect(pins.misses()).toBe(1)
  })

  test('non-session cgroups pin and resolve as unit null without counting a miss', () => {
    const proc = fakeProc({ 500: { cgroup: '0::/init.scope\n', startTime: 3 } })
    const pins = createPinCache({ capacity: 8, ...proc.options })
    pins.pin(500)
    expect(pins.resolve(500)).toBeNull()
    expect(pins.misses()).toBe(0)
  })

  test('seed: startup cgroup-scan members resolve even after exiting, canonical leaves only', () => {
    const proc = fakeProc({
      600: inSession('session-abc123'),
      601: { cgroup: 'never read', startTime: 4 },
    })
    const pins = createPinCache({ capacity: 8, ...proc.options })
    pins.seed(600, 'session-abc123')
    pins.seed(601, 'not-a-session-leaf')
    proc.table.delete(600)
    expect(pins.resolve(600)).toBe('session-abc123')
    expect(pins.resolve(601)).toBeNull()
    expect(pins.misses()).toBe(0)
  })
})

describe('unitForCgroupContent', () => {
  test('extracts a canonical session leaf from the unified hierarchy line', () => {
    expect(unitForCgroupContent('0::/runners/session-abc123\n')).toBe('session-abc123')
  })

  test('a nested descendant cgroup still attributes to its session leaf', () => {
    expect(unitForCgroupContent('0::/runners/session-abc123/worker\n')).toBe('session-abc123')
  })

  test('finds the unified line among legacy v1 lines', () => {
    const content = '12:cpu:/foo\n1:name=systemd:/bar\n0::/runners/session-x9\n'
    expect(unitForCgroupContent(content)).toBe('session-x9')
  })

  test.each([
    ['non-runners cgroup', '0::/init.scope\n'],
    ['runners root itself', '0::/runners\n'],
    ['non-canonical leaf (escape rules)', '0::/runners/session-A_zz\n'],
    ['legacy pid-named leaf', '0::/runners/31337\n'],
    ['no unified line', '12:cpu:/runners/session-abc123\n'],
    ['empty content', ''],
  ])('%s → null', (_name, content) => {
    expect(unitForCgroupContent(content)).toBeNull()
  })
})

describe('createHandlePathCache', () => {
  // A filesystem-wide FID mark is the only mark type FAN_REPORT_FID allows, so
  // the helper sees every read-close on the VM and discards the ones outside
  // the drive. Each discard used to cost an open_by_handle_at + readlink, which
  // is what kept an idle VM busy — the resolution must happen once per handle.
  test('resolves each distinct handle once no matter how often it recurs', () => {
    const resolved: string[] = []
    const cache = createHandlePathCache({
      capacity: 8,
      resolve: record => {
        resolved.push(record.handleKey)
        return `/opt/duet/${record.handleKey}`
      },
    })

    for (let turn = 0; turn < 2; turn += 1) {
      const records = [fidRecord('aa'), fidRecord('bb')]
      cache.fill(records)
      expect(records.map(record => record.objectPath)).toEqual(['/opt/duet/1:aa', '/opt/duet/1:bb'])
    }

    expect(resolved).toEqual(['1:aa', '1:bb'])
  })

  test('an unresolvable handle is remembered as unresolvable, not retried', () => {
    let calls = 0
    const cache = createHandlePathCache({
      capacity: 8,
      resolve: () => {
        calls += 1
        return null
      },
    })

    const first = [fidRecord('aa')]
    cache.fill(first)
    const second = [fidRecord('aa')]
    cache.fill(second)

    expect(first[0]?.objectPath).toBeUndefined()
    expect(second[0]?.objectPath).toBeUndefined()
    expect(calls).toBe(1)
  })

  test('a moved file re-resolves, and a moved directory drops every cached path', () => {
    const paths = new Map([
      ['1:aa', '/drive/before.txt'],
      ['1:dd', '/drive/dir'],
    ])
    const cache = createHandlePathCache({
      capacity: 8,
      resolve: record => paths.get(record.handleKey) ?? null,
    })
    cache.fill([fidRecord('aa'), fidRecord('dd')])

    paths.set('1:aa', '/drive/after.txt')
    cache.observe({ mask: FAN.MOVED_TO, records: [fidRecord('aa')] })
    const afterFileMove = [fidRecord('aa'), fidRecord('dd')]
    cache.fill(afterFileMove)
    // Only the renamed entry re-resolved; the untouched directory stayed cached.
    expect(afterFileMove.map(record => record.objectPath)).toEqual([
      '/drive/after.txt',
      '/drive/dir',
    ])

    // A directory move changes the path of everything beneath it, so nothing
    // cached can be trusted afterwards.
    paths.set('1:dd', '/drive/moved-dir')
    paths.set('1:aa', '/drive/moved-dir/after.txt')
    cache.observe({ mask: FAN.MOVED_TO | FAN.ONDIR, records: [fidRecord('dd')] })
    const afterDirMove = [fidRecord('aa'), fidRecord('dd')]
    cache.fill(afterDirMove)
    expect(afterDirMove.map(record => record.objectPath)).toEqual([
      '/drive/moved-dir/after.txt',
      '/drive/moved-dir',
    ])
  })

  test('the cache is bounded, evicting the oldest inserted handle even after a cache hit', () => {
    const resolved: string[] = []
    const cache = createHandlePathCache({
      capacity: 2,
      resolve: record => {
        resolved.push(record.handleKey)
        return `/drive/${record.handleKey}`
      },
    })

    cache.fill([fidRecord('aa'), fidRecord('bb')])
    cache.fill([fidRecord('aa')]) // a hit does not refresh insertion age
    cache.fill([fidRecord('cc')]) // evicts 'aa'
    cache.fill([fidRecord('bb'), fidRecord('cc')]) // both still cached
    cache.fill([fidRecord('aa')]) // re-resolved after eviction

    expect(resolved).toEqual(['1:aa', '1:bb', '1:cc', '1:aa'])
  })
})

function fidRecord(handleHex: string): FidRecord {
  const handle = Uint8Array.from(
    (handleHex.match(/../g) ?? []).map(byte => Number.parseInt(byte, 16)),
  )
  return {
    kind: 'fid',
    infoType: 1,
    fsid: [0, 0],
    handleType: 1,
    handle,
    handleKey: `1:${handleHex}`,
    name: null,
  }
}

describe('pollTimeoutMs', () => {
  // The event fds are all in the poll set, so a wake-up that finds nothing is
  // pure overhead: the only reason to stop blocking is the stats deadline.
  // Waking 20 times a second to discover that 5 seconds have not yet passed is
  // what made an idle helper cost measurable CPU.
  test('blocks until the stats deadline rather than a fixed slice', () => {
    expect(pollTimeoutMs(1_000, 1_000, 5_000)).toBe(5_000)
    expect(pollTimeoutMs(3_000, 1_000, 5_000)).toBe(3_000)
    expect(pollTimeoutMs(5_900, 1_000, 5_000)).toBe(100)
  })

  test('never blocks past a due or overdue deadline', () => {
    expect(pollTimeoutMs(6_000, 1_000, 5_000)).toBe(0)
    expect(pollTimeoutMs(9_999, 1_000, 5_000)).toBe(0)
  })
})
