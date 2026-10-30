import { ConvexHttpClient } from 'convex/browser'

import {
  DUET_STAGING_EDGE_HOST,
  EDGE_SECRET_HEADER,
  EdgeResolveResponseSchema,
} from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { fnQuery, type LegResult, type LiveEnv } from './staging-live-env.ts'
import { errorMessage, stagingFetch, timedFetch } from './staging-live-http.ts'
// Publish is a read-only viewer (spec publish-viewer): the bare URL serves
// the anonymous viewer page and never the published bytes; the bytes are only
// reachable through the reserved `?raw` selector, text-like forced to
// text/plain. Both halves are asserted here.
export async function verifyStagingPublish(
  workspaceSlug: string,
  publishSlug: string,
  expected: string,
): Promise<LegResult> {
  const deadline = Date.now() + 90_000
  let lastStatus = 0
  let lastBody = ''
  const baseUrl = `https://${DUET_STAGING_EDGE_HOST}/${workspaceSlug}/${publishSlug}/`
  for (;;) {
    try {
      const response = await stagingFetch(`${baseUrl}?raw`)
      lastStatus = response.status
      lastBody = await response.text()
      if (response.ok && lastBody.includes(expected)) {
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.startsWith('text/plain')) {
          throw new Error(`Published content mismatch: ?raw content-type ${contentType}`)
        }
        const viewer = await stagingFetch(baseUrl)
        const viewerBody = await viewer.text()
        if (!viewer.ok) {
          throw new Error(`Published content mismatch: viewer HTTP ${viewer.status}`)
        }
        if (viewerBody.includes(expected) || !viewerBody.includes('<html')) {
          throw new Error('Published content mismatch: bare URL must serve viewer HTML, not bytes')
        }
        return { status: 'pass' }
      }
      if ([404, 502].includes(response.status) && /resolve|not_found|origin/i.test(lastBody)) {
        if (Date.now() >= deadline) {
          return {
            status: 'skipped',
            reason: `staging edge could not serve publish route: HTTP ${lastStatus} resolve unavailable`,
          }
        }
      } else if (Date.now() >= deadline) {
        throw new Error(`Published content mismatch: HTTP ${lastStatus}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Published content mismatch:')) {
        throw error
      }
      if (Date.now() >= deadline) {
        return { status: 'skipped', reason: `staging edge unavailable: ${errorMessage(error)}` }
      }
    }
    await Bun.sleep(2_000)
  }
}

export async function verifyPublishControlPlane(args: {
  env: LiveEnv
  convex: ConvexHttpClient
  workspaceSlug: string
  publishSlug: string
  artifacts: StagingArtifactCollector
}): Promise<LegResult> {
  const { env, convex, workspaceSlug, publishSlug, artifacts } = args
  const direct = (await convex.query(fnQuery('domains/publishes/model:resolveForEdge'), {
    internalKey: env.internalKey,
    workspaceSlug,
    publishSlug,
  })) as Record<string, unknown> | null
  const response = await timedFetch(
    `${env.convexSiteUrl}/v1/edge/resolve`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [EDGE_SECRET_HEADER]: env.edgeInternalKey,
      },
      body: JSON.stringify({
        kind: 'publish',
        host: DUET_STAGING_EDGE_HOST,
        workspaceSlug,
        publishSlug,
      }),
    },
    artifacts,
  )
  const parsedResponse =
    response.status === 200
      ? EdgeResolveResponseSchema.safeParse(await response.json().catch(() => null))
      : null
  if (direct !== null && parsedResponse?.success === true) return { status: 'pass' }
  return {
    status: 'fail',
    reason: `staging Convex publish resolve disagreed: query=${direct === null ? 'null' : 'resolved'} HTTP ${response.status} shape=${parsedResponse === null ? 'not-checked' : parsedResponse.success ? 'resolved' : 'invalid'}`,
  }
}
