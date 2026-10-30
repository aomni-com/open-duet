import { CheckIcon } from '@phosphor-icons/react/dist/ssr'
import { useTranslations } from 'next-intl'

import { serifStyle } from '@/components/landing/landing-styles'
import { PUBLIC_SUBSCRIPTION_PLANS, PUBLIC_TYPICAL_MESSAGE } from '@/lib/public-site-config'

/**
 * The plan row and the band beneath it. It lives outside the pricing route
 * because the route's own screenshot is viewport-only and stops above this row,
 * so a playground fixture is the only thing that can hold these cards to a
 * baseline — and they are the part of the page most likely to be edited.
 *
 * `signupHref` is a prop rather than a `productHref()` call so that fixture can
 * render the real component without reaching for product origins.
 */

// Nine bullets: four that differ by plan (credits, messages, server, storage)
// and five that hold everywhere. The shared five repeat on every card by
// design — a card is compared against a competitor's on its own, so it has to
// carry the platform's table stakes rather than send the reader to a band.
// The billing *mechanics* still live once, in `SharedInclusions` below.
const TIER_FEATURE_KEYS = [
  'feature1',
  'feature2',
  'feature3',
  'feature4',
  'feature5',
  'feature6',
  'feature7',
  'feature8',
  'feature9',
] as const

type TierCardProps = {
  tier: string
  price: string
  priceSuffix?: string
  description: string
  features: string[]
  cta: { label: string; href: string }
  featured?: boolean
  footnote?: string
  featuredBadge?: string
}

