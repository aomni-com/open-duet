'use client'

import { BrainIcon, CaretDownIcon, CurrencyDollarIcon, LightningIcon } from '@phosphor-icons/react'
import { useId, useState, type ReactNode } from 'react'

import { useIsMobile } from '../hooks/use-mobile'
import { cn } from '../lib/utils'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from './common/drawer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './shadcn/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from './shadcn/tooltip'

type QualityScoreValue = 1 | 2 | 3 | 4 | 5

type QualityScoreLabels = {
  performance: string
  intelligence: string
  cost: string
}

export type QualitySelectorOption<Id extends string = string> = {
  id: Id
  label: string
  /** Optional description under the label. */
  detail?: ReactNode
  scores: {
    performance: QualityScoreValue
    intelligence: QualityScoreValue
    cost: QualityScoreValue
  }
  scoreLabels: QualityScoreLabels
}

export type QualitySelectorProps<Id extends string = string> = {
  label: string
  value: Id
  options: readonly QualitySelectorOption<Id>[]
  /** Additional choices disclosed on demand, with consumer-localized group copy. */
  advanced?: { label: string; options: readonly QualitySelectorOption<Id>[] }
  onValueChange: (id: Id) => void
  disabled?: boolean
  appearance: 'compose' | 'settings'
  onAfterSelect?: () => void
}

