import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReference } from 'convex/server'

import {
  convexUrlsFromDeployment,
  hashApiKey,
  TUNNEL_TOKEN_HEADER,
  type ShareSyncReport,
} from '@repo/contract'

import { ExeClient } from '../src/exe.ts'
import { shellQuote } from '../src/internal.ts'
import { PROBE_TRANSCRIPTS_DIR } from './probe-artifacts.ts'

const SECRET_SHAPES = [
  /\b(Bearer\s+)[^\s,;]+/gi,
  /\b(token=)(?:duet_(?:vm|sk|share)_[A-Za-z0-9_-]+|exe1\.[A-Za-z0-9._-]+)/gi,
] as const
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const FILE_WAIT_MS = 3 * 60_000
const CLEANUP_WAIT_MS = 5 * 60_000
const INVALID_TUNNEL_TOKEN = 'probe-observation-not-a-credential'

interface ProbeConfig {
  apiUrl: string
  convexUrl: string
  internalKey: string
  loginSecret: string
  exeToken: string
  pollMs: number
  timeoutMs: number
}

interface Workspace {
  id: string
  slug: string
  apiToken: string
  vmName: string
  sshDest: string
  httpsUrl: string
  runtimeVersion: string
  syncthingDeviceId: string
  edgeToken: string
}

interface RawWorkspace {
  _id: string
  slug: string
  name: string
  status: string
  vmName?: string
  sshDest?: string
  httpsUrl?: string
  runtimeVersion?: string
  syncthingDeviceId?: string
}

interface RawShare {
  id: string
  state: 'pending' | 'active' | 'revoked' | 'unlinked'
  mountPath?: string
  sync?: {
    sourceToTargetAcceptId: string
    targetToSourceAcceptId: string
  }
}

interface RealizationRow extends ShareSyncReport {
  workspaceId: string
  updatedAt: number
}

interface VmShareState {
  gatewayPid: number
  configHash: string
  mountsHash: string
  mounts: Array<{
    id: string
    shareId: string
    path: string
    mode: 'read' | 'write'
    role: 'origin' | 'recipient'
  }>
  folders: Array<{
    id: string
    path: string
    type: string
    deviceIds: string[]
  }>
  devices: Array<{
    id: string
    addresses: string[]
  }>
  listeningPorts: number[]
}

interface ShareRealization {
  shareId: string
  readyAt: number
  origin: {
    report: RealizationRow
    state: VmShareState
    bridgePort: number
    acceptId: string
  }
  recipient: {
    report: RealizationRow
    state: VmShareState
    bridgePort: number
    acceptId: string
  }
}

interface ProbeResult {
  runId: string
  startedAt: string
  completedAt?: string
  pollMs: number
  workspaces: Array<{ slug: string; vmName: string; runtimeVersion: string }>
  legs: {
    accept?: {
      shareId: string
      generations: {
        origin: string
        recipient: string
      }
      readyMs: number
      byteArrivalMs: number
      roles: ['origin', 'recipient']
    }
    idle?: {
      polls: number
      durationMs: number
      reportsUnchanged: boolean
      processesUnchanged: boolean
      configUnchanged: boolean
      mountsUnchanged: boolean
      bridgePortsUnchanged: boolean
    }
    restart?: {
      oldGatewayPid: number
      newGatewayPid: number
      acceptRebuilt: boolean
      bridgeRebuilt: boolean
      byteArrivalMs: number
    }
    relocation?: {
      shareId: string
      fromPath: string
      toPath: string
      recipientGenerationBefore: string
      recipientGenerationAfter: string
      readyMs: number
      originToRecipientMs: number
      recipientToOriginMs: number
      originFilesSurvived: boolean
      recipientFilesSurvived: boolean
      idleStable: boolean
    }
    revoke?: {
      originPruned: boolean
      recipientPruned: boolean
      filesRemain: boolean
      acceptsPruned: boolean
      bridgesPruned: boolean
    }
    unlink?: {
      shareId: string
      filesRemain: boolean
      replicaBecameLocal: boolean
      originPruned: boolean
      recipientPruned: boolean
    }
    floors?: {
      duetAnchorExcluded: boolean
      gitExcluded: boolean
      recipientWriteRejected: boolean
    }
    containment?: {
      gatewayWriteSucceeded: boolean
      syncthingWriteSucceeded: boolean
    }
  }
  convergeReports: RealizationRow[]
  diagnostics?: {
    readMode?: ReadModeDiagnostics
  }
  cleanup?: {
    workspacesDeleted: string[]
    vmsRemoved: string[]
    edgeKeysRemoved: string[]
    apiKeysRevoked: string[]
    identityRetired: boolean
    errors: string[]
  }
  error?: string
  unproven: string[]
}

interface ReadModeDiagnostics {
  capturedAt: string
  folderId: string
  mount?: Record<string, unknown>
  folder?: Record<string, unknown>
  localChanges?: unknown
  fileInfo?: unknown
  recentEvents?: unknown
  gatewayLogs: unknown[]
  file: {
    exists: boolean
    sha256?: string
    size?: number
  }
}

interface SharePaths {
  origin: string
  recipient: string
}

interface AppRow {
  id: string
  slug: string
  sourceShareId?: string
  sourceAppId?: string
}

interface CreatedWorkspace {
  id?: string
  slug?: string
  name: string
  vmName: string
}

export function redactProbeText(text: string, secrets: readonly string[]): string {
  let redacted = text
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, '<redacted>')
  }
  for (const pattern of SECRET_SHAPES) {
    redacted = redacted.replace(pattern, '$1<redacted>')
  }
  return redacted
}

export function areComplementaryReadyReports(reports: {
  origin?: ShareSyncReport
  recipient?: ShareSyncReport
}): boolean {
  return (
    reports.origin?.state === 'ready' &&
    reports.recipient?.state === 'ready' &&
    reports.origin.shareId === reports.recipient.shareId
  )
}

export function anchorMarkersStayLocal(sourceMarker: string, recipientMarker: string): boolean {
  const prefix = 'duet-anchor:v1:'
  return (
    sourceMarker.startsWith(prefix) &&
    recipientMarker.startsWith(prefix) &&
    sourceMarker !== recipientMarker
  )
}

export function hasRelocatedShareState(
  state: Pick<VmShareState, 'mounts' | 'folders'>,
  folderId: string,
  relativePath: string,
): boolean {
  return (
    state.mounts.some(mount => mount.id === folderId && mount.path === relativePath) &&
    state.folders.some(
      folder => folder.id === folderId && folder.path === `/home/exedev/drive/${relativePath}`,
    )
  )
}

