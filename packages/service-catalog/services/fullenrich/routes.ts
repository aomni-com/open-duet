import { proxyRoutes } from '../../src/vendor-helpers'

export const fullenrichAdditionalRoutes = proxyRoutes('fullenrich', [
  ['reverse-email-start', 'POST', '/api/v2/contact/reverse/email/bulk'],
  ['reverse-email-poll', 'GET', '/api/v2/contact/reverse/email/bulk/:enrichmentId', 'ownedById'],
  ['people-search', 'POST', '/api/v2/people/search'],
  ['company-search', 'POST', '/api/v2/company/search'],
])

