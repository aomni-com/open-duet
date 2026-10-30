export const DUET_LOCALE_COOKIE = 'DUET_LOCALE'

export const DUET_LOCALES = ['en', 'es-419'] as const
export type DuetLocale = (typeof DUET_LOCALES)[number]

const DUET_COOKIE_DOMAIN = '.duet.so'
const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365
// The PostHog SDK's dated defaults preset; pinning it keeps every Duet app on
// one set of SDK behaviors rather than drifting per app.
const POSTHOG_DEFAULTS = '2026-05-30'
const duetLocaleSet = new Set<string>(DUET_LOCALES)

export type PostHogPersistenceOptions = Readonly<{
  persistence: 'localStorage+cookie'
  cross_subdomain_cookie: boolean
  secure_cookie: boolean
  __preview_cookie_wins_on_conflict: boolean
}>

export type PostHogClientOptions = PostHogPersistenceOptions & {
  api_host?: string
  defaults: typeof POSTHOG_DEFAULTS
}

export function readDuetLocaleCookie(cookieHeader: string | null | undefined): DuetLocale | null {
  if (!cookieHeader) return null

  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    const name = pair.slice(0, separator).trim()
    if (name !== DUET_LOCALE_COOKIE) continue

    const value = pair.slice(separator + 1).trim()
    if (duetLocaleSet.has(value)) return value as DuetLocale
  }
  return null
}

export function serializeDuetLocaleCookie(locale: DuetLocale, hostname: string): string {
  const attributes = [
    `${DUET_LOCALE_COOKIE}=${locale}`,
    'Path=/',
    `Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ]

  if (isDuetHostname(hostname)) attributes.push(`Domain=${DUET_COOKIE_DOMAIN}`)
  if (!isLocalHostname(hostname)) attributes.push('Secure')
  return attributes.join('; ')
}

export function createPostHogPersistenceOptions(hostname: string): PostHogPersistenceOptions {
  const sharesDuetCookie = isDuetHostname(hostname)
  return {
    persistence: 'localStorage+cookie',
    cross_subdomain_cookie: sharesDuetCookie,
    secure_cookie: !isLocalHostname(hostname),
    __preview_cookie_wins_on_conflict: sharesDuetCookie,
  }
}

// Every Duet app configures the PostHog client the same way, so the whole
// option set has one owner and an app supplies only its own environment.
export function createPostHogClientOptions(args: {
  hostname: string
  apiHost?: string
}): PostHogClientOptions {
  return {
    ...(args.apiHost === undefined ? {} : { api_host: args.apiHost }),
    defaults: POSTHOG_DEFAULTS,
    ...createPostHogPersistenceOptions(args.hostname),
  }
}

function isDuetHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  return normalized === 'duet.so' || normalized.endsWith('.duet.so')
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '')
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized
}