async function runRailShareSyncProbe(config: ProbeConfig = readConfig()): Promise<ProbeResult> {
  const runStarted = Date.now()
  const runId = `staging-e2e-rail-share-${new Date(runStarted)
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`
  const probeEmail = `${runId}-admin@duet.so`
  const convex = new ConvexHttpClient(config.convexUrl, { logger: false })
  const exe = new ExeClient({ token: config.exeToken })
  const result: ProbeResult = {
    runId,
    startedAt: new Date(runStarted).toISOString(),
    pollMs: config.pollMs,
    workspaces: [],
    legs: {},
    convergeReports: [],
    unproven: [
      'The public share realization report does not expose the converger internal changes counter; idle stability is proven by unchanged reports, PIDs, config, mount registry, and bridge ports.',
    ],
  }
  const created: CreatedWorkspace[] = []
  const issuedApiTokens: string[] = []
  const issuedEdgeKeyLabels: string[] = []
  let actorId: string | undefined
  let origin: Workspace | undefined
  let recipient: Workspace | undefined

  try {
    const originName = `${runId} origin`
    created.push({ name: `${originName}'s Workspace`, vmName: '' })
    const bootstrap = await loginAs(config, probeEmail, {
      create: true,
      ephemeral: true,
      name: originName,
    })
    actorId = bootstrap.userId
    issuedApiTokens.push(bootstrap.token)
    const originSeed = await waitForWorkspaceSeedBySlug(config, convex, bootstrap.workspaceSlug)
    Object.assign(created[0]!, { id: originSeed.id, slug: originSeed.slug })

    await mutate(convex, 'testing/workspaces:activateSyntheticSubscriptionByEmailForTest', {
      internalKey: config.internalKey,
      email: probeEmail,
    })

    const suffix = runId.slice(-8)
    const recipientSlug = `rail-recipient-${suffix}`
    const recipientName = `${runId} recipient`
    created.push({ slug: recipientSlug, name: recipientName, vmName: '' })
    const recipientSeed = (await mutate(convex, 'domains/workspaces/birth:createWorkspace', {
      internalKey: config.internalKey,
      actorId,
      slug: recipientSlug,
      name: recipientName,
    })) as { workspaceId: string; slug: string }
    Object.assign(created[1]!, { id: recipientSeed.workspaceId, slug: recipientSeed.slug })

    origin = await waitForLiveWorkspace(
      config,
      convex,
      exe,
      originSeed,
      probeEmail,
      issuedEdgeKeyLabels,
    )
    issuedApiTokens.push(origin.apiToken)
    recipient = await waitForLiveWorkspace(
      config,
      convex,
      exe,
      { id: recipientSeed.workspaceId, slug: recipientSeed.slug },
      probeEmail,
      issuedEdgeKeyLabels,
    )
    issuedApiTokens.push(recipient.apiToken)
    created[0]!.vmName = origin.vmName
    created[1]!.vmName = recipient.vmName
    result.workspaces = [origin, recipient].map(workspace => ({
      slug: workspace.slug,
      vmName: workspace.vmName,
      runtimeVersion: workspace.runtimeVersion,
    }))

    const readPaths = {
      origin: `rail/${suffix}/read`,
      recipient: `shared/${suffix}/read`,
    }
    const initialPayload = `rail-byte-${crypto.randomUUID()}`
    await Promise.all([
      putFile(config, origin, `${readPaths.origin}/payload.txt`, initialPayload),
      writeRemote(origin, `${readPaths.origin}/.git/config`, 'must-not-cross'),
    ])

    const acceptStarted = Date.now()
    const readShare = await createAndAcceptShare({
      config,
      convex,
      actorId,
      probeEmail,
      origin,
      recipient,
      paths: readPaths,
      mode: 'read',
    })
    const realization = await waitForShareRealization({
      config,
      convex,
      origin,
      recipient,
      shareId: readShare.id,
      acceptedAt: acceptStarted,
    })
    result.convergeReports.push(realization.origin.report, realization.recipient.report)
    await waitForFile(config, recipient, `${readPaths.recipient}/payload.txt`, initialPayload)
    const byteArrivalMs = Date.now() - acceptStarted
    assertCondition(
      byteArrivalMs <= 2 * config.pollMs + 15_000,
      `initial byte arrival exceeded the two-poll envelope: ${byteArrivalMs}ms`,
    )
    result.legs.accept = {
      shareId: readShare.id,
      generations: {
        origin: realization.origin.report.generation,
        recipient: realization.recipient.report.generation,
      },
      readyMs: realization.readyAt - acceptStarted,
      byteArrivalMs,
      roles: ['origin', 'recipient'],
    }

    const [sourceMarker, recipientMarker, gitExcluded] = await Promise.all([
      readRemoteFile(origin, `${readPaths.origin}/.duet-anchor`),
      readRemoteFile(recipient, `${readPaths.recipient}/.duet-anchor`),
      waitForRemoteMissing(recipient, `${readPaths.recipient}/.git/config`, 2 * config.pollMs),
    ])
    const anchorExcluded = anchorMarkersStayLocal(sourceMarker, recipientMarker)
    const viewerPayload = `recipient-edit-${crypto.randomUUID()}`
    await putFile(config, recipient, `${readPaths.recipient}/payload.txt`, viewerPayload)
    try {
      await waitForFile(config, recipient, `${readPaths.recipient}/payload.txt`, initialPayload)
    } catch (error) {
      result.diagnostics = {
        readMode: await collectReadModeDiagnostics(
          recipient,
          `share-${readShare.id}`,
          'payload.txt',
          `${readPaths.recipient}/payload.txt`,
        ).catch(diagnosticError => ({
          capturedAt: new Date().toISOString(),
          folderId: `share-${readShare.id}`,
          gatewayLogs: [
            {
              operation: 'diagnostic_capture_failed',
              error: redactProbeText(
                diagnosticError instanceof Error
                  ? diagnosticError.message
                  : String(diagnosticError),
                configSecrets(config),
              ),
            },
          ],
          file: { exists: false },
        })),
      }
      throw error
    }
    const recipientWriteRejected =
      (await getFile(config, origin, `${readPaths.origin}/payload.txt`)) === initialPayload
    assertCondition(recipientWriteRejected, 'read-mode recipient edit replaced the creator version')
    result.legs.floors = {
      duetAnchorExcluded: anchorExcluded,
      gitExcluded,
      recipientWriteRejected,
    }
    assertCondition(anchorExcluded && gitExcluded, 'share floor files crossed to the recipient')

    result.legs.idle = await proveIdleStability({
      config,
      convex,
      origin,
      recipient,
      realization,
    })

    result.legs.restart = await proveRestartHeal({
      config,
      convex,
      origin,
      recipient,
      paths: readPaths,
      realization,
    })

    const relocation = await proveRelocation({
      config,
      convex,
      actorId,
      probeEmail,
      origin,
      recipient,
      suffix,
    })
    result.legs.relocation = relocation.leg
    result.convergeReports.push(...relocation.reports)

    await mutate(convex, 'domains/shares/model:revokeShare', {
      internalKey: config.internalKey,
      actorId,
      shareId: readShare.id,
      fromWorkspaceId: origin.id,
      now: Date.now(),
    })
    result.legs.revoke = await waitForSharePruned({
      config,
      origin,
      recipient,
      paths: readPaths,
      realization,
    })

    const appSlug = `rail-${suffix}`
    const appPath = `apps/${appSlug}`
    const appPayload = `<!doctype html><title>${runId}</title><main>${runId}</main>`
    await putFile(config, origin, `${appPath}/index.html`, appPayload, 'text/html')
    await registerApp(config, origin, appSlug, appPath)
    const unlinkPaths = { origin: appPath, recipient: `shared/${suffix}/app` }
    const unlinkShare = await createAndAcceptShare({
      config,
      convex,
      actorId,
      probeEmail,
      origin,
      recipient,
      paths: unlinkPaths,
      mode: 'read',
    })
    const unlinkRealization = await waitForShareRealization({
      config,
      convex,
      origin,
      recipient,
      shareId: unlinkShare.id,
      acceptedAt: Date.now(),
    })
    result.convergeReports.push(unlinkRealization.origin.report, unlinkRealization.recipient.report)
    await waitForFile(config, recipient, `${unlinkPaths.recipient}/index.html`, appPayload)
    await waitForApp(config, recipient, appSlug, app => app.sourceShareId === unlinkShare.id)

    await mutate(convex, 'domains/shares/model:unlinkShare', {
      internalKey: config.internalKey,
      actorId,
      shareId: unlinkShare.id,
      toWorkspaceId: recipient.id,
      now: Date.now(),
    })
    const unlinkPruned = await waitForSharePruned({
      config,
      origin,
      recipient,
      paths: unlinkPaths,
      realization: unlinkRealization,
    })
    const localApp = await waitForApp(
      config,
      recipient,
      appSlug,
      app => app.sourceShareId === undefined && app.sourceAppId === undefined,
    )
    result.legs.unlink = {
      shareId: unlinkShare.id,
      filesRemain:
        (await getFile(config, recipient, `${unlinkPaths.recipient}/index.html`)) === appPayload,
      replicaBecameLocal:
        localApp.sourceShareId === undefined && localApp.sourceAppId === undefined,
      originPruned: unlinkPruned.originPruned,
      recipientPruned: unlinkPruned.recipientPruned,
    }
    assertCondition(
      result.legs.unlink.filesRemain &&
        result.legs.unlink.replicaBecameLocal &&
        result.legs.unlink.originPruned &&
        result.legs.unlink.recipientPruned,
      'unlink did not detach cleanly',
    )

    result.legs.containment = {
      gatewayWriteSucceeded: true,
      syncthingWriteSucceeded: true,
    }
    result.completedAt = new Date().toISOString()
    return result
  } catch (error) {
    result.error = redactProbeText(
      error instanceof Error ? error.message : String(error),
      configSecrets(config),
    )
    throw error
  } finally {
    result.cleanup = await cleanupResources({
      config,
      convex,
      exe,
      runId,
      probeEmail,
      created,
      issuedApiTokens,
      issuedEdgeKeyLabels,
    })
    await writeArtifact(result)
  }
}

