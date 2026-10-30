import { z } from 'zod'

import { GatewayAgentRosterSchema } from '../agents/index'
import {
  MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE,
  AnchorSchema,
  DriveRelativePathSchema,
  MAX_ANCHOR_MARKER_NONCE_UTF8_BYTES,
  type GatewayAnchor,
} from '../anchors/index'
import {
  AppReconciliationErrorSchema,
  GatewayAppConfigSchema,
  MAX_APPS_PER_WORKSPACE,
} from '../apps/index'
import { ConnectedProviderIdSchema } from '../connected-providers/index'
import {
  MAX_MARKETPLACE_AGENT_PULL_REPORTS_PER_WORKSPACE,
  MarketplaceAgentPullReportSchema,
  VmDesiredMarketplaceAgentsSchema,
} from '../marketplace/index'
import { MAX_SYNC_MACHINES_PER_USER, SyncthingDeviceIdSchema } from '../mirror/index'
import { AppApiScopesSchema } from '../scopes/index'
import {
  MAX_ACTIVE_SHARES_PER_WORKSPACE,
  ShareSyncErrorCodeSchema,
  ShareSyncGenerationSchema,
} from '../shares/index'
import { WorkspaceSlugSchema } from '../slug/index'
import {
  GatewayTrainJobReportBatchSchema,
  MAX_TRAIN_IDENTIFIER_UTF8_BYTES,
  MAX_TRAIN_REPORTS_PER_SYNC,
} from '../train/index'
import { utf8BoundedString } from '../utf8/index'
import { WORKSPACE_MEMBER_LIMIT } from '../workspaces/limits'

export * from './uploads'

export const MAX_VM_PROVIDER_NAME_UTF8_BYTES = 256
export const MAX_VM_PROVIDER_SSH_DEST_UTF8_BYTES = 2_048
export const MAX_VM_PROVIDER_HTTPS_URL_UTF8_BYTES = 2_048
export const MAX_VM_VERSION_METADATA_UTF8_BYTES = 512
export const MAX_VM_RESPONSE_CREDENTIAL_UTF8_BYTES = 4 * 1024
export const MAX_VM_RESPONSE_ID_UTF8_BYTES = MAX_TRAIN_IDENTIFIER_UTF8_BYTES
export const MAX_VM_RESPONSE_URL_UTF8_BYTES = 8 * 1024
export const VmResponseCredentialSchema = utf8BoundedString(
  MAX_VM_RESPONSE_CREDENTIAL_UTF8_BYTES,
  'VM response credential',
).min(1)
export const VmResponseIdSchema = utf8BoundedString(
  MAX_VM_RESPONSE_ID_UTF8_BYTES,
  'VM response identifier',
).min(1)
export const VmResponseUrlSchema = z
  .url()
  .pipe(utf8BoundedString(MAX_VM_RESPONSE_URL_UTF8_BYTES, 'VM response URL'))
export const VmProviderNameSchema = utf8BoundedString(
  MAX_VM_PROVIDER_NAME_UTF8_BYTES,
  'Provider VM name',
).min(1)
export const VmProviderSshDestSchema = utf8BoundedString(
  MAX_VM_PROVIDER_SSH_DEST_UTF8_BYTES,
  'Provider SSH destination',
).min(1)
export const VmProviderHttpsUrlSchema = z
  .url()
  .pipe(utf8BoundedString(MAX_VM_PROVIDER_HTTPS_URL_UTF8_BYTES, 'Provider HTTPS URL'))
export const VmVersionMetadataSchema = utf8BoundedString(
  MAX_VM_VERSION_METADATA_UTF8_BYTES,
  'VM version metadata',
).min(1)
const OptionalVmMetadataSchema = VmVersionMetadataSchema.optional()
export const MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE = MAX_ACTIVE_SHARES_PER_WORKSPACE

/**
 * What the telemetry chart reads. The VM no longer measures itself, so this is
 * the only telemetry shape the contract declares — it is a response contract,
 * unrelated to anything a gateway sends up the sync rail.
 *
 * The units are the chart's, not the provider's — the backend projects
 * provider cores and bytes into these before they leave Convex, so the web app
 * never learns that a core count arrives as `cpu_cores`.
 */
