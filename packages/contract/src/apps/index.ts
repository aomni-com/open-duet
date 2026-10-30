import { z } from 'zod'

import { AgentCwdSchema, canonicalAgentCwd } from '../agent/index'
import { AnchorStateSchema, DriveRelativePathSchema } from '../anchors/index'
import {
  AppDomainHostnameSchema,
  AppDomainSummarySchema,
  type AppDomainSummary,
} from '../domains/index'
import { normalizeDrivePath } from '../drive/index'
import { EDGE_HOSTS, parseEdgeAppHost } from '../edge/index'
import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'
import { IconPathSchema } from '../relative-path/index'
import { AppApiScopesSchema, sameApiScopes } from '../scopes/index'
import { ShareModeSchema, type ShareMode } from '../shares/index'
import { AppSlugSchema, WorkspaceSlugSchema } from '../slug/index'
import { utf8BoundedString } from '../utf8/index'
import { type WorkspaceRole } from '../workspaces/index'
import { AppControlsSchema, AppNameSchema, type AppControls } from './fields'
import { AppsScopeSchema } from './path-scope'

export * from './path-scope'
export * from './fields'
export * from './credentials'

export const APP_AUTO_PORT_RANGE_START = 41_000
export const APP_AUTO_PORT_RANGE_END = 41_999
export const MAX_APPS_PER_WORKSPACE = 100
export const MAX_APP_COMMAND_UTF8_BYTES = 8 * 1024
export const MAX_APP_INSTALL_COMMAND_UTF8_BYTES = 8 * 1024
export const MAX_APP_CONTENT_GENERATION_UTF8_BYTES = 1_024
export const MAX_APP_RECONCILIATION_ERROR_UTF8_BYTES = 4_000
export const MAX_APP_PUBLIC_URL_UTF8_BYTES = 4 * 1024

// The one owner of auto-port allocation policy: lowest free port in the
// reserved range. Both origin registration and replica seeding allocate through
// here so the policy can't drift between them.
export function firstAvailableAutoAssignedPort(usedPorts: ReadonlySet<number | undefined>): number {
  for (let port = APP_AUTO_PORT_RANGE_START; port <= APP_AUTO_PORT_RANGE_END; port += 1) {
    if (!usedPorts.has(port)) return port
  }
  throw new Error('No auto-assigned app ports available')
}

export const AppVisibilitySchema = z.enum(['folder', 'public'])
export type AppVisibility = z.infer<typeof AppVisibilitySchema>

export const ListAppsQuerySchema = CollectionPageQuerySchema.extend({
  id: z.string().min(1).optional(),
  cwd: AgentCwdSchema.refine(cwd => canonicalAgentCwd(cwd) !== undefined).optional(),
  path: z.string().optional(),
  scope: AppsScopeSchema.optional(),
}).superRefine((query, ctx) => {
  if (query.scope !== undefined && query.path === undefined) {
    ctx.addIssue({ code: 'custom', path: ['scope'], message: 'scope requires path' })
  }
  const selectedFilters = [query.id, query.cwd, query.path].filter(value => value !== undefined)
  if (selectedFilters.length > 1) {
    ctx.addIssue({ code: 'custom', message: 'id, cwd, and path filters are mutually exclusive' })
  }
})
export type ListAppsQuery = z.input<typeof ListAppsQuerySchema>

const AppRuntimeStatusSchema = z.enum(['reconciling', 'reconciled', 'reconcile_failed'])

const AppPortSchema = z.number().int().min(1).max(65_535)
export const AppCommandSchema = utf8BoundedString(MAX_APP_COMMAND_UTF8_BYTES, 'App command').min(1)
export const AppInstallCommandSchema = utf8BoundedString(
  MAX_APP_INSTALL_COMMAND_UTF8_BYTES,
  'App install command',
).min(1)
const InstallCommandRequestSchema = z.string().trim().pipe(AppInstallCommandSchema)
const AppCommandRequestSchema = z.string().trim().pipe(AppCommandSchema)
export const AppContentGenerationSchema = utf8BoundedString(
  MAX_APP_CONTENT_GENERATION_UTF8_BYTES,
  'App content generation',
).min(1)
export const AppReconciliationErrorSchema = utf8BoundedString(
  MAX_APP_RECONCILIATION_ERROR_UTF8_BYTES,
  'App reconciliation error',
)
  .min(1)
  .max(2_000)
