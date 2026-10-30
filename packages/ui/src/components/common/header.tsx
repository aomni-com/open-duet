'use client'

import { ArrowLeft, type Icon } from '@phosphor-icons/react'
import Link from 'next/link'
import { createElement, type ReactNode } from 'react'

import { BetaBadge } from '@repo/ui/components/common/beta-badge'
import { Button, type ButtonProps } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { Skeleton } from '../shadcn/skeleton'

function BackButton({
  className,
  label,
  ...props
}: Omit<ButtonProps, 'variant'> & { label?: string }) {
  return (
    <Button
      variant="ghost"
      className={cn(
        'p-0 hover:scale-105 transition-transform duration-200',
        !label ? 'size-8' : 'h-8',
        className,
      )}
      {...props}
    >
      <ArrowLeft className="size-4" />
      {label && <span className="text-xs">{label}</span>}
    </Button>
  )
}

type WithBackButtonAndClick = {
  onBackClick: () => void
  href?: never
  backButtonLabel?: string
  hasBackButton: true
}

type WithBackButtonAndHref = {
  onBackClick?: never
  href: string
  backButtonLabel?: string
  hasBackButton: true
}

type WithoutBackButton = {
  onBackClick?: never
  href?: never
  backButtonLabel?: never
  hasBackButton?: false
}

type Props = {
  title: string
  icon?: Icon
  isBeta?: boolean
  isLoading?: boolean
  hasBackButton?: boolean
  children?: ReactNode
  className?: string
  hideBottomBorder?: boolean
  variant?: 'default' | 'transparent-border'
  rightContent?: ReactNode
  leftContent?: ReactNode
  renderContent?: () => ReactNode
  renderRightTitle?: () => ReactNode
  titleClassName?: string
} & (WithBackButtonAndClick | WithBackButtonAndHref | WithoutBackButton)

export function Header({
  title,
  icon,
  isBeta,
  isLoading,
  hasBackButton,
  children,
  href,
  className,
  onBackClick,
  backButtonLabel,
  variant = 'default',
  rightContent,
  leftContent,
  renderContent,
  renderRightTitle,
  titleClassName,
}: Props) {
  return (
    <div
      className={cn(
        'flex min-h-14 flex-row items-center justify-between bg-card py-2 transition-all duration-200',
        variant === 'default' && 'border-b',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-row items-center px-3 sm:px-6">
        {hasBackButton && onBackClick ? (
          <div className={cn(backButtonLabel ? 'mr-3' : 'mr-1')}>
            <BackButton onClick={onBackClick} label={backButtonLabel} />
          </div>
        ) : null}

        {hasBackButton && href ? (
          <div className={cn(backButtonLabel ? 'mr-3' : 'mr-1')}>
            <Link href={href}>
              <BackButton label={backButtonLabel} />
            </Link>
          </div>
        ) : null}

        {leftContent && <div className="flex items-center mr-2">{leftContent}</div>}

        {icon
          ? createElement(icon, {
              className: cn('mr-2 hidden size-5 sm:block'),
            })
          : null}

        {isLoading ? (
          <Skeleton className="h-5 w-24" />
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            {renderContent ? (
              renderContent()
            ) : (
              <>
                <h2
                  className={cn(
                    'line-clamp-2 text-sm font-semibold leading-tight sm:text-base',
                    titleClassName,
                  )}
                >
                  {title}
                </h2>
                {isBeta ? <BetaBadge className="relative bottom-px shrink-0" /> : null}
                {renderRightTitle ? renderRightTitle() : null}
              </>
            )}
            {children}
          </div>
        )}
      </div>

      {rightContent && (
        <div className="flex shrink-0 items-center justify-end gap-2 pr-3 sm:pr-6">
          {rightContent}
        </div>
      )}
    </div>
  )
}
