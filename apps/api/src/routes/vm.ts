import {
  DeliveredModelCredentialsSchema,
  RUNTIME_RELEASE_ARTIFACT_NAMES,
  extractBearerToken,
  FileEventBatchSchema,
  type GatewayAgentConfig,
  type GatewayAnchor,
  type GatewayAppConfig,
  type RuntimeReleaseDescriptor,
  type ApprovedModelCatalog,
  hashApiKey,
  VmRegisterRequestSchema,
  VmRestoreReferenceSchema,
  VmRestoreCommandSchema,
  type VmRestoreReference,
  type VmRestoreDescriptor,
  VmRegisterResponseSchema,
  VmSyncRequestSchema,
  VmSyncResponseSchema,
  type VmModelCredentials,
  type VmRegisterResponse,
  type VmSyncRequest,
  type VmSyncResponse,
} from '@repo/contract'
import {
  buildSkillsBundle,
  renderDefaultSkills,
  type BuiltSkillsBundle,
} from '@repo/skills-registry'

import { drainWorkspaceOnRegister as drainWorkspaceRunnerInputs } from '../agent-runner'
import type { BackupBlobStore } from '../backups/blob'
import { withPublicAppUrls } from '../gateway/app-configs'
import { type GatewayClient, type GatewayConnection } from '../gateway/client'
import {
  announcedRuntimeRelease,
  logRuntimeReleaseAccess,
  readRuntimeReleaseArtifact,
  readRuntimeReleaseManifest,
} from '../runtime/release'
import {
  fn,
  fnQuery,
  readJson,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
  type ComposioMcpProvider,
} from '../shared'
import { fastCadenceReason, vmSyncPollAfterMs } from '../vm-poll-interval'
import { synchronizeLeasedSessionIntegrations } from './session-integrations'
import { applyVmAnchorMoveCandidates } from './workspaces'

export const VM_AUTH_BYPASS_PATHS = [
  '/v1/vm/register',
  '/v1/vm/sync',
  '/v1/vm/anchors/move-candidates',
  '/v1/vm/file-events',
  '/v1/vm/runtime-release/manifest',
] as const

export const VM_AUTH_BYPASS_PATTERNS = [
  /^\/v1\/vm\/runtime-release\/artifacts\/[^/]+$/,
  /^\/v1\/vm\/skills\/[^/]+$/,
  /^\/v1\/vm\/workspaces\/[^/]+\/restore$/,
] as const
const VM_SYNC_PROJECTION_TIME_BUCKET_MS = 60_000

export type VmRegistrationPostCommitSeam =
  | 'core_projection'
  | 'release'
  | 'skills'
  | 'restore_url'
  | 'composition'
  | 'serialization'

export interface VmRegistrationPostCommitTestHooks {
  before?: (seam: VmRegistrationPostCommitSeam) => void | Promise<void>
  /** Stands in for a Convex deployment whose registerVm result this API build did not anticipate. */
  committedResult?: (result: unknown) => unknown
}

