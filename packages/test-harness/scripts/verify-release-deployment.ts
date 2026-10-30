import { ConvexHttpClient } from 'convex/browser'

import { convexUrlsFromDeployment } from '@repo/contract'

import { productionConvexDeployment, productionReleaseOrigin } from '../src/release-target.ts'
import { verifyReleaseDeploymentTarget } from '../src/staging-live-deployment.ts'
import { fnQuery } from '../src/staging-live-env.ts'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function readJson(url: string, init: RequestInit = {}, label = url): Promise<unknown> {
  const response = await releaseFetch(url, init, label)
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
  return await response.json()
}

async function readText(url: string, init: RequestInit = {}, label = url): Promise<string> {
  const response = await releaseFetch(url, init, label)
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
  return await response.text()
}

async function releaseFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
  } catch {
    throw new Error(`${label} failed`)
  }
}

const deployment = productionConvexDeployment(required('CONVEX_DEPLOYMENT'))
const internalKey = required('DUET_API_INTERNAL_KEY')
const workspaceSlug = required('DUET_RELEASE_PROBE_WORKSPACE_SLUG')
const convex = new ConvexHttpClient(convexUrlsFromDeployment(deployment).cloudUrl)
const evidence = await verifyReleaseDeploymentTarget(
  {
    apiUrl: productionReleaseOrigin('DUET_API_URL', required('DUET_API_URL')),
    appUrl: productionReleaseOrigin('DUET_APP_URL', required('DUET_APP_URL')),
    docsUrl: productionReleaseOrigin('DUET_DOCS_URL', required('DUET_DOCS_URL')),
  },
  {
    resolveGateway: async () =>
      (await convex.query(fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'), {
        internalKey,
        slug: workspaceSlug,
      })) as
        | { vmToken: string; httpsUrl: string; runtimeVersion?: string }
        | { refusal: string }
        | null,
    readJson,
    readText,
  },
)

console.log(JSON.stringify(evidence))
