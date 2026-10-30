'use client'

import { type CampaignVariant } from '@/components/landing/campaign/campaign-spec'
import { HeroVideo } from '@/components/landing/hero-video'
import { InkMark } from '@/components/landing/ink-mark'
import { FinalCta, LanderHero } from '@/components/landing/landers/hero-and-close'
import { PillarsSection, ProblemSection } from '@/components/landing/landers/sections'
import { ShareSection } from '@/components/landing/landers/share-section'
import { TrainSection } from '@/components/landing/landers/train-section'
import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { LandingNavFrost } from '@/components/landing/landing-nav-frost'
import { TrustedBy } from '@/components/landing/trusted-by'

const TRUST_BULLETS = ['Start in minutes', '7-day free trial', 'Cancel anytime'] as const

/** The shared lander hero — video, frosted band, one CTA — carrying the
 * campaign's audience tag in the chip slot and its promise as the headline. */
function CampaignHero({ variant }: { variant: CampaignVariant }) {
  return (
    <div className="relative -mt-20 h-[100svh] overflow-hidden min-[950px]:h-[calc(100vh_+_5rem)]">
      <HeroVideo />
      <LanderHero
        chip={
          <span
            className="lv2-glow-chip animate-fade-rise mb-7 inline-flex items-center rounded-full px-4 py-1.5 text-sm tracking-[0.01em] backdrop-blur-md"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--lv2-surface) 34%, transparent)',
            }}
          >
            <span className="text-lv2-fg-soft lv2-text-legible font-medium">{variant.eyebrow}</span>
          </span>
        }
        headline={
          <>
            {variant.h1Lead}{' '}
            <span className="lv2-hero-ink-soft block italic">{variant.h1Italic}</span>
          </>
        }
        sub={variant.sub}
      />
    </div>
  )
}

function ProblemBorrowed({ variant }: { variant: CampaignVariant }) {
  if (variant.borrowed === 'silos') return <ProblemSection />
  return null
}

function ProofBorrowed({ variant }: { variant: CampaignVariant }) {
  if (variant.borrowed === 'share') return <ShareSection />
  if (variant.borrowed === 'train') {
    return (
      <TrainSection
        band="bg-lv2-band-cool"
        eyebrow="Make it yours"
        title={
          <>
            Everyone gets the same AI.{' '}
            <span className="lv2-hero-ink-soft italic">You train yours.</span>
          </>
        }
        intro="Point it at how your business actually works, and it stops answering like a stranger."
      />
    )
  }
  return null
}

export function CampaignLanding({ variant }: { variant: CampaignVariant }) {
  return (
    <LandingChrome noAmbient>
      <LandingNavFrost>
        <LandingNav homeHref="/" />
      </LandingNavFrost>
      <CampaignHero variant={variant} />
      <TrustedBy />
      <ProblemBorrowed variant={variant} />
      <PillarsSection
        eyebrow={variant.pillarsEyebrow}
        title={variant.pillarsTitle}
        intro={variant.pillarsIntro}
        pillars={variant.pillars}
      />
      <ProofBorrowed variant={variant} />
      <FinalCta
        eyebrow={variant.closingEyebrow}
        title={
          <>
            {variant.closingLead} <InkMark>{variant.closingMark}</InkMark>
          </>
        }
        sub={variant.closingSub}
        bullets={TRUST_BULLETS}
      />
      <LandingFooter />
    </LandingChrome>
  )
}
