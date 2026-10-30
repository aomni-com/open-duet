import type { ServiceDefinition } from '../../src/index'
import { flat, route } from '../../src/vendor-helpers'
import { crustdataAdditionalRoutes } from './routes'

export const crustdata: ServiceDefinition = {
  id: 'crustdata',
  name: 'Crustdata',
  summary: 'Company, people, and enrichment data lookups.',
  category: 'enrichment',
  docsUrl: 'https://docs.crustdata.com',
  notes: 'Routes are stateless lookups billed by the vendor account.',
  baseUrl: 'https://api.crustdata.com',
  auth: { kind: 'bearer' },
  unit: { name: 'call', microUsdPerUnit: 50000 },
  routes: [
    route('company-enrich', 'POST', '/company/enrich', 'generate', flat, {
      probe: { headers: { 'x-api-version': '2025-11-01' }, json: { domains: ['example.com'] } },
    }),
    route('person-enrich', 'POST', '/person/enrich', 'generate', flat, {
      probe: {
        headers: { 'x-api-version': '2025-11-01' },
        json: { professional_network_profile_urls: ['https://www.linkedin.com/in/example'] },
      },
    }),
    ...crustdataAdditionalRoutes,
  ],
  pools: [
    {
      id: 'watcher',
      ttlMs: 24 * 60 * 60 * 1000,
      expire: {
        method: 'POST',
        path: '/watcher/watches/:watchId/update',
        body: { status: 'deleted' },
      },
    },
  ],
}
