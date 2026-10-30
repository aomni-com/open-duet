import assert from 'node:assert/strict'

const PRODUCTION_ORIGINS = {
  DUET_API_URL: 'https://ctl.duet.so',
  DUET_APP_URL: 'https://app.duet.so',
  DUET_DOCS_URL: 'https://docs.duet.so',
} as const

export type ProductionReleaseOriginName = keyof typeof PRODUCTION_ORIGINS

export function productionReleaseOrigin(name: ProductionReleaseOriginName, input: string): string {
  const canonical = PRODUCTION_ORIGINS[name]
  try {
    assert(input === canonical || input === `${canonical}/`)
    return canonical
  } catch {
    throw new Error(`${name} must equal the canonical production origin`)
  }
}

export function productionConvexDeployment(input: string): string {
  const deployment = input.trim()
  assert(deployment !== '', 'CONVEX_DEPLOYMENT is required')
  assert(deployment.startsWith('prod:'), 'CONVEX_DEPLOYMENT must select production')
  assert(deployment.slice('prod:'.length).trim() !== '', 'CONVEX_DEPLOYMENT is required')
  return deployment
}
