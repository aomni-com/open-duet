'use client'

import { CheckCircle } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import Image from 'next/image'
import { useCallback, useEffect, useRef, useState } from 'react'

import { SiriOrb } from '@repo/ui/components/21dev/siri-orb'

import type { AgentActivity, AgentExpression } from './types'

type AgentSpriteProps = {
  name: string
  color: string
  orbColors: { c1: string; c2: string; c3: string }
  activity: AgentActivity
  expression: AgentExpression
  visible: boolean
  reducedMotion: boolean
  workingIcon: string | null
  completed: boolean
  orbSize?: string
  activeWorkstreams?: number
}

const BLINK_DURATION = 150
const MAX_EYE_SHIFT = 3

function AgentFace({
  expression,
  activity,
  reducedMotion,
}: {
  expression: AgentExpression
  activity: AgentActivity
  reducedMotion: boolean
}) {
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isBlinking, setIsBlinking] = useState(false)
  const lookTimerRef = useRef<number | null>(null)
  const blinkTimerRef = useRef<number | null>(null)

  const scheduleLook = useCallback(() => {
    const delay = 1000 + Math.random() * 3000
    lookTimerRef.current = window.setTimeout(() => {
      const angle = Math.random() * Math.PI * 2
      const dist = (0.5 + Math.random() * 0.5) * MAX_EYE_SHIFT
      setPosition({ x: Math.cos(angle) * dist, y: Math.sin(angle) * dist })
      scheduleLook()
    }, delay)
  }, [])

  const scheduleBlink = useCallback(() => {
    const delay = 2000 + Math.random() * 4000
    blinkTimerRef.current = window.setTimeout(() => {
      setIsBlinking(true)
      window.setTimeout(() => setIsBlinking(false), BLINK_DURATION)
      scheduleBlink()
    }, delay)
  }, [])

  useEffect(() => {
    if (reducedMotion) return
    scheduleLook()
    scheduleBlink()
    return () => {
      if (lookTimerRef.current) window.clearTimeout(lookTimerRef.current)
      if (blinkTimerRef.current) window.clearTimeout(blinkTimerRef.current)
    }
  }, [reducedMotion, scheduleLook, scheduleBlink])

  useEffect(() => {
    if (activity === 'idle') {
      setPosition({ x: 0, y: 0 })
    }
  }, [activity])

  const scaleY = isBlinking
    ? 0.1
    : expression === 'focused'
      ? 0.9
      : expression === 'happy'
        ? 1.1
        : 1

  const transitionDuration = isBlinking ? BLINK_DURATION : 200

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center gap-[5px]">
      {[0, 1].map(i => (
        <div
          key={i}
          className="relative rounded-full bg-black"
          style={{
            width: 8,
            height: 10,
            transform: `translate(${position.x * 0.4}px, ${position.y * 0.4}px) scaleY(${scaleY})`,
            transition: `transform ${transitionDuration}ms ease`,
          }}
        >
          <div
            className="absolute rounded-full bg-white"
            style={{
              width: 3,
              height: 3,
              top: '18%',
              left: '55%',
              opacity: 0.7,
            }}
          />
        </div>
      ))}
    </div>
  )
}

function getOrbDuration(activeWorkstreams: number): number {
  if (activeWorkstreams >= 3) return 10
  if (activeWorkstreams >= 1) return 14
  return 20
}

export function AgentSprite({
  name,
  color,
  orbColors,
  activity,
  expression,
  visible,
  reducedMotion,
  workingIcon,
  completed,
  orbSize = '40px',
  activeWorkstreams = 0,
}: AgentSpriteProps) {
  const animationDuration = getOrbDuration(activeWorkstreams)

  return (
    <motion.div
      className="flex flex-col items-center"
      initial={{ scale: 0, opacity: 0 }}
      animate={{
        scale: visible ? 1 : 0,
        opacity: visible ? 1 : 0,
      }}
      transition={
        reducedMotion
          ? { duration: 0.1 }
          : { type: 'spring', stiffness: 200, damping: 20, mass: 0.8 }
      }
    >
      {/* Floating icon area — fixed height to prevent layout shift */}
      <div className="mb-1.5 flex h-7 items-center justify-center">
        <AnimatePresence mode="wait">
          {workingIcon ? (
            <motion.div
              key="working-icon"
              className="flex items-center gap-1"
              initial={{ opacity: 0, y: 4, scale: 0.8, filter: 'blur(2px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -4, scale: 0.8, filter: 'blur(2px)' }}
              transition={
                reducedMotion ? { duration: 0.1 } : { type: 'spring', stiffness: 300, damping: 20 }
              }
            >
              <Image
                src={workingIcon}
                alt=""
                width={18}
                height={18}
                className="h-[18px] w-[18px] object-contain"
              />
              {!reducedMotion && (
                <motion.div
                  className="h-3.5 w-3.5 rounded-full border-[1.5px] border-transparent"
                  style={{ borderTopColor: color }}
                  animate={{ rotate: 360 }}
                  transition={{
                    duration: 1.5,
                    repeat: Infinity,
                    ease: 'linear',
                  }}
                />
              )}
            </motion.div>
          ) : completed ? (
            <motion.div
              key="check-icon"
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0 }}
              transition={
                reducedMotion ? { duration: 0.1 } : { type: 'spring', stiffness: 400, damping: 15 }
              }
            >
              <CheckCircle className="h-5 w-5 text-emerald-400" weight="fill" />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <motion.div
        className="relative"
        animate={!reducedMotion && activity === 'idle' ? { scale: [1, 1.02, 1] } : { scale: 1 }}
        transition={
          activity === 'idle' ? { duration: 3, repeat: Infinity, ease: 'easeInOut' } : undefined
        }
      >
        <SiriOrb size={orbSize} animationDuration={animationDuration} colors={orbColors} />
        <AgentFace expression={expression} activity={activity} reducedMotion={reducedMotion} />
      </motion.div>

      <span className="mt-1.5 text-[10px] font-medium text-white/60">{name}</span>
    </motion.div>
  )
}
