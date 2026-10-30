import { createHash } from 'node:crypto'

import { PUBLIC_ROUTE_MANIFEST, type PublicRoute } from '../../src/public-route-manifest'

const REPRESENTATIVE_DYNAMIC_PATHS = new Set([
  // Two deliberately different blog bodies: the first owns translated rich
  // content and ProductLink; the second owns accordion and table-of-contents
  // rendering. Generated post URLs remain covered by the manifest/build gate.
  '/blog/6-best-ai-agent-builders-in-2026',
  // One Spanish editorial body stands in for the translated template; the
  // discontinued /es marketing trees are redirect-covered by their hub shots.
  '/es/blog/6-best-ai-agent-builders-in-2026',
  '/blog/mcp-servers-for-claude-code-examples',
  // Richest guide body.
  '/guides/claude-code-for-founders',
  // One route for each generated listing or marketing template. Components
  // are increasingly fixture-owned in the playground, so this list stays at
  // one KEY route per template rather than every locale twin.
  '/blog/category/ai',
  '/blog/tag/ai-agents',
  '/for/med-spas',
  '/use-cases/by-job/content-marketing',
  '/use-cases/small-businesses/shopify-store',
  '/vs/claude-code',
])

export const VISUAL_PUBLIC_ROUTES = PUBLIC_ROUTE_MANIFEST.filter(route =>
  isDistinctPageOrRepresentative(route),
)

export const NO_JS_PUBLIC_ROUTES = [
  '/',
  '/es',
  '/blog/6-best-ai-agent-builders-in-2026',
  '/es/blog/6-best-ai-agent-builders-in-2026',
  '/guides/duet-vs-codex',
  '/es/guides/duet-vs-codex',
  '/pricing',
  '/es/pricing',
] as const

/** The pages whose centrepieces are WebGL: the train globe (three.js) and the
 * mesh-gradient backdrop. A client that cannot give them a GL context — a
 * scraper, an agent's headless browser, a machine whose GPU process died — must
 * still be served the page, so these are the routes worth loading GL-less. */
export const NO_WEBGL_PUBLIC_ROUTES = [
  '/',
  '/l/platform',
  '/l/agent-cloud',
  '/l/file-sharing',
] as const

function isDistinctPageOrRepresentative(route: PublicRoute): boolean {
  const pathname = route.publicPath
  if (/^\/(?:es\/)?blog\/category\//.test(pathname)) {
    return REPRESENTATIVE_DYNAMIC_PATHS.has(pathname)
  }
  if (/^\/(?:es\/)?blog\/tag\//.test(pathname)) {
    return REPRESENTATIVE_DYNAMIC_PATHS.has(pathname)
  }
  if (/^\/(?:es\/)?blog\/[^/]+$/.test(pathname)) {
    return REPRESENTATIVE_DYNAMIC_PATHS.has(pathname)
  }
  if (/^\/(?:es\/)?guides\/[^/]+$/.test(pathname)) {
    return REPRESENTATIVE_DYNAMIC_PATHS.has(pathname)
  }
  if (/^\/for\/(?:med-spas|roofers|vet-practices)$/.test(pathname)) {
    return REPRESENTATIVE_DYNAMIC_PATHS.has(pathname)
  }
  if (/^\/(?:es\/)?use-cases\/by-job\/[^/]+$/.test(pathname)) {
    return REPRESENTATIVE_DYNAMIC_PATHS.has(pathname)
  }
  if (/^\/(?:es\/)?use-cases\/small-businesses\/[^/]+$/.test(pathname)) {
    return REPRESENTATIVE_DYNAMIC_PATHS.has(pathname)
  }
  if (/^\/(?:es\/)?vs\/[^/]+$/.test(pathname)) {
    return REPRESENTATIVE_DYNAMIC_PATHS.has(pathname)
  }
  return true
}

export function publicRouteId(pathname: string): string {
  const decodedPathname = decodeURIComponent(pathname)
  const readable = decodedPathname === '/' ? 'root' : decodedPathname.slice(1).replaceAll('/', '--')
  if (/^[A-Za-z0-9._-]+$/.test(readable)) return readable

  const sanitized = readable.replaceAll(/[^A-Za-z0-9._-]+/g, '-')
  const digest = createHash('sha256').update(decodedPathname).digest('hex').slice(0, 10)
  return `${sanitized}-${digest}`
}
