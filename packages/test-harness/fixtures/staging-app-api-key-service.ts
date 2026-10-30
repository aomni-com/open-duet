type FixtureEnvironment = Record<string, string | undefined>
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type FixtureDiagnostics = {
  appApiKeyPresent: boolean
  apiUrlPresent: boolean
  provisioningTokenAbsent: boolean
  allowedCallSucceeded: boolean
  undeclaredCallRejected: boolean
  workspaceAuthorityLocal: boolean
}

export async function collectAppApiKeyDiagnostics(
  env: FixtureEnvironment,
  expectedWorkspaceSlug?: string,
  fetchImpl: Fetch = fetch,
): Promise<FixtureDiagnostics> {
  const appApiKeyPresent =
    typeof env.DUET_APP_API_KEY === 'string' && env.DUET_APP_API_KEY.length > 0
  const apiUrlPresent = typeof env.DUET_API_URL === 'string' && env.DUET_API_URL.length > 0
  const provisioningTokenAbsent = env.DUET_PROVISIONING_TOKEN === undefined
  let allowedCallSucceeded = false
  let undeclaredCallRejected = false
  let workspaceAuthorityLocal = false

  if (appApiKeyPresent && apiUrlPresent) {
    try {
      const headers = { authorization: `Bearer ${env.DUET_APP_API_KEY}` }
      const baseUrl = env.DUET_API_URL!.replace(/\/+$/, '')
      const allowed = await fetchImpl(`${baseUrl}/v1/whoami`, { headers })
      allowedCallSucceeded = allowed.status === 200
      const body = (await allowed.json()) as { workspaces?: Array<{ slug?: unknown }> }
      const workspaceSlug = body.workspaces?.[0]?.slug
      workspaceAuthorityLocal =
        allowedCallSucceeded &&
        body.workspaces?.length === 1 &&
        typeof workspaceSlug === 'string' &&
        workspaceSlug === expectedWorkspaceSlug
      if (allowedCallSucceeded && typeof workspaceSlug === 'string') {
        const denied = await fetchImpl(
          `${baseUrl}/v1/ws/${encodeURIComponent(workspaceSlug)}/apps`,
          { headers },
        )
        const deniedBody = (await denied.json()) as { error?: unknown }
        undeclaredCallRejected = denied.status === 403 && deniedBody.error === 'insufficient_scope'
      }
    } catch {
      allowedCallSucceeded = false
      undeclaredCallRejected = false
    }
  }

  return {
    appApiKeyPresent,
    apiUrlPresent,
    provisioningTokenAbsent,
    allowedCallSucceeded,
    undeclaredCallRejected,
    workspaceAuthorityLocal,
  }
}

export async function observeAppKeyRevocation(
  env: FixtureEnvironment,
  options: {
    fetchImpl?: Fetch
    sleep?: (milliseconds: number) => Promise<unknown>
    attempts?: number
    recordRevoked?: () => Promise<unknown>
  } = {},
): Promise<boolean> {
  if (!env.DUET_APP_API_KEY || !env.DUET_API_URL) return false
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? Bun.sleep
  const url = `${env.DUET_API_URL.replace(/\/+$/, '')}/v1/whoami`
  const headers = { authorization: `Bearer ${env.DUET_APP_API_KEY}` }
  let authenticatedBeforeDisable = false

  for (let attempt = 0; attempt < (options.attempts ?? 400); attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers })
      if (response.status === 200) authenticatedBeforeDisable = true
      if (response.status === 401) {
        if (!authenticatedBeforeDisable) return false
        await options.recordRevoked?.()
        return true
      }
    } catch {
      // A transient request failure is not evidence of revocation.
    }
    await sleep(25)
  }
  return false
}

if (import.meta.main) {
  const marker = Bun.argv[2] ?? 'staging-app-api-key'
  let revocationObserverReady = false
  Bun.serve({
    port: Number(process.env.PORT),
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === '/diagnostics') {
        return Response.json(
          await collectAppApiKeyDiagnostics(
            process.env,
            request.headers.get('x-expected-workspace') ?? undefined,
          ),
        )
      }
      if (pathname === '/diagnostics/revocation') {
        if (!revocationObserverReady) {
          revocationObserverReady = true
          void observeAppKeyRevocation(process.env, {
            recordRevoked: async () => {
              await Bun.write(
                '.app-api-key-revoked.json',
                `${JSON.stringify({ priorKeyRejected: true })}\n`,
              )
            },
          }).catch(() => undefined)
        }
        return Response.json({ revocationObserverReady })
      }
      return new Response(`<!doctype html><title>${marker}</title><main>${marker}</main>`, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    },
  })
}
