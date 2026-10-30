import { describe, expect, test } from 'bun:test'

import { HELPER_PROTOCOL_VERSION, encodeHelperCommand, type HelperEvent } from './helper-protocol'
import { createHelperSupervisor, type HelperChild, type SpawnHelper } from './helper-supervisor'

// ── A fake helper child the test drives: push stdout frames, record stdin
// writes and kill signals, and end (exit) on demand or on kill. ────────────
interface FakeChild {
  child: HelperChild
  argv: readonly string[]
  writes: string[]
  kills: string[]
  pushEvent(event: HelperEvent): void
  pushRaw(text: string): void
  failWrites(error: Error): void
  deferWrites(): (error: Error) => void
  end(): void
  exitedResolved(): boolean
}

function createFakeChild(argv: readonly string[]): FakeChild {
  const encoder = new TextEncoder()
  const writes: string[] = []
  const kills: string[] = []
  const queue: Uint8Array[] = []
  let notify: (() => void) | null = null
  let ended = false
  let writeError: Error | null = null
  let rejectWrite: ((error: Error) => void) | null = null
  let writeGate: Promise<void> | null = null
  let resolvedExit = false
  let resolveExit!: () => void
  const exited = new Promise<void>(resolve => {
    resolveExit = () => {
      resolvedExit = true
      resolve()
    }
  })
  const wake = (): void => {
    const n = notify
    notify = null
    n?.()
  }
  const end = (): void => {
    if (ended) return
    ended = true
    wake()
    resolveExit()
  }
  const stdout: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift() as Uint8Array
          continue
        }
        if (ended) return
        await new Promise<void>(resolve => {
          notify = resolve
        })
      }
    },
  }
  return {
    argv,
    writes,
    kills,
    child: {
      stdout,
      sendCommand: async frame => {
        if (writeGate !== null) await writeGate
        if (writeError !== null) throw writeError
        writes.push(frame)
        return { status: 'sent' }
      },
      kill: (signal = 'SIGTERM') => {
        kills.push(signal)
        end() // a real SIGTERM/SIGKILL terminates the helper
      },
      exited,
    },
    pushEvent: event => {
      queue.push(encoder.encode(`${JSON.stringify(event)}\n`))
      wake()
    },
    pushRaw: text => {
      queue.push(encoder.encode(text))
      wake()
    },
    failWrites: error => {
      writeError = error
    },
    deferWrites: () => {
      writeGate = new Promise<void>((_resolve, reject) => {
        rejectWrite = reject
      })
      return error => rejectWrite?.(error)
    },
    end,
    exitedResolved: () => resolvedExit,
  }
}

interface Harness {
  spawn: SpawnHelper
  children: FakeChild[]
  events: HelperEvent[]
  downs: number
  delays: number[]
}

function harness(): Harness {
  const children: FakeChild[] = []
  const h: Harness = {
    children,
    events: [],
    downs: 0,
    delays: [],
    spawn: argv => {
      const fake = createFakeChild(argv)
      children.push(fake)
      return fake.child
    },
  }
  return h
}

const READY: HelperEvent = { t: 'ready', pid: 999, protocol: HELPER_PROTOCOL_VERSION }

function nthChild(h: Harness, index: number): FakeChild {
  const fake = h.children[index]
  if (fake === undefined) throw new Error(`no fake child spawned at index ${index}`)
  return fake
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) return
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`waitFor timed out: ${label}`)
}

function makeSupervisor(h: Harness, overrides: Record<string, unknown> = {}) {
  return createHelperSupervisor({
    helperPath: '/opt/duet/current/helper.js',
    driveDir: '/home/exedev/drive',
    gatewayPid: 4242,
    bunPath: '/usr/bin/bun',
    spawn: h.spawn,
    onEvent: event => h.events.push(event),
    onDown: () => {
      h.downs += 1
    },
    delay: async ms => {
      h.delays.push(ms)
    },
    log: () => undefined,
    ...overrides,
  })
}

