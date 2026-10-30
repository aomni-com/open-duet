import type { PaginationResult } from 'convex/server'

import {
  BillingHistoryPageSchema,
  BillingHistoryQuerySchema,
  BillingHostedSessionRequestSchema,
  BillingHostedSessionResponseSchema,
  BillingPortalRequestSchema,
  isCollectionCursorError,
  SubscriptionCheckoutRequestSchema,
  SubscriptionPlanChangeRequestSchema,
  SubscriptionPlanChangeResponseSchema,
  UsageReportGroupSchema,
  UsageReportPeriodSchema,
  UserBillingConfigRequestSchema,
  UserBillingOverviewSchema,
  WorkspaceLedgerQuerySchema,
  WorkspaceLedgerPageSchema,
} from '@repo/contract'

import { createConvexCollectionPage } from '../collection-page'
import {
  appHref,
  fn,
  fnAction,
  fnQuery,
  readJson,
  requireHumanActor,
  requireWorkspaceMember,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
} from '../shared'

const workspaceLedgerPages = createConvexCollectionPage('billing.ledger')
const billingHistoryPages = createConvexCollectionPage('user-billing-history')

export function registerBillingRoutes(app: ApiApp, runtime: ApiRouteRuntime): void {
  app.get('/v1/ws/:workspaceSlug/billing/usage', async c => {
    const workspace = requireWorkspaceMember(c)
    if ('response' in workspace) return workspace.response
    const url = new URL(c.req.url)
    const period = UsageReportPeriodSchema.safeParse(url.searchParams.get('period') ?? 'monthly')
    const group = UsageReportGroupSchema.safeParse(url.searchParams.get('group') ?? 'workspace')
    if (!period.success || !group.success) return c.json({ error: 'invalid_request' }, 400)
    const rows = await runtime.convex.query(fnQuery('domains/credits/internal:listUsageReport'), {
      internalKey: runtime.internalKey,
      actorId: c.get('auth').user.id,
      workspaceId: workspace.id,
      period: period.data,
      group: group.data,
      start: url.searchParams.get('start') ?? undefined,
      end: url.searchParams.get('end') ?? undefined,
    })
    return c.json({ period: period.data, group: group.data, rows })
  })

  app.get('/v1/ws/:workspaceSlug/billing/ledger', async c => {
    const workspace = requireWorkspaceMember(c)
    if ('response' in workspace) return workspace.response
    const url = new URL(c.req.url)
    const query = WorkspaceLedgerQuerySchema.safeParse(Object.fromEntries(url.searchParams))
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: workspace.id,
      filters: {},
      order: 'createdAt:desc,id:desc',
    }
    try {
      const result = (await runtime.convex.query(
        fnQuery('domains/credits/internal:workspaceLedger'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          paginationOpts: await workspaceLedgerPages.paginationOpts(query.data, binding),
        },
      )) as PaginationResult<unknown>
      return c.json(
        WorkspaceLedgerPageSchema.parse(await workspaceLedgerPages.response(result, binding)),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
  })

  app.get('/v1/user/billing', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const result = await runtime.convex.query(
      fnQuery('domains/credits/internal:getUserBillingOverview'),
      { internalKey: runtime.internalKey, actorId: session.userId, now: runtime.now() },
    )
    return c.json(UserBillingOverviewSchema.parse(result))
  })

  app.put('/v1/user/billing', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const body = UserBillingConfigRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const workspace = c
      .get('auth')
      .workspaces.find(candidate => candidate.slug === body.data.workspaceSlug)
    if (workspace === undefined) return c.json({ error: 'not_found' }, 404)
    try {
      const { workspaceSlug: _workspaceSlug, ...config } = body.data
      await runtime.convex.mutation(fn('domains/credits/internal:updateUserBilling'), {
        internalKey: runtime.internalKey,
        actorId: session.userId,
        workspaceId: workspace.id,
        ...config,
        now: runtime.now(),
      })
      const result = await runtime.convex.query(
        fnQuery('domains/credits/internal:getUserBillingOverview'),
        { internalKey: runtime.internalKey, actorId: session.userId, now: runtime.now() },
      )
      return c.json(UserBillingOverviewSchema.parse(result))
    } catch (error) {
      return billingError(c, error)
    }
  })

  app.get('/v1/user/billing/history', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const query = BillingHistoryQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = { subject: session.userId, filters: {}, order: 'createdAt:desc,id:desc' }
    try {
      const result = (await runtime.convex.query(
        fnQuery('domains/credits/internal:getBillingHistory'),
        {
          internalKey: runtime.internalKey,
          actorId: session.userId,
          paginationOpts: await billingHistoryPages.paginationOpts(query.data, binding),
        },
      )) as PaginationResult<unknown>
      return c.json(
        BillingHistoryPageSchema.parse(await billingHistoryPages.response(result, binding)),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
  })

  app.post('/v1/user/billing/checkout', async c => {
    return hostedBillingSession(c, runtime, 'checkout')
  })

  app.post('/v1/user/billing/subscription/checkout', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const body = SubscriptionCheckoutRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const workspace = c
      .get('auth')
      .workspaces.find(candidate => candidate.slug === body.data.workspaceSlug)
    if (workspace === undefined) return c.json({ error: 'not_found' }, 404)
    try {
      const result = await runtime.convex.action(
        fnAction('domains/credits/billingActions:createSubscriptionCheckout'),
        {
          internalKey: runtime.internalKey,
          actorId: session.userId,
          workspaceId: workspace.id,
          plan: body.data.plan,
          returnUrl: appHref(runtime.appUrl, '/settings/billing'),
          now: runtime.now(),
        },
      )
      return c.json(BillingHostedSessionResponseSchema.parse(result))
    } catch (error) {
      return billingError(c, error)
    }
  })

  app.post('/v1/user/billing/subscription/plan', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const body = SubscriptionPlanChangeRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const workspace = c
      .get('auth')
      .workspaces.find(candidate => candidate.slug === body.data.workspaceSlug)
    if (workspace === undefined) return c.json({ error: 'not_found' }, 404)
    try {
      const result = await runtime.convex.action(
        fnAction('domains/credits/billingActions:changeSubscriptionPlan'),
        {
          internalKey: runtime.internalKey,
          actorId: session.userId,
          workspaceId: workspace.id,
          ...('plan' in body.data
            ? { plan: body.data.plan }
            : 'cancel' in body.data
              ? { cancel: true }
              : { resume: true }),
        },
      )
      return c.json(SubscriptionPlanChangeResponseSchema.parse(result))
    } catch (error) {
      return billingError(c, error)
    }
  })

  app.post('/v1/user/billing/portal', async c => {
    return hostedBillingSession(c, runtime, 'portal')
  })
}

