import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import matter from 'gray-matter'

import { isProductCtaPath } from '../lib/blog/cta-href'
import { DARK_IMAGE_SOURCES } from '../lib/dark-image-variants'
import { PUBLIC_ROUTE_MANIFEST } from '../src/public-route-manifest'
import { SPANISH_PUBLIC_PATHS } from '../src/spanish-public-paths.generated'
import { findMojibake } from './public-text-integrity'

const LANDER_ROOT = path.resolve(import.meta.dir, '..')
const TEXT_ROOTS = ['app', 'components', 'content', 'messages', 'lib', 'src']
const REMOTE_IMAGEKIT_ASSETS = new Set([
  '/landing/landing-bg-light.mp4',
  '/landing/landing-bg-night.mp4',
  '/landing/landing-duet-every-morning.png',
  '/landing/landing-duet-for-the-launch.png',
  '/landing/landing-duet-hired.png',
  '/landing/landing-duet-mid-week-research.png',
  '/landing/landing-duet-on-demand-builds.png',
])
const ASSET_PATTERN =
  /(?:\/(?:landing|blog|guides|authors|icons|mascots|onboarding-mascot|use-cases|badges|fonts)\/[A-Za-z0-9_@./+% -]+?\.(?:png|jpe?g|webp|svg|gif|avif|mp4|webm|mov|woff2?|otf)|\/favicon-dev\.ico)/gi

const failures: string[] = []
const reachableLocalAssets = new Set<string>()
const routePaths = PUBLIC_ROUTE_MANIFEST.map(route => route.publicPath)
const publicRoutePaths = new Set(routePaths)
if (new Set(routePaths).size !== routePaths.length)
  failures.push('public route manifest has duplicates')
if (routePaths.length < 500)
  failures.push(`public route manifest is unexpectedly small: ${routePaths.length}`)

const expectedSpanishPaths = routePaths.filter(route => route === '/es' || route.startsWith('/es/'))
if (JSON.stringify(SPANISH_PUBLIC_PATHS) !== JSON.stringify(expectedSpanishPaths)) {
  failures.push('generated Spanish locale-switch paths do not match the public route manifest')
}

verifyMessageParity('marketing.json')
verifyTranslatedContent('blog')
verifyTranslatedContent('guides')
verifyDarkImageVariants()
verifyBrandAssets()

let referencedAssets = 0
for (const root of TEXT_ROOTS) {
  for (const relative of new Bun.Glob('**/*').scanSync({
    cwd: path.join(LANDER_ROOT, root),
    onlyFiles: true,
  })) {
    if (!/\.(?:[cm]?[jt]sx?|mdx|json|css)$/.test(relative)) continue
    const text = readFileSync(path.join(LANDER_ROOT, root, relative), 'utf8')
    for (const [index, line] of text.split('\n').entries()) {
      const damaged = findMojibake(line)
      if (damaged.length > 0) {
        failures.push(
          `mojibake in ${path.join(root, relative)}:${index + 1} (${[...new Set(damaged)].join(', ')})`,
        )
      }
    }
    if (/\.(?:[cm]?[jt]sx?)$/.test(relative) && /['"]\/sign-up(?:[?'"])/.test(text)) {
      failures.push(`removed /sign-up target in ${path.join(root, relative)}`)
    }
    if (relative.endsWith('.mdx')) {
      for (const match of text.matchAll(/!\[[^\]]*\]\(https:\/\/duet\.so(\/[^)]+)\)/g)) {
        failures.push(
          `same-origin MDX image must use a local path: ${path.join(root, relative)}:${match[1]}`,
        )
      }
      // A CTA names a path and the site decides the origin, so every authored
      // target has to be one the site can actually serve: a lander route, a
      // product path, or an anchor in this page. Without this the two are
      // indistinguishable and a typo resolves against whichever host is left.
      for (const match of text.matchAll(/^\s*href[:=] ?["']([^"']+)["']/gm)) {
        const target = match[1]!
        // external links are absolute by nature; a CTA target never is
        if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue
        if (isProductCtaPath(target)) continue
        const [routePath] = target.split(/[?#]/)
        if (!publicRoutePaths.has(routePath!)) {
          failures.push(`unroutable CTA href: ${target} in ${path.join(root, relative)}`)
        }
      }
      // `<ProductLink>` is the other way content names a link target, and it
      // declares its origin in the name, so the closed world it belongs to is
      // the product path list rather than the route manifest.
      for (const match of text.matchAll(/<ProductLink[^>]*\spath="([^"]+)"/g)) {
        const target = match[1]!
        if (!isProductCtaPath(target)) {
          failures.push(
            `ProductLink target is not a product path: ${target} in ${path.join(root, relative)}`,
          )
        }
      }
      for (const match of text.matchAll(/\]\((\/[^)\s?#]+)(?:[?#][^)]*)?\)/g)) {
        const target = decodeURI(match[1]!)
        if (
          !publicRoutePaths.has(target) &&
          !target.startsWith('/api/') &&
          !/\.(?:png|jpe?g|webp|svg|gif|avif|mp4|webm|mov|pdf|zip)$/i.test(target)
        ) {
          failures.push(`missing internal MDX route: ${target} in ${path.join(root, relative)}`)
        }
      }
    }
    for (const match of text.matchAll(ASSET_PATTERN)) {
      const asset = match[0]
      referencedAssets += 1
      if (REMOTE_IMAGEKIT_ASSETS.has(asset)) continue
      reachableLocalAssets.add(asset)
      const target = path.join(LANDER_ROOT, 'public', asset)
      try {
        if (!statSync(target).isFile()) failures.push(`missing public asset: ${asset}`)
      } catch {
        failures.push(`missing public asset: ${asset}`)
      }
    }
  }
}

for (const relative of new Bun.Glob('**/*').scanSync({
  cwd: path.join(LANDER_ROOT, 'public'),
  onlyFiles: true,
})) {
  const asset = `/${relative}`
  if (!reachableLocalAssets.has(asset)) failures.push(`unreachable public asset: ${asset}`)
}

if (failures.length > 0) {
  console.error(['Public content verification failed:', ...failures.map(x => `- ${x}`)].join('\n'))
  process.exit(1)
}

console.log(
  `Verified ${routePaths.length} public routes, translation parity, and ${referencedAssets} asset references.`,
)

function verifyMessageParity(file: string) {
  const en = JSON.parse(readFileSync(path.join(LANDER_ROOT, 'messages/en', file), 'utf8'))
  const es = JSON.parse(readFileSync(path.join(LANDER_ROOT, 'messages/es-419', file), 'utf8'))
  const enKeys = leafKeys(en).sort()
  const esKeys = leafKeys(es).sort()
  if (JSON.stringify(enKeys) !== JSON.stringify(esKeys)) {
    failures.push(`${file} English/Spanish leaf keys differ`)
  }
}

function leafKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  )
}

