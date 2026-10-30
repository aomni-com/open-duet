import type { PriceRule } from '../../src/index'

export const firecrawlCredits: PriceRule = { kind: 'responseJson', path: 'creditsUsed' }
// The v2 response no longer includes creditsUsed for every endpoint; the
// documented unit rates at https://docs.firecrawl.dev/features/browser and the
// vendor's current pricing pages are the fallback checked against the ledger.
export const firecrawlScrapeCredits: PriceRule = {
  kind: 'first',
  rules: [firecrawlCredits, { kind: 'flat', units: 1 }],
}
export const firecrawlSearchCredits: PriceRule = {
  kind: 'first',
  rules: [firecrawlCredits, { kind: 'flat', units: 2 }],
}
export const firecrawlMapCredits: PriceRule = {
  kind: 'first',
  rules: [firecrawlCredits, { kind: 'flat', units: 1 }],
}
export const firecrawlAsyncCost: PriceRule = {
  kind: 'first',
  rules: [firecrawlCredits, { kind: 'flat', units: 1 }],
}
export const firecrawlAsyncCredits = (idParam: string): PriceRule => ({
  kind: 'asyncTerminal',
  statusPath: 'status',
  terminal: ['completed', 'failed', 'cancelled'],
  idParam,
  cost: firecrawlAsyncCost,
})
// Firecrawl bills browser sessions by browser minute (source:
// https://docs.firecrawl.dev/features/browser, checked 2026-10-12). Playwright/code sessions
// cost 2 credits per minute; prompt-driven sessions cost 7, with a one-minute
// minimum. The request body is inspected only for the prompt/code distinction.
export const firecrawlBrowserExecution: PriceRule = {
  kind: 'custom',
  needs: { requestJson: true, responseJson: false },
  price: context => {
    const request = context.requestJson as Record<string, unknown> | undefined
    const rate = typeof request?.prompt === 'string' && request.prompt.length > 0 ? 7 : 2
    return { units: rate * Math.max(1, context.elapsedMs / 60_000) }
  },
}

