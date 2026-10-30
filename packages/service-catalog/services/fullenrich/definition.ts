import type { ServiceDefinition } from '../../src/index'
import { flat, free, route } from '../../src/vendor-helpers'
import { fullenrichAdditionalRoutes } from './routes'

export const fullenrich: ServiceDefinition = {
  id: 'fullenrich',
  name: 'FullEnrich',
  summary: 'B2B person and company enrichment.',
  category: 'enrichment',
  docsUrl: 'https://docs.fullenrich.com',
  notes: 'Contact enrichment uses vendor credits: work email 1, mobile phone 10, personal email 3.',
  baseUrl: 'https://app.fullenrich.com',
  auth: { kind: 'bearer' },
  unit: { name: 'credit', microUsdPerUnit: 50000 },
  routes: [
    route('enrich', 'POST', '/api/v2/contact/enrich/bulk', 'generate', flat, {
      probe: {
        json: {
          name: 'duet-probe',
          data: [
            {
              first_name: 'John',
              last_name: 'Snow',
              company_name: 'Example Inc',
              enrich_fields: ['contact.work_emails'],
            },
          ],
        },
      },
    }),
    route('enrich-poll', 'GET', '/api/v2/contact/enrich/bulk/:enrichmentId', 'ownedById', free),
    ...fullenrichAdditionalRoutes,
  ],
}
