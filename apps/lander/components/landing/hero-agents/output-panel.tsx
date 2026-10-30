'use client'

import {
  Check,
  CircleNotch,
  EnvelopeSimple,
  FileText,
  Layout,
  Megaphone,
} from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import Image from 'next/image'
import type { ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

import type { OutputState, OutputType } from './types'

const SOFT_EASE = [0.25, 0.46, 0.45, 0.94] as const

type OutputPanelProps = {
  outputs: OutputState[]
  visibleOutputIds: [string, string]
}

function StatusIndicator({ status }: { status: OutputState['status'] }) {
  if (status === 'completed') {
    return (
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 400, damping: 15 }}
      >
        <Check className="h-3 w-3 text-emerald-400" weight="bold" />
      </motion.div>
    )
  }
  if (status === 'building') {
    return <CircleNotch className="h-3 w-3 animate-spin text-white/40" weight="bold" />
  }
  return <div className="h-3 w-3 rounded-full bg-white/10" />
}

function getOutputIcon(type: OutputType): ReactNode {
  switch (type) {
    case 'dashboard':
      return <Layout className="h-3 w-3 text-white/50" weight="duotone" />
    case 'document':
      return <FileText className="h-3 w-3 text-white/50" weight="duotone" />
    case 'email':
      return <EnvelopeSimple className="h-3 w-3 text-white/50" weight="duotone" />
    case 'social':
      return <Megaphone className="h-3 w-3 text-white/50" weight="duotone" />
  }
}

function ShimmerBar({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div className={cn('relative overflow-hidden', className)} style={style}>
      <div
        className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite]"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.04), transparent)',
        }}
      />
    </div>
  )
}

