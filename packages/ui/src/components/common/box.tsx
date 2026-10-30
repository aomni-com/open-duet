'use client'

import { type Icon } from '@phosphor-icons/react'
import { createElement, type HTMLAttributes, type PropsWithChildren, type ReactNode } from 'react'

import { AnimateDirection } from '@repo/ui/components/common/animate-direction'
import { AnimatedEllipsis } from '@repo/ui/components/common/animate-ellipsis'
import { cn } from '@repo/ui/lib/utils'

type BoxContainerProps = PropsWithChildren<{
  className?: string
}> &
  HTMLAttributes<HTMLDivElement>

function BoxContainer({ children, className, ...props }: BoxContainerProps) {
  return (
    <div
      className={cn('flex flex-col rounded-xl border border-border bg-background p-4', className)}
      {...props}
    >
      {children}
    </div>
  )
}

type BoxTitleProps = {
  icon: Icon
  text: string
  variant?: 'primary' | 'secondary'
  className?: string
  loading?: boolean
  textClassName?: string
  iconClassName?: string
  renderRight?: () => ReactNode
} & HTMLAttributes<HTMLDivElement>

function BoxTitle({
  icon,
  text,
  variant = 'primary',
  loading,
  className,
  textClassName,
  iconClassName,
  renderRight,
  ...props
}: BoxTitleProps) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-row items-center justify-between gap-6',
        variant === 'secondary' && 'text-muted-foreground',
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-center gap-1.5">
        {createElement(icon, {
          className: cn(
            'shrink-0',
            variant === 'primary' && 'size-4 text-blue-500',
            variant === 'secondary' && 'size-3.5 text-muted-foreground',
            iconClassName,
          ),
        })}
        <div
          className={cn(
            'flex flex-row items-center font-medium tracking-tight',
            variant === 'secondary' && 'text-sm font-normal',
            textClassName,
          )}
        >
          {text}

          <AnimateDirection
            direction="forwards"
            className="inline"
            displacementInPx={2}
            changeId={loading ? 'loading' : 'loaded'}
            initial
          >
            {loading ? <AnimatedEllipsis /> : null}
          </AnimateDirection>
        </div>
      </div>

      {renderRight?.()}
    </div>
  )
}

export const Box = {
  Container: BoxContainer,
  Title: BoxTitle,
}
