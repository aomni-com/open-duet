'use client'

import {
  AlarmIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CircleIcon,
  CircleNotchIcon,
  ListChecksIcon,
  QuestionIcon,
  StopIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { ComposeBarSessionQuestionsSection } from './compose-bar-session-questions'
import type { ComposeBarSession, ComposeBarSessionTodo } from './types'

export function ComposeBarSessionPanel({
  session,
  disabled,
}: {
  session: ComposeBarSession
  disabled: boolean
}) {
  const actionLabel = session.action?.pending
    ? (session.action.pendingLabel ?? session.action.label)
    : session.action?.label
  const activeTodo =
    session.todos?.items.find(todo => todo.status === 'active') ??
    session.todos?.items.find(todo => todo.status === 'pending') ??
    session.todos?.items.at(-1)
  const hasQuestions = session.phase === 'waiting' && (session.questions?.items.length ?? 0) > 0

  const reducedMotion = usePrefersReducedMotion()

  return (
    <section
      aria-live="polite"
      data-compose-bar-session={session.phase}
      /* A tab sliding out from behind the bar: it shares the bar's top border
         (`-mb-px`, `border-b-0`) and is rounded only where it emerges.
         Inset from the bar's edges by a fixed 12px, so the bar's own line runs
         on either side of it and the tab reads as narrower than the folder it
         belongs to. The fixed measure serves both the full conversation and
         narrow agent surfaces; a proportional inset would change its visual
         weight with the host rather than with the component. */
      className={cn(
        'relative z-10 mx-3 border border-border/70 bg-background/95 px-2.5 shadow-[0_-10px_28px_-18px_rgba(2,6,23,0.5)]',
        hasQuestions
          ? 'rounded-xl py-1'
          : cn('-mb-px rounded-t-xl border-b-0', session.phase === 'sleeping' ? 'py-1' : 'py-1.5'),
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={session.key}
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          {hasQuestions && session.questions ? (
            <ComposeBarSessionQuestionsSection questions={session.questions} disabled={disabled} />
          ) : (
            <div
              className={cn(
                'flex justify-between gap-2 text-xs font-medium',
                session.phase === 'sleeping'
                  ? 'items-start text-muted-foreground/80'
                  : 'min-h-7 items-center text-muted-foreground',
              )}
            >
              <div
                className={cn(
                  'flex min-w-0 gap-1.5',
                  session.phase === 'sleeping' ? 'items-start' : 'items-center',
                )}
              >
                <SessionVisual session={session} />
                {session.phase === 'sleeping' ? (
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span>{session.label}</span>
                    {session.hint ? (
                      <span className="text-[11px] font-normal text-muted-foreground/70">
                        {session.hint}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <span className="min-w-0 truncate leading-4">
                    {session.label}
                    {session.phase === 'working' ? <AnimatedEllipsis /> : null}
                  </span>
                )}
              </div>
              {session.action ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || session.action.disabled || session.action.pending}
                  aria-label={session.action.ariaLabel ?? actionLabel}
                  title={session.action.title}
                  className={cn(
                    'shrink-0 gap-1 rounded-full text-[11px] font-medium text-muted-foreground',
                    session.phase === 'sleeping'
                      ? 'h-6 min-w-[64px] px-2 hover:bg-destructive/10 hover:text-destructive disabled:text-muted-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground'
                      : 'h-11 px-3 sm:h-6 sm:px-2',
                  )}
                  onClick={session.action.onSelect}
                >
                  {session.action.pending ? (
                    <CircleNotchIcon className="size-3 motion-safe:animate-spin" aria-hidden />
                  ) : (
                    <StopIcon className="size-3" aria-hidden />
                  )}
                  <span>{actionLabel}</span>
                </Button>
              ) : null}
            </div>
          )}

          {!hasQuestions && session.phase !== 'sleeping' && session.hint ? (
            <p className="ml-5 text-[11px] font-normal text-muted-foreground">{session.hint}</p>
          ) : null}

          {!hasQuestions && session.action?.error ? (
            <p role="alert" className="mt-1 flex items-center gap-1 text-xs text-destructive">
              <WarningCircleIcon className="size-3.5 shrink-0" aria-hidden />
              <span>{session.action.error}</span>
            </p>
          ) : null}

          {!hasQuestions && session.question ? (
            <p className="mt-1.5 whitespace-pre-line rounded-md bg-muted/45 px-2 py-1.5 text-sm font-normal text-foreground">
              {session.question}
            </p>
          ) : null}

          {session.todos && session.todos.items.length > 0 ? (
            <div className="mt-1 border-t border-border/60 pt-1">
              <button
                type="button"
                disabled={disabled}
                aria-expanded={session.todos.expanded}
                aria-label={
                  session.todos.expanded ? session.todos.collapseLabel : session.todos.expandLabel
                }
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-7"
                onClick={() => session.todos?.onExpandedChange(!session.todos.expanded)}
              >
                <span className="flex shrink-0 items-center gap-1.5">
                  <ListChecksIcon className="size-3.5" aria-hidden />
                  <span>{session.todos.label}</span>
                  <CaretDownIcon
                    aria-hidden
                    className={cn(
                      'size-2.5 transition-transform',
                      session.todos.expanded && 'rotate-180',
                    )}
                  />
                </span>
                {!session.todos.expanded && activeTodo ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <TodoIcon todo={activeTodo} />
                    <span className="truncate text-foreground">{activeTodo.label}</span>
                  </span>
                ) : null}
              </button>

              {session.todos.expanded ? (
                <div
                  role="list"
                  className="mt-1 max-h-24 space-y-0.5 overflow-y-auto px-1 [mask-image:linear-gradient(to_bottom,black_calc(100%-0.5rem),transparent)]"
                >
                  {session.todos.items.map(todo => (
                    <div
                      key={todo.id}
                      role="listitem"
                      aria-label={`${session.todos?.statusLabels[todo.status]}: ${todo.label}`}
                      className={cn(
                        'flex min-h-7 items-center gap-2 rounded-md px-1.5 text-sm font-normal',
                        todo.status === 'active' && 'bg-muted/45 font-medium',
                      )}
                    >
                      <TodoIcon todo={todo} />
                      <span
                        className={cn(
                          'min-w-0 truncate text-foreground',
                          todo.status === 'complete' && 'text-muted-foreground line-through',
                          todo.status === 'failed' && 'text-destructive',
                        )}
                      >
                        {todo.label}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </motion.div>
      </AnimatePresence>
    </section>
  )
}

function SessionVisual({ session }: { session: ComposeBarSession }) {
  if (session.phase === 'working' && session.avatar) {
    return (
      <span aria-hidden className="size-6 shrink-0">
        {session.avatar}
      </span>
    )
  }
  if (session.phase === 'sleeping') {
    return (
      <AlarmIcon
        className={cn('mt-0.5 size-3.5 shrink-0', session.tone)}
        weight="fill"
        aria-hidden
      />
    )
  }
  if (session.phase === 'waiting') {
    return (
      <QuestionIcon className={cn('size-3.5 shrink-0', session.tone)} weight="fill" aria-hidden />
    )
  }
  // Working session with no avatar: keep the working identity instead of
  // falling through to the waiting question glyph.
  return (
    <CircleNotchIcon
      className={cn('size-3.5 shrink-0 motion-safe:animate-spin', session.tone)}
      aria-hidden
    />
  )
}

function AnimatedEllipsis() {
  return (
    <span aria-hidden>
      <span className="motion-safe:hidden">…</span>
      <span className="hidden motion-safe:inline">
        <span className="motion-safe:animate-ping">.</span>
        <span className="motion-safe:animate-ping [animation-delay:150ms]">.</span>
        <span className="motion-safe:animate-ping [animation-delay:300ms]">.</span>
      </span>
    </span>
  )
}

function usePrefersReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(true)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return reducedMotion
}

function TodoIcon({ todo }: { todo: ComposeBarSessionTodo }) {
  if (todo.status === 'complete') {
    return <CheckCircleIcon className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
  }
  if (todo.status === 'active') {
    return (
      <CircleNotchIcon
        className="size-3.5 shrink-0 text-live motion-safe:animate-spin"
        aria-hidden
      />
    )
  }
  if (todo.status === 'failed') {
    return <WarningCircleIcon className="size-3.5 shrink-0 text-destructive" aria-hidden />
  }
  return <CircleIcon className="size-3.5 shrink-0" aria-hidden />
}
