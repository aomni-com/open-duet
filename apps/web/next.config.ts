import path from 'node:path'

import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
import { PHASE_PRODUCTION_BUILD } from 'next/constants'

import {
  requireConvexPublicUrlForBuild,
  resolveConvexAuthPublicUrl,
} from './src/auth/convex-public-url'
import { PRODUCT_REWRITE_SOURCES } from './src/routing/product-routes'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')
const convexAuthPublicUrl = resolveConvexAuthPublicUrl(process.env)

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'www.google.com',
        pathname: '/s2/favicons',
      },
    ],
  },
  // Keep `/_next/static/*?dpl=` and the churning favicon URL out of the index
  // as standalone documents. See apps/lander/next.config.ts for the full
  // rationale; app.duet.so shares the `sc-domain:duet.so` Search Console
  // property, so its asset URLs land in the same report.
  headers: async () => [
    {
      source: '/_next/static/:path*',
      headers: [{ key: 'X-Robots-Tag', value: 'noindex' }],
    },
    {
      source: '/favicon.ico',
      headers: [{ key: 'X-Robots-Tag', value: 'noindex' }],
    },
  ],
  rewrites: async () => ({
    fallback: PRODUCT_REWRITE_SOURCES.filter(source => source !== '/').map(source => ({
      source,
      destination: '/',
    })),
  }),
  skipTrailingSlashRedirect: true,
  turbopack: { root: path.resolve(import.meta.dirname, '../..') },
  ...(convexAuthPublicUrl === undefined
    ? {}
    : { env: { NEXT_PUBLIC_CONVEX_URL: convexAuthPublicUrl } }),
}

/* `next dev` stays tolerant — the playground and the static marketing routes
   run fine without a backend — but a production build without a resolvable
   Convex URL inlines nothing and ships client chunks that crash on load, so
   the build itself is the right place to refuse. */
export default function config(phase: string) {
  if (phase === PHASE_PRODUCTION_BUILD) requireConvexPublicUrlForBuild(process.env)
  return withNextIntl(nextConfig)
}
