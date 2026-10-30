import type { MetadataRoute } from 'next'

import { docsCanonicalUrl, DOCS_ROUTES } from '../lib/docs'

export const dynamic = 'force-static'

export default function sitemap(): MetadataRoute.Sitemap {
  return DOCS_ROUTES.map(route => ({
    url: docsCanonicalUrl(route.href),
    changeFrequency: 'weekly',
    priority: route.href === '/' ? 1 : 0.7,
  }))
}
