import type { Infer } from 'convex/values'

import {
  APPROVED_MODELS,
  assertSingleWorkspaceScopes,
  modelByGatewayId,
  scopeSetSatisfies,
  type ApprovedModelCatalog,
} from '@repo/contract'

import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { stampCredentialUse } from '../apiKeys/authenticate'
import {
  authorizedAppKeyPayload,
  grantableScopesForWorkspaceRole,
  liveWorkspaceBySlug,
  requireApiInternalKey,
} from '../apiKeys/model'
import { authorizeSpend } from '../credits/creditsShared'
import { runPreflightWithDb, scheduleReconcileServicingStatusIfRequired } from '../credits/ledger'
import { reserveCreditsWithDb } from '../credits/reservations'
import { workspaceMonthlySpend } from '../credits/workspaceSpend'
import {
  blocked,
  insufficientScopeBlock,
  modelNotAllowedBlock,
  paymentBlock,
  preflightBlock,
  rateLimitBlock,
  unauthorizedBlock,
} from './blocks'
import { createPendingGenerationWithDb } from './generations'
import type { gatewayPreflightArgs } from './model'
import { consumeWorkspaceRateLimitWithDb, workspaceRateLimitConfig } from './rateLimit'

export async function gatewayPreflightImpl(
  ctx: MutationCtx,
  args: Infer<typeof gatewayPreflightArgs>,
  catalog: ApprovedModelCatalog = APPROVED_MODELS,
) {
  requireApiInternalKey(args.internalKey)
  const now = args.now ?? Date.now()
  const key = await ctx.db
    .query('apiKeys')
    .withIndex('by_hashedKey', q => q.eq('hashedKey', args.hashedKey))
    .unique()
  if (key === null)
    return blocked(unauthorizedBlock(args.hashedKey === '' ? 'missing_api_key' : 'invalid_api_key'))
  if (key.revokedAt !== undefined) return blocked(unauthorizedBlock('invalid_api_key'))
  if (key.expiresAt !== undefined && key.expiresAt <= now)
    return blocked(unauthorizedBlock('expired_api_key'))

  if (key.kind === 'user' && !args.workspaceSlug)
    return blocked({
      status: 403,
      body: {
        error: 'Choose a billing workspace with duet workspace use, or send x-duet-workspace.',
        code: 'workspace_ambiguous',
      },
    })
  let workspace
  let scopes
  if (key.kind === 'user') {
    const selectedWorkspace = await liveWorkspaceBySlug(ctx, args.workspaceSlug!)
    if (selectedWorkspace === null)
      return blocked(insufficientScopeBlock(`ws:${args.workspaceSlug}:services`))
    const membership = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', selectedWorkspace._id).eq('userId', key.userId),
      )
      .unique()
    workspace = selectedWorkspace
    scopes =
      membership === null ? [] : grantableScopesForWorkspaceRole(workspace.slug, membership.role)
  } else {
    assertSingleWorkspaceScopes(key.scopes)
    if (key.workspaceIds.length !== 1) throw new Error('API key must map to exactly one workspace')
    workspace = await ctx.db.get(key.workspaceIds[0]!)
    scopes = key.scopes
    if (
      workspace !== null &&
      args.workspaceSlug !== undefined &&
      args.workspaceSlug !== workspace.slug
    )
      return blocked({
        status: 403,
        body: {
          error: 'The workspace selector conflicts with this credential.',
          code: 'workspace_mismatch',
        },
      })
  }
  // Only a workspace that is gone for good blocks. Liveness states pass:
  // `unhealthy` is stamped by the health sweep on a late heartbeat, which
  // happens precisely when the VM is busy running a turn — and this request
  // arriving at all proves the VM is up. Rejecting it killed that turn's own
  // model calls over a missed heartbeat, mislabeled as a credential failure.
  if (
    workspace === null ||
    workspace.status === 'archived' ||
    workspace.status === 'retired' ||
    workspace.status === 'deleted'
  ) {
    return blocked(unauthorizedBlock('invalid_api_key'))
  }
  const user = await ctx.db.get(key.userId)
  if (user === null) return blocked(unauthorizedBlock('invalid_api_key'))
  await stampCredentialUse(ctx, key, now)

  const requiredScope = `ws:${workspace.slug}:services`
  if (!scopeSetSatisfies(scopes, requiredScope))
    return blocked(insufficientScopeBlock(requiredScope))
  if (workspace.onboardedAt === undefined) {
    return blocked({
      status: 409,
      body: {
        error: 'onboarding_required',
        code: 'onboarding_required',
        onboardingUrl: `/w/${workspace.slug}/onboarding`,
      },
    })
  }
  const appAttribution = await appAttributionForKey(ctx, key)
  if (key.kind === 'app' && appAttribution === undefined) {
    return blocked(unauthorizedBlock('invalid_api_key'))
  }

  const servicingStatus = workspace.servicingStatus ?? 'active'
  if (servicingStatus === 'paused') return blocked(paymentBlock('subscription_inactive'))
  if (servicingStatus === 'banned') return blocked(paymentBlock('payment_required'))

  let generation: { model: string; chargeToWorkspace: boolean } | undefined
  let billingUser
  if (args.requestKind === 'generation') {
    // The proxy always derives a model for generation requests; a missing one
    // here is an invalid request, not a passthrough.
    if (typeof args.model !== 'string' || args.model.length === 0) {
      return blocked(modelNotAllowedBlock())
    }
    // Upstream validates model availability. The catalog only identifies free
    // models here; an unknown model follows ordinary workspace spending checks.
    const approvedModel = modelByGatewayId(catalog, args.model)
    billingUser = await ctx.db.get(workspace.billingUserId)
    generation = { model: args.model, chargeToWorkspace: approvedModel?.isFree !== true }
  }

  const billingMode = args.billingMode ?? 'post_response'
  if (generation?.chargeToWorkspace) {
    if (billingUser === null || billingUser === undefined) throw new Error('Billing user not found')
    const entitlementDecision = authorizeSpend(workspace, billingUser, {
      workspaceMonthlySpendMicroUsd: await workspaceMonthlySpend(ctx, workspace, now),
      estimatedCostMicroUsd: args.estimateMicroUsd,
      ...(billingMode === 'reservation' ? { reservedCostMicroUsd: args.estimateMicroUsd } : {}),
      now,
    })
    await scheduleReconcileServicingStatusIfRequired(ctx, billingUser, entitlementDecision)
    if (!entitlementDecision.proceed && entitlementDecision.reason === 'subscription_required') {
      return blocked(
        preflightBlock(entitlementDecision.reason, undefined, entitlementDecision.balanceMicroUsd),
      )
    }
  }

  const rateLimitConfig = workspaceRateLimitConfig(args.requestKind)
  const rateLimit = await consumeWorkspaceRateLimitWithDb(ctx, {
    workspaceId: workspace._id,
    endpoint: args.requestKind,
    limit: rateLimitConfig.limit,
    windowMs: rateLimitConfig.windowMs,
    now,
  })
  if (!rateLimit.ok) return blocked(rateLimitBlock(rateLimit.retryAfterSeconds))

  if (generation === undefined) {
    return {
      proceed: true as const,
      workspaceId: workspace._id,
      workspaceSlug: workspace.slug,
      userId: key.userId,
    }
  }

  if (!generation.chargeToWorkspace) {
    const { generationId } = await createPendingGenerationWithDb(ctx, {
      workspaceId: workspace._id,
      userId: key.userId,
      modality: args.modality,
      model: generation.model,
      tier: args.tier,
      billingMode,
      chargeToWorkspace: generation.chargeToWorkspace,
      ...appAttribution,
      now,
    })
    return {
      proceed: true as const,
      workspaceId: workspace._id,
      workspaceSlug: workspace.slug,
      userId: key.userId,
      generationId,
    }
  }
  if (billingMode === 'reservation') {
    const reservation = await reserveCreditsWithDb(ctx, {
      workspaceId: workspace._id,
      estimateMicroUsd: args.estimateMicroUsd,
      reference: `ai_generation:${crypto.randomUUID()}`,
      userId: key.userId,
      metadata: { modality: args.modality, model: generation.model },
      now,
    })
    if (!reservation.proceed)
      return blocked(
        preflightBlock(reservation.reason, reservation.tier, reservation.balanceMicroUsd),
      )
    if (reservation.reservationId === undefined)
      throw new Error('Reservation preflight succeeded without reservation id')
    const { generationId } = await createPendingGenerationWithDb(ctx, {
      workspaceId: workspace._id,
      userId: key.userId,
      modality: args.modality,
      model: generation.model,
      tier: args.tier,
      billingMode,
      chargeToWorkspace: generation.chargeToWorkspace,
      reservationId: reservation.reservationId,
      ...appAttribution,
      now,
    })
    return {
      proceed: true as const,
      workspaceId: workspace._id,
      workspaceSlug: workspace.slug,
      userId: key.userId,
      generationId,
      reservationId: reservation.reservationId,
    }
  }

  const preflight = await runPreflightWithDb(ctx, {
    workspaceId: workspace._id,
    userId: key.userId,
    estimatedCostMicroUsd: args.estimateMicroUsd,
    now,
  })
  if (!preflight.proceed)
    return blocked(preflightBlock(preflight.reason, preflight.tier, preflight.balanceMicroUsd))
  const { generationId } = await createPendingGenerationWithDb(ctx, {
    workspaceId: workspace._id,
    userId: key.userId,
    modality: args.modality,
    model: generation.model,
    tier: args.tier,
    billingMode,
    chargeToWorkspace: generation.chargeToWorkspace,
    ...appAttribution,
    now,
  })
  return {
    proceed: true as const,
    workspaceId: workspace._id,
    workspaceSlug: workspace.slug,
    userId: key.userId,
    generationId,
  }
}

async function appAttributionForKey(
  ctx: MutationCtx,
  key: Doc<'apiKeys'>,
): Promise<{ appId: Doc<'apps'>['_id']; appSlug: string } | undefined> {
  if (key.kind !== 'app') return undefined
  const authorized = await authorizedAppKeyPayload(ctx, key)
  if (authorized === null) return undefined
  return { appId: authorized.app.id, appSlug: authorized.app.slug }
}
