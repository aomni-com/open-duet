import { DEPLOYED_PRODUCT_ROUTES } from '@/src/routing/deployed-product-routes'

export const dynamic = 'force-static'

export function GET(): Response {
  return Response.json(
    { schemaVersion: 1, routes: DEPLOYED_PRODUCT_ROUTES },
    { headers: { 'cache-control': 'public, max-age=300, s-maxage=300' } },
  )
}