export const VmTelemetrySampleSchema = z
  .object({
    at: z.number().nonnegative(),
    cpuPct: z.number().min(0).max(100).optional(),
    memUsedMb: z.number().nonnegative().optional(),
    memTotalMb: z.number().nonnegative().optional(),
    diskUsedMb: z.number().nonnegative().optional(),
    diskTotalMb: z.number().nonnegative().optional(),
  })
  .strip()
export type VmTelemetrySample = z.infer<typeof VmTelemetrySampleSchema>

export const VmTelemetryHistoryQuerySchema = z.object({
  sinceAt: z.coerce.number().nonnegative().optional(),
})

export const VmTelemetryHistoryResponseSchema = z.object({
  samples: z.array(VmTelemetrySampleSchema),
})
export type VmTelemetryHistoryResponse = z.infer<typeof VmTelemetryHistoryResponseSchema>

export const ShareSyncReportSchema = z.object({
  shareId: z.string().min(1),
  generation: ShareSyncGenerationSchema,
  state: z.enum(['applying', 'ready', 'paused', 'error']),
  errorCode: ShareSyncErrorCodeSchema.optional(),
})

export type ShareSyncReport = z.infer<typeof ShareSyncReportSchema>

export const AppReconciliationReportSchema = z.discriminatedUnion('status', [
  GatewayAppConfigSchema.extend({
    status: z.literal('reconciled'),
  }),
  GatewayAppConfigSchema.extend({
    status: z.literal('reconcile_failed'),
    error: AppReconciliationErrorSchema,
  }),
])
export type AppReconciliationReport = z.infer<typeof AppReconciliationReportSchema>

const ExactSemverSchema = VmVersionMetadataSchema.regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  'Expected an exact semantic version',
)

/**
 * How long a workspace may go without a sync before the health sweep marks it
 * unhealthy. The sync poll IS the heartbeat, so this is the ceiling on any
 * poll interval the control plane hands out — it lives here rather than beside
 * the sweep because the API must respect a threshold the backend enforces.
 */
export const VM_SYNC_STALE_MS = 15 * 60 * 1000
/**
 * How many idle polls must fit inside the staleness window. One would mean a
 * single dropped poll marks the workspace unhealthy; three leaves room for a
 * loss and a retry. Owned here, beside the window it divides, because the API
 * derives its idle ceiling from it and the staging harness budgets against the
 * same ceiling — two copies of the divisor would silently disagree.
 */
export const VM_SYNC_IDLE_POLLS_PER_STALE_WINDOW = 3
/** The longest a quiet VM is ever asked to wait between polls. */
export const MAX_VM_IDLE_SYNC_INTERVAL_MS = VM_SYNC_STALE_MS / VM_SYNC_IDLE_POLLS_PER_STALE_WINDOW

export const VmSyncRequestSchema = z
  .object({
    workspaceHint: z.string().min(1).optional(),
    trainReports: GatewayTrainJobReportBatchSchema.optional(),
    syncthingDeviceId: SyncthingDeviceIdSchema.optional(),
    shareSyncReports: z
      .array(ShareSyncReportSchema)
      .max(MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE)
      .optional(),
    appReconciliationReports: z
      .array(AppReconciliationReportSchema)
      .max(MAX_APPS_PER_WORKSPACE)
      .optional(),
    marketplacePullReports: z
      .array(MarketplaceAgentPullReportSchema)
      .max(MAX_MARKETPLACE_AGENT_PULL_REPORTS_PER_WORKSPACE)
      .optional(),
    needsModelCredentials: z.boolean(),
    needsAppCredentials: z.array(z.string().min(1)).max(MAX_APPS_PER_WORKSPACE).optional(),
    versions: z
      .object({
        runtime: ExactSemverSchema,
        // The image "version" is an identity ref (ghcr digest), not a semver —
        // the provisioner passes DUET_IMAGE_VERSION=<imageRef> verbatim.
        image: VmVersionMetadataSchema,
      })
      .strip(),
  })
  // Clients validate their actual outgoing body. Unknown fields strip in
  // both directions so a future protocol addition cannot brick VM updates.
  .strip()
export type VmSyncRequest = z.infer<typeof VmSyncRequestSchema>

export const VmRegisterRequestSchema = z.object({
  provisioningToken: z.string().min(1),
  workspaceHint: z.string().min(1),
  vmName: VmProviderNameSchema.optional(),
  sshDest: VmProviderSshDestSchema.optional(),
  httpsUrl: VmProviderHttpsUrlSchema.optional(),
  runtimeVersion: OptionalVmMetadataSchema,
  imageVersion: OptionalVmMetadataSchema,
})
export type VmRegisterRequest = z.infer<typeof VmRegisterRequestSchema>

