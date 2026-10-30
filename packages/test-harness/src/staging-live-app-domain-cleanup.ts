import assert from 'node:assert/strict'

import type { ConvexHttpClient } from 'convex/browser'

import { fnQuery } from './staging-live-env'
import { bearer, bearerJson } from './staging-live-http'
import { workspaceIsDeleted, type StagingResourceLedger } from './staging-live-resource-ledger'

/** Ledger verification happens after every parent and credential cleanup. */
export function createAppDomainFixtureCleanup(args: {
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  internalKey: string
  workspaceId: string
  base: string
  hostname: string
  appPath: string
  apiToken: string
  request: (url: string, init?: RequestInit) => Promise<Response>
  waitProviderAbsent: () => Promise<unknown>
  providerAbsent: () => Promise<boolean>
}) {
  const capturedApp = async (appId: string) => {
    const apps = (await args.convex.query(fnQuery('domains/apps/model:listByWorkspace'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      id: appId,
    })) as Array<{ id: string; slug: string }>
    return apps[0] ?? null
  }
  const workspaceDeleted = () => workspaceIsDeleted(args.convex, args.internalKey, args.workspaceId)
  const deleteCapturedAppResource = async (appId: string, suffix: string) => {
    const app = await capturedApp(appId)
    // A deleted generation must never send a slug mutation to its replacement.
    if (app === null) return
    const response = await args.request(`${args.base}/apps/${app.slug}${suffix}`, {
      method: 'DELETE',
      headers: bearer(args.apiToken),
    })
    assert(
      [200, 404].includes(response.status),
      `fixture ${suffix === '' ? 'app' : 'domain'} deletion failed`,
    )
  }
  return {
    recordDomain(appId: string) {
      args.ledger.record({
        kind: 'app-domain',
        id: `${args.hostname}:${appId}`,
        label: `${args.ledger.runId}:domain:${args.hostname}:${appId}`,
        cleanupPriority: 100,
        cleanup: async () => {
          await deleteCapturedAppResource(appId, '/domain')
          await args.waitProviderAbsent()
        },
        // This is external cleanup proof, not an unseen orphan-row absence claim.
        // Successful live detach separately observes domain:null before deleting its app.
        verify: async () => (await capturedApp(appId)) === null && (await args.providerAbsent()),
      })
    },
    recordApp(appId: string) {
      args.ledger.record({
        kind: 'app',
        id: appId,
        label: `${args.ledger.runId}:app:${appId}`,
        cleanupPriority: 50,
        cleanup: async () => await deleteCapturedAppResource(appId, ''),
        verify: async () => (await capturedApp(appId)) === null,
      })
    },
    recordDirectory() {
      args.ledger.record({
        kind: 'file',
        id: args.appPath,
        label: `${args.ledger.runId}:fixture-directory:${args.appPath}`,
        cleanupPriority: 20,
        cleanup: async () => {
          if (await workspaceDeleted()) return
          const response = await args.request(`${args.base}/files/actions`, {
            method: 'POST',
            headers: bearerJson(args.apiToken),
            body: JSON.stringify({ operation: 'delete', path: args.appPath, recursive: true }),
          })
          assert([200, 404].includes(response.status), 'fixture directory deletion failed')
        },
        verify: workspaceDeleted,
      })
    },
  }
}
