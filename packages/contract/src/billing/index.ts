import { z } from 'zod'

import {
  MicroUsdAmountSchema,
  MIN_AUTO_TOPUP_AMOUNT_MICRO_USD,
  MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD,
} from '../ledger/index'
import { RecordedAttributionTierIdSchema } from '../model-tiers/index'
import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'
import { SubscriptionPlanIdSchema } from '../plans/index'
import { WorkspaceSlugSchema } from '../slug/index'
import { utf8BoundedString } from '../utf8/index'
import { WorkspaceNameSchema } from '../workspaces/name'

export const MAX_CREDIT_TRANSACTION_METADATA_JSON_BYTES = 16 * 1024
export const MAX_CREDIT_TRANSACTION_REFERENCE_UTF8_BYTES = 512
export const CreditTransactionReferenceSchema = utf8BoundedString(
  MAX_CREDIT_TRANSACTION_REFERENCE_UTF8_BYTES,
  'Credit transaction reference',
).min(1)

export const UsageReportGroupSchema = z.enum(['workspace', 'user', 'app'])
export type UsageReportGroup = z.infer<typeof UsageReportGroupSchema>

export const UsageReportPeriodSchema = z.enum(['daily', 'weekly', 'monthly'])
export type UsageReportPeriod = z.infer<typeof UsageReportPeriodSchema>

export const UsageReportQuerySchema = z.object({
  period: UsageReportPeriodSchema.default('monthly'),
  group: UsageReportGroupSchema.default('workspace'),
  start: z.string().optional(),
  end: z.string().optional(),
})

const UsageReportRowSchema = z.object({
  workspaceId: z.string(),
  period: z.string(),
  spendMicroUsd: MicroUsdAmountSchema,
  userId: z.string().optional(),
  appId: z.string().optional(),
  appSlug: z.string().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
})

export const UsageReportResponseSchema = z.object({
  period: UsageReportPeriodSchema,
  group: UsageReportGroupSchema,
  rows: z.array(UsageReportRowSchema),
})
export type UsageReportResponse = z.infer<typeof UsageReportResponseSchema>

const NonnegativeMicroUsdAmountSchema = MicroUsdAmountSchema.nonnegative()
const AutoTopupAmountMicroUsdSchema = MicroUsdAmountSchema.min(MIN_AUTO_TOPUP_AMOUNT_MICRO_USD)
const AutoTopupThresholdMicroUsdSchema = MicroUsdAmountSchema.min(
  MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD,
)

export const BillingTopupConfigSchema = z.object({
  autoTopupEnabled: z.boolean().optional(),
  autoTopupThresholdMicroUsd: AutoTopupThresholdMicroUsdSchema.optional(),
  autoTopupAmountMicroUsd: AutoTopupAmountMicroUsdSchema.optional(),
  maxMonthlySpendMicroUsd: NonnegativeMicroUsdAmountSchema.optional(),
})

const BillingTopupConfigResponseSchema = BillingTopupConfigSchema.extend({
  autoTopupThresholdMicroUsd: AutoTopupThresholdMicroUsdSchema,
  stripeCustomerId: z.string().optional(),
  // monthlySpend* is spend-cap telemetry, not the monthly subscription credit bucket.
  monthlySpendMicroUsd: MicroUsdAmountSchema,
  monthlySpendPeriodKey: z.string().optional(),
  balanceMicroUsd: MicroUsdAmountSchema,
  lastTopupError: z.object({ code: z.string(), message: z.string(), at: z.number() }).optional(),
  consecutiveTopupFailures: z.number().int(),
  firstPaidAt: z.number().optional(),
})

export const BillingWorkspaceSchema = z.object({
  id: z.string(),
  slug: WorkspaceSlugSchema,
  name: z.string(),
  storage: z.object({
    usableGb: z.number(),
    usedBytes: z.number().optional(),
    sampledAt: z.number().optional(),
    plan: SubscriptionPlanIdSchema,
    nextPlan: SubscriptionPlanIdSchema.optional(),
    nextUsableGb: z.number().optional(),
  }),
})
export type BillingWorkspace = z.infer<typeof BillingWorkspaceSchema>

// Mirrors Stripe's complete subscription status vocabulary.
export const SubscriptionStatusSchema = z.enum([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
])
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>

export const UserSubscriptionSchema = z.object({
  plan: SubscriptionPlanIdSchema,
  status: SubscriptionStatusSchema,
  // Derived at read time from the subscription status and paid-through boundary; never persisted.
  isActive: z.boolean(),
  currentPeriodStart: z.number(),
  currentPeriodEnd: z.number(),
  // Derived from the last accepted paid invoice, not the lifecycle period alone.
  creditsExpireAt: z.number(),
  cancelAtPeriodEnd: z.boolean(),
  pendingPlan: SubscriptionPlanIdSchema.optional(),
})
export type UserSubscription = z.infer<typeof UserSubscriptionSchema>

