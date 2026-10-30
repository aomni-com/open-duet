import type { Metadata } from 'next'

import { RuntimeIntlProvider } from '../../components/providers/runtime-intl-provider'
import { AuthProvider } from '../../src/auth/provider'

const description = 'Sign in to Duet to build your agents and use the ones shared with you.'

export const metadata: Metadata = {
  title: 'Sign in — Duet',
  description,
  alternates: { canonical: '/sign-in' },
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <RuntimeIntlProvider>
      <AuthProvider>{children}</AuthProvider>
    </RuntimeIntlProvider>
  )
}