export function QualitySelector<Id extends string>({
  label,
  value,
  options,
  advanced,
  onValueChange,
  disabled = false,
  appearance,
  onAfterSelect = () => undefined,
}: QualitySelectorProps<Id>) {
  const isMobile = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const advancedId = useId()
  const advancedGroup = advanced?.options.length ? advanced : undefined
  const allOptions = [...options, ...(advanced?.options ?? [])]
  const selected = allOptions.find(option => option.id === value)
  const selectedLabel = selected?.label ?? value

  const activate = (id: Id) => {
    if (!disabled && id !== value && allOptions.some(option => option.id === id)) onValueChange(id)
  }

  const mobileOptions = (items: readonly QualitySelectorOption<Id>[]) =>
    items.map(option => (
      <button
        key={option.id}
        type="button"
        role="radio"
        aria-checked={option.id === value}
        disabled={disabled}
        onClick={() => {
          activate(option.id)
          setDrawerOpen(false)
          window.setTimeout(onAfterSelect, 350)
        }}
        className={cn(
          'group flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
          option.id === value
            ? 'bg-gradient-to-r from-brand/[0.16] via-brand/[0.08] to-transparent'
            : 'bg-muted/35 hover:bg-muted/60',
        )}
      >
        <QualityOptionContent option={option} selected={option.id === value} compact />
      </button>
    ))

  const desktopOptions = (items: readonly QualitySelectorOption<Id>[]) =>
    items.map(option => (
      <DropdownMenuRadioItem
        key={option.id}
        value={option.id}
        disabled={disabled}
        className={cn(
          'group/option cursor-pointer items-start rounded-md px-2 py-2 transition-colors [&>span:first-child]:hidden',
          'focus:bg-accent/40 focus:text-popover-foreground',
          'data-[state=checked]:bg-gradient-to-r data-[state=checked]:from-brand/[0.14] data-[state=checked]:via-brand/[0.07] data-[state=checked]:to-transparent',
        )}
      >
        <QualityOptionContent option={option} selected={option.id === value} />
      </DropdownMenuRadioItem>
    ))

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'relative z-10 flex min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden text-left font-medium outline-none',
        'disabled:pointer-events-none disabled:opacity-50',
        appearance === 'compose'
          ? 'w-full px-3 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/90'
          : 'min-h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring sm:w-96',
      )}
    >
      <span className="sr-only">{label}: </span>
      {appearance === 'compose' ? (
        <span aria-hidden className="hidden shrink-0 text-white/70 sm:inline">
          {label}:
        </span>
      ) : null}
      <span
        className={cn(
          'min-w-0 flex-1 break-words whitespace-normal',
          appearance === 'compose' && 'text-white drop-shadow-sm',
        )}
      >
        {selectedLabel}
      </span>
      {selected ? (
        <QualityScores
          scores={selected.scores}
          labels={selected.scoreLabels}
          compact
          className={cn(
            'shrink-0',
            appearance === 'compose' ? 'text-white/80' : 'text-muted-foreground',
          )}
        />
      ) : null}
      <CaretDownIcon
        className={cn(
          'shrink-0',
          appearance === 'compose' ? 'size-3 text-white/70' : 'size-4 text-muted-foreground',
        )}
        aria-hidden
      />
    </button>
  )

  if (isMobile) {
    return (
      <Drawer
        open={drawerOpen}
        onOpenChange={open => {
          setDrawerOpen(open)
          if (open)
            setAdvancedOpen(advancedGroup?.options.some(option => option.id === value) ?? false)
        }}
      >
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent
          className="z-[6050] max-h-[90dvh] overflow-hidden rounded-t-3xl border-border/80"
          overlayClassName="z-[6050]"
        >
          <DrawerHeader className="px-5 pb-3 pt-4 text-left">
            <DrawerTitle className="text-base">{label}</DrawerTitle>
            <DrawerDescription className="sr-only">{label}</DrawerDescription>
          </DrawerHeader>
          <div
            role="radiogroup"
            aria-label={label}
            className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
          >
            {mobileOptions(options)}
            {advancedGroup ? (
              <div className="border-t border-border/80 pt-2">
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  aria-controls={advancedId}
                  disabled={disabled}
                  onClick={() => setAdvancedOpen(open => !open)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  {advancedGroup.label}
                  <CaretDownIcon
                    aria-hidden
                    className={cn(
                      'size-4 shrink-0 transition-transform',
                      advancedOpen && 'rotate-180',
                    )}
                  />
                </button>
                <div id={advancedId} hidden={!advancedOpen} className="space-y-2">
                  {mobileOptions(advancedGroup.options)}
                </div>
              </div>
            ) : null}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={appearance === 'compose' ? 'top' : 'bottom'}
        className="w-[calc(100vw-1rem)] max-w-[32rem]"
      >
        <DropdownMenuRadioGroup
          aria-label={label}
          value={value}
          onValueChange={nextValue => {
            activate(nextValue as Id)
            window.setTimeout(onAfterSelect, 100)
          }}
        >
          {desktopOptions(options)}
          {advancedGroup ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={disabled} className="cursor-pointer py-2">
                  {advancedGroup.label}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent
                    collisionPadding={8}
                    className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-[28rem] max-w-[calc(100vw-1rem)] overflow-y-auto"
                  >
                    {desktopOptions(advancedGroup.options)}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </>
          ) : null}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function QualityOptionContent<Id extends string>({
  option,
  selected,
  compact = false,
}: {
  option: QualitySelectorOption<Id>
  selected: boolean
  compact?: boolean
}) {
  return (
    <span className="flex min-w-0 flex-1 items-start gap-2.5">
      <span
        data-quality-option-marker
        aria-hidden
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 bg-background/35 transition-[border-color,background-color,box-shadow]',
          selected && 'border-brand/70 bg-brand/[0.08] shadow-[0_0_0_3px_hsl(var(--brand)/0.09)]',
        )}
      >
        {selected ? (
          <span data-quality-option-selected className="size-1.5 rounded-full bg-brand" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-3">
          <span className="min-w-0 flex-1 text-sm font-medium leading-tight">{option.label}</span>
          <QualityScores
            scores={option.scores}
            labels={option.scoreLabels}
            compact={compact}
            className="shrink-0 text-muted-foreground"
          />
        </span>
        {option.detail === undefined ? null : (
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {option.detail}
          </span>
        )}
      </span>
    </span>
  )
}

function QualityScores({
  scores,
  labels,
  compact = false,
  className,
}: {
  scores: QualitySelectorOption['scores']
  labels: QualityScoreLabels
  compact?: boolean
  className?: string
}) {
  return (
    <span className={cn('flex items-center', compact ? 'gap-1.5 sm:gap-2' : 'gap-2', className)}>
      <QualityScore
        label={labels.performance}
        value={scores.performance}
        compact={compact}
        icon={<LightningIcon className="size-3.5 shrink-0" weight="fill" aria-hidden />}
      />
      <QualityScore
        label={labels.intelligence}
        value={scores.intelligence}
        compact={compact}
        icon={<BrainIcon className="size-3.5 shrink-0" weight="fill" aria-hidden />}
      />
      <QualityScore
        label={labels.cost}
        value={scores.cost}
        compact={compact}
        icon={<CurrencyDollarIcon className="size-3.5 shrink-0" weight="fill" aria-hidden />}
      />
    </span>
  )
}

function QualityScore({
  label,
  value,
  compact,
  icon,
}: {
  label: string
  value: QualityScoreValue
  compact: boolean
  icon: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={`${label}: ${value}/5`} className="flex items-center gap-1">
          {icon}
          {compact ? (
            <span className="text-[11px] font-semibold leading-none tabular-nums sm:hidden">
              {value}
              <span className="text-[8px] font-medium opacity-50">/5</span>
            </span>
          ) : null}
          <span className={cn('items-center gap-[3px]', compact ? 'hidden sm:flex' : 'flex')}>
            {Array.from({ length: 5 }, (_, index) => (
              <span
                key={index}
                aria-hidden
                className={cn(
                  'h-1 w-1.5 rounded-full bg-current',
                  index < value ? 'opacity-90' : 'opacity-25',
                )}
              />
            ))}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}: {value}/5
      </TooltipContent>
    </Tooltip>
  )
}
