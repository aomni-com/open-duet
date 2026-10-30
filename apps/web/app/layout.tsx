import './globals.css'

import { PostHogPageView, PostHogProvider } from '@posthog/next'
import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'

import '@repo/tailwind-config/globals.css'
import { cn } from '@repo/ui/lib/utils'
import { createPostHogClientOptions } from '@repo/web-locale'

import { ProductProviders } from '@/components/providers/product-providers'
import { browserCookieHostname } from '@/src/site-config'

const sansRoman = localFont({
  src: [
    {
      path: '../public/fonts/sans-variable.woff2',
      style: 'normal',
      weight: '100 900',
    },
  ],
  variable: '--font-sans',
  preload: true,
  display: 'swap',
})
const sansItalic = localFont({
  src: [
    {
      path: '../public/fonts/sans-italic-variable.woff2',
      style: 'italic',
      weight: '100 900',
    },
  ],
  variable: '--font-sans-italic',
  preload: false,
  display: 'swap',
})
const mono = localFont({
  src: [
    { path: '../public/fonts/mono-regular.otf', weight: '400' },
    { path: '../public/fonts/mono-medium.otf', weight: '500' },
    { path: '../public/fonts/mono-semibold.otf', weight: '600' },
    { path: '../public/fonts/mono-bold.otf', weight: '700' },
  ],
  variable: '--font-mono',
  preload: false,
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(process.env.DUET_APP_URL ?? 'https://app.duet.so'),
  title: 'Duet',
  description: 'Build AI agents from how you work, and share them.',
  applicationName: 'Duet',
  icons: {
    icon: '/favicon.ico',
    apple: '/icons/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const postHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  const isVercelDeployment = process.env.VERCEL === '1'
  const content = <ProductProviders>{children}</ProductProviders>
  return (
    <html
      lang="en"
      className={cn(sansRoman.variable, sansItalic.variable, mono.variable, 'antialiased')}
      suppressHydrationWarning
    >
      <body className="font-sans" suppressHydrationWarning>
        {postHogKey ? (
          <PostHogProvider
            apiKey={postHogKey}
            clientOptions={createPostHogClientOptions({
              hostname: browserCookieHostname(),
              apiHost: process.env.NEXT_PUBLIC_POSTHOG_HOST,
            })}
          >
            {content}
            <PostHogPageView />
          </PostHogProvider>
        ) : (
          content
        )}
        {isVercelDeployment ? (
          <>
            <Analytics />
            <SpeedInsights />
          </>
        ) : null}
      </body>
    </html>
  )
}