/**
 * How early the VM asks for its next model credential — and, because of that,
 * how long a superseded one must keep authenticating.
 *
 * Both halves are the same promise. An agent runner bakes `DUET_API_KEY` into
 * its env at spawn and holds it for the whole turn, so the handover only works
 * if the outgoing key outlives the incoming one's arrival by at least the
 * window the VM asked in. Revoking on delivery collapses that overlap to zero
 * and 401s every model call of a turn already in flight.
 */
export const VM_MODEL_CREDENTIAL_REFRESH_WINDOW_MS = 2 * 60 * 60 * 1000

export const DeliveredModelCredentialsSchema = z.object({
  apiKey: VmResponseCredentialSchema,
  expiresAt: z.number(),
})

export const VmModelCredentialsSchema = DeliveredModelCredentialsSchema.extend({
  gatewayBaseUrl: VmResponseUrlSchema,
})
export type VmModelCredentials = z.infer<typeof VmModelCredentialsSchema>

export const VmAppCredentialsSchema = z.object({
  appId: VmResponseIdSchema,
  apiKey: VmResponseCredentialSchema,
  // Declared capabilities (AppApiScopesSchema vocabulary), NOT ws-serialized
  // key scopes: the gateway compares these against GatewayAppConfig.apiScopes.
  scopes: AppApiScopesSchema,
  expiresAt: z.number(),
})
export type VmAppCredentials = z.infer<typeof VmAppCredentialsSchema>

const CanonicalSha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/)

export const VmDesiredShareSyncSchema = z.object({
  shares: z
    .array(
      z.object({
        shareId: VmResponseIdSchema,
        generation: CanonicalSha256HexSchema,
        folder: z.object({
          id: VmResponseIdSchema,
          path: DriveRelativePathSchema,
          mode: z.enum(['read', 'write']),
          role: z.enum(['origin', 'recipient']),
          peerDeviceId: SyncthingDeviceIdSchema,
          ignorePatterns: z.array(z.string()),
          paused: z.boolean(),
        }),
        mount: z.object({ path: DriveRelativePathSchema }).optional(),
        accept: z.object({
          acceptId: VmResponseIdSchema,
          targetPort: z.number().int().min(1).max(65_535),
          tokenDigest: CanonicalSha256HexSchema,
          expiresAt: z.number(),
        }),
        bridge: z
          .object({
            peerDeviceId: SyncthingDeviceIdSchema,
            peerUrl: VmResponseUrlSchema.refine(
              url => /^wss?:\/\//.test(url),
              'Expected a WebSocket URL',
            ),
            tunnelToken: VmResponseCredentialSchema,
            acceptId: VmResponseIdSchema,
          })

          .optional(),
      }),
    )
    .max(MAX_ACTIVE_SHARES_PER_WORKSPACE),
})

export type VmDesiredShareSync = z.infer<typeof VmDesiredShareSyncSchema>

// Derived from the anchor row schema so the kind/state enums have ONE owner —
// a new anchor kind added to AnchorSchema reaches the VM-sync anchor list
// automatically, instead of the two drifting (a redeclared enum would let the
// anchor list silently reject a kind the rest of the app accepts).
export const GatewayAnchorSchema = AnchorSchema.extend({
  markerNonce: utf8BoundedString(MAX_ANCHOR_MARKER_NONCE_UTF8_BYTES, 'Anchor marker nonce'),
  agentId: z.string().optional(),
}) satisfies z.ZodType<GatewayAnchor>

export const GatewayAnchorsReconcileRequestSchema = z.object({
  anchors: z.array(GatewayAnchorSchema).max(MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE),
})

export type GatewayAnchorsReconcileRequest = z.infer<typeof GatewayAnchorsReconcileRequestSchema>

/**
 * Make `roots` hold exactly `files`. Under a named root the caller's plan is the
 * whole truth: the gateway writes what differs, leaves identical bytes untouched
 * (their mtime is the publish ETag, so an identical rewrite would badge every
 * subscriber with a phantom update), and reaps what the plan no longer claims —
 * which is how a deletion or a rename in the source reaches the hub at all.
 *
 * The publish floor is never reaped, so an installed `node_modules` still
 * coexists with a repo-owned folder, and `.duet-anchor` — whose absence makes
 * the gateway refuse the folder as a hijack — survives its own update.
 *
 * A root NOT named here is never walked. That is what keeps demotion working:
 * drop a folder from the plan and it keeps serving its last bytes.
 *
 * Every file path must sit beneath one of `roots`; the gateway re-checks that
 * rather than trusting the caller.
 */
