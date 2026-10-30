import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')

test('the lander keeps native analytics and click capture without browser ad runtimes', () => {
  const layout = readFileSync(path.join(root, 'app/layout.tsx'), 'utf8')

  for (const marker of [
    'googletagmanager.com',
    'connect.facebook.net',
    'redditstatic.com/ads/pixel.js',
    'bzrcdn.openai.com',
    'GoogleTagManager',
    'OpenAiPixel',
    'meta-pixel',
    'reddit-pixel',
  ]) {
    expect(layout).not.toContain(marker)
  }
  for (const obsolete of [
    'components/analytics/google-tag-manager.tsx',
    'components/analytics/openai-pixel.tsx',
    'lib/analytics/gtm.ts',
    'lib/analytics/reddit.ts',
  ]) {
    expect(existsSync(path.join(root, obsolete))).toBeFalse()
  }

  const campaignContract = readFileSync(
    path.resolve(root, '../../packages/contract/src/campaigns/index.ts'),
    'utf8',
  )
  expect(campaignContract).toContain("'fbclid'")
  expect(campaignContract).toContain("'oppref'")
})
