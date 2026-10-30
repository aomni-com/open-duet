import { expect, test } from 'bun:test'

import { BROWSER_STACK_RETENTION_MS, DESKTOP_BROWSER_UNIT } from '@repo/contract'

import {
  createDesktopSupervisor,
  DESKTOP_REAP_GRACE_MS,
  DESKTOP_STOP_BROWSER_ARGV,
  DESKTOP_START_BACKOFF_MAX_MS,
  DESKTOP_TICK_MS,
} from './supervisor'

test('concurrent desktop requests start one target and expose one shared phase', async () => {
  const calls: string[][] = []
  let releaseStart: (() => void) | undefined
  const startBlocked = new Promise<void>(resolve => (releaseStart = resolve))
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      calls.push(argv)
      if (argv.includes('start')) await startBlocked
      return { exitCode: 0 }
    },
    hasLiveAgentRunners: () => false,
    now: () => 1_000,
    log: () => undefined,
  })

  expect(supervisor.phase()).toBe('stopped')
  const first = supervisor.ensureStarted()
  const second = supervisor.ensureStarted()
  expect(supervisor.phase()).toBe('starting')
  releaseStart?.()

  expect(await Promise.all([first, second])).toEqual(['ready', 'ready'])
  expect(calls).toEqual([['sudo', '-n', 'systemctl', 'start', 'duet-desktop.target']])
  expect(supervisor.phase()).toBe('ready')
})

test('maintenance waits for an in-flight desktop start before entering', async () => {
  let releaseStart: (() => void) | undefined
  const startBlocked = new Promise<void>(resolve => (releaseStart = resolve))
  const entered: string[] = []
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      if (argv.includes('start')) await startBlocked
      return { exitCode: 0 }
    },
    hasLiveAgentRunners: () => false,
  })

  const start = supervisor.ensureStarted()
  const maintenance = supervisor.runMaintenance(async () => {
    entered.push('maintenance')
  })
  await Promise.resolve()
  expect(entered).toEqual([])
  releaseStart?.()
  await Promise.all([start, maintenance])
  expect(entered).toEqual(['maintenance'])
})

test('a failed target start restores stopped and surfaces the command failure', async () => {
  const logs: Array<Record<string, unknown>> = []
  const supervisor = createDesktopSupervisor({
    runCommand: async () => ({ exitCode: 5 }),
    hasLiveAgentRunners: () => false,
    now: () => 0,
    log: fields => logs.push(fields),
  })

  await expect(supervisor.ensureStarted()).rejects.toThrow('desktop target start failed')
  expect(supervisor.phase()).toBe('stopped')
  expect(logs).toContainEqual({
    operation: 'start',
    status: 'failed',
    error: 'desktop target start failed with exit code 5',
    // Carried so a VM stuck in this state is diagnosable from the log alone —
    // the count is what distinguishes one bad start from a wedged target.
    consecutiveFailures: 1,
    backoffMs: 5_000,
  })
})

test('a maintenance gate refuses a new desktop start without running systemd', async () => {
  const calls: string[][] = []
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      calls.push(argv)
      return { exitCode: 0 }
    },
    hasLiveAgentRunners: () => false,
    isStartBlocked: () => true,
  })

  await expect(supervisor.ensureStarted()).rejects.toThrow('desktop start blocked for maintenance')
  expect(calls).toEqual([])
  expect(supervisor.phase()).toBe('stopped')
})

test('concurrent failed requests share one in-flight start attempt', async () => {
  // Counts starts, not commands: a failed start also stops the browser unit,
  // and the claim here is about attempts being shared, not about how many
  // systemctl calls one attempt makes.
  let starts = 0
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      if (argv.includes('start')) starts += 1
      return { exitCode: 5 }
    },
    hasLiveAgentRunners: () => false,
  })

  const first = supervisor.ensureStarted()
  const second = supervisor.ensureStarted()
  await Promise.allSettled([first, second])

  expect(starts).toBe(1)
  expect(supervisor.phase()).toBe('stopped')
})

