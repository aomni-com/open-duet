'use client'

import { CheckCircle } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'

import { DARK_ICON_PATHS } from './agent-animation-data'
import type { WorkstreamState } from './types'

type WorkstreamIndicatorProps = {
  workstream: WorkstreamState
  reducedMotion: boolean
}

export function WorkstreamIndicator({ workstream, reducedMotion }: WorkstreamIndicatorProps) {
  const [messageIndex, setMessageIndex] = useState(0)
  const prevStatusRef = useRef(workstream.status)

  useEffect(() => {
    if (workstream.status === 'working' && prevStatusRef.current !== 'working') {
      setMessageIndex(0)
    }
    prevStatusRef.current = workstream.status
  }, [workstream.status])

  useEffect(() => {
    if (workstream.status !== 'working') return
    const interval = window.setInterval(() => {
      setMessageIndex(prev => (prev + 1) % workstream.statusMessages.length)
    }, 2000)
    return () => window.clearInterval(interval)
  }, [workstream.status, workstream.statusMessages.length])

  const statusText =
    workstream.status === 'working' ? workstream.statusMessages[messageIndex] : undefined

  const isCompleted = workstream.status === 'completed'

  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      <motion.div
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: workstream.color }}
        animate={
          isCompleted && !reducedMotion
            ? {
                scale: [1, 1.3, 1],
                boxShadow: [
                  `0 0 0px ${workstream.color}00`,
                  `0 0 8px ${workstream.color}`,
                  `0 0 0px ${workstream.color}00`,
                ],
              }
            : { scale: 1 }
        }
        transition={isCompleted ? { duration: 0.4 } : undefined}
      />

      <span className="w-12 shrink-0 truncate text-[10px] font-medium text-white/50">
        {workstream.label}
      </span>

      <div className="min-w-0 flex-1">
        <AnimatePresence mode="wait">
          {statusText && (
            <motion.span
              key={messageIndex}
              className="block truncate text-[10px] text-white/30"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
            >
              {statusText}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="flex h-5 w-5 shrink-0 items-center justify-center">
        <AnimatePresence mode="wait">
          {workstream.status === 'working' && workstream.activeIcon ? (
            <motion.div
              key="working-icon"
              className="flex items-center gap-1"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={
                reducedMotion ? { duration: 0.1 } : { type: 'spring', stiffness: 300, damping: 20 }
              }
            >
              {DARK_ICON_PATHS.has(workstream.activeIcon) ? (
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/40">
                  <Image
                    src={workstream.activeIcon}
                    alt=""
                    width={14}
                    height={14}
                    className="h-3.5 w-3.5 object-contain"
                  />
                </div>
              ) : (
                <Image
                  src={workstream.activeIcon}
                  alt=""
                  width={14}
                  height={14}
                  className="h-3.5 w-3.5 shrink-0 object-contain"
                />
              )}
              {!reducedMotion && (
                <motion.div
                  className="h-3 w-3 rounded-full border-[1.5px] border-transparent"
                  style={{ borderTopColor: workstream.color }}
                  animate={{ rotate: 360 }}
                  transition={{
                    duration: 1.5,
                    repeat: Infinity,
                    ease: 'linear',
                  }}
                />
              )}
            </motion.div>
          ) : workstream.status === 'completed' ? (
            <motion.div
              key="check-icon"
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0 }}
              transition={
                reducedMotion ? { duration: 0.1 } : { type: 'spring', stiffness: 400, damping: 15 }
              }
            >
              <CheckCircle className="h-4 w-4 text-emerald-400" weight="fill" />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}
