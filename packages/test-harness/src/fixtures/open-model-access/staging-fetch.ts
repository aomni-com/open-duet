// Only the staging outer protection and journey budget differ from normal CLI networking.
import { stagingProtectionHeaders } from '../../staging-live-artifacts'

const original = globalThis.fetch
const origins = new Set(
  [process.env.DUET_API_URL!, process.env.DUET_GATEWAY_BASE_URL!].map(
    value => new URL(value).origin,
  ),
)
const deadline = Number(process.env.DUET_E2E_OPEN_MODEL_DEADLINE)
let generations = 0

globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Open model access acceptance deadline expired')
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    for (const [key, value] of new Headers(init?.headers)) headers.set(key, value)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (url.origin === new URL(process.env.DUET_GATEWAY_BASE_URL!).origin && method === 'POST') {
      if (++generations > 1) throw new Error('CLI acceptance attempted a second paid request')
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(remaining),
      ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : []),
    ])
    return await original(input, {
      ...init,
      signal,
      headers: stagingProtectionHeaders(
        url.toString(),
        origins,
        Object.fromEntries(headers),
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET!,
      ),
    })
  },
  { preconnect: original.preconnect },
)
