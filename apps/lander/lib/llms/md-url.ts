/**
 * The one owner of the `/<route>.md` ⇄ `/md/<route>` mapping, shared by the
 * rewrite in `proxy.ts` and the route handler it rewrites to. Two spellings
 * of the same rule drift into twins that 404.
 */

/** The homepage has no path segment of its own, so its twin is named. */
const HOME_SEGMENT = 'index'

const MD_SUFFIX = '.md'

export function pathToMdSegments(path: string): string[] {
  return path === '/' ? [HOME_SEGMENT] : path.slice(1).split('/')
}

export function mdSegmentsToPath(segments: string[]): string {
  if (segments.length === 1 && segments[0] === HOME_SEGMENT) return '/'
  return `/${segments.join('/')}`
}

/** Where a page's twin is prerendered, as it appears in the build manifest. */
export function mdRoutePath(path: string): string {
  return `/md/${pathToMdSegments(path).join('/')}`
}

/**
 * The twin's public URL path — `/pricing` → `/pricing.md`, `/` → `/index.md`.
 * What a link in the agent-readable surfaces points at, since `robots.ts`
 * allows AI crawlers `*.md` site-wide and the styled page only in some trees.
 */
export function mdTwinPath(path: string): string {
  return `/${pathToMdSegments(path).join('/')}${MD_SUFFIX}`
}

/**
 * `/blog/foo.md` → `/md/blog/foo`, or null when the request is not a twin.
 * Deliberately narrow: only paths whose final segment ends in `.md`.
 */
export function mdRewriteTarget(pathname: string): string | null {
  if (!pathname.endsWith(MD_SUFFIX)) return null
  return `/md${pathname.slice(0, -MD_SUFFIX.length)}`
}
