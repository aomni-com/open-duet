import { expect, test } from 'bun:test'

import { parseScrapedUrlFrontmatter, urlToUploadFilename } from '@repo/contract'

import { scrapeTrainUrl, TrainSourceFetchError } from './scraper'

test('scrapes a URL into deterministic, safely frontmattered markdown', async () => {
  const url = 'https://example.com/docs/getting-started?edition=pro'
  const title = 'A "hostile" title\nwith a second line'
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined

  const result = await scrapeTrainUrl(url, {
    firecrawlKey: 'firecrawl-key',
    now: () => new Date('2026-07-15T03:04:05.000Z'),
    fetch: async (input, init) => {
      request = { input, init }
      return Response.json({
        success: true,
        data: {
          markdown: '# Exact body\n\nUnmodified.',
          metadata: { title, futureMetadata: true },
          futureData: true,
        },
        futureResponse: true,
      })
    },
  })

  expect(result.filename).toBe(urlToUploadFilename(url))
  expect(parseScrapedUrlFrontmatter(result.markdown)).toEqual({
    url,
    title,
    scrapedAt: '2026-07-15T03:04:05.000Z',
  })
  expect(result.markdown.endsWith('# Exact body\n\nUnmodified.')).toBe(true)
  expect(String(request?.input)).toBe('https://api.firecrawl.dev/v2/scrape')
  expect(new Headers(request?.init?.headers).get('authorization')).toBe('Bearer firecrawl-key')
  expect(JSON.parse(String(request?.init?.body))).toMatchObject({
    url,
    formats: ['markdown'],
    onlyMainContent: true,
    removeBase64Images: true,
    blockAds: true,
    proxy: 'auto',
  })
  expect(request?.init?.signal).toBeInstanceOf(AbortSignal)
})

test('classifies a non-2xx Firecrawl response with its status', async () => {
  const failure = scrapeTrainUrl('https://example.com/missing', {
    firecrawlKey: 'firecrawl-key',
    fetch: async () => new Response('nope', { status: 429 }),
  })

  await expect(failure).rejects.toEqual(
    new TrainSourceFetchError('non_2xx', 'Firecrawl returned HTTP 429', 429),
  )
})

test('classifies an upstream timeout', async () => {
  const failure = scrapeTrainUrl('https://example.com/slow', {
    firecrawlKey: 'firecrawl-key',
    fetch: async () => {
      throw new DOMException('timed out', 'TimeoutError')
    },
  })

  await expect(failure).rejects.toEqual(
    new TrainSourceFetchError('timeout', 'Firecrawl request timed out'),
  )
})

test('aborts a hung Firecrawl socket at the local deadline', async () => {
  let observedAbort = false
  const failure = scrapeTrainUrl('https://example.com/hung', {
    firecrawlKey: 'firecrawl-key',
    localTimeoutMs: 5,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          observedAbort = true
          reject(init.signal?.reason)
        })
      }),
  })

  await expect(failure).rejects.toEqual(
    new TrainSourceFetchError('timeout', 'Firecrawl request timed out'),
  )
  expect(observedAbort).toBe(true)
})

test('preserves caller cancellation instead of misclassifying it as a Firecrawl timeout', async () => {
  const controller = new AbortController()
  const failure = scrapeTrainUrl('https://example.com/dismissed', {
    firecrawlKey: 'firecrawl-key',
    signal: controller.signal,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      }),
  })

  controller.abort(new DOMException('Website import dismissed', 'AbortError'))

  await expect(failure).rejects.toMatchObject({
    name: 'AbortError',
    message: 'Website import dismissed',
  })
})

test('classifies malformed Firecrawl JSON', async () => {
  const failure = scrapeTrainUrl('https://example.com/broken', {
    firecrawlKey: 'firecrawl-key',
    fetch: async () => Response.json({ success: true, data: { markdown: '' } }),
  })

  await expect(failure).rejects.toEqual(
    new TrainSourceFetchError('malformed_response', 'Firecrawl returned a malformed response'),
  )
})
