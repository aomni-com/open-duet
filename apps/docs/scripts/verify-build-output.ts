import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { DocsDeploymentSchema } from '@repo/contract'

import { docsCanonicalUrl, DOCS_ROUTES } from '../lib/docs'

const DOCS_ROOT = path.resolve(import.meta.dir, '..')
const failures: string[] = []

for (const route of DOCS_ROUTES) {
  const outputPath =
    route.href === '/'
      ? path.join(DOCS_ROOT, 'out/index.html')
      : path.join(DOCS_ROOT, 'out', route.href.slice(1), 'index.html')
  const html = await readFile(outputPath, 'utf8').catch(() => '')
  if (!html.includes('<h1'))
    failures.push(`${route.href}: static HTML is missing meaningful content`)
  const canonical = docsCanonicalUrl(route.href)
  if (!html.includes(`rel="canonical" href="${canonical}"`))
    failures.push(`${route.href}: canonical metadata does not match ${canonical}`)
}

const sitemap = await readFile(path.join(DOCS_ROOT, 'out/sitemap.xml'), 'utf8').catch(() => '')
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]!).sort()
const expectedSitemapUrls = DOCS_ROUTES.map(route => docsCanonicalUrl(route.href)).sort()
if (JSON.stringify(sitemapUrls) !== JSON.stringify(expectedSitemapUrls)) {
  failures.push('sitemap route set does not exactly match the docs route manifest')
}

const notFound = await readFile(path.join(DOCS_ROOT, 'out/404.html'), 'utf8').catch(() => '')
if (!notFound.includes('That document does not exist'))
  failures.push('custom static 404 is missing')

const highlighted = await readFile(
  path.join(DOCS_ROOT, 'out/getting-started/index.html'),
  'utf8',
).catch(() => '')
if (!highlighted.includes('data-rehype-pretty-code-figure')) {
  failures.push('syntax-highlighted static code output is missing')
}

const deployment = await readFile(path.join(DOCS_ROOT, 'out/deployment.json'), 'utf8')
  .then(source => DocsDeploymentSchema.safeParse(JSON.parse(source)))
  .catch(() => undefined)
if (deployment?.success !== true) failures.push('static deployment identity is missing or invalid')

if (failures.length > 0) {
  console.error(
    ['Static output verification failed:', ...failures.map(failure => `- ${failure}`)].join('\n'),
  )
  process.exit(1)
}

console.log(
  `Verified static HTML, canonical metadata, sitemap, deployment identity, and 404 for ${DOCS_ROUTES.length} routes.`,
)
