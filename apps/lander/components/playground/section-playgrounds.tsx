'use client'

import { FinalCta } from '@/components/landing/landers/hero-and-close'
import { HOME_COPY } from '@/components/landing/landers/home-copy'
import { PLATFORM_FAQS } from '@/components/landing/landers/platform-copy'
import {
  IntegrationsSection,
  PrimitivesSection,
} from '@/components/landing/landers/platform-sections'
import {
  FaqsSection,
  ForCompaniesSection,
  LiveCollabSection,
  ProblemSection,
  ValuePropsSection,
} from '@/components/landing/landers/sections'
import { SetupSection } from '@/components/landing/landers/setup-section'
import { ShareSection } from '@/components/landing/landers/share-section'
import { TrainSection } from '@/components/landing/landers/train-section'
import { PricingTiers } from '@/components/landing/pricing/pricing-tiers'

export function ProblemSilosPlayground() {
  return <ProblemSection />
}

export function ValuePropsPlayground() {
  return <ValuePropsSection />
}

export function TrainSectionPlayground() {
  return (
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
  )
}

export function CollabSectionPlayground() {
  return <LiveCollabSection />
}

export function CompaniesSectionPlayground() {
  return <ForCompaniesSection />
}

export function FaqSectionPlayground() {
  return <FaqsSection items={PLATFORM_FAQS} />
}

export function FinalCtaPlayground() {
  return <FinalCta />
}

export function PrimitivesPlayground() {
  return <PrimitivesSection />
}

export function IntegrationsPlayground() {
  return <IntegrationsSection />
}

export function SharePlayground() {
  return <ShareSection />
}

export function HomeSetupPlayground() {
  return <SetupSection copy={HOME_COPY.en.setup} />
}

export function HomeSharePlayground() {
  return <ShareSection copy={HOME_COPY.en.share} />
}

export function HomeIntegrationsPlayground() {
  return <IntegrationsSection copy={HOME_COPY.en.integrations} />
}

// The only visual owner of the plan cards: the pricing route's own screenshot
// is viewport-only and stops above the row. Real copy and real numbers — the
// shell supplies the English messages, and the component reads the
// contract-derived plan catalog.
export function PricingTiersPlayground() {
  return <PricingTiers signupHref="#" />
}
