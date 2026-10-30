'use client'

import { CircleNotch } from '@phosphor-icons/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { messageStack } from './message-stack'
import { SessionMessage, SessionTimeline } from './session-message'

export function historyContinuationState(input: {
  hasOlder: boolean
  isLoadingOlder: boolean
  loadOlderFailed: boolean
}): 'hidden' | 'available' | 'loading' | 'failed' {
  if (!input.hasOlder) return 'hidden'
  if (input.isLoadingOlder) return 'loading'
  return input.loadOlderFailed ? 'failed' : 'available'
}

export function timelineHasLeadingClip(scrollTop: number): boolean {
  return scrollTop > 1
}

/**
 * How close to the beginning the reader gets before the next page is fetched.
 * Roughly a screenful of runway, so history lands before the reader arrives.
 */
const historyTriggerDistance = 320

/**
 * A chat never asks to be continued. Scrolling back is the whole gesture:
 * history is fetched once the reader comes within a screenful of the
 * beginning — and only then. 'loading' is already fetching, and 'failed'
 * waits for the explicit retry rather than re-firing on every scroll event.
 *
 * Direction is what separates the reader's gesture from the timeline's own
 * housekeeping. Opening a chat scrolls to the live tail, and restoring the
 * reading position after a prepend scrolls back down again; both start at the
 * top and pass straight through the trigger zone on their way out of it. Only
 * movement *toward* the beginning is someone asking for more.
 */
export function reachesHistoryTrigger(input: {
  scrollTop: number
  previousScrollTop: number
  continuation: ReturnType<typeof historyContinuationState>
}): boolean {
  if (input.continuation !== 'available') return false
  if (input.scrollTop > historyTriggerDistance) return false
  return input.scrollTop < input.previousScrollTop
}

/**
 * History fetched with no gesture behind it, for the one reason that justifies
 * it: the reader cannot reach what is behind them.
 *
 * The empty transcript is the obvious way into that state — a latest page can
 * be all durable events (a rename, a participant joining) that project to no
 * message. But it is not the only way, and reading it as the whole rule left
 * the trap open one message short of closing. A long agent turn fills its page
 * with the agent's own work and pushes the prompt that started it onto the page
 * behind; what lands is a single message that does not fill the viewport. There
 * is then nothing to scroll, so no upward gesture exists to make, and the
 * reader is looking at an answer whose question they cannot ask for.
 *
 * So the question is whether the reader has a way back, and `canScrollBack` is
 * that question answered from the scroll element itself rather than from a
 * count of rows. It must be measured, never assumed: on the first frame the
 * virtualizer is still reporting estimated row heights, so a full transcript
 * can momentarily look unscrollable and every chat would quietly pay for a page
 * nobody asked for. Callers start it `true` and set it from real geometry after
 * layout, which makes "not measured yet" mean "do nothing".
 *
 * Once the reader *can* scroll back, reading on is theirs to start.
 */
export function historyNeedsUnpromptedPage(input: {
  visibleMessageCount: number
  canScrollBack: boolean
  continuation: ReturnType<typeof historyContinuationState>
}): boolean {
  if (input.continuation !== 'available') return false
  if (input.visibleMessageCount === 0) return true
  return !input.canScrollBack
}

type VirtualizedSessionTimelineProps = ComponentProps<typeof SessionTimeline> & {
  timelineLabel: string
  loadingEarlierLabel: string
  loadEarlierFailedLabel: string
  retryEarlierLabel: string
  hasOlder: boolean
  isLoadingOlder: boolean
  loadOlderFailed: boolean
  loadOlder?: () => Promise<void>
  /** Explicit user sends return to the live tail even when composed from history. */
  tailRevision?: number
  /** Keeps pagination mounted while an event-only page has no visible messages. */
  emptyState?: ReactNode
  className?: string
}

/**
 * The one scroll owner for every chat timeline.
 *
 * Messages stay in chronological DOM order. TanStack Virtual's end anchor
 * preserves the reader's position when older history is prepended and keeps a
 * streaming final message pinned only while the reader is already at the tail.
 *
 * Scrolling back is the only gesture history needs: the timeline fetches the
 * previous page as the reader approaches the beginning, so there is no button
 * asking a reader who is already reading to ask again.
 */
