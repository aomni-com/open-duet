import type { ServiceDefinition } from '../../src/index'
import { route } from '../../src/vendor-helpers'
import { dataforseoRoutes } from './routes'

export const dataforseo: ServiceDefinition = {
  id: 'dataforseo',
  name: 'DataForSEO',
  summary: 'SEO keyword, SERP, and backlink data.',
  category: 'seo',
  docsUrl: 'https://docs.dataforseo.com',
  notes: 'Vendor response cost is authoritative for billing.',
  baseUrl: 'https://api.dataforseo.com',
  auth: { kind: 'basic' },
  unit: { name: 'usd', microUsdPerUnit: 1000000 },
  routes: [
    route(
      'serp-task-post',
      'POST',
      '/v3/serp/google/organic/task_post',
      'generate',
      { kind: 'responseJson', path: 'cost' },
      { probe: { json: [{ keyword: 'example', language_code: 'en', location_code: 2840 }] } },
    ),
    route('serp-task-get', 'POST', '/v3/serp/google/organic/task_get/:id', 'ownedById', {
      kind: 'responseJson',
      path: 'cost',
    }),
    ...dataforseoRoutes,
  ],
}
