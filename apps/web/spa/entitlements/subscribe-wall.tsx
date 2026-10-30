'use client'

import { MoonStars } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'

import type { SubscriptionPlanId, UserBillingOverview, WorkspaceSummary } from '@repo/contract'
import {
  DEFAULT_TRIAL_GRANT_MICRO_USD,
  servicingDaysUntilDecommission,
  SUBSCRIPTION_PLANS,
} from '@repo/contract'
import { cn } from '@repo/ui/lib/utils'

import {
  hasWorkspaceToSwitchTo,
  WorkspaceSwitchMenu,
  type WorkspaceSwitch,
} from '../shell/workspace-switch-menu'
import { billingFooterActionClassName } from './billing-footer-action'
import { SubscriptionPlanChooser } from './subscription-plan-chooser'

export const ROOT_ENTITLEMENT_POLL_MS = 15_000

export type WorkspaceWallState =
  | { kind: 'member'; workspace: WorkspaceSummary }
  | { kind: 'payer-loading'; workspace: WorkspaceSummary }
  | { kind: 'billing-issue'; workspace: WorkspaceSummary; billing: UserBillingOverview }
  | {
      kind: 'trial-exhausted' | 'trial-timed-out' | 'lapsed'
      workspace: WorkspaceSummary
      billing: UserBillingOverview
    }

export type WorkspaceMomentum = {
  generations: number
  generationsAtLeast?: boolean
  publishedApps: number
  publishedAppsAtLeast?: boolean
  organizedFiles: number
  organizedFilesAtLeast?: boolean
}

export function summarizeWorkspaceMomentum(input: {
  ledgerEntries: readonly { type: string }[]
  ledgerEntriesIncomplete?: boolean
  apps: readonly { visibility: string }[]
  appsIncomplete?: boolean
  rootEntries: readonly { type: string }[]
  rootEntriesIncomplete?: boolean
}): WorkspaceMomentum {
  return {
    generations: input.ledgerEntries.filter(entry => entry.type === 'usage').length,
    ...(input.ledgerEntriesIncomplete ? { generationsAtLeast: true } : {}),
    publishedApps: input.apps.filter(app => app.visibility === 'public').length,
    ...(input.appsIncomplete ? { publishedAppsAtLeast: true } : {}),
    organizedFiles: input.rootEntries.filter(entry => entry.type === 'file').length,
    ...(input.rootEntriesIncomplete ? { organizedFilesAtLeast: true } : {}),
  }
}

/**
 * What the wall says about the deadline, and it is never a constant.
 *
 * The workspace is destroyed `SERVICING_ARCHIVE_AFTER_MS` after it stopped
 * being serviced, so the sentence has to be computed from the same instant the
 * sweep measures. It used to read "will shut down in 7 days" on the first day
 * and on the last, and — because decommission changes `status` and leaves
 * `servicingStatus` at `paused` — it went on saying it after the workspace was
 * already gone. Somebody subscribing to save their files was reading a promise
 * about a thing that had already happened.
 */
export function decommissionNotice(
  t: (key: string, values?: Record<string, number>) => string,
  workspace: Pick<WorkspaceSummary, 'status' | 'servicingStatusChangedAt'>,
  now: number,
): string {
  // Past tense first: once the workspace is torn down the countdown is not
  // wrong, it is meaningless.
  if (workspace.status === 'archived' || workspace.status === 'retired') {
    return t('decommissioned')
  }
  const days = servicingDaysUntilDecommission(workspace.servicingStatusChangedAt, now)
  if (days === undefined) return t('decommissionUnknown')
  return days === 0 ? t('decommissionToday') : t('decommission', { days })
}

export function deriveWorkspaceWall(
  workspace: WorkspaceSummary,
  viewerUserId: string,
  billing: UserBillingOverview | undefined,
): WorkspaceWallState | null {
  // Servicing belongs to the workspace's payer. The viewer's own billing state
  // must never override this projection (monthly-subscriptions L17).
  if (workspace.servicingStatus !== 'paused') return null
  if (workspace.billingUserId !== viewerUserId) return { kind: 'member', workspace }
  if (billing === undefined) return { kind: 'payer-loading', workspace }
  if (billing.subscription !== null) {
    return billing.subscription.isActive
      ? { kind: 'billing-issue', workspace, billing }
      : { kind: 'lapsed', workspace, billing }
  }
  return {
    kind: billing.trial.status === 'exhausted' ? 'trial-exhausted' : 'trial-timed-out',
    workspace,
    billing,
  }
}

