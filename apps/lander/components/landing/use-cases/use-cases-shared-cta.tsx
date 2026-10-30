import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr'
import { type ReactNode } from 'react'

import { PrimaryCta } from '@/components/landing/landing-cta'
import { productHref } from '@/src/config/origins'

type UseCasesSharedCtaProps = {
  /** Override the label — defaults to "Start free". */
  children?: ReactNode
  /** Hero CTAs use lg; inline section CTAs use md. */
  size?: 'sm' | 'md' | 'lg'
  /** Show a soft pulsing halo behind the pill (hero and final CTA only). */
  halo?: boolean
  /** Magnetic cursor — off by default in dense layouts. */
  magnetic?: boolean
}

/**
 * Thin wrapper around the canonical `PrimaryCta` pill. Exists so every
 * call site in the /use-cases section pulls the same default
 * destination, sizing, and arrow affordance — and a future tweak to
 * use-case CTAs only needs to touch one file.
 */
export function UseCasesSharedCta({
  children = 'Start free',
  size = 'md',
  halo = false,
  magnetic = false,
}: UseCasesSharedCtaProps) {
  return (
    <PrimaryCta href={productHref('/sign-in')} size={size} halo={halo} magnetic={magnetic}>
      {children}
      <ArrowRightIcon weight="bold" className="size-4" aria-hidden="true" />
    </PrimaryCta>
  )
}
