'use client'

import Image from 'next/image'
import { useEffect, useState } from 'react'

import { ikUrl } from '@/lib/imagekit'

/**
 * Hero background video.
 *
 * Source files live on ImageKit (`ik.imagekit.io/duet/landing/...`) so
 * the CDN handles format negotiation (H.264 / VP9 / AV1 via `f-auto`)
 * and resolution-appropriate cuts. The 4K originals weigh ~8 MiB each;
 * the mobile transform (`w-1280,q-50,f-auto`) drops that to ~1.5 MiB and
 * the desktop transform (`w-1920,q-55,f-auto`) lands around ~4 MiB —
 * both with the same visual at typical viewport sizes.
 *
 * Rendering strategy:
 *   1. The `<video>` is server-rendered with the *light* source as the
 *      default — that's also the OS default for most visitors, so SSR
 *      matches what the browser ends up showing. The wrapper div paints
 *      `--lv2-bg` immediately so the hero never flashes empty.
 *   2. `preload="metadata"` tells the browser to fetch the manifest
 *      only — the frames stream once playback starts. Enough for the
 *      autoplay loop without blocking the network on the hero <h1>'s
 *      font / paint.
 *   3. Two still posters (the videos' first frames, committed under
 *      `public/landing/`) are stacked *over* the video so the very first
 *      paint is the correct frame, not a black box, even before the
 *      video manifest arrives. They're static local JPGs rather than an
 *      ImageKit `ik-thumbnail.jpg` transform because that video-thumbnail
 *      transform is rate-limited on the account and was returning 403s.
 *      Because each video loops from frame 0, a t=0 still matches the
 *      first played frame exactly — the handoff is a pure crossfade with
 *      no jump. CSS (`dark:`) picks which poster shows, keyed off the
 *      `.dark` class next-themes sets pre-hydration — the same signal the
 *      rest of the lander styles against, so the poster is theme-correct
 *      at first paint. (We deliberately avoid `useTheme()` here: its
 *      React context only resolves a few hundred ms *after* the class
 *      lands, long enough to flash the wrong poster.)
 *   4. Once the matching video can play (`canplay`/`playing`), the poster
 *      layer fades out fast (~300 ms) to reveal the live video. The fade
 *      is gated on the theme being known so a quick-loading light video
 *      can't flash out from under the (already-correct) dark poster.
 */

const LIGHT_PATH = '/landing/landing-bg-light.mp4'
const NIGHT_PATH = '/landing/landing-bg-night.mp4'

type SrcVariant = {
  mobile: string
  desktop: string
  poster: string
}

function videoVariants(path: string, poster: string): SrcVariant {
  return {
    // Mobile cut — 1280 wide is comfortably above any phone DPR-adjusted
    // viewport. quality 50 matches ImageKit's video default. format
    // 'auto' serves AV1/VP9 when supported, H.264 elsewhere.
    mobile: ikUrl(path, [{ width: 1280, quality: 50, format: 'auto' }]),
    // Desktop cut — 1920 wide covers the laptop tier natively (13"–16",
    // ~1440–1728 CSS px at 1×) and only mildly upscales on big external
    // displays, which the lv2-hero-vignette backdrop-blur masks. Quality
    // 50 with AV1/VP9 via `f-auto` lands the file around ~3.2 MB —
    // enough headroom for clean motion in the higher-detail areas
    // (mascot, type) without dragging the budget back toward the 4 MB
    // mark.
    desktop: ikUrl(path, [{ width: 1920, quality: 50, format: 'auto' }]),
    // Poster — the video's first frame, committed under public/landing/
    // and routed through next/image (served as ~90 KB WebP) so it paints
    // near-instantly and survives the ImageKit video-transform limit.
    poster,
  }
}

const LIGHT = videoVariants(LIGHT_PATH, '/landing/hero-poster-light.jpg')
const NIGHT = videoVariants(NIGHT_PATH, '/landing/hero-poster-night.jpg')

// Phones crop this wide scene hard. Two mobile-only adjustments, both
// reset from `md` up where the hero is wide enough to show it all:
//   • `object-[40%_center]` nudges the frame left so the two left mascots
//     stay in shot and the human lands on the right, not dead centre.
//   • `scale-[1.08] origin-top` zooms in from the top. Mobile leaves no
//     vertical slack (the cover'd video already fills the full height), so
//     this is what drops the mascots lower in the frame instead of having
//     them sit mid-hero; the slight extra crop only trims foreground grass.
// Shared by the <video> AND both posters so the still and the video frame
// identically — any mismatch would make the crossfade jump.
const FRAMING =
  'object-cover object-[40%_center] scale-[1.08] origin-top md:object-center md:scale-100'

