import { z } from 'zod'

import { JsonObjectSchema, JsonValueSchema } from '../analytics'

export const UTM_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const

export const AD_CLICK_PARAMS = ['gclid', 'gbraid', 'wbraid', 'rdt_cid', 'fbclid', 'oppref'] as const

export const ATTRIBUTION_SIGNAL_KEYS = [
  ...UTM_PARAMS,
  ...AD_CLICK_PARAMS,
  'referrer',
  'sourceUrl',
  'ip',
  'userAgent',
] as const

export type AttributionSignalKey = (typeof ATTRIBUTION_SIGNAL_KEYS)[number]
export type AttributionSignals = Partial<Record<AttributionSignalKey, string>>

const attributionSignalKeySet = new Set<string>(ATTRIBUTION_SIGNAL_KEYS)
export function normalizeAttributionSignals(input: unknown): AttributionSignals {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const normalized: AttributionSignals = {}
  for (const [key, rawValue] of Object.entries(input)) {
    if (!attributionSignalKeySet.has(key) || typeof rawValue !== 'string') continue
    const value = rawValue.trim()
    if (value.length === 0) continue
    normalized[key as AttributionSignalKey] = value
  }
  return normalized
}

export const CampaignLeadDataSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    source: z.string().optional(),
    pageSlug: z.string().optional(),
    company: z
      .object({
        name: z.string().optional(),
        url: z.string().optional(),
      })

      .optional(),
  })
  .catchall(JsonValueSchema)
  .refine(value => JsonObjectSchema.safeParse(value).success, {
    message: 'Expected lead data no larger than 64 KiB',
  })

export const CampaignLeadRequestSchema = z.object({
  data: CampaignLeadDataSchema,
})

export type CampaignLeadRequest = z.infer<typeof CampaignLeadRequestSchema>

export const CampaignLeadResponseSchema = z.object({
  leadId: z.string().min(1),
})

export type CampaignLeadResponse = z.infer<typeof CampaignLeadResponseSchema>