function readConfig(): ProbeConfig {
  if (process.argv.includes('--help')) {
    printHelp()
    process.exit(0)
  }
  const deployment = requiredEnv('CONVEX_DEPLOYMENT')
  const pollSeconds = Number(process.env.DUET_VM_SYNC_INTERVAL_SECONDS ?? '5')
  const timeoutMs = Number(process.env.DUET_SHARE_PROBE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    throw new Error('DUET_VM_SYNC_INTERVAL_SECONDS must be positive')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('DUET_SHARE_PROBE_TIMEOUT_MS must be positive')
  }
  return {
    apiUrl: trimSlash(requiredEnv('DUET_API_URL')),
    convexUrl: convexUrlsFromDeployment(deployment).cloudUrl,
    internalKey: requiredEnv('DUET_API_INTERNAL_KEY'),
    loginSecret: requiredEnv('DUET_PROGRAMMATIC_LOGIN_SECRET'),
    exeToken: requiredEnv('EXE_TOKEN'),
    pollMs: pollSeconds * 1000,
    timeoutMs,
  }
}

function printHelp(): void {
  console.log(`Rail-only two-VM share synchronization probe.

Required environment:
  CONVEX_DEPLOYMENT
  DUET_API_URL
  DUET_API_INTERNAL_KEY
  DUET_PROGRAMMATIC_LOGIN_SECRET
  EXE_TOKEN

The probe creates a temporary staging-E2E identity and two workspaces, creates
and accepts shares through internal-key Convex seams, observes only vm-sync
realization reports plus VM/file state, and deletes its resources. It never
calls a gateway share/sync mutation route and never prints credentials.`)
}

async function waitForWorkspaceSeedBySlug(
  config: ProbeConfig,
  convex: ConvexHttpClient,
  slug: string,
): Promise<{ id: string; slug: string }> {
  const workspace = await waitUntil(
    () =>
      query(convex, 'domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: config.internalKey,
        slug,
      }) as Promise<{ workspaceId: string; workspaceSlug: string } | { refusal: string } | null>,
    // A provisioning workspace resolves to a typed refusal, not null; keep
    // waiting until the resolution is a live connection.
    value => value !== null && !('refusal' in value),
    config.timeoutMs,
    `workspace ${slug} did not register its gateway after login`,
  )
  if (workspace === null || 'refusal' in workspace) {
    throw new Error(`workspace ${slug} disappeared after login`)
  }
  return { id: workspace.workspaceId, slug: workspace.workspaceSlug }
}

async function waitForLiveWorkspace(
  config: ProbeConfig,
  convex: ConvexHttpClient,
  exe: ExeClient,
  seed: { id: string; slug: string },
  probeEmail: string,
  issuedEdgeKeyLabels: string[],
): Promise<Workspace> {
  await waitUntil(
    async () =>
      (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
        internalKey: config.internalKey,
        workspaceId: seed.id,
      })) as RawWorkspace | null,
    workspace =>
      workspace !== null &&
      workspace.status === 'active' &&
      workspace.vmName !== undefined &&
      workspace.sshDest !== undefined &&
      workspace.httpsUrl !== undefined &&
      workspace.runtimeVersion !== undefined &&
      workspace.syncthingDeviceId !== undefined,
    config.timeoutMs,
    `workspace ${seed.slug} did not become active with a registered gateway`,
  )
  const connection = (await query(
    convex,
    'domains/workspaces/provisioning:gatewayConnectionBySlug',
    {
      internalKey: config.internalKey,
      slug: seed.slug,
    },
  )) as { vmToken?: string } | null
  if (connection?.vmToken === undefined) {
    throw new Error(`workspace ${seed.slug} has no gateway connection`)
  }
  const release = await apiJson<{ version: string }>(
    config,
    '/v1/vm/runtime-release/manifest',
    connection.vmToken,
    {},
    200,
  )
  const current = await waitUntil(
    async () =>
      (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
        internalKey: config.internalKey,
        workspaceId: seed.id,
      })) as RawWorkspace | null,
    workspace =>
      workspace !== null &&
      workspace.status === 'active' &&
      workspace.runtimeVersion === release.version &&
      workspace.syncthingDeviceId !== undefined,
    config.timeoutMs,
    `workspace ${seed.slug} did not activate gateway release ${release.version}`,
  )
  if (
    current === null ||
    current.vmName === undefined ||
    current.sshDest === undefined ||
    current.httpsUrl === undefined ||
    current.runtimeVersion === undefined ||
    current.syncthingDeviceId === undefined
  ) {
    throw new Error(`workspace ${seed.slug} lost its registered gateway identity`)
  }
  const edgeKeyLabel = `rail-share-${seed.slug}`
  issuedEdgeKeyLabels.push(edgeKeyLabel)
  const edgeToken = await exe.generateVmApiKey(current.vmName, edgeKeyLabel, '1h')
  const login = await loginAs(config, probeEmail, { workspaceSlug: seed.slug })
  return {
    id: seed.id,
    slug: seed.slug,
    apiToken: login.token,
    vmName: current.vmName,
    sshDest: current.sshDest,
    httpsUrl: current.httpsUrl,
    runtimeVersion: current.runtimeVersion,
    syncthingDeviceId: current.syncthingDeviceId,
    edgeToken,
  }
}

async function createAndAcceptShare(args: {
  config: ProbeConfig
  convex: ConvexHttpClient
  actorId: string
  probeEmail: string
  origin: Workspace
  recipient: Workspace
  paths: SharePaths
  mode: 'read' | 'write'
}): Promise<RawShare> {
  const created = (await mutate(args.convex, 'testing/shares:createShareForTest', {
    internalKey: args.config.internalKey,
    actorId: args.actorId,
    fromWorkspaceId: args.origin.id,
    toEmail: args.probeEmail,
    path: args.paths.origin,
    mode: args.mode,
    now: Date.now(),
  })) as { share: { id: string } }
  await mutate(args.convex, 'domains/shares/model:acceptShare', {
    internalKey: args.config.internalKey,
    actorId: args.actorId,
    shareId: created.share.id,
    toWorkspaceId: args.recipient.id,
    mountPath: args.paths.recipient,
    now: Date.now(),
  })
  return await rawShare(args.config, args.convex, created.share.id)
}