async function hostedBillingSession(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  kind: 'checkout' | 'portal',
) {
  const session = requireHumanActor(c)
  if ('response' in session) return session.response
  const rawBody = await readJson(c.req.raw)
  const body =
    kind === 'checkout'
      ? BillingHostedSessionRequestSchema.safeParse(rawBody)
      : BillingPortalRequestSchema.safeParse(rawBody)
  if (!body.success) return c.json({ error: 'invalid_request' }, 400)
  const workspace = c
    .get('auth')
    .workspaces.find(candidate => candidate.slug === body.data.workspaceSlug)
  if (workspace === undefined) return c.json({ error: 'not_found' }, 404)
  try {
    const actionName =
      kind === 'checkout'
        ? 'domains/credits/billingActions:createCheckout'
        : 'domains/credits/billingActions:createPortal'
    const actionArgs: Record<string, unknown> = {
      internalKey: runtime.internalKey,
      actorId: session.userId,
      workspaceId: workspace.id,
      returnUrl: appHref(runtime.appUrl, '/settings/billing'),
    }
    if (kind === 'checkout') {
      actionArgs.now = runtime.now()
      if ('amountMicroUsd' in body.data && body.data.amountMicroUsd !== undefined) {
        actionArgs.amountMicroUsd = body.data.amountMicroUsd
      }
    }
    const result = await runtime.convex.action(fnAction(actionName), actionArgs)
    return c.json(BillingHostedSessionResponseSchema.parse(result))
  } catch (error) {
    return billingError(c, error)
  }
}

function billingError(c: ApiContext, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Billing payer required/.test(message)) return c.json({ error: 'payer_required' }, 403)
  if (/Payment method required/.test(message))
    return c.json({ error: 'payment_method_required' }, 409)
  if (/Subscription already exists/.test(message))
    return c.json({ error: 'subscription_exists' }, 409)
  if (/Nonterminal subscription required/.test(message))
    return c.json({ error: 'subscription_not_found' }, 409)
  if (/Subscription is not scheduled to cancel/.test(message))
    return c.json({ error: 'subscription_not_canceling' }, 409)
  if (/Stripe billing is not configured/.test(message)) {
    return c.json({ error: 'billing_not_configured' }, 503)
  }
  throw error
}