export function registerVmRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: {
    modelGatewayUrl: string | null
    runtimeReleaseDir: string
    vmSyncIntervalSeconds: number
    vmIdleSyncIntervalSeconds: number
    edgeHost: string
    approvedModelCatalog: ApprovedModelCatalog
    composioMcpProvider?: ComposioMcpProvider
    backupBlob: BackupBlobStore
    registrationPostCommitTestHooks?: VmRegistrationPostCommitTestHooks
  },
): void {
  const skillsBundles = new SkillsBundlesByOrigin(options.approvedModelCatalog)

  app.post('/v1/vm/register', async c => {
    const body = VmRegisterRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    let committed: unknown
    try {
      committed = await runtime.convex.mutation(fn('domains/workspaces/provisioning:registerVm'), {
        internalKey: runtime.internalKey,
        provisioningTokenHash: await hashApiKey(body.data.provisioningToken),
        workspaceHint: body.data.workspaceHint,
        vmName: body.data.vmName,
        sshDest: body.data.sshDest,
        httpsUrl: body.data.httpsUrl,
        runtimeVersion: body.data.runtimeVersion,
        imageVersion: body.data.imageVersion,
        deliverModelCredentials: options.modelGatewayUrl !== null,
        now: Date.now(),
      })
    } catch (error) {
      // The VM retries this on its backoff loop, so a refused registration
      // recurs every few minutes; say which VM so the noise is traceable.
      console.error(
        `[vm-register] refused workspaceHint=${body.data.workspaceHint} vmName=${body.data.vmName ?? '-'}:`,
        error instanceof Error ? error.message : String(error),
      )
      return c.json({ error: 'unauthorized' }, 401)
    }
    // Committed. The VM's provisioning token is spent until its first sync, so
    // from here every answer must carry the VM token — never a 401. That
    // includes a result shape this API build did not anticipate: one Vercel
    // build deploys Convex and then promotes the API, so a release that changes
    // registerVm's result serves new Convex to the old API during the promotion
    // window (2026-08-29: two committed registrations answered 401, both VMs
    // re-registered every five minutes for days).
    const result =
      options.registrationPostCommitTestHooks?.committedResult?.(committed) ?? committed
    const vmToken = committedString(result, 'vmToken')
    if (vmToken === undefined) {
      console.error(
        `[vm-register] committed result carries no vmToken workspaceHint=${body.data.workspaceHint}`,
      )
      return c.json({ error: 'registration_result_unusable' }, 500)
    }
    const parsedRestore = VmRestoreReferenceSchema.nullable().safeParse(
      typeof result === 'object' && result !== null
        ? ((result as Record<string, unknown>).restore ?? null)
        : null,
    )
    const reference = parsedRestore.success ? parsedRestore.data : null
    const refreshUrl = new URL(
      `/v1/vm/workspaces/${body.data.workspaceHint}/restore`,
      c.req.url,
    ).toString()
    const restore = reference ? restoreDescriptor(reference, refreshUrl) : null
    const vmTokenPrefix = committedString(result, 'vmTokenPrefix')
    const fallbackResponse = vmRegisterJsonResponse({
      vmToken,
      vmTokenPrefix,
      syncIntervalSeconds: options.vmSyncIntervalSeconds,
      restore,
      sync: {
        pollAfterMs: options.vmSyncIntervalSeconds * 1000,
        workspaceSlug: committedString(result, 'workspaceSlug'),
        anchors: [],
        agents: [],
        apps: [],
        shareSync: { shares: [] },
        updates: { paused: true },
      },
    })
    try {
      if (!isVmRegisterResult(result)) throw new Error('Invalid register result')
      const syncState = await readVmSyncState(
        runtime,
        await hashApiKey(vmToken),
        runtime.now(),
        options.registrationPostCommitTestHooks,
      )
      // Registration is the VM's first credential delivery. A production VM
      // cannot accept runner input safely until this HTTP response has landed;
      // its first sync poll will drain the durable queue immediately after.
      if (options.modelGatewayUrl === null && reference === null) {
        await drainWorkspaceAgentInputs(
          c,
          runtime,
          gatewayClient,
          body.data.workspaceHint,
          'register',
          options.composioMcpProvider,
        )
      }
      await options.registrationPostCommitTestHooks?.before?.('release')
      const release = await announcedRuntimeRelease({
        releaseDir: options.runtimeReleaseDir,
        apiBaseUrl: new URL(c.req.url).origin,
      })
      await options.registrationPostCommitTestHooks?.before?.('skills')
      const skills = skillsDescriptor(c.req.url, skillsBundles.forOrigin(runtime.appUrl))
      await options.registrationPostCommitTestHooks?.before?.('composition')
      const sync = composeVmSyncResponse({
        pollAfterMs: options.vmSyncIntervalSeconds * 1000,
        workspaceSlug: syncState.workspaceSlug,
        edgeHost: options.edgeHost,
        anchors: syncState.anchors,
        agents: syncState.agents,
        mirrorMachineIds: syncState.mirrorMachineIds,
        apps: syncState.apps,
        shareSync: syncState.shareSync,
        marketplace: syncState.marketplace,
        disconnectConnectedProviders: syncState.disconnectConnectedProviders,
        updatesPaused: syncState.updatesPaused,
        quiesce: syncState.quiesce,
        runtimeRelease: release,
        deliveredModelCredentials: result.modelCredentials,
        modelGatewayUrl: options.modelGatewayUrl,
        skills,
      })
      await options.registrationPostCommitTestHooks?.before?.('restore_url')
      const signedRestore =
        reference?.kind === 'workspace-backup'
          ? {
              ...restoreDescriptor(reference, refreshUrl),
              download: await options.backupBlob.download(reference.objectPath),
            }
          : restore
      const responseBody = {
        vmToken,
        vmTokenPrefix,
        syncIntervalSeconds: options.vmSyncIntervalSeconds,
        restore: signedRestore,
        sync,
      }
      await options.registrationPostCommitTestHooks?.before?.('serialization')
      return vmRegisterJsonResponse(responseBody)
    } catch (error) {
      console.error('[vm-register] post-commit response unavailable', error)
      return fallbackResponse
    }
  })

  app.post('/v1/vm/sync', async c => {
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    const body = VmSyncRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) {
      // A request this API cannot parse means the SENDER is outdated — and
      // its upgrade path runs through this very endpoint. Instead of a 400
      // (which bricked the image-gateway fleet, 2026-07-23), authenticate
      // the token and answer 200 with a runtime-release-only envelope: the
      // gateway's pre-validation rescue parse installs it and the next sync
      // speaks the current shape. Schema breaks heal in one cycle.
      const issues = body.error.issues.slice(0, 8).map(issue => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      }))
      console.error('[vm-sync] unparseable request; serving rescue release', JSON.stringify(issues))
      const vmTokenHash = await hashApiKey(token)
      try {
        await readVmSyncState(runtime, vmTokenHash, runtime.now())
      } catch (error) {
        if (isInvalidVmTokenError(error)) return c.json({ error: 'unauthorized' }, 401)
        throw error
      }
      const rescueRelease = await announcedRuntimeRelease({
        releaseDir: options.runtimeReleaseDir,
        apiBaseUrl: new URL(c.req.url).origin,
      })
      return c.json({ runtimeRelease: rescueRelease })
    }
    const vmTokenHash = await hashApiKey(token)
    const now = runtime.now()
    let state: VmSyncProjection
    try {
      state = await readVmSyncState(runtime, vmTokenHash, now)
    } catch (error) {
      if (isInvalidVmTokenError(error)) return c.json({ error: 'unauthorized' }, 401)
      throw error
    }
    const observation = backendObservation(body.data, options.modelGatewayUrl !== null)
    // The projection is a pure cached read; the persist DECISION lives in the
    // mutation, called every poll with a real clock. Train reports use their own
    // generation-idempotent mutation, outside that observation throttle.
    const marketplacePullReports = body.data.marketplacePullReports ?? []
    const trainReports = body.data.trainReports ?? []
    const [mutationResult, acceptedTrainReportGenerations] = await Promise.all([
      runtime.convex.mutation(fn('domains/workspaces/vmSync:persistVmSyncObservation'), {
        internalKey: runtime.internalKey,
        vmTokenHash,
        observation,
        now,
      }),
      // Only when there is something to reconcile. This poll runs for every VM
      // every few seconds, so an unconditional call here is a fleet-wide Convex
      // bill for a mutation that loads the workspace row to accept nothing.
      // Train ingestion must never sink the core sync loop (anchors, apps,
      // credentials, self-update): on failure we ack nothing and the gateway
      // retains its outbox for the next poll, rather than 500 the whole sync.
      trainReports.length === 0
        ? Promise.resolve([] as string[])
        : (
            runtime.convex.mutation(fn('domains/train/model:reconcileFromVm'), {
              internalKey: runtime.internalKey,
              workspaceId: state.workspaceId,
              trainReports,
            }) as Promise<string[]>
          ).catch(() => [] as string[]),
      // Marketplace pull ingestion is shielded the same way: one subscription's
      // apply already fails onto its own row inside the mutation, and this
      // catch keeps even an apply-code bug from sinking the sync loop — a
      // deleted-app orphan once 500ed every poll of the workspace this way.
      // The gateway re-reports on the next poll, so a dropped batch heals.
      marketplacePullReports.length === 0
        ? Promise.resolve()
        : runtime.convex
            .mutation(fn('domains/marketplace/model:applyPullReports'), {
              internalKey: runtime.internalKey,
              workspaceId: state.workspaceId,
              reports: marketplacePullReports,
              now,
            })
            .catch(error => {
              console.error('[vm-sync] marketplace pull apply failed', {
                workspaceId: state.workspaceId,
                error: error instanceof Error ? error.message : String(error),
              })
            }),
    ])
    const persisted = asPersistedVmSyncResult(mutationResult)
    // A credential is not usable by the VM until this response lands. Draining
    // in the same request races a runner spawn against the response that
    // carries its auth; leave the durable input parked for the next poll.
    //
    // Parked input is the ONLY trigger. The projection already answers "is
    // anything parked" with one indexed point-read, so a drain on any other
    // cue is a second Convex query per poll that finds nothing, fleet-wide,
    // forever.
    if (persisted?.modelCredentials === undefined && state.hasPendingRunnerInput) {
      await drainWorkspaceAgentInputs(
        c,
        runtime,
        gatewayClient,
        state.workspaceId,
        'sync',
        options.composioMcpProvider,
      )
    }
    const release = await announcedRuntimeRelease({
      releaseDir: options.runtimeReleaseDir,
      apiBaseUrl: new URL(c.req.url).origin,
    })
    const cadence = {
      now,
      request: body.data,
      activity: {
        hasPendingRunnerInput: state.hasPendingRunnerInput === true,
        // Paused and banned workspaces are refused credentials by the persist
        // path, so their VMs ask on every poll; the ask is not an exchange.
        credentialsRefused: state.quiesce === true,
        deliveringModelCredentials: persisted?.modelCredentials !== undefined,
        modelCredentialsRetryAt: persisted?.modelCredentialsRetryAt,
      },
    }
    // One line per FAST poll, naming the clause. A VM pinned to the fast
    // cadence costs six times an idle one, and this is the only place that
    // knows why; grep the reason distribution in production before touching
    // the cadence policy. Idle polls log nothing.
    const fastReason = fastCadenceReason(cadence)
    if (fastReason !== null) {
      console.log(`[vm-sync] fast-cadence workspace=${state.workspaceSlug} reason=${fastReason}`)
    }
    const response = composeVmSyncResponse({
      pollAfterMs: vmSyncPollAfterMs({
        ...cadence,
        activeSeconds: options.vmSyncIntervalSeconds,
        idleSeconds: options.vmIdleSyncIntervalSeconds,
      }),
      workspaceSlug: state.workspaceSlug,
      edgeHost: options.edgeHost,
      anchors: state.anchors,
      agents: state.agents,
      mirrorMachineIds: state.mirrorMachineIds,
      apps: state.apps,
      shareSync: state.shareSync,
      marketplace: state.marketplace,
      disconnectConnectedProviders: state.disconnectConnectedProviders,
      updatesPaused: state.updatesPaused,
      quiesce: state.quiesce,
      acceptedTrainReportGenerations,
      runtimeRelease: release,
      deliveredModelCredentials: persisted?.modelCredentials,
      deliveredAppCredentials: persisted?.appCredentials,
      modelGatewayUrl: options.modelGatewayUrl,
      skills: skillsDescriptor(c.req.url, skillsBundles.forOrigin(runtime.appUrl)),
    })
    return jsonWithCredentialCachePolicy(c, response, vmSyncHasCredentials(response))
  })

  app.post('/v1/vm/anchors/move-candidates', async c => {
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    const body = await readJson(c.req.raw)
    try {
      const result = await applyVmAnchorMoveCandidates(runtime, gatewayClient, token, body)
      if (typeof result === 'object' && result !== null && 'invalid' in result) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      return c.json(result)
    } catch {
      return c.json({ error: 'unauthorized' }, 401)
    }
  })

  app.post('/v1/vm/workspaces/:workspaceId/restore', async c => {
    c.header('cache-control', 'private, no-store')
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    const command = VmRestoreCommandSchema.safeParse(await readJson(c.req.raw))
    if (!command.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      return c.json(
        await runtime.convex.mutation(fn('domains/workspaceBackups/restore:report'), {
          internalKey: runtime.internalKey,
          workspaceId: c.req.param('workspaceId'),
          vmTokenHash: await hashApiKey(token),
          command: command.data,
        }),
      )
    } catch (error) {
      if (String(error).includes('unauthorized')) return c.json({ error: 'unauthorized' }, 401)
      return c.json({ error: 'restore_rejected' }, 409)
    }
  })

  app.get('/v1/vm/workspaces/:workspaceId/restore', async c => {
    c.header('cache-control', 'private, no-store')
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    let reference: VmRestoreReference | null
    try {
      reference = VmRestoreReferenceSchema.nullable().parse(
        await runtime.convex.query(fnQuery('domains/workspaces/provisioning:restoreForVm'), {
          internalKey: runtime.internalKey,
          workspaceId: c.req.param('workspaceId'),
          vmTokenHash: await hashApiKey(token),
        }),
      )
    } catch {
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (reference?.kind !== 'workspace-backup') return c.json({ error: 'not_found' }, 404)
    try {
      return c.json(await options.backupBlob.download(reference.objectPath))
    } catch {
      return c.json({ error: 'storage_unavailable' }, 503)
    }
  })

  // File-event ingest (spec file-attribution slice 03): the gateway relays
  // attribution batches with its vm token, exactly like the agent-session
  // relay above it in agent.ts. The workspace comes from the authenticated
  // VM registration — never from the payload.
  app.post('/v1/vm/file-events', async c => {
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    const body = FileEventBatchSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const gateway = await gatewayConnectionByVmToken(runtime, token)
      if (gateway === null) return c.json({ error: 'unauthorized' }, 401)
      const result = await runtime.convex.mutation(
        fn('domains/fileActivity/api:recordBatchFromApi'),
        {
          internalKey: runtime.internalKey,
          workspaceId: gateway.workspaceId,
          batch: body.data,
          now: runtime.now(),
        },
      )
      return c.json(result)
    } catch {
      return c.json({ error: 'unauthorized' }, 401)
    }
  })

  app.get('/v1/vm/runtime-release/manifest', async c => {
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    try {
      const gateway = await gatewayConnectionByVmToken(runtime, token)
      if (gateway === null) return c.json({ error: 'unauthorized' }, 401)
      logRuntimeReleaseAccess('manifest', gateway)
      const manifest = await readRuntimeReleaseManifest(options.runtimeReleaseDir)
      if (manifest === null) return c.json({ error: 'runtime_release_unavailable' }, 503)
      return c.json(manifest)
    } catch {
      return c.json({ error: 'unauthorized' }, 401)
    }
  })

  app.get('/v1/vm/runtime-release/artifacts/:name', async c => {
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    try {
      const gateway = await gatewayConnectionByVmToken(runtime, token)
      if (gateway === null) return c.json({ error: 'unauthorized' }, 401)
      const name = c.req.param('name')
      if (!(RUNTIME_RELEASE_ARTIFACT_NAMES as readonly string[]).includes(name))
        return c.json({ error: 'not_found' }, 404)
      logRuntimeReleaseAccess(name, gateway)
      const artifact = await readRuntimeReleaseArtifact(options.runtimeReleaseDir, name)
      if (artifact === null) return c.json({ error: 'runtime_release_unavailable' }, 503)
      return new Response(artifact.body, {
        status: 200,
        headers: {
          'content-type': artifact.contentType,
          'content-length': String(artifact.byteLength),
        },
      })
    } catch {
      return c.json({ error: 'unauthorized' }, 401)
    }
  })

  app.get('/v1/vm/skills/:hash', async c => {
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    try {
      const gateway = await gatewayConnectionByVmToken(runtime, token)
      if (gateway === null) return c.json({ error: 'unauthorized' }, 401)
      const bundle = skillsBundles.forOrigin(runtime.appUrl)
      if (c.req.param('hash') !== bundle.hash) return c.json({ error: 'not_found' }, 404)
      return new Response(bundle.bytes, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(new TextEncoder().encode(bundle.bytes).byteLength),
        },
      })
    } catch {
      return c.json({ error: 'unauthorized' }, 401)
    }
  })
}

