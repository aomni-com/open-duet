import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import type { ConvexHttpClient } from 'convex/browser'

import {
  APPROVED_MODELS,
  AppResponseSchema,
  AppCredentialListResponseSchema,
  ExportAppCredentialResponseSchema,
  DUET_APP_ACCESS_QUERY,
  MAX_VM_IDLE_SYNC_INTERVAL_MS,
  MAX_EXPORTED_APP_CREDENTIALS,
} from '@repo/contract'

import { buildSkillsBundle, renderDefaultSkills } from '../../skills-registry/src/index'
import type { StagingArtifactCollector } from './staging-live-artifacts'
import { fnQuery } from './staging-live-env'
import { waitForForwardProgress } from './staging-live-forward-progress'
import { bearer, bearerJson, stagingFetch } from './staging-live-http'
import type { StagingResourceLedger } from './staging-live-resource-ledger'
import {
  runWorkspaceBrowserJourney,
  readWorkspaceBrowserEnv,
} from './staging-live-workspace-browser'

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export async function runAppKeyExportJourney(
  options: { onProgress?: (stage: string) => void } = {},
) {
  const env = readWorkspaceBrowserEnv()
  const transport = await fetch(`${env.apiUrl}/v1/whoami`, { signal: AbortSignal.timeout(30_000) })
  await transport.body?.cancel()
  assert.equal(
    transport.status,
    401,
    'direct VM CLI transport must reach API authentication; check staging deployment protection',
  )
  return await runWorkspaceBrowserJourney({
    journey: 'app-key-export',
    label: 'App credential export',
    onProgress: options.onProgress,
    run: async context => {
      const cliPackage = await Bun.file(new URL('../../duet/package.json', import.meta.url)).json()
      const gateway = (await context.convex.query(
        fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
        {
          internalKey: context.env.internalKey,
          slug: context.workspace.slug,
        },
      )) as { vmToken: string } | { refusal: string } | null
      assert(
        gateway !== null && 'vmToken' in gateway,
        'workspace lacks its authenticated skills rail',
      )
      context.artifacts.registerSecret(gateway.vmToken)
      const expected = buildSkillsBundle(
        renderDefaultSkills({ appUrl: context.env.appUrl, catalog: APPROVED_MODELS }),
      )
      const response = await stagingFetch(`${context.env.apiUrl}/v1/vm/skills/${expected.hash}`, {
        headers: bearer(gateway.vmToken),
        signal: AbortSignal.timeout(30_000),
      })
      assert.equal(response.status, 200, 'served skills bundle differs from the checkout release')
      const bytes = await response.text()
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        expected.hash,
        'served skills bundle identity is wrong',
      )
      const skill = expected.bundle.files.find(file => file.path === 'build-apps/SKILL.md')
      assert(skill !== undefined, 'served bundle omitted build-apps')
      const evidence = await runAppKeyExportAcceptance({
        ...context,
        expectedCliVersion: cliPackage.version,
        expectedSkillHash: createHash('sha256').update(skill.content).digest('hex'),
      })
      return { ...evidence, skillsBundleHash: expected.hash }
    },
  })
}

