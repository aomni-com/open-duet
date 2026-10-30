'use client'

import { motion } from 'framer-motion'

import { cn } from '@repo/ui/lib/utils'

import { AgentSprite } from './agent-sprite'
import type { AgentState, WorkstreamState } from './types'
import { WorkstreamIndicator } from './workstream-indicator'

type AgentWorldProps = {
  duetAgent: AgentState
  workstreams: WorkstreamState[]
  reducedMotion: boolean
  className?: string
}

function DotGrid() {
  return (
    <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
      <defs>
        <pattern id="dot-grid" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" fill="rgba(255,255,255,0.06)" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dot-grid)" />
    </svg>
  )
}

export function AgentWorld({ duetAgent, workstreams, reducedMotion, className }: AgentWorldProps) {
  const activeCount = workstreams.filter(w => w.status === 'working').length

  return (
    <div className={cn('relative h-full w-full overflow-hidden', className)}>
      <DotGrid />

      <div className="relative z-10 flex h-full flex-col items-center justify-start gap-3 px-4 pt-1">
        <AgentSprite
          name={duetAgent.name}
          color={duetAgent.color}
          orbColors={duetAgent.orbColors}
          activity={duetAgent.activity}
          expression={duetAgent.expression}
          visible={duetAgent.visible}
          reducedMotion={reducedMotion}
          workingIcon={duetAgent.workingIcon}
          completed={duetAgent.completed}
          orbSize="48px"
          activeWorkstreams={activeCount}
        />

        <div className="flex w-full flex-col gap-y-0.5">
          {workstreams.map((ws, i) => (
            <motion.div
              key={ws.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{
                duration: 0.3,
                delay: i * 0.05,
              }}
            >
              <WorkstreamIndicator workstream={ws} reducedMotion={reducedMotion} />
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  )
}
