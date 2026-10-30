import './styles.css'

import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { DocsShell } from '../components/docs-shell'

export const metadata: Metadata = {
  metadataBase: new URL('https://docs.duet.so'),
  title: { default: 'Duet developer docs', template: '%s · Duet developer docs' },
  description: 'Build workspace tools and integrations with the Duet API.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Duet developer docs',
    title: 'Duet developer docs',
    description: 'Build workspace tools and integrations with the Duet API.',
    url: 'https://docs.duet.so',
  },
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <DocsShell>{children}</DocsShell>
      </body>
    </html>
  )
}
