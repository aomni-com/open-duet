import { type CSSProperties, type ReactNode } from 'react'

import { PrimaryCta, SecondaryCta } from '@/components/landing/landing-cta'
import { RevealItem, SectionReveal } from '@/components/landing/section-reveal'
import { TRIAL_DAYS } from '@/lib/public-site-config'
import { productHref } from '@/src/config/origins'

type LandingFinalCtaProps = {
  serifStyle: CSSProperties
  /** Bold opening line. Wraps in serif. */
  headingLead?: ReactNode
  /** Muted continuation line. */
  headingTrail?: ReactNode
  /** Supporting copy below the headline. */
  description?: ReactNode
  /** Primary CTA label. */
  primaryLabel?: string
  primaryHref?: string
  /** Secondary link label + href; pass `null` to hide. */
  secondary?: { label: string; href: string } | null
}

export function LandingFinalCta({
  serifStyle,
  headingLead = 'Stop running your business.',
  headingTrail = 'Start directing it.',
  description = `${TRIAL_DAYS} days free. No card required. Your first workflow can be live in under 10 minutes.`,
  primaryLabel = 'Start free',
  primaryHref = productHref('/sign-in'),
  secondary = { label: 'See pricing', href: '/pricing' },
}: LandingFinalCtaProps) {
  return (
    <section className="relative z-10 border-t border-lv2-line px-6 py-40 text-center">
      <SectionReveal className="mx-auto flex flex-col items-center">
        <RevealItem>
          <h2
            className="text-lv2-fg mx-auto max-w-4xl text-5xl leading-[0.95] tracking-[-2px] sm:text-6xl md:text-7xl"
            style={serifStyle}
          >
            {headingLead}
            <br />
            <em className="text-lv2-muted not-italic">{headingTrail}</em>
          </h2>
        </RevealItem>
        {description ? (
          <RevealItem>
            <p className="text-lv2-muted mx-auto mt-8 max-w-xl text-base">{description}</p>
          </RevealItem>
        ) : null}
        <RevealItem className="mt-12 flex flex-wrap items-center justify-center gap-6">
          <PrimaryCta href={primaryHref} halo size="lg">
            {primaryLabel}
          </PrimaryCta>
          {secondary ? (
            <SecondaryCta href={secondary.href} size="lg">
              {secondary.label}
            </SecondaryCta>
          ) : null}
        </RevealItem>
      </SectionReveal>
    </section>
  )
}
