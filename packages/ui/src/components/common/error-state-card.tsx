'use client'

import { ArrowClockwise, WarningCircle, type Icon } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { createElement } from 'react'

import { AnimatedBlobs } from '@repo/ui/components/common/animated-blobs'
import { Button } from '@repo/ui/components/shadcn/button'
import { Card } from '@repo/ui/components/shadcn/card'
import { cn } from '@repo/ui/lib/utils'

type ActionProps = {
  retryButton?: {
    label?: string
    onClick: () => void
    icon?: Icon
  }
  secondaryButton?: {
    label: string
    onClick: () => void
    icon: Icon
  }
}

export type ErrorStateCardProps = {
  title: string
  description: string
  icon?: Icon
  error?: Error | string
  showErrorDetails?: boolean
  className?: string
} & ActionProps

export function ErrorStateCard({
  title,
  description,
  icon = WarningCircle,
  retryButton,
  secondaryButton,
  error,
  showErrorDetails = false,
  className,
}: ErrorStateCardProps) {
  const errorMessage = typeof error === 'string' ? error : error?.message

  return (
    <Card
      className={cn(
        'relative w-full max-w-xl p-6 rounded-xl shadow-xl border border-destructive/20 overflow-hidden',
        'bg-destructive/5',
        className,
      )}
    >
      <AnimatedBlobs opacity={0.12} />
      <motion.div
        className="relative z-10 flex flex-col items-center text-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.5 }}
      >
        <div className="size-12 rounded-full bg-destructive/15 flex items-center justify-center mb-3">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{
              delay: 0.4,
              duration: 0.6,
              type: 'spring',
              stiffness: 200,
            }}
          >
            {createElement(icon, {
              className: 'size-6 text-destructive',
            })}
          </motion.div>
        </div>

        <motion.h2
          className="text-xl font-bold mb-1"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.5 }}
        >
          {title}
        </motion.h2>

        <motion.p
          className="text-muted-foreground max-w-lg mb-4"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.5 }}
        >
          {description}
        </motion.p>

        {showErrorDetails && errorMessage && (
          <motion.div
            className="w-full mb-6 mt-2"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7, duration: 0.5 }}
          >
            <pre className="text-xs text-destructive/90 bg-destructive/10 p-3 rounded-md whitespace-pre-wrap max-h-32 text-center">
              {errorMessage}
            </pre>
          </motion.div>
        )}

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8, duration: 0.5 }}
          className="flex flex-row gap-2"
        >
          {retryButton && (
            <Button
              onClick={retryButton.onClick}
              size="lg"
              className="shadow-md hover:shadow-lg transition-shadow"
              variant="destructive"
            >
              {createElement(retryButton.icon || ArrowClockwise, {
                className: 'w-4 h-4 mr-2',
              })}
              {retryButton.label || 'Retry'}
            </Button>
          )}
          {secondaryButton && (
            <Button
              onClick={secondaryButton.onClick}
              size="lg"
              variant="outline"
              className="shadow-md hover:shadow-lg transition-shadow"
            >
              {createElement(secondaryButton.icon, {
                className: 'w-4 h-4 mr-2',
              })}
              {secondaryButton.label}
            </Button>
          )}
        </motion.div>
      </motion.div>
    </Card>
  )
}
