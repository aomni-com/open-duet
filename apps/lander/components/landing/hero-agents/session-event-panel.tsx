'use client'

import { AnimatePresence, motion } from 'framer-motion'
import Image from 'next/image'
import { useEffect, useRef } from 'react'

import { SiriOrb } from '@repo/ui/components/21dev/siri-orb'

import { DUET_AGENT } from './agent-animation-data'
import type { SessionEvent } from './types'

type SessionEventPanelProps = {
  events: SessionEvent[]
  label: string
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-0.5">
      {[0, 1, 2].map(i => (
        <motion.div
          key={i}
          className="h-1 w-1 rounded-full bg-white/40"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{
            duration: 1.2,
            repeat: Infinity,
            delay: i * 0.2,
            ease: 'easeInOut',
          }}
        />
      ))}
    </div>
  )
}

function EventAvatar({
  actorKind,
  actorColor,
  actorAvatar,
}: {
  actorKind: 'agent' | 'human'
  actorColor?: string
  actorAvatar?: string
}) {
  if (actorKind === 'agent') {
    return (
      <div className="relative h-6 w-6 shrink-0">
        <SiriOrb size="24px" colors={DUET_AGENT.orbColors} />
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-[2.5px]">
          <div className="relative rounded-full bg-black" style={{ width: 4, height: 5 }}>
            <div
              className="absolute rounded-full bg-white"
              style={{
                width: 1.5,
                height: 1.5,
                top: '18%',
                left: '55%',
                opacity: 0.7,
              }}
            />
          </div>
          <div className="relative rounded-full bg-black" style={{ width: 4, height: 5 }}>
            <div
              className="absolute rounded-full bg-white"
              style={{
                width: 1.5,
                height: 1.5,
                top: '18%',
                left: '55%',
                opacity: 0.7,
              }}
            />
          </div>
        </div>
      </div>
    )
  }

  if (actorAvatar) {
    return (
      <Image
        src={actorAvatar}
        alt=""
        width={24}
        height={24}
        className="h-6 w-6 shrink-0 rounded-full object-cover"
      />
    )
  }

  return (
    <div
      className="h-6 w-6 shrink-0 rounded-full"
      style={{ backgroundColor: actorColor ?? '#6C9CFF' }}
    />
  )
}

export function SessionEventPanel({ events, label }: SessionEventPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const visible = events.slice(-5)
  const visibleVersion = visible
    .map(
      event => `${event.id}:${event.content}:${event.isPending === true ? 'pending' : 'settled'}`,
    )
    .join('\u0000')

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [visibleVersion])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-white/[0.08]">
      <div className="shrink-0 px-3 pt-2 pb-1">
        <div className="text-[10px] font-medium uppercase tracking-wider text-white/30">
          {label}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-2"
      >
        <AnimatePresence mode="popLayout">
          {visible.map(event => {
            const isHuman = event.actorKind === 'human'
            const isAgent = event.actorKind === 'agent'

            return (
              <motion.div
                key={event.id}
                layout
                initial={{
                  opacity: 0,
                  y: 6,
                  x: isAgent ? -8 : isHuman ? 8 : 0,
                  scale: 0.97,
                  filter: 'blur(2px)',
                }}
                animate={{ opacity: 1, y: 0, x: 0, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -4, filter: 'blur(2px)' }}
                transition={{ duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
                className={`flex items-center gap-2 py-0.5 ${isHuman ? 'flex-row-reverse' : ''}`}
              >
                <EventAvatar
                  actorKind={event.actorKind}
                  actorColor={event.actorColor}
                  actorAvatar={event.actorAvatar}
                />
                <div className={`min-w-0 flex-1 ${isHuman ? 'text-right' : ''}`}>
                  <span className="text-[10px] font-medium text-white/70">{event.actorName}</span>
                  {event.isPending ? (
                    <TypingDots />
                  ) : (
                    <p className="text-[11px] leading-snug text-white/50">{event.content}</p>
                  )}
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </div>
  )
}
