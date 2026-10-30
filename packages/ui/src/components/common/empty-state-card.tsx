'use client'

import { type Icon } from '@phosphor-icons/react'
import { createElement } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import { Card } from '@repo/ui/components/shadcn/card'
import { cn } from '@repo/ui/lib/utils'

type ActionProps = {
  primaryButton?: {
    label: string
    onClick: () => void
    icon: Icon
  }
  secondaryButton?: {
    label: string
    onClick: () => void
    icon: Icon
  }
}

type FeatureItem = {
  icon: Icon
  iconColorsClassName: string
  title: string
  description: string
  iconContainerClassName?: string
  iconClassName?: string
}

export type EmptyStateCardProps = {
  title: string
  description: string
  icon: Icon
  features?: FeatureItem[]
  size?: 'sm' | 'md' | 'lg'
  className?: string
} & ActionProps

export function EmptyStateCard({
  title,
  description,
  icon,
  primaryButton,
  secondaryButton,
  features,
  size = 'lg',
  className,
}: EmptyStateCardProps) {
  const containerClassName =
    size === 'sm'
      ? 'max-w-md p-4 rounded-lg'
      : size === 'md'
        ? 'max-w-lg p-5 rounded-xl'
        : 'max-w-xl p-6 rounded-xl'

  const iconContainerClassName =
    size === 'sm' ? 'size-10 mb-2' : size === 'md' ? 'size-11 mb-3' : 'size-12 mb-3'
  const iconClassName = size === 'sm' ? 'size-5' : size === 'md' ? 'size-6' : 'size-6'
  const titleClassName = size === 'sm' ? 'text-base' : size === 'md' ? 'text-lg' : 'text-xl'
  const descriptionClassName = size === 'sm' ? 'mb-5 text-sm' : 'mb-8'
  const actionsSize = size === 'sm' ? 'default' : 'lg'

  return (
    <Card
      className={cn(
        // NOTE: disable the "top highlight" in dark mode to avoid a washed-out band.
        'relative w-full overflow-hidden border-none highlight-white dark:[box-shadow:none]',
        containerClassName,
        'bg-background-secondary/25',
        className,
      )}
    >
      <div className="relative z-10 flex flex-col items-center text-center">
        <div
          className={cn(
            'rounded-full bg-primary/10 flex items-center justify-center',
            iconContainerClassName,
          )}
        >
          {createElement(icon, {
            className: cn(iconClassName, 'text-primary'),
          })}
        </div>

        <h2 className={cn(titleClassName, 'font-bold mb-1')}>{title}</h2>

        <p className={cn('text-muted-foreground max-w-lg', descriptionClassName)}>{description}</p>

        {primaryButton || secondaryButton ? (
          <div className="flex flex-row gap-2">
            {primaryButton && (
              <Button
                onClick={primaryButton.onClick}
                size={actionsSize}
                variant="default"
                className="shadow-md hover:shadow-lg transition-shadow"
              >
                {createElement(primaryButton.icon, { className: 'w-4 h-4' })}
                {primaryButton.label}
              </Button>
            )}
            {secondaryButton && (
              <Button
                onClick={secondaryButton.onClick}
                size={actionsSize}
                variant="secondary"
                className="shadow-md hover:shadow-lg transition-shadow"
              >
                {createElement(secondaryButton.icon, { className: 'w-4 h-4' })}
                {secondaryButton.label}
              </Button>
            )}
          </div>
        ) : null}

        {features && features.length > 0 && (
          <div className="mt-8 grid w-full grid-cols-3 gap-2 sm:gap-6">
            {features.map((feature, index) => (
              <div key={index} className="flex flex-col items-center p-2 text-center sm:p-4">
                <div
                  className={cn(
                    'size-12 rounded-full flex items-center justify-center mb-3',
                    feature.iconContainerClassName,
                  )}
                >
                  {createElement(feature.icon, {
                    className: cn('size-7 text-primary', feature.iconColorsClassName),
                  })}
                </div>
                <h3 className="font-medium mb-1">{feature.title}</h3>
                <p className="text-xs text-muted-foreground">{feature.description}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}
