import assert from 'node:assert/strict'

import { type Page, type Response } from '@playwright/test'

const BROWSER_RESPONSE_TIMEOUT_MS = 60_000

export async function waitForBrowserApiResponse(
  page: Page,
  method: string,
  pathname: string,
): Promise<void> {
  await waitForFinishedBrowserResponse(page, method, pathname)
}

export async function waitForFinishedBrowserResponse(
  page: Page,
  method: string,
  pathname: string,
  matchesUrl: (url: URL) => boolean = () => true,
): Promise<Response> {
  const response = await page.waitForResponse(
    candidate => {
      const url = new URL(candidate.url())
      return candidate.request().method() === method && url.pathname === pathname && matchesUrl(url)
    },
    { timeout: BROWSER_RESPONSE_TIMEOUT_MS },
  )
  assert(response.ok(), `${method} ${pathname} returned HTTP ${response.status()}`)
  await assertBrowserResponseFinished(response, `${method} ${pathname}`)
  return response
}

export async function assertBrowserResponseFinished(
  response: Pick<Response, 'finished' | 'status'>,
  label: string,
  timeoutMs = BROWSER_RESPONSE_TIMEOUT_MS,
): Promise<void> {
  // HTTP 204 forbids a response body. The status is the completion evidence;
  // Playwright can leave finished() pending for this bodyless response.
  if (response.status() === 204) return
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label} response body`)),
      timeoutMs,
    )
  })
  try {
    const failure = await Promise.race([response.finished(), timedOut])
    assert.equal(failure, null, `${label} response body was aborted`)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
