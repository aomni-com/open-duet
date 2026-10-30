export type DuetEnvironment = 'local' | 'staging' | 'production'

const ORIGINS: Record<DuetEnvironment, { lander: string; product: string }> = {
  local: { lander: 'http://localhost:3002', product: 'http://localhost:3000' },
  staging: {
    lander: 'https://lander-staging.duet.so',
    product: 'https://app-staging.duet.so',
  },
  production: { lander: 'https://duet.so', product: 'https://app.duet.so' },
}

// Next.js only substitutes public variables in client bundles when it can see
// the exact property access. Capturing them here keeps client-owned navigation
// on the same explicit origin that server-rendered canonicals and CTAs use.
const PUBLIC_BUILD_ENV = {
  NEXT_PUBLIC_DUET_APP_URL: process.env.NEXT_PUBLIC_DUET_APP_URL,
  NEXT_PUBLIC_DUET_LANDER_URL: process.env.NEXT_PUBLIC_DUET_LANDER_URL,
  VERCEL: process.env.VERCEL,
}

export function getLanderOrigin(environment: DuetEnvironment): string {
  return ORIGINS[environment].lander
}

export function getProductOrigin(environment: DuetEnvironment): string {
  return ORIGINS[environment].product
}

export function productHref(
  path: string,
  searchParams?: URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>,
  environment?: DuetEnvironment,
): string {
  assertProductPath(path)
  const url = new URL(
    path,
    environment === undefined ? resolveConfiguredProductOrigin() : getProductOrigin(environment),
  )
  for (const [name, values] of entries(searchParams)) {
    for (const value of values) url.searchParams.append(name, value)
  }
  return url.toString()
}

export function resolveConfiguredProductOrigin(
  env: Record<string, string | undefined> = PUBLIC_BUILD_ENV,
): string {
  const configured = env.NEXT_PUBLIC_DUET_APP_URL?.trim()
  if (!configured) {
    if (env.VERCEL === '1') {
      throw new Error('NEXT_PUBLIC_DUET_APP_URL is required for a deployed lander build')
    }
    return getProductOrigin('local')
  }
  return parseConfiguredOrigin(configured, 'product')
}

export function resolveConfiguredLanderOrigin(
  env: Record<string, string | undefined> = PUBLIC_BUILD_ENV,
): string {
  const configured = env.NEXT_PUBLIC_DUET_LANDER_URL?.trim()
  if (!configured) {
    if (env.VERCEL === '1') {
      throw new Error('NEXT_PUBLIC_DUET_LANDER_URL is required for a deployed lander build')
    }
    return getLanderOrigin('local')
  }
  return parseConfiguredOrigin(configured, 'lander')
}

function parseConfiguredOrigin(configured: string, owner: 'product' | 'lander'): string {
  const url = new URL(configured)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`Configured ${owner} origin must be an HTTP origin`)
  }
  return url.origin
}

export function resolveDuetEnvironment(
  value: string | undefined = process.env.VERCEL_ENV,
): DuetEnvironment {
  if (value === 'production') return 'production'
  if (value === 'preview' || value === 'staging') return 'staging'
  return 'local'
}

function assertProductPath(value: string): void {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    [...value].some(character => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  ) {
    throw new Error('Product destination must be a safe absolute path')
  }
  const parsed = new URL(value, 'https://product.invalid')
  if (parsed.origin !== 'https://product.invalid') {
    throw new Error('Product destination must not provide an origin')
  }
}

function entries(
  value:
    | URLSearchParams
    | Readonly<Record<string, string | readonly string[] | undefined>>
    | undefined,
): Array<[string, string[]]> {
  if (value === undefined) return []
  if (value instanceof URLSearchParams) {
    const grouped = new Map<string, string[]>()
    for (const [name, entry] of value) grouped.set(name, [...(grouped.get(name) ?? []), entry])
    return [...grouped]
  }
  return Object.entries(value).flatMap(([name, entry]) => {
    if (entry === undefined) return []
    return [[name, typeof entry === 'string' ? [entry] : [...entry]]]
  })
}