async function waitForShareRealization(args: {
  config: ProbeConfig
  convex: ConvexHttpClient
  origin: Workspace
  recipient: Workspace
  shareId: string
  acceptedAt: number
}): Promise<ShareRealization> {
  const reports = await waitUntil(
    async () => {
      const [originRows, recipientRows] = await Promise.all([
        shareReports(args.config, args.convex, args.origin.id),
        shareReports(args.config, args.convex, args.recipient.id),
      ])
      return {
        origin: originRows.find(row => row.shareId === args.shareId),
        recipient: recipientRows.find(row => row.shareId === args.shareId),
      }
    },
    areComplementaryReadyReports,
    args.config.timeoutMs,
    `share ${args.shareId} did not report complementary ready realizations`,
  )
  const folderId = `share-${args.shareId}`
  const [originState, recipientState, share] = await Promise.all([
    waitForVmShareState(args.origin, folderId, 'origin', args.config.timeoutMs),
    waitForVmShareState(args.recipient, folderId, 'recipient', args.config.timeoutMs),
    rawShare(args.config, args.convex, args.shareId),
  ])
  if (share.sync === undefined) throw new Error(`share ${share.id} has no sync topology`)
  const originBridge = bridgePort(originState, args.recipient.syncthingDeviceId)
  const recipientBridge = bridgePort(recipientState, args.origin.syncthingDeviceId)
  await Promise.all([
    waitForAcceptState(args.origin, share.sync.targetToSourceAcceptId, true, args.config.timeoutMs),
    waitForAcceptState(
      args.recipient,
      share.sync.sourceToTargetAcceptId,
      true,
      args.config.timeoutMs,
    ),
  ])
  return {
    shareId: args.shareId,
    readyAt: Math.max(reports.origin!.updatedAt, reports.recipient!.updatedAt, args.acceptedAt),
    origin: {
      report: reports.origin!,
      state: originState,
      bridgePort: originBridge,
      acceptId: share.sync.targetToSourceAcceptId,
    },
    recipient: {
      report: reports.recipient!,
      state: recipientState,
      bridgePort: recipientBridge,
      acceptId: share.sync.sourceToTargetAcceptId,
    },
  }
}

async function proveIdleStability(args: {
  config: ProbeConfig
  convex: ConvexHttpClient
  origin: Workspace
  recipient: Workspace
  realization: ShareRealization
}): Promise<NonNullable<ProbeResult['legs']['idle']>> {
  const started = Date.now()
  await Bun.sleep(args.config.pollMs * 10 + 1_000)
  const [originState, recipientState, originReports, recipientReports] = await Promise.all([
    readVmShareState(args.origin),
    readVmShareState(args.recipient),
    shareReports(args.config, args.convex, args.origin.id),
    shareReports(args.config, args.convex, args.recipient.id),
  ])
  const originReport = originReports.find(row => row.shareId === args.realization.shareId)
  const recipientReport = recipientReports.find(row => row.shareId === args.realization.shareId)
  const reportsUnchanged =
    originReport?.updatedAt === args.realization.origin.report.updatedAt &&
    recipientReport?.updatedAt === args.realization.recipient.report.updatedAt
  const processesUnchanged =
    originState.gatewayPid === args.realization.origin.state.gatewayPid &&
    recipientState.gatewayPid === args.realization.recipient.state.gatewayPid
  const configUnchanged =
    originState.configHash === args.realization.origin.state.configHash &&
    recipientState.configHash === args.realization.recipient.state.configHash
  const mountsUnchanged =
    originState.mountsHash === args.realization.origin.state.mountsHash &&
    recipientState.mountsHash === args.realization.recipient.state.mountsHash
  const bridgePortsUnchanged =
    originState.listeningPorts.includes(args.realization.origin.bridgePort) &&
    recipientState.listeningPorts.includes(args.realization.recipient.bridgePort) &&
    bridgePort(originState, args.recipient.syncthingDeviceId) ===
      args.realization.origin.bridgePort &&
    bridgePort(recipientState, args.origin.syncthingDeviceId) ===
      args.realization.recipient.bridgePort
  assertCondition(
    reportsUnchanged &&
      processesUnchanged &&
      configUnchanged &&
      mountsUnchanged &&
      bridgePortsUnchanged,
    'unchanged desired share state caused observable convergence churn',
  )
  return {
    polls: 10,
    durationMs: Date.now() - started,
    reportsUnchanged,
    processesUnchanged,
    configUnchanged,
    mountsUnchanged,
    bridgePortsUnchanged,
  }
}

async function proveRestartHeal(args: {
  config: ProbeConfig
  convex: ConvexHttpClient
  origin: Workspace
  recipient: Workspace
  paths: SharePaths
  realization: ShareRealization
}): Promise<NonNullable<ProbeResult['legs']['restart']>> {
  const oldGatewayPid = args.realization.recipient.state.gatewayPid
  await remote(
    args.recipient,
    'sudo systemctl kill --kill-who=main --signal=KILL duet-gateway.service',
  )
  const newState = await waitUntil(
    () => readVmShareState(args.recipient),
    state =>
      state.gatewayPid > 0 &&
      state.gatewayPid !== oldGatewayPid &&
      state.listeningPorts.some(port => port > 0),
    args.config.timeoutMs,
    'recipient gateway did not restart',
  )
  await waitForAcceptState(
    args.recipient,
    args.realization.recipient.acceptId,
    true,
    args.config.timeoutMs,
  )
  const healed = await waitUntil(
    () => readVmShareState(args.recipient),
    state => {
      const port = bridgePortOrNull(state, args.origin.syncthingDeviceId)
      return port !== null && state.listeningPorts.includes(port)
    },
    args.config.timeoutMs,
    'recipient bridge was not rebuilt from the next rail snapshot',
  )
  const payload = `restart-byte-${crypto.randomUUID()}`
  await putFile(args.config, args.origin, `${args.paths.origin}/restart.txt`, payload)
  const started = Date.now()
  await waitForFile(args.config, args.recipient, `${args.paths.recipient}/restart.txt`, payload)
  const byteArrivalMs = Date.now() - started
  assertCondition(
    byteArrivalMs <= 2 * args.config.pollMs + 15_000,
    `post-restart byte arrival exceeded the two-poll envelope: ${byteArrivalMs}ms`,
  )
  const report = (await shareReports(args.config, args.convex, args.recipient.id)).find(
    row => row.shareId === args.realization.shareId,
  )
  assertCondition(report?.state === 'ready', 'recipient did not remain ready after gateway restart')
  return {
    oldGatewayPid,
    newGatewayPid: newState.gatewayPid,
    acceptRebuilt: true,
    bridgeRebuilt: bridgePort(healed, args.origin.syncthingDeviceId) > 0,
    byteArrivalMs,
  }
}

