import './landing-styles.css'

import { ImageKitProvider } from '@imagekit/next'
import { type ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { AmbientBackground } from '@/components/landing/ambient-background'
import { IK_URL_ENDPOINT } from '@/lib/imagekit'

type LandingChromeProps = {
  children: ReactNode
  /** Hide the ambient shader — useful for sections that want a calmer backdrop. */
  noAmbient?: boolean
  /** Extra classes on the <main>. */
  className?: string
}

/**
 * Page shell for the landing design language — landers, pricing, blog,
 * guides. Injects the landing CSS once, applies `.landing-v2` (so the
 * lv2-* design tokens are in scope), and renders the ambient shader
 * behind everything by default.
 */
export function LandingChrome({ children, noAmbient, className }: LandingChromeProps) {
  return (
    <main className={cn('landing-v2 relative min-h-screen overflow-x-clip', className)}>
      {noAmbient ? null : <AmbientBackground />}
      {/* ImageKitProvider is scoped to the lander only — the rest of the
          app uses local assets / different CDNs. Wrapping here means
          every <Image> from `@imagekit/next` inside a landing surface
          picks up the duet endpoint without each call site repeating it. */}
      <ImageKitProvider urlEndpoint={IK_URL_ENDPOINT}>{children}</ImageKitProvider>
    </main>
  )
}
