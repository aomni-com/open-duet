import fs from 'node:fs'
import path from 'node:path'

import { ReleaseRevisionSchema } from '@repo/contract'

export function resolveReleaseRevision(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const revision = ReleaseRevisionSchema.safeParse(env.VERCEL_GIT_COMMIT_SHA?.trim())
  return revision.success ? revision.data : null
}

/**
 * The identity of the running deployment, as the browser sees it.
 *
 * The browser cannot tell "the code I loaded" from "the code being served now",
 * so it needs a value that changes on every promotion and on nothing else.
 * Vercel's deployment id is that value; the commit sha stands in when a build
 * is not deployment-addressed, and Next's build id covers self-hosted output.
 * A dev server has no build to identify, so it reports a per-process sentinel —
 * distinct enough that two dev servers never look like the same deployment.
 */
export function resolveDeployedVersion({
  env,
  readBuildId,
}: {
  env: Readonly<Record<string, string | undefined>>
  readBuildId: () => string
}): string {
  const fromPlatform = [env.VERCEL_DEPLOYMENT_ID, env.VERCEL_GIT_COMMIT_SHA]
    .map(value => value?.trim())
    .find(value => value !== undefined && value.length > 0)
  if (fromPlatform !== undefined) return fromPlatform

  try {
    const buildId = readBuildId().trim()
    if (buildId.length > 0) return buildId
  } catch {
    // An unbuilt tree has no build id; fall through to the dev sentinel.
  }
  return `dev-${process.pid}`
}

export function readNextBuildId(): string {
  return fs.readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8')
}