test('viewer presence is exactly-once and protects the target from reaping', async () => {
  let now = 0
  const calls: string[][] = []
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      calls.push(argv)
      return { exitCode: 0 }
    },
    hasLiveAgentRunners: () => false,
    now: () => now,
    log: () => undefined,
  })
  await supervisor.ensureStarted()
  const detach = supervisor.viewerAttached()
  expect(supervisor.viewerCount()).toBe(1)

  now = DESKTOP_REAP_GRACE_MS + 1
  await supervisor.tick()
  expect(calls.some(argv => argv.includes('stop'))).toBe(false)

  detach()
  detach()
  expect(supervisor.viewerCount()).toBe(0)
  await supervisor.tick()
  expect(calls.at(-1)).toEqual(['sudo', '-n', 'systemctl', 'stop', 'duet-desktop.target'])
  expect(supervisor.phase()).toBe('stopped')
})

test('the grace window bridges a desktop request to its first viewer', async () => {
  let now = 10_000
  const calls: string[][] = []
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      calls.push(argv)
      return { exitCode: 0 }
    },
    hasLiveAgentRunners: () => false,
    now: () => now,
    log: () => undefined,
  })
  await supervisor.ensureStarted()

  now += DESKTOP_REAP_GRACE_MS
  await supervisor.tick()
  expect(calls.some(argv => argv.includes('stop'))).toBe(false)

  now += 1
  await supervisor.tick()
  expect(calls.some(argv => argv.includes('stop'))).toBe(true)
})

test('a live agent starts and holds the desktop without inventing another session count', async () => {
  let live = true
  let now = 0
  let active = false
  const calls: string[][] = []
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      calls.push(argv)
      if (argv.includes('start')) active = true
      if (argv.includes('stop')) active = false
      return { exitCode: argv.includes('is-active') && !active ? 3 : 0 }
    },
    hasLiveAgentRunners: () => live,
    now: () => now,
    log: () => undefined,
  })

  await supervisor.tick()
  expect(calls.at(-1)).toEqual(['sudo', '-n', 'systemctl', 'start', 'duet-desktop.target'])
  expect(supervisor.phase()).toBe('ready')

  live = false
  now = DESKTOP_REAP_GRACE_MS + 1
  await supervisor.tick()
  expect(calls.at(-1)).toEqual(['sudo', '-n', 'systemctl', 'stop', 'duet-desktop.target'])
})

test('viewer and agent demand independently keep the desktop alive', async () => {
  let live = true
  let now = 0
  let active = false
  const calls: string[][] = []
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      calls.push(argv)
      if (argv.includes('start')) active = true
      if (argv.includes('stop')) active = false
      return { exitCode: argv.includes('is-active') && !active ? 3 : 0 }
    },
    hasLiveAgentRunners: () => live,
    now: () => now,
    log: () => undefined,
  })

  await supervisor.tick()
  const detach = supervisor.viewerAttached()
  now = DESKTOP_REAP_GRACE_MS + 1

  // Specifically the target: a browser stop can also appear here, reconciling
  // Chrome against a target that is not up yet, and that is not this claim.
  const stoppedTarget = () =>
    calls.some(argv => argv.includes('stop') && argv.includes('duet-desktop.target'))

  live = false
  await supervisor.tick()
  expect(stoppedTarget()).toBe(false)

  live = true
  detach()
  await supervisor.tick()
  expect(stoppedTarget()).toBe(false)

  live = false
  await supervisor.tick()
  expect(calls.at(-1)).toEqual(['sudo', '-n', 'systemctl', 'stop', 'duet-desktop.target'])
})

test('the first tick reaps an orphan target left active across a gateway restart', async () => {
  const calls: string[][] = []
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      calls.push(argv)
      return { exitCode: 0 }
    },
    hasLiveAgentRunners: () => false,
    now: () => 10,
    log: () => undefined,
  })

  await supervisor.tick()
  expect(supervisor.phase()).toBe('stopped')
  expect(calls).toEqual([
    ['sudo', '-n', 'systemctl', 'is-active', 'duet-desktop.target'],
    ['sudo', '-n', 'systemctl', 'stop', 'duet-desktop.target'],
  ])
})