describe('helper supervisor', () => {
  test('spawns sudo -n bun with the release helper path, drive, and gateway pid', async () => {
    const h = harness()
    const sup = makeSupervisor(h)
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'first spawn')
    expect(nthChild(h, 0).argv).toEqual([
      'sudo',
      '-n',
      '/usr/bin/bun',
      '/opt/duet/current/helper.js',
      '/home/exedev/drive',
      '4242',
    ])
    nthChild(h, 0).pushEvent(READY)
    await started
    expect(sup.stats().running).toBe(true)
    await sup.stop()
  })

  test('start() resolves on ready and forwards fs/stats events, not ready', async () => {
    const h = harness()
    const sup = makeSupervisor(h)
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'spawn')
    nthChild(h, 0).pushEvent(READY)
    await started
    const fsEvent: HelperEvent = {
      t: 'fs',
      kind: 'write',
      path: 'a.txt',
      pid: 7,
      unit: 'session-x',
      at: 1,
    }
    const statsEvent: HelperEvent = { t: 'stats', overflow: 0, cgroupMisses: 2, at: 2 }
    nthChild(h, 0).pushEvent(fsEvent)
    nthChild(h, 0).pushEvent(statsEvent)
    await waitFor(() => h.events.length === 2, 'two forwarded events')
    expect(h.events).toEqual([fsEvent, statsEvent])
    await sup.stop()
  })

  test('protocol mismatch at ready fails loudly, kills the child, and does not restart', async () => {
    const h = harness()
    const sup = makeSupervisor(h)
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'spawn')
    nthChild(h, 0).pushEvent({ t: 'ready', pid: 1, protocol: HELPER_PROTOCOL_VERSION + 1 })
    await expect(started).rejects.toThrow(/protocol mismatch/)
    expect(nthChild(h, 0).kills.length).toBeGreaterThan(0)
    // Fatal: no respawn, and the down transition is reported once.
    await waitFor(() => h.downs === 1, 'onDown on fatal')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
    expect(h.children.length).toBe(1)
    expect(sup.stats().helperRestarts).toBe(0)
    await sup.stop()
  })

  test('restarts with bounded exponential backoff on unexpected exit', async () => {
    const h = harness()
    let readyTransitions = 0
    const sup = makeSupervisor(h, {
      backoff: { baseMs: 10, maxMs: 40 },
      onReady: () => {
        readyTransitions += 1
      },
    })
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'first spawn')
    nthChild(h, 0).pushEvent(READY)
    await started

    // Crash four times; backoff should climb 10, 20, 40, then cap at 40.
    for (let i = 0; i < 4; i += 1) {
      const index = i
      nthChild(h, index).end()
      await waitFor(() => h.children.length === index + 2, `respawn ${index + 1}`)
      nthChild(h, index + 1).pushEvent(READY)
    }
    await waitFor(() => readyTransitions === 5, 'ready after every restart')
    expect(h.delays).toEqual([10, 20, 40, 40])
    expect(sup.stats().helperRestarts).toBe(4)
    expect(readyTransitions).toBe(5)
    expect(h.downs).toBe(4)
    await sup.stop()
  })

  test('synchronous spawn throws keep backing off until a child starts', async () => {
    const h = harness()
    let spawnAttempts = 0
    const sup = makeSupervisor(h, {
      spawn: (argv: readonly string[]) => {
        spawnAttempts += 1
        if (spawnAttempts <= 2) throw new Error('spawn unavailable')
        return h.spawn(argv)
      },
      backoff: { baseMs: 10, maxMs: 40 },
    })

    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'child after spawn failures')
    nthChild(h, 0).pushEvent(READY)
    await started
    expect(spawnAttempts).toBe(3)
    expect(h.delays).toEqual([10, 20])
    expect(sup.stats().helperRestarts).toBe(2)
    await sup.stop()
  })

  test('suppress passes through to the running child and is re-applied on restart', async () => {
    const h = harness()
    const sup = makeSupervisor(h)
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'spawn')
    nthChild(h, 0).pushEvent(READY)
    await started

    sup.suppress(true)
    expect(nthChild(h, 0).writes).toContain(encodeHelperCommand({ t: 'suppress', on: true }))

    // Restart: the desired suppression state rides along to the fresh child.
    nthChild(h, 0).end()
    await waitFor(() => h.children.length === 2, 'respawn')
    nthChild(h, 1).pushEvent(READY)
    await waitFor(
      () => nthChild(h, 1).writes.includes(encodeHelperCommand({ t: 'suppress', on: true })),
      're-applied suppress',
    )
    await sup.stop()
  })

  test('suppress issued before ready still reaches the child once it is up', async () => {
    const h = harness()
    const sup = makeSupervisor(h)
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'spawn')
    sup.suppress(true) // stored desired state; re-applied on ready
    nthChild(h, 0).pushEvent(READY)
    await started
    expect(nthChild(h, 0).writes).toContain(encodeHelperCommand({ t: 'suppress', on: true }))
    await sup.stop()
  })

  test('excludePids passes through and is re-applied to a fresh child on restart', async () => {
    const h = harness()
    const sup = makeSupervisor(h)
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'spawn')
    nthChild(h, 0).pushEvent(READY)
    await started

    sup.excludePids([7788])
    expect(nthChild(h, 0).writes).toContain(
      encodeHelperCommand({ t: 'exclude-pids', pids: [7788] }),
    )

    // A daemon restart updates the set; the latest set rides along to the child.
    sup.excludePids([9900])
    nthChild(h, 0).end()
    await waitFor(() => h.children.length === 2, 'respawn')
    nthChild(h, 1).pushEvent(READY)
    await waitFor(
      () =>
        nthChild(h, 1).writes.includes(encodeHelperCommand({ t: 'exclude-pids', pids: [9900] })),
      're-applied exclude-pids',
    )
    await sup.stop()
  })

  test('an EPIPE while excluding pids degrades attribution and replays all desired state', async () => {
    const h = harness()
    const logs: Array<Record<string, unknown>> = []
    const sup = makeSupervisor(h, {
      log: (fields: Record<string, unknown>) => logs.push(fields),
    })
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'spawn')
    nthChild(h, 0).pushEvent(READY)
    await started
    sup.suppress(true)
    nthChild(h, 0).failWrites(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))

    expect(() => sup.excludePids([7788])).not.toThrow()
    await waitFor(() => sup.stats().helperRestarts === 1, 'restart after EPIPE')
    expect(logs).toContainEqual({ event: 'helper_write_failed', error: 'broken pipe' })
    expect(nthChild(h, 0).kills).toContain('SIGKILL')
    await waitFor(() => h.children.length === 2, 'replacement child')
    nthChild(h, 1).pushEvent(READY)
    await waitFor(
      () =>
        nthChild(h, 1).writes.includes(encodeHelperCommand({ t: 'suppress', on: true })) &&
        nthChild(h, 1).writes.includes(encodeHelperCommand({ t: 'exclude-pids', pids: [7788] })),
      'full desired state replay',
    )
    await sup.stop()
  })

  test('an EPIPE during ready replay restarts silently and the next child gets all desired state', async () => {
    const h = harness()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const sup = makeSupervisor(h)
    try {
      sup.suppress(true)
      sup.excludePids([7788])
      const started = sup.start()
      await waitFor(() => h.children.length === 1, 'spawn')
      nthChild(h, 0).failWrites(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
      nthChild(h, 0).pushEvent(READY)

      await waitFor(() => sup.stats().helperRestarts === 1, 'restart after ready replay EPIPE')
      await waitFor(() => h.children.length === 2, 'replacement child')
      nthChild(h, 1).pushEvent(READY)
      await started
      expect(nthChild(h, 1).writes).toEqual([
        encodeHelperCommand({ t: 'suppress', on: true }),
        encodeHelperCommand({ t: 'exclude-pids', pids: [7788] }),
      ])
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await sup.stop()
    }
  })

  test('a late write failure from an old child cannot mark its replacement down', async () => {
    const h = harness()
    const sup = makeSupervisor(h)
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'spawn')
    nthChild(h, 0).pushEvent(READY)
    await started

    const rejectOldWrite = nthChild(h, 0).deferWrites()
    sup.excludePids([7788])
    nthChild(h, 0).end()
    await waitFor(() => h.children.length === 2, 'replacement child')
    nthChild(h, 1).pushEvent(READY)
    await waitFor(() => sup.stats().running, 'replacement ready')

    rejectOldWrite(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(sup.stats().running).toBe(true)
    expect(nthChild(h, 0).kills).toEqual([])
    await sup.stop()
  })

  test('excludePids issued before ready still reaches the child once it is up', async () => {
    const h = harness()
    const sup = makeSupervisor(h)
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'spawn')
    sup.excludePids([4242])
    nthChild(h, 0).pushEvent(READY)
    await started
    expect(nthChild(h, 0).writes).toContain(
      encodeHelperCommand({ t: 'exclude-pids', pids: [4242] }),
    )
    await sup.stop()
  })

  test('Syncthing pid refresh survives a transient discovery failure without clearing the known pid', async () => {
    const h = harness()
    const logs: Array<Record<string, unknown>> = []
    let discoveryAttempt = 0
    const resumeDelays: Array<() => void> = []
    const sup = makeSupervisor(h, {
      spawn: (argv: readonly string[]) => {
        if (argv[0] !== 'systemctl') return h.spawn(argv)
        discoveryAttempt += 1
        const fake = createFakeChild(argv)
        fake.pushRaw(discoveryAttempt === 1 ? '7788\n' : discoveryAttempt === 2 ? '' : '9900\n')
        fake.end()
        return fake.child
      },
      delay: () =>
        new Promise<void>(resolve => {
          resumeDelays.push(resolve)
        }),
      log: (fields: Record<string, unknown>) => logs.push(fields),
    })

    const started = sup.startWithSyncthingPidRefresh()
    await waitFor(() => h.children.length === 1, 'helper spawn')
    nthChild(h, 0).pushEvent(READY)
    await started
    await waitFor(
      () =>
        nthChild(h, 0).writes.includes(encodeHelperCommand({ t: 'exclude-pids', pids: [7788] })),
      'initial Syncthing pid exclusion',
    )

    resumeDelays.shift()?.()
    await waitFor(() => discoveryAttempt === 2, 'failed discovery')
    expect(logs.some(fields => fields.event === 'syncthing_pid_refresh_failed')).toBe(true)
    expect(nthChild(h, 0).writes).not.toContain(
      encodeHelperCommand({ t: 'exclude-pids', pids: [] }),
    )

    resumeDelays.shift()?.()
    await waitFor(
      () =>
        nthChild(h, 0).writes.includes(encodeHelperCommand({ t: 'exclude-pids', pids: [9900] })),
      'recovered Syncthing pid exclusion',
    )
    await sup.stop()
  })

  test('Syncthing pid refresh failure is contained without an unhandled rejection', async () => {
    const h = harness()
    const logs: Array<Record<string, unknown>> = []
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const sup = makeSupervisor(h, {
      spawn: (argv: readonly string[]) => {
        if (argv[0] !== 'systemctl') return h.spawn(argv)
        const fake = createFakeChild(argv)
        fake.pushRaw('7788\n')
        fake.end()
        return fake.child
      },
      delay: async () => {
        throw new Error('refresh timer failed')
      },
      log: (fields: Record<string, unknown>) => logs.push(fields),
    })
    try {
      const started = sup.startWithSyncthingPidRefresh()
      await waitFor(() => h.children.length === 1, 'helper spawn')
      nthChild(h, 0).pushEvent(READY)
      await started
      await waitFor(
        () => logs.some(fields => fields.event === 'syncthing_pid_refresh_failed'),
        'contained refresh failure log',
      )
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await sup.stop()
    }
  })

  test('counts malformed frames without dropping the surrounding valid events', async () => {
    const h = harness()
    const sup = makeSupervisor(h)
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'spawn')
    nthChild(h, 0).pushEvent(READY)
    await started

    nthChild(h, 0).pushRaw('not json at all\n')
    nthChild(h, 0).pushRaw('{"t":"fs","kind":"chmod"}\n') // unknown kind → null
    const good: HelperEvent = { t: 'fs', kind: 'read', path: 'b', pid: 3, unit: null, at: 9 }
    nthChild(h, 0).pushEvent(good)
    await waitFor(() => h.events.length === 1, 'valid event after malformed')
    expect(h.events).toEqual([good])
    expect(sup.stats().malformedFrames).toBe(2)
    await sup.stop()
  })

  test('holds the stdin pipe open for the child lifetime — writes land, no EOF/kill until stop', async () => {
    const h = harness()
    const sup = makeSupervisor(h)
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'spawn')
    nthChild(h, 0).pushEvent(READY)
    await started

    sup.suppress(false)
    sup.suppress(true)
    // The child is still alive: the supervisor never closed stdin or killed it.
    expect(nthChild(h, 0).exitedResolved()).toBe(false)
    expect(nthChild(h, 0).kills).toEqual([])
    expect(nthChild(h, 0).writes).toEqual([
      encodeHelperCommand({ t: 'suppress', on: false }),
      encodeHelperCommand({ t: 'suppress', on: true }),
    ])
    await sup.stop()
    // Only stop() terminates the child.
    expect(nthChild(h, 0).kills).toEqual(['SIGTERM'])
    expect(nthChild(h, 0).exitedResolved()).toBe(true)
  })

  test('stop() kills the child, stops restarting, and leaves running=false', async () => {
    const h = harness()
    const sup = makeSupervisor(h)
    const started = sup.start()
    await waitFor(() => h.children.length === 1, 'spawn')
    nthChild(h, 0).pushEvent(READY)
    await started

    await sup.stop()
    expect(sup.stats().running).toBe(false)
    expect(nthChild(h, 0).kills).toEqual(['SIGTERM'])
    // No restart after an intentional stop.
    await new Promise<void>(resolve => setTimeout(resolve, 5))
    expect(h.children.length).toBe(1)
    expect(sup.stats().helperRestarts).toBe(0)
    expect(h.downs).toBe(0)
  })
})