export const AppIconSchema = IconPathSchema
export const AppPublicUrlSchema = z
  .url()
  .pipe(utf8BoundedString(MAX_APP_PUBLIC_URL_UTF8_BYTES, 'App public URL'))
const ExplicitAppPortSchema = AppPortSchema.refine(
  port => port < APP_AUTO_PORT_RANGE_START || port > APP_AUTO_PORT_RANGE_END,
  { message: 'Explicit app port must be outside the reserved range' },
)

// What one caller may do to one app. Role alone cannot answer this: a shared
// replica lives in the recipient's own workspace, where they are the owner, yet
// what they may do to it is bounded by the share it arrived through.
export type AppControlsSubject = {
  anchorState?: z.infer<typeof AnchorStateSchema>
  sourceShareId?: string
  sourceShareMode?: ShareMode
  listingSubscriptionId?: string
  disabledAt?: number
}

/**
 * A managed app whose files have not landed yet.
 *
 * Installing a subscription writes the app row immediately and switches it off
 * until the first pull applies its content, so "subscription-owned AND switched
 * off" is the app still arriving. It is the only way a managed app is off: the
 * publisher dropping one deletes the row rather than parking it, so there is no
 * other state this conjunction can mean.
 *
 * Exported because the frame words itself from it — a switched-off REPLICA has
 * a switch its reader can flip, and this one does not, so telling both the same
 * thing sends one of them hunting for a control that does not exist.
 */
export function appIsInstalling(
  app: Pick<AppControlsSubject, 'listingSubscriptionId' | 'disabledAt'>,
): boolean {
  return app.listingSubscriptionId !== undefined && app.disabledAt !== undefined
}

export function appControls(role: WorkspaceRole, app: AppControlsSubject): AppControls {
  const canEdit = role === 'owner' || role === 'editor'
  const isReplica = app.sourceShareId !== undefined
  // A marketplace-managed app's runtime is the publisher's declaration: a local
  // edit would be clobbered by the next sync. Visibility stays the installer's.
  const isManaged = app.listingSubscriptionId !== undefined
  // Switched off means it cannot serve, whatever kind of app it is, so nothing
  // that changes what it serves is on offer. A replica additionally writes
  // through to the origin, so it stays mutable only while its share grants
  // write.
  const mutable =
    canEdit && app.disabledAt === undefined && (!isReplica || app.sourceShareMode === 'write')
  // An app whose folder is gone can never answer its public URL, so a public
  // link for it would be dead on arrival.
  const servable = app.anchorState !== 'broken'
  return {
    manageDomain: canEdit,
    updateRuntime: mutable && !isManaged,
    makePublic: mutable && servable && role === 'owner',
    makePrivate: mutable && servable,
    // A replica leaves by dropping the share, and a managed app by uninstalling
    // the subscription that ships it — never by deleting the row underneath
    // either one.
    delete: canEdit && !isReplica && !isManaged,
  }
}

const AppSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  anchorId: z.string(),
  anchorPath: DriveRelativePathSchema,
  anchorState: AnchorStateSchema,
  command: AppCommandSchema,
  apiScopes: AppApiScopesSchema,
  installCommand: AppInstallCommandSchema.optional(),
  port: AppPortSchema,
  slug: AppSlugSchema,
  name: AppNameSchema.optional(),
  icon: AppIconSchema.optional(),
  visibility: AppVisibilitySchema,
  canonicalUrl: AppPublicUrlSchema,
  customDomain: AppDomainSummarySchema.optional(),
  runtimeStatus: AppRuntimeStatusSchema,
  reconciliationError: AppReconciliationErrorSchema.optional(),
  sourceShareId: z.string().optional(),
  sourceShareMode: ShareModeSchema.optional(),
  sourceAppId: z.string().optional(),
  listingSubscriptionId: z.string().optional(),
  disabledAt: z.number().int().nonnegative().optional(),
  disabledByUserId: z.string().optional(),
  createdByUserId: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  controls: AppControlsSchema,
})
export type App = z.infer<typeof AppSchema>

export const AppListResponseSchema = collectionPageSchema(
  AppSchema,
  z.object({ capabilities: z.object({ register: z.boolean() }) }),
)
export type AppListResponse = z.infer<typeof AppListResponseSchema>

