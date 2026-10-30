import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { PRODUCT_REWRITE_SOURCES } from '../src/routing/product-routes'

const buildRoot = path.resolve(import.meta.dir, '../.next')
const prerender = JSON.parse(
  await readFile(path.join(buildRoot, 'prerender-manifest.json'), 'utf8'),
) as { routes: Record<string, unknown> }
const routeManifest = JSON.parse(
  await readFile(path.join(buildRoot, 'routes-manifest.json'), 'utf8'),
) as {
  staticRoutes: Array<{ page: string }>
  dynamicRoutes: Array<{ page: string }>
  rewrites: {
    afterFiles: Array<{ source: string; destination: string }>
    fallback: Array<{ source: string; destination: string }>
  }
}

const requiredStaticRoutes = [
  '/playground',
  '/playground/auth-surfaces',
  '/playground/spa-shell',
  '/playground/ui-primitives',
  '/product-route-manifest.json',
]
const requiredDynamicRoutes = [
  '/',
  '/device',
  '/sign-in',
  '/sign-out',
  '/w/[workspaceSlug]/apps/[slug]/open',
]
const missingStaticRoutes = requiredStaticRoutes.filter(route => !(route in prerender.routes))
if (missingStaticRoutes.length > 0) {
  throw new Error(`Routes lost static rendering: ${missingStaticRoutes.join(', ')}`)
}
const accidentallyStatic = requiredDynamicRoutes.filter(route => route in prerender.routes)
if (accidentallyStatic.length > 0) {
  throw new Error(`Identity routes unexpectedly prerendered: ${accidentallyStatic.join(', ')}`)
}

const routeOwners = new Set([
  ...routeManifest.staticRoutes.map(route => route.page),
  ...routeManifest.dynamicRoutes.map(route => route.page),
])
for (const route of requiredDynamicRoutes) {
  if (!routeOwners.has(route)) throw new Error(`Dynamic route owner is missing: ${route}`)
}
for (const removedRoute of ['/app', '/api/device']) {
  if (routeOwners.has(removedRoute))
    throw new Error(`Removed route still has an owner: ${removedRoute}`)
}

const expectedRewriteSources = PRODUCT_REWRITE_SOURCES.filter(source => source !== '/')
for (const source of expectedRewriteSources) {
  if (routeManifest.rewrites.afterFiles.some(candidate => candidate.source === source)) {
    throw new Error(`SPA rewrite shadows explicit product handlers: ${source}`)
  }
  const rewrite = routeManifest.rewrites.fallback.find(candidate => candidate.source === source)
  if (rewrite?.destination !== '/') {
    throw new Error(`Missing transparent ${source} → / SPA rewrite`)
  }
}

console.log(
  `Verified ${requiredStaticRoutes.length} static playground routes, ${requiredDynamicRoutes.length} dynamic identity/product routes, ${expectedRewriteSources.length} SPA rewrites, and no removed route owners.`,
)
