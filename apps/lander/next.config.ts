import path from 'node:path'

import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  // Cosmetic Search Console cleanup for two crawl-churn sources:
  //   (a) `/_next/static/*?dpl=` chunk/CSS/font URLs — every HTML page links
  //       the chunks (so Googlebot must fetch them to render) and Vercel Skew
  //       Protection mints a fresh `?dpl=<hash>` set on every deploy.
  //   (b) `/favicon.ico?favicon.<hash>.ico?dpl=` — Next emits this malformed
  //       double-query icon href, so a new favicon URL appears each deploy.
  // Both get reported as 'Crawled – currently not indexed' under the
  // `sc-domain:duet.so` property, which spans every subdomain.
  // Canonical fix per Google: keep crawling ALLOWED (rendering needs the
  // JS/CSS — never Disallow `/_next/` in robots.txt, that would block
  // rendering and harm indexing of real pages) but send `X-Robots-Tag:
  // noindex` so the asset URLs report as excluded-by-noindex and never enter
  // the index as standalone documents. Header source matching ignores the
  // query string, so one rule covers every `?dpl` variant automatically.
  // Mirrored in apps/web/next.config.ts and apps/docs/vercel.json (the docs
  // app is `output: 'export'`, where Next's headers() is a no-op).
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
  redirects: async () => [
    {
      source: '/guides/claude-code-for-beginners',
      destination: '/guides/claude-code-for-founders',
      permanent: true,
    },
    {
      source: '/blog/acord-forms-commercial-quote-prep-with-ai',
      destination: '/guides/acord-forms-commercial-quote-prep-with-ai',
      permanent: true,
    },
    {
      source: '/blog/client-emails-renewal-follow-ups-faster-with-ai',
      destination: '/guides/client-emails-renewal-follow-ups-faster-with-ai',
      permanent: true,
    },
    {
      source: '/blog/how-to-cut-rekeying-in-carrier-portals',
      destination: '/guides/how-to-cut-rekeying-in-carrier-portals',
      permanent: true,
    },
    // Never a published slug — an inbound link (newsletter/social) invented it.
    // The growth story it promises is the 800% traffic post, so send it there
    // rather than let the link keep dead-ending on a 404.
    {
      source: '/blog/how-we-use-duet-to-grow-duet',
      destination: '/blog/how-we-grew-google-traffic-800-percent-with-ai',
      permanent: true,
    },
  ],
  skipTrailingSlashRedirect: true,
  turbopack: { root: path.resolve(import.meta.dirname, '../..') },
}

export default withNextIntl(nextConfig)
