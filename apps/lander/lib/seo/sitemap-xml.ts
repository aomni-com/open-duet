import type { MetadataRoute } from 'next'

// Serialises a shard's entries into the same `<urlset>` XML that Next's
// metadata sitemap convention produced, so migrating off `generateSitemaps`
// to explicit route handlers does not change a single byte Google sees:
//   - no indentation, one tag per line
//   - `xmlns:xhtml` declared only when at least one entry has alternates
//   - per-url order: <loc>, <xhtml:link …/>, <lastmod>, <changefreq>, <priority>
//   - Date lastModified -> ISO string; string lastModified passed through
//   - priority via String() ("1", not "1.0")

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function formatLastmod(lastModified: NonNullable<MetadataRoute.Sitemap[number]['lastModified']>) {
  return lastModified instanceof Date ? lastModified.toISOString() : String(lastModified)
}

export function buildUrlsetXml(entries: MetadataRoute.Sitemap): string {
  const hasAlternates = entries.some(entry => entry.alternates?.languages)
  const urlsetOpen = hasAlternates
    ? '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
    : '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'

  const body = entries
    .map(entry => {
      const lines = ['<url>', `<loc>${escapeXml(entry.url)}</loc>`]
      const languages = entry.alternates?.languages
      if (languages) {
        for (const [hreflang, href] of Object.entries(languages)) {
          if (href == null) continue
          lines.push(
            `<xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${escapeXml(String(href))}" />`,
          )
        }
      }
      if (entry.lastModified != null) {
        lines.push(`<lastmod>${formatLastmod(entry.lastModified)}</lastmod>`)
      }
      if (entry.changeFrequency != null) {
        lines.push(`<changefreq>${entry.changeFrequency}</changefreq>`)
      }
      if (entry.priority != null) {
        lines.push(`<priority>${entry.priority}</priority>`)
      }
      lines.push('</url>')
      return lines.join('\n')
    })
    .join('\n')

  const inner = entries.length > 0 ? `${urlsetOpen}\n${body}\n` : `${urlsetOpen}\n`
  return `<?xml version="1.0" encoding="UTF-8"?>\n${inner}</urlset>\n`
}