const TrialStatusSchema = z.enum(['available', 'exhausted', 'ended'])

export const UserBillingOverviewSchema = BillingTopupConfigResponseSchema.omit({
  stripeCustomerId: true,
})
  .extend({
    paidCreditBalanceMicroUsd: MicroUsdAmountSchema,
    monthlyCreditBalanceMicroUsd: MicroUsdAmountSchema,
    subscription: UserSubscriptionSchema.nullable(),
    trial: z.object({ status: TrialStatusSchema }),
    hasPaymentMethod: z.boolean(),
    workspaces: z.array(BillingWorkspaceSchema),
  })
  .superRefine((overview, ctx) => {
    if (
      overview.balanceMicroUsd !==
      overview.paidCreditBalanceMicroUsd + overview.monthlyCreditBalanceMicroUsd
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['balanceMicroUsd'],
        message: 'balance must equal paid plus monthly credits',
      })
    }
  })
export type UserBillingOverview = z.infer<typeof UserBillingOverviewSchema>

export const UserBillingConfigRequestSchema = BillingTopupConfigSchema.omit({
  maxMonthlySpendMicroUsd: true,
})
  .extend({
    workspaceSlug: WorkspaceSlugSchema,
    maxMonthlySpendMicroUsd: NonnegativeMicroUsdAmountSchema.nullable().optional(),
  })
  .strict()

export const BillingHostedSessionRequestSchema = z.object({
  workspaceSlug: WorkspaceSlugSchema,
  amountMicroUsd: MicroUsdAmountSchema.min(MIN_AUTO_TOPUP_AMOUNT_MICRO_USD).optional(),
})
export const BillingPortalRequestSchema = z.object({ workspaceSlug: WorkspaceSlugSchema })
export const BillingHostedSessionResponseSchema = z.object({
  url: z.url(),
  // Route-created hosted resources join staging's external cleanup ledger.
  sessionId: z.string().optional(),
})
export const SubscriptionCheckoutRequestSchema = z.object({
  workspaceSlug: WorkspaceSlugSchema,
  plan: SubscriptionPlanIdSchema,
})
export const SubscriptionPlanChangeRequestSchema = z.union([
  z.object({ workspaceSlug: WorkspaceSlugSchema, plan: SubscriptionPlanIdSchema }),
  z.object({ workspaceSlug: WorkspaceSlugSchema, cancel: z.literal(true) }),
  z.object({ workspaceSlug: WorkspaceSlugSchema, resume: z.literal(true) }),
])
export type SubscriptionPlanChangeRequest = z.infer<typeof SubscriptionPlanChangeRequestSchema>
export const SubscriptionPlanChangeResponseSchema = z.object({ ok: z.literal(true) })
export type SubscriptionPlanChangeResponse = z.infer<typeof SubscriptionPlanChangeResponseSchema>

export const TransactionTypeSchema = z.enum([
  'grant',
  'topup',
  'usage',
  'adjustment',
  'reservation',
  'subscription_grant',
  'subscription_expiry',
])
export type TransactionType = z.infer<typeof TransactionTypeSchema>

const BillingHistoryItemBaseSchema = z.object({
  id: z.string(),
  amountMicroUsd: MicroUsdAmountSchema,
  type: TransactionTypeSchema,
  // Narrows a `usage` row to a non-model charge so billing history can name it.
  // Absent means model spend, which is every other usage row.
  usageKind: z.enum(['vm_compute']).optional(),
  createdAt: z.number().int().positive(),
})
const BillingHistoryItemSchema = z.discriminatedUnion('scope', [
  BillingHistoryItemBaseSchema.extend({ scope: z.literal('account') }),
  BillingHistoryItemBaseSchema.extend({
    scope: z.literal('workspace'),
    workspaceId: z.string(),
    workspaceName: WorkspaceNameSchema,
  }),
])
export const BillingHistoryQuerySchema = CollectionPageQuerySchema
export const BillingHistoryPageSchema = collectionPageSchema(BillingHistoryItemSchema)
export type BillingHistoryResponse = z.infer<typeof BillingHistoryPageSchema>

// The workspace-scoped transaction ledger. actorUserId is the member whose
// activity produced the entry; internal references and metadata stay private.
export const WorkspaceLedgerEntrySchema = z.object({
  id: z.string(),
  amountMicroUsd: MicroUsdAmountSchema,
  type: TransactionTypeSchema,
  actorUserId: z.string().optional(),
  tier: RecordedAttributionTierIdSchema.optional(),
  createdAt: z.number().int().positive(),
})
export type WorkspaceLedgerEntry = z.infer<typeof WorkspaceLedgerEntrySchema>

export const WorkspaceLedgerQuerySchema = CollectionPageQuerySchema
export const WorkspaceLedgerPageSchema = collectionPageSchema(WorkspaceLedgerEntrySchema)
export type WorkspaceLedgerResponse = z.infer<typeof WorkspaceLedgerPageSchema>
