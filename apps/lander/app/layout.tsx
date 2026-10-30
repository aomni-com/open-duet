import './globals.css'

import { PostHogPageView, PostHogProvider } from '@posthog/next'
import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import type { Metadata, Viewport } from 'next'
import { Vollkorn } from 'next/font/google'
import localFont from 'next/font/local'

import '@repo/tailwind-config/globals.css'
import { cn } from '@repo/ui/lib/utils'
import { createPostHogClientOptions } from '@repo/web-locale'

import { AdClickCapture } from '@/components/analytics/ad-click-capture'
import { OrganizationJsonLd } from '@/components/landing/organization-json-ld'
import { LocaleAutoDetect } from '@/components/locale-auto-detect'
import { StaticSiteProviders } from '@/components/static-site-providers'
import {
  BRAND_DESCRIPTION,
  BRAND_META_TITLE,
  BRAND_NAME,
  BRAND_TAGLINE,
  BRAND_TWITTER_HANDLE,
} from '@/lib/brand-copy'
import { resolveConfiguredLanderOrigin } from '@/src/config/origins'

const sansRoman = localFont({
  src: '../public/fonts/sans-variable.woff2',
  variable: '--font-sans',
  preload: true,
  display: 'swap',
})
const sansItalic = localFont({
  src: '../public/fonts/sans-italic-variable.woff2',
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
const display = Vollkorn({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-display',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(resolveConfiguredLanderOrigin()),
  title: BRAND_META_TITLE,
  applicationName: BRAND_NAME,
  description: BRAND_DESCRIPTION,
  icons: {
    icon: process.env.VERCEL_ENV === 'production' ? '/favicon.ico' : '/favicon-dev.ico',
    apple: '/icons/apple-touch-icon.png',
  },
  openGraph: {
    title: BRAND_META_TITLE,
    description: BRAND_DESCRIPTION,
    type: 'website',
    siteName: BRAND_NAME,
    locale: 'en_US',
    images: [
      {
        url: '/landing/duet-lander-image.jpg',
        width: 1200,
        height: 630,
        alt: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: BRAND_META_TITLE,
    description: BRAND_DESCRIPTION,
    site: BRAND_TWITTER_HANDLE,
    creator: BRAND_TWITTER_HANDLE,
    images: ['/landing/duet-lander-image.jpg'],
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
  const postHogHostname = new URL(resolveConfiguredLanderOrigin()).hostname
  const content = <StaticSiteProviders>{children}</StaticSiteProviders>
  return (
    <html
      lang="en"
      className={cn(
        sansRoman.variable,
        sansItalic.variable,
        mono.variable,
        display.variable,
        'antialiased',
      )}
      suppressHydrationWarning
    >
      <head>
        <LocaleAutoDetect />
      </head>
      <body className="font-sans" suppressHydrationWarning>
        <OrganizationJsonLd />
        {isVercelDeployment ? (
          <>
            <AdClickCapture />
            <Analytics />
            <SpeedInsights />
          </>
        ) : null}
        {postHogKey ? (
          <PostHogProvider
            apiKey={postHogKey}
            clientOptions={createPostHogClientOptions({
              hostname: postHogHostname,
              apiHost: process.env.NEXT_PUBLIC_POSTHOG_HOST,
            })}
          >
            {content}
            <PostHogPageView />
          </PostHogProvider>
        ) : (
          content
        )}
      </body>
    </html>
  )
}
