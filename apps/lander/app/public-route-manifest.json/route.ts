import { DEPLOYED_PUBLIC_ROUTE_MANIFEST } from '@/src/public-route-manifest'

export const dynamic = 'force-static'

export function GET(): Response {
  return Response.json(
    {
      schemaVersion: 2,
      routes: DEPLOYED_PUBLIC_ROUTE_MANIFEST,
    },
    {
      headers: {
        'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
      },
    },
  )
}
