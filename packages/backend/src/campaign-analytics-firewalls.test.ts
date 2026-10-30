import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '../../..')

test('campaign analytics keeps one vocabulary and no history, config, browser-ad, or legacy-lead owner', () => {
  const schema = source('packages/backend/convex/schema.ts')
  expect(schema).not.toMatch(/\banalyticsEvents?\s*:\s*defineTable/)
  expect(schema).not.toMatch(/\banalyticsReplay/)
  expect(schema).not.toMatch(/\bcampaignConfigs?\s*:\s*defineTable/)

  const apiRoute = source('apps/api/src/routes/analytics.ts')
  expect(apiRoute).not.toMatch(/app\.get\(['"]\/v1\/analytics/)

  const analyticsDomain = sourcesUnder('packages/backend/convex/domains/analytics')
  expect(analyticsDomain).not.toMatch(/\b(list|replay|backfill)Analytics/)
  expect(analyticsDomain).not.toMatch(/ctx\.db\.(insert|query)\(['"]analyticsEvents?['"]\)/)

  const eventContract = source('packages/contract/src/analytics/index.ts')
  expect(eventContract.match(/export const ANALYTICS_EVENT_NAMES/g)).toHaveLength(1)
  expect(eventContract).toContain("name => name !== 'conversion.evaluated'")
  expect(sourcesUnder('packages/contract/src')).not.toMatch(
    /export const ANALYTICS_EVENT_NAMES[\s\S]*export const ANALYTICS_EVENT_NAMES/,
  )

  const browserProduction = [
    sourcesUnder('apps/web', isProductionBrowserSource),
    sourcesUnder('apps/lander', isProductionBrowserSource),
  ].join('\n')
  for (const forbidden of [
    'META_CONVERSIONS_ACCESS_TOKEN',
    'GOOGLE_DATA_MANAGER_CLIENT_SECRET',
    'GOOGLE_DATA_MANAGER_REFRESH_TOKEN',
    'REDDIT_CONVERSIONS_ACCESS_TOKEN',
    'OPENAI_CONVERSIONS_API_KEY',
    'connect.facebook.net',
    'redditstatic.com/ads/pixel.js',
    'bzrcdn.openai.com',
    'googletagmanager.com',
  ]) {
    expect(browserProduction).not.toContain(forbidden)
  }

  const applicationRoutes = [
    sourcesUnder('apps/api/src', isProductionTypeScript),
    sourcesUnder('apps/lander/app', isProductionTypeScript),
  ].join('\n')
  expect(applicationRoutes).not.toContain('/api/leads')
  expect(applicationRoutes).not.toContain('/v1/leads')
  expect(applicationRoutes).not.toMatch(/\b(hubspot|salesforce|marketo)\b/i)
})

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8')
}

function sourcesUnder(
  relativeDirectory: string,
  include: (file: string) => boolean = isProductionTypeScript,
): string {
  const directory = path.join(root, relativeDirectory)
  return filesUnder(directory)
    .filter(include)
    .map(file => readFileSync(file, 'utf8'))
    .join('\n')
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(target) : statSync(target).isFile() ? [target] : []
  })
}

function isProductionTypeScript(file: string): boolean {
  return (
    /\.(?:ts|tsx)$/.test(file) &&
    !/\.(?:test|spec)\.(?:ts|tsx)$/.test(file) &&
    !file.includes(`${path.sep}playground${path.sep}`)
  )
}

function isProductionBrowserSource(file: string): boolean {
  return (
    isProductionTypeScript(file) &&
    !file.includes(`${path.sep}scripts${path.sep}`) &&
    !file.includes(`${path.sep}tests${path.sep}`)
  )
}