export const AppResponseSchema = z.object({ app: AppSchema })
export type AppResponse = z.infer<typeof AppResponseSchema>

export const DeleteAppResponseSchema = z.object({ ok: z.literal(true) })
export type DeleteAppResponse = z.infer<typeof DeleteAppResponseSchema>

export const AppReconciliationFailureSchema = z.object({
  error: z.literal('app_reconcile_failed'),
  operation: z.enum(['register', 'update', 'delete', 'disable']),
  reason: z.string().min(1),
  app: AppSchema.optional(),
})

export const RegisterAppRequestSchema = z.object({
  path: z.string().trim().min(1).pipe(DriveRelativePathSchema),
  command: AppCommandRequestSchema,
  apiScopes: AppApiScopesSchema,
  installCommand: InstallCommandRequestSchema.optional(),
  port: ExplicitAppPortSchema.optional(),
  slug: AppSlugSchema,
  name: AppNameSchema.optional(),
  icon: AppIconSchema.optional(),
})

export type RegisterAppRequest = z.infer<typeof RegisterAppRequestSchema>

export const AppDeclarationSchema = z.object({
  path: z.string().transform((path, context) => {
    const normalized = normalizeDrivePath(path)
    if (!normalized.ok) {
      context.addIssue({ code: 'custom', message: `Invalid seed app path: ${normalized.reason}` })
      return z.NEVER
    }
    return normalized.relativePath
  }),
  slug: AppSlugSchema,
  command: AppCommandRequestSchema,
  apiScopes: AppApiScopesSchema,
  installCommand: InstallCommandRequestSchema.optional(),
  // Explicit like `RegisterAppRequestSchema`: every declaration flows into the
  // one registration owner, which refuses the reserved auto-allocation range.
  port: ExplicitAppPortSchema.optional(),
  name: AppNameSchema.optional(),
  icon: AppIconSchema.optional(),
})
export type AppDeclaration = z.infer<typeof AppDeclarationSchema>

export const UpdateAppRequestSchema = z
  .object({
    command: AppCommandRequestSchema.optional(),
    apiScopes: AppApiScopesSchema.optional(),
    installCommand: InstallCommandRequestSchema.optional(),
    port: ExplicitAppPortSchema.optional(),
    name: AppNameSchema.optional(),
    icon: AppIconSchema.optional(),
  })
  .refine(
    value =>
      value.command !== undefined ||
      value.apiScopes !== undefined ||
      value.installCommand !== undefined ||
      value.port !== undefined ||
      value.name !== undefined ||
      value.icon !== undefined,
  )

export type UpdateAppRequest = z.infer<typeof UpdateAppRequestSchema>

export const SetAppVisibilityRequestSchema = z.object({
  visibility: AppVisibilitySchema,
})

export const SetAppDisabledRequestSchema = z.object({ disabled: z.boolean() })

// Strip-by-default, deliberately not `.loose()`: reconciliation reports extend
// this schema and ride the vm-sync request, where stripping is the gate that
// keeps app credential fields from ever echoing back. Skew safety comes from
// tolerating (dropping) unknown fields plus keeping new fields optional —
// never from preserving unknowns.
export const GatewayAppConfigSchema = z.object({
  appId: z.string(),
  slug: AppSlugSchema,
  name: AppNameSchema.optional(),
  command: AppCommandSchema,
  installCommand: AppInstallCommandSchema.optional(),
  port: AppPortSchema,
  anchorPath: DriveRelativePathSchema,
  apiScopes: AppApiScopesSchema,
  contentGeneration: AppContentGenerationSchema.optional(),
  visibility: AppVisibilitySchema.optional(),
  canonicalUrl: AppPublicUrlSchema.optional(),
  customDomain: AppDomainSummarySchema.optional(),
})

export type GatewayAppConfig = z.infer<typeof GatewayAppConfigSchema>

export function sameGatewayAppRuntimeConfig(
  left: GatewayAppConfig,
  right: GatewayAppConfig,
): boolean {
  // Visibility metadata is excluded so toggles never restart processes or
  // strand a skewed gateway's app in reconciling.
  return (
    left.appId === right.appId &&
    left.slug === right.slug &&
    left.command === right.command &&
    left.installCommand === right.installCommand &&
    left.port === right.port &&
    left.anchorPath === right.anchorPath &&
    sameApiScopes(left.apiScopes, right.apiScopes) &&
    left.contentGeneration === right.contentGeneration
  )
}

