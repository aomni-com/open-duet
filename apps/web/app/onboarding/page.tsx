import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Set up your workspace — Duet',
  description: 'Name Duet, choose a starter team, and teach your workspace.',
  robots: { index: false, follow: false },
}

export default function OnboardingPage() {
  redirect('/')
}
