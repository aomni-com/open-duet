import assert from 'node:assert/strict'

import { safeRequestTarget, type StagingArtifactCollector } from './staging-live-artifacts.ts'

export async function apiJson<T = unknown>(
  url: string,
  init: RequestInit,
  expectedStatus: number,
  label: string,
  artifacts?: StagingArtifactCollector,
): Promise<T> {
  const response =
    artifacts === undefined ? await stagingFetch(url, init) : await timedFetch(url, init, artifacts)
  assertResponse(response, expectedStatus, label)
  return (await response.json()) as T
}

export async function apiText(
  url: string,
  init: RequestInit,
  expectedStatus: number,
  label: string,
  artifacts?: StagingArtifactCollector,
): Promise<string> {
  const response =
    artifacts === undefined ? await stagingFetch(url, init) : await timedFetch(url, init, artifacts)
  assertResponse(response, expectedStatus, label)
  return await response.text()
}

export async function timedFetch(
  url: string,
  init: RequestInit,
  artifacts: StagingArtifactCollector,
): Promise<Response> {
  const startedAt = Date.now()
  try {
    const response = await stagingFetch(url, init)
    artifacts.recordApiTiming({
      method: init.method ?? 'GET',
      target: safeRequestTarget(url),
      status: response.status,
      durationMs: Date.now() - startedAt,
    })
    return response
  } catch (error) {
    artifacts.recordApiTiming({
      method: init.method ?? 'GET',
      target: safeRequestTarget(url),
      durationMs: Date.now() - startedAt,
      error: errorMessage(error),
    })
    throw error
  }
}

/**
 * One dropped connection should not discard an hour of legs.
 *
 * A run this long crosses the network thousands of times, and twice in four runs
 * a socket closed mid-flight — once as `Failed to fetch` inside the page, once as
 * `The socket connection was closed unexpectedly` out here — taking every leg
 * behind it with a message about transport rather than about the product.
 *
 * Retried only when the request never got an answer, and only for the methods
 * where asking twice means the same as asking once. A POST that dies in flight
 * may already have created what it was asked to create, so it is rethrown: a
 * duplicate workspace would be a worse lie than a failed run. An abort is the
 * caller's own decision and is never second-guessed.
 */
const TRANSPORT_RETRY_METHODS = new Set(['GET', 'HEAD'])
const TRANSPORT_RETRIES = 2
const TRANSPORT_RETRY_BACKOFF_MS = 500

async function fetchThroughTransportRetries(
  input: string | URL | Request,
  init: RequestInit,
): Promise<Response> {
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(input, init)
    } catch (error) {
      const aborted =
        (error instanceof Error && error.name === 'AbortError') || init.signal?.aborted === true
      if (aborted || !TRANSPORT_RETRY_METHODS.has(method) || attempt >= TRANSPORT_RETRIES)
        throw error
      await Bun.sleep(TRANSPORT_RETRY_BACKOFF_MS * (attempt + 1))
    }
  }
}

export async function stagingFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input)
  if (!url.hostname.includes('staging')) return await fetchThroughTransportRetries(input, init)
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  if (!secret) throw new Error('VERCEL_AUTOMATION_BYPASS_SECRET is required for staging fetches')
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value)
  headers.set('x-vercel-protection-bypass', secret)
  return await fetchThroughTransportRetries(input, { ...init, headers })
}

export async function assertApiCredentialRevoked(
  apiUrl: string,
  credential: string,
  fetchImpl: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = stagingFetch,
): Promise<void> {
  const response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/v1/whoami`, {
    headers: bearer(credential),
  })
  assert.equal(response.status, 401, 'logout did not revoke browser session credential')
}

export function assertResponse(response: Response, expected: number, label: string): void {
  assert.equal(
    response.status,
    expected,
    `${label} expected HTTP ${expected}, got ${response.status}`,
  )
}

export function bearer(token: string, initial?: HeadersInit): Headers {
  const headers = new Headers(initial)
  headers.set('authorization', `Bearer ${token}`)
  return headers
}

export function bearerJson(token: string, initial?: HeadersInit): Headers {
  const headers = bearer(token, initial)
  headers.set('content-type', 'application/json')
  return headers
}

export function vercelBypassHeaders(secret: string): Record<string, string> {
  return { 'x-vercel-protection-bypass': secret }
}

export function bearerTokenFromHeaders(headers: HeadersInit | undefined): string | null {
  if (headers === undefined) return null
  const authorization = new Headers(headers).get('authorization')
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

export function secondsSince(startedAt: number, fractionDigits = 1): number {
  return Number(((Date.now() - startedAt) / 1000).toFixed(fractionDigits))
}

export async function waitForWorkspace<T>(args: {
  workspaceId: string
  load: () => Promise<T | undefined>
  predicate: (workspace: T) => boolean | Promise<boolean>
  timeoutMs: number
  pollMs: number
  summarize?: (workspace: T | undefined) => unknown
}): Promise<T> {
  const deadline = Date.now() + args.timeoutMs
  let last: T | undefined
  for (;;) {
    last = await args.load()
    if (last !== undefined && (await args.predicate(last))) return last
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for workspace ${args.workspaceId}; last=${JSON.stringify(args.summarize?.(last) ?? last)}`,
      )
    }
    await Bun.sleep(args.pollMs)
  }
}

export async function readUntilTerminal(response: Response): Promise<Record<string, unknown>> {
  assertResponse(response, 200, 'agent events')
  assert(response.body !== null, 'agent event stream had no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 30_000
  try {
    for (;;) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal agent event')
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(1, deadline - Date.now())).then(() => ({
          done: true as const,
          value: undefined,
        })),
      ])
      if (chunk.done) throw new Error('Timed out waiting for terminal agent event')
      buffer += decoder.decode(chunk.value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const data = frame
          .split('\n')
          .find(line => line.startsWith('data: '))
          ?.slice('data: '.length)
        if (data === undefined) continue
        const row = JSON.parse(data) as { event: Record<string, unknown> }
        if (
          typeof row.event.type === 'string' &&
          ['complete', 'ask', 'interrupted', 'sleep'].includes(row.event.type)
        ) {
          return row.event
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run an operation again after a pause if it throws.
 *
 * For the legs that go through a freshly provisioned VM's gateway: a register
 * that lands before the gateway is answering 502s, and burning a whole live run
 * on that is worse than waiting fifteen seconds. Only ONE retry — a second
 * failure is a real one and should fail the journey.
 */
export async function retryOnce<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch {
    await new Promise(resolvePause => setTimeout(resolvePause, 15_000))
    return await operation()
  }
}