function verifyTranslatedContent(kind: 'blog' | 'guides') {
  const englishKeys = new Set<string>()
  for (const relative of new Bun.Glob('*.mdx').scanSync({
    cwd: path.join(LANDER_ROOT, 'content', kind),
  })) {
    const { data } = matter(readFileSync(path.join(LANDER_ROOT, 'content', kind, relative), 'utf8'))
    englishKeys.add(
      typeof data.translationKey === 'string'
        ? data.translationKey
        : relative.replace(/\.mdx$/, ''),
    )
  }
  for (const relative of new Bun.Glob('*.mdx').scanSync({
    cwd: path.join(LANDER_ROOT, 'content/es-419', kind),
  })) {
    const { data } = matter(
      readFileSync(path.join(LANDER_ROOT, 'content/es-419', kind, relative), 'utf8'),
    )
    if (data.locale !== 'es-419') failures.push(`${kind}/${relative} is missing locale es-419`)
    if (typeof data.translationKey !== 'string' || !englishKeys.has(data.translationKey)) {
      failures.push(`${kind}/${relative} has no matching English translationKey`)
    }
  }
}

function verifyDarkImageVariants() {
  const declared = [...DARK_IMAGE_SOURCES].sort()
  const discovered = [
    ...new Bun.Glob('**/*-dark.{png,jpg,jpeg,webp,gif}').scanSync({
      cwd: path.join(LANDER_ROOT, 'public'),
      onlyFiles: true,
    }),
  ]
    .map(relative => `/${relative.replace(/-dark(?=\.(?:png|jpe?g|webp|gif)$)/i, '')}`)
    .sort()
  if (JSON.stringify(declared) !== JSON.stringify(discovered)) {
    failures.push('dark image registry does not exactly match public dark variants')
  }
  for (const relative of new Bun.Glob('**/*-dark.{png,jpg,jpeg,webp,gif}').scanSync({
    cwd: path.join(LANDER_ROOT, 'public'),
    onlyFiles: true,
  })) {
    reachableLocalAssets.add(`/${relative}`)
  }
}

function verifyBrandAssets() {
  for (const relative of ['components/landing/trusted-by.tsx']) {
    const text = readFileSync(path.join(LANDER_ROOT, relative), 'utf8')
    for (const match of text.matchAll(/\bfile:\s*['"]([^'"]+\.svg)['"]/g)) {
      const file = match[1]
      if (file === undefined) continue
      reachableLocalAssets.add(`/landing/brands/${file}`)
      try {
        if (!statSync(path.join(LANDER_ROOT, 'public/landing/brands', file)).isFile()) {
          failures.push(`missing brand asset: ${file}`)
        }
      } catch {
        failures.push(`missing brand asset: ${file}`)
      }
    }
  }
}