function TierCard({
  tier,
  price,
  priceSuffix,
  description,
  features,
  cta,
  featured,
  footnote,
  featuredBadge,
}: TierCardProps) {
  // Outer wrapper holds the overflow-visible positioning so the "featured"
  // pill can extend past the card's top edge. The liquid-glass surface lives
  // on an inner div since liquid-glass sets overflow: hidden and would clip.
  return (
    <div className="relative h-full pt-4">
      {featured ? (
        // The pill straddles the card's top edge: `top-4` IS that edge (it
        // matches the wrapper's `pt-4`), and -translate-y-1/2 lifts the pill by
        // half its own height, so the centring survives any badge text or font
        // size. `flex` is load-bearing — the badge is an inline span, so a block
        // parent would size to the line box (24px) rather than the pill (19.5px)
        // and the translate would centre the wrong box, leaving the pill 2px low.
        <div className="pointer-events-none absolute left-1/2 top-4 z-10 flex -translate-x-1/2 -translate-y-1/2">
          <span
            className="bg-lv2-accent whitespace-nowrap rounded-full px-3.5 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] shadow-[0_8px_24px_-6px_hsl(214_65%_50%/0.5)]"
            // Not `text-white`: inside `.landing-v2` that utility is remapped to
            // the theme foreground, which is near-black in light mode.
            style={{ color: 'hsl(0 0% 100%)' }}
          >
            {featuredBadge}
          </span>
        </div>
      ) : null}

      <div
        className="liquid-glass relative flex h-full flex-col rounded-3xl p-7"
        style={
          featured
            ? {
                background:
                  'linear-gradient(160deg, rgba(39,192,141,0.12), rgba(39,192,141,0.02) 55%, rgba(255,255,255,0.01))',
              }
            : undefined
        }
      >
        <div>
          <p className="text-[10px] uppercase tracking-[0.28em] text-white/60">{tier}</p>
          <div className="mt-4 flex items-baseline gap-2">
            <span
              className={`font-normal tracking-[-1.5px] text-white ${
                price.includes(' ') ? 'text-3xl md:text-4xl' : 'text-5xl'
              }`}
              style={serifStyle}
            >
              {price}
            </span>
            {priceSuffix ? <span className="text-sm text-white/55">{priceSuffix}</span> : null}
          </div>
          <p className="mt-3 text-sm leading-relaxed text-white/70">{description}</p>
        </div>

        <div className="my-6 h-px bg-white/10" />

        <ul className="flex-1 space-y-2.5">
          {features.map(f => (
            <li key={f} className="flex items-start gap-3 text-sm text-white/80">
              <CheckIcon className="text-lv2-accent mt-0.5 h-4 w-4 shrink-0" weight="bold" />
              {f}
            </li>
          ))}
        </ul>

        <div className="mt-7">
          <a
            href={cta.href}
            className={`block w-full rounded-full px-4 py-3 text-center text-sm font-medium transition-colors ${
              featured
                ? 'bg-[hsl(214_65%_50%)] text-[hsl(0_0%_100%)] hover:bg-[hsl(214_70%_44%)]'
                : 'bg-lv2-surface-alt text-lv2-fg border border-lv2-line hover:bg-[color:var(--lv2-line)]'
            }`}
          >
            {cta.label}
          </a>
          {footnote ? <p className="mt-2.5 text-center text-xs text-white/45">{footnote}</p> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * What holds across all three plans, stated once under the row. Also carries
 * the footnote for the message estimates: a count with no stated assumption
 * reads as a quota, and credits meter real usage rather than messages.
 */
function SharedInclusions() {
  const t = useTranslations('pricingPage')
  const items = [t('tiers.shared.item1'), t('tiers.shared.item2'), t('tiers.shared.item3')]
  return (
    // A border-topped band, not a fourth glass card: `.liquid-glass` paints
    // almost nothing, so a panel here reads as text loose on the page. The
    // enterprise section on the pricing route uses this same band treatment.
    <div className="mx-auto mt-14 max-w-6xl border-t border-white/10 pt-8">
      <p className="text-[10px] uppercase tracking-[0.28em] text-white/55">
        {t('tiers.shared.label')}
      </p>
      <ul className="mt-4 grid gap-2.5 sm:grid-cols-3">
        {items.map(item => (
          <li key={item} className="flex items-start gap-3 text-sm text-white/80">
            <CheckIcon className="text-lv2-accent mt-0.5 h-4 w-4 shrink-0" weight="bold" />
            {item}
          </li>
        ))}
      </ul>
      <p className="mt-6 max-w-3xl text-xs leading-relaxed text-white/45">
        {t('tiers.shared.estimateFootnote', {
          inputK: PUBLIC_TYPICAL_MESSAGE.inputTokensK,
          outputK: PUBLIC_TYPICAL_MESSAGE.outputTokensK,
          tier: PUBLIC_TYPICAL_MESSAGE.tierLabel,
        })}
      </p>
    </div>
  )
}

export function PricingTiers({ signupHref }: { signupHref: string }) {
  const t = useTranslations('pricingPage')
  // Plain grid wrappers keep the plan contract visible in static HTML when
  // JavaScript is disabled; the reveal primitive intentionally starts hidden.
  return (
    <section className="relative z-10 px-4 pb-24 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-stretch gap-5 md:grid-cols-3">
        {PUBLIC_SUBSCRIPTION_PLANS.map(plan => {
          // Every card reads the same variables; what differs is the values
          // the plan catalog supplies, which is the whole point of the row.
          const values = {
            bonusPercent: plan.bonusPercent,
            credits: plan.monthlyCredits,
            messages: plan.estimatedMessages,
            tier: PUBLIC_TYPICAL_MESSAGE.tierLabel,
            cpu: plan.vmCpuCores,
            ram: plan.vmRamGb,
            storage: plan.storageGb,
          }
          return (
            <div className="h-full" key={plan.id}>
              <TierCard
                tier={t(`tiers.plans.${plan.id}.name`)}
                price={plan.monthlyPrice}
                priceSuffix={t('tiers.priceSuffixPerMonth')}
                description={t(`tiers.plans.${plan.id}.description`, values)}
                features={TIER_FEATURE_KEYS.map(key => t(`tiers.plans.${plan.id}.${key}`, values))}
                cta={{ label: t('tiers.cta'), href: signupHref }}
                featured={plan.id === 'pro'}
                featuredBadge={t('tiers.mostPopularBadge')}
                footnote={t('tiers.footnote')}
              />
            </div>
          )
        })}
      </div>

      <SharedInclusions />
    </section>
  )
}
