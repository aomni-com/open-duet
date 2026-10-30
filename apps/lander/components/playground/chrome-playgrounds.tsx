'use client'

import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { LandingNavFrost } from '@/components/landing/landing-nav-frost'

export function NavPlayground() {
  return (
    <div className="min-h-[60vh]">
      <LandingNavFrost>
        <LandingNav homeHref="/" />
      </LandingNavFrost>
      <div className="h-64" />
    </div>
  )
}

export function FooterPlayground() {
  return <LandingFooter />
}
