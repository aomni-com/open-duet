import { useTranslations } from 'next-intl'

import { PrimaryCta } from '@/components/landing/landing-cta'
import { serifStyle } from '@/components/landing/landing-styles'
import { productHref } from '@/src/config/origins'

/**
 * Closing CTA at the bottom of every blog post and guide. Deliberately
 * uniform across the site: same copy, same look, regardless of what the
 * reader just read. The content-specific ask lives inline mid-article
 * (driven by `post.cta` from frontmatter); this one is the universal
 * "hire Duet" handshake at the end.
 *
 * Sits on a marbled cloud-sky backdrop generated inline via SVG
 * fractal-noise turbulence so the white streaks read as painted clouds
 * rather than circular gradient blobs. Light mode: bright daylight sky.
 * Dark mode: deep midnight sky with subtler highlights. Content sits
 * inside a floating glass card so the gradient breathes around it.
 */
export function TrailingCta() {
  const t = useTranslations('blogUi')
  return (
    <section className="relative isolate overflow-hidden px-6 py-24 sm:py-32">
      <CloudSkySvg className="dark:hidden" variant="light" />
      <CloudSkySvg className="hidden dark:block" variant="dark" />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col items-center rounded-3xl bg-white/65 px-8 py-16 text-center shadow-[0_30px_80px_-30px_hsl(214_60%_30%/0.35)] ring-1 ring-white/70 backdrop-blur-2xl dark:bg-[hsl(216_28%_12%/0.65)] dark:shadow-[0_30px_80px_-30px_hsl(216_80%_2%/0.7)] dark:ring-[hsl(40_28%_94%/0.1)] sm:px-16 sm:py-20">
        <h2
          className="text-3xl leading-[1.05] tracking-[-1px] text-[hsl(218_45%_18%)] dark:text-[hsl(40_28%_96%)] sm:text-4xl md:text-5xl"
          style={serifStyle}
        >
          {t('trailingHeading')}
        </h2>
        <p className="mt-5 max-w-md text-base leading-relaxed text-[hsl(218_25%_38%)] dark:text-[hsl(40_22%_78%)] sm:text-lg">
          {t('trailingBody')}
        </p>
        <div className="mt-9">
          <PrimaryCta
            href={productHref('/sign-in?from=blog-trailing-cta')}
            size="md"
            magnetic={false}
          >
            {t('startFree')}
          </PrimaryCta>
        </div>
      </div>
    </section>
  )
}

/**
 * Inline SVG that paints a marbled sky behind the trailing CTA. Uses
 * `feTurbulence` (fractal noise) routed through a color matrix that
 * converts bright noise into opaque white and dark noise into
 * transparent, producing the wispy painted-cloud look on top of a
 * radial sky gradient. Two preset variants: light (daylight sky) and
 * dark (midnight sky with dimmed cloud highlights).
 *
 * Filter IDs are scoped per-variant so both <svg>s can coexist on the
 * page without colliding when one is in the inactive theme.
 */
function CloudSkySvg({ className, variant }: { className?: string; variant: 'light' | 'dark' }) {
  const isLight = variant === 'light'
  const sky = isLight
    ? { c1: 'hsl(204 95% 84%)', c2: 'hsl(210 90% 70%)', c3: 'hsl(214 82% 56%)' }
    : { c1: 'hsl(214 65% 18%)', c2: 'hsl(216 72% 11%)', c3: 'hsl(220 80% 5%)' }
  const cloud = isLight ? 'hsl(0 0% 100%)' : 'hsl(214 55% 55%)'
  // Color matrix turns the grayscale noise into "alpha for white" so
  // bright noise -> opaque cloud, dark noise -> transparent sky.
  // Threshold (`-0.5`) controls how much of the canvas reads as cloud
  // vs sky. Steeper multiplier (`1.8`) sharpens the edges.
  const matrix = isLight
    ? '0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 1.8 0 0 0 -0.5'
    : '0 0 0 0 0.45 0 0 0 0 0.6 0 0 0 0 0.85 1.6 0 0 0 -0.7'
  const skyId = `tcta-sky-${variant}`
  const filterId = `tcta-cloud-${variant}`
  return (
    <svg
      aria-hidden="true"
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
      className={`pointer-events-none absolute inset-0 -z-10 h-full w-full ${className ?? ''}`}
    >
      <defs>
        <radialGradient id={skyId} cx="50%" cy="32%" r="85%">
          <stop offset="0%" stopColor={sky.c1} />
          <stop offset="55%" stopColor={sky.c2} />
          <stop offset="100%" stopColor={sky.c3} />
        </radialGradient>
        <filter id={filterId} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="3" seed="5" />
          <feColorMatrix values={matrix} />
        </filter>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${skyId})`} />
      <rect
        width="100%"
        height="100%"
        fill={cloud}
        filter={`url(#${filterId})`}
        opacity={isLight ? 0.85 : 0.5}
      />
    </svg>
  )
}