async function proveRelocation(args: {
  config: ProbeConfig
  convex: ConvexHttpClient
  actorId: string
  probeEmail: string
  origin: Workspace
  recipient: Workspace
  suffix: string
}): Promise<{
  leg: NonNullable<ProbeResult['legs']['relocation']>
  reports: RealizationRow[]
}> {
  const paths = {
    origin: `rail/${args.suffix}/relocate`,
    recipient: `shared/${args.suffix}/relocate`,
  }
  const relocatedPath = `shared/${args.suffix}/relocated`
  const initialPayload = `relocation-baseline-${crypto.randomUUID()}`
  await putFile(args.config, args.origin, `${paths.origin}/payload.txt`, initialPayload)
  const share = await createAndAcceptShare({
    config: args.config,
    convex: args.convex,
    actorId: args.actorId,
    probeEmail: args.probeEmail,
    origin: args.origin,
    recipient: args.recipient,
    paths,
    mode: 'write',
  })
  const realization = await waitForShareRealization({
    config: args.config,
    convex: args.convex,
    origin: args.origin,
    recipient: args.recipient,
    shareId: share.id,
    acceptedAt: Date.now(),
  })
  await waitForFile(args.config, args.recipient, `${paths.recipient}/payload.txt`, initialPayload)

  const oldAbsolutePath = `/home/exedev/drive/${paths.recipient}`
  const newAbsolutePath = `/home/exedev/drive/${relocatedPath}`
  await remote(
    args.recipient,
    `mkdir -p ${shellQuote(dirname(newAbsolutePath))} && mv -- ${shellQuote(
      oldAbsolutePath,
    )} ${shellQuote(newAbsolutePath)}`,
  )
  // Give Syncthing one observation window with the old path absent. Its missing
  // root must halt rather than deleting origin bytes, and the converger must not
  // recreate that old root while metadata still points there.
  await Bun.sleep(args.config.pollMs + 1_000)
  assertCondition(
    !(await remotePathExists(args.recipient, paths.recipient)),
    'converger recreated the old share root before relocation metadata arrived',
  )
  assertCondition(
    (await getFile(args.config, args.origin, `${paths.origin}/payload.txt`)) === initialPayload,
    'origin bytes disappeared while the recipient mount path was absent',
  )

  const relocationStarted = Date.now()
  await mutate(args.convex, 'testing/shares:patchShareMountPathForTest', {
    internalKey: args.config.internalKey,
    shareId: share.id,
    mountPath: relocatedPath,
  })
  const folderId = `share-${share.id}`
  const relocated = await waitUntil(
    async () => {
      const [state, reports, currentShare] = await Promise.all([
        readVmShareState(args.recipient),
        shareReports(args.config, args.convex, args.recipient.id),
        rawShare(args.config, args.convex, share.id),
      ])
      return {
        state,
        report: reports.find(row => row.shareId === share.id),
        share: currentShare,
      }
    },
    value =>
      value.share.mountPath === relocatedPath &&
      value.report?.state === 'ready' &&
      value.report.generation !== realization.recipient.report.generation &&
      hasRelocatedShareState(value.state, folderId, relocatedPath),
    args.config.timeoutMs,
    `share ${share.id} did not relocate through the rail`,
  )
  if (relocated.report === undefined) throw new Error(`share ${share.id} lost its realization`)

  const originToRecipientPayload = `origin-after-relocate-${crypto.randomUUID()}`
  const originToRecipientStarted = Date.now()
  await putFile(
    args.config,
    args.origin,
    `${paths.origin}/origin-after.txt`,
    originToRecipientPayload,
  )
  await waitForFile(
    args.config,
    args.recipient,
    `${relocatedPath}/origin-after.txt`,
    originToRecipientPayload,
  )
  const originToRecipientMs = Date.now() - originToRecipientStarted

  const recipientToOriginPayload = `recipient-after-relocate-${crypto.randomUUID()}`
  const recipientToOriginStarted = Date.now()
  await putFile(
    args.config,
    args.recipient,
    `${relocatedPath}/recipient-after.txt`,
    recipientToOriginPayload,
  )
  await waitForFile(
    args.config,
    args.origin,
    `${paths.origin}/recipient-after.txt`,
    recipientToOriginPayload,
  )
  const recipientToOriginMs = Date.now() - recipientToOriginStarted

  const [originFilesSurvived, recipientFilesSurvived] = await Promise.all([
    getFile(args.config, args.origin, `${paths.origin}/payload.txt`).then(
      body => body === initialPayload,
    ),
    getFile(args.config, args.recipient, `${relocatedPath}/payload.txt`).then(
      body => body === initialPayload,
    ),
  ])
  assertCondition(
    originFilesSurvived && recipientFilesSurvived,
    'relocation did not preserve the baseline bytes on both sides',
  )

  const idleState = await readVmShareState(args.recipient)
  const idleReport = relocated.report
  await Bun.sleep(args.config.pollMs * 3 + 1_000)
  const [afterIdleState, afterIdleReports] = await Promise.all([
    readVmShareState(args.recipient),
    shareReports(args.config, args.convex, args.recipient.id),
  ])
  const afterIdleReport = afterIdleReports.find(row => row.shareId === share.id)
  const idleStable =
    afterIdleState.configHash === idleState.configHash &&
    afterIdleState.mountsHash === idleState.mountsHash &&
    afterIdleReport?.updatedAt === idleReport.updatedAt
  assertCondition(idleStable, 'relocated share churned after reaching ready')

  await mutate(args.convex, 'domains/shares/model:unlinkShare', {
    internalKey: args.config.internalKey,
    actorId: args.actorId,
    shareId: share.id,
    toWorkspaceId: args.recipient.id,
    now: Date.now(),
  })
  await waitForSharePruned({
    config: args.config,
    origin: args.origin,
    recipient: args.recipient,
    paths: { origin: paths.origin, recipient: relocatedPath },
    realization,
    peerDeviceState: 'present',
  })

  return {
    leg: {
      shareId: share.id,
      fromPath: paths.recipient,
      toPath: relocatedPath,
      recipientGenerationBefore: realization.recipient.report.generation,
      recipientGenerationAfter: relocated.report.generation,
      readyMs: relocated.report.updatedAt - relocationStarted,
      originToRecipientMs,
      recipientToOriginMs,
      originFilesSurvived,
      recipientFilesSurvived,
      idleStable,
    },
    reports: [realization.origin.report, realization.recipient.report, relocated.report],
  }
}

async function waitForSharePruned(args: {
  config: ProbeConfig
  origin: Workspace
  recipient: Workspace
  paths: SharePaths
  realization: ShareRealization
  peerDeviceState?: 'absent' | 'present'
}): Promise<NonNullable<ProbeResult['legs']['revoke']>> {
  const folderId = `share-${args.realization.shareId}`
  const peerDeviceState = args.peerDeviceState ?? 'absent'
  const [originState, recipientState] = await Promise.all([
    waitUntil(
      () => readVmShareState(args.origin),
      state =>
        hasPrunedShareState(state, folderId, args.recipient.syncthingDeviceId, peerDeviceState),
      args.config.timeoutMs,
      `origin did not prune ${folderId}`,
    ),
    waitUntil(
      () => readVmShareState(args.recipient),
      state => hasPrunedShareState(state, folderId, args.origin.syncthingDeviceId, peerDeviceState),
      args.config.timeoutMs,
      `recipient did not prune ${folderId}`,
    ),
  ])
  await Promise.all([
    waitForAcceptState(args.origin, args.realization.origin.acceptId, false, args.config.timeoutMs),
    waitForAcceptState(
      args.recipient,
      args.realization.recipient.acceptId,
      false,
      args.config.timeoutMs,
    ),
  ])
  const filesRemain =
    (await fileStatus(args.config, args.recipient, `${args.paths.recipient}/payload.txt`)) ===
      200 ||
    (await fileStatus(args.config, args.recipient, `${args.paths.recipient}/index.html`)) === 200
  const bridgesPruned =
    !originState.listeningPorts.includes(args.realization.origin.bridgePort) &&
    !recipientState.listeningPorts.includes(args.realization.recipient.bridgePort)
  const value = {
    originPruned: true,
    recipientPruned: true,
    filesRemain,
    acceptsPruned: true,
    bridgesPruned,
  }
  assertCondition(
    value.originPruned &&
      value.recipientPruned &&
      value.filesRemain &&
      value.acceptsPruned &&
      value.bridgesPruned,
    'share teardown left live synchronization state',
  )
  return value
}

