import { expect, test } from 'bun:test'

import { DEPLOYED_PRODUCT_ROUTES } from '@/src/routing/deployed-product-routes'

import { GET } from './route'

test('serializes every deployed SPA route from the router-owned inventory', async () => {
  const response = GET()

  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('public')
  expect(await response.json()).toEqual({ schemaVersion: 1, routes: DEPLOYED_PRODUCT_ROUTES })
})
