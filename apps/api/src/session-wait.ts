import type { ConvexHttpClient } from 'convex/browser'

import type { SessionTimelineEntry } from '@repo/contract'

import type { GatewayClient } from './gateway/client'
import { fnQuery } from './shared'

export const SESSION_WAIT_TIMEOUT_MS = 720_000
export const SESSION_WAIT_RECONNECT_MS = 5_000

/**
 * The contract already owns this shape, and its `event` is a discriminated
 * union rather than `unknown` — which matters now that callers are told to read
 * `terminal.event.type === 'ask'` and reach for `terminal.event.questions`.
 */
export type SessionWaitTerminal = SessionTimelineEntry

export interface SessionWaitObserverInput {
  workspaceId: string
  sessionId: string
  inputSeq: number
  signal: AbortSignal
  deadlineAt: number
}

/**
 * The covering terminal plus the covered session's cwd. The cwd matters to
 * callers quoting the terminal result: any relative file path in it is
 * relative to that session's frame, not the caller's, so the observer hands
 * both back rather than making callers re-fetch the session.
 */
export interface SessionWaitCoveringTerminal {
  terminal: SessionWaitTerminal
  cwd?: string
}

export interface SessionWaitObserverDependencies {
  now(): number
  findCoveringTerminal(args: {
    workspaceId: string
    sessionId: string
    inputSeq: number
  }): Promise<SessionWaitCoveringTerminal | null>
  delay(ms: number, signal: AbortSignal): Promise<void>
  waitForLiveWake(args: {
    workspaceId: string
    sessionId: string
    inputSeq: number
    signal: AbortSignal
  }): Promise<'activity' | 'closed'>
}

export type SessionWaitObservation =
  | ({ status: 'completed' } & SessionWaitCoveringTerminal)
  | { status: 'pending' }

export function createSessionWaitDependencies(args: {
  convex: Pick<ConvexHttpClient, 'query'>
  internalKey: string
  gatewayClient: GatewayClient
  workspaceSlug: string
  now: () => number
}): SessionWaitObserverDependencies {
  return {
    now: args.now,
    delay: sessionWaitDelay,
    findCoveringTerminal: async input => {
      const row = (await args.convex.query(
        fnQuery('domains/agentSessions/model:findCoveringTerminal'),
        {
          internalKey: args.internalKey,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          inputSeq: input.inputSeq,
        },
      )) as (SessionWaitTerminal & { cwd?: string }) | null
      if (row === null) return null
      const { cwd, ...terminal } = row
      return { terminal, ...(cwd === undefined ? {} : { cwd }) }
    },
    waitForLiveWake: input =>
      args.gatewayClient.waitForAgentSessionActivity(
        args.workspaceSlug,
        input.sessionId,
        input.inputSeq,
        input.signal,
      ),
  }
}

export async function observeSessionWait(
  dependencies: SessionWaitObserverDependencies,
  input: SessionWaitObserverInput,
): Promise<SessionWaitObservation> {
  return await observeSessionWaitLoop(dependencies, input)
}

async function observeSessionWaitLoop(
  dependencies: SessionWaitObserverDependencies,
  input: SessionWaitObserverInput,
): Promise<SessionWaitObservation> {
  while (true) {
    input.signal.throwIfAborted()
    const covering = await dependencies.findCoveringTerminal(input)
    input.signal.throwIfAborted()
    if (covering !== null) return { status: 'completed', ...covering }

    const remainingMs = input.deadlineAt - dependencies.now()
    if (remainingMs <= 0) return { status: 'pending' }

    const cycle = new AbortController()
    const signal = AbortSignal.any([input.signal, cycle.signal])
    const live = dependencies.waitForLiveWake({ ...input, signal })
    const deadline = dependencies.delay(remainingMs, signal).then(() => 'deadline' as const)

    try {
      const wake = await Promise.race([live, deadline])
      if (wake !== 'closed') continue
    } finally {
      cycle.abort()
    }

    const retryMs = Math.min(SESSION_WAIT_RECONNECT_MS, input.deadlineAt - dependencies.now())
    if (retryMs > 0) await dependencies.delay(retryMs, input.signal)
  }
}

export async function sessionWaitDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
