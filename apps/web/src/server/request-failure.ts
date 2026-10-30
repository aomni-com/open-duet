import { redactText } from '@repo/contract'

/** Keep diagnostics on the server; request bodies, cookies and URL queries carry credentials. */
export function reportRequestFailure(request: Request, event: string, error: unknown): void {
  console.error(event, {
    method: request.method,
    path: new URL(request.url).pathname,
    requestId: request.headers.get('x-vercel-id') ?? undefined,
    error: describeError(error),
  })
}

function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: diagnosticText(String(error)) }
  const code = 'code' in error ? error.code : undefined
  return {
    name: error.name,
    ...(typeof code === 'string' || typeof code === 'number'
      ? { code: diagnosticText(String(code)) }
      : {}),
    message: diagnosticText(error.message),
    stack: error.stack === undefined ? undefined : diagnosticText(error.stack),
    ...(error.cause === undefined || depth >= 3
      ? {}
      : { cause: describeError(error.cause, depth + 1) }),
  }
}

function diagnosticText(value: string): string {
  return redactText(value)
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED]')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]+/g, '$1?[REDACTED]')
    .slice(0, 16_384)
}
