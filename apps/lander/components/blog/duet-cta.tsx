import { cn } from '@repo/ui/lib/utils'

import { PrimaryCta } from '@/components/landing/landing-cta'
import { resolveCtaHref } from '@/lib/blog/cta-href'

type DuetCTAProps = {
  className?: string
  title?: string
  subtitle?: string
  buttonText?: string
  href?: string
}

export function DuetCTA({
  className,
  title = 'Run this in your own business.',
  subtitle = 'Hire Duet — your always-on AI hire that runs every workflow.',
  buttonText = 'Start free',
  href = '/sign-in?from=blog-cta',
}: DuetCTAProps) {
  return (
    <div
      data-nosnippet
      className={cn(
        'relative my-10 overflow-hidden rounded-2xl p-2 sm:p-3',
        // Light: daylight cloud sky. Dark: deep midnight sky in the
        // same brand-blue hue family so the CTA still reads as "Duet
        // blue" but no longer pretends it's daytime.
        'bg-[radial-gradient(120%_140%_at_15%_10%,hsl(210_100%_98%)_0%,hsl(212_95%_92%)_28%,hsl(214_85%_78%)_60%,hsl(218_70%_62%)_100%)]',
        'dark:bg-[radial-gradient(120%_140%_at_15%_10%,hsl(216_55%_18%)_0%,hsl(216_60%_12%)_30%,hsl(218_65%_8%)_60%,hsl(220_75%_4%)_100%)]',
        'shadow-[0_30px_80px_-30px_hsl(214_70%_50%/0.45)] dark:shadow-[0_30px_80px_-30px_hsl(216_80%_2%/0.75)]',
        className,
      )}
    >
      {/* Cloud blooms — light variant (bright white highlights). Hidden
          in dark mode so the dark gradient stays clean. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-90 dark:hidden"
        style={{
          background:
            'radial-gradient(45% 55% at 80% 20%, hsl(0 0% 100% / 0.85) 0%, hsl(0 0% 100% / 0) 70%),' +
            'radial-gradient(35% 45% at 10% 85%, hsl(210 100% 98% / 0.9) 0%, hsl(210 100% 98% / 0) 70%),' +
            'radial-gradient(30% 35% at 60% 90%, hsl(214 100% 96% / 0.8) 0%, hsl(214 100% 96% / 0) 70%)',
          filter: 'blur(8px)',
        }}
      />
      {/* Cloud blooms — dark variant (subtle brand-blue highlights so the
          midnight sky doesn't read as a flat blue rectangle). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden opacity-60 dark:block"
        style={{
          background:
            'radial-gradient(45% 55% at 80% 20%, hsl(214 70% 32% / 0.55) 0%, hsl(214 70% 32% / 0) 70%),' +
            'radial-gradient(35% 45% at 10% 85%, hsl(218 60% 24% / 0.6) 0%, hsl(218 60% 24% / 0) 70%),' +
            'radial-gradient(30% 35% at 60% 90%, hsl(216 65% 28% / 0.5) 0%, hsl(216 65% 28% / 0) 70%)',
          filter: 'blur(10px)',
        }}
      />
      {/* Film grain — kept identical in both themes since it just adds
          texture, not color. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.18] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.6 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
        }}
      />

      {/* Nested inner card — porcelain glass in light, ink glass in dark
          so the title/subtitle stay legible against the surrounding sky. */}
      <div
        className={cn(
          'relative rounded-xl px-6 py-7 backdrop-blur-xl sm:px-8 sm:py-8',
          'bg-white/70 ring-1 ring-white/60',
          'shadow-[inset_0_1px_0_0_hsl(0_0%_100%/0.9),0_8px_30px_-12px_hsl(214_60%_30%/0.25)]',
          'dark:bg-[hsl(216_28%_12%/0.7)] dark:ring-[hsl(40_28%_94%/0.1)]',
          'dark:shadow-[inset_0_1px_0_0_hsl(40_28%_94%/0.08),0_8px_30px_-12px_hsl(216_80%_2%/0.7)]',
        )}
      >
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="m-0 text-balance text-lg font-semibold leading-snug text-[hsl(218_45%_18%)] dark:text-[hsl(40_28%_96%)] sm:text-xl">
              {title}
            </p>
            <p className="m-0 mt-1.5 text-pretty text-sm leading-relaxed text-[hsl(218_25%_38%)] dark:text-[hsl(40_22%_78%)] sm:text-[15px]">
              {subtitle}
            </p>
          </div>
          <PrimaryCta href={resolveCtaHref(href)} size="sm" magnetic={false} className="shrink-0">
            {buttonText}
          </PrimaryCta>
        </div>
      </div>
    </div>
  )
}
