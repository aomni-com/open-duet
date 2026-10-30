'use client'

import { AnimatePresence, motion, MotionConfig, useInView } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { usePrefersMotion } from '@/components/landing/feature-demos/hooks/use-prefers-motion'
import { DemoContainer } from '@/components/landing/feature-demos/shared/demo-container'

import { AgentWorld } from './agent-world'
import { OutputBox, OutputPanel } from './output-panel'
import { SessionEventPanel } from './session-event-panel'
import type { HeroAgentVizProps } from './types'
import { useAgentTimeline } from './use-agent-timeline'

export function HeroAgentViz({
  layout = 'desktop',
  className,
  sessionEventsLabel = 'Session events',
}: HeroAgentVizProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(containerRef, { once: false, amount: 0.3 })
  const hasBeenInView = useRef(false)

  // Latch: once in view, start animations. Reset on re-entry so the cycle restarts fresh.
  if (isInView && !hasBeenInView.current) {
    hasBeenInView.current = true
  }

  const { prefersReducedMotion } = usePrefersMotion()

  const { duetAgent, workstreams, sessionEvents, outputs, visibleOutputIds } = useAgentTimeline({
    prefersReducedMotion,
    layout,
    isActive: hasBeenInView.current && isInView,
  })

  const isMobile = layout === 'mobile'
  const panelHeightClass = isMobile ? 'h-[360px]' : 'h-[620px]'

  const [activeQuadrant, setActiveQuadrant] = useState(0)

  useEffect(() => {
    if (!isMobile || !isInView) return
    const interval = setInterval(() => {
      setActiveQuadrant(prev => (prev + 1) % 4)
    }, 2500)
    return () => clearInterval(interval)
  }, [isMobile, isInView])

  const output0 = useMemo(
    () => outputs.find(o => o.id === visibleOutputIds[0]),
    [outputs, visibleOutputIds],
  )
  const output1 = useMemo(
    () => outputs.find(o => o.id === visibleOutputIds[1]),
    [outputs, visibleOutputIds],
  )

  const mobileQuadrantContent = useMemo(() => {
    switch (activeQuadrant) {
      case 0:
        return (
          <div className="flex h-full items-center justify-center">
            <AgentWorld
              duetAgent={duetAgent}
              workstreams={workstreams}
              reducedMotion={prefersReducedMotion}
              className="h-full w-full"
            />
          </div>
        )
      case 1:
        return (
          <div className="flex h-full items-center justify-center">
            <SessionEventPanel events={sessionEvents} label={sessionEventsLabel} />
          </div>
        )
      case 2:
        return output0 ? (
          <div className="flex h-full items-center justify-center p-4">
            <div className="w-full max-h-full overflow-hidden">
              <OutputBox output={output0} />
            </div>
          </div>
        ) : null
      case 3:
        return output1 ? (
          <div className="flex h-full items-center justify-center p-4">
            <div className="w-full max-h-full overflow-hidden">
              <OutputBox output={output1} />
            </div>
          </div>
        ) : null
    }
  }, [
    activeQuadrant,
    duetAgent,
    workstreams,
    prefersReducedMotion,
    sessionEvents,
    sessionEventsLabel,
    output0,
    output1,
  ])

  return (
    <MotionConfig
      transition={{
        type: 'spring',
        stiffness: 200,
        damping: 24,
        mass: 0.9,
      }}
    >
      <div
        ref={containerRef}
        className={cn(
          'flex w-full flex-col overflow-hidden rounded-3xl border border-white/10 bg-white/5 shadow-[0_24px_80px_rgba(8,10,20,0.55)] backdrop-blur',
          panelHeightClass,
          className,
        )}
      >
        <DemoContainer
          title="Duet Agent Workspace"
          subtitle="Running"
          className="h-full !rounded-none border-none bg-transparent"
          contentClassName="!p-0"
        >
          {isMobile ? (
            <div className="flex h-full flex-col">
              <div className="relative min-h-0 flex-1">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeQuadrant}
                    className="absolute inset-0"
                    initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -12 }}
                    transition={{ duration: 0.3, ease: 'easeInOut' }}
                  >
                    {mobileQuadrantContent}
                  </motion.div>
                </AnimatePresence>
              </div>
              <div className="flex shrink-0 items-center justify-center gap-1.5 pb-3 pt-2">
                {[0, 1, 2, 3].map(i => (
                  <div
                    key={i}
                    className={cn(
                      'h-1.5 w-1.5 rounded-full transition-colors duration-300',
                      i === activeQuadrant ? 'bg-white/60' : 'bg-white/15',
                    )}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-0">
              <div className="flex w-1/2 flex-col min-h-0">
                <AgentWorld
                  duetAgent={duetAgent}
                  workstreams={workstreams}
                  reducedMotion={prefersReducedMotion}
                  className="h-1/2 shrink-0"
                />
                <SessionEventPanel events={sessionEvents} label={sessionEventsLabel} />
              </div>
              <div className="w-1/2 min-h-0 border-l border-white/10">
                <OutputPanel outputs={outputs} visibleOutputIds={visibleOutputIds} />
              </div>
            </div>
          )}
        </DemoContainer>
      </div>
    </MotionConfig>
  )
}
