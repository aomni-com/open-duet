// A Convex deployment is identified by one value — CONVEX_DEPLOYMENT — the
// deployment name (e.g. "elated-hippopotamus-235"), optionally carrying the
// "<type>:" prefix the Convex CLI writes (e.g. "dev:elated-hippopotamus-235").
// Both the cloud (.convex.cloud) and site (.convex.site) URLs derive from the
// name, so services set only CONVEX_DEPLOYMENT and never a separate CONVEX_URL /
// CONVEX_SITE_URL that could drift from it.
export function convexUrlsFromDeployment(deployment: string): {
  cloudUrl: string
  siteUrl: string
} {
  const name = deployment.trim().split(':').pop()?.trim() ?? ''
  if (!name) {
    throw new Error('CONVEX_DEPLOYMENT is required to derive Convex URLs')
  }
  return {
    cloudUrl: `https://${name}.convex.cloud`,
    siteUrl: `https://${name}.convex.site`,
  }
}
