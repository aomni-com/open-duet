import { z } from 'zod'

import { serializeScrapedUrlFrontmatter, urlToUploadFilename, type FetchLike } from '@repo/contract'

const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape'
const FIRECRAWL_TIMEOUT_MS = 45_000
const FIRECRAWL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const LOCAL_SCRAPE_TIMEOUT_MS = 50_000

const scrapeResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    markdown: z.string().min(1),
    metadata: z.object({ title: z.string().optional() }).optional(),
  }),
})

export type TrainSourceFetchFailureDetail = 'timeout' | 'malformed_response' | 'non_2xx'

export class TrainSourceFetchError extends Error {
  constructor(
    readonly detail: TrainSourceFetchFailureDetail,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'TrainSourceFetchError'
  }
}

export async function scrapeTrainUrl(
  url: string,
  deps: {
    firecrawlKey: string
    fetch: FetchLike
    now?: () => Date
    localTimeoutMs?: number
    signal?: AbortSignal
  },
): Promise<{ filename: string; markdown: string }> {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new TrainSourceFetchError('malformed_response', 'source URL is malformed')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new TrainSourceFetchError('malformed_response', 'source URL must use HTTP or HTTPS')
  }

  let response: Response
  try {
    // Deliberately mirrors the lander instead of sharing a module: the API and
    // lander deploy independently, so each owns its Firecrawl integration.
    const timeoutSignal = AbortSignal.timeout(deps.localTimeoutMs ?? LOCAL_SCRAPE_TIMEOUT_MS)
    response = await deps.fetch(FIRECRAWL_SCRAPE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.firecrawlKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        maxAge: FIRECRAWL_MAX_AGE_MS,
        timeout: FIRECRAWL_TIMEOUT_MS,
        removeBase64Images: true,
        blockAds: true,
        proxy: 'auto',
      }),
      signal:
        deps.signal === undefined ? timeoutSignal : AbortSignal.any([deps.signal, timeoutSignal]),
    })
  } catch (error) {
    if (deps.signal?.aborted) {
      throw deps.signal.reason ?? new DOMException('Website import cancelled', 'AbortError')
    }
    if (isAbortError(error)) {
      throw new TrainSourceFetchError('timeout', 'Firecrawl request timed out')
    }
    throw new TrainSourceFetchError('malformed_response', 'Firecrawl request failed')
  }

  if (!response.ok) {
    throw new TrainSourceFetchError(
      'non_2xx',
      `Firecrawl returned HTTP ${response.status}`,
      response.status,
    )
  }

  let scrape: z.infer<typeof scrapeResponseSchema>
  try {
    scrape = scrapeResponseSchema.parse(await response.json())
  } catch {
    throw new TrainSourceFetchError('malformed_response', 'Firecrawl returned a malformed response')
  }

  const title = scrape.data.metadata?.title?.trim() || parsedUrl.hostname
  const markdown = serializeScrapedUrlFrontmatter(
    { url, title, scrapedAt: (deps.now ?? (() => new Date()))().toISOString() },
    scrape.data.markdown,
  )
  return { filename: urlToUploadFilename(url), markdown }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}
