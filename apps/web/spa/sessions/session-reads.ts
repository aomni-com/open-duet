'use client'

/* ============================================================================
   When an open session counts as read.

   Unread means *work that finished while you were away*. So presence, not
   mounting, is what clears it: an open tab behind three other windows is not
   someone reading, and a badge that cleared for a laptop left open overnight
   would be measuring nothing at all.

   That single sentence decides the whole shape:

   - **Every stamp is gated on `document.visibilityState`.** Not on permission,
     not on whether the query is enabled. `createSessionDetailRefreshSignal`
     next door gates on `canWrite` — a cache-scope and permission question — and
     is right to; this is a different question with the same shape, which is
     exactly why they are two functions rather than one with a flag.

   - **Coming back marks read.** A hidden tab holds its high-water mark and
     stamps it the moment the tab is looked at again. The alternative — waiting
     for the next event — leaves a session you are staring at marked unread
     until the agent happens to say something.

   - **There is no `pagehide` flush.** A tab being closed is the least reliable
     evidence of presence there is, and the backend's cursor is a maximum, so
     dropping the last mark costs one badge that clears on the next visit. A
     flush on the way out would instead mark read whatever was on screen when
     the laptop lid shut.

   The coalescing window is safe only because the wire write is a maximum:
   intermediates may be dropped freely, since the one that lands carries
   everything below it.
   ========================================================================= */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'

import { useSpa } from '../context'
import { commitSessionSummaryFields, findCachedSessionSummary } from './session-cache'

type TimerHandle = unknown

export type SessionReadSignal = {
  /** Report the highest event seq now on screen. Cheap; call it per frame. */
  observe: (seq: number) => void
  /**
   * Presence changed; the signal re-reads `isVisible` itself. On becoming
   * visible any held mark is stamped, on becoming hidden nothing is sent.
   */
  presenceChanged: () => void
  /** Drop timers. Does not stamp: see the `pagehide` note above. */
  dispose: () => void
}

export function createSessionReadSignal(args: {
  stamp: (seq: number) => void
  isVisible: () => boolean
  now?: () => number
  /* The timer seam is a plain token rather than `ReturnType<typeof setTimeout>`:
     that type is `Timeout` under Node's globals and `number` in a browser, and
     the signal only ever hands it back to the matching `clearTimer`. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  coalescingWindowMs?: number
}): SessionReadSignal {
  const now = args.now ?? Date.now
  const setTimer: (fn: () => void, ms: number) => TimerHandle = args.setTimer ?? setTimeout
  const clearTimer: (handle: TimerHandle) => void =
    args.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const coalescingWindowMs = args.coalescingWindowMs ?? 1_000

  /* The highest seq seen, and the highest already sent. Both are needed: the
     gap between them *is* the pending mark, and comparing them is what makes a
     repeated `observe` of an unchanged session free. */
  let observedSeq = 0
  let stampedSeq = 0
  let lastStampAt = Number.NEGATIVE_INFINITY
  let timer: TimerHandle | undefined

  const cancelTimer = () => {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }

  const send = () => {
    cancelTimer()
    if (observedSeq <= stampedSeq) return
    stampedSeq = observedSeq
    lastStampAt = now()
    args.stamp(stampedSeq)
  }

  /* Either send now or arm a timer for when the window closes. The trailing
     timer is what makes a burst of events end in a stamp rather than in a mark
     held until the next event — which, at the end of a turn, never comes. */
  const schedule = () => {
    if (!args.isVisible()) return
    if (observedSeq <= stampedSeq) return
    const waited = now() - lastStampAt
    if (waited >= coalescingWindowMs) {
      send()
      return
    }
    if (timer !== undefined) return
    timer = setTimer(() => {
      timer = undefined
      /* Presence is re-checked on the way out, not just on the way in: the tab
         may have been hidden during the window, and the stamp queued while
         someone was looking must not land after they left. */
      if (args.isVisible()) send()
    }, coalescingWindowMs - waited)
  }

  return {
    observe: seq => {
      if (seq <= observedSeq) return
      observedSeq = seq
      schedule()
    },
    presenceChanged: () => {
      if (!args.isVisible()) {
        /* Hidden: hold the mark rather than sending it. The timer goes with the
           presence — a stamp armed while visible must not fire into a hidden
           tab, which is the whole point of gating on presence at all. */
        cancelTimer()
        return
      }
      schedule()
    },
    dispose: cancelTimer,
  }
}

/**
 * The signal, bound to one session and to the browser's own idea of presence.
 *
 * There is exactly one caller — `useSessionDetail` — and that is not an
 * accident of where it was convenient to put it. Every conversation host
 * mounts the same detail hook, so a second call site would be a second
 * definition of "read".
 */
export function useSessionReadStamp(
  workspaceSlug: string,
  sessionId: string | undefined,
): (seq: number) => void {
  const { api } = useSpa()
  const queryClient = useQueryClient()
  const signalRef = useRef<SessionReadSignal>(undefined)

  useEffect(() => {
    if (sessionId === undefined) return
    const signal = createSessionReadSignal({
      /* Fire-and-forget. The cursor is a maximum, so a failed stamp costs one
         badge that clears next visit — worth far less than an error surfaced to
         someone who never asked for the request. */
      stamp: seq => {
        void api.markSessionRead(workspaceSlug, sessionId, seq).catch(() => {})
        /* The dot clears now, not on the next list fetch. Only `unread` is
           copied across — deliberately *not* `updatedAt`, or every list this
           row appears in would resort the moment someone looked at it. */
        const cached = findCachedSessionSummary(queryClient, workspaceSlug, sessionId)
        if (cached === undefined || !cached.unread) return
        commitSessionSummaryFields(queryClient, workspaceSlug, { ...cached, unread: false }, [
          'unread',
        ])
      },
      isVisible: () => document.visibilityState === 'visible',
    })
    signalRef.current = signal
    const onVisibility = () => signal.presenceChanged()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      /* No flush on the way out — see the header. Unmounting is not reading, and
         neither is the tab closing that usually causes it. */
      signal.dispose()
      signalRef.current = undefined
    }
  }, [api, queryClient, sessionId, workspaceSlug])

  return useCallback((seq: number) => signalRef.current?.observe(seq), [])
}
