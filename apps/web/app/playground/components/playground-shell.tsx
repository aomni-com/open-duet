'use client'

import { MotionConfig } from 'framer-motion'
import { useEffect, type ReactNode } from 'react'

import { TooltipProvider } from '@repo/ui/components/shadcn/tooltip'

import { PinnedComposePlaceholderRoll } from '../../../spa/sessions/compose-placeholder'

/* A screenshot is of the end state, so every clock that could leave a surface
   part-way through one is set to zero.
 *
 * The delays are not decoration here. An animation declared with a delay and
 * `fill: both` renders its *first* keyframe for the whole delay — zeroing only
 * the duration leaves it parked there, permanently, because the delay is what is
 * still running. The knowledge map's unfold is declared that way: it opens at
 * `scale(0.955)` so the panels resolve around the face rather than arriving
 * before it, and with the duration crushed and the delay intact the playground
 * drew that surface four and a half per cent small — off-centre too, since it
 * scales about a corner — in every fixture and every baseline taken from one.
 * Nothing looked wrong, because everything was wrong by the same fraction.
 */
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

export function PlaygroundShell({ children }: { children: ReactNode }) {
  useEffect(() => {
    let cancelled = false

    async function markReady() {
      await document.fonts.ready
      /* Decoding is a best effort with a deadline, not a barrier. A rejected
         decode was already tolerated; a decode that never *settles* was not, and
         it hangs this whole gate — which shows up as every test in the file
         timing out on the ready flag rather than as anything about images.
         Chromium can leave `decode()` pending on an SVG data URI, and the map
         draws one per agent, so the surface that made this reachable was simply
         the first fixture to land on a canvas full of them.

         Nothing is lost by capping it: the frame loop below still refuses to
         call the page ready until its height has held still, so a picture that
         is genuinely still arriving keeps the gate shut on its own terms. */
      const decoded = Array.from(document.images).map(image =>
        image.complete ? Promise.resolve() : image.decode().catch(() => undefined),
      )
      await Promise.race([
        Promise.all(decoded),
        new Promise<void>(resolve => setTimeout(resolve, 2_000)),
      ])

      /* Height alone cannot say the page has settled. A transcript scrolls
         itself to the bottom after its content lands, and again when an image
         finishes loading and the resize observer fires — all of which move
         scroll offsets inside a fixed-height pane without moving the body one
         pixel. The gate opened mid-scroll and shots landed tens of pixels
         apart between runs, which reads as a stale baseline and is not one.
         So the signature the loop watches is height AND every scroll offset on
         the page. */
      let previousSignature = ''
      let stableFrames = 0
      for (let frame = 0; frame < 120 && stableFrames < 4; frame += 1) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const framesReady = Array.from(
          document.querySelectorAll<HTMLElement>('[data-playground-wait-for-frame]'),
        ).every(element => element.dataset.playgroundFrameReady === 'true')
        if (!framesReady) {
          stableFrames = 0
          continue
        }
        const scrolled = Array.from(document.body.querySelectorAll('*')).reduce(
          (total, element) => total + element.scrollTop + element.scrollLeft,
          0,
        )
        const signature = `${document.body.getBoundingClientRect().height}:${scrolled}`
        stableFrames = signature === previousSignature ? stableFrames + 1 : 0
        previousSignature = signature
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
      {/* A clock is not the only thing that can leave two runs of the same
          fixture different: the entry composer greets you with one of a pool
          of prompts, rolled per mount. The gate photographs the first one. */}
      <PinnedComposePlaceholderRoll.Provider value={0}>
        <TooltipProvider>
          <div data-playground-shell>{children}</div>
        </TooltipProvider>
      </PinnedComposePlaceholderRoll.Provider>
    </MotionConfig>
  )
}
