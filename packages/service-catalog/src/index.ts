export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type ServiceCategory =
  | 'audio'
  | 'search'
  | 'scraping'
  | 'enrichment'
  | 'seo'
  | 'social'
  | 'media'
  | 'data'

export type AuthScheme =
  | { kind: 'bearer' }
  | { kind: 'basic' }
  | { kind: 'header'; name: string }
  | { kind: 'query'; name: string }

export type Admission = 'generate' | 'publicRead' | 'ownedById' | 'sharedPool'

export type PoolBinding =
  | { pool: string; role: 'create'; idFrom: string }
  | { pool: string; role: 'read' | 'use' }
  | { pool: string; role: 'mutate' | 'delete'; idParam: string }

export interface PoolDefinition {
  id: string
  ttlMs: number
  expire: { method: Method; path: string; body?: unknown }
  quota?: { read: string }
}

/** A vendor account usage endpoint used only by the local probe. */
export interface UsageDefinition {
  path: string
  read(json: unknown): Record<string, number>
}

export interface Needs {
  requestJson: boolean
  responseJson: boolean
}

export interface ChargeContext {
  route: Route
  params: Record<string, string>
  status: number
  headers: Headers
  elapsedMs: number
  requestJson?: unknown
  responseJson?: unknown
}

export interface VendorCharge {
  units: number
  reference?: string
}

export type PriceRule =
  | { kind: 'free' }
  | { kind: 'flat'; units: number }
  | { kind: 'responseHeader'; header: string; rate?: number }
  | { kind: 'responseJson'; path: string; rate?: number }
  | { kind: 'requestJson'; paths: string[]; rate: number }
  | { kind: 'table'; field: string; rows: Record<string, number>; default?: number }
  | { kind: 'first'; rules: PriceRule[] }
  | { kind: 'asyncStart' }
  | {
      kind: 'asyncTerminal'
      statusPath: string
      terminal: string[]
      idParam: string
      cost: PriceRule
    }
  | { kind: 'custom'; needs: Needs; price: (context: ChargeContext) => VendorCharge | null }

export interface Route {
  id: string
  method: Method
  path: string
  admission: Admission
  pool?: PoolBinding
  price: PriceRule
  success?: (input: { status: number; headers: Headers; body: unknown }) => boolean
  probe?: {
    path?: string
    headers?: Record<string, string>
    query?: Record<string, string>
    json?: unknown
    multipart?: Record<string, string>
  }
}

export interface ProviderHooks {
  beforeForward?: (request: ForwardRequest, context: HookContext) => ForwardRequest | HookRefusal
  afterResponse?: (response: VendorResponse, context: HookContext) => VendorResponse
  needs?: Needs
}

export interface ForwardRequest {
  method: Method
  path: string
  search: string
  headers: Headers
  body: unknown
}

export interface VendorResponse {
  status: number
  headers: Headers
  body: unknown
}

export interface HookContext {
  serviceId: string
  route: Route
  params: Record<string, string>
  workspaceId: string
}

export interface HookRefusal {
  kind: 'refusal'
  status: number
  code: string
  message: string
}

export interface ServiceDefinition {
  id: string
  baseUrl: string
  auth: AuthScheme
  unit: { name: string; microUsdPerUnit: number }
  routes: readonly Route[]
  usage?: UsageDefinition
  pools?: readonly PoolDefinition[]
  hooks?: ProviderHooks
  name: string
  summary: string
  category: ServiceCategory
  docsUrl: string
  llmsTxtUrl?: string
  notes: string
}

export interface Fixture {
  route: string
  request?: { method?: Method; json?: unknown; query?: Record<string, string> }
  response: { status: number; headers?: Record<string, string>; json?: unknown }
  params?: Record<string, string>
}

export const STANDARD_MARGIN = 1.2