export function SubscribeWall({
  state,
  momentum,
  onSubscribe,
  onLogout,
  billingPortal,
  workspaceSwitch,
  recoveryLink,
  now = Date.now(),
}: {
  state: WorkspaceWallState
  momentum: WorkspaceMomentum
  onSubscribe?: (plan: SubscriptionPlanId) => void
  onLogout(): void
  billingPortal?: { onOpen(): void; pending: boolean; failed: boolean }
  workspaceSwitch?: WorkspaceSwitch
  recoveryLink?: ReactNode
  /**
   * The clock the deadline is measured against. Injectable because this wall
   * now says a DATE, and a fixture that reads the wall clock photographs a
   * different sentence every day it runs.
   */
  now?: number
}) {
  const t = useTranslations('duetEntitlementWall')
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlanId>('pro')
  const isMember = state.kind === 'member'
  const isLoading = state.kind === 'payer-loading'
  const isBillingIssue = state.kind === 'billing-issue'
  const isLapsed = state.kind === 'lapsed'
  const status = isMember
    ? t('member.status')
    : isLoading
      ? t('loading.status')
      : isBillingIssue
        ? t('billingIssue.status')
        : state.kind === 'trial-exhausted'
          ? t('trialExhausted.status')
          : state.kind === 'trial-timed-out'
            ? t('trialTimedOut.status')
            : t('lapsed.status')
  const body = isMember
    ? t('member.body')
    : isLoading
      ? t('loading.body')
      : isBillingIssue
        ? t('billingIssue.body')
        : state.kind === 'trial-exhausted'
          ? t('trialExhausted.body')
          : state.kind === 'trial-timed-out'
            ? t('trialTimedOut.body')
            : t('lapsed.body')

  return (
    <div
      data-entitlement-wall={state.kind}
      className="absolute inset-0 z-50 overflow-y-auto bg-slate-950/45 px-3 py-4 backdrop-blur-[5px] sm:px-6 sm:py-8"
    >
      <div className="flex min-h-full items-center justify-center">
        <section
          role="dialog"
          aria-modal="false"
          aria-labelledby="entitlement-wall-title"
          className="w-full max-w-4xl overflow-hidden rounded-[28px] border border-white/70 bg-[linear-gradient(145deg,rgba(255,255,255,.98),rgba(248,247,243,.97))] shadow-[0_30px_100px_rgba(15,23,42,.32)] dark:border-white/10 dark:bg-[linear-gradient(145deg,rgba(24,24,27,.98),rgba(15,23,42,.98))]"
        >
          <div className="px-5 pb-5 pt-6 sm:px-8 sm:pb-7 sm:pt-8">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-700 dark:text-amber-300">
              <span className="grid size-7 place-items-center rounded-full bg-amber-100 dark:bg-amber-400/10">
                <MoonStars aria-hidden size={15} weight="fill" />
              </span>
              {status}
            </div>
            <h1
              id="entitlement-wall-title"
              className="mt-3 text-balance text-3xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-4xl dark:text-white"
            >
              {t('headline', { workspace: state.workspace.name })}
            </h1>
            <p
              className={cn(
                'mt-2 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base dark:text-slate-300',
                isBillingIssue && 'max-w-xl',
              )}
            >
              {body}
            </p>
            <p className="mt-2 max-w-2xl text-sm font-medium text-rose-700 dark:text-rose-300">
              {decommissionNotice(t, state.workspace, now)}
            </p>

            {!isMember && !isLoading && !isBillingIssue ? <Meter state={state} /> : null}
            <MomentumRecap momentum={momentum} />

            {isMember || isLoading || isBillingIssue ? (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-white/5">
                {isBillingIssue ? (
                  <button
                    type="button"
                    onClick={billingPortal?.onOpen}
                    disabled={billingPortal === undefined || billingPortal.pending}
                    aria-busy={billingPortal?.pending ?? false}
                    data-billing-recovery-action
                    className="flex min-h-11 w-full items-center justify-center rounded-xl bg-violet-700 px-4 text-center text-sm font-semibold text-white shadow-sm transition-transform active:scale-[.99] disabled:opacity-50 dark:bg-violet-500"
                  >
                    {billingPortal?.pending ? t('openingBillingPortal') : t('billingIssue.action')}
                  </button>
                ) : (
                  <p className="font-semibold text-slate-950 dark:text-white">
                    {t('member.action')}
                  </p>
                )}
                <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {isBillingIssue
                    ? t('billingIssue.actionBody')
                    : isLoading
                      ? t('loading.actionBody')
                      : t('member.actionBody')}
                </p>
              </div>
            ) : (
              <>
                <div className="mt-5">
                  <SubscriptionPlanChooser selectedPlan={selectedPlan} onSelect={setSelectedPlan} />
                </div>
                <button
                  type="button"
                  data-subscribe-action
                  data-selected-plan={selectedPlan}
                  onClick={() => onSubscribe?.(selectedPlan)}
                  className="mt-4 flex min-h-12 w-full items-center justify-center rounded-2xl bg-slate-950 px-5 text-sm font-semibold text-white shadow-lg shadow-slate-950/15 transition-transform active:scale-[.99] dark:bg-white dark:text-slate-950"
                >
                  {isLapsed
                    ? t('resubscribe', { workspace: state.workspace.name })
                    : t('wake', { workspace: state.workspace.name })}
                </button>
              </>
            )}
            <p className="mt-3 text-center text-[13px] leading-5 text-slate-600 dark:text-slate-300">
              {!isMember && !isLoading && !isBillingIssue ? <>{t('rules')} </> : null}
              <span className="inline-flex flex-wrap items-center justify-center gap-2">
                {!isMember && billingPortal ? (
                  <>
                    <button
                      type="button"
                      onClick={billingPortal.onOpen}
                      disabled={billingPortal.pending}
                      aria-busy={billingPortal.pending}
                      className={billingFooterActionClassName}
                    >
                      {billingPortal.pending ? t('openingBillingPortal') : t('manageBilling')}
                    </button>
                    <span aria-hidden="true">·</span>
                  </>
                ) : null}
                {hasWorkspaceToSwitchTo(state.workspace, workspaceSwitch) ? (
                  <>
                    <WorkspaceSwitchMenu
                      className={billingFooterActionClassName}
                      current={state.workspace}
                      workspaceSwitch={workspaceSwitch}
                    />
                    <span aria-hidden="true">·</span>
                  </>
                ) : null}
                {recoveryLink ? (
                  <>
                    {recoveryLink}
                    <span aria-hidden="true">·</span>
                  </>
                ) : null}
                <button type="button" onClick={onLogout} className={billingFooterActionClassName}>
                  {t('logout')}
                </button>
              </span>
            </p>
            {!isMember && billingPortal?.failed ? (
              <p role="alert" className="mt-2 text-center text-sm text-rose-700 dark:text-rose-300">
                {t('billingPortalError')}
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}

function Meter({ state }: { state: WorkspaceWallState }) {
  const t = useTranslations('duetEntitlementWall')
  const lapsedBilling = state.kind === 'lapsed' ? state.billing : undefined
  const plan = lapsedBilling?.subscription?.plan
  const allotment = plan === undefined ? undefined : SUBSCRIPTION_PLANS[plan].monthlyCreditsMicroUsd
  const usedPercent =
    allotment === undefined
      ? 100
      : Math.max(
          0,
          Math.min(
            100,
            Math.round((1 - (lapsedBilling?.monthlyCreditBalanceMicroUsd ?? 0) / allotment) * 100),
          ),
        )
  return (
    <div className="mt-5" aria-label={t('meterLabel')}>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
        <div className="h-full w-full rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400" />
      </div>
      <div className="mt-1.5 flex justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
        <span>
          {lapsedBilling !== undefined
            ? t('monthlyUsed', { percent: usedPercent })
            : t('trialUsed', { amount: formatUsd(DEFAULT_TRIAL_GRANT_MICRO_USD) })}
        </span>
        <span>{t('drained')}</span>
      </div>
      {lapsedBilling !== undefined && lapsedBilling.paidCreditBalanceMicroUsd > 0 ? (
        <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          {t('reserveRetained')}
        </p>
      ) : null}
    </div>
  )
}

function MomentumRecap({ momentum }: { momentum: WorkspaceMomentum }) {
  const t = useTranslations('duetEntitlementWall')
  const bodyKey = momentum.publishedAppsAtLeast
    ? momentum.generationsAtLeast
      ? momentum.organizedFilesAtLeast
        ? 'momentum.bodyAllAtLeast'
        : 'momentum.bodyGenerationsAndAppsAtLeast'
      : momentum.organizedFilesAtLeast
        ? 'momentum.bodyAppsAndFilesAtLeast'
        : 'momentum.bodyAppsAtLeast'
    : momentum.generationsAtLeast
      ? momentum.organizedFilesAtLeast
        ? 'momentum.bodyBothAtLeast'
        : 'momentum.bodyGenerationsAtLeast'
      : momentum.organizedFilesAtLeast
        ? 'momentum.bodyAtLeast'
        : 'momentum.body'
  return (
    <div className="mt-4 rounded-2xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-white/10 dark:bg-white/[.025]">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
        {t('momentum.title')}
      </p>
      <p className="mt-1.5 text-sm leading-6 text-slate-700 dark:text-slate-200">
        {t(bodyKey, {
          generations: momentum.generations,
          publishedApps: momentum.publishedApps,
          organizedFiles: momentum.organizedFiles,
        })}
      </p>
    </div>
  )
}

function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`
}
