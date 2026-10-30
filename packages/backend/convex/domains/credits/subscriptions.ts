import {
  HARD_BLOCK_FLOOR_MICRO_USD,
  SUBSCRIPTION_PLANS,
  SubscriptionPlanIdSchema,
  defaultTierFor,
  type AnalyticsEvent,
  type SubscriptionPlanId,
  type SubscriptionStatus,
  type TierEntitlement,
  type WorkspaceFunding,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { terminalizeOpenSessionsForWorkspace } from '../agentSessions/events'
import { emitAnalyticsEvent, PRODUCT_BACKEND_ANALYTICS_ORIGIN } from '../analytics/model'
import { writeAuditEvent } from '../audit/model'
import { raiseStoredTiersToPlanDefault } from '../workspaces/tierSweep'
import { requestWorkspaceVmAttach } from '../workspaces/vmConvergence'
import { reconcileWorkspaceVmDisks } from '../workspaces/vmDiskPolicy'
import { resetTopupFailureBilling } from './paymentRecovery'
import type { NormalizedSubscriptionEvent } from './subscriptionEvents'
import {
  expireMonthlyCreditsWithDb,
  resetMonthlyCreditsWithDb,
  spendableBalance,
  walletOf,
} from './wallet'

export const AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD = 3

export function isTerminalSubscriptionStatus(status: SubscriptionStatus): boolean {
  return (
    status === 'canceled' ||
    status === 'incomplete_expired' ||
    status === 'unpaid' ||
    status === 'paused'
  )
}

type LifecycleEvent = Extract<
  NormalizedSubscriptionEvent,
  { kind: 'subscription_lifecycle' | 'subscription_deleted' }
>
type PaidInvoiceEvent = Extract<NormalizedSubscriptionEvent, { kind: 'invoice_paid' }>
type FailedInvoiceEvent = Extract<NormalizedSubscriptionEvent, { kind: 'invoice_payment_failed' }>
type SubscriptionEventEmitter = (
  ctx: MutationCtx,
  event: AnalyticsEvent<'subscription.started' | 'subscription.renewed'>,
) => Promise<void>

/**
 * THE reading of a payer row as entitlement.
 *
 * Everything that used to derive "which plan is this person on" separately —
 * the tier entitlement, the workspace creation limit, the servicing verdict —
 * now asks here, because those answers reach the same human through different
 * surfaces. `workspace_limit_reached` is a subscribe trigger an agent acts on;
 * if the limit refusal and the `funding` block that agent reads disagreed, it
 * would be told to buy a plan it already has.
 *
 * The plan is parsed defensively because it crosses the db as a string, and it
 * rides along only while the subscription is live — a lapsed plan must not
 * leak into decisions.
 */
export function fundingOf(payer: Doc<'users'>, now: number): WorkspaceFunding {
  const subscriber = isSubscriber(payer)
  const plan = SubscriptionPlanIdSchema.safeParse(payer.billing?.subscription?.plan)
  // An unconverted trial: the grant is gone the moment a subscription ever
  // activated, so a returning lapsed subscriber never falls back into one.
  const trialExpiresAt = payer.billing?.trialExpiresAt
  const trialing =
    payer.billing?.subscriptionEverActivatedAt === undefined &&
    trialExpiresAt !== undefined &&
    now < trialExpiresAt
  return {
    plan: subscriber && plan.success ? plan.data : null,
    // A trial with nothing spendable left is over in every way that matters,
    // which is why the balance floor belongs here and not only in servicing.
    active:
      subscriber || (trialing && spendableBalance(walletOf(payer)) > HARD_BLOCK_FLOOR_MICRO_USD),
    ...(trialing ? { trialEndsAt: trialExpiresAt } : {}),
  }
}

/** Tier-entitlement facts, read off the one entitlement derivation. */
export function tierEntitlementOf(user: Doc<'users'>, now: number): TierEntitlement {
  const { plan } = fundingOf(user, now)
  return { subscriber: isSubscriber(user), ...(plan === null ? {} : { plan }) }
}

/**
 * A plan switch drags stored session/workspace quality up to the new plan's
 * default tier, never down — the sweep itself enforces the only-raise rule;
 * this gate only keeps status-only and replayed events cheap.
 */
async function sweepTiersIfDefaultMoved(
  ctx: MutationCtx,
  before: Doc<'users'>,
  after: Doc<'users'>,
  now: number,
): Promise<void> {
  const nextFloor = defaultTierFor(tierEntitlementOf(after, now))
  if (nextFloor !== defaultTierFor(tierEntitlementOf(before, now))) {
    await raiseStoredTiersToPlanDefault(ctx, before._id, nextFloor)
  }
}

export function isSubscriber(user: Doc<'users'>): boolean {
  const status = user.billing?.subscription?.status
  // Stripe owns subscription access; credit expiry must not interrupt renewal
  // while the next invoice is still being finalized or paid.
  return status === 'active' || status === 'trialing'
}

export function desiredServicingStatus(user: Doc<'users'>, now: number): 'active' | 'paused' {
  // Entitlement is `funding.active` itself, not a second copy of it: the block
  // an agent reads and the reason its workspace stops being serviced have to
  // be the same sentence. What servicing adds on top is payment machinery the
  // payer can see in their own billing settings.
  const entitled = fundingOf(user, now).active
  const topupAvailable =
    (user.billing?.consecutiveTopupFailures ?? 0) < AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD
  return entitled && topupAvailable && user.billing?.disputeFlaggedAt === undefined
    ? 'active'
    : 'paused'
}

/**
 * THE servicing verdict for a workspace: birth and reconciliation both ask
 * here, so "is this workspace serviced?" has one answer computed one way.
 *
 * Operator transitions deliberately do NOT route through this — they are recording a
 * transition rather than deriving a verdict: the admin ban
 * (`domains/internalAdmin/model.ts`) writes `banned`, which this function then
 * honors, the admin unpause sets active until the next reconciliation, and
 * `markAdminArchivedImpl`
 * (`domains/workspaces/provisioningCore.ts`) stamps `paused` alongside an
 * archival. An exempt workspace archived that way is reconciled back to
 * `active` on the next pass rather than staying wrongly paused.
 *
 * `desiredServicingStatus` deliberately stays user-only: it answers "is this
 * PAYER entitled?", which is a fact about a person. Teaching it about
 * workspaces would give the question two owners and make an exemption
 * invisible to whichever caller asked the other one.
 *
 * Ban outranks exemption. Exemption says "Duet pays for this workspace"; a ban
 * is an operator decision about conduct, and the two must never trade places.
 */
export function servicingStatusFor(
  workspace: Pick<Doc<'workspaces'>, 'servicingStatus' | 'servicingExemptAt'>,
  user: Doc<'users'>,
  now: number,
): 'active' | 'paused' | 'banned' {
  if (workspace.servicingStatus === 'banned') return 'banned'
  if (workspace.servicingExemptAt !== undefined) return 'active'
  return desiredServicingStatus(user, now)
}

export async function reconcileServicingStatus(
  ctx: MutationCtx,
  userId: Id<'users'>,
  now: number,
): Promise<void> {
  const user = await ctx.db.get(userId)
  if (user === null) return
  const workspaces = ctx.db
    .query('workspaces')
    .withIndex('by_billing_user', q => q.eq('billingUserId', userId))
  for await (const workspace of workspaces) {
    if (workspace.status === 'deleted' || workspace.status === 'retired') continue
    // Per workspace, not per payer: an exemption is a fact about THIS workspace,
    // so one entitled/unentitled verdict for the whole loop would erase it.
    const desired = servicingStatusFor(workspace, user, now)
    if (desired === 'banned') continue
    if (workspace.status === 'archived') {
      if (desired !== 'active') continue
      await ctx.db.patch(workspace._id, {
        status: 'provisioning',
        servicingStatus: 'active',
        servicingStatusChangedAt: now,
        updatedAt: now,
      })
      await requestWorkspaceVmAttach(ctx, workspace._id)
      continue
    }
    if (workspace.servicingStatus === desired) continue
    await ctx.db.patch(workspace._id, {
      servicingStatus: desired,
      servicingStatusChangedAt: now,
      updatedAt: now,
    })
    /* The moment the clock starts, written down.
       `servicingStatusChangedAt` is what the decommission sweep measures a
       workspace's remaining life from, and until now nothing recorded when it
       moved — so a workspace destroyed on the wrong day left no evidence of
       which day it was actually paused, and the question could only be
       answered by arithmetic on the deletion that followed. */
    await writeAuditEvent(ctx, {
      workspaceId: workspace._id,
      event: desired === 'paused' ? 'workspace.servicing_paused' : 'workspace.servicing_resumed',
      actorId: workspace.billingUserId,
      at: now,
      // `reason` is the provenance field this table already has for a state
      // change; a new pair of keys would need a schema migration to say the
      // same thing.
      provenance: { reason: `${workspace.servicingStatus ?? 'active'}->${desired}` },
    })
    if (desired === 'paused') {
      await terminalizeOpenSessionsForWorkspace(ctx, workspace._id, now)
    }
  }
}

export async function ensureCurrentEntitlementWithDb(
  ctx: MutationCtx,
  user: Doc<'users'>,
  now: number,
): Promise<Doc<'users'>> {
  const epoch = user.billing?.monthlyCreditEpoch
  const expiresAt = user.billing?.monthlyCreditExpiresAt
  if (
    epoch !== undefined &&
    expiresAt !== undefined &&
    expiresAt <= now &&
    user.monthlyCreditBalanceMicroUsd !== 0
  ) {
    const subscriptionId = user.billing?.subscription?.stripeSubscriptionId
    if (subscriptionId === undefined) throw new Error('Monthly credit epoch has no subscription')
    await expireMonthlyCreditsWithDb(ctx, {
      userId: user._id,
      reference: `subscription_expiry:lapse:${subscriptionId}:${epoch}`,
      reason: 'subscription_lapsed',
      now,
    })
  }
  await reconcileServicingStatus(ctx, user._id, now)
  const refreshed = await ctx.db.get(user._id)
  if (refreshed === null) throw new Error('Subscription account disappeared')
  return refreshed
}

export async function expireLapsedSubscriptionsWithDb(
  ctx: MutationCtx,
  args: { cursor?: string; limit: number; now: number; useStoredCursor?: boolean },
): Promise<{ cursor?: string; done: boolean; processed: number }> {
  const limit = Math.min(Math.max(Math.floor(args.limit), 1), 500)
  if (args.useStoredCursor === true && args.cursor === undefined) {
    return await sweepStoredPhase(ctx, limit, args.now)
  }
  // The caller-driven form carries its own pass window for the same reason the
  // stored one does: the cursor it hands back is only valid against the query
  // that produced it, so the boundary has to travel with it rather than be
  // re-read off whatever clock the next call happens to pass.
  const phase = decodeSweepCursor(args.cursor, args.now)
  if (phase.kind === 'monthly') {
    const page = await ctx.db
      .query('users')
      .withIndex('by_monthly_credit_expiry', q =>
        q
          .gt('billing.monthlyCreditExpiresAt', 0)
          .lte('billing.monthlyCreditExpiresAt', phase.boundary),
      )
      .paginate({ cursor: phase.cursor, numItems: limit })
    for (const user of page.page) await ensureCurrentEntitlementWithDb(ctx, user, args.now)
    if (!page.isDone) {
      return {
        cursor: encodeSweepCursor('monthly', page.continueCursor, phase.boundary),
        done: false,
        processed: page.page.length,
      }
    }
    return {
      cursor: encodeSweepCursor('trial', null, phase.boundary),
      done: false,
      processed: page.page.length,
    }
  }
  const trials = await sweepExpiredTrials(ctx, phase.cursor, limit, phase.boundary, args.now)
  return {
    ...(trials.done ? {} : { cursor: encodeSweepCursor('trial', trials.cursor, phase.boundary) }),
    done: trials.done,
    processed: trials.processed,
  }
}

/**
 * How long a stored cursor may sit untouched before the pass is abandoned.
 *
 * The sweep alternates scopes by wall-clock minute, so a healthy pass stamps
 * each scope every two minutes. A cursor frozen far past that means every tick
 * is dying before it can persist, and the only cursor that does that is one the
 * database refuses (`InvalidCursor` — an index redefinition, say). Convex allows
 * a single `.paginate()` per execution, so a poisoned cursor cannot be caught
 * and retried inside the tick; the pass has to be declared dead by its clock
 * instead. Restarting costs a re-scan and nothing else: every account this sweep
 * touches is reconciled idempotently.
 */
const SWEEP_PASS_STALE_MS = 15 * 60_000

/**
 * The window one pass reads, pinned for the pass's whole life.
 *
 * A Convex cursor is bound to the query that produced it, and the query here is
 * an index range whose upper bound is the clock — so a cursor stored on one tick
 * described a query that no longer existed on the next, and the sweep died with
 * `InvalidCursor` without ever clearing the cursor it choked on: one wedge, and
 * lapsed accounts stop being reconciled for good. A pass therefore carries its
 * opening boundary alongside the cursor and keeps reading that window. Accounts
 * that lapse mid-pass are picked up by the pass after it, which is the same
 * one-tick latency the cron already has.
 */
function sweepPassWindow(
  state: Doc<'subscriptionLapseSweepState'> | null,
  now: number,
): { cursor: string | null; boundary: number } {
  // A cursor with no boundary predates this rule, and one whose pass has gone
  // stale is being rejected on every tick. Both are unresumable.
  if (
    state?.cursor === undefined ||
    state.boundary === undefined ||
    now - state.updatedAt > SWEEP_PASS_STALE_MS
  ) {
    return { cursor: null, boundary: now }
  }
  return { cursor: state.cursor, boundary: state.boundary }
}

async function sweepStoredPhase(
  ctx: MutationCtx,
  limit: number,
  now: number,
): Promise<{ done: boolean; processed: number }> {
  const kind = Math.floor(now / 60_000) % 2 === 0 ? ('monthly' as const) : ('trial' as const)
  const state = await ctx.db
    .query('subscriptionLapseSweepState')
    .withIndex('by_scope', q => q.eq('scope', kind))
    .unique()
  const pass = sweepPassWindow(state, now)
  if (kind === 'monthly') {
    const page = await ctx.db
      .query('users')
      .withIndex('by_monthly_credit_expiry', q =>
        q
          .gt('billing.monthlyCreditExpiresAt', 0)
          .lte('billing.monthlyCreditExpiresAt', pass.boundary),
      )
      .paginate({ cursor: pass.cursor, numItems: limit })
    for (const user of page.page) {
      // A malformed account must not wedge this cursor page forever; caught
      // errors keep the transaction alive so the cursor still advances.
      try {
        await ensureCurrentEntitlementWithDb(ctx, user, now)
      } catch (error) {
        console.error(`monthly lapse sweep failed for ${user._id}: ${String(error)}`)
      }
    }
    await persistSweepCursor(ctx, kind, state, page, pass.boundary, now)
    return { done: page.isDone, processed: page.page.length }
  }
  const page = await ctx.db
    .query('users')
    .withIndex('by_trial_expiry', q =>
      q.gt('billing.trialExpiresAt', 0).lte('billing.trialExpiresAt', pass.boundary),
    )
    .paginate({ cursor: pass.cursor, numItems: limit })
  for (const user of page.page) {
    try {
      await reconcileServicingStatus(ctx, user._id, now)
    } catch (error) {
      console.error(`trial lapse sweep failed for ${user._id}: ${String(error)}`)
    }
  }
  await persistSweepCursor(ctx, kind, state, page, pass.boundary, now)
  return { done: page.isDone, processed: page.page.length }
}

async function persistSweepCursor(
  ctx: MutationCtx,
  scope: 'monthly' | 'trial',
  state: Doc<'subscriptionLapseSweepState'> | null,
  page: { isDone: boolean; continueCursor: string },
  boundary: number,
  now: number,
): Promise<void> {
  // Cursor and boundary are written as one fact or not at all: a cursor that
  // outlived its window is exactly the state this sweep died of.
  const resume = page.isDone
    ? { cursor: undefined, boundary: undefined }
    : { cursor: page.continueCursor, boundary }
  if (state === null) {
    await ctx.db.insert('subscriptionLapseSweepState', { scope, ...resume, updatedAt: now })
  } else {
    await ctx.db.patch(state._id, { ...resume, updatedAt: now })
  }
}

async function sweepExpiredTrials(
  ctx: MutationCtx,
  cursor: string | null,
  limit: number,
  boundary: number,
  now: number,
): Promise<{ cursor: string; done: boolean; processed: number }> {
  const page = await ctx.db
    .query('users')
    .withIndex('by_trial_expiry', q =>
      q.gt('billing.trialExpiresAt', 0).lte('billing.trialExpiresAt', boundary),
    )
    .paginate({ cursor, numItems: limit })
  for (const user of page.page) await reconcileServicingStatus(ctx, user._id, now)
  return { cursor: page.continueCursor, done: page.isDone, processed: page.page.length }
}

function encodeSweepCursor(
  kind: 'monthly' | 'trial',
  cursor: string | null,
  boundary: number,
): string {
  return JSON.stringify({ kind, cursor, boundary })
}

function decodeSweepCursor(
  cursor: string | undefined,
  now: number,
): { kind: 'monthly' | 'trial'; cursor: string | null; boundary: number } {
  if (cursor === undefined) return { kind: 'monthly', cursor: null, boundary: now }
  const parsed = JSON.parse(cursor) as { kind?: unknown; cursor?: unknown; boundary?: unknown }
  if (
    (parsed.kind !== 'monthly' && parsed.kind !== 'trial') ||
    (parsed.cursor !== null && typeof parsed.cursor !== 'string')
  ) {
    throw new Error('Invalid subscription lapse cursor')
  }
  return {
    kind: parsed.kind,
    cursor: parsed.cursor,
    boundary: typeof parsed.boundary === 'number' ? parsed.boundary : now,
  }
}

export async function applySubscriptionLifecycleWithDb(
  ctx: MutationCtx,
  event: LifecycleEvent,
  now = Date.now(),
): Promise<{ applied: boolean }> {
  const user = await userForCustomer(ctx, event.customerId)
  if (user === null) return { applied: false }
  const current = user.billing?.subscription
  if (current !== undefined) {
    // Stripe event ids are not monotonic, so same-second events must apply in
    // delivery order (each id applies at most once via the webhook dedup).
    // Observed live: a schedule release and the cancel it preceded shared a
    // second, and the cancel lost an id-order tie-break and was dropped.
    const delta = event.eventCreatedAt - current.latestLifecycleEventCreatedAt
    if (delta < 0) return { applied: false }
    // An equal-second event never revives a terminal record: deletion wins.
    if (delta === 0 && isTerminalSubscriptionStatus(current.status)) return { applied: false }
  }
  assertSingleSubscription(current, event.subscriptionId)

  const status: SubscriptionStatus =
    event.kind === 'subscription_deleted' ? 'canceled' : event.status
  const subscription = {
    stripeSubscriptionId: event.subscriptionId,
    stripePriceId: event.priceId,
    plan: event.plan,
    status,
    currentPeriodStart: event.currentPeriodStart,
    currentPeriodEnd: event.currentPeriodEnd,
    cancelAtPeriodEnd: event.kind === 'subscription_deleted' ? false : event.cancelAtPeriodEnd,
    ...(event.kind === 'subscription_lifecycle' && event.pendingPlan !== undefined
      ? { pendingPlan: event.pendingPlan }
      : {}),
    latestLifecycleEventCreatedAt: event.eventCreatedAt,
    latestLifecycleEventId: event.eventId,
  }
  await ctx.db.patch(user._id, { billing: { ...user.billing, subscription } })

  await sweepTiersIfDefaultMoved(
    ctx,
    user,
    { ...user, billing: { ...user.billing, subscription } },
    now,
  )

  if (event.kind === 'subscription_deleted' || isTerminalSubscriptionStatus(status)) {
    const epoch = user.billing?.monthlyCreditEpoch
    if (epoch !== undefined) {
      await expireMonthlyCreditsWithDb(ctx, {
        userId: user._id,
        reference: `subscription_expiry:lapse:${event.subscriptionId}:${epoch}`,
        reason: 'subscription_lapsed',
        now,
      })
    }
  }
  await reconcileServicingStatus(ctx, user._id, now)
  await reconcileWorkspaceVmDisks(ctx, user._id, now)
  return { applied: true }
}

export async function applyPaidSubscriptionInvoiceWithDb(
  ctx: MutationCtx,
  event: PaidInvoiceEvent,
  now = Date.now(),
  emit: SubscriptionEventEmitter = emitAnalyticsEvent,
): Promise<{ applied: boolean }> {
  const user = await userForCustomer(ctx, event.customerId)
  if (user === null) return { applied: false }
  const current = user.billing?.subscription
  const priorEpoch = user.billing?.monthlyCreditEpoch
  assertSingleSubscription(current, event.subscriptionId)

  const walletResult = await resetMonthlyCreditsWithDb(ctx, {
    userId: user._id,
    invoiceId: event.invoiceId,
    plan: event.plan,
    allotmentMicroUsd: SUBSCRIPTION_PLANS[event.plan].monthlyCreditsMicroUsd,
    periodStart: event.periodStart,
    periodEnd: event.periodEnd,
    invoiceCreatedAt: event.invoiceCreatedAt,
    recordStaleInvoice: true,
    now,
  })
  const refreshed = await ctx.db.get(user._id)
  if (refreshed === null) throw new Error('Subscription account disappeared')
  const refreshedCurrent = refreshed.billing?.subscription
  // Terminal only blocks invoices for the SAME dead subscription (a late
  // invoice must not resurrect it). A paid invoice for a DIFFERENT
  // subscription is a resubscribe: rebind and let the grant stand.
  const terminal =
    refreshedCurrent !== undefined &&
    isTerminalSubscriptionStatus(refreshedCurrent.status) &&
    refreshedCurrent.stripeSubscriptionId === event.subscriptionId
  const rebindAfterTerminal =
    refreshedCurrent !== undefined &&
    isTerminalSubscriptionStatus(refreshedCurrent.status) &&
    refreshedCurrent.stripeSubscriptionId !== event.subscriptionId &&
    walletResult.applied
  const subscription =
    refreshedCurrent === undefined || rebindAfterTerminal
      ? {
          stripeSubscriptionId: event.subscriptionId,
          stripePriceId: event.priceId,
          plan: event.plan,
          status: 'active' as const,
          currentPeriodStart: event.periodStart,
          currentPeriodEnd: event.periodEnd,
          cancelAtPeriodEnd: false,
          latestLifecycleEventCreatedAt: 0,
          latestLifecycleEventId: '',
        }
      : terminal || !walletResult.applied
        ? refreshedCurrent
        : {
            ...refreshedCurrent,
            stripePriceId: event.priceId,
            plan: event.plan,
            currentPeriodStart: event.periodStart,
            currentPeriodEnd: event.periodEnd,
            pendingPlan: undefined,
          }
  const activatedAt = refreshed.billing?.subscriptionEverActivatedAt ?? now
  const paymentEvent = subscriptionPaymentEvent(event)
  const paymentEventWins =
    compareSubscriptionPaymentEvent(
      paymentEvent,
      refreshed.billing?.latestSubscriptionPaymentEvent,
    ) > 0
  const settledBilling = {
    ...resetTopupFailureBilling(refreshed.billing, event.eventCreatedAt),
    subscription,
    subscriptionEverActivatedAt: activatedAt,
    firstPaidAt: refreshed.billing?.firstPaidAt ?? now,
    // A paid subscription invoice proves an off-session-chargeable payment
    // method — the same readiness setup_intent.succeeded records. Without
    // this, subscribers who never ran the setup flow can't top up.
    paymentMethodReadyAt: refreshed.billing?.paymentMethodReadyAt ?? now,
    subscriptionPaymentError: paymentEventWins
      ? undefined
      : refreshed.billing?.subscriptionPaymentError,
    latestSubscriptionPaymentEvent: paymentEventWins
      ? paymentEvent
      : refreshed.billing?.latestSubscriptionPaymentEvent,
  }
  await ctx.db.patch(user._id, { billing: settledBilling })
  await sweepTiersIfDefaultMoved(ctx, user, { ...refreshed, billing: settledBilling }, now)
  if (terminal && walletResult.applied) {
    await expireMonthlyCreditsWithDb(ctx, {
      userId: user._id,
      reference: `subscription_expiry:lapse:${event.subscriptionId}:${event.invoiceId}`,
      reason: 'subscription_lapsed',
      ...(priorEpoch === undefined
        ? {}
        : {
            replaceReference: `subscription_expiry:lapse:${event.subscriptionId}:${priorEpoch}`,
          }),
      now,
    })
  }
  await reconcileServicingStatus(ctx, user._id, now)
  if (walletResult.applied) {
    await reconcileWorkspaceVmDisks(ctx, user._id, now)
    // Only an invoice that moved the wallet is a purchase, so a replay or a
    // stale invoice emits nothing. `firstPaidAt` read before the patch above
    // is the durable marker of whether this user had ever paid before.
    await emit(ctx, {
      id: `subscription-purchase:${event.invoiceId}`,
      name:
        refreshed.billing?.firstPaidAt === undefined
          ? 'subscription.started'
          : 'subscription.renewed',
      version: 1,
      at: now,
      origin: PRODUCT_BACKEND_ANALYTICS_ORIGIN,
      userId: user._id,
      properties: {
        plan: event.plan,
        priceId: event.priceId,
        invoiceId: event.invoiceId,
        subscriptionId: event.subscriptionId,
        billingReason: event.billingReason,
        // The amount charged at this moment, not today's price list: a later
        // price change must not retroactively revalue a past purchase.
        monthlyPriceMicroUsd: SUBSCRIPTION_PLANS[event.plan].monthlyPriceMicroUsd,
      },
    })
  }
  return { applied: walletResult.applied }
}

export async function recordSubscriptionPaymentFailureWithDb(
  ctx: MutationCtx,
  event: FailedInvoiceEvent,
  now: number,
): Promise<void> {
  const user = await userForCustomer(ctx, event.customerId)
  if (user === null) return
  const paymentEvent = subscriptionPaymentEvent(event)
  if (
    compareSubscriptionPaymentEvent(paymentEvent, user.billing?.latestSubscriptionPaymentEvent) <= 0
  ) {
    return
  }
  await ctx.db.patch(user._id, {
    billing: {
      ...user.billing,
      subscriptionPaymentError: {
        code: 'invoice_payment_failed',
        message:
          'Your subscription payment failed. Please update your payment method before the paid-through period ends.',
        at: now,
      },
      latestSubscriptionPaymentEvent: paymentEvent,
    },
  })
}

export async function flagSubscriptionDisputeWithDb(
  ctx: MutationCtx,
  customerId: string,
  now: number,
): Promise<boolean> {
  const user = await userForCustomer(ctx, customerId)
  if (user === null) return false
  await ctx.db.patch(user._id, { billing: { ...user.billing, disputeFlaggedAt: now } })
  await reconcileServicingStatus(ctx, user._id, now)
  return true
}

async function userForCustomer(ctx: MutationCtx, customerId: string): Promise<Doc<'users'> | null> {
  return await ctx.db
    .query('users')
    .withIndex('by_stripe_customer', q => q.eq('billing.stripeCustomerId', customerId))
    .unique()
}

function subscriptionPaymentEvent(event: PaidInvoiceEvent | FailedInvoiceEvent) {
  return {
    periodEnd: event.periodEnd,
    invoiceCreatedAt: event.invoiceCreatedAt,
    invoiceId: event.invoiceId,
    eventCreatedAt: event.eventCreatedAt,
    eventId: event.eventId,
  }
}

function compareSubscriptionPaymentEvent(
  left: ReturnType<typeof subscriptionPaymentEvent>,
  right: ReturnType<typeof subscriptionPaymentEvent> | undefined,
): number {
  if (right === undefined) return 1
  for (const key of ['periodEnd', 'invoiceCreatedAt'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.invoiceId !== right.invoiceId) return left.invoiceId < right.invoiceId ? -1 : 1
  if (left.eventCreatedAt !== right.eventCreatedAt) {
    return left.eventCreatedAt - right.eventCreatedAt
  }
  return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0
}

function assertSingleSubscription(
  current: NonNullable<Doc<'users'>['billing']>['subscription'],
  incomingSubscriptionId: string,
): void {
  if (
    current !== undefined &&
    current.stripeSubscriptionId !== incomingSubscriptionId &&
    !isTerminalSubscriptionStatus(current.status)
  ) {
    throw new Error('Account already has a nonterminal subscription')
  }
}

// Test-only adapters keep the wallet commands owned by this module while slice-02
// tests continue to exercise their lower-level arithmetic contract.
export async function resetMonthlyCreditsForTestWithDb(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    invoiceId: string
    plan: SubscriptionPlanId
    allotmentMicroUsd: number
    periodStart: number
    periodEnd: number
    invoiceCreatedAt?: number
    now: number
  },
) {
  return await resetMonthlyCreditsWithDb(ctx, args)
}

export async function expireMonthlyCreditsForTestWithDb(
  ctx: MutationCtx,
  args: { userId: Id<'users'>; reference: string; reason: string; now: number },
) {
  return await expireMonthlyCreditsWithDb(ctx, args)
}
