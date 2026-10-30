import { z } from 'zod'

import { AgentTagSchema } from '../agents/index'
import { MarketplaceAgentNameSchema } from '../marketplace/index'
import { WorkspacePurposeSchema } from '../workspaces/index'

export const MAX_ONBOARDING_TAG_HINTS = 3
export const MAX_ONBOARDING_RECOMMENDATION_REASON_LENGTH = 200

export const OnboardingRecommendationsRequestSchema = z.object({
  purpose: WorkspacePurposeSchema,
  // A soft prior for the recommender, computed client-side from the goal
  // catalog — the server never learns goal ids, only closed-vocabulary tags.
  tagHints: z.array(AgentTagSchema).max(MAX_ONBOARDING_TAG_HINTS).optional(),
})
export type OnboardingRecommendationsRequest = z.infer<
  typeof OnboardingRecommendationsRequestSchema
>

export const OnboardingRecommendationSchema = z.object({
  agentName: MarketplaceAgentNameSchema,
  reason: z.string().trim().min(1).max(MAX_ONBOARDING_RECOMMENDATION_REASON_LENGTH),
})
export type OnboardingRecommendation = z.infer<typeof OnboardingRecommendationSchema>

// Exactly 4 or nothing: a one-item "recommendation" reads as broken UI, so
// sanitization collapses partial results to empty and the wire refuses to
// transport them. Empty means the team step renders the plain catalog.
export const OnboardingRecommendationsResponseSchema = z.object({
  recommendations: z.union([
    z.array(OnboardingRecommendationSchema).length(4),
    z.array(OnboardingRecommendationSchema).length(0),
  ]),
})
export type OnboardingRecommendationsResponse = z.infer<
  typeof OnboardingRecommendationsResponseSchema
>

export const OnboardingPaymentIntentRequestSchema = z.object({
  attemptId: z.string().trim().min(8).max(200),
})
export type OnboardingPaymentIntentRequest = z.infer<typeof OnboardingPaymentIntentRequestSchema>

export const OnboardingPaymentIntentResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    paymentMethodReadyAt: z.number().int().positive(),
  }),
  z.object({
    status: z.literal('requires_confirmation'),
    attemptId: z.string().min(1),
    paymentIntentId: z.string().min(1),
    clientSecret: z.string().min(1),
    publishableKey: z.string().min(1),
    amount: z.literal(1000),
    currency: z.literal('usd'),
  }),
  z.object({
    status: z.literal('pending'),
    attemptId: z.string().min(1),
    paymentIntentId: z.string().min(1),
    clientSecret: z.string().min(1),
    publishableKey: z.string().min(1),
    amount: z.literal(1000),
    currency: z.literal('usd'),
  }),
])
export type OnboardingPaymentIntentResponse = z.infer<typeof OnboardingPaymentIntentResponseSchema>

export const OnboardingBillingDetailsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  address: z.object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().max(100).optional(),
    postalCode: z.string().trim().min(1).max(30),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/),
  }),
})
export type OnboardingBillingDetails = z.infer<typeof OnboardingBillingDetailsSchema>

export const OnboardingPaymentCompleteRequestSchema = z.object({
  attemptId: z.string().trim().min(8).max(200),
  paymentIntentId: z.string().trim().min(1),
  billingDetails: OnboardingBillingDetailsSchema,
})
export type OnboardingPaymentCompleteRequest = z.infer<
  typeof OnboardingPaymentCompleteRequestSchema
>

export const OnboardingPaymentStatusSchema = z.object({
  ready: z.boolean(),
  paymentMethodReadyAt: z.number().int().positive().optional(),
  attemptId: z.string().min(1).optional(),
  paymentIntentId: z.string().min(1).optional(),
  status: z
    .enum([
      'idle',
      'requires_confirmation',
      'requires_action',
      'requires_capture',
      'canceling',
      'canceled',
      'ready',
      'failed',
    ])
    .optional(),
})
export type OnboardingPaymentStatus = z.infer<typeof OnboardingPaymentStatusSchema>
