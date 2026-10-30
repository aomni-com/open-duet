'use client'

import { MotionConfig } from 'framer-motion'
import type { ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { DEMO_SPRING_CONFIG } from './animation-config'

type DemoContainerProps = {
  title?: string
  subtitle?: string
  children: ReactNode
  className?: string
  headerClassName?: string
  contentClassName?: string
}

export function DemoContainer({
  title,
  subtitle,
  children,
  className,
  headerClassName,
  contentClassName,
}: DemoContainerProps) {
  return (
    <MotionConfig transition={DEMO_SPRING_CONFIG}>
      <div
        className={cn(
          'flex h-full w-full flex-col overflow-hidden rounded-xl bg-gradient-to-b from-white/[0.08] to-white/[0.03] backdrop-blur-sm',
          className,
        )}
      >
        {(title || subtitle) && (
          <header
            className={cn(
              'flex items-center justify-between border-b border-white/10 px-5 py-3',
              headerClassName,
            )}
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="h-3 w-3 rounded-full bg-white/10" />
                <div className="h-3 w-3 rounded-full bg-white/10" />
                <div className="h-3 w-3 rounded-full bg-white/10" />
              </div>
              <div className="h-4 w-px bg-white/10" />
              <div>
                {subtitle && (
                  <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-white/40">
                    {subtitle}
                  </p>
                )}
                {title && <p className="text-xs font-medium text-white/70">{title}</p>}
              </div>
            </div>
          </header>
        )}

        <div
          className={cn(
            'flex-1 min-h-0 overflow-hidden p-5',
            !title && !subtitle && 'p-5',
            contentClassName,
          )}
        >
          {children}
        </div>
      </div>
    </MotionConfig>
  )
}
