'use client'

import { InfoIcon } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'

import type { AgentModelUsageEntry, AgentTokenUsage } from '@repo/contract'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@repo/ui/components/shadcn/hover-card'
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

import type { ProjectedAgentMessage } from './projection'

/**
 * The quiet line under a turn: while the turn runs it counts up ("thinking
 * for 12s"), and once the terminal event lands it settles into the turn's
 * wall-clock span with an info affordance opening the token readout. A turn
 * that ended without a terminal event (its tail was split off by a steer, or
 * the runner died) has neither and renders nothing.
 *
 * `clockNow` pins the counting clock: when set, the line renders that instant
 * and never ticks — the deterministic mode screenshot fixtures feed through
 * the shell's `clock` seam. When absent, the line keeps its own one-second
 * interval against the wall clock.
 */
export function SessionTurnFooter({
  message,
  running = false,
  clockNow,
}: {
  message: ProjectedAgentMessage
  running?: boolean
  clockNow?: number
}) {
  const t = useTranslations('duetApp.sessionProduct')
  const thinking = !message.finalized && running && message.createdAt !== undefined
  const now = useTickingNow(thinking && clockNow === undefined)

  if (thinking) {
    const anchor = clockNow ?? now
    if (anchor === undefined || message.createdAt === undefined) return null
    return (
      <div data-turn-footer className="mt-2 flex items-center gap-1.5 text-xs text-foreground/70">
        <span className="tabular-nums">
          {t('thinkingFor', {
            duration: formatTurnDuration(Math.max(anchor - message.createdAt, 1_000)),
          })}
        </span>
      </div>
    )
  }

  const duration =
    message.createdAt !== undefined && message.finalizedAt !== undefined
      ? // Sub-second turns still read as having taken a beat: "thought for 0s"
        // would claim the turn never happened.
        Math.max(message.finalizedAt - message.createdAt, 1_000)
      : undefined
  if (duration === undefined && message.turnUsage === undefined) return null

  return (
    <div data-turn-footer className="mt-2 flex items-center gap-1.5 text-xs text-foreground/70">
      {duration === undefined ? null : (
        <span className="tabular-nums">
          {t('thoughtFor', { duration: formatTurnDuration(duration) })}
        </span>
      )}
      {message.turnUsage === undefined ? null : (
        <TurnUsageInfo turnUsage={message.turnUsage} usageByModel={message.usageByModel} />
      )}
    </div>
  )
}

/**
 * The wall clock, re-read every second while `active`. Starts undefined so a
 * server render never bakes in a clock face; the first client effect fills it.
 */
function useTickingNow(active: boolean): number | undefined {
  const [now, setNow] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [active])
  return active ? now : undefined
}

function TurnUsageInfo({
  turnUsage,
  usageByModel,
}: {
  turnUsage: AgentTokenUsage
  usageByModel: AgentModelUsageEntry[] | undefined
}) {
  const t = useTranslations('duetApp.sessionProduct')
  const isMobile = useIsMobile()
  const trigger = (
    <button
      type="button"
      aria-label={t('turnUsageLabel')}
      className="inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <InfoIcon className="size-3.5" aria-hidden />
    </button>
  )
  const body = <TurnUsagePanel turnUsage={turnUsage} usageByModel={usageByModel} />

  // Hover does not exist on touch, so the same readout rides the product's
  // mobile surface for inspectors: a bottom sheet, as the relay chip does.
  if (isMobile) {
    return (
      <Sheet>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          className="flex max-h-[85dvh] flex-col gap-0 rounded-t-2xl p-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="shrink-0 border-b px-3 py-2 text-left">
            <SheetTitle className="text-xs font-medium">{t('turnUsageTitle')}</SheetTitle>
            <SheetDescription className="sr-only">{t('turnUsageLabel')}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">{body}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <HoverCard openDelay={150} closeDelay={120}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent align="start" sideOffset={8} className="w-64 p-0">
        <p className="border-b px-3 py-2 text-xs font-medium">{t('turnUsageTitle')}</p>
        <div className="p-3">{body}</div>
      </HoverCardContent>
    </HoverCard>
  )
}

/** The readout itself, kept pure so tests and fixtures can mount it directly. */
export function TurnUsagePanel({
  turnUsage,
  usageByModel,
}: {
  turnUsage: AgentTokenUsage
  usageByModel: AgentModelUsageEntry[] | undefined
}) {
  const t = useTranslations('duetApp.sessionProduct')
  return (
    <div className="space-y-1 text-xs tabular-nums">
      <UsageRow label={t('usageTotalTokens')} tokens={turnUsage.totalTokens} emphasize />
      <UsageRow label={t('usageInput')} tokens={turnUsage.input} indent />
      <UsageRow label={t('usageOutput')} tokens={turnUsage.output} indent />
      <UsageRow label={t('usageCacheRead')} tokens={turnUsage.cacheRead} indent />
      <UsageRow label={t('usageCacheWrite')} tokens={turnUsage.cacheWrite} indent />
      {usageByModel === undefined || usageByModel.length === 0 ? null : (
        <>
          <div className="flex items-center gap-2 pt-1.5 text-muted-foreground" aria-hidden>
            <span className="h-px flex-1 bg-border" />
            <span>{t('usagePerModel')}</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          {usageByModel.map(entry => (
            <UsageRow
              // One model can appear twice when its transport differs
              // (plan-covered turn, metered fallback), so the name alone
              // cannot key the row.
              key={`${entry.model}:${entry.transport.provider}:${entry.transport.billing}`}
              label={entry.model}
              tokens={entry.usage.totalTokens}
            />
          ))}
        </>
      )}
    </div>
  )
}

function UsageRow({
  label,
  tokens,
  emphasize = false,
  indent = false,
}: {
  label: string
  tokens: number
  emphasize?: boolean
  indent?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-baseline gap-2',
        indent && 'pl-2',
        emphasize ? 'font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <span className="w-14 shrink-0 text-right">{formatTokenCount(tokens)}</span>
    </div>
  )
}

function formatTurnDuration(ms: number): string {
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return `${count}`
}
