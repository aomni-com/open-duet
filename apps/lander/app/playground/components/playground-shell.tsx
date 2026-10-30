'use client'

import { MotionConfig } from 'framer-motion'
import { NextIntlClientProvider } from 'next-intl'
import { useEffect, type ReactNode } from 'react'

import { LandingChrome } from '@/components/landing/landing-chrome'
import { StaticSiteProviders } from '@/components/static-site-providers'
import messages from '@/messages/en/marketing.json'

/* A screenshot is of the end state, so every clock that could leave a surface
   part-way through one is set to zero.

   Zeroing only the duration is a bug: an animation declared with a delay and
   `fill: both` renders its first keyframe for the whole delay, so the delay
   must be zeroed too or the surface is photographed parked at frame one. */
const DETERMINISTIC_CSS = `
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`

export function PlaygroundShell({
  children,
  presentation,
}: {
  children: ReactNode
  presentation: 'landing' | 'plain'
}) {
  useEffect(() => {
    let cancelled = false

    async function markReady() {
      await document.fonts.ready
      // Decoding is a best effort with a deadline, not a barrier: Chromium can
      // leave `decode()` pending on SVG data URIs, and the layout-stability
      // loop below still keeps the gate shut while pictures are arriving.
      const decoded = Array.from(document.images).map(image =>
        image.complete ? Promise.resolve() : image.decode().catch(() => undefined),
      )
      await Promise.race([
        Promise.all(decoded),
        new Promise<void>(resolve => setTimeout(resolve, 2_000)),
      ])

      let previousHeight = -1
      let stableFrames = 0
      for (let frame = 0; frame < 120 && stableFrames < 4; frame += 1) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const height = document.body.getBoundingClientRect().height
        stableFrames = height === previousHeight ? stableFrames + 1 : 0
        previousHeight = height
      }

      if (!cancelled) document.body.dataset.playgroundReady = 'true'
    }

    void markReady()
    return () => {
      cancelled = true
      delete document.body.dataset.playgroundReady
    }
  }, [])

  return (
    <MotionConfig reducedMotion="always">
      <style>{DETERMINISTIC_CSS}</style>
      <NextIntlClientProvider locale="en" messages={messages}>
        <StaticSiteProviders>
          {/* Each fixture uses its production frame: marketing tokens or the
              plain utility-page palette. */}
          {presentation === 'plain' ? (
            <main className="min-h-screen bg-background text-foreground" data-playground-shell>
              {children}
            </main>
          ) : (
            <LandingChrome noAmbient>
              <div data-playground-shell>{children}</div>
            </LandingChrome>
          )}
        </StaticSiteProviders>
      </NextIntlClientProvider>
    </MotionConfig>
  )
}
