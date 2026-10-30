'use client'

import { CircleNotch, WarningCircle } from '@phosphor-icons/react'
import { useEffect, useRef } from 'react'

import { cn } from '@repo/ui/lib/utils'

import type { ComposeBarSuggestion } from './compose-bar-mention-extension'
import type { ComposeBarPickerContinuation, ComposeBarPickerLabels } from './types'

/**
 * The list a trigger opens, above the composer.
 *
 * It renders outside the compose surface because that surface clips its own
 * overflow; anchoring to the surface's full width instead of the caret keeps
 * the popup inside the conversation column on every viewport, which a
 * caret-anchored popup does not at the right edge of a narrow phone.
 *
 * Selection is displayed, never owned — the editor's suggestion plugin sees
 * the arrow keys first, so this component reports clicks and draws whatever
 * index it is handed.
 */
export function ComposeBarMentionPicker({
  suggestion,
  labels,
  loading,
  unavailable = false,
  continuation,
}: {
  suggestion: ComposeBarSuggestion
  labels: ComposeBarPickerLabels
  loading: boolean
  unavailable?: boolean
  continuation?: ComposeBarPickerContinuation
}) {
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [suggestion.activeIndex])

  return (
    <div
      data-compose-bar-picker={suggestion.trigger}
      className="absolute bottom-full left-0 z-30 mb-1.5 w-full overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
    >
      {suggestion.items.length === 0 ? (
        // An unreachable workspace is not an empty one, and different words are
        // not a different state: a reader scanning past the text has to be able
        // to see that one of these is a problem and the other is an answer.
        <p
          role={unavailable && !loading ? 'alert' : undefined}
          className={cn(
            'flex items-center justify-center gap-2 px-3 py-3 text-sm',
            unavailable && !loading
              ? 'bg-warning/10 font-medium text-warning-foreground'
              : 'text-muted-foreground',
          )}
        >
          {loading ? (
            <>
              <CircleNotch className="size-4 animate-spin" aria-hidden />
              {labels.loading}
            </>
          ) : unavailable ? (
            <>
              <WarningCircle className="size-4 shrink-0" aria-hidden />
              {labels.unavailable}
            </>
          ) : (
            labels.empty
          )}
        </p>
      ) : (
        <ul
          aria-label={labels.list}
          className="max-h-64 overflow-y-auto p-1"
          style={{ overscrollBehaviorY: 'contain' }}
        >
          {suggestion.items.map((item, index) => {
            const active = index === suggestion.activeIndex
            const disabled = item.disabled === true
            return (
              <li key={item.id}>
                <button
                  ref={active ? activeRef : undefined}
                  type="button"
                  // The editor keeps focus while the picker is open, so a
                  // press must not steal it out from under the caret.
                  onMouseDown={event => event.preventDefault()}
                  // Eligibility is the suggestion plugin's to decide; this only
                  // reports the press. A second `disabled` check here would be
                  // a second owner of the same rule.
                  onClick={() => suggestion.select(index)}
                  aria-current={active}
                  aria-disabled={disabled}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                    disabled
                      ? 'text-muted-foreground/70'
                      : active
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-accent/60',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm font-medium">
                        {suggestion.char}
                        {item.name}
                      </span>
                      {item.scopeLabel ? (
                        // Outlined, not just filled: `bg-muted` is the same value
                        // as the active row's `bg-accent`, so a fill alone makes
                        // the chip dissolve into whichever row the highlight is
                        // on — and next to the warning chip's visible fill, a
                        // shapeless one reads as a different size entirely.
                        <span className="shrink-0 rounded border border-border bg-muted px-1 py-px text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
                          {item.scopeLabel}
                        </span>
                      ) : null}
                      {item.disabledLabel ? (
                        <span className="shrink-0 rounded bg-warning/15 px-1 py-px text-[0.625rem] font-medium uppercase tracking-wide text-warning-foreground">
                          {item.disabledLabel}
                        </span>
                      ) : null}
                    </span>
                    {item.description ? (
                      <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {continuation ? (
        <div className="border-t border-border p-1">
          <button
            type="button"
            onMouseDown={event => event.preventDefault()}
            onClick={continuation.onLoadMore}
            disabled={continuation.loading}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-md px-2 py-2 text-sm font-medium transition-colors',
              'hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none',
              continuation.unavailable
                ? 'bg-warning/10 text-warning-foreground'
                : 'text-muted-foreground',
            )}
          >
            {continuation.loading ? (
              <CircleNotch className="size-4 animate-spin" aria-hidden />
            ) : continuation.unavailable ? (
              <WarningCircle className="size-4" aria-hidden />
            ) : null}
            {continuation.loading
              ? continuation.labels.loading
              : continuation.unavailable
                ? continuation.labels.retry
                : continuation.labels.loadMore}
          </button>
        </div>
      ) : null}
    </div>
  )
}
