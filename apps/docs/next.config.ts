import path from 'node:path'

import createMDX from '@next/mdx'
import type { NextConfig } from 'next'

const withMDX = createMDX({
  options: {
    // Turbopack resolves plugin names inside its worker. Passing imported
    // functions makes the loader options unserializable during `next build`.
    remarkPlugins: ['remark-gfm'],
    rehypePlugins: [
      ['rehype-pretty-code', { theme: 'github-dark-default', keepBackground: false }],
    ],
  },
})

const nextConfig: NextConfig = {
  // `output: 'export'` makes Next's headers() a silent no-op, so the
  // `X-Robots-Tag: noindex` rule that keeps `/_next/static/*?dpl=` asset URLs
  // out of Search Console lives in ./vercel.json instead. Don't add headers()
  // here expecting it to work.
  output: 'export',
  pageExtensions: ['ts', 'tsx', 'md', 'mdx'],
  poweredByHeader: false,
  trailingSlash: true,
  turbopack: {
    root: path.resolve(import.meta.dirname, '../..'),
  },
}

export default withMDX(nextConfig)
