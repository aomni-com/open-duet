'use client'

import {
  ArrowRightIcon,
  BrainIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  EnvelopeSimpleIcon,
  FileTextIcon,
  FlowArrowIcon,
  FolderIcon,
  type Icon,
  SparkleIcon,
  WaveformIcon,
  WrenchIcon,
} from '@phosphor-icons/react'
import { animate, motion } from 'framer-motion'
import { type CSSProperties, useEffect, useState } from 'react'

import type { AppLocale } from '@/lib/i18n/locales'

/** Every scene paints from `--facet-accent`, injected per source on the panel
 * root, so the whole card recolours to the live source instead of reading blue
 * end to end. `ACCENT` is the var (with a blue fallback); `mix` tints it. */
const ACCENT = 'var(--facet-accent, #3a86e0)'
const mix = (pct: number) => `color-mix(in srgb, ${ACCENT} ${pct}%, transparent)`

/** Which bespoke scene a source label maps to, resolved by keyword so any
 * per-lander feed, in either language, still lands on the right animation
 * without extra config. */
type FacetKind = 'files' | 'tone' | 'tools' | 'data' | 'memory' | 'workflows' | 'generic'
const FACET_KEYWORDS: readonly [FacetKind, readonly string[]][] = [
  ['files', ['file', 'doc', 'folder', 'archivo', 'carpeta']],
  ['tone', ['tone', 'voice', 'style', 'tono', 'voz', 'estilo']],
  ['tools', ['tool', 'stack', 'api', 'herramienta']],
  ['memory', ['memory', 'remember', 'recall', 'memoria']],
  ['workflows', ['workflow', 'playbook', 'process', 'steps', 'proceso', 'flujo']],
  ['data', ['data', 'context', 'dato', 'contexto']],
]
function facetKind(label: string): FacetKind {
  const l = label.toLowerCase()
  return FACET_KEYWORDS.find(([, words]) => words.some(w => l.includes(w)))?.[0] ?? 'generic'
}

/** One hue per source — blue / violet / teal / amber / rose / green — shared
 * with the globe's particle channels and the chips so the colour story stays in
 * sync. */
const ACCENTS: Record<FacetKind, string> = {
  files: '#3a86e0',
  tone: '#a274ec',
  tools: '#2bc0ad',
  data: '#f5a524',
  memory: '#ec6a9c',
  workflows: '#59b872',
  generic: '#3a86e0',
}

/** Resolve a feed label to its source accent (used by the chips + panel). */
export function facetAccent(label: string): string {
  return ACCENTS[facetKind(label)]
}

const HEADER_ICON: Record<FacetKind, Icon> = {
  files: FolderIcon,
  tone: WaveformIcon,
  tools: WrenchIcon,
  data: DatabaseIcon,
  memory: BrainIcon,
  workflows: FlowArrowIcon,
  generic: SparkleIcon,
}

/** Resolve a feed label to its glyph (used by the chips + panel header). */
export function facetIcon(label: string): Icon {
  return HEADER_ICON[facetKind(label)]
}

/** The words inside the scenes, per language. The scenes are a demo of a
 * made-up account (Acme), so only the prose translates; file names, brands,
 * and figures stay as they are. */
type SceneText = {
  firstFile: string
  toneBefore: string
  toneAfter: string
  liveRecord: string
  dataRows: readonly { k: string; v: string }[]
  sessions: readonly string[]
  memoryNow: string
  steps: readonly string[]
}

