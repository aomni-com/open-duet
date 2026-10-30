'use client'

import { CaretRightIcon, CheckIcon, CircleNotchIcon, MinusIcon } from '@phosphor-icons/react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import { cn } from '../lib/utils'

export type AIToolStatus = 'running' | 'complete' | 'error'

type DetailsProps = ComponentPropsWithoutRef<'details'>
type AIDetailsProps = DetailsProps & Record<`data-${string}`, string | undefined>

export function AIMessage({ children, className, ...props }: ComponentPropsWithoutRef<'article'>) {
  return (
    <article {...props} className={cn('group relative min-w-0', className)}>
      {children}
    </article>
  )
}

/**
 * The compact status affordance used by AI tool rows. The label is supplied by
 * the product so localization stays with the data owner; the primitive only
 * renders the state and keeps its footprint stable across transitions.
 */
export function AIToolStatusIcon({
  status,
  label,
  className,
}: {
  status: AIToolStatus
  label: string
  className?: string
}) {
  const iconClassName = cn('size-4 text-muted-foreground', className)
  if (status === 'running') {
    return (
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        <CircleNotchIcon
          aria-label={label}
          aria-hidden={false}
          className={cn(iconClassName, 'text-brand motion-safe:animate-spin')}
          weight="bold"
        />
      </span>
    )
  }
  if (status === 'complete') {
    return (
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        <CheckIcon aria-label={label} aria-hidden={false} className={iconClassName} weight="bold" />
      </span>
    )
  }
  return (
    <span className="inline-flex size-4 shrink-0 items-center justify-center">
      <MinusIcon aria-label={label} className={iconClassName} />
    </span>
  )
}

/**
 * A shadcn Trace-shaped disclosure for the ordered work an agent performs.
 * Children stay in the DOM in source order; native details controls visibility.
 */
export function AITrace({
  title,
  description,
  icon,
  children,
  className,
  detailsProps,
}: {
  title: string
  description?: string
  icon?: ReactNode
  children: ReactNode
  className?: string
  detailsProps?: AIDetailsProps
}) {
  return (
    <details {...detailsProps} className={cn('group/trace', className, detailsProps?.className)}>
      <summary className="flex min-h-7 min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-sm py-1 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
        <DisclosureMarker group="trace" />
        {icon === undefined ? null : (
          <span className="inline-flex size-4 shrink-0 items-center justify-center">{icon}</span>
        )}
        <span className="shrink-0">{title}</span>
        {description === undefined ? null : (
          <span className="min-w-0 flex-1 truncate font-normal italic text-muted-foreground/90">
            {description}
          </span>
        )}
      </summary>
      <div className="mt-2 mb-1 ml-[7px] min-w-0 border-l pr-1 pl-4 leading-relaxed text-muted-foreground">
        {children}
      </div>
    </details>
  )
}

/**
 * AI Elements-shaped tool disclosure. It is controlled by native details so
 * keyboard and no-JavaScript behavior remain available without a provider.
 */
export function AITool({
  name,
  source,
  status,
  statusLabel,
  children,
  className,
  icon,
  detailsProps,
}: {
  name: string
  source?: ReactNode
  status: AIToolStatus
  statusLabel: string
  children?: ReactNode
  className?: string
  icon?: ReactNode
  detailsProps?: AIDetailsProps
}) {
  return (
    <details {...detailsProps} className={cn('group/tool', className, detailsProps?.className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm py-0.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
        <DisclosureMarker group="tool" />
        {icon}
        <span className="flex min-w-0 max-w-[75%] items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-xs font-medium lowercase">{name}</span>
          {source}
        </span>
        <AIToolStatusIcon status={status} label={statusLabel} />
      </summary>
      {children}
    </details>
  )
}

export function AIReasoning({
  title,
  preview,
  pendingLabel,
  children,
  className,
  detailsProps,
}: {
  title: string
  preview?: string
  pendingLabel?: string
  children: ReactNode
  className?: string
  detailsProps?: AIDetailsProps
}) {
  return (
    <details
      {...detailsProps}
      className={cn('group/reasoning', className, detailsProps?.className)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm py-0.5 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
        <DisclosureMarker group="reasoning" />
        <span className="shrink-0">{title}</span>
        {pendingLabel === undefined ? null : (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0">{pendingLabel}</span>
          </>
        )}
        {preview === undefined ? null : (
          <span
            aria-hidden
            className="min-w-0 flex-1 truncate font-normal italic text-muted-foreground/90 group-open:invisible"
          >
            {preview}
          </span>
        )}
      </summary>
      {children}
    </details>
  )
}

function DisclosureMarker({ group }: { group: 'trace' | 'tool' | 'reasoning' }) {
  return (
    <span aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center">
      <CaretRightIcon
        className={cn(
          'size-3 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
          group === 'trace'
            ? 'group-open/trace:rotate-90'
            : group === 'tool'
              ? 'group-open/tool:rotate-90'
              : 'group-open/reasoning:rotate-90',
        )}
      />
    </span>
  )
}