function DashboardSkeleton({ progress }: { progress: number }) {
  return (
    <div className="flex flex-col gap-1.5 p-2">
      <style jsx>{`
        @keyframes shimmer {
          100% {
            transform: translateX(100%);
          }
        }
      `}</style>

      {/* Header bar */}
      {progress > 0.1 ? (
        <div className="h-2.5 w-3/4 rounded-sm bg-white/15 transition-all duration-700" />
      ) : (
        <ShimmerBar className="h-2.5 w-3/4 rounded-sm bg-white/[0.06]" />
      )}

      {/* Metric cards */}
      <div className="mt-1 flex gap-1.5">
        {[0, 1, 2].map(i => (
          <div
            key={i}
            className={cn(
              'flex-1 rounded-sm p-1.5 transition-all duration-700',
              progress > 0.3 ? 'bg-white/10' : 'bg-white/[0.04]',
            )}
            style={{ transitionDelay: `${i * 80}ms` }}
          >
            <div
              className={cn(
                'mb-1 h-1.5 w-1/2 rounded-sm transition-all duration-700',
                progress > 0.3 ? 'bg-white/20' : 'bg-white/[0.06]',
              )}
              style={{ transitionDelay: `${i * 80 + 40}ms` }}
            />
            <div
              className={cn(
                'h-3 w-3/4 rounded-sm transition-all duration-700',
                progress > 0.3 ? 'bg-white/15' : 'bg-white/[0.04]',
              )}
              style={{ transitionDelay: `${i * 80 + 80}ms` }}
            />
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div className="mt-1.5 flex items-end gap-1 h-10">
        {[0.7, 0.45, 0.9, 0.6].map((maxH, i) => {
          const barProgress = Math.max(0, Math.min(1, (progress - 0.4) / 0.4))
          const height = barProgress * maxH * 100
          return (
            <div
              key={i}
              className="flex-1 rounded-t-sm"
              style={{
                height: `${height}%`,
                backgroundColor:
                  progress > 0.4
                    ? `rgba(108, 156, 255, ${0.2 + barProgress * 0.3})`
                    : 'rgba(255,255,255,0.04)',
                transition: `height 800ms cubic-bezier(0.16, 1, 0.3, 1), background-color 700ms ease`,
                transitionDelay: `${i * 80}ms`,
              }}
            />
          )
        })}
      </div>

      {/* Table rows */}
      <div className="mt-1.5 flex flex-col gap-1">
        {[0, 1, 2].map(i => (
          <div
            key={i}
            className={cn(
              'h-2 rounded-sm transition-all duration-700',
              progress > 0.8 ? 'bg-white/10' : 'bg-white/[0.03]',
            )}
            style={{
              width: `${progress > 0.8 ? 60 + i * 12 : 100}%`,
              opacity: progress > 0.8 ? 1 : 0.3,
              transitionDelay: `${i * 100}ms`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

const PRD_LINES = [
  'Product Requirements Document',
  '',
  'Overview',
  'Duet AI launches Q2 with full agent orchestration...',
  '',
  'Key Goals',
  '\u2022 Expand to 3 new market segments',
  '\u2022 Achieve $4.2B TAM coverage',
  '\u2022 Ship 5 integration partners',
  '',
  'Timeline',
  'Phase 1: Internal beta (Week 1-2)',
  'Phase 2: Public launch (Week 3-4)',
]

function DocumentContent({ progress }: { progress: number }) {
  const totalLines = PRD_LINES.length

  return (
    <div className="flex flex-col gap-0 p-3 pt-4">
      {PRD_LINES.map((line, i) => {
        const threshold = i / totalLines
        const visible = progress > threshold

        if (line === '') {
          return <div key={i} className="h-1.5" style={{ opacity: visible ? 1 : 0 }} />
        }

        const isHeading =
          i === 0 || line === 'Overview' || line === 'Key Goals' || line === 'Timeline'

        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : 4 }}
            transition={{ duration: 0.4, ease: SOFT_EASE }}
          >
            <p
              className={cn(
                'leading-relaxed',
                isHeading ? 'text-[10px] font-medium text-white/60' : 'text-[9px] text-white/40',
              )}
            >
              {line}
            </p>
          </motion.div>
        )
      })}
    </div>
  )
}

const EMAIL_LINES = [
  'Hi team,',
  '',
  'Quick update on the Q2 launch prep:',
  '',
  '\u2022 Dashboard and PRD are finalized',
  '\u2022 GTM timeline approved by leadership',
  '\u2022 All integration partners confirmed',
  '',
  'Next steps: Review the launch checklist',
  'and confirm go/no-go by Friday EOD.',
  '',
  'Best,',
  'Chief of Staff Agent',
]

function EmailContent({ progress }: { progress: number }) {
  return (
    <div className="flex flex-col gap-0 p-2">
      {/* To field */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: progress > 0.05 ? 1 : 0, y: progress > 0.05 ? 0 : 4 }}
        transition={{ duration: 0.4, ease: SOFT_EASE }}
        className="flex items-center gap-1 border-b border-white/[0.06] pb-1 mb-1"
      >
        <span className="text-[9px] text-white/30">To:</span>
        <span className="text-[9px] text-white/50">team@company.com</span>
      </motion.div>

      {/* Subject field */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: progress > 0.1 ? 1 : 0, y: progress > 0.1 ? 0 : 4 }}
        transition={{ duration: 0.4, ease: SOFT_EASE }}
        className="flex items-center gap-1 border-b border-white/[0.06] pb-1 mb-1.5"
      >
        <span className="text-[9px] text-white/30">Subj:</span>
        <span className="text-[9px] font-medium text-white/60">Q2 Launch — Stakeholder Update</span>
      </motion.div>

      {/* Body lines */}
      {EMAIL_LINES.map((line, i) => {
        const threshold = 0.15 + (i / EMAIL_LINES.length) * 0.75
        const visible = progress > threshold

        if (line === '') {
          return <div key={i} className="h-1.5" style={{ opacity: visible ? 1 : 0 }} />
        }

        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : 4 }}
            transition={{ duration: 0.4, ease: SOFT_EASE }}
          >
            <p className="text-[9px] leading-relaxed text-white/40">{line}</p>
          </motion.div>
        )
      })}
    </div>
  )
}

function SocialPostContent({ progress }: { progress: number }) {
  return (
    <div className="flex flex-col gap-0 p-2">
      {/* Profile row */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: progress > 0.05 ? 1 : 0, y: progress > 0.05 ? 0 : 4 }}
        transition={{ duration: 0.4, ease: SOFT_EASE }}
        className="flex items-center gap-1.5 mb-1"
      >
        <div className="h-4 w-4 rounded-full bg-gradient-to-br from-blue-400/50 to-blue-600/50" />
        <div className="flex flex-col">
          <a
            href="https://x.com/duetchat"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[9px] font-medium text-white/60 hover:text-white/80 transition-colors"
          >
            @duetchat
          </a>
          <span className="text-[8px] text-white/30">12,480 followers</span>
        </div>
      </motion.div>

      {/* Post text — short caption */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: progress > 0.1 ? 1 : 0, y: progress > 0.1 ? 0 : 4 }}
        transition={{ duration: 0.4, ease: SOFT_EASE }}
        className="mb-1.5"
      >
        <p className="text-[9px] leading-relaxed text-white/45">
          We just shipped our new product in a day. Here&apos;s how.
        </p>
      </motion.div>

      {/* 1:1 image card — dark branded announcement */}
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 4 }}
        animate={{
          opacity: progress > 0.15 ? 1 : 0,
          scale: progress > 0.15 ? 1 : 0.97,
          y: progress > 0.15 ? 0 : 4,
        }}
        transition={{ duration: 0.5, ease: SOFT_EASE }}
        className="relative mb-1.5 aspect-square w-full overflow-hidden rounded-md border border-white/[0.08] bg-[#0a0c14]"
      >
        {/* Subtle diagonal gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/[0.06] to-purple-500/[0.06]" />

        {/* Card content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6">
          {/* Eclipse logo */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: progress > 0.15 ? 1 : 0 }}
            transition={{ duration: 0.4, ease: SOFT_EASE }}
          >
            <Image
              src="/landing/icons/eclipse-white.svg"
              alt="Duet"
              width={36}
              height={36}
              className="opacity-60"
            />
          </motion.div>

          {/* Top badge */}
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: progress > 0.2 ? 1 : 0, y: progress > 0.2 ? 0 : 4 }}
            transition={{ duration: 0.4, ease: SOFT_EASE }}
            className="flex items-center rounded-full bg-white/10 px-2.5 py-1"
          >
            <span className="text-[9px] leading-none font-medium text-white/50">February 2026</span>
          </motion.div>

          {/* Headline */}
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: progress > 0.3 ? 1 : 0, y: progress > 0.3 ? 0 : 4 }}
            transition={{ duration: 0.4, ease: SOFT_EASE }}
          >
            <p className="text-[16px] font-bold text-white/80">Product Launch</p>
          </motion.div>

          {/* Divider */}
          <motion.div
            initial={{ opacity: 0, scaleX: 0 }}
            animate={{ opacity: progress > 0.4 ? 1 : 0, scaleX: progress > 0.4 ? 1 : 0 }}
            transition={{ duration: 0.5, ease: SOFT_EASE }}
            className="h-px w-10 bg-white/10"
          />

          {/* Subtitle */}
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: progress > 0.5 ? 1 : 0, y: progress > 0.5 ? 0 : 4 }}
            transition={{ duration: 0.4, ease: SOFT_EASE }}
          >
            <a
              href="https://x.com/duetchat"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-white/40 hover:text-white/60 transition-colors"
            >
              @duetchat
            </a>
          </motion.div>

          {/* Bottom accent dots */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: progress > 0.6 ? 1 : 0 }}
            transition={{ duration: 0.4, ease: SOFT_EASE }}
            className="flex gap-1.5 pt-1"
          >
            {['#6C9CFF', '#34D399', '#A78BFA', '#F59E0B'].map((color, i) => (
              <div
                key={i}
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: color }}
              />
            ))}
          </motion.div>
        </div>
      </motion.div>

      {/* Engagement row */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: progress > 0.7 ? 1 : 0 }}
        transition={{ duration: 0.4, ease: SOFT_EASE }}
        className="flex items-center gap-3"
      >
        <span className="text-[8px] text-white/30">847 reactions</span>
        <span className="text-[8px] text-white/30">63 comments</span>
        <span className="text-[8px] text-white/30">28 reposts</span>
      </motion.div>
    </div>
  )
}

