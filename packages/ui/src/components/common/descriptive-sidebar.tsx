'use client'

import { type Icon } from '@phosphor-icons/react'
import Link from 'next/link'
import { useCallback } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/shadcn/tooltip'
import { cn } from '@repo/ui/lib/utils'
import { type PropsWithClassName } from '@repo/ui/types/index'

export type DescriptiveSidebarItem =
  | {
      type: 'data'
      key: string
      title: string
      description: string
      icon: Icon
      onClick?: () => void
      href?: string
      disabled?: boolean
      tooltipLabel?: string
      className?: string
      iconClassName?: string
    }
  | {
      type: 'schema'
      key: string
      title: string
      description: string
      icon: Icon
      count?: number
      onClick?: () => void
      href?: string
      disabled?: boolean
      tooltipLabel?: string
      className?: string
      iconClassName?: string
    }
  | { type: 'divider'; title?: string }

type Props = PropsWithClassName<{
  items: DescriptiveSidebarItem[]
  selectedKey: string
}>

export function DescriptiveSidebar({ items, selectedKey, className }: Props) {
  const renderButton = useCallback(
    (item: DescriptiveSidebarItem) => {
      if (item.type === 'divider') {
        return null
      }

      const isSelected = selectedKey === item.key
      const isDisabled = item.disabled === true

      const button = (
        <button
          key={item.key}
          className={cn(
            'relative flex w-full rounded-md bg-background-secondary py-3 highlight-white dark:border-0',
            isSelected && 'text-primary',
            isDisabled && 'opacity-50 cursor-not-allowed',
            item.className,
          )}
          onClick={item.onClick}
          disabled={isDisabled}
        >
          <div className="mx-4 flex min-w-0 items-start gap-3 text-left">
            <span
              className={cn(
                'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-background ring-2 ring-ring',
                isSelected ? 'ring-app-accent shadow' : 'ring-muted-foreground/50',
                isDisabled && 'ring-muted-foreground/30',
              )}
            >
              <item.icon
                className={cn(
                  'size-4',
                  isSelected ? 'text-primary' : 'text-muted-foreground',
                  isDisabled && 'text-muted-foreground/50',
                  item.iconClassName,
                )}
              />
            </span>

            <div className="min-w-0">
              <h3 className="truncate text-lg font-semibold leading-7">{item.title}</h3>
              <p className="my-1 hidden text-start text-sm font-normal leading-tight text-muted-foreground md:block">
                {item.description}
              </p>
            </div>
          </div>
        </button>
      )

      if (isDisabled && item.tooltipLabel) {
        return (
          <Tooltip key={item.key}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent>
              <p>{item.tooltipLabel}</p>
            </TooltipContent>
          </Tooltip>
        )
      }

      return button
    },
    [selectedKey],
  )

  return (
    <div className={cn('flex shrink-0 flex-col', className)}>
      <ul className="flex justify-between p-4 space-y-4 overflow-x-auto shrink-0 flex-col">
        {items.map((item, index) => {
          if (item.type === 'divider') {
            return <li key={`divider-${index}`} className="h-px w-full bg-border" />
          }

          if (item.href && !item.disabled) {
            return (
              <Link href={item.href} key={item.key}>
                {renderButton(item)}
              </Link>
            )
          }

          return renderButton(item)
        })}
      </ul>
    </div>
  )
}