export function VirtualizedSessionTimeline({
  messages,
  timelineLabel,
  loadingEarlierLabel,
  loadEarlierFailedLabel,
  retryEarlierLabel,
  hasOlder,
  isLoadingOlder,
  loadOlderFailed,
  loadOlder,
  tailRevision = 0,
  emptyState,
  className,
  ...messageProps
}: VirtualizedSessionTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const continuation = historyContinuationState({ hasOlder, isLoadingOlder, loadOlderFailed })
  const showsFailedContinuation = continuation === 'failed' && loadOlder !== undefined
  const stacks = messageStack(messages)
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    // A ResizeObserver can report the first transcript measurement while
    // React is still committing the session. Let React schedule that update;
    // forcing it synchronously produces a dev-overlay error and buys us
    // nothing because direct DOM positioning already keeps rows stable.
    useFlushSync: false,
    estimateSize: () => 96,
    getItemKey: index => messages[index]!.id,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 6,
    directDomUpdates: true,
    // Top spacing belongs to the virtualizer so prepended history participates
    // in its anchor math. The measured final row is the only tail edge;
    // paddingEnd would give scrollToEnd() a competing destination.
    paddingStart: 12 + (continuation === 'hidden' ? 0 : 48),
  })

  useLayoutEffect(() => {
    const scrollToTail = () => {
      virtualizer.scrollToEnd()
    }
    scrollToTail()
    // A submitted answer can replace a tall question panel and append its
    // transcript row in the same commit. A first-render chat can likewise run
    // before the virtualizer has an element size. The next frame corrects both
    // cases after the browser and ResizeObserver have supplied real geometry.
    const frame = requestAnimationFrame(scrollToTail)
    return () => cancelAnimationFrame(frame)
  }, [tailRevision, virtualizer])

  // The parent hands down a fresh `loadOlder` closure every render; a ref keeps
  // the effect below keyed to what actually decides a fetch — the continuation
  // state and the page that just landed.
  const loadOlderRef = useRef(loadOlder)
  loadOlderRef.current = loadOlder

  // `loadOlder` is re-entrancy guarded at its source, so the scroll handler and
  // the effect below can both fire on the same arrival and still spend one
  // request. A rejection lands in `loadOlderFailed`, which disarms both until
  // the reader retries.
  const requestOlderHistory = () => void loadOlderRef.current?.().catch(() => {})

  const previousScrollTopRef = useRef(0)
  const reachForOlderHistory = (scrollElement: HTMLElement) => {
    const scrollTop = scrollElement.scrollTop
    const previousScrollTop = previousScrollTopRef.current
    previousScrollTopRef.current = scrollTop
    if (reachesHistoryTrigger({ scrollTop, previousScrollTop, continuation })) requestOlderHistory()
  }

  const visibleMessageCount = messages.length
  /* Whether the reader has anywhere to scroll back to, measured rather than
     inferred. `true` until the first measurement lands, so the frame where the
     virtualizer is still guessing row heights cannot be mistaken for a
     transcript with nothing behind it. */
  const [canScrollBack, setCanScrollBack] = useState(true)
  const totalSize = virtualizer.getTotalSize()
  useLayoutEffect(() => {
    const measure = () => {
      const scrollElement = scrollRef.current
      if (scrollElement === null) return
      setCanScrollBack(scrollElement.scrollHeight > scrollElement.clientHeight + 1)
    }
    // After the browser has laid the rows out — the same reason `scrollToTail`
    // waits a frame.
    const frame = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(frame)
  }, [totalSize, visibleMessageCount])
  useLayoutEffect(() => {
    // Each arriving page asks the same question again, so a run of pages the
    // reader cannot get behind is walked through rather than stopping at the
    // first one.
    if (historyNeedsUnpromptedPage({ visibleMessageCount, canScrollBack, continuation }))
      requestOlderHistory()
  }, [canScrollBack, continuation, visibleMessageCount])

  useLayoutEffect(() => {
    if (!showsFailedContinuation) return

    const revealHistoryAnchor = () => {
      const scrollElement = scrollRef.current
      if (!scrollElement) return

      const firstVisibleItem = virtualizer.getVirtualItemForOffset(scrollElement.scrollTop)
      if (firstVisibleItem === undefined || firstVisibleItem.start >= scrollElement.scrollTop)
        return

      // The retry band reduces the scroll viewport. Re-anchor the message that
      // spans its new leading edge so its first transcript part is readable.
      virtualizer.scrollToIndex(firstVisibleItem.index, { align: 'start' })
    }

    revealHistoryAnchor()
    const frame = requestAnimationFrame(revealHistoryAnchor)
    return () => cancelAnimationFrame(frame)
  }, [showsFailedContinuation, virtualizer])

  return (
    <div data-session-timeline-frame className="flex min-h-0 min-w-0 flex-1 flex-col">
      {showsFailedContinuation ? (
        <div
          role="alert"
          className="flex min-h-10 shrink-0 items-center justify-center gap-2 border-b bg-background px-3 text-xs"
        >
          <span className="text-muted-foreground">{loadEarlierFailedLabel}</span>
          <button
            type="button"
            onClick={() => void loadOlder().catch(() => {})}
            className="rounded-full border bg-background/95 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur hover:bg-muted"
          >
            {retryEarlierLabel}
          </button>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        role="log"
        aria-label={timelineLabel}
        aria-live="polite"
        data-virtualized-session-timeline
        data-virtualized-message-count={messages.length}
        data-has-older-messages={hasOlder}
        data-leading-clip="false"
        onScroll={event => {
          event.currentTarget.dataset.leadingClip = timelineHasLeadingClip(
            event.currentTarget.scrollTop,
          )
            ? 'true'
            : 'false'
          reachForOlderHistory(event.currentTarget)
        }}
        className={cn(
          'relative min-h-0 flex-1 scroll-pb-16 overflow-y-auto [overflow-anchor:none] [mask-image:linear-gradient(to_bottom,black_calc(100%-1rem),transparent)] data-[leading-clip=true]:[mask-image:linear-gradient(to_bottom,transparent,black_1rem,black_calc(100%-1rem),transparent)]',
          className,
        )}
      >
        {continuation === 'loading' ? (
          <div
            role="status"
            aria-label={loadingEarlierLabel}
            className="pointer-events-none absolute inset-x-0 top-3 flex h-8 items-center justify-center text-muted-foreground"
          >
            <CircleNotch aria-hidden className="size-4 animate-spin" />
          </div>
        ) : null}
        {messages.length === 0 ? (
          emptyState
        ) : (
          <div ref={virtualizer.containerRef} className="relative w-full">
            {virtualizer.getVirtualItems().map(virtualItem => {
              const message = messages[virtualItem.index]!
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  data-virtualized-message={message.id}
                  className="absolute left-0 top-0 w-full"
                >
                  <div
                    className={cn(
                      'mx-auto w-full min-w-0 max-w-4xl',
                      virtualItem.index === messages.length - 1 && 'pb-7',
                    )}
                  >
                    <SessionMessage
                      message={message}
                      stack={stacks[virtualItem.index]}
                      {...messageProps}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