export function sameGatewayAppConfig(left: GatewayAppConfig, right: GatewayAppConfig): boolean {
  // Visibility metadata is excluded so toggles never restart processes or
  // strand a skewed gateway's app in reconciling.
  return (
    left.appId === right.appId &&
    left.slug === right.slug &&
    left.name === right.name &&
    left.command === right.command &&
    left.installCommand === right.installCommand &&
    left.port === right.port &&
    left.anchorPath === right.anchorPath &&
    sameApiScopes(left.apiScopes, right.apiScopes) &&
    left.contentGeneration === right.contentGeneration
  )
}

export function appForCwd<T extends { anchorPath: string }>(
  cwd: string | undefined,
  apps: readonly T[],
): T | undefined {
  if (cwd === undefined) return undefined
  const canonicalCwd = canonicalAgentCwd(cwd)
  if (canonicalCwd === undefined) return undefined

  let selected: { app: T; depth: number; slug: string } | undefined
  for (const app of apps) {
    const normalizedAnchor = normalizeDrivePath(app.anchorPath)
    if (!normalizedAnchor.ok) continue
    const anchorPath = normalizedAnchor.relativePath
    if (canonicalCwd !== anchorPath && !canonicalCwd.startsWith(`${anchorPath}/`)) {
      continue
    }
    const depth = anchorPath.split('/').length
    const slug = 'slug' in app && typeof app.slug === 'string' ? app.slug : ''
    if (
      selected === undefined ||
      depth > selected.depth ||
      (depth === selected.depth && slug < selected.slug)
    ) {
      selected = { app, depth, slug }
    }
  }
  return selected?.app
}

export const GatewayAppsReconcileRequestSchema = z
  .object({
    apps: z.array(GatewayAppConfigSchema).max(MAX_APPS_PER_WORKSPACE),
    requiredReadySlugs: z.array(AppSlugSchema).max(MAX_APPS_PER_WORKSPACE).optional(),
  })
  .superRefine((request, ctx) => {
    if (request.requiredReadySlugs === undefined) return
    const desiredSlugs = new Set(request.apps.map(app => app.slug))
    request.requiredReadySlugs.forEach((slug, index) => {
      if (desiredSlugs.has(slug)) return
      ctx.addIssue({
        code: 'custom',
        path: ['requiredReadySlugs', index],
        message: 'Required ready slug must be present in apps',
      })
    })
  })

// edgeHost is the deployment's edge host (DUET_EDGE_HOST or
// DUET_STAGING_EDGE_HOST) — the caller knows its environment; this stays pure.
export function canonicalAppUrl(workspaceSlug: string, appSlug: string, edgeHost: string): string {
  const workspace = WorkspaceSlugSchema.parse(workspaceSlug)
  const app = AppSlugSchema.parse(appSlug)
  return AppPublicUrlSchema.parse(`https://${app}--${workspace}.${edgeHost}/`)
}

export function primaryAppUrl(
  workspaceSlug: string,
  appSlug: string,
  edgeHost: string,
  domain?: AppDomainSummary,
): string {
  if (domain?.status === 'active') {
    return AppPublicUrlSchema.parse(`https://${AppDomainSummarySchema.parse(domain).hostname}/`)
  }
  return canonicalAppUrl(workspaceSlug, appSlug, edgeHost)
}

export const LaunchAppQuerySchema = z
  .object({
    host: z
      .string()
      .refine(
        host =>
          AppDomainHostnameSchema.safeParse(host).success ||
          EDGE_HOSTS.some(edgeHost => parseEdgeAppHost(host, edgeHost) !== null),
        'Invalid app hostname',
      )
      .optional(),
    path: utf8BoundedString(8_192, 'App return path')
      .refine(
        path =>
          path.startsWith('/') &&
          !path.startsWith('//') &&
          !/[\\#]/.test(path) &&
          [...path].every(
            character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
        'Invalid relative app path',
      )
      .optional(),
  })
  .strict()
  .refine(
    value => (value.host === undefined) === (value.path === undefined),
    'Supply host and path together',
  )
export type LaunchAppQuery = z.infer<typeof LaunchAppQuerySchema>
