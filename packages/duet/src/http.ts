import type { FetchLike } from '@repo/contract'

import { EXIT_CODES, CliError } from './exit-codes.js'

export interface ApiClientOptions {
  baseUrl: string
  apiKey?: string
  fetch?: FetchLike
}

export interface RequestOptions {
  method?: string
  body?: RequestInit['body']
  json?: unknown
  headers?: RequestInit['headers']
  auth?: boolean
  /** Refuse redirects for operations that return one-time secrets. */
  redirect?: RequestInit['redirect']
  /** Keep failures free of response bodies for one-time secret operations. */
  errorMode?: 'status' | 'raw'
}

export class ApiClient {
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly fetchImpl: FetchLike

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    // Wrapped, never stored bare: a browser's fetch is brand-checked on the
    // global object, so `this.fetchImpl(...)` on a bare reference throws
    // "Illegal invocation" there. Node tolerates it; the wrapper means this
    // client behaves the same in both.
    const fetchImpl = options.fetch ?? fetch
    this.fetchImpl = (input, init) => fetchImpl(input, init)
  }

  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers)
    const auth = options.auth ?? true
    if (auth) {
      if (this.apiKey === undefined || this.apiKey.length === 0) {
        throw new CliError('unauthorized', 'Run duet login first.', EXIT_CODES.auth)
      }
      headers.set('authorization', `Bearer ${this.apiKey}`)
    }
    let body = options.body
    if (options.json !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(options.json)
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1${path}`, {
        method: options.method ?? 'GET',
        headers,
        body,
        ...(options.redirect === undefined ? {} : { redirect: options.redirect }),
        ...(body === undefined || body === null ? {} : { duplex: 'half' }),
      } as RequestInit & { duplex?: 'half' })
    } catch (error) {
      throw new CliError(
        'network',
        error instanceof Error ? error.message : 'Network request failed.',
        EXIT_CODES.network,
      )
    }
    if (!response.ok && options.errorMode !== 'raw') await throwHttpError(response, options.errorMode === 'status')
    return response
  }
}

export async function throwHttpError(response: Response, statusOnly = false): Promise<never> {
  const body: Record<string, unknown> = statusOnly
    ? { status: response.status }
    : await readErrorBody(response)
  const error = statusOnly
    ? 'request_failed'
    : typeof body.error === 'string'
      ? body.error
      : response.statusText || 'request_failed'
  if (response.status === 401)
    throw new CliError('unauthorized', 'Authentication failed.', EXIT_CODES.auth, body)
  if (response.status === 403) {
    const scope = typeof body.scope === 'string' ? body.scope : undefined
    throw new CliError(
      'insufficient_scope',
      scope === undefined ? 'Missing required scope.' : `Missing required scope: ${scope}`,
      EXIT_CODES.scope,
      body,
    )
  }
  if (response.status === 404)
    throw new CliError('not_found', 'Not found.', EXIT_CODES.notFound, body)
  throw new CliError(
    error,
    `API request failed with HTTP ${response.status}.`,
    EXIT_CODES.generic,
    {
      ...body,
      status: response.status,
    },
  )
}

async function readErrorBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await response.json()) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
