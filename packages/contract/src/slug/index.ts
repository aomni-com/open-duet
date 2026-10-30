import { z } from 'zod'

export const MAX_SLUG_LENGTH = 40

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Shared public namespace guard for workspace slugs, app subdomain slugs, and
 * publish slugs. v1's retired-slug anti-squat table is deliberately not ported:
 * slug edits leave no redirects, and workspace rename ships with a loud warning.
 */
const RESERVED_SLUGS = [
  '',
  'undefined',
  'null',
  'api',
  'app',
  'apps',
  'admin',
  'settings',
  'static',
  'sign-up',
  'sign-in',
  'login',
  'logout',
  'pricing',
  'blog',
  'docs',
  'invite',
  'cli',
  '_next',
  'manifest',
  'manifest-webmanifest',
  'sitemap',
  'sitemap-xml',
  'robots',
  'robots-txt',
  'terms',
  'privacy',
  'legal',
  'changelog',
  'about',
  'mobile',
  'webhooks',
  'health',
  'cdn-cgi',
  // The default agent's token — see ROOT_AGENT_SCOPE below, which owns the
  // spelling. It is reserved here so no registered agent can ever claim it.
  'root',
] as const

/**
 * The drive root's token, everywhere it carries meaning: session filters, job
 * filters, the `/agents/root` route family, the agent roster. It lives in the
 * slug module because it IS a slug — the one reserved above — and the modules
 * that need it (`sessions`, `agents`) both already depend on slugs, so this is
 * the one home that creates no cycle.
 */
export const ROOT_AGENT_SCOPE = 'root'

const RESERVED_SLUG_SET: ReadonlySet<string> = new Set(RESERVED_SLUGS)

type SlugNamespace = 'workspace' | 'app' | 'publish'

interface SlugValidationResult {
  ok: boolean
  reason?: 'empty' | 'too_long' | 'invalid_grammar' | 'reserved'
}

export function normalizeSlug(raw: string): string {
  if (!raw) return ''
  const lowered = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
  const slug = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= MAX_SLUG_LENGTH) return slug
  return slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '')
}

function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUG_SET.has(slug.toLowerCase())
}

function validateSlug(slug: string): SlugValidationResult {
  if (slug.length === 0) return { ok: false, reason: 'empty' }
  if (slug.length > MAX_SLUG_LENGTH) return { ok: false, reason: 'too_long' }
  if (isReservedSlug(slug)) return { ok: false, reason: 'reserved' }
  if (!SLUG_PATTERN.test(slug)) return { ok: false, reason: 'invalid_grammar' }
  return { ok: true }
}

export function assertValidSlug(slug: string, namespace: SlugNamespace = 'workspace'): string {
  const result = validateSlug(slug)
  if (result.ok) return slug
  throw new Error(`Invalid ${namespace} slug: ${result.reason}`)
}

const SlugSchema = z.string().superRefine((slug, ctx) => {
  const result = validateSlug(slug)
  if (result.ok) return
  ctx.addIssue({
    code: 'custom',
    message: `Invalid slug: ${result.reason}`,
  })
})

export const NormalizedSlugSchema = z.string().transform(normalizeSlug).pipe(SlugSchema)

export const WorkspaceSlugSchema = SlugSchema
export const AppSlugSchema = SlugSchema
export const PublishSlugSchema = SlugSchema