export const GatewayConvergeSubtreeRequestSchema = z.object({
  roots: z.array(z.string().min(1)).min(1),
  files: z.array(z.object({ path: z.string().min(1), base64: z.string() })),
})

export type GatewayConvergeSubtreeRequest = z.infer<typeof GatewayConvergeSubtreeRequestSchema>

export const GatewayConvergeSubtreeResponseSchema = z.object({
  written: z.array(z.string()),
  unchanged: z.number().int().nonnegative(),
  /** Paths reaped because the plan no longer claims them. Sorted. */
  deleted: z.array(z.string()),
})

export type GatewayConvergeSubtreeResponse = z.infer<typeof GatewayConvergeSubtreeResponseSchema>

export const RUNTIME_RELEASE_MANIFEST_FILE = 'manifest.json'
export const RUNTIME_RELEASE_HELPER_FILE = 'helper.js'
export const RUNTIME_RELEASE_ARTIFACT_NAMES = [
  'duet',
  'helper.js',
  'index.js',
  'initdb.wasm',
  'pglite.data',
  'pglite.wasm',
  'photon_rs_bg.wasm',
  'vector.tar.gz',
] as const

const RuntimeArtifactSchema = z
  .object({
    name: z.enum(RUNTIME_RELEASE_ARTIFACT_NAMES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 digest'),
    byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
  })
  .refine(artifact => artifact.mode === (artifact.name === 'duet' ? 0o755 : 0o644), {
    message: 'Runtime executable and data modes must match their installed roles',
  })

function completeRuntimeInventory(artifacts: { name: string }[]): boolean {
  return (
    artifacts.length === RUNTIME_RELEASE_ARTIFACT_NAMES.length &&
    artifacts.every((artifact, index) => artifact.name === RUNTIME_RELEASE_ARTIFACT_NAMES[index])
  )
}

export const RuntimeReleaseManifestSchema = z.object({
  formatVersion: z.literal(1),
  version: ExactSemverSchema,
  artifacts: z
    .array(RuntimeArtifactSchema)
    .length(RUNTIME_RELEASE_ARTIFACT_NAMES.length)
    .refine(completeRuntimeInventory, 'Expected the complete sorted runtime inventory'),
})
export type RuntimeReleaseManifest = z.infer<typeof RuntimeReleaseManifestSchema>

export const RuntimeReleaseDescriptorSchema = RuntimeReleaseManifestSchema.extend({
  artifacts: z
    .array(RuntimeArtifactSchema.safeExtend({ href: VmResponseUrlSchema }))
    .length(RUNTIME_RELEASE_ARTIFACT_NAMES.length)
    .refine(completeRuntimeInventory, 'Expected the complete sorted runtime inventory'),
})
export type RuntimeReleaseDescriptor = z.infer<typeof RuntimeReleaseDescriptorSchema>

/** The hashed bytes exclude the version and transport URLs. */
export function canonicalRuntimeReleaseIdentityInput(
  artifacts: ReadonlyArray<RuntimeReleaseManifest['artifacts'][number]>,
): string {
  return JSON.stringify({
    formatVersion: 1,
    artifacts: [...artifacts]
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map(({ name, sha256, byteLength, mode }) => ({ name, sha256, byteLength, mode })),
  })
}

const VmUpdatesSchema = z.object({ paused: z.boolean() })

export const VmSyncResponseSchema = z
  .object({
    pollAfterMs: z.number().positive(),
    // Per-workspace servicing stop. This is deliberately unrelated to
    // updates.paused, which controls only the global release rollout.
    quiesce: z.boolean().optional(),
    workspaceSlug: WorkspaceSlugSchema.optional(),
    anchors: z.array(GatewayAnchorSchema).max(MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE),
    apps: z.array(GatewayAppConfigSchema).max(MAX_APPS_PER_WORKSPACE).optional(),
    // The agent roster, mirroring `apps`: anchors own path identity, agents own
    // agent identity (D9), and they join on agentId. Optional is a permanent
    // skew rule, not scaffolding — an absent field means "keep what you have",
    // an explicit [] clears it.
    agents: GatewayAgentRosterSchema.optional(),
    runtimeRelease: RuntimeReleaseDescriptorSchema.optional(),
    skills: z
      .object({
        hash: utf8BoundedString(256, 'Skills bundle hash').min(1),
        url: VmResponseUrlSchema,
      })
      .optional(),
    updates: VmUpdatesSchema,
    acceptedTrainReportGenerations: z
      .array(VmResponseIdSchema)
      .max(MAX_TRAIN_REPORTS_PER_SYNC)
      .optional(),
    modelCredentials: VmModelCredentialsSchema.optional(),
    appCredentials: z.array(VmAppCredentialsSchema).max(MAX_APPS_PER_WORKSPACE).optional(),
    mirrorMachineIds: z
      .array(VmResponseIdSchema)
      .max(WORKSPACE_MEMBER_LIMIT * MAX_SYNC_MACHINES_PER_USER),
    shareSync: VmDesiredShareSyncSchema.optional(),
    marketplace: VmDesiredMarketplaceAgentsSchema.optional(),
    disconnectConnectedProviders: z
      .array(ConnectedProviderIdSchema)
      .max(ConnectedProviderIdSchema.options.length)
      .optional(),
  })
  // Consumer-tolerant: a gateway must strip fields added by a later feature,
  // not reject the whole response — otherwise it can never parse a response
  // that grew and never self-updates (landmine L1). Matches
  // VmRegisterResponseSchema's `.strip()`. The producer constructs a typed,
  // correct response; unknown-key rejection on the wire only bricks old gateways.
  .strip()
export type VmSyncResponse = z.infer<typeof VmSyncResponseSchema>

// Rescue only the complete runtime release when a future response cannot yet
// be read. Legacy gateway-only manifests and npm directives are never applied.
export const RuntimeReleaseEnvelopeSchema = z.object({
  runtimeRelease: RuntimeReleaseDescriptorSchema.optional(),
})
export type RuntimeReleaseEnvelope = z.infer<typeof RuntimeReleaseEnvelopeSchema>

export const VmRestoreReferenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workspace-backup'),
    backupId: z.string().min(1),
    objectPath: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    kind: z.literal('birth-seed'),
    url: VmResponseUrlSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
])
export type VmRestoreReference = z.infer<typeof VmRestoreReferenceSchema>