test('persisted browser activity retains the stack for 24 hours and reaps just after', async () => {
  let now = BROWSER_STACK_RETENTION_MS
  const calls: string[][] = []
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      calls.push(argv)
      return { exitCode: 0 }
    },
    hasLiveAgentRunners: () => false,
    lastBrowserActivityAt: () => 0,
    now: () => now,
  })

  await supervisor.tick()
  expect(calls.some(argv => argv.includes('stop'))).toBe(false)
  now += 1
  await supervisor.tick()
  expect(calls.at(-1)).toEqual(['sudo', '-n', 'systemctl', 'stop', 'duet-desktop.target'])
})

test('a target that will not start is retried on a widening backoff, not every tick', async () => {
  // The shape this exists for: a full root disk makes the target's Chrome unit
  // fail every time, and a live runner asks for the desktop on every tick. The
  // old loop spent ~0.1 vCPU per VM on that, indefinitely.
  const starts: number[] = []
  let clock = 0
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      if (argv.includes('start')) {
        starts.push(clock)
        return { exitCode: 1 }
      }
      return { exitCode: 3 } // is-active: not active
    },
    hasLiveAgentRunners: () => true,
    now: () => clock,
    log: () => undefined,
  })

  for (; clock <= 2 * 60 * 60_000; clock += DESKTOP_TICK_MS) await supervisor.tick()

  // Two hours of ticks is 1440 start attempts without a backoff.
  expect(starts.length).toBeLessThan(40)
  const gaps = starts.slice(1).map((at, index) => at - starts[index]!)
  expect(gaps[0]).toBeGreaterThanOrEqual(DESKTOP_TICK_MS)
  expect(gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1]!)).toBe(true)
  expect(gaps.at(-1)).toBe(DESKTOP_START_BACKOFF_MAX_MS)
})

test('every start reaps leaked Chrome metrics first, so a full-disk workspace heals itself', async () => {
  // The self-heal: a workspace whose disk the leak filled cannot start Chrome
  // at all, so the reap has to come before the start that it unblocks — and on
  // the first start after a gateway release, without an operator.
  const order: string[] = []
  let diskFull = true
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      if (argv.includes('start')) {
        order.push('start')
        return { exitCode: diskFull ? 1 : 0 }
      }
      return { exitCode: 3 }
    },
    reapBrowserMetrics: async () => {
      order.push('reap')
      diskFull = false
      return { deleted: 4_840, failed: 0 }
    },
    hasLiveAgentRunners: () => true,
    now: () => 0,
    log: () => undefined,
  })

  expect(await supervisor.ensureStarted()).toBe('ready')
  expect(order).toEqual(['reap', 'start'])
})

test('a reap that cannot run does not stop the desktop from starting', async () => {
  const supervisor = createDesktopSupervisor({
    runCommand: async () => ({ exitCode: 0 }),
    reapBrowserMetrics: async () => {
      throw new Error('EROFS: read-only file system')
    },
    hasLiveAgentRunners: () => false,
    now: () => 0,
    log: () => undefined,
  })

  expect(await supervisor.ensureStarted()).toBe('ready')
})

test('a failed start stops the browser unit, so systemd stops relaunching it too', async () => {
  // The gateway backing off is only half the loop: duet-desktop-browser.service
  // is Restart=always on a one-second timer with no start limit, so a Chrome
  // that cannot start is relaunched every second in the gap we just opened.
  const argvs: string[][] = []
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      argvs.push(argv)
      if (argv.includes('is-active')) return { exitCode: 3 }
      return { exitCode: argv.includes('start') ? 1 : 0 }
    },
    hasLiveAgentRunners: () => true,
    now: () => 0,
    log: () => undefined,
  })

  await supervisor.tick()

  expect(argvs.at(-1)).toEqual(DESKTOP_STOP_BROWSER_ARGV)
  // Only the permissions the shipped image already grants: `stop` on this unit
  // is in the sudoers, so this needs no image rebuild to take effect.
  expect(DESKTOP_STOP_BROWSER_ARGV).toEqual([
    'sudo',
    '-n',
    'systemctl',
    'stop',
    'duet-desktop-browser.service',
  ])
})

