import { HeroVideo } from '@/components/landing/hero-video'
import { InkMark } from '@/components/landing/ink-mark'
import { FinalCta, LanderHero } from '@/components/landing/landers/hero-and-close'
import { HOME_COPY } from '@/components/landing/landers/home-copy'
import {
  IntegrationsSection,
  PrimitivesSection,
} from '@/components/landing/landers/platform-sections'
import { FaqsSection, PillarsSection } from '@/components/landing/landers/sections'
import { SetupSection } from '@/components/landing/landers/setup-section'
import { ShareSection } from '@/components/landing/landers/share-section'
import { TrainSection } from '@/components/landing/landers/train-section'
import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { LandingNavFrost } from '@/components/landing/landing-nav-frost'
import type { AppLocale } from '@/lib/i18n/locales'

/** The main lander, in every language the homepage is served in. The hero
 * states the deal: one subscription, every kind of AI. The reader does not
 * know what the state of the art looks like, so the page shows it in the
 * order they need it: jobs they could hand over this week, the stack those
 * jobs would take to assemble alone, an agent that learns their work, the
 * inventory that comes built in, and how anything they make reaches someone
 * else. The platform argument for builders lives at `/l/platform`. */
export function HomeLanding({ locale }: { locale: AppLocale }) {
  const copy = HOME_COPY[locale]
  return (
    <LandingChrome noAmbient>
      {/* Sticky nav at the page level: transparent over the hero, gains a
          frosted-glass background on scroll. The hero wrapper pulls itself up
          under the nav with -mt-20 so the hero video bleeds behind. */}
      <LandingNavFrost>
        <LandingNav homeHref="/" />
      </LandingNavFrost>
      <div className="relative -mt-20 h-[100svh] overflow-hidden min-[950px]:h-[calc(100vh_+_5rem)]">
        <HeroVideo />
        <LanderHero
          headline={
            <>
              {copy.hero.lead}{' '}
              {/* Block, not inline: on a phone an inline tail strands its
                  first word at the end of the line above. */}
              <span className="lv2-hero-ink-soft block italic">{copy.hero.trail}</span>
            </>
          }
          sub={copy.hero.sub}
          cta={copy.cta}
        />
      </div>
      <PillarsSection {...copy.outcomes} />
      <SetupSection copy={copy.setup} />
      <TrainSection
        band="bg-lv2-band-cool"
        eyebrow={copy.train.eyebrow}
        title={
          <>
            {copy.train.titleLead}{' '}
            <span className="lv2-hero-ink-soft italic">{copy.train.titleTrail}</span>
          </>
        }
        intro={copy.train.intro}
        feed={copy.train.feed}
        facetNotes={copy.train.facetNotes}
        locale={locale}
      />
      <PrimitivesSection copy={copy.platform} />
      <ShareSection copy={copy.share} />
      <IntegrationsSection copy={copy.integrations} />
      <FaqsSection items={copy.faq.items} title={copy.faq.title} eyebrow={copy.faq.eyebrow} />
      <FinalCta
        eyebrow={copy.close.eyebrow}
        title={
          <>
            {copy.close.titleLead} <InkMark>{copy.close.titleMark}</InkMark>
          </>
        }
        sub={copy.close.sub}
        bullets={copy.close.bullets}
        cta={copy.cta}
      />
      <LandingFooter />
    </LandingChrome>
  )
}
