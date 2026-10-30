import type { ReactNode } from 'react'

import { RuntimeIntlProvider } from '@/components/providers/runtime-intl-provider'
import { AuthProvider } from '@/src/auth/provider'

export default function ProductLayout({ children }: { children: ReactNode }) {
  return (
    <RuntimeIntlProvider>
      <AuthProvider>{children}</AuthProvider>
    </RuntimeIntlProvider>
  )
}
