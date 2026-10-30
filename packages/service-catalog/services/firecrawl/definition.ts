import type { ServiceDefinition } from '../../src/index'
import { free, route } from '../../src/vendor-helpers'
import {
  firecrawlAsyncCredits,
  firecrawlBrowserExecution,
  firecrawlMapCredits,
  firecrawlScrapeCredits,
  firecrawlSearchCredits,
} from './pricing'

export const firecrawl: ServiceDefinition = {
  id: 'firecrawl',
  name: 'Firecrawl',
  summary: 'Web scraping, search, mapping, crawling, and browser automation.',
  category: 'scraping',
  docsUrl: 'https://docs.firecrawl.dev',
  llmsTxtUrl: 'https://docs.firecrawl.dev/llms.txt',
  notes: 'Crawl and extract jobs are asynchronous; poll the returned id.',
  baseUrl: 'https://api.firecrawl.dev',
  auth: { kind: 'bearer' },
  unit: { name: 'credit', microUsdPerUnit: 5000 },
  routes: [
    route('scrape', 'POST', '/v2/scrape', 'generate', firecrawlScrapeCredits, {
      probe: { json: { url: 'https://example.com', formats: ['markdown'] } },
    }),
    route('search', 'POST', '/v2/search', 'generate', firecrawlSearchCredits, {
      probe: { json: { query: 'example', limit: 1 } },
    }),
    route('map', 'POST', '/v2/map', 'generate', firecrawlMapCredits, {
      probe: { json: { url: 'https://example.com' } },
    }),
    route('crawl-start', 'POST', '/v2/crawl', 'generate', free),
    route('crawl-poll', 'GET', '/v2/crawl/:crawlId', 'ownedById', firecrawlAsyncCredits('crawlId')),
    route('extract-start', 'POST', '/v2/extract', 'generate', free),
    route(
      'extract-poll',
      'GET',
      '/v2/extract/:extractId',
      'ownedById',
      firecrawlAsyncCredits('extractId'),
    ),
    route('browser-start', 'POST', '/v2/browser', 'generate', free),
    route(
      'browser-execute',
      'POST',
      '/v2/browser/:sessionId/execute',
      'ownedById',
      firecrawlBrowserExecution,
    ),
    route('browser-close', 'DELETE', '/v2/browser/:sessionId', 'ownedById', { kind: 'free' }),
  ],
}