export function hasPrunedShareState(
  state: {
    folders: Array<{ id: string }>
    mounts: Array<{ id: string }>
    devices: Array<{ id: string }>
  },
  folderId: string,
  peerDeviceId: string,
  peerDeviceState: 'absent' | 'present',
): boolean {
  const peerDeviceExists = state.devices.some(device => device.id === peerDeviceId)
  return (
    !state.folders.some(folder => folder.id === folderId) &&
    !state.mounts.some(mount => mount.id === folderId) &&
    peerDeviceExists === (peerDeviceState === 'present')
  )
}

async function readVmShareState(workspace: Workspace): Promise<VmShareState> {
  const output = await remote(
    workspace,
    `python3 - <<'PY'
import hashlib, json, os, subprocess, xml.etree.ElementTree as ET
config_path = '/home/exedev/.duet/syncthing/config.xml'
mounts_path = '/home/exedev/.duet/sync-mounts.json'
config_bytes = open(config_path, 'rb').read()
mounts_bytes = open(mounts_path, 'rb').read() if os.path.exists(mounts_path) else b'[]'
root = ET.fromstring(config_bytes)
folders = []
for folder in root.findall('folder'):
    folders.append({
        'id': folder.attrib.get('id', ''),
        'path': folder.attrib.get('path', ''),
        'type': folder.attrib.get('type', ''),
        'deviceIds': [device.attrib.get('id', '') for device in folder.findall('device')],
    })
devices = []
for device in root.findall('device'):
    devices.append({
        'id': device.attrib.get('id', ''),
        'addresses': [address.text or '' for address in device.findall('address')],
    })
mounts = json.loads(mounts_bytes)
pid = int(subprocess.check_output(
    ['systemctl', 'show', '--property=MainPID', '--value', 'duet-gateway.service'],
    text=True,
).strip() or '0')
ports = []
for line in subprocess.run(['ss', '-H', '-ltn'], text=True, capture_output=True, check=True).stdout.splitlines():
    endpoint = line.split()[3]
    try:
        ports.append(int(endpoint.rsplit(':', 1)[1]))
    except (IndexError, ValueError):
        pass
print(json.dumps({
    'gatewayPid': pid,
    'configHash': hashlib.sha256(config_bytes).hexdigest(),
    'mountsHash': hashlib.sha256(mounts_bytes).hexdigest(),
    'mounts': mounts,
    'folders': folders,
    'devices': devices,
    'listeningPorts': sorted(set(ports)),
}, sort_keys=True))
PY`,
  )
  return JSON.parse(output) as VmShareState
}

async function collectReadModeDiagnostics(
  workspace: Workspace,
  folderId: string,
  filename: string,
  drivePath: string,
): Promise<ReadModeDiagnostics> {
  const output = await remote(
    workspace,
    `python3 - ${shellQuote(folderId)} ${shellQuote(filename)} ${shellQuote(
      `/home/exedev/drive/${drivePath}`,
    )} <<'PY'
import hashlib, json, os, sys, urllib.parse, urllib.request, xml.etree.ElementTree as ET

folder_id, filename, file_path = sys.argv[1:]
config_path = '/home/exedev/.duet/syncthing/config.xml'
mounts_path = '/home/exedev/.duet/sync-mounts.json'
log_path = '/home/exedev/.duet/logs/gateway.log'
root = ET.parse(config_path).getroot()
api_key = root.findtext('./gui/apikey') or ''
address = root.findtext('./gui/address') or '127.0.0.1:8384'
if address.startswith('0.0.0.0:'):
    address = '127.0.0.1:' + address.rsplit(':', 1)[1]
base = 'http://' + address

def api(path, params=None):
    query = '' if params is None else '?' + urllib.parse.urlencode(params)
    request = urllib.request.Request(base + path + query, headers={'X-API-Key': api_key})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())
    except Exception as error:
        return {'diagnosticError': str(error)}

mounts = json.load(open(mounts_path)) if os.path.exists(mounts_path) else []
mount = next((item for item in mounts if item.get('id') == folder_id), None)
folder = next(
    (
        {
            'id': item.attrib.get('id'),
            'path': item.attrib.get('path'),
            'type': item.attrib.get('type'),
            'fsWatcherEnabled': item.attrib.get('fsWatcherEnabled'),
            'rescanIntervalS': item.attrib.get('rescanIntervalS'),
        }
        for item in root.findall('folder')
        if item.attrib.get('id') == folder_id
    ),
    None,
)
logs = []
if os.path.exists(log_path):
    for line in open(log_path, errors='replace'):
        try:
            row = json.loads(line)
        except Exception:
            continue
        if row.get('label') in ('read-mode-enforcer', 'syncthing-events', 'scan-nudge'):
            logs.append(row)

file_state = {'exists': os.path.exists(file_path)}
if file_state['exists'] and os.path.isfile(file_path):
    contents = open(file_path, 'rb').read()
    file_state.update({'sha256': hashlib.sha256(contents).hexdigest(), 'size': len(contents)})

print(json.dumps({
    'capturedAt': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
    'folderId': folder_id,
    'mount': mount,
    'folder': folder,
    'localChanges': api('/rest/db/localchanged', {'folder': folder_id}),
    'fileInfo': api('/rest/db/file', {'folder': folder_id, 'file': filename}),
    'recentEvents': api('/rest/events', {
        'events': 'LocalIndexUpdated',
        'limit': '20',
        'timeout': '1',
    }),
    'gatewayLogs': logs[-100:],
    'file': file_state,
}, sort_keys=True))
PY`,
  )
  return JSON.parse(output) as ReadModeDiagnostics
}

async function waitForVmShareState(
  workspace: Workspace,
  folderId: string,
  role: 'origin' | 'recipient',
  timeoutMs: number,
): Promise<VmShareState> {
  return await waitUntil(
    () => readVmShareState(workspace),
    state =>
      state.gatewayPid > 0 &&
      state.folders.some(folder => folder.id === folderId) &&
      state.mounts.some(mount => mount.id === folderId && mount.role === role),
    timeoutMs,
    `${workspace.slug} did not realize ${role} folder ${folderId}`,
  )
}

function bridgePort(state: VmShareState, peerDeviceId: string): number {
  const port = bridgePortOrNull(state, peerDeviceId)
  if (port === null) throw new Error(`missing bridge address for peer ${peerDeviceId}`)
  return port
}

function bridgePortOrNull(state: VmShareState, peerDeviceId: string): number | null {
  const addresses = state.devices.find(device => device.id === peerDeviceId)?.addresses ?? []
  for (const address of addresses) {
    const match = address.match(/^tcp:\/\/127\.0\.0\.1:(\d+)$/)
    if (match !== null) return Number(match[1])
  }
  return null
}

