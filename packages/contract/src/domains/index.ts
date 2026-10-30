import { z } from 'zod'

import { AppControlsSchema, AppNameSchema } from '../apps/fields'
import { collectionPageSchema } from '../pagination/index'
import { AppSlugSchema } from '../slug/index'
import { utf8BoundedString } from '../utf8/index'

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export const AppDomainHostnameSchema = z
  .string()
  .regex(HOSTNAME_PATTERN, 'Invalid DNS hostname')
  .refine(hostname => {
    try {
      const destination = new URL(`https://${hostname}`).hostname
      return destination === hostname && !/^\d+\.\d+\.\d+\.\d+$/.test(destination)
    } catch {
      return false
    }
  }, 'A domain must be a DNS hostname rather than an IP address')
  .refine(
    hostname =>
      !['duet.so', 'duet.chat'].some(root => hostname === root || hostname.endsWith(`.${root}`)),
    'Duet domains cannot be attached',
  )

export function normalizeAppDomainHostname(input: string): string {
  z.string()
    .refine(
      value => [...value].every(character => character.charCodeAt(0) <= 127),
      'Use an ASCII or punycode hostname',
    )
    .parse(input)
  return AppDomainHostnameSchema.parse(
    input
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, ''),
  )
}

export const DomainStatusSchema = z.enum(['pending', 'verifying', 'active', 'failed', 'removing'])
export type DomainStatus = z.infer<typeof DomainStatusSchema>

const DnsTypeSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[\x20-\x7e]+$/)

export const DomainDnsRecordSchema = z.object({
  type: DnsTypeSchema,
  domain: z.string().min(1).max(253),
  value: utf8BoundedString(4_096, 'DNS record value').min(1),
  reason: utf8BoundedString(1_024, 'DNS record reason').optional(),
})
export type DomainDnsRecord = z.infer<typeof DomainDnsRecordSchema>

export const DomainDnsConflictSchema = z.object({
  name: z.string().min(1).max(253),
  type: DnsTypeSchema,
  value: utf8BoundedString(4_096, 'DNS conflict value').min(1),
})
export type DomainDnsConflict = z.infer<typeof DomainDnsConflictSchema>

export const DomainTargetSchema = z.object({
  teamId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256),
  gitBranch: z.string().min(1).max(255).nullable(),
})
export type DomainTarget = z.infer<typeof DomainTargetSchema>

export const DomainObservationSchema = z.object({
  hostname: AppDomainHostnameSchema,
  apexName: z.string().min(1).max(253),
  ownershipVerified: z.boolean(),
  misconfigured: z.boolean(),
  records: z.array(DomainDnsRecordSchema).max(32),
  conflicts: z.array(DomainDnsConflictSchema).max(32),
  target: DomainTargetSchema.pick({ projectId: true, gitBranch: true }),
})
export type DomainObservation = z.infer<typeof DomainObservationSchema>

export const AppDomainSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  appId: z.string(),
  hostname: AppDomainHostnameSchema,
  status: DomainStatusSchema,
  records: z.array(DomainDnsRecordSchema).max(32),
  conflicts: z.array(DomainDnsConflictSchema).max(32),
  lastError: utf8BoundedString(4_000, 'Domain error').max(2_000).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastCheckedAt: z.number().int().nonnegative().optional(),
  verifiedAt: z.number().int().nonnegative().optional(),
  retryRequired: z.boolean().optional(),
  operatorRepairRequired: z.literal(true).optional(),
  checking: z.literal(true).optional(),
})
export type AppDomain = z.infer<typeof AppDomainSchema>

export const AppDomainSummarySchema = AppDomainSchema.pick({ hostname: true, status: true })
export type AppDomainSummary = z.infer<typeof AppDomainSummarySchema>

export const AttachAppDomainRequestSchema = z.strictObject({
  hostname: utf8BoundedString(4_096, 'Domain input').min(1),
})

export const AppDomainResponseSchema = z.object({ domain: AppDomainSchema.nullable() })
export type AppDomainResponse = z.infer<typeof AppDomainResponseSchema>

export const WorkspaceAppDomainRowSchema = z.object({
  domain: AppDomainSchema,
  app: z.object({
    id: z.string(),
    slug: AppSlugSchema,
    name: AppNameSchema.optional(),
    controls: AppControlsSchema.pick({ manageDomain: true }),
  }),
})
export type WorkspaceAppDomainRow = z.infer<typeof WorkspaceAppDomainRowSchema>
export const AppDomainListResponseSchema = collectionPageSchema(WorkspaceAppDomainRowSchema)
export type AppDomainListResponse = z.infer<typeof AppDomainListResponseSchema>

export const AppDomainErrorSchema = z.object({
  error: z.enum([
    'invalid_request',
    'invalid_cursor',
    'forbidden',
    'domain_occupied',
    'hostname_in_use',
    'domain_cleanup_pending',
    'domain_not_configured',
    'not_found',
  ]),
})
export type AppDomainError = z.infer<typeof AppDomainErrorSchema>['error']
