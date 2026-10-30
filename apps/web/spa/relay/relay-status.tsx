'use client'

import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CaretUpIcon,
  CodeIcon,
  FlagCheckeredIcon,
  FlowArrowIcon,
  InfoIcon,
  LightningIcon,
  MoonStarsIcon,
  RobotIcon,
  TimerIcon,
} from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import type { AgentStateMachineSession, MachinePathItem, Machine } from '@repo/contract'
import { PrettyObject } from '@repo/ui/components/common/pretty-object'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@repo/ui/components/shadcn/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/shadcn/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@repo/ui/components/shadcn/sheet'
import { useIsMobile } from '@repo/ui/hooks/use-mobile'
import { cn } from '@repo/ui/lib/utils'

export function RelayStatus({
  summary,
  stateMachine,
  className,
}: {
  summary: Machine
  stateMachine?: AgentStateMachineSession
  className?: string
}) {
  const t = useTranslations('duetApp.relay')
  const isMobile = useIsMobile()
  const currentIndex = summary.orderedPath.findIndex(item => item.phase === 'current')
  const currentItem = currentIndex >= 0 ? summary.orderedPath[currentIndex] : undefined
  const definition = summary.definitionName ?? t('unnamed')
  const total =
    summary.progress?.total ?? summary.orderedPath.filter(item => item.phase !== 'outcome').length
  const completed = currentIndex < 0 ? undefined : (summary.progress?.completed ?? currentIndex + 1)
  const current = currentItem?.name ?? summary.currentState ?? definition
  const nextItem =
    currentIndex >= 0 ? summary.orderedPath[currentIndex + 1] : summary.orderedPath[0]
  const next = nextItem?.name ?? t('final')
  const previousCount = currentIndex > 0 ? currentIndex : 0
  const remainingAfterNextCount = currentIndex >= 0 ? Math.max(total - currentIndex - 2, 0) : 0
  const progressLabel =
    completed !== undefined
      ? t('progress', { current: completed, total })
      : t('unknownProgress', { total })
  const progressShort = completed === undefined ? null : `${completed}/${total}`
  const currentIconColor =
    currentItem?.terminalStatus === 'failed' || currentItem?.terminalStatus === 'error'
      ? 'text-destructive'
      : currentItem?.terminalStatus === 'completed'
        ? 'text-emerald-600 dark:text-emerald-400'
        : currentItem?.terminalStatus === 'cancelled' ||
            currentItem?.terminalStatus === 'interrupted'
          ? 'text-muted-foreground'
          : 'text-brand'
  const ariaLabel = `${t('activeRelay')}: ${definition}. ${t('current')}: ${current}. ${t('next')}: ${next}. ${progressLabel}.`

  const compactStatus = (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      tabIndex={0}
      className={cn(
        'group inline-flex h-7 min-w-0 max-w-full cursor-default items-center gap-1.5 rounded-md bg-muted/40 px-2 text-xs outline-none transition-colors',
        'hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <span className="relative flex size-3.5 shrink-0 items-center justify-center text-live">
        <span className="absolute size-3 rounded-full bg-live/15 motion-safe:animate-pulse" />
        <span className="relative size-1.5 rounded-full bg-live" aria-hidden />
      </span>

      {previousCount > 0 ? (
        <span
          className="hidden shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground/55 @[26rem]/relay-header:inline"
          title={t('previousLong', { count: previousCount })}
        >
          +{previousCount}
        </span>
      ) : null}

      <span className="flex min-w-0 flex-1 items-center gap-1">
        <RelayKindIcon item={currentItem} outcome={summary.outcome} className={currentIconColor} />
        <span className="min-w-0 truncate font-medium text-foreground" title={current}>
          {current}
        </span>
      </span>

      <span className="hidden min-w-0 shrink items-center gap-1 text-muted-foreground @[22rem]/relay-header:flex">
        <span className="shrink-0 text-muted-foreground/40" aria-hidden>
          →
        </span>
        {nextItem ? (
          <RelayKindIcon
            item={nextItem}
            outcome={undefined}
            className="size-3 text-muted-foreground/50"
          />
        ) : null}
        <span className="min-w-0 max-w-[9rem] truncate" title={next}>
          {next}
        </span>
      </span>

      {remainingAfterNextCount > 0 ? (
        <span
          className="hidden shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground/55 @[26rem]/relay-header:inline"
          title={t('remainingLong', { count: remainingAfterNextCount })}
        >
          +{remainingAfterNextCount}
        </span>
      ) : null}

      {progressShort ? (
        <span
          className="hidden shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground/60 @[15rem]/relay-header:inline @[26rem]/relay-header:hidden"
          title={progressLabel}
        >
          {progressShort}
        </span>
      ) : null}
    </div>
  )

  return (
    <motion.div
      key={definition}
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={cn('@container/relay-header flex w-full min-w-0 justify-end', className)}
      data-relay-status
    >
      {isMobile ? (
        <Sheet>
          <SheetTrigger asChild>{compactStatus}</SheetTrigger>
          <SheetContent
            side="bottom"
            className="gap-0 rounded-t-2xl p-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] [&>button]:right-4 [&>button]:top-4"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{ariaLabel}</SheetTitle>
              <SheetDescription>{t('pathDescription')}</SheetDescription>
            </SheetHeader>
            <div
              className="mx-auto mb-1 mt-2.5 h-1 w-9 rounded-full bg-muted-foreground/25"
              aria-hidden
            />
            <RelayPathDisclosure summary={summary} stateMachine={stateMachine} surface="sheet" />
          </SheetContent>
        </Sheet>
      ) : (
        <HoverCard openDelay={150} closeDelay={120}>
          <HoverCardTrigger asChild>{compactStatus}</HoverCardTrigger>
          <HoverCardContent align="end" sideOffset={8} className="w-72 overflow-hidden p-0">
            <RelayPathDisclosure summary={summary} stateMachine={stateMachine} surface="popover" />
          </HoverCardContent>
        </HoverCard>
      )}
    </motion.div>
  )
}

export function RelayPathDisclosure({
  summary,
  stateMachine,
  surface,
}: {
  summary: Machine
  stateMachine?: AgentStateMachineSession
  surface: 'popover' | 'sheet'
}) {
  const t = useTranslations('duetApp.relay')
  const pathViewportRef = useRef<HTMLDivElement>(null)
  const currentRef = useRef<HTMLLIElement>(null)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [scrollEdges, setScrollEdges] = useState({ top: false, bottom: false })
  const currentItem =
    summary.orderedPath.find(item => item.phase === 'current') ??
    summary.orderedPath.find(
      item => item.phase === 'outcome' && item.terminalStatus === summary.outcome,
    )
  const currentIdentity = currentItem ? relayItemIdentity(currentItem) : undefined

  const updateScrollEdges = useCallback(() => {
    const viewport = pathViewportRef.current
    if (viewport === null) return
    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight
    setScrollEdges({
      top: viewport.scrollTop > 1,
      bottom: maxScrollTop - viewport.scrollTop > 1,
    })
  }, [pathViewportRef])

  useLayoutEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    updateScrollEdges()
  }, [currentIdentity, summary.orderedPath.length, updateScrollEdges])

  return (
    <section aria-label={t('activeRelay')} className="min-h-0">
      <header className="flex h-9 min-h-9 items-center gap-2 px-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/80">
          <LightningIcon aria-hidden weight="fill" className="size-3.5" />
        </span>
        <h2 className="shrink-0">{t('title')}</h2>
        <span
          className="ml-auto min-w-0 truncate text-xs font-medium normal-case tracking-normal text-foreground"
          title={summary.definitionName ?? t('unnamed')}
        >
          {summary.definitionName ?? t('unnamed')}
        </span>
      </header>

      {stateMachine?.definition.prompt ? (
        <button
          type="button"
          aria-expanded={promptExpanded}
          aria-label={promptExpanded ? t('collapsePrompt') : t('expandPrompt')}
          className="mx-3 mb-1 flex w-[calc(100%-1.5rem)] items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/40"
          onClick={() => setPromptExpanded(current => !current)}
        >
          <span
            className={cn(
              'min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground/70',
              promptExpanded && 'max-h-32 overflow-y-auto',
            )}
          >
            {promptExpanded
              ? stateMachine.definition.prompt
              : stateMachine.definition.prompt.length > 80
                ? `${stateMachine.definition.prompt.slice(0, 80)}…`
                : stateMachine.definition.prompt}
          </span>
          {promptExpanded ? (
            <CaretUpIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground/50" aria-hidden />
          ) : (
            <CaretDownIcon
              className="mt-0.5 size-3 shrink-0 text-muted-foreground/50"
              aria-hidden
            />
          )}
        </button>
      ) : null}

      <div className="relative min-h-0 overflow-hidden">
        <div
          ref={pathViewportRef}
          role="region"
          aria-label={t('pathItemsLabel')}
          tabIndex={0}
          data-testid="relay-path-viewport"
          className={cn(
            'min-h-0 overflow-y-auto px-1 py-1 scroll-py-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            surface === 'popover' ? 'max-h-56' : 'max-h-[min(58dvh,30rem)]',
          )}
          onScroll={updateScrollEdges}
        >
          {summary.orderedPath.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t('pathUnavailable')}
            </p>
          ) : (
            <ol className="flex flex-col gap-0.5 py-1" aria-label={t('pathItemsLabel')}>
              {relayDisclosureItems(summary).map(displayItem => {
                if (displayItem.type === 'outcomes') {
                  const outcomeNames = displayItem.items.map(item => item.name).join(', ')
                  return (
                    <li
                      key="relay-outcomes"
                      data-relay-item-phase="outcome"
                      className="scroll-my-4"
                      aria-label={t('possibleOutcomesLabel', { outcomes: outcomeNames })}
                      title={outcomeNames}
                    >
                      <div className="rounded-md px-2 py-1.5 text-xs text-muted-foreground/70">
                        <div className="mb-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/55">
                          {t('outcomes')}
                        </div>
                        <div className="flex items-center gap-2">
                          <FlagCheckeredIcon className="size-3.5 shrink-0" aria-hidden />
                          <div className="ml-auto flex min-w-0 flex-1 justify-end gap-1 overflow-hidden">
                            {displayItem.items.slice(0, 3).map(item => (
                              <span
                                key={item.key}
                                className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/80"
                                title={item.name}
                              >
                                {item.terminalStatus
                                  ? t(`compactOutcome.${item.terminalStatus}`)
                                  : item.name}
                              </span>
                            ))}
                            {displayItem.items.length > 3 ? (
                              <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                                +{displayItem.items.length - 3}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </li>
                  )
                }

                const item = displayItem.item
                const identity = relayItemIdentity(item)
                const isCurrent = identity === currentIdentity
                const state = stateMachine?.definition.states[item.index]
                const stateConfig = state?.name === item.name ? state : undefined
                const terminalStatus = isCurrent
                  ? (item.terminalStatus ?? summary.outcome)
                  : undefined
                const isFailed = terminalStatus === 'failed' || terminalStatus === 'error'
                const isCancelled =
                  terminalStatus === 'cancelled' || terminalStatus === 'interrupted'
                const isTerminalCompleted = terminalStatus === 'completed'
                const isTerminal = item.kind === 'terminal'
                const badgeLabel = terminalStatus
                  ? t(`outcome.${terminalStatus}`)
                  : isCurrent
                    ? t('current')
                    : isTerminal
                      ? t('phase.outcome')
                      : t(`kind.${relayKindLabel(item.kind)}`)
                return (
                  <li
                    key={identity}
                    ref={isCurrent ? currentRef : undefined}
                    data-relay-item-id={identity}
                    data-relay-item-index={item.index}
                    data-relay-item-key={item.key}
                    data-relay-item-phase={item.phase}
                    aria-current={isCurrent ? 'step' : undefined}
                    className="scroll-my-5"
                  >
                    <div
                      className={cn(
                        'group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                        isCurrent && !isFailed && !isCancelled
                          ? 'bg-brand/10 text-foreground ring-1 ring-brand/40'
                          : 'text-muted-foreground hover:bg-muted/40',
                        isTerminalCompleted &&
                          'bg-emerald-500/10 text-foreground ring-1 ring-emerald-500/35',
                        isFailed && 'bg-destructive/10 text-foreground ring-1 ring-destructive/35',
                        isCancelled && 'bg-muted/60 text-muted-foreground ring-1 ring-border',
                      )}
                    >
                      {!isCurrent && !isTerminal ? (
                        <span
                          className="mx-[3px] size-2 shrink-0 rounded-full bg-muted-foreground/45"
                          aria-hidden
                        />
                      ) : isTerminal ? (
                        <FlagCheckeredIcon
                          className={cn(
                            'size-3.5 shrink-0',
                            isFailed
                              ? 'text-destructive'
                              : isTerminalCompleted
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-muted-foreground/55',
                          )}
                          aria-hidden
                        />
                      ) : (
                        <span
                          className="relative flex size-3.5 shrink-0 items-center justify-center"
                          aria-hidden
                        >
                          <span className="absolute size-3 rounded-full bg-live/20 motion-safe:animate-pulse" />
                          <span className="relative size-2 rounded-full bg-live shadow-[0_0_0_2px] shadow-live/15" />
                        </span>
                      )}
                      {!isTerminal ? (
                        <RelayKindIcon
                          item={item}
                          outcome={undefined}
                          className={cn(
                            'size-3.5',
                            isCurrent ? 'text-brand' : 'text-muted-foreground/65',
                          )}
                        />
                      ) : null}
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate',
                          isCurrent ? 'font-medium' : 'font-normal',
                        )}
                        title={item.name}
                      >
                        {item.name}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 rounded px-1 py-0.5 text-[10px] uppercase tracking-wide',
                          isCurrent && !isFailed && !isCancelled
                            ? 'bg-brand/15 text-brand'
                            : 'bg-muted/60 text-muted-foreground/80',
                          isTerminalCompleted &&
                            'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                          isFailed && 'bg-destructive/15 text-destructive',
                        )}
                      >
                        {badgeLabel}
                      </span>
                      {stateConfig ? (
                        <StateConfigInspector
                          state={stateConfig}
                          label={item.name}
                          surface={surface}
                        />
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
        <div
          aria-hidden
          data-testid="relay-path-top-fade"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b transition-opacity duration-150',
            surface === 'popover' ? 'from-popover to-popover/0' : 'from-background to-background/0',
            scrollEdges.top ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          aria-hidden
          data-testid="relay-path-bottom-fade"
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t transition-opacity duration-150',
            surface === 'popover' ? 'from-popover to-popover/0' : 'from-background to-background/0',
            scrollEdges.bottom ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
    </section>
  )
}

function relayItemIdentity(item: MachinePathItem): string {
  return `${item.index}:${item.key}:${item.phase}`
}

type RelayDisclosureItem =
  | { type: 'item'; item: MachinePathItem }
  | { type: 'outcomes'; items: MachinePathItem[] }

function relayDisclosureItems(summary: Machine): RelayDisclosureItem[] {
  const currentOutcome = summary.orderedPath.find(
    item => item.phase === 'outcome' && item.terminalStatus === summary.outcome,
  )
  const outcomes = summary.orderedPath.filter(
    item => item.phase === 'outcome' && item !== currentOutcome,
  )
  const items: RelayDisclosureItem[] = []
  let grouped = false
  for (const item of summary.orderedPath) {
    if (item.phase !== 'outcome' || item === currentOutcome) {
      items.push({ type: 'item', item })
      continue
    }
    if (grouped) continue
    grouped = true
    if (outcomes.length > 0) items.push({ type: 'outcomes', items: outcomes })
  }
  return items
}

function StateConfigInspector({
  state,
  label,
  surface,
}: {
  state: AgentStateMachineSession['definition']['states'][number]
  label: string
  surface: 'popover' | 'sheet'
}) {
  const t = useTranslations('duetApp.relay')
  const config = Object.fromEntries(
    Object.entries(state).filter(([key]) => key !== 'name' && key !== 'kind'),
  )
  const trigger = (
    <button
      type="button"
      aria-label={t('viewConfiguration', { state: label })}
      className="inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <InfoIcon className="size-3.5" aria-hidden />
    </button>
  )
  const body =
    Object.keys(config).length > 0 ? (
      <PrettyObject data={config} />
    ) : (
      <p className="text-xs text-muted-foreground">{t('noConfiguration')}</p>
    )

  if (surface === 'sheet') {
    return (
      <Sheet>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          className="flex max-h-[85dvh] flex-col gap-0 rounded-t-2xl p-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="shrink-0 border-b px-3 py-2 text-left">
            <SheetTitle className="truncate text-xs font-medium">{label}</SheetTitle>
            <SheetDescription className="sr-only">
              {t('configurationDescription', { state: label })}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">{body}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="max-h-[60vh] w-72 overflow-y-auto p-3"
      >
        <p className="mb-2 truncate text-xs font-medium" title={label}>
          {label}
        </p>
        {body}
      </PopoverContent>
    </Popover>
  )
}

function relayKindLabel(kind: string | undefined): 'agent' | 'script' | 'poll' | 'timer' | 'state' {
  if (kind === 'agent' || kind === 'script' || kind === 'poll' || kind === 'timer') return kind
  if (kind === 'park') return 'timer'
  return 'state'
}

function RelayKindIcon({
  item,
  outcome,
  className,
}: {
  item: MachinePathItem | undefined
  outcome: Machine['outcome']
  className?: string
}) {
  const iconClassName = cn('size-3.5 shrink-0 text-brand', className)
  const kind = outcome === undefined ? item?.kind : 'terminal'
  const props = {
    'aria-hidden': true,
    className: iconClassName,
    'data-relay-kind': kind ?? 'unknown',
  } as const

  switch (kind) {
    case 'agent':
      return <RobotIcon {...props} />
    case 'script':
      return <CodeIcon {...props} />
    case 'poll':
      return <ArrowsClockwiseIcon {...props} />
    case 'timer':
      return <TimerIcon {...props} />
    case 'park':
      return <MoonStarsIcon {...props} />
    case 'terminal':
      return <FlagCheckeredIcon {...props} />
    case undefined:
      return <LightningIcon {...props} />
    default:
      return <FlowArrowIcon {...props} />
  }
}
