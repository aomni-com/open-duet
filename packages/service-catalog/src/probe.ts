import { evaluate, matchRoute, readPath, type PriceRule, type ServiceDefinition } from './index'

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface ProbeResult {
  service: string
  route: string
  verdict: 'ok' | 'drift' | 'forbidden' | 'unpriced' | 'error'
  computedUnits: number | null
  reportedUnits: number | null
  ledgerUnits: number | null
  status: number
  detail?: string
}

function reportedUnits(rule: PriceRule, headers: Headers, responseJson: unknown): number | null {
  switch (rule.kind) {
    case 'responseHeader': {
      const raw = headers.get(rule.header)
      const value = raw === null ? NaN : Number(raw)
      return Number.isFinite(value) ? value * (rule.rate ?? 1) : null
    }
    case 'responseJson': {
      const value = readPath(responseJson, rule.path)
      return typeof value === 'number' ? value * (rule.rate ?? 1) : null
    }
    case 'first':
      for (const child of rule.rules) {
        const value = reportedUnits(child, headers, responseJson)
        if (value !== null) return value
      }
      return null
    case 'asyncTerminal': {
      const status = readPath(responseJson, rule.statusPath)
      return typeof status === 'string' && rule.terminal.includes(status)
        ? reportedUnits(rule.cost, headers, responseJson)
        : null
    }
    default:
      return null
  }
}

function authHeaders(definition: ServiceDefinition, secret: string): Headers {
  const headers = new Headers()
  if (definition.auth.kind === 'bearer') headers.set('authorization', `Bearer ${secret}`)
  else if (definition.auth.kind === 'basic') headers.set('authorization', `Basic ${secret}`)
  else if (definition.auth.kind === 'header') headers.set(definition.auth.name, secret)
  return headers
}

function authUrl(definition: ServiceDefinition, path: string, secret: string): string {
  if (definition.auth.kind !== 'query') return `${definition.baseUrl}${path}`
  const separator = path.includes('?') ? '&' : '?'
  return `${definition.baseUrl}${path}${separator}${encodeURIComponent(definition.auth.name)}=${encodeURIComponent(secret)}`
}

async function readUsageUnits(
  definition: ServiceDefinition,
  secret: string,
  fetch: FetchLike,
): Promise<number | null> {
  const usage = definition.usage
  if (!usage) return null
  let response: Response
  try {
    response = await fetch(authUrl(definition, usage.path, secret), {
      method: 'GET',
      headers: authHeaders(definition, secret),
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  let json: unknown
  try {
    json = JSON.parse(await response.text())
  } catch {
    return null
  }
  let values: Record<string, number>
  try {
    values = usage.read(json)
  } catch {
    return null
  }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return null
  const numbers = Object.values(values)
  if (numbers.some(value => !Number.isFinite(value))) return null
  return numbers.reduce((sum, value) => sum + value, 0)
}

function compareUnits(left: number | null, right: number | null): boolean {
  return left !== null && right !== null && Math.ceil(left) !== Math.ceil(right)
}

export async function probeService(
  definition: ServiceDefinition,
  deps: { fetch: FetchLike; secret: (serviceId: string) => Promise<string | null> },
): Promise<ProbeResult[]> {
  const secret = await deps.secret(definition.id)
  if (!secret) return definition.routes.map(route => ({ service: definition.id, route: route.id, verdict: 'error', computedUnits: null, reportedUnits: null, ledgerUnits: null, status: 0, detail: 'credential unavailable' }))
  const results: ProbeResult[] = []
  for (const route of definition.routes) {
    if (!route.probe) continue
    const path = route.probe.path ?? route.path.replace(/:([A-Za-z0-9_]+)/g, 'probe')
    const queryParams = new URLSearchParams(route.probe.query)
    const headers = authHeaders(definition, secret)
    for (const [name, value] of Object.entries(route.probe.headers ?? {})) headers.set(name, value)
    if (definition.auth.kind === 'query') queryParams.set(definition.auth.name, secret)
    const query = queryParams.size === 0 ? '' : `?${queryParams}`
    let body: RequestInit['body']
    if (route.probe.multipart !== undefined) {
      const form = new FormData()
      for (const [name, value] of Object.entries(route.probe.multipart)) form.set(name, value)
      body = form
    } else if (route.probe.json !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(route.probe.json)
    }
    const usageBefore = route.price.kind === 'free' ? null : await readUsageUnits(definition, secret, deps.fetch)
    const startedAt = performance.now()
    let response: Response
    try {
      response = await deps.fetch(`${definition.baseUrl}${path}${query}`, { method: route.method, headers, body })
    } catch (error) {
      results.push({ service: definition.id, route: route.id, verdict: 'error', computedUnits: null, reportedUnits: null, ledgerUnits: null, status: 0, detail: error instanceof Error ? error.message : 'request failed' })
      continue
    }
    const text = await response.text()
    let json: unknown
    try { json = JSON.parse(text) } catch { json = undefined }
    const match = matchRoute(definition, route.method, path)
    const charge = match ? evaluate(definition, { route, params: match.params, status: response.status, headers: response.headers, elapsedMs: performance.now() - startedAt, responseJson: json, requestJson: route.probe.json }) : null
    const reported = response.ok ? reportedUnits(route.price, response.headers, json) : null
    const usageAfter = usageBefore === null ? null : await readUsageUnits(definition, secret, deps.fetch)
    const ledgerUnits = usageBefore !== null && usageAfter !== null ? usageAfter - usageBefore : null
    const drift = compareUnits(charge?.units ?? null, reported) || compareUnits(charge?.units ?? null, ledgerUnits)
    const detail = charge !== null && ledgerUnits !== null && compareUnits(charge.units, ledgerUnits)
      ? `usage ledger delta ${ledgerUnits} differs from computed ${charge.units}`
      : undefined
    results.push({ service: definition.id, route: route.id, verdict: response.status === 401 || response.status === 403 ? 'forbidden' : charge === null && route.price.kind !== 'free' ? 'unpriced' : drift ? 'drift' : response.ok ? 'ok' : 'error', computedUnits: charge?.units ?? null, reportedUnits: reported, ledgerUnits, status: response.status, detail })
  }
  return results
}
