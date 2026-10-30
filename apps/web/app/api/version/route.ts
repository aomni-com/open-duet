import { QUERY_CACHE_SCHEMA_VERSION } from '@/spa/api/query-cache-version'
import {
  readNextBuildId,
  resolveDeployedVersion,
  resolveReleaseRevision,
} from '@/src/server/deployed-version'

export const dynamic = 'force-dynamic'

// Resolved once: the answer cannot change without replacing this process, and
// re-reading BUILD_ID on every poll would put a filesystem hit on a route the
// whole browser fleet calls every few minutes.
const version = resolveDeployedVersion({ env: process.env, readBuildId: readNextBuildId })
const revision = resolveReleaseRevision(process.env)
export function GET(): Response {
  return Response.json(
    { version, revision, cacheSchema: QUERY_CACHE_SCHEMA_VERSION },
    { headers: { 'cache-control': 'no-store' } },
  )
}
