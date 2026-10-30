import { ReleaseRevisionSchema } from '@repo/contract'

export const dynamic = 'force-static'

export function docsReleaseRevision(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const parsed = ReleaseRevisionSchema.safeParse(env.VERCEL_GIT_COMMIT_SHA)
  return parsed.success ? parsed.data : null
}

export function GET(): Response {
  return Response.json({ revision: docsReleaseRevision(process.env) })
}
