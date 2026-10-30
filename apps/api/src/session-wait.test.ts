import { describe, expect, test } from 'bun:test'

import {
  observeSessionWait,
  sessionWaitDelay,
  SESSION_WAIT_RECONNECT_MS,
  SESSION_WAIT_TIMEOUT_MS,
  type SessionWaitCoveringTerminal,
  type SessionWaitObserverDependencies,
  type SessionWaitTerminal,
} from './session-wait'

const terminal: SessionWaitTerminal = {
  seq: 7,
  createdAt: 5_000,
  event: { type: 'complete', status: 'completed', result: 'done' },
}

describe('foreground session wait observer', () => {
  test('an immediate durable terminal completes without attaching live', async () => {
    let liveAttaches = 0
    const deps = fakeDependencies({
      terminals: [{ terminal, cwd: 'agents/growth' }],
      waitForLiveWake: async () => {
        liveAttaches += 1
        return 'activity'
      },
    })

    await expect(observeSessionWait(deps, waitInput())).resolves.toEqual({
      status: 'completed',
      terminal,
      cwd: 'agents/growth',
    })
    expect(liveAttaches).toBe(0)
    expect(deps.queryCount()).toBe(1)
  })

  test('a live frame only nudges a second durable query', async () => {
    const deps = fakeDependencies({
      terminals: [null, { terminal }],
      waitForLiveWake: async () => 'activity',
    })

    await expect(observeSessionWait(deps, waitInput())).resolves.toEqual({
      status: 'completed',
      terminal,
    })
    expect(deps.queryCount()).toBe(2)
    expect(deps.delayCount()).toBe(1)
    expect(deps.delayDurations()).toEqual([SESSION_WAIT_TIMEOUT_MS])
  })

  test('closed or unavailable live streams use reconnect backoff', async () => {
    const deps = fakeDependencies({
      terminals: [null, null, { terminal }],
      waitForLiveWake: async () => 'closed',
    })

    await expect(observeSessionWait(deps, waitInput())).resolves.toEqual({
      status: 'completed',
      terminal,
    })
    expect(deps.queryCount()).toBe(3)
    expect(deps.delayCount()).toBe(4)
    expect(deps.now()).toBe(SESSION_WAIT_RECONNECT_MS * 2)
  })

  test('the configured deadline returns pending with bounded durable checks', async () => {
    const deps = fakeDependencies({ terminals: [] })

    await expect(observeSessionWait(deps, waitInput())).resolves.toEqual({ status: 'pending' })
    expect(deps.now()).toBe(SESSION_WAIT_TIMEOUT_MS)
    expect(deps.queryCount()).toBe(2)
    expect(deps.delayDurations()).toEqual([SESSION_WAIT_TIMEOUT_MS])
  })

  test('request abort closes observer-owned waits without a durable mutation seam', async () => {
    const controller = new AbortController()
    let liveSignal: AbortSignal | undefined
    let delaySignal: AbortSignal | undefined
    const never = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    const deps: SessionWaitObserverDependencies = {
      now: () => 0,
      findCoveringTerminal: async () => null,
      delay: async (_ms, signal) => {
        delaySignal = signal
        return await never(signal)
      },
      waitForLiveWake: async ({ signal }) => {
        liveSignal = signal
        return await never(signal)
      },
    }

    const observed = observeSessionWait(deps, waitInput(controller.signal))
    await Promise.resolve()
    controller.abort()

    await expect(observed).rejects.toMatchObject({ name: 'AbortError' })
    expect(delaySignal?.aborted).toBe(true)
    expect(liveSignal?.aborted).toBe(true)
  })

  test('the production delay releases immediately on abort', async () => {
    const controller = new AbortController()
    const delayed = sessionWaitDelay(SESSION_WAIT_TIMEOUT_MS, controller.signal)
    controller.abort()

    await expect(delayed).rejects.toMatchObject({ name: 'AbortError' })
  })
})

function waitInput(signal: AbortSignal = new AbortController().signal) {
  return {
    workspaceId: 'workspace_1',
    sessionId: 'session_1',
    inputSeq: 2,
    signal,
    deadlineAt: SESSION_WAIT_TIMEOUT_MS,
  }
}

function fakeDependencies(options: {
  terminals: Array<SessionWaitCoveringTerminal | null>
  waitForLiveWake?: SessionWaitObserverDependencies['waitForLiveWake']
  deadlineExpires?: boolean
}) {
  let now = 0
  let queries = 0
  let delays = 0
  const delayDurations: number[] = []
  const deps: SessionWaitObserverDependencies & {
    queryCount(): number
    delayCount(): number
    delayDurations(): number[]
  } = {
    now: () => now,
    findCoveringTerminal: async () => options.terminals[queries++] ?? null,
    delay: async (ms, signal) => {
      if (signal.aborted) throw signal.reason
      delays += 1
      delayDurations.push(ms)
      const deadlineExpires = options.deadlineExpires ?? options.waitForLiveWake === undefined
      if (ms > SESSION_WAIT_RECONNECT_MS && !deadlineExpires) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      now += ms
    },
    waitForLiveWake:
      options.waitForLiveWake ??
      (async ({ signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        return 'closed'
      }),
    queryCount: () => queries,
    delayCount: () => delays,
    delayDurations: () => delayDurations,
  }
  return deps
}
