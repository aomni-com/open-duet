import { ConvexError } from 'convex/values'

import {
  OnboardingPaymentCompleteRequestSchema,
  OnboardingPaymentIntentRequestSchema,
  OnboardingPaymentIntentResponseSchema,
  OnboardingPaymentStatusSchema,
  OnboardingRecommendationsRequestSchema,
  OnboardingRecommendationsResponseSchema,
} from '@repo/contract'

import {
  fnAction,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  type ApiContext,
  type ApiApp,
  type ApiRouteRuntime,
  type WorkspaceRef,
} from '../shared'

export function registerOnboardingRoutes(app: ApiApp, runtime: ApiRouteRuntime): void {
  app.get('/v1/ws/:workspaceSlug/onboarding/payment-method', async c => {
    const workspace = requireOnboardingOwner(c)
    if ('response' in workspace) return workspace.response
    const result = await runtime.convex.query(
      fnQuery('domains/credits/internal:getOnboardingPaymentStatus'),
      {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
      },
    )
    return c.json(OnboardingPaymentStatusSchema.parse(result))
  })

  app.post('/v1/ws/:workspaceSlug/onboarding/payment-method/intent', async c => {
    const workspace = requireOnboardingOwner(c)
    if ('response' in workspace) return workspace.response
    const body = OnboardingPaymentIntentRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const result = await runtime.convex.action(
        fnAction('domains/credits/billingActions:createOnboardingPaymentIntent'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          attemptId: body.data.attemptId,
          now: runtime.now(),
        },
      )
      return c.json(OnboardingPaymentIntentResponseSchema.parse(result))
    } catch (error) {
      return onboardingPaymentError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/onboarding/payment-method/complete', async c => {
    const workspace = requireOnboardingOwner(c)
    if ('response' in workspace) return workspace.response
    const body = OnboardingPaymentCompleteRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const result = await runtime.convex.action(
        fnAction('domains/credits/billingActions:completeOnboardingPayment'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          attemptId: body.data.attemptId,
          paymentIntentId: body.data.paymentIntentId,
          billingDetails: body.data.billingDetails,
          now: runtime.now(),
        },
      )
      return c.json(OnboardingPaymentStatusSchema.parse(result))
    } catch (error) {
      return onboardingPaymentError(c, error)
    }
  })

  // Owner-only and gone once onboarded: the window is what keeps the
  // platform-paid LLM from becoming a free general endpoint.
  app.post('/v1/ws/:workspaceSlug/onboarding/recommendations', async c => {
    const workspace = requireOnboardingOwner(c)
    if ('response' in workspace) return workspace.response
    const body = OnboardingRecommendationsRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)

    // Once the guards pass the answer is always 200 in the response shape:
    // recommendations degrade to empty, they never surface an error.
    try {
      const result = await runtime.convex.action(
        fnAction('domains/onboarding/recommend:recommend'),
        {
          internalKey: runtime.internalKey,
          purpose: body.data.purpose,
          ...(body.data.tagHints === undefined ? {} : { tagHints: body.data.tagHints }),
        },
      )
      return c.json(OnboardingRecommendationsResponseSchema.parse(result))
    } catch {
      return c.json({ recommendations: [] })
    }
  })
}

function onboardingPaymentError(c: ApiContext, error: unknown) {
  if (error instanceof ConvexError) {
    const data = error.data as { error?: unknown; code?: unknown } | string
    const code = typeof data === 'string' ? data : (data.code ?? data.error)
    if (code === 'payment_method_required') {
      return c.json({ error: 'payment_method_required', code: 'payment_method_required' }, 409)
    }
    if (code === 'payment_attempt_invalid') {
      return c.json({ error: 'payment_attempt_invalid', code: 'payment_attempt_invalid' }, 409)
    }
  }
  const message = error instanceof Error ? error.message : ''
  if (message.includes('Payment method') || message.includes('payment method')) {
    return c.json({ error: 'payment_method_required', code: 'payment_method_required' }, 409)
  }
  if (message.includes('attempt mismatch') || message.includes('valid onboarding authorization')) {
    return c.json({ error: 'payment_attempt_invalid', code: 'payment_attempt_invalid' }, 409)
  }
  return c.json({ error: 'payment_setup_failed', code: 'payment_setup_failed' }, 502)
}

function requireOnboardingOwner(c: ApiContext): WorkspaceRef | { response: Response } {
  const workspace = requireAuthedWorkspace(c, 'agents', { allowIncomplete: true })
  if ('response' in workspace) return workspace
  if (workspace.role !== 'owner') return { response: c.json({ error: 'forbidden' }, 403) }
  const summary = c.get('auth').workspaces.find(candidate => candidate.id === workspace.id)
  if (summary === undefined || summary.onboardedAt !== undefined) {
    return { response: c.json({ error: 'already_onboarded' }, 409) }
  }
  return workspace
}