class SkillsBundlesByOrigin {
  private static readonly MAX_CACHED_ORIGINS = 8
  private readonly bundles = new Map<string, BuiltSkillsBundle>()

  constructor(private readonly catalog: ApprovedModelCatalog) {}

  forOrigin(appUrl: string): BuiltSkillsBundle {
    const appOrigin = new URL(appUrl).origin
    const cached = this.bundles.get(appOrigin)
    if (cached !== undefined) {
      this.bundles.delete(appOrigin)
      this.bundles.set(appOrigin, cached)
      return cached
    }
    const bundle = buildSkillsBundle(
      renderDefaultSkills({ appUrl: appOrigin, catalog: this.catalog }),
    )
    this.bundles.set(appOrigin, bundle)
    if (this.bundles.size > SkillsBundlesByOrigin.MAX_CACHED_ORIGINS) {
      const oldestOrigin = this.bundles.keys().next().value
      if (oldestOrigin !== undefined) this.bundles.delete(oldestOrigin)
    }
    return bundle
  }
}

function skillsDescriptor(
  requestUrl: string,
  bundle: BuiltSkillsBundle,
): NonNullable<VmSyncResponse['skills']> {
  return {
    hash: bundle.hash,
    url: new URL(`/v1/vm/skills/${bundle.hash}`, requestUrl).toString(),
  }
}