async function waitForAcceptState(
  workspace: Workspace,
  acceptId: string,
  exists: boolean,
  timeoutMs: number,
): Promise<void> {
  await waitUntil(
    async () => {
      const path = `/v1/tunnel/accept/${encodeURIComponent(acceptId)}`
      const response = await fetch(`${gatewayBase(workspace)}${path}`, {
        headers: {
          'x-exedev-authorization': `Bearer ${workspace.edgeToken}`,
          [TUNNEL_TOKEN_HEADER]: INVALID_TUNNEL_TOKEN,
        },
      }).catch(() => null)
      return response?.status ?? 0
    },
    status => (exists ? status === 401 : status === 404),
    timeoutMs,
    `tunnel accept ${acceptId} did not become ${exists ? 'active' : 'absent'}`,
  )
}

async function shareReports(
  config: ProbeConfig,
  convex: ConvexHttpClient,
  workspaceId: string,
): Promise<RealizationRow[]> {
  return (await query(convex, 'testing/workspaces:rawShareSyncReportsForTest', {
    internalKey: config.internalKey,
    workspaceId,
  })) as RealizationRow[]
}

async function rawShare(
  config: ProbeConfig,
  convex: ConvexHttpClient,
  shareId: string,
): Promise<RawShare> {
  const rows = (await query(convex, 'testing/shares:rawSharesForTest', {
    internalKey: config.internalKey,
  })) as RawShare[]
  const share = rows.find(row => row.id === shareId)
  if (share === undefined) throw new Error(`share ${shareId} disappeared`)
  return share
}

async function registerApp(
  config: ProbeConfig,
  workspace: Workspace,
  slug: string,
  path: string,
): Promise<void> {
  await apiJson(
    config,
    `/v1/ws/${workspace.slug}/apps`,
    workspace.apiToken,
    {
      method: 'POST',
      body: JSON.stringify({
        path,
        command: 'python3 -m http.server 4173',
        apiScopes: [],
        port: 4173,
        slug,
      }),
    },
    201,
  )
}

async function waitForApp(
  config: ProbeConfig,
  workspace: Workspace,
  slug: string,
  predicate: (app: AppRow) => boolean,
): Promise<AppRow> {
  const app = await waitUntil(
    async () => {
      const body = await apiJson<{ apps: AppRow[] }>(
        config,
        `/v1/ws/${workspace.slug}/apps`,
        workspace.apiToken,
        {},
        200,
      )
      return body.apps.find(app => app.slug === slug)
    },
    app => app !== undefined && predicate(app),
    config.timeoutMs,
    `app ${slug} did not reach the expected replication state`,
  )
  if (app === undefined) throw new Error(`app ${slug} disappeared`)
  return app
}

async function putFile(
  config: ProbeConfig,
  workspace: Workspace,
  path: string,
  contents: string,
  contentType = 'text/plain',
): Promise<void> {
  const response = await fetch(fileUrl(config, workspace, path), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${workspace.apiToken}`,
      'content-type': contentType,
    },
    body: contents,
  })
  if (response.status !== 200) {
    throw new Error(`PUT file ${path} failed with HTTP ${response.status}`)
  }
}

async function getFile(config: ProbeConfig, workspace: Workspace, path: string): Promise<string> {
  const response = await fetch(fileUrl(config, workspace, path), {
    headers: { authorization: `Bearer ${workspace.apiToken}` },
  })
  if (response.status !== 200) {
    throw new Error(`GET file ${path} failed with HTTP ${response.status}`)
  }
  return await response.text()
}

async function fileStatus(
  config: ProbeConfig,
  workspace: Workspace,
  path: string,
): Promise<number> {
  const response = await fetch(fileUrl(config, workspace, path), {
    headers: { authorization: `Bearer ${workspace.apiToken}` },
  })
  return response.status
}

async function waitForFile(
  config: ProbeConfig,
  workspace: Workspace,
  path: string,
  expected: string,
): Promise<void> {
  await waitUntil(
    async () => {
      const response = await fetch(fileUrl(config, workspace, path), {
        headers: { authorization: `Bearer ${workspace.apiToken}` },
      }).catch(() => null)
      return response?.status === 200 ? await response.text() : null
    },
    body => body === expected,
    FILE_WAIT_MS,
    `${path} did not arrive in ${workspace.slug}`,
  )
}

async function waitForRemoteMissing(
  workspace: Workspace,
  path: string,
  durationMs: number,
): Promise<boolean> {
  const deadline = Date.now() + durationMs
  do {
    if (await remotePathExists(workspace, path)) return false
    await Bun.sleep(Math.min(1_000, durationMs))
  } while (Date.now() < deadline)
  return true
}

function fileUrl(config: ProbeConfig, workspace: Workspace, path: string): string {
  return `${config.apiUrl}/v1/ws/${workspace.slug}/files/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

async function writeRemote(workspace: Workspace, path: string, contents: string): Promise<void> {
  const absolutePath = `/home/exedev/drive/${path}`
  const encoded = Buffer.from(contents).toString('base64')
  await remote(
    workspace,
    `mkdir -p ${shellQuote(dirname(absolutePath))} && printf %s ${shellQuote(
      encoded,
    )} | base64 -d > ${shellQuote(absolutePath)}`,
  )
}

async function readRemoteFile(workspace: Workspace, path: string): Promise<string> {
  return await remote(workspace, `cat -- ${shellQuote(`/home/exedev/drive/${path}`)}`)
}

async function remotePathExists(workspace: Workspace, path: string): Promise<boolean> {
  const absolutePath = `/home/exedev/drive/${path}`
  const client = new ExeClient()
  const result = await client.exec(workspace.sshDest, `test -e ${shellQuote(absolutePath)}`, 10_000)
  return result.exitCode === 0
}

async function remote(workspace: Workspace, command: string): Promise<string> {
  const client = new ExeClient()
  const result = await client.exec(workspace.sshDest, command, 60_000)
  if (result.exitCode !== 0) {
    throw new Error(
      `remote command failed on ${workspace.slug} with exit ${result.exitCode}: ${
        result.stderr || result.stdout
      }`,
    )
  }
  return result.stdout.trim()
}

async function loginAs(
  config: ProbeConfig,
  email: string,
  options: { workspaceSlug?: string; create?: boolean; name?: string; ephemeral?: true | number },
): Promise<{ token: string; userId: string; workspaceSlug: string }> {
  const response = await fetch(`${config.apiUrl}/v1/admin/login-as`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.loginSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email,
      ...options,
      ttlSeconds: 2 * 60 * 60,
    }),
  })
  if (response.status !== 200) {
    throw new Error(
      `programmatic login${
        options.workspaceSlug === undefined ? '' : ` for ${options.workspaceSlug}`
      } failed with HTTP ${response.status}`,
    )
  }
  return (await response.json()) as { token: string; userId: string; workspaceSlug: string }
}

