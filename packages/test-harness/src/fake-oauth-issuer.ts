import {
  createFakeOAuthIssuer,
  type FakeOAuthIssuer,
  type FakeOAuthIssuerOptions,
} from '@repo/fake-oauth-issuer'

export * from '@repo/fake-oauth-issuer'

export function serveFakeOAuthIssuer(
  options: FakeOAuthIssuerOptions = {},
  port?: number,
): { issuer: FakeOAuthIssuer; url: string; stop(): void } {
  assertFakeIssuerEnvironment(process.env)
  const issuer = createFakeOAuthIssuer(options)
  const server = startServer(issuer, port)
  return {
    issuer,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

export function assertFakeIssuerEnvironment(env: NodeJS.ProcessEnv): void {
  const productionHosts = new Set(['ctl.duet.so', 'app.duet.so', 'api.duet.so'])
  if (
    [env.DUET_API_URL, env.DUET_APP_URL].some(value => {
      if (!value) return false
      try {
        return productionHosts.has(new URL(value).hostname)
      } catch {
        return false
      }
    })
  ) {
    throw new Error('Fake OAuth issuer must never run against production')
  }
  const stagingTarget = [env.DUET_API_URL, env.DUET_APP_URL].some(value =>
    value?.includes('staging'),
  )
  if (env.NODE_ENV !== 'test' && !stagingTarget) {
    throw new Error('Fake OAuth issuer is restricted to test and staging environments')
  }
}

function startServer(
  issuer: FakeOAuthIssuer,
  port: number | undefined,
): ReturnType<typeof Bun.serve> {
  if (port !== undefined) {
    return Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: request => issuer.fetch(request),
    })
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return Bun.serve({
        hostname: '127.0.0.1',
        port: 20_000 + Math.floor(Math.random() * 30_000),
        fetch: request => issuer.fetch(request),
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to start fake OAuth issuer')
}