export async function runAppKeyExportAcceptance(args: {
  env: { apiUrl: string; internalKey: string }
  workspace: { _id: string; slug: string }
  apiToken: string
  runId: string
  ledger: StagingResourceLedger
  artifacts: StagingArtifactCollector
  convex: ConvexHttpClient
  progress: (stage: string) => void
  expectedCliVersion: string
  expectedSkillHash: string
  fetchImpl?: Fetch
}) {
  const fetchImpl = args.fetchImpl ?? stagingFetch
  const base = `${args.env.apiUrl}/v1/ws/${encodeURIComponent(args.workspace.slug)}`
  const slug = 'app-key-export'
  const appPath = `apps/${slug}`
  const appUrl = `${base}/apps/${slug}`
  const request = (url: string, init: RequestInit = {}) =>
    fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(30_000),
    })
  const json = async (url: string, init: RequestInit, status: number) => {
    const response = await request(url, init)
    assert.equal(
      response.status,
      status,
      `app-key-export expected HTTP ${status}, got ${response.status}`,
    )
    return await response.json()
  }
  args.progress('app-key-export:register')
  await json(
    `${base}/files/actions`,
    {
      method: 'POST',
      headers: bearerJson(args.apiToken),
      body: JSON.stringify({ operation: 'mkdir', path: appPath, recursive: true }),
    },
    200,
  )
  const source = await Bun.file(
    new URL('../fixtures/staging-app-key-export-service.ts', import.meta.url),
  ).text()
  const write = await request(`${base}/files/${appPath}/service.ts`, {
    method: 'PUT',
    headers: bearer(args.apiToken, { 'content-type': 'text/plain' }),
    body: source,
  })
  assert.equal(write.status, 200, 'app-key-export fixture write failed')
  const capturedApp = async (id: string) => {
    const rows = (await args.convex.query(fnQuery('domains/apps/model:listByWorkspace'), {
      internalKey: args.env.internalKey,
      workspaceId: args.workspace._id,
      id,
    })) as Array<{ slug: string }>
    return rows[0]
  }
  const register = async () => {
    const registered = AppResponseSchema.parse(
      await json(
        `${base}/apps`,
        {
          method: 'POST',
          headers: bearerJson(args.apiToken),
          body: JSON.stringify({
            path: appPath,
            slug,
            command: 'bun service.ts',
            apiScopes: ['apps', 'services'],
          }),
        },
        201,
      ),
    ).app
    args.ledger.record({
      kind: 'app',
      id: registered.id,
      label: `${args.runId}:app:${slug}`,
      cleanupPriority: 50,
      cleanup: async () => {
        if ((await capturedApp(registered.id)) === undefined) return
        const response = await request(appUrl, { method: 'DELETE', headers: bearer(args.apiToken) })
        assert([200, 404].includes(response.status), 'fixture app cleanup failed')
      },
      verify: async () => (await capturedApp(registered.id)) === undefined,
    })
    return registered
  }
  const registered = await register()
  const launch = await request(`${appUrl}/launch`, {
    headers: bearer(args.apiToken),
    redirect: 'manual',
  })
  assert.equal(launch.status, 302, 'private fixture launch failed')
  const destination = launch.headers.get('location')
  assert(destination !== null, 'private fixture launch omitted its URL')
  const grant = new URL(destination).searchParams.get(DUET_APP_ACCESS_QUERY)
  if (grant !== null) args.artifacts.registerSecret(grant)
  const admission = await request(destination, { redirect: 'manual' })
  const cookies = admission.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')
  for (const value of admission.headers.getSetCookie())
    args.artifacts.registerSecret(value.split(';')[0]!.split('=').slice(1).join('='))
  const serviceHeaders = new Headers({
    cookie: cookies,
    'x-expected-workspace': args.workspace.slug,
    'x-expected-app': slug,
  })
  // App reconciliation can arrive during a quiet VM's sleep; delivery remains pull-only.
  const deliveryBudgetMs = MAX_VM_IDLE_SYNC_INTERVAL_MS + 60_000
  const deliveryPollMs = 5_000
  const diagnostics = await waitForForwardProgress({
    label: 'managed app credential did not authenticate',
    load: async () => {
      args.progress('app-key-export:await-managed-auth')
      return await json(
        new URL('/diagnostics', registered.canonicalUrl).toString(),
        { headers: serviceHeaders },
        200,
      )
    },
    isComplete: value => value.managedAuthenticated === true,
    hasProgress: (previous, current) => previous.managedKeyPresent !== current.managedKeyPresent,
    maxConsecutiveUnchangedObservations: Math.ceil(deliveryBudgetMs / deliveryPollMs),
    timeoutMs: deliveryBudgetMs,
    pollMs: deliveryPollMs,
    summarize: value => ({
      managedKeyPresent: value.managedKeyPresent,
      managedAuthenticated: value.managedAuthenticated,
    }),
  })
  assert.equal(
    diagnostics.cliVersion,
    args.expectedCliVersion,
    'installed CLI differs from the served runtime release',
  )
  assert.equal(
    diagnostics.cliCommandAvailable,
    true,
    'installed CLI lacks the credential command; do not dispatch an agent prompt',
  )
  assert.equal(
    diagnostics.buildAppsSkillHash,
    args.expectedSkillHash,
    'installed build-app skill differs from the served bundle',
  )
  const credentialsUrl = `${appUrl}/credentials`
  const authenticate = async (key: string, status: number) => {
    const response = await request(`${args.env.apiUrl}/v1/whoami`, { headers: bearer(key) })
    assert.equal(
      response.status,
      status,
      'exported credential authentication had the wrong outcome',
    )
    await response.body?.cancel()
  }
  const revoke = async (id: string) => {
    const response = await request(`${credentialsUrl}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: bearer(args.apiToken),
    })
    assert([200, 404].includes(response.status), 'export cleanup failed')
    await response.body?.cancel()
  }
  const exported: ReturnType<typeof ExportAppCredentialResponseSchema.parse>[] = []
  const exportCredential = async (cli: boolean) => {
    const response = await request(
      cli ? new URL('/cli-export', registered.canonicalUrl).toString() : `${credentialsUrl}/export`,
      {
        method: 'POST',
        headers: cli ? serviceHeaders : bearerJson(args.apiToken),
        ...(cli ? {} : { body: JSON.stringify({ expiration: 'never' }) }),
      },
    )
    assert.equal(response.status, 201, 'one-time export failed; do not retry it automatically')
    const raw = await response.json()
    if (typeof raw?.key === 'string') args.artifacts.registerSecret(raw.key)
    const parsed = ExportAppCredentialResponseSchema.safeParse(raw)
    assert(parsed.success, 'one-time export response violated its contract')
    const credential = parsed.data
    assert.equal(
      credential.apiUrl,
      args.env.apiUrl,
      'export metadata returned the wrong API environment',
    )
    assert.equal(credential.expiresAt, null, 'explicit never export acquired an expiry')
    exported.push(credential)
    args.ledger.record({
      kind: 'api-key',
      id: credential.credentialId,
      label: `${args.runId}:export:${credential.credentialId}`,
      cleanupPriority: 100,
      cleanup: async () => await revoke(credential.credentialId),
      verify: async () => {
        const response = await request(`${credential.apiUrl}/v1/whoami`, {
          headers: bearer(credential.key),
        })
        await response.body?.cancel()
        return response.status === 401
      },
    })
    return credential
  }
  args.progress('app-key-export:installed-cli')
  const first = await exportCredential(true)
  const second = await exportCredential(true)
  const cliInventory = AppCredentialListResponseSchema.parse(
    await json(
      new URL('/cli-list', registered.canonicalUrl).toString(),
      { headers: serviceHeaders },
      200,
    ),
  )
  assert.deepEqual(
    cliInventory.items.map(item => item.credentialId).sort(),
    [first.credentialId, second.credentialId].sort(),
    'installed CLI inventory did not list both exports',
  )
  await authenticate(first.key, 200)
  await authenticate(second.key, 200)
  const catalog = await request(`${second.gatewayBaseUrl}/v1/models`, {
    headers: bearer(second.key),
  })
  assert.equal(catalog.status, 200, 'external exported app failed catalog authentication')
  await catalog.body?.cancel()
  await json(
    new URL('/cli-revoke', registered.canonicalUrl).toString(),
    {
      method: 'POST',
      headers: new Headers([...serviceHeaders, ['content-type', 'application/json']]),
      body: JSON.stringify({ credentialId: first.credentialId }),
    },
    200,
  )
  await authenticate(first.key, 401)
  await authenticate(second.key, 200)
  args.progress('app-key-export:capacity')
  const active = [second]
  for (let index = active.length; index < MAX_EXPORTED_APP_CREDENTIALS; index += 1)
    active.push(await exportCredential(false))
  const inventory = AppCredentialListResponseSchema.parse(
    await json(credentialsUrl, { headers: bearer(args.apiToken) }, 200),
  )
  assert.deepEqual(
    inventory.items.map(item => item.credentialId).sort(),
    active.map(item => item.credentialId).sort(),
    'live export inventory lost a credential or included a retired one',
  )
  const full = await json(
    `${credentialsUrl}/export`,
    {
      method: 'POST',
      headers: bearerJson(args.apiToken),
      body: JSON.stringify({ expiration: 'never' }),
    },
    409,
  )
  assert.equal(full.error, 'app_credential_limit', 'capacity refusal had the wrong category')
  assert.equal(full.limit, MAX_EXPORTED_APP_CREDENTIALS, 'capacity refusal had the wrong limit')
  await revoke(active.at(-1)!.credentialId)
  await exportCredential(false)
  args.progress('app-key-export:scope-and-row-lifecycle')
  for (const apiScopes of [['services'], ['apps', 'services']]) {
    await json(
      appUrl,
      { method: 'PATCH', headers: bearerJson(args.apiToken), body: JSON.stringify({ apiScopes }) },
      200,
    )
  }
  await authenticate(second.key, 401)
  const fresh = await exportCredential(false)
  await authenticate(fresh.key, 200)
  await json(appUrl, { method: 'DELETE', headers: bearer(args.apiToken) }, 200)
  await authenticate(fresh.key, 401)
  const replacement = await register()
  assert.notEqual(replacement.id, registered.id, 'app recreation reused the old row identity')
  await authenticate(fresh.key, 401)
  const evidence = {
    managedAuthenticated: true,
    cliVersion: diagnostics.cliVersion,
    buildAppsSkillHash: diagnostics.buildAppsSkillHash,
    appIds: [registered.id, replacement.id],
    credentialIds: exported.map(item => item.credentialId),
    exportsOverlap: true,
    individualRevocation: true,
    capacityBounded: true,
    capacityRecovered: true,
    scopeChangePermanent: true,
    rowBindingPermanent: true,
    catalogAuthenticated: true,
  }
  await args.artifacts.writeJson('app-key-export.json', evidence)
  return evidence
}