async function apiJson<T>(
  config: ProbeConfig,
  path: string,
  token: string,
  init: RequestInit,
  expectedStatus: number,
): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })
  if (response.status !== expectedStatus) {
    const body = await response.text()
    throw new Error(
      `${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
    )
  }
  return (await response.json()) as T
}

async function cleanupResources(args: {
  config: ProbeConfig
  convex: ConvexHttpClient
  exe: ExeClient
  runId: string
  probeEmail: string
  created: CreatedWorkspace[]
  issuedApiTokens: string[]
  issuedEdgeKeyLabels: string[]
}): Promise<NonNullable<ProbeResult['cleanup']>> {
  const workspacesDeleted: string[] = []
  const vmsRemoved: string[] = []
  const edgeKeysRemoved: string[] = []
  const apiKeysRevoked: string[] = []
  const errors: string[] = []
  let identityRetired = false
  const discovered: CreatedWorkspace[] = []
  try {
    const resources = (await withCleanupRetries(() =>
      query(args.convex, 'testing/stagingE2e:orphanedResourcesByRunIdForTest', {
        internalKey: args.config.internalKey,
        runId: args.runId,
        emails: [args.probeEmail],
        workspaceNames: args.created.map(workspace => workspace.name),
      }),
    )) as { workspaces: Array<{ id: string; label: string }> }
    for (const resource of resources.workspaces) {
      const workspace = (await withCleanupRetries(() =>
        query(args.convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
          internalKey: args.config.internalKey,
          workspaceId: resource.id,
        }),
      )) as RawWorkspace | null
      if (workspace !== null) {
        discovered.push({
          id: workspace._id,
          slug: workspace.slug,
          name: workspace.name,
          vmName: workspace.vmName ?? '',
        })
      }
    }
  } catch (error) {
    errors.push(
      `workspace discovery: ${redactProbeText(
        error instanceof Error ? error.message : String(error),
        configSecrets(args.config),
      )}`,
    )
  }
  const cleanupTargets = [...args.created]
  for (const workspace of discovered) {
    const tracked = cleanupTargets.find(
      candidate =>
        candidate.id === workspace.id ||
        candidate.slug === workspace.slug ||
        candidate.name === workspace.name,
    )
    if (tracked === undefined) {
      cleanupTargets.push(workspace)
    } else {
      Object.assign(tracked, workspace)
    }
  }

  for (const workspace of cleanupTargets.reverse()) {
    try {
      const resolved =
        workspace.id === undefined
          ? discovered.find(row => row.slug === workspace.slug || row.name === workspace.name)
          : discovered.find(row => row.id === workspace.id)
      const workspaceId = workspace.id ?? resolved?.id
      if (workspaceId === undefined) continue
      const deleted = await deleteWorkspaceWithRetry(
        args.config,
        args.convex,
        workspaceId,
        resolved,
      )
      const label = workspace.slug ?? resolved?.slug ?? workspace.name
      workspacesDeleted.push(label)
      const vmName = deleted.vmName ?? workspace.vmName
      if (vmName.length === 0) continue
      await waitUntil(
        async () => !(await args.exe.list()).some(vm => vm.vm_name === vmName),
        value => value,
        CLEANUP_WAIT_MS,
        `VM ${vmName} was not removed by workspace cleanup`,
      ).catch(async () => {
        await args.exe.remove(vmName)
      })
      if ((await args.exe.list()).some(vm => vm.vm_name === vmName)) {
        throw new Error(`VM ${vmName} remains after fallback removal`)
      }
      vmsRemoved.push(vmName)
    } catch (error) {
      errors.push(
        `${workspace.slug ?? workspace.name}: ${redactProbeText(
          error instanceof Error ? error.message : String(error),
          configSecrets(args.config),
        )}`,
      )
    }
  }
  for (const label of args.issuedEdgeKeyLabels) {
    try {
      await args.exe.removeSshKey(label)
      edgeKeysRemoved.push(label)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/not found|does not exist|unknown key/i.test(message)) {
        errors.push(`edge-key ${label}: ${redactProbeText(message, configSecrets(args.config))}`)
      }
    }
  }
  for (const token of args.issuedApiTokens) {
    const prefix = token.slice(0, 'duet_sk_'.length + 8)
    try {
      await mutate(args.convex, 'testing/stagingE2e:revokeApiKeyByHashForTest', {
        internalKey: args.config.internalKey,
        hashedKey: await hashApiKey(token),
        expectedPrefix: prefix,
        expectedOwnerEmail: args.probeEmail,
        now: Date.now(),
      })
      apiKeysRevoked.push(prefix)
    } catch (error) {
      errors.push(
        `api-key ${prefix}: ${redactProbeText(
          error instanceof Error ? error.message : String(error),
          [...configSecrets(args.config), token],
        )}`,
      )
    }
  }
  try {
    await mutate(args.convex, 'testing/stagingE2e:retireUserByEmailForTest', {
      internalKey: args.config.internalKey,
      email: args.probeEmail,
      now: Date.now(),
    })
    identityRetired = true
  } catch (error) {
    errors.push(
      `identity: ${redactProbeText(
        error instanceof Error ? error.message : String(error),
        configSecrets(args.config),
      )}`,
    )
  }
  return {
    workspacesDeleted,
    vmsRemoved,
    edgeKeysRemoved,
    apiKeysRevoked,
    identityRetired,
    errors,
  }
}

async function deleteWorkspaceWithRetry(
  config: ProbeConfig,
  convex: ConvexHttpClient,
  workspaceId: string,
  initial: { vmName?: string } | undefined,
): Promise<{ vmName?: string }> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
      internalKey: config.internalKey,
      workspaceId,
    })) as RawWorkspace | null
    if (current?.status === 'deleted') return { vmName: current.vmName ?? initial?.vmName }
    try {
      return (await mutate(convex, 'testing/workspaces:deleteWorkspaceByIdForTest', {
        internalKey: config.internalKey,
        workspaceId,
        now: Date.now(),
      })) as { vmName?: string }
    } catch (error) {
      lastError = error
      if (attempt < 3) await Bun.sleep(attempt * 1_000)
    }
  }
  const current = (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
    internalKey: config.internalKey,
    workspaceId,
  })) as RawWorkspace | null
  if (current?.status === 'deleted') return { vmName: current.vmName ?? initial?.vmName }
  throw lastError instanceof Error ? lastError : new Error(`workspace ${workspaceId} delete failed`)
}

async function withCleanupRetries<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      lastError = error
      if (attempt < 3) await Bun.sleep(attempt * 1_000)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('cleanup query failed')
}

async function writeArtifact(result: ProbeResult): Promise<void> {
  await mkdir(fileURLToPath(PROBE_TRANSCRIPTS_DIR), { recursive: true })
  const path = fileURLToPath(new URL(`${result.runId}.json`, PROBE_TRANSCRIPTS_DIR))
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
}

async function waitUntil<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T
  for (;;) {
    last = await read()
    if (predicate(last)) return last
    if (Date.now() >= deadline) {
      throw new Error(`${timeoutMessage}; last=${safeSummary(last)}`)
    }
    await Bun.sleep(1_000)
  }
}

function query(
  client: ConvexHttpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return client.query(ref<'query'>(name), args)
}

function mutate(
  client: ConvexHttpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return client.mutation(ref<'mutation'>(name), args)
}

function ref<Kind extends 'query' | 'mutation'>(
  name: string,
): FunctionReference<Kind, 'public', Record<string, unknown>, unknown> {
  return makeFunctionReference<Kind>(name)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required environment variable ${name}`)
  }
  return value
}

function assertCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function gatewayBase(workspace: Workspace): string {
  const url = new URL(workspace.httpsUrl)
  url.port = '3000'
  return url.toString().replace(/\/+$/, '')
}

function safeSummary(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)
}

function configSecrets(config: ProbeConfig): string[] {
  return [config.internalKey, config.loginSecret, config.exeToken]
}

async function main(): Promise<void> {
  let config: ProbeConfig | undefined
  try {
    config = readConfig()
    const result = await runRailShareSyncProbe(config)
    if ((result.cleanup?.errors.length ?? 0) > 0) {
      throw new Error(`probe cleanup failed: ${result.cleanup!.errors.join('; ')}`)
    }
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(redactProbeText(message, config === undefined ? [] : configSecrets(config)))
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
