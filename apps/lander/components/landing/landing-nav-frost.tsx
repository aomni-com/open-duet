'use client'

import { useEffect, useState, type ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

/**
 * Sticky wrapper for LandingNav that's transparent over the hero and
 * gains a frosted-glass background once the user scrolls past the
 * threshold. Used on pages with a full-bleed hero (home,
 * /for/<vertical> with a heroImage) so the nav bleeds the hero behind
 * it on top, then stays readable over the page body.
 */
export function LandingNavFrost({
  children,
  threshold = 80,
}: {
  children: ReactNode
  threshold?: number
}) {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold)
    // Catch deep links / browser-back that lands mid-page already
    // scrolled past the threshold.
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [threshold])

  return (
    <div className="sticky top-0 z-40 isolate w-full">
      {/* Frost layer. Always rendered, fades in via opacity once the
          user scrolls past the threshold. Transitioning opacity is
          smooth and cheap; toggling backdrop-blur directly can flicker
          and tween awkwardly in some browsers. No bottom border — the
          blur alone separates the nav from the page body. */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0 -z-10 bg-[color:var(--lv2-bg)]/70 backdrop-blur-md transition-opacity duration-500 ease-out',
          scrolled ? 'opacity-100' : 'opacity-0',
        )}
      />
      {children}
    </div>
  )
}
