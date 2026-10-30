import { z } from 'zod'

export const ConnectedProviderIdSchema = z.enum(['openai-codex', 'github-copilot'])
export type ConnectedProviderId = z.infer<typeof ConnectedProviderIdSchema>

export const ConnectedProviderStatusSchema = z
  .object({
    provider: ConnectedProviderIdSchema,
    state: z.enum(['connected', 'plan_ineligible', 'reconnect_needed']),
    connectedAt: z.number(),
    connectedByUserId: z.string().optional(),
    connectedByLabel: z.string().optional(),
    eligibilityCheckedAt: z.number().optional(),
  })
  // Status records ride responses (poll) and VM observations alike; strip so
  // independently deployed consumers tolerate additive fields.
  .strip()
export type ConnectedProviderStatus = z.infer<typeof ConnectedProviderStatusSchema>

export const ConnectStartRequestSchema = z.object({ provider: ConnectedProviderIdSchema })
export type ConnectStartRequest = z.infer<typeof ConnectStartRequestSchema>

export const ConnectStartResponseSchema = z
  .object({
    sessionId: z.string(),
    intervalMs: z.number(),
  })
  .strip()
export type ConnectStartResponse = z.infer<typeof ConnectStartResponseSchema>

export const ConnectPollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strip(),
  z
    .object({
      status: z.literal('awaiting_code'),
      userCode: z.string(),
      verificationUri: z.string(),
      expiresAt: z.number(),
    })
    .strip(),
  z.object({ status: z.literal('connected'), connection: ConnectedProviderStatusSchema }).strip(),
  z
    .object({
      status: z.literal('failed'),
      reason: z.enum(['denied', 'expired', 'plan_ineligible', 'error']),
      // Present on plan_ineligible so the backend can attribute the persisted
      // (but ineligible) credential to the member who initiated the connect.
      provider: ConnectedProviderIdSchema.optional(),
      detail: z.string().optional(),
    })
    .strip(),
])
export type ConnectPollResponse = z.infer<typeof ConnectPollResponseSchema>