function OutputBoxContent({ type, progress }: { type: OutputType; progress: number }) {
  switch (type) {
    case 'dashboard':
      return <DashboardSkeleton progress={progress} />
    case 'document':
      return <DocumentContent progress={progress} />
    case 'email':
      return <EmailContent progress={progress} />
    case 'social':
      return <SocialPostContent progress={progress} />
  }
}

export function OutputBox({ output }: { output: OutputState }) {
  const isBuilding = output.status === 'building'

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-white/[0.03] transition-all duration-700',
        isBuilding
          ? 'border-white/[0.12] shadow-[0_0_16px_rgba(108,156,255,0.06)]'
          : 'border-white/[0.08]',
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-2.5 py-1.5">
        {getOutputIcon(output.type)}
        <span className="flex-1 truncate text-[10px] font-medium text-white/60">
          {output.title}
        </span>
        <StatusIndicator status={output.status} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <OutputBoxContent type={output.type} progress={output.progress} />
      </div>
    </div>
  )
}

export function OutputPanel({ outputs, visibleOutputIds }: OutputPanelProps) {
  const visibleOutputs = visibleOutputIds.map(id => outputs.find(o => o.id === id))

  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {visibleOutputs.map((output, slotIndex) => (
          <AnimatePresence mode="wait" key={`slot-${slotIndex}`}>
            {output && (
              <motion.div
                key={output.id}
                className="flex min-h-0 flex-1"
                initial={{ opacity: 0, y: 16, scale: 0.97, filter: 'blur(4px)' }}
                animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -12, scale: 0.98, filter: 'blur(4px)' }}
                transition={{ duration: 0.4, ease: SOFT_EASE }}
              >
                <OutputBox output={output} />
              </motion.div>
            )}
          </AnimatePresence>
        ))}
      </div>
    </div>
  )
}
