'use client'

import { CheckCircleIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'

import { useHydratedReducedMotion, useIsDark } from '@/components/landing/atoms'
import { GrainVeil } from '@/components/landing/grain-veil'
import { InkMark } from '@/components/landing/ink-mark'
import { MeshGradient } from '@/components/landing/landers/section-primitives'
import { PrimaryCta } from '@/components/landing/landing-cta'
import { serifStyle } from '@/components/landing/landing-styles'
import { RevealItem, SectionReveal } from '@/components/landing/section-reveal'
import { ShaderOnView } from '@/components/landing/shader-on-view'
import { SubtleBackdrop } from '@/components/landing/subtle-backdrop'
import { productHref } from '@/src/config/origins'

/**
 * The two ends of every lander: the hero that opens it and the closing ask
 * that finishes it, plus an optional announcement chip.
 *
 * They live apart from the section library because every lander mounts both
 * and picks its sections, so a page importing the frame should not pull the
 * silo shelf and the collaboration demo with it. Landers differ here only in
 * the copy they pass — one owner means a fix to the hero's legibility or the
 * CTA's mobile bullets reaches all of them at once.
 */

/** The fundraise announcement chip used by campaign heroes: a slim glow
 * chip with a milled edge and a pastel comet that drifts the border (see
 * .lv2-glow-chip). Frosted glass; brand blue is reserved for the raise
 * amount. Callers pass only the trailing clause, so the raise itself reads
 * identically on every page. */
export function FundraiseChip({ children }: { children: ReactNode }) {
  return (
    <a
      href="https://www.decibel.vc/articles/introducing-aomni-ai-powered-dangerously-smart-revenue-teams"
      target="_blank"
      rel="noopener noreferrer"
      className="lv2-glow-chip animate-fade-rise group mb-7 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm tracking-[0.01em] no-underline backdrop-blur-md transition-transform duration-200 hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(214_65%_50%)]"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--lv2-surface) 34%, transparent)',
      }}
    >
      <span className="text-lv2-fg-soft lv2-text-legible text-balance font-medium">
        We raised <span className="text-lv2-accent font-semibold">$4.5M</span> {children}
      </span>
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className="text-lv2-muted size-3.5 transition-transform duration-200 group-hover:translate-x-px group-hover:-translate-y-px"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 8 8 4M4.5 4H8v3.5" />
      </svg>
    </a>
  )
}

/** The full-bleed hero over the landing video: chip slot, serif headline,
 * frosted sub band, one self-serve signup CTA. Mount inside
 * the video wrapper (`relative -mt-20 h-[100svh] …` + `<HeroVideo />`) so the
 * frame bleeds behind the nav. One owner for every lander hero — home and
 * campaigns differ only in the copy they pass. */
export function LanderHero({
  chip,
  headline,
  sub,
  cta = 'Start free',
}: {
  chip?: ReactNode
  headline: ReactNode
  sub: ReactNode
  /** The signup button's label, in the page's language. */
  cta?: string
}) {
  return (
    <section className="relative z-10 flex h-full flex-col items-center px-6 pt-28 text-center sm:pt-36">
      {/* One soft vignette behind the whole copy block, instead of a frame
          around each line: the frame read as a box dropped on the video, and
          the vignette only lifts the frame where the type actually sits. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full sm:h-[88%]"
        style={{
          background:
            'radial-gradient(ellipse 66% 60% at 50% 44%, color-mix(in srgb, var(--lv2-surface) 78%, transparent) 0%, color-mix(in srgb, var(--lv2-surface) 46%, transparent) 42%, transparent 74%)',
        }}
      />
      {chip}
      <h1
        className="lv2-hero-ink lv2-text-legible mx-auto max-w-4xl text-balance text-[clamp(2.75rem,7vw,5.25rem)] font-normal leading-[1.04] tracking-[-0.035em]"
        style={serifStyle}
      >
        {headline}
      </h1>
      {/* Plain type with the headline's own legibility shadows; the vignette
          above does the rest. No border, no fill, nothing to read as a box. */}
      <p className="lv2-hero-ink animate-fade-rise-delay mx-auto mt-6 max-w-[38rem] text-balance text-[17px] font-medium leading-[1.55] sm:text-lg">
        {sub}
      </p>
      {/* One ask: start a self-serve signup on the product origin. */}
      <div className="animate-fade-rise-delay-2 mt-6">
        <PrimaryCta href={productHref('/sign-in?from=lander-hero')} size="md" halo>
          {cta}
        </PrimaryCta>
      </div>
    </section>
  )
}

/** The shared closing band: mesh weather, eyebrow/title/sub, one signup CTA,
 * trust bullets. Home renders the defaults; campaign landers
 * pass their own copy so the ask stays identical while the message stays
 * per-audience. */
export function FinalCta({
  eyebrow = 'Yours to build, share, and sell',
  title = (
    <>
      The agents you build here are <InkMark>yours.</InkMark>
    </>
  ),
  sub = 'Everything your agent is, its memory, skills, and apps, lives in your workspace, ready to hand to your team or sell to your customers.',
  kicker,
  bullets = ['Start in minutes', '7-day free trial', 'Works with any agent'],
  cta = 'Start free',
}: {
  eyebrow?: string
  title?: ReactNode
  sub?: ReactNode
  /** One italic line under the sub — the page's parting aphorism. */
  kicker?: ReactNode
  bullets?: readonly string[]
  /** The signup button's label, in the page's language. */
  cta?: string
}) {
  const reduce = useHydratedReducedMotion()
  const dark = useIsDark()
  // Neutral band tones only — the mesh is weather, never the brand blue.
  const meshColors = dark
    ? ['#131a26', '#181e2c', '#10151f', '#1a2030']
    : ['#e7edf6', '#f7f1e6', '#fbfbfd', '#eef2f9']

  return (
    <section className="relative overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <ShaderOnView
          shaderComponent={MeshGradient}
          shaderProps={{
            colors: meshColors,
            distortion: 0.9,
            swirl: 0.15,
            speed: reduce ? 0 : 0.35,
            style: { width: '100%', height: '100%' },
          }}
          once
          className="absolute inset-0 opacity-70 [mask-image:radial-gradient(ellipse_80%_75%_at_center,black_35%,transparent_95%)]"
        />
        <SubtleBackdrop />
        <GrainVeil opacity={0.03} />
      </div>

      <div className="relative mx-auto max-w-4xl px-6 py-24 text-center sm:py-32">
        <SectionReveal amount={0.4}>
          <RevealItem>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-foreground/80">
              {eyebrow}
            </p>
          </RevealItem>
          <RevealItem>
            <h2
              className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl lg:text-5xl"
              style={serifStyle}
            >
              {title}
            </h2>
          </RevealItem>
          <RevealItem>
            <p className="mx-auto mt-5 max-w-xl text-base text-foreground/70 sm:text-lg">{sub}</p>
            {kicker ? <p className="mt-3 text-sm italic text-foreground/65">{kicker}</p> : null}
          </RevealItem>
          <RevealItem>
            <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <PrimaryCta href={productHref('/sign-in?from=lander-final')} size="md" halo>
                {cta}
              </PrimaryCta>
            </div>
          </RevealItem>
          <RevealItem>
            <ul className="mt-8 flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-foreground/65 sm:gap-x-6">
              {bullets.map(item => (
                <li key={item} className="inline-flex items-center gap-1.5">
                  <CheckCircleIcon weight="fill" className="size-3.5" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </RevealItem>
        </SectionReveal>
      </div>
    </section>
  )
}
