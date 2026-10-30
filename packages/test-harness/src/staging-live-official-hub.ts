import {
  InternalAdminOfficialHubSyncSchema,
  type InternalAdminOfficialHubSync,
} from '@repo/contract'

import { fnMutation, fnQuery } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import type { WorkspaceBrowserJourneyContext } from './staging-live-workspace-browser.ts'

/**
 * Press the official hub sync the way an operator does. The sync adopts the
 * live hub workspace — or creates one and boots its VM when none is active —
 * converges the repo's agents into it, and re-registers their listings, which
 * is what brings a greyed catalog back. A hub whose VM is still coming up
 * refuses the converge leg, so a press is retried until the deadline.
 */
export async function pressOfficialHubSync(
  context: WorkspaceBrowserJourneyContext,
  label: string,
  options: { retryUntilMs?: number } = {},
): Promise<InternalAdminOfficialHubSync> {
  const { env, artifacts } = context
  const admin = await syncAdminIdentity(context)
  const deadline = Date.now() + (options.retryUntilMs ?? 0)
  for (;;) {
    try {
      return InternalAdminOfficialHubSyncSchema.parse(
        await apiJson<unknown>(
          `${env.apiUrl}/v1/internal-admin/official-hub/sync`,
          { method: 'POST', headers: bearerJson(admin.token), body: '{}' },
          200,
          label,
          artifacts,
        ),
      )
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await Bun.sleep(10_000)
    }
  }
}

/**
 * The last marketplace/pull lines of a workspace's gateway log, read through
 * internal-admin as the operator. Diagnostic only: it never throws, so a
 * failure message can carry it without masking the assertion it decorates.
 */
export async function workspaceGatewayLogTail(
  context: Pick<
    WorkspaceBrowserJourneyContext,
    'env' | 'runId' | 'artifacts' | 'ledger' | 'convex'
  >,
  workspaceId: string,
  pattern = /marketplace|official|pull/i,
): Promise<string> {
  try {
    const admin = await syncAdminIdentity(context)
    const response = await stagingFetch(
      `${context.env.apiUrl}/v1/internal-admin/workspaces/${workspaceId}/logs?source=gateway`,
      { headers: bearer(admin.token) },
    )
    if (!response.ok) return `<log read ${response.status}>`
    // The route answers `{ content }` — the tail of the file, not the file.
    const { content } = (await response.json()) as { content?: string }
    const lines = (content ?? '')
      .split('\n')
      .filter(line => pattern.test(line))
      .slice(-25)
    return lines.length === 0 ? '<no matching lines>' : lines.join(' | ')
  } catch (error) {
    return `<log read threw: ${error instanceof Error ? error.message : String(error)}>`
  }
}

/** The 15-minute availability sweep, pressed now instead of waited for. */
export async function sweepListingAvailability(
  context: WorkspaceBrowserJourneyContext,
): Promise<{ scanned: number; changed: number }> {
  return (await context.convex.mutation(
    fnMutation('domains/marketplace/listings:sweepListingAvailability'),
    { internalKey: context.env.internalKey },
  )) as { scanned: number; changed: number }
}

/**
 * ONE throwaway internal-admin identity per run, minted on first use.
 *
 * Both the sync leg and the log diagnostic need admin auth. Minting one each
 * would provision two workspaces and leave the cleanup ledger with two rows for
 * what is conceptually one actor.
 */
export async function syncAdminIdentity(
  context: Pick<
    WorkspaceBrowserJourneyContext,
    'env' | 'runId' | 'artifacts' | 'ledger' | 'convex'
  >,
): Promise<{ token: string; userId: string }> {
  const { env, runId, artifacts, ledger, convex } = context
  const cached = adminIdentities.get(runId)
  if (cached !== undefined) return await cached
  // MUST be the `<runId>-admin@duet.so` shape: `assertStagingE2ESyntheticEmail`
  // (backend testing/stagingE2e.ts) refuses to retire anything else, so an
  // invented address creates a workspace the cleanup rail cannot reap.
  const adminEmail = `${runId}-admin@duet.so`
  const pending = (async () => {
    const admin = await apiJson<{ token: string; userId: string }>(
      `${env.apiUrl}/v1/admin/login-as`,
      {
        method: 'POST',
        headers: bearerJson(env.loginSecret),
        body: JSON.stringify({
          email: adminEmail,
          create: true,
          ephemeral: true,
          name: `Marketplace operator ${runId}`,
          ttlSeconds: 900,
        }),
      },
      200,
      'marketplace operator login',
      artifacts,
    )
    // `login-as` with `create: true` PROVISIONS A WORKSPACE, so this identity is
    // a real resource and has to be ledgered or the run leaks a VM every time —
    // which it did, once, before this was ledgered.
    //
    // That workspace must be DELETED BEFORE the user: `retireUserIdentity`
    // refuses with "User still belongs to a live workspace" while any of the
    // user's workspaces is not yet `deleted`. The predecessor only minted this
    // identity on the install-failure diagnostic path, so the ordering bug sat
    // latent until the sync leg started minting it on every run.
    ledger.record({
      kind: 'user',
      id: admin.userId,
      label: `${runId}:operator-admin:${adminEmail}`,
      cleanupPriority: -100,
      cleanup: async () => {
        const owned = (await convex.query(fnQuery('testing/workspaces:workspacesByOwnerForTest'), {
          internalKey: env.internalKey,
          userId: admin.userId,
        })) as Array<{ _id: string }>
        for (const workspace of owned) {
          await convex.mutation(fnMutation('testing/workspaces:deleteWorkspaceByIdForTest'), {
            internalKey: env.internalKey,
            workspaceId: workspace._id,
          })
        }
        await convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
          internalKey: env.internalKey,
          email: adminEmail,
        })
      },
      verify: async () =>
        (await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
          internalKey: env.internalKey,
          email: adminEmail,
        })) === null,
    })
    return admin
  })()
  adminIdentities.set(runId, pending)
  return await pending
}

const adminIdentities = new Map<string, Promise<{ token: string; userId: string }>>()