async function drainWorkspaceAgentInputs(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  workspaceId: string,
  source: 'register' | 'sync',
  composioMcpProvider?: ComposioMcpProvider,
): Promise<void> {
  try {
    const drain = await drainWorkspaceRunnerInputs({
      c,
      runtime,
      gatewayClient,
      workspaceId,
      projectIntegrations: composioMcpProvider !== undefined,
      beforeDispatch: (workspace, prepared) =>
        synchronizeLeasedSessionIntegrations(
          c,
          runtime,
          {
            composioMcpProvider,
          },
          workspace,
          prepared,
        ),
    })
    if (drain.stopped === 'failed') {
      console.error(`vm ${source} drain: gateway dispatch failed`, {
        workspaceId,
        delivered: drain.delivered,
        status: drain.response?.status,
      })
    }
  } catch (error) {
    console.error(`vm ${source} drain failed`, {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function gatewayConnectionByVmToken(
  runtime: ApiRouteRuntime,
  token: string,
): Promise<GatewayConnection | null> {
  return (await runtime.convex.query(
    fnQuery('domains/workspaces/provisioning:gatewayConnectionByVmToken'),
    {
      internalKey: runtime.internalKey,
      vmTokenHash: await hashApiKey(token),
    },
  )) as GatewayConnection | null
}

function withApiModelCredentials(result: unknown, gatewayBaseUrl: string | null): unknown {
  if (typeof result !== 'object' || result === null) return result
  const value = result as Record<string, unknown>
  const delivered = value.modelCredentials
  const parsed = DeliveredModelCredentialsSchema.safeParse(delivered)
  if (!parsed.success) return result
  // The API owns the credential's address, so a deployment with no model rail
  // cannot complete the envelope. Backend delivery is unprompted — it does not
  // know this deployment's config — so drop the credential rather than ship one
  // the VM must reject for a missing `gatewayBaseUrl`.
  if (gatewayBaseUrl === null) {
    const { modelCredentials: _undeliverable, ...rest } = value
    return rest
  }
  return {
    ...value,
    modelCredentials: {
      apiKey: parsed.data.apiKey,
      gatewayBaseUrl,
      expiresAt: parsed.data.expiresAt,
    } satisfies VmModelCredentials,
  }
}

interface VmSyncProjection {
  hasPendingRunnerInput?: boolean
  workspaceId: string
  workspaceSlug: string
  anchors: GatewayAnchor[]
  agents: GatewayAgentConfig[]
  mirrorMachineIds: string[]
  apps: GatewayAppConfig[]
  shareSync: NonNullable<VmSyncResponse['shareSync']>
  marketplace?: NonNullable<VmSyncResponse['marketplace']>
  disconnectConnectedProviders?: NonNullable<VmSyncResponse['disconnectConnectedProviders']>
  updatesPaused: boolean
  quiesce: boolean
}

export interface ComposeVmSyncResponseInput {
  pollAfterMs: number
  workspaceSlug: string
  edgeHost: string
  anchors: GatewayAnchor[]
  agents: GatewayAgentConfig[]
  mirrorMachineIds: string[]
  apps: GatewayAppConfig[]
  shareSync: NonNullable<VmSyncResponse['shareSync']>
  marketplace?: NonNullable<VmSyncResponse['marketplace']>
  disconnectConnectedProviders?: NonNullable<VmSyncResponse['disconnectConnectedProviders']>
  updatesPaused: boolean
  quiesce: boolean
  acceptedTrainReportGenerations?: string[]
  runtimeRelease: RuntimeReleaseDescriptor | null
  deliveredModelCredentials?: { apiKey: string; expiresAt: number }
  deliveredAppCredentials?: NonNullable<VmSyncResponse['appCredentials']>
  modelGatewayUrl: string | null
  skills: NonNullable<VmSyncResponse['skills']>
}

export function composeVmSyncResponse(input: ComposeVmSyncResponseInput): VmSyncResponse {
  const credentials = withApiModelCredentials(
    input.deliveredModelCredentials === undefined
      ? {}
      : { modelCredentials: input.deliveredModelCredentials },
    input.modelGatewayUrl,
  ) as { modelCredentials?: VmModelCredentials }
  const updates = { paused: input.updatesPaused || input.runtimeRelease === null }
  return VmSyncResponseSchema.parse({
    pollAfterMs: input.pollAfterMs,
    quiesce: input.quiesce,
    workspaceSlug: input.workspaceSlug,
    anchors: input.anchors,
    agents: input.agents,
    mirrorMachineIds: input.mirrorMachineIds,
    apps: withPublicAppUrls(input.apps, {
      workspaceSlug: input.workspaceSlug,
      edgeHost: input.edgeHost,
    }),
    shareSync: input.shareSync,
    ...(input.marketplace === undefined ? {} : { marketplace: input.marketplace }),
    ...(input.disconnectConnectedProviders === undefined ||
    input.disconnectConnectedProviders.length === 0
      ? {}
      : { disconnectConnectedProviders: input.disconnectConnectedProviders }),
    ...(input.runtimeRelease === null ? {} : { runtimeRelease: input.runtimeRelease }),
    skills: input.skills,
    updates,
    ...(input.acceptedTrainReportGenerations === undefined
      ? {}
      : {
          acceptedTrainReportGenerations: input.acceptedTrainReportGenerations,
        }),
    ...(credentials.modelCredentials === undefined
      ? {}
      : { modelCredentials: credentials.modelCredentials }),
    ...(input.deliveredAppCredentials === undefined
      ? {}
      : { appCredentials: input.deliveredAppCredentials }),
  })
}

function vmSyncHasCredentials(response: VmSyncResponse): boolean {
  return (
    response.modelCredentials !== undefined ||
    (response.appCredentials !== undefined && response.appCredentials.length > 0) ||
    (response.shareSync !== undefined && response.shareSync.shares.length > 0)
  )
}

type BackendVmSyncObservation = Pick<
  VmSyncRequest,
  | 'syncthingDeviceId'
  | 'shareSyncReports'
  | 'appReconciliationReports'
  | 'needsModelCredentials'
  | 'needsAppCredentials'
> & { versions: VmSyncRequest['versions'] }

function backendObservation(
  request: VmSyncRequest,
  canDeliverCredentials: boolean,
): BackendVmSyncObservation {
  return {
    ...(request.syncthingDeviceId === undefined
      ? {}
      : { syncthingDeviceId: request.syncthingDeviceId }),
    ...(request.shareSyncReports === undefined
      ? {}
      : { shareSyncReports: request.shareSyncReports }),
    ...(request.appReconciliationReports === undefined
      ? {}
      : { appReconciliationReports: request.appReconciliationReports }),
    needsModelCredentials: request.needsModelCredentials && canDeliverCredentials,
    ...(request.needsAppCredentials === undefined
      ? {}
      : { needsAppCredentials: request.needsAppCredentials }),
    versions: {
      runtime: request.versions.runtime,
      image: request.versions.image,
    },
  }
}

async function readVmSyncState(
  runtime: ApiRouteRuntime,
  vmTokenHash: string,
  now: number,
  registrationHooks?: VmRegistrationPostCommitTestHooks,
): Promise<VmSyncProjection> {
  // Use the end of the current minute so identical polls share Convex's query
  // cache without ever projecting credentials past their real expiry.
  const projectionNow =
    Math.ceil(now / VM_SYNC_PROJECTION_TIME_BUCKET_MS) * VM_SYNC_PROJECTION_TIME_BUCKET_MS
  const args = {
    internalKey: runtime.internalKey,
    vmTokenHash,
    now: projectionNow,
  }
  await registrationHooks?.before?.('core_projection')
  // ONE query, on purpose: a Convex query is a consistent snapshot, so the
  // roster and the shares are read under the same servicing state and a pause
  // cannot land between them. It is also one function call per poll, which
  // across the fleet is the bill this route is measured by.
  return (await runtime.convex.query(
    fnQuery('domains/workspaces/vmSync:readVmSyncState'),
    args,
  )) as VmSyncProjection
}

function vmRegisterJsonResponse(body: VmRegisterResponse): Response {
  return new Response(JSON.stringify(VmRegisterResponseSchema.parse(body)), {
    status: 200,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json; charset=UTF-8',
    },
  })
}

function asPersistedVmSyncResult(value: unknown):
  | {
      persisted?: boolean
      modelCredentials?: { apiKey: string; expiresAt: number }
      modelCredentialsRetryAt?: number
      appCredentials?: NonNullable<VmSyncResponse['appCredentials']>
    }
  | undefined {
  return typeof value === 'object' && value !== null ? value : undefined
}

function isInvalidVmTokenError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Invalid VM token')
}

/** A string field of a committed registerVm result, whatever shape the deployment returned. */
function committedString(result: unknown, key: string): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const value = (result as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function isVmRegisterResult(result: unknown): result is {
  workspaceId: string
  workspaceSlug: string
  vmToken: string
  vmTokenPrefix?: string
  restore: VmRestoreReference | null
  modelCredentials?: { apiKey: string; expiresAt: number }
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    typeof (result as { vmToken?: unknown }).vmToken === 'string' &&
    typeof (result as { workspaceId?: unknown }).workspaceId === 'string' &&
    typeof (result as { workspaceSlug?: unknown }).workspaceSlug === 'string' &&
    'restore' in result
  )
}

function jsonWithCredentialCachePolicy(
  c: ApiContext,
  body: object,
  hasCredentials: boolean,
): Response {
  if (hasCredentials) c.header('cache-control', 'private, no-store')
  return c.json(body)
}

function restoreDescriptor(reference: VmRestoreReference, refreshUrl: string): VmRestoreDescriptor {
  if (reference.kind === 'birth-seed') return reference
  const { objectPath: _, ...descriptor } = reference
  return { ...descriptor, refreshUrl }
}