test('Chrome is never left running once the desktop target is down', async () => {
  // duet-desktop.target only `Wants` the browser unit, so systemd starts Chrome
  // even when KasmVNC failed — Chrome then cannot reach DISPLAY=:1, dies, and
  // Restart=always relaunches it every second. That, not the supervisor, is
  // what leaked a 4 MiB metrics file per second until the disk was full.
  const argvs: string[][] = []
  let targetActive = false
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      argvs.push(argv)
      if (argv.includes('is-active')) return { exitCode: targetActive ? 0 : 3 }
      return { exitCode: 0 }
    },
    hasLiveAgentRunners: () => false,
    now: () => 0,
    log: () => undefined,
  })

  await supervisor.tick()
  const stops = argvs.filter(argv => argv.includes(DESKTOP_BROWSER_UNIT))
  expect(stops).toEqual([DESKTOP_STOP_BROWSER_ARGV])

  // Once reconciled it stays quiet: a stop per tick would be 12 needless sudo
  // calls a minute on every idle workspace in the fleet.
  await supervisor.tick()
  await supervisor.tick()
  expect(argvs.filter(argv => argv.includes(DESKTOP_BROWSER_UNIT))).toHaveLength(1)

  // A target that comes up and goes down again is reconciled afresh.
  targetActive = true
  await supervisor.tick()
  targetActive = false
  await supervisor.tick()
  expect(argvs.filter(argv => argv.includes(DESKTOP_BROWSER_UNIT))).toHaveLength(2)
})

test('a start clears an orphaned display lock before attempting', async () => {
  const order: string[] = []
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      if (argv.includes('start')) order.push('start')
      return { exitCode: 0 }
    },
    clearStaleDisplayLock: async () => {
      order.push('clear-lock')
      return true
    },
    hasLiveAgentRunners: () => false,
    now: () => 0,
    log: () => undefined,
  })

  expect(await supervisor.ensureStarted()).toBe('ready')
  expect(order).toEqual(['clear-lock', 'start'])
})

test('the backoff clears once the target comes up, and a request still tries during one', async () => {
  const starts: number[] = []
  let clock = 0
  let targetCanStart = false
  const supervisor = createDesktopSupervisor({
    runCommand: async argv => {
      if (argv.includes('start')) {
        starts.push(clock)
        return { exitCode: targetCanStart ? 0 : 1 }
      }
      return { exitCode: 3 }
    },
    hasLiveAgentRunners: () => true,
    now: () => clock,
    log: () => undefined,
  })

  for (; clock <= 30 * 60_000; clock += DESKTOP_TICK_MS) await supervisor.tick()
  const whileFailing = starts.length

  // Someone actually asking for the desktop mid-backoff is a real demand, not
  // unattended supervision, so it attempts rather than being suppressed.
  await expect(supervisor.ensureStarted()).rejects.toThrow('desktop target start failed')
  expect(starts.length).toBe(whileFailing + 1)

  // The disk gets freed: recovery is automatic, within one backoff window.
  targetCanStart = true
  for (let end = clock + DESKTOP_START_BACKOFF_MAX_MS; clock <= end; clock += DESKTOP_TICK_MS) {
    await supervisor.tick()
  }
  expect(supervisor.phase()).toBe('ready')

  // A later failure starts over at one tick rather than inheriting the ceiling.
  targetCanStart = false
  const recovered = starts.length
  await supervisor.tick()
  expect(starts.length).toBe(recovered + 1)
  clock += DESKTOP_TICK_MS
  await supervisor.tick()
  expect(starts.length).toBe(recovered + 2)
})
