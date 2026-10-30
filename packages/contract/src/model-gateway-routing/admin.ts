import { z } from 'zod'

import { ModelRouterPolicySchema, ModelRouterRuleSchema } from './index'

/** Payload accepted by the internal model-router policy editor. */
export const InternalAdminModelRouterPolicyRequestSchema = z.object({
  rules: z.array(ModelRouterRuleSchema).max(100),
  reason: z.string().trim().min(3).max(500),
})
export type InternalAdminModelRouterPolicyRequest = z.infer<
  typeof InternalAdminModelRouterPolicyRequestSchema
>

/** Policy plus the audit row created for the operator read or write. */
export const InternalAdminModelRouterPolicySchema = ModelRouterPolicySchema.extend({
  auditId: z.string().min(1),
})
export type InternalAdminModelRouterPolicy = z.infer<typeof InternalAdminModelRouterPolicySchema>