const SCENE_TEXT: Record<AppLocale, SceneText> = {
  en: {
    firstFile: 'Acme thread.eml',
    toneBefore: 'Dear Sir or Madam, I hope this email finds you well.',
    toneAfter: 'Hey Sam — quick follow-up on Acme 👋',
    liveRecord: 'Live record',
    dataRows: [
      { k: 'Account', v: 'Acme Inc.' },
      { k: 'Plan', v: 'Enterprise' },
      { k: 'Seats', v: '48 active' },
    ],
    sessions: ['Tue · shipped pricing-v3', 'Wed · drafted Acme reply', 'Thu · reviewed the deck'],
    memoryNow: 'Picks up right where you left off',
    steps: ['Pull the Acme thread', 'Draft in your voice', 'Queue for approval'],
  },
  'es-419': {
    firstFile: 'hilo Acme.eml',
    toneBefore: 'Estimado señor o señora, espero que se encuentre muy bien.',
    toneAfter: 'Hola Sam, te escribo rápido sobre Acme 👋',
    liveRecord: 'Registro en vivo',
    dataRows: [
      { k: 'Cuenta', v: 'Acme Inc.' },
      { k: 'Plan', v: 'Enterprise' },
      { k: 'Licencias', v: '48 activas' },
    ],
    sessions: [
      'mar · publicó pricing-v3',
      'mié · redactó la respuesta a Acme',
      'jue · revisó la presentación',
    ],
    memoryNow: 'Retoma justo donde lo dejaste',
    steps: ['Trae el hilo de Acme', 'Redacta con tu voz', 'Deja listo para aprobar'],
  },
}

type SceneProps = { reduce: boolean; text: SceneText }

/* --------------------------------------------------------------------------
 * Scene 1 — your files: a scan line sweeps a stack of your docs; each row
 * lights up, fills a read-progress bar, and checks off as it's ingested.
 * ------------------------------------------------------------------------ */
const FILES = (text: SceneText) =>
  [
    { name: text.firstFile, Glyph: EnvelopeSimpleIcon },
    { name: 'pricing-v3.pdf', Glyph: FileTextIcon },
    { name: 'brand-guide.md', Glyph: FileTextIcon },
  ] as const