export const VmRestoreDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workspace-backup'),
    backupId: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    refreshUrl: VmResponseUrlSchema,
    download: z.object({ url: VmResponseUrlSchema, expiresAt: z.number() }).optional(),
  }),
  z.object({
    kind: z.literal('birth-seed'),
    url: VmResponseUrlSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
])
export type VmRestoreDescriptor = z.infer<typeof VmRestoreDescriptorSchema>

// Restore progress counts completed IO/index work, including real work repeated after
// a process restart. Claims and phase changes alone never extend the deadline.
const restoreAttempt = { backupId: z.string().min(1), attemptId: z.string().min(1).max(128) }
export const VmRestoreCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claim'), ...restoreAttempt }),
  z.object({
    kind: z.literal('progress'),
    ...restoreAttempt,
    phase: z.enum(['download', 'index', 'extract', 'install']),
    processedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    processedEntries: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.object({ kind: z.literal('installed'), ...restoreAttempt }),
  z.object({ kind: z.literal('failed'), ...restoreAttempt }),
])
export type VmRestoreCommand = z.infer<typeof VmRestoreCommandSchema>
export const VmRestoreClaimSchema = z.object({
  status: z.enum(['running', 'installed', 'failed', 'abandoned']),
  processedBytes: z.number().int().nonnegative(),
  processedEntries: z.number().int().nonnegative(),
})
export type VmRestoreClaim = z.infer<typeof VmRestoreClaimSchema>
export const RESTORE_STALL_MS = 15 * 60_000

export const VmRegisterResponseSchema = z
  .object({
    vmToken: VmResponseCredentialSchema,
    vmTokenPrefix: VmResponseCredentialSchema.optional(),
    syncIntervalSeconds: z.number().positive(),
    restore: VmRestoreDescriptorSchema.nullable().optional(),
    // A committed registration must return its token even if projection fails.
    // Only a complete machine set makes this initial snapshot authoritative.
    sync: VmSyncResponseSchema.partial({ mirrorMachineIds: true }),
  })
  .strip()
export type VmRegisterResponse = z.infer<typeof VmRegisterResponseSchema>
