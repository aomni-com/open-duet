'use client'

import { HeroVideo } from '@/components/landing/hero-video'
import { FinalCta } from '@/components/landing/landers/hero-and-close'
import { PLATFORM_FAQS } from '@/components/landing/landers/platform-copy'
import {
  IntegrationsSection,
  PlatformHero,
  PrimitivesSection,
} from '@/components/landing/landers/platform-sections'
import { FaqsSection } from '@/components/landing/landers/sections'
import { TrainSection } from '@/components/landing/landers/train-section'
import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { LandingNavFrost } from '@/components/landing/landing-nav-frost'
import { TrustedBy } from '@/components/landing/trusted-by'

/** The platform lander (`/l/platform`): the hero makes the promise, the
 * primitives section grounds it, and integrations diffuse "why not just
 * Claude". It argues the whole platform rather than one use case, which is
 * why it is a campaign lander and not the main lander — `/` sells one job
 * (building and hosting the site or app) to one audience. */
export function PlatformLanding() {
  return (
    <LandingChrome noAmbient>
      {/* Sticky nav at the page level — transparent over the hero, gains a
          frosted-glass background on scroll. The hero wrapper below pulls
          itself up under the nav with -mt-20 so the hero video bleeds
          behind. */}
      <LandingNavFrost>
        <LandingNav homeHref="/" />
      </LandingNavFrost>
      <div className="relative -mt-20 h-[100svh] overflow-hidden min-[950px]:h-[calc(100vh_+_5rem)]">
        <HeroVideo />
        <PlatformHero />
      </div>
      <TrustedBy />
      <PrimitivesSection />
      <IntegrationsSection />
      <TrainSection
        band="bg-lv2-band-cool"
        eyebrow="Make it yours"
        title={
          <>
            Everyone gets the same AI.{' '}
            <span className="lv2-hero-ink-soft italic">You train yours.</span>
          </>
        }
        intro="Point it at how you actually work, and it stops answering like a stranger."
      />
      <FaqsSection items={PLATFORM_FAQS} />
      <FinalCta />
      <LandingFooter />
    </LandingChrome>
  )
}