export function readPath(value: unknown, path: string): unknown {
  const parts = path.split('.').filter(Boolean)
  let current: unknown = value
  for (const part of parts) {
    if (part.endsWith('[]')) {
      const key = part.slice(0, -2)
      const array = key ? (current as Record<string, unknown> | null)?.[key] : current
      if (!Array.isArray(array)) return undefined
      const remainder = parts.slice(parts.indexOf(part) + 1).join('.')
      return array.reduce<number>((sum, item) => {
        const child = remainder ? readPath(item, remainder) : item
        return sum + (typeof child === 'number' ? child : 0)
      }, 0)
    }
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function routeSegments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function routesOverlap(left: string, right: string): boolean {
  const a = routeSegments(left)
  const b = routeSegments(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const leftSegment = a[index]
    const rightSegment = b[index]
    if (leftSegment === '*' || rightSegment === '*') return true
    if (leftSegment === undefined || rightSegment === undefined) return false
    if (leftSegment.startsWith(':') || rightSegment.startsWith(':')) continue
    if (leftSegment !== rightSegment) return false
  }
  return true
}

function pathMatches(pattern: string, actual: string): Record<string, string> | null {
  if (actual.split('/').some(segment => segment === '..')) return null
  const expected = routeSegments(pattern)
  const received = routeSegments(actual)
  const wildcard = expected.at(-1) === '*'
  if (
    (!wildcard && expected.length !== received.length) ||
    (wildcard && received.length < expected.length - 1)
  ) {
    return null
  }
  const params: Record<string, string> = {}
  for (let i = 0; i < expected.length; i += 1) {
    const segment = expected[i]!
    if (segment === '*') break
    const value = received[i]!
    if (segment.startsWith(':')) params[segment.slice(1)] = value
    else if (segment !== value) return null
  }
  return params
}

export function matchRoute(
  definition: ServiceDefinition,
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | null {
  if (path.includes('..')) return null
  const normalizedMethod = method.toUpperCase()
  for (const route of definition.routes) {
    if (route.method !== normalizedMethod) continue
    const params = pathMatches(route.path, path)
    if (params !== null) return { route, params }
  }
  return null
}

export function needsOf(rule: PriceRule): Needs {
  switch (rule.kind) {
    case 'responseJson':
    case 'table':
      return { requestJson: false, responseJson: true }
    case 'requestJson':
      return { requestJson: true, responseJson: false }
    case 'custom':
      return rule.needs
    case 'first':
      return rule.rules.reduce<Needs>(
        (needs, child) => {
          const next = needsOf(child)
          return {
            requestJson: needs.requestJson || next.requestJson,
            responseJson: needs.responseJson || next.responseJson,
          }
        },
        { requestJson: false, responseJson: false },
      )
    case 'asyncTerminal': {
      const next = needsOf(rule.cost)
      return { requestJson: next.requestJson, responseJson: true }
    }
    default:
      return { requestJson: false, responseJson: false }
  }
}

function successful(route: Route, context: ChargeContext): boolean {
  if (route.success)
    return route.success({
      status: context.status,
      headers: context.headers,
      body: context.responseJson,
    })
  return context.status >= 200 && context.status < 300
}

function evaluateRule(rule: PriceRule, context: ChargeContext): VendorCharge | null {
  if (!successful(context.route, context)) return null
  switch (rule.kind) {
    case 'free':
    case 'asyncStart':
      return null
    case 'flat':
      return { units: rule.units }
    case 'responseHeader': {
      const value = context.headers.get(rule.header)
      const units = value === null ? null : Number(value)
      return units !== null && Number.isFinite(units) ? { units: units * (rule.rate ?? 1) } : null
    }
    case 'responseJson': {
      const value = readPath(context.responseJson, rule.path)
      return typeof value === 'number' ? { units: value * (rule.rate ?? 1) } : null
    }
    case 'requestJson': {
      for (const path of rule.paths) {
        const value = readPath(context.requestJson, path)
        if (typeof value === 'number') return { units: value * rule.rate }
      }
      return null
    }
    case 'table': {
      const value = readPath(context.responseJson, rule.field)
      if (typeof value !== 'string')
        return rule.default === undefined ? null : { units: rule.default }
      const units = rule.rows[value] ?? rule.default
      return units === undefined ? null : { units }
    }
    case 'first':
      for (const child of rule.rules) {
        const charge = evaluateRule(child, context)
        if (charge !== null) return charge
      }
      return null
    case 'asyncTerminal': {
      const status = readPath(context.responseJson, rule.statusPath)
      if (typeof status !== 'string' || !rule.terminal.includes(status)) return null
      return evaluateRule(rule.cost, context)
    }
    case 'custom':
      return rule.price(context)
  }
}

export function evaluate(
  definition: ServiceDefinition,
  context: ChargeContext,
): VendorCharge | null {
  const charge = evaluateRule(context.route.price, context)
  if (charge === null || context.route.price.kind !== 'asyncTerminal') return charge
  const resourceId = context.params[context.route.price.idParam]
  if (resourceId === undefined) return charge
  return {
    ...charge,
    reference: `service:${definition.id}:${context.route.id}:${resourceId}:final`,
  }
}

export function priceCharge(
  definition: ServiceDefinition,
  charge: VendorCharge,
): { vendorCostMicroUsd: number; chargeMicroUsd: number; reference?: string } {
  const vendorCostMicroUsd = Math.ceil(charge.units * definition.unit.microUsdPerUnit)
  return {
    vendorCostMicroUsd,
    chargeMicroUsd: Math.ceil(vendorCostMicroUsd * STANDARD_MARGIN),
    reference: charge.reference,
  }
}

export interface CatalogError {
  serviceId: string
  code: string
  message: string
  routeId?: string
  poolId?: string
}

function error(
  definition: ServiceDefinition,
  code: string,
  message: string,
  extra: Partial<CatalogError> = {},
): CatalogError {
  return { serviceId: definition.id, code, message, ...extra }
}

function validatePriceRule(
  definition: ServiceDefinition,
  route: Route,
  rule: PriceRule,
  errors: CatalogError[],
): void {
  const checkUnits = (units: number, label: string): void => {
    if (!Number.isFinite(units) || units < 0) {
      errors.push(
        error(definition, 'invalid_price_units', `${label} must be a finite non-negative number.`, {
          routeId: route.id,
        }),
      )
    }
  }
  const checkRate = (rate: number | undefined, label: string): void => {
    if (rate !== undefined) checkUnits(rate, label)
  }
  switch (rule.kind) {
    case 'flat':
      checkUnits(rule.units, 'Flat price units')
      break
    case 'responseHeader':
      checkRate(rule.rate, 'Response-header price rate')
      break
    case 'responseJson':
      checkRate(rule.rate, 'Response-body price rate')
      break
    case 'requestJson':
      checkRate(rule.rate, 'Request-body price rate')
      break
    case 'table':
      for (const [key, units] of Object.entries(rule.rows))
        checkUnits(units, `Table price for ${key}`)
      checkRate(rule.default, 'Table default price')
      break
    case 'first':
      for (const child of rule.rules) validatePriceRule(definition, route, child, errors)
      break
    case 'asyncTerminal':
      validatePriceRule(definition, route, rule.cost, errors)
      break
    case 'free':
    case 'asyncStart':
    case 'custom':
      break
  }
}

export function validateCatalog(definitions: readonly ServiceDefinition[]): CatalogError[] {
  const errors: CatalogError[] = []
  const serviceIds = new Set<string>()
  for (const definition of definitions) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(definition.id))
      errors.push(error(definition, 'invalid_service_id', 'Service id must be a URL-safe slug.'))
    if (serviceIds.has(definition.id))
      errors.push(error(definition, 'duplicate_service_id', 'Service id is duplicated.'))
    serviceIds.add(definition.id)
    if (!Number.isFinite(definition.unit.microUsdPerUnit) || definition.unit.microUsdPerUnit <= 0) {
      errors.push(
        error(
          definition,
          'invalid_unit_rate',
          'Service unit rate must be a finite positive number.',
        ),
      )
    }
    const routeIds = new Set<string>()
    const signatures = new Set<string>()
    const routePaths = new Map<Route['method'], string[]>()
    const pools = new Map((definition.pools ?? []).map(pool => [pool.id, pool]))
    for (const route of definition.routes) {
      validatePriceRule(definition, route, route.price, errors)
      if (routeIds.has(route.id))
        errors.push(
          error(definition, 'duplicate_route_id', 'Route id is duplicated.', { routeId: route.id }),
        )
      routeIds.add(route.id)
      const signature = `${route.method} ${route.path}`
      const sameMethodPaths = routePaths.get(route.method) ?? []
      if (
        signatures.has(signature) ||
        sameMethodPaths.some(path => routesOverlap(path, route.path))
      )
        errors.push(
          error(definition, 'ambiguous_route', 'Two routes can match the same method and path.', {
            routeId: route.id,
          }),
        )
      signatures.add(signature)
      routePaths.set(route.method, [...sameMethodPaths, route.path])
      if (!route.admission)
        errors.push(
          error(definition, 'missing_admission', 'Route admission is required.', {
            routeId: route.id,
          }),
        )
      if (route.admission === 'sharedPool') {
        const binding = route.pool
        if (!binding)
          errors.push(
            error(
              definition,
              'missing_pool_binding',
              'Shared-pool routes require a pool binding.',
              { routeId: route.id },
            ),
          )
        else if (!pools.has(binding.pool))
          errors.push(
            error(definition, 'unknown_pool', 'Route refers to an unknown pool.', {
              routeId: route.id,
              poolId: binding.pool,
            }),
          )
        else if (binding.role === 'create' && !binding.idFrom)
          errors.push(
            error(definition, 'missing_id_from', 'Pool create routes require idFrom.', {
              routeId: route.id,
            }),
          )
        else if ((binding.role === 'mutate' || binding.role === 'delete') && !binding.idParam)
          errors.push(
            error(definition, 'missing_id_param', 'Pool mutate/delete routes require idParam.', {
              routeId: route.id,
            }),
          )
      } else if (route.pool)
        errors.push(
          error(
            definition,
            'unexpected_pool_binding',
            'Only shared-pool routes may have a pool binding.',
            { routeId: route.id },
          ),
        )
    }
    const poolIds = new Set<string>()
    for (const pool of definition.pools ?? []) {
      if (poolIds.has(pool.id))
        errors.push(
          error(definition, 'duplicate_pool_id', 'Pool id is duplicated.', { poolId: pool.id }),
        )
      poolIds.add(pool.id)
      if (!Number.isFinite(pool.ttlMs) || pool.ttlMs <= 0)
        errors.push(
          error(definition, 'missing_pool_ttl', 'Pool requires a positive ttlMs.', {
            poolId: pool.id,
          }),
        )
      if (!pool.expire?.method || !pool.expire.path)
        errors.push(
          error(definition, 'missing_pool_expiry', 'Pool requires an expiry route.', {
            poolId: pool.id,
          }),
        )
      else if (
        !definition.routes.some(
          route => route.method === pool.expire.method && route.path === pool.expire.path,
        )
      ) {
        errors.push(
          error(
            definition,
            'missing_pool_expiry_route',
            'Pool expiry must refer to an admitted route.',
            { poolId: pool.id },
          ),
        )
      }
      if (pool.quota && !pool.quota.read)
        errors.push(
          error(definition, 'missing_pool_quota', 'Pool quota requires a read path.', {
            poolId: pool.id,
          }),
        )
    }
    if (definition.hooks?.needs === undefined && definition.hooks?.beforeForward) {
      // beforeForward receives the request object; an explicit needs declaration
      // keeps body buffering intentional for streaming routes.
      errors.push(
        error(
          definition,
          'missing_hook_needs',
          'Provider hooks that inspect bodies must declare needs.',
        ),
      )
    }
  }
  return errors
}

export function replayFixture(
  definition: ServiceDefinition,
  fixture: Fixture,
): { route: string; units: number | null } {
  const method = fixture.request?.method ?? 'POST'
  const matched = matchRoute(definition, method, fixture.route)
  if (!matched) return { route: fixture.route, units: null }
  const headers = new Headers(fixture.response.headers)
  const charge = evaluate(definition, {
    route: matched.route,
    params: fixture.params ?? matched.params,
    status: fixture.response.status,
    headers,
    elapsedMs: 0,
    requestJson: fixture.request?.json,
    responseJson: fixture.response.json,
  })
  return { route: matched.route.id, units: charge?.units ?? null }
}

export {
  SERVICE_DEFINITIONS,
  firecrawl,
  crustdata,
  fullenrich,
  dataforseo,
  elevenlabs,
  socialapi,
} from './vendors'
export { probeService, type ProbeResult } from './probe'