export function HeroVideo() {
  // Resolve the theme from the `.dark` class next-themes writes onto
  // <html> in its pre-hydration script, NOT from `useTheme()`. The class
  // is on the element a few hundred ms before next-themes' React context
  // reports the resolved theme, and we need the *video* source to follow
  // it promptly — otherwise a dark-mode visitor's light video can load
  // and reveal before the swap. `null` until the effect first reads it,
  // which keeps SSR + first client render on LIGHT (no hydration
  // mismatch); the MutationObserver then also tracks the manual toggle.
  const [isDark, setIsDark] = useState<boolean | null>(null)
  // matchMedia genuinely needs an effect — `window` is absent during
  // SSR/render. Defaults to the *mobile* cut so SSR and the first paint
  // pick the smaller file: iOS Safari aborts autoplay on heavier loads
  // over cellular and falls back to a play button. The 1280px cut also
  // looks fine on desktop — the hero backdrop-blur vignette masks any
  // upscale on top of the lv2-bg color.
  const [isDesktop, setIsDesktop] = useState(false)
  // Track *which* src reached a playable state, not a bare boolean, so a
  // theme/viewport swap flips `ready` back to false on the same render
  // the src changes — the poster stays opaque over the reloading video
  // with no transparent gap.
  const [readySrc, setReadySrc] = useState<string | null>(null)

  useEffect(() => {
    const root = document.documentElement
    const read = () => setIsDark(root.classList.contains('dark'))
    read()
    const observer = new MutationObserver(read)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const query = window.matchMedia('(min-width: 769px)')
    setIsDesktop(query.matches)
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const variant = isDark ? NIGHT : LIGHT
  const src = isDesktop ? variant.desktop : variant.mobile
  // Reveal the video only once we know the theme AND *this* src is
  // playable. Gating on `isDark !== null` stops a fast light video from
  // flashing out from under the already-correct dark poster in the brief
  // window before the theme is read.
  const ready = isDark !== null && readySrc === src

  return (
    <div
      className="absolute inset-0 z-0 transition-colors duration-500"
      style={{ backgroundColor: 'var(--lv2-bg)' }}
      aria-hidden="true"
    >
      <video
        // `key` on the active src means a theme or viewport change tears
        // down and remounts the <video>. `ready` (derived from src) is
        // false until *this* src becomes playable, so the poster sits
        // over the reloading video the whole time and the hero never goes
        // blank. `canplay` fires once the current frame is decoded and
        // displayable (readyState >= 3); `playing` is the belt-and-braces
        // confirmation that frames are actually being presented. Either
        // one settling this src is enough to drop the poster.
        key={src}
        className={`absolute inset-0 h-full w-full ${FRAMING}`}
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
        disablePictureInPicture
        tabIndex={-1}
        onCanPlay={() => setReadySrc(src)}
        onPlaying={() => setReadySrc(src)}
      >
        {/* No `type` hint: ImageKit's `f-auto` returns `video/webm` to
            Chrome and `video/mp4` to Safari (UA-based negotiation).
            Declaring a static `type` here lies to whichever engine gets
            the other format, and the type-mismatch makes some browsers
            refuse playback and surface the play-button overlay. Let the
            response's Content-Type header decide. */}
        <source src={src} />
      </video>
      {/* Starting-frame poster layer — fades out fast once the matching
          video is playable. Both stills render; CSS (`dark:`) shows the
          one for the active theme off the `.dark` class, so it's correct
          at first paint without waiting on the theme context. The video
          loops from frame 0, so the still matches the first played frame
          exactly — a pure dissolve, no jump. Static classNames mean React
          never has to reconcile the <img> attributes (so no hydration
          freeze); only this wrapper's opacity animates. */}
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-300 ease-out"
        style={{ opacity: ready ? 0 : 1 }}
        aria-hidden="true"
      >
        {/* No `priority`: it would force-preload *both* stills (the
            preload fires regardless of `display`), making every visitor
            pay for the theme they don't see. Each still is above the
            fold, so the one its theme reveals loads on mount anyway,
            while the hidden one (display:none) is never fetched — so a
            light visitor pulls only the light still and vice-versa. */}
        <Image src={LIGHT.poster} alt="" fill sizes="100vw" className={`${FRAMING} dark:hidden`} />
        <Image
          src={NIGHT.poster}
          alt=""
          fill
          sizes="100vw"
          className={`hidden ${FRAMING} dark:block`}
        />
      </div>
      {/* Cinematic blur vignette — a circular backdrop-blur disc
          anchored at the bottom-center of the hero. Lower half stays
          sharp; the top corners (header band) softly defocus. Tuned
          per theme via `.dark .landing-v2 …`. No color overlays — the
          raw video carries the palette, the blur carries the focus. */}
      <div className="lv2-hero-vignette pointer-events-none absolute inset-0" />
    </div>
  )
}
