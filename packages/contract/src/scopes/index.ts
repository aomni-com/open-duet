import { z } from 'zod'

import { WorkspaceSlugSchema } from '../slug/index'

export const CAPABILITIES = [
  'files:read',
  'files:write',
  'memory',
  'sessions',
  'agents',
  'services',
  'integrations',
  'apps',
  'share',
  'publish',
  'members',
  'admin',
] as const

/** A request may repeat capabilities, but cannot make normalization itself unbounded. */
export const MAX_CAPABILITY_REQUEST_ITEMS = 64
export const MAX_STORED_API_KEY_SCOPES = CAPABILITIES.length

export type Capability = (typeof CAPABILITIES)[number]

export type AppApiCapability = Exclude<Capability, 'admin'>

export const APP_API_CAPABILITIES = CAPABILITIES.filter(
  (capability): capability is AppApiCapability => capability !== 'admin',
)

export const AppApiScopesSchema = z
  .array(z.enum(APP_API_CAPABILITIES))
  .max(MAX_CAPABILITY_REQUEST_ITEMS)
  .overwrite(scopes => [...new Set(scopes)].sort())

export const ELEVATED_APP_CAPABILITIES = [
  'files:write',
  'integrations',
  'share',
  'publish',
] as const satisfies readonly AppApiCapability[]

// Declarations are canonical (deduped, sorted) once parsed, so element-wise
// equality is set equality.
export function sameApiScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export interface WorkspaceScope {
  workspaceSlug: string
  capability: Capability
}

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES)

export const API_VERSION = { api: 1 } as const

export const CapabilitySchema = z.enum(CAPABILITIES)

// The shape of a capability request from a membership-backed credential — a
// login, an OAuth consent, a device grant. It is deliberately NOT a subset:
// every capability is requestable, and `roleCanGrant` is the only ceiling,
// so an owner reaches `members`/`admin` and a viewer reaches neither.
// Canonical (deduped, sorted) once parsed, exactly like AppApiScopesSchema.
export const CapabilityListSchema = z
  .array(CapabilitySchema)
  .max(MAX_CAPABILITY_REQUEST_ITEMS)
  .overwrite(capabilities => [...new Set(capabilities)].sort())

export function parseScope(scope: string): WorkspaceScope | null {
  const parts = scope.split(':')
  if (parts.length < 3 || parts[0] !== 'ws') return null
  const workspaceSlug = parts[1]
  const capability = parts.slice(2).join(':')
  if (workspaceSlug === undefined || WorkspaceSlugSchema.safeParse(workspaceSlug).success === false)
    return null
  if (!isCapability(capability)) return null
  return { workspaceSlug, capability }
}

export function serializeScope(scope: WorkspaceScope): string {
  const workspaceSlug = WorkspaceSlugSchema.parse(scope.workspaceSlug)
  const capability = CapabilitySchema.parse(scope.capability)
  return `ws:${workspaceSlug}:${capability}`
}

export function scopeSetSatisfies(scopes: Iterable<string>, requirement: string): boolean {
  const required = parseScope(requirement)
  if (required === null) return false
  for (const scope of scopes) {
    const granted = parseScope(scope)
    if (granted === null) continue
    if (granted.workspaceSlug !== required.workspaceSlug) continue
    if (granted.capability === required.capability || granted.capability === 'admin') return true
  }
  return false
}

function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value)
}

const ApiKeyScopeSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(scope => parseScope(scope) !== null, 'Invalid scope')

/** The one canonical representation persisted by every API-key writer. */
export const StoredApiKeyScopesSchema = z
  .array(ApiKeyScopeSchema)
  .max(MAX_CAPABILITY_REQUEST_ITEMS)
  .overwrite(scopes => [...new Set(scopes)].sort())
  .refine(scopes => scopes.length <= MAX_STORED_API_KEY_SCOPES, 'Too many API key scopes')

export function canonicalizeApiKeyScopes(scopes: string[]): string[] {
  return StoredApiKeyScopesSchema.parse(scopes)
}
