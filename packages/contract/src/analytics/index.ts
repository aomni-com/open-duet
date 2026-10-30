import { z } from 'zod'

export const MAX_ANALYTICS_JSON_BYTES = 64 * 1024

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue }

export const AUDIT_EVENT_NAMES = [
  'agent.deleted',
  'agent.disabled',
  'agent.enabled',
  // A listing became an agent in someone's workspace. Distinct from
  // `agent.registered`, which fires for every agent folder the VM registers:
  // this one names the LISTING that was installed and the surface that asked
  // for it, which is what an install breakdown counts.
  'agent.installed',
  'agent.onboarded',
  'agent.onboarding_reset',
  'agent.registered',
  'agent.registered_again',
  'agent.updated',
  'anchor.broken',
  'anchor.broken_by_rename',
  'anchor.created',
  'anchor.reanchored',
  'anchor.reanchored_by_rename',
  'anchor.reaped_missing_folder',
  'api_key.app_key_minted',
  'api_key.app_key_revoked',
  'api_key.app_key_rotated',
  'api_key.browser_session_issued',
  'api_key.browser_session_revoked',
  'api_key.browser_session_rotated',
  'api_key.impersonation_issued',
  'api_key.issued',
  'api_key.revoked',
  'api_key.sync_device_issued',
  'api_key.sync_device_revoked',
  'api_key.vm_model_key_minted',
  'api_key.vm_model_key_revoked',
  'api_key.vm_model_key_rotated',
  'api_key.vm_model_key_superseded',
  'app.deleted',
  'app.deployed',
  'app.domain_activated',
  'app.domain_attached',
  'app.domain_removed',
  'app.visibility_changed',
  'billing.customer_created',
  'billing.settings_updated',
  'credits.trial_granted',
  'device_code.approved',
  'device_code.denied',
  'publish.created',
  'publish.deleted',
  'publish.new_file_served',
  'publish.new_zip_served',
  'publish.paused',
  'publish.resumed',
  'publish.slug_updated',
  'share.accepted',
  'share.created',
  'share.paused',
  'share.reshared',
  'share.resumed',
  'share.revoked',
  'share.unlinked',
  'user.profile_updated',
  'workspace.became_healthy',
  'workspace.became_unhealthy',
  'workspace.billing_user_changed',
  'workspace.created',
  'workspace.default_model_changed',
  'workspace.deleted',
  'workspace.duet_name_changed',
  'workspace.invite_accepted',
  'workspace.invite_created',
  'workspace.invite_revoked',
  'workspace.member_changed',
  'workspace.member_removed',
  'workspace.member_role_changed',
  'workspace.operator_reprovision_deferred',
  'workspace.operator_reprovision_started',
  'workspace.provisioning_failed',
  'workspace.provisioning_started',
  'workspace.renamed',
  'workspace.retired',
  'workspace.servicing_archived',
  // When the clock the decommission sweep measures actually started, and when
  // it stopped. Without these a workspace destroyed on the wrong day leaves no
  // record of which day it was paused.
  'workspace.servicing_paused',
  'workspace.servicing_resumed',
  'workspace.servicing_archived_without_archive',
  'workspace.suspended',
  'workspace.trial_retired',
  'workspace.unsuspended',
  'workspace.vm_attach_scheduled',
  'workspace.vm_attached',
  'workspace.vm_disk_resize_scheduled',
  'workspace.vm_disk_resized',
  'workspace.vm_registered',
  // The same VM re-presented its provisioning token before its first sync —
  // the registration response never reached it. Same VM token, fresh heartbeat.
  'workspace.vm_reregistered',
  'workspace.vm_size_resized',
] as const

// Audit facts whose payloads describe credential material or impersonation.
// They stay in the durable audit log but are never fanned out to analytics
// sinks; a new sensitive audit event must be added here when it is named.
export const ANALYTICS_EXCLUDED_AUDIT_EVENT_NAMES = [
  'api_key.impersonation_issued',
  'api_key.vm_model_key_minted',
  'api_key.vm_model_key_rotated',
  'api_key.vm_model_key_superseded',
  'api_key.vm_model_key_revoked',
  'api_key.app_key_minted',
  'api_key.app_key_rotated',
  'api_key.app_key_revoked',
] as const satisfies readonly (typeof AUDIT_EVENT_NAMES)[number][]

