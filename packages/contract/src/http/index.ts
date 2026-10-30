import { z } from 'zod'

export const DUET_API_ORIGIN = 'https://ctl.duet.so'

export const AUTHENTICATED_API_RATE_LIMIT = 600
export const AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS = 60_000

export const ApiRateLimitErrorSchema = z.object({
  error: z.literal('rate_limited'),
  retryAfterSeconds: z.number().int().positive(),
})
export type ApiRateLimitError = z.infer<typeof ApiRateLimitErrorSchema>

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function requestBody(request: Request): RequestInit['body'] {
  return request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body
}

export function duplexFor(request: Request): { duplex?: 'half' } {
  return request.method === 'GET' || request.method === 'HEAD' ? {} : { duplex: 'half' }
}