function FilesScene({ reduce, text }: SceneProps) {
  return (
    <div className="relative space-y-1.5">
      {!reduce && (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-7 rounded-lg"
          style={{
            background: `linear-gradient(180deg, transparent, ${mix(22)}, transparent)`,
          }}
          initial={{ y: -6, opacity: 0 }}
          animate={{ y: [-6, 74, -6], opacity: [0, 0.9, 0] }}
          transition={{
            duration: 2.6,
            repeat: Infinity,
            ease: 'easeInOut',
            times: [0, 0.5, 1],
          }}
        />
      )}
      {FILES(text).map((f, i) => (
        <motion.div
          key={f.name}
          className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5"
          style={{ borderColor: mix(16), backgroundColor: mix(5) }}
          initial={reduce ? false : { opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{
            delay: 0.08 + i * 0.13,
            type: 'spring',
            stiffness: 300,
            damping: 22,
          }}
        >
          <f.Glyph weight="fill" className="size-4" style={{ color: ACCENT }} />
          <span className="text-sm text-foreground/80">{f.name}</span>
          <div className="ml-auto h-1 w-9 overflow-hidden rounded-full bg-foreground/10">
            <motion.div
              className="h-full origin-left rounded-full"
              style={{ backgroundColor: ACCENT }}
              initial={reduce ? false : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ delay: 0.3 + i * 0.13, duration: 0.55 }}
            />
          </div>
          <motion.span
            initial={reduce ? false : { scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{
              delay: 0.85 + i * 0.13,
              type: 'spring',
              stiffness: 500,
              damping: 16,
            }}
          >
            <CheckCircleIcon weight="fill" className="size-4" style={{ color: ACCENT }} />
          </motion.span>
        </motion.div>
      ))}
    </div>
  )
}

/* --------------------------------------------------------------------------
 * Scene 2 — your tone: a live waveform pulses while a stiff generic line is
 * struck through and your own voice types itself in underneath.
 * ------------------------------------------------------------------------ */
function ToneScene({ reduce, text }: SceneProps) {
  return (
    <div className="space-y-2.5">
      <div className="flex h-8 items-center gap-[3px]">
        {Array.from({ length: 22 }).map((_, i) => (
          <motion.span
            key={i}
            className="w-[3px] rounded-full"
            style={{ backgroundColor: ACCENT }}
            initial={{ height: '22%', opacity: 0.35 }}
            animate={
              reduce
                ? { height: '55%', opacity: 0.7 }
                : {
                    height: ['25%', '85%', '35%', '70%', '28%'],
                    opacity: [0.4, 0.95, 0.5, 0.85, 0.4],
                  }
            }
            transition={
              reduce
                ? undefined
                : {
                    duration: 1.5,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    delay: (i % 6) * 0.09,
                  }
            }
          />
        ))}
      </div>
      <div className="space-y-1">
        <motion.p
          className="text-sm text-foreground/40 line-through"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: reduce ? 0.6 : [0, 1, 0.5] }}
          transition={{ duration: 0.9, times: [0, 0.4, 1] }}
        >
          {text.toneBefore}
        </motion.p>
        <div className="overflow-hidden">
          <motion.p
            className="whitespace-nowrap text-sm font-medium"
            style={{ color: ACCENT }}
            initial={reduce ? false : { clipPath: 'inset(0 100% 0 0)' }}
            animate={{ clipPath: 'inset(0 0% 0 0)' }}
            transition={{ delay: 0.55, duration: 0.85, ease: 'easeOut' }}
          >
            {text.toneAfter}
          </motion.p>
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------
 * Scene 3 — your tools: the tools you live in snap online one by one, each
 * springing in and flipping a status dot to "connected".
 * ------------------------------------------------------------------------ */
// Curated local brand marks (public/landing/integrations) so the tools scene
// never depends on a remote icon CDN — cdn.simpleicons.org 404s for Slack.
const TOOLS = [
  { name: 'HubSpot', icon: '/landing/integrations/hubspot.png' },
  { name: 'Gmail', icon: '/landing/integrations/gmail.webp' },
  { name: 'Slack', icon: '/landing/integrations/slack.png' },
  { name: 'Linear', icon: '/landing/integrations/linear.svg' },
] as const

function ToolsScene({ reduce }: SceneProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {TOOLS.map((t, i) => (
        <motion.div
          key={t.name}
          className="flex items-center gap-1.5 rounded-lg border px-2 py-1.5"
          style={{ borderColor: mix(16), backgroundColor: mix(5) }}
          initial={reduce ? false : { opacity: 0, scale: 0.82, y: 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{
            delay: 0.06 + i * 0.13,
            type: 'spring',
            stiffness: 340,
            damping: 20,
          }}
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-white shadow-sm ring-1 ring-black/5">
            {/* oxlint-disable-next-line eslint-plugin-next/no-img-element */}
            <img
              src={t.icon}
              alt={t.name}
              loading="lazy"
              decoding="async"
              draggable={false}
              className="size-3.5 select-none object-contain"
            />
          </span>
          <span className="text-sm text-foreground/80">{t.name}</span>
          <motion.span
            className="ml-auto size-1.5 rounded-full"
            style={{ backgroundColor: ACCENT }}
            initial={reduce ? false : { scale: 0, opacity: 0 }}
            animate={reduce ? { scale: 1, opacity: 1 } : { scale: [0, 1.5, 1], opacity: 1 }}
            transition={{ delay: 0.3 + i * 0.13, duration: 0.4 }}
          />
        </motion.div>
      ))}
    </div>
  )
}

/* --------------------------------------------------------------------------
 * Scene 4 — your data: a live record populates row by row, real values
 * blurring in and the MRR figure counting up from zero.
 * ------------------------------------------------------------------------ */
function CountUp({ to, reduce }: { to: number; reduce: boolean }) {
  const [n, setN] = useState(reduce ? to : 0)
  useEffect(() => {
    if (reduce) return
    const controls = animate(0, to, {
      duration: 1.1,
      ease: 'easeOut',
      delay: 0.5,
      onUpdate: v => setN(Math.round(v)),
    })
    return () => controls.stop()
  }, [to, reduce])
  return <>${n.toLocaleString()}</>
}

function DataScene({ reduce, text }: SceneProps) {
  return (
    <div className="space-y-1.5">
      <div className="mb-2 flex items-center gap-1.5">
        <motion.span
          className="size-1.5 rounded-full"
          style={{ backgroundColor: ACCENT }}
          animate={reduce ? undefined : { opacity: [1, 0.3, 1] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
        />
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/45">
          {text.liveRecord}
        </span>
      </div>
      {text.dataRows.map((row, i) => (
        <div
          key={row.k}
          className="flex items-center justify-between border-b border-foreground/5 pb-1 text-sm"
        >
          <span className="text-foreground/50">{row.k}</span>
          <motion.span
            className="font-medium text-foreground/85"
            initial={reduce ? false : { opacity: 0, filter: 'blur(4px)', y: 3 }}
            animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
            transition={{ delay: 0.15 + i * 0.14, duration: 0.4 }}
          >
            {row.v}
          </motion.span>
        </div>
      ))}
      <div className="flex items-center justify-between pt-0.5 text-sm">
        <span className="text-foreground/50">MRR</span>
        <span className="font-semibold tabular-nums" style={{ color: ACCENT }}>
          <CountUp to={4200} reduce={reduce} />
        </span>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------
 * Scene 5 — your memory: past sessions stack up behind a "now" card and the
 * agent picks up exactly where the last one left off, no re-explaining.
 * ------------------------------------------------------------------------ */
function MemoryScene({ reduce, text }: SceneProps) {
  return (
    <div className="space-y-2">
      <div className="relative space-y-1.5">
        {text.sessions.map((s, i) => (
          <motion.div
            key={s}
            className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5"
            style={{ borderColor: mix(16), backgroundColor: mix(5) }}
            initial={reduce ? false : { opacity: 0, y: 8, filter: 'blur(4px)' }}
            animate={{
              opacity: 1 - i * 0.16,
              y: 0,
              filter: 'blur(0px)',
            }}
            transition={{
              delay: 0.1 + i * 0.14,
              type: 'spring',
              stiffness: 300,
              damping: 24,
            }}
          >
            <ClockCounterClockwiseIcon weight="fill" className="size-4" style={{ color: ACCENT }} />
            <span className="text-sm text-foreground/75">{s}</span>
          </motion.div>
        ))}
      </div>
      <motion.div
        className="flex items-center gap-2 rounded-lg border px-2.5 py-2"
        style={{ borderColor: mix(38), backgroundColor: mix(12) }}
        initial={reduce ? false : { opacity: 0, x: -10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.6, type: 'spring', stiffness: 320, damping: 22 }}
      >
        <span
          className="inline-flex size-5 items-center justify-center rounded-full"
          style={{ backgroundColor: mix(26) }}
        >
          <ArrowRightIcon weight="bold" className="size-3" style={{ color: ACCENT }} />
        </span>
        <span className="text-sm font-medium" style={{ color: ACCENT }}>
          {text.memoryNow}
        </span>
      </motion.div>
    </div>
  )
}

/* --------------------------------------------------------------------------
 * Scene 6 — your workflows: a 3-step play runs on its own, each step ticking
 * to done as the flow advances from start to finish.
 * ------------------------------------------------------------------------ */
function WorkflowsScene({ reduce, text }: SceneProps) {
  return (
    <div className="relative space-y-0">
      {text.steps.map((s, i) => (
        <div key={s} className="flex items-stretch gap-2.5">
          <div className="flex flex-col items-center">
            <motion.span
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
              style={{ backgroundColor: ACCENT }}
              initial={reduce ? false : { scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{
                delay: 0.15 + i * 0.4,
                type: 'spring',
                stiffness: 480,
                damping: 18,
              }}
            >
              {i + 1}
            </motion.span>
            {i < text.steps.length - 1 && (
              <motion.span
                className="my-0.5 w-[2px] flex-1 origin-top rounded-full"
                style={{ backgroundColor: mix(35) }}
                initial={reduce ? false : { scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={{ delay: 0.35 + i * 0.4, duration: 0.3 }}
              />
            )}
          </div>
          <motion.div
            className="mb-1.5 flex flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5"
            style={{ borderColor: mix(16), backgroundColor: mix(5) }}
            initial={reduce ? false : { opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 + i * 0.4, duration: 0.35 }}
          >
            <span className="text-sm text-foreground/80">{s}</span>
            <motion.span
              className="ml-auto"
              initial={reduce ? false : { scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{
                delay: 0.55 + i * 0.4,
                type: 'spring',
                stiffness: 500,
                damping: 16,
              }}
            >
              <CheckCircleIcon weight="fill" className="size-4" style={{ color: ACCENT }} />
            </motion.span>
          </motion.div>
        </div>
      ))}
    </div>
  )
}

const SCENES: Record<FacetKind, (p: SceneProps) => React.ReactNode> = {
  files: FilesScene,
  tone: ToneScene,
  tools: ToolsScene,
  data: DataScene,
  memory: MemoryScene,
  workflows: WorkflowsScene,
  generic: () => null,
}

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.06, delayChildren: 0.04 },
  },
  exit: { opacity: 0, y: -6, transition: { duration: 0.16 } },
}
const item = {
  hidden: { opacity: 0, y: 8, filter: 'blur(5px)' },
  show: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { type: 'spring', stiffness: 300, damping: 24 },
  },
}

/**
 * The reactive right-hand panel of the train section. When a source is hovered
 * on the globe, this mounts a *dedicated* framer-motion scene that performs what
 * that one input contributes — files scan + check off, tone renders a waveform
 * and rewrites in your voice, tools snap online, data populates a live record —
 * framed by a shared accent bar, header, and closing note. Reduced motion gets a
 * settled static version of each scene.
 */
export function FacetPanel({
  label,
  note,
  reduce,
  locale = 'en',
}: {
  label: string
  note: string
  reduce: boolean
  locale?: AppLocale
}) {
  const kind = facetKind(label)
  const HeaderGlyph = HEADER_ICON[kind]
  const Scene = SCENES[kind]

  return (
    <motion.div
      // reduce flips false→true after hydration; remount so the panel
      // re-renders settled instead of freezing at the cancelled 'hidden' state
      key={reduce ? 'settled' : 'animated'}
      variants={reduce ? undefined : container}
      initial={reduce ? false : 'hidden'}
      animate="show"
      exit={reduce ? undefined : 'exit'}
      className="relative overflow-hidden rounded-xl border py-3 pl-4 pr-3.5 backdrop-blur-md"
      style={
        {
          '--facet-accent': ACCENTS[kind],
          borderColor: mix(18),
          backgroundColor: mix(7),
        } as CSSProperties
      }
    >
      <motion.span
        aria-hidden="true"
        className="absolute left-0 top-0 h-full w-[3px] origin-top"
        style={{ backgroundColor: ACCENT }}
        initial={reduce ? false : { scaleY: 0 }}
        animate={{ scaleY: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      />
      <motion.div variants={reduce ? undefined : item} className="mb-3 flex items-center gap-2">
        <span
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md"
          style={{ backgroundColor: mix(22) }}
        >
          <HeaderGlyph weight="fill" className="size-4" style={{ color: ACCENT }} />
        </span>
        <span className="text-xl font-semibold" style={{ color: ACCENT }}>
          {label}
        </span>
      </motion.div>

      <motion.div variants={reduce ? undefined : item} className="mb-3">
        <Scene reduce={reduce} text={SCENE_TEXT[locale]} />
      </motion.div>

      <motion.p
        variants={reduce ? undefined : item}
        className="text-sm leading-relaxed text-foreground/75"
      >
        {note}
      </motion.p>
    </motion.div>
  )
}
