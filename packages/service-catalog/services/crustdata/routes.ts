import type { Route } from '../../src/index'
import { flat, proxyRoutes, route } from '../../src/vendor-helpers'

export const crustdataAdditionalRoutes = [
  ...proxyRoutes('crustdata', [
    ['company-identify', 'POST', '/company/identify'],
    ['company-search', 'POST', '/company/search'],
    ['company-search-autocomplete', 'POST', '/company/search/autocomplete'],
    ['company-live-search', 'POST', '/company/professional_network/search/live'],
    ['person-search', 'POST', '/person/search'],
    ['person-search-autocomplete', 'POST', '/person/search/autocomplete'],
    ['person-live-enrich', 'POST', '/person/professional_network/enrich/live'],
    ['person-live-search', 'POST', '/person/professional_network/search/live'],
    ['social-post-search', 'POST', '/social_post/search'],
    ['social-post-enrich-live', 'POST', '/social_post/professional_network/enrich/live'],
    ['social-post-search-live', 'POST', '/social_post/professional_network/search/live'],
    ['watcher-simulation', 'POST', '/watcher/simulation/watches'],
    ['batch-company-search', 'POST', '/batch/company/search'],
    ['batch-company-enrich', 'POST', '/batch/company/enrich'],
    ['batch-person-search', 'POST', '/batch/person/search'],
    ['batch-person-enrich', 'POST', '/batch/person/enrich'],
    ['batch-get', 'GET', '/batch/:batchId', 'ownedById'],
  ]),
  route('crustdata-watcher-create', 'POST', '/watcher/watches', 'sharedPool', flat, {
    pool: { pool: 'watcher', role: 'create', idFrom: 'watch_id' },
  }),
  route(
    'crustdata-watcher-update',
    'POST',
    '/watcher/watches/:watchId/update',
    'sharedPool',
    flat,
    { pool: { pool: 'watcher', role: 'mutate', idParam: 'watchId' } },
  ),
] as Route[]

