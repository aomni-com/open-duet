import { convexUrlsFromDeployment } from '@repo/contract'

export function resolveConvexAuthPublicUrl(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const explicit = environment.NEXT_PUBLIC_CONVEX_URL?.trim()
  if (explicit) return explicit

  const deployment = environment.CONVEX_DEPLOYMENT?.trim()
  return deployment ? convexUrlsFromDeployment(deployment).cloudUrl : undefined
}

/**
 * The same resolution, but for a production build, where absence must be an
 * error. The URL is inlined into client chunks at build time; built without
 * one, every Convex-touching page ships a bundle that throws on load and the
 * reader sees the framework's blank "this page couldn't load" — a broken build
 * that looks like a passing one until someone visits /sign-out. Better to
 * refuse to produce it.
 */
export function requireConvexPublicUrlForBuild(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const url = resolveConvexAuthPublicUrl(environment)
  if (url === undefined) {
    throw new Error(
      'A production build needs a Convex URL to inline into client chunks. ' +
        'Set NEXT_PUBLIC_CONVEX_URL (tests use https://visual-fixture.convex.cloud) ' +
        'or CONVEX_DEPLOYMENT, e.g. via the env files the deploy rails load.',
    )
  }
  return url
}
