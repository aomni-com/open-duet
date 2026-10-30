import assert from 'node:assert/strict'

import {
  ApiDeploymentSchema,
  BACKEND_SCHEMA_VERSION,
  DocsDeploymentSchema,
  WEB_CACHE_SCHEMA_VERSION,
  WebDeploymentSchema,
  type ApiDeployment,
  type DocsDeployment,
  type WebDeployment,
} from '@repo/contract'

import { fnQuery, type Workspace } from './staging-live-env'
import { apiJson, apiText, bearer } from './staging-live-http'
import { parseRuntimeReleaseManifest } from './staging-live-runtime'
import type { WorkspaceBrowserJourneyContext } from './staging-live-workspace-browser'

export type ReleaseDeployment = {
  api: ApiDeployment
  web: WebDeployment
  docs: DocsDeployment
  runtimeManifest: unknown
  runtimeHealth: { runtimeVersion: string }
  workspace: Pick<Workspace, 'runtimeVersion'>
}

export type ReleaseDeploymentEvidence = {
  backendSchema: number
  cacheSchema: number
  runtimeVersion: string
}

type ReleaseGatewayConnection = {
  vmToken: string
  httpsUrl: string
  runtimeVersion?: string
}

export type ReleaseDeploymentTarget = {
  apiUrl: string
  appUrl: string
  docsUrl: string
}

export type ReleaseDeploymentDependencies = {
  resolveGateway: () => Promise<ReleaseGatewayConnection | { refusal: string } | null>
  readJson: (url: string, init?: RequestInit, label?: string) => Promise<unknown>
  readText: (url: string, init?: RequestInit, label?: string) => Promise<string>
}

export async function verifyReleaseDeployment(
  context: WorkspaceBrowserJourneyContext,
): Promise<ReleaseDeploymentEvidence> {
  return await verifyReleaseDeploymentTarget(
    {
      apiUrl: context.env.apiUrl,
      appUrl: context.env.appUrl,
      docsUrl: context.env.docsUrl,
    },
    {
      resolveGateway: async () =>
        (await context.convex.query(
          fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
          { internalKey: context.env.internalKey, slug: context.workspace.slug },
        )) as ReleaseGatewayConnection | { refusal: string } | null,
      readJson: async (url, init, label) =>
        await apiJson(url, init ?? {}, 200, label ?? 'release deployment', context.artifacts),
      readText: async (url, init, label) =>
        await apiText(url, init ?? {}, 200, label ?? 'release docs', context.artifacts),
    },
  )
}

export async function verifyReleaseDeploymentTarget(
  target: ReleaseDeploymentTarget,
  dependencies: ReleaseDeploymentDependencies,
): Promise<ReleaseDeploymentEvidence> {
  const connection = await dependencies.resolveGateway()
  assert(connection !== null && !('refusal' in connection), 'workspace gateway was unavailable')

  const [api, web, docs, runtimeManifest, runtimeHealth, docsSessions, docsEvents] =
    await Promise.all([
      dependencies.readJson(`${target.apiUrl}/deployment`, {}, 'API deployment identity'),
      dependencies.readJson(`${target.appUrl}/api/version`, {}, 'web deployment identity'),
      dependencies.readJson(`${target.docsUrl}/deployment.json`, {}, 'docs deployment identity'),
      dependencies.readJson(
        `${target.apiUrl}/v1/vm/runtime-release/manifest`,
        { headers: bearer(connection.vmToken) },
        'runtime release manifest',
      ),
      dependencies.readJson(
        `${connection.httpsUrl.replace(/\/+$/, '')}/health`,
        { headers: bearer(connection.vmToken) },
        'runtime health identity',
      ),
      dependencies.readText(`${target.docsUrl}/sessions/`, {}, 'sessions docs contract'),
      dependencies.readText(`${target.docsUrl}/events/`, {}, 'events docs contract'),
    ])

  assertSpecificPeopleDocsContract({ sessions: docsSessions, events: docsEvents })

  return assertReleaseDeployment({
    api: api as ApiDeployment,
    web: web as WebDeployment,
    docs: docs as DocsDeployment,
    runtimeManifest,
    runtimeHealth: runtimeHealth as { runtimeVersion: string },
    workspace: connection,
  })
}

export function assertSpecificPeopleDocsContract(rendered: {
  sessions: string
  events: string
}): void {
  for (const required of [
    'one list',
    'items',
    'nextCursor',
    'Specific people',
    'memberUserIds',
    'personalArchive',
    'globalArchive',
    'id="sessions.audience"',
    'id="sessions.audience.update"',
  ]) {
    assert(rendered.sessions.includes(required), `sessions docs omitted ${required}`)
  }
  for (const required of ['afterSeq', 'Last-Event-ID']) {
    assert(rendered.events.includes(required), `events docs omitted ${required}`)
  }
  for (const [page, removed] of [
    [rendered.sessions, '/agent/jobs'],
    [rendered.events, '?since='],
  ] as const) {
    assert(
      !page.includes(removed),
      `deployed docs retained removed jobs route or old shape: ${removed}`,
    )
  }
}

export function assertReleaseDeployment(input: ReleaseDeployment): ReleaseDeploymentEvidence {
  const api = ApiDeploymentSchema.parse(input.api)
  const web = WebDeploymentSchema.parse(input.web)
  DocsDeploymentSchema.parse(input.docs)

  assert.equal(api.backend.schema, BACKEND_SCHEMA_VERSION, 'backend schema version was stale')
  assert.equal(web.cacheSchema, WEB_CACHE_SCHEMA_VERSION, 'web cache schema version was stale')

  const runtimeVersion = api.runtime.version
  const manifest = parseRuntimeReleaseManifest(input.runtimeManifest)
  assert(runtimeVersion !== null, 'API deployment omitted its runtime version')
  assert.equal(
    manifest.version,
    runtimeVersion,
    'runtime manifest did not match the API deployment',
  )
  assert.equal(
    input.runtimeHealth.runtimeVersion,
    runtimeVersion,
    'runtime health did not match the API deployment',
  )
  assert.equal(
    input.workspace.runtimeVersion,
    runtimeVersion,
    'workspace runtime did not match the API deployment',
  )

  return {
    backendSchema: api.backend.schema,
    cacheSchema: web.cacheSchema,
    runtimeVersion,
  }
}
