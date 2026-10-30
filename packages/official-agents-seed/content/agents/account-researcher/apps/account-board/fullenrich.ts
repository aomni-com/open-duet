/**
 * The app's entire outward edge: one phone lookup, through Duet's service
 * proxy, which forwards to FullEnrich and injects the upstream key.
 *
 *   POST /v1/services/fullenrich/api/v2/contact/enrich/bulk       → start
 *   GET  /v1/services/fullenrich/api/v2/contact/enrich/bulk/{id}  → poll
 *
 * Only `contact.phones` is ever requested here — emails are the agent's job and
 * are already on the contact by the time they reach this board. The button
 * exists because a phone number costs an order of magnitude more than
 * everything else on a contact card put together, so it is spent one person at
 * a time, on the user's click, and never as a side effect of research.
 *
 * `$DUET_APP_API_KEY` is read from the environment and kept in memory only. It
 * is never written to disk, logged, or sent to the page.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type FullEnrichOptions = {
  fetchImpl?: FetchLike
  env?: Record<string, string | undefined>
  /** Injected so tests and the visual harness do not wait on a real provider. */
  pollIntervalMs?: number
  timeoutMs?: number
}

export type PhoneLookupInput = {
  fullName: string
  companyName?: string
  domain?: string
  profileUrl?: string
}

export type PhoneLookupResult =
  | { found: true; number: string; region?: string }
  | { found: false; reason?: string }

const DEFAULT_POLL_INTERVAL_MS = 3_000
const DEFAULT_TIMEOUT_MS = 120_000

/** Terminal upstream states, in the words the page shows the user. */
const TERMINAL_REASONS: Record<string, string> = {
  CREDITS_INSUFFICIENT: 'The phone lookup service is out of credit.',
  CANCELED: 'The lookup was cancelled before it finished.',
  RATE_LIMIT: 'The lookup service is rate limiting; try again in a few minutes.',
  UNKNOWN: 'The lookup service returned an unknown state.',
}

export function createFullEnrichClient(options: FullEnrichOptions = {}) {
  const env = options.env ?? Bun.env
  // Wrapped at the seam: a bare global fetch assigned onto an object throws
  // "Illegal invocation" in browsers and is a known Bun/browser divergence.
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  const apiUrl = env.DUET_API_URL?.replace(/\/+$/, '')
  const apiKey = env.DUET_APP_API_KEY
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const base = `${apiUrl}/v1/services/fullenrich/api/v2/contact/enrich/bulk`

  const configured = apiUrl !== undefined && apiUrl !== '' && apiKey !== undefined && apiKey !== ''

  async function request(url: string, init?: RequestInit): Promise<Response> {
    return await fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...init?.headers,
      },
    })
  }

  return {
    configured,

    /**
     * A LinkedIn URL identifies a person on its own; without one FullEnrich
     * needs a name AND an employer, so a person with neither cannot be looked
     * up at all. That is a 409 at the route, not a failed lookup here.
     */
    canLookUp(input: PhoneLookupInput): boolean {
      if (typeof input.profileUrl === 'string' && input.profileUrl !== '') return true
      const [first, ...rest] = input.fullName.trim().split(/\s+/)
      const named = first !== undefined && first !== '' && rest.length > 0
      return named && (input.domain !== undefined || input.companyName !== undefined)
    },

    async lookupPhone(input: PhoneLookupInput): Promise<PhoneLookupResult> {
      if (!configured) return { found: false, reason: 'This app cannot reach the Duet API.' }
      const parts = input.fullName.trim().split(/\s+/)
      const contact: Record<string, unknown> = { enrich_fields: ['contact.phones'] }
      if (input.profileUrl !== undefined && input.profileUrl !== '') {
        contact.linkedin_url = input.profileUrl
      } else {
        contact.first_name = parts[0]
        contact.last_name = parts.slice(1).join(' ')
        if (input.domain !== undefined) contact.domain = input.domain
        if (input.companyName !== undefined) contact.company_name = input.companyName
      }

      let enrichmentId: string
      try {
        const started = await request(base, {
          method: 'POST',
          body: JSON.stringify({ name: `Phone lookup: ${input.fullName}`, data: [contact] }),
        })
        if (!started.ok) {
          return { found: false, reason: `The lookup service refused the request (${started.status}).` }
        }
        const body = (await started.json()) as { enrichment_id?: string }
        if (typeof body.enrichment_id !== 'string') {
          return { found: false, reason: 'The lookup service did not start the request.' }
        }
        enrichmentId = body.enrichment_id
      } catch (error) {
        return { found: false, reason: describe(error) }
      }

      const deadline = Date.now() + timeoutMs
      for (;;) {
        await sleep(pollIntervalMs)
        let payload: EnrichmentPayload
        try {
          const polled = await request(`${base}/${encodeURIComponent(enrichmentId)}`)
          if (!polled.ok) {
            return { found: false, reason: `The lookup service returned ${polled.status}.` }
          }
          payload = (await polled.json()) as EnrichmentPayload
        } catch (error) {
          return { found: false, reason: describe(error) }
        }

        const status = typeof payload.status === 'string' ? payload.status : 'UNKNOWN'
        if (status === 'FINISHED') {
          const phone = payload.data?.[0]?.contact_info?.most_probable_phone
          const number = typeof phone?.number === 'string' ? phone.number.trim() : ''
          if (number === '') return { found: false }
          return {
            found: true,
            number,
            ...(typeof phone?.region === 'string' && phone.region !== ''
              ? { region: phone.region }
              : {}),
          }
        }
        const terminal = TERMINAL_REASONS[status]
        if (terminal !== undefined) return { found: false, reason: terminal }
        if (Date.now() >= deadline) {
          return { found: false, reason: 'The lookup did not finish in time.' }
        }
      }
    },
  }
}

export type FullEnrichClient = ReturnType<typeof createFullEnrichClient>

type EnrichmentPayload = {
  status?: string
  data?: Array<{ contact_info?: { most_probable_phone?: { number?: string; region?: string } } }>
}

function describe(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? `The lookup could not be reached: ${error.message}`
    : 'The lookup could not be reached.'
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise(resolve => setTimeout(resolve, ms))
}