export const BUSINESS_EVENT_NAMES = [
  'agent_session.message_sent',
  'file.created',
  'file.written',
  'file.deleted',
  'file.renamed',
  'file.read',
  'file.restored',
  'user.signed_up',
  // A paid subscription invoice. `started` is the user's first paid invoice
  // ever — the real purchase — and `renewed` is every later one, so a campaign
  // can credit acquisition without re-crediting each billing cycle.
  'subscription.started',
  'subscription.renewed',
  'onboarding.started',
  'onboarding.completed',
  'conversion.evaluated',
] as const

export const ANALYTICS_EVENT_NAMES = [...AUDIT_EVENT_NAMES, ...BUSINESS_EVENT_NAMES] as const

export const CONVERSION_TRIGGER_EVENT_NAMES = ANALYTICS_EVENT_NAMES.filter(
  name => name !== 'conversion.evaluated',
) as Exclude<AnalyticsEventName, 'conversion.evaluated'>[]

export const BROWSER_ANALYTICS_EVENT_NAMES = ['onboarding.started'] as const

export type AuditEventName = (typeof AUDIT_EVENT_NAMES)[number]
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number]
export type ConversionTriggerEventName = Exclude<AnalyticsEventName, 'conversion.evaluated'>
export type BrowserAnalyticsEventName = (typeof BROWSER_ANALYTICS_EVENT_NAMES)[number]

export interface AnalyticsEvent<N extends AnalyticsEventName = AnalyticsEventName> {
  id: string
  name: N
  version: number
  at: number
  origin: string
  userId: string
  workspaceId?: string
  attributionId?: string
  properties: JsonObject
}

export interface BrowserAnalyticsEventRequest {
  id: string
  name: BrowserAnalyticsEventName
  workspaceId?: string
  properties: JsonObject
}

export const AnalyticsEventNameSchema = z.enum(ANALYTICS_EVENT_NAMES)
export const AuditEventNameSchema = z.enum(AUDIT_EVENT_NAMES)
export const ConversionTriggerEventNameSchema = z.enum(CONVERSION_TRIGGER_EVENT_NAMES)
export const BrowserAnalyticsEventNameSchema = z.enum(BROWSER_ANALYTICS_EVENT_NAMES)

export const JsonValueSchema = z.custom<JsonValue>(
  value => isFiniteJson(value) && serializedJsonBytes(value) <= MAX_ANALYTICS_JSON_BYTES,
  'Expected finite JSON no larger than 64 KiB',
)

export const JsonObjectSchema = z.custom<JsonObject>(
  value =>
    isJsonObject(value) &&
    isFiniteJson(value) &&
    serializedJsonBytes(value) <= MAX_ANALYTICS_JSON_BYTES,
  'Expected a finite JSON object no larger than 64 KiB',
)

export const AnalyticsEventSchema: z.ZodType<AnalyticsEvent> = z.object({
  id: z.string().min(1),
  name: AnalyticsEventNameSchema,
  version: z.number().int().positive(),
  at: z.number().finite(),
  origin: z.string().min(1),
  userId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  attributionId: z.string().min(1).optional(),
  properties: JsonObjectSchema,
})

export const BrowserAnalyticsEventRequestSchema: z.ZodType<BrowserAnalyticsEventRequest> = z.object(
  {
    id: z.uuid(),
    name: BrowserAnalyticsEventNameSchema,
    workspaceId: z.string().min(1).optional(),
    properties: JsonObjectSchema,
  },
)

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isFiniteJson(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true
  }
  if (typeof value !== 'object' || value === null) return false
  if (ancestors.has(value)) return false

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!isFiniteJson(item, ancestors)) return false
      }
      return true
    }
    if (!isJsonObject(value) || Object.getOwnPropertySymbols(value).length > 0) return false
    return Object.values(value).every(item => isFiniteJson(item, ancestors))
  } catch {
    return false
  } finally {
    ancestors.delete(value)
  }
}

function serializedJsonBytes(value: JsonValue): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}
