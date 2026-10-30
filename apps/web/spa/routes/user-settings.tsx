'use client'

import {
  Check,
  Copy,
  Devices,
  Key,
  Lightning,
  PlugsConnectedIcon,
  Trash,
  UserCircle,
} from '@phosphor-icons/react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query'
import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'

import {
  bonusPercentForPlan,
  DEFAULT_AUTO_TOPUP_AMOUNT_MICRO_USD,
  dollarsToMicroUsd,
  MIN_AUTO_TOPUP_AMOUNT_MICRO_USD,
  MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD,
  optionalCapToMicroUsd,
  microUsdToDollars,
  SUBSCRIPTION_PLANS,
  type BillingHistoryResponse,
  type CollectionPage,
  type OAuthGrant,
  type SubscriptionPlanId,
  type SyncMachine,
  type UserBillingOverview,
} from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { persistDuetLocale } from '../../lib/i18n/persist-locale'
import { duetQueryKeys } from '../api/query-keys'
import {
  duetQueryOptions,
  invalidateAfterCheckoutReturn,
  isInitialCollectionError,
  mapCollectionItems,
} from '../api/query-options'
import { useSpa } from '../context'
import {
  announceCheckoutSuccess,
  CheckoutCelebrationOverlay,
  useCheckoutCelebration,
} from '../entitlements/checkout-celebration'
import { CHECKOUT_CELEBRATION_POLL_MS } from '../entitlements/checkout-success-signal'
import { StorageMeters } from '../entitlements/storage-surfaces'
import { UserAvatar } from '../identity/identity-avatar'
import { CollectionLoadMore } from '../settings/collection-load-more'
import {
  SettingsCard,
  SettingsFrame,
  SettingsMutationStatus,
  SettingsPage,
  SettingsState,
  formatMicroUsd,
} from '../settings/settings-frame'

export default function UserSettingsRoute() {
  const { surface = 'profile' } = useParams()
  return (
    <SettingsFrame kind="user">
      {surface === 'profile' ? <ProfileSettings /> : null}
      {surface === 'billing' ? <BillingSettings /> : null}
      {surface === 'api-keys' ? <ApiKeysSettings /> : null}
      {surface === 'preferences' ? <PreferencesSettings /> : null}
    </SettingsFrame>
  )
}

function ProfileSettings() {
  const t = useTranslations('duetSettings')
  const { api } = useSpa()
  const queryClient = useQueryClient()
  const profileOptions = duetQueryOptions.user.profile(api)
  const profile = useQuery(profileOptions)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  useEffect(() => {
    if (!profile.data) return
    setFirstName(profile.data.firstName ?? '')
    setLastName(profile.data.lastName ?? '')
  }, [profile.data])
  const mutation = useMutation({
    mutationFn: () => api.updateUserProfile({ firstName, lastName }),
    onSuccess: updated => {
      queryClient.setQueryData(profileOptions.queryKey, updated)
      void queryClient.invalidateQueries({ queryKey: duetQueryKeys.identity })
    },
  })
  return (
    <SettingsPage group="user" surface="profile">
      {profile.isPending ? (
        <SettingsState title={t('loading')} body={t('user.profile.loading')} busy />
      ) : profile.isError ? (
        <SettingsState title={t('loadError')} body={t('user.profile.error')} />
      ) : (
        <div className="space-y-5">
          <SettingsCard>
            <div className="flex flex-col items-center gap-5 text-center sm:flex-row sm:text-left">
              <UserAvatar
                name={profile.data.name ?? profile.data.email}
                className="size-20 shadow-lg"
              />
              <div className="min-w-0">
                <h3 className="truncate text-xl font-semibold">
                  {profile.data.name ?? profile.data.email}
                </h3>
                <p className="mt-1 truncate text-sm text-muted-foreground">{profile.data.email}</p>
              </div>
            </div>
          </SettingsCard>
          <SettingsCard title={t('user.profile.personal')} description={t('user.profile.help')}>
            <form
              className="space-y-5"
              onSubmit={event => {
                event.preventDefault()
                mutation.mutate()
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label={t('user.profile.firstName')}
                  value={firstName}
                  onChange={setFirstName}
                />
                <TextField
                  label={t('user.profile.lastName')}
                  value={lastName}
                  onChange={setLastName}
                />
              </div>
              <TextField label={t('email')} value={profile.data.email} disabled />
              <div className="flex justify-end border-t pt-5">
                <button disabled={mutation.isPending} className={buttonVariants()}>
                  {mutation.isPending ? t('saving') : t('save')}
                </button>
              </div>
              <SettingsMutationStatus mutation={mutation} />
            </form>
          </SettingsCard>
        </div>
      )}
    </SettingsPage>
  )
}

function BillingSettings() {
  const t = useTranslations('duetSettings')
  const locale = useLocale()
  const { api, identity } = useSpa()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const { celebrating } = useCheckoutCelebration()
  // Stripe credits the wallet from a webhook that lands after the redirect, so
  // this page keeps asking for the few seconds that follow instead of showing
  // the pre-payment balance until someone reloads by hand.
  const billingOptions = duetQueryOptions.user.billingOverview(
    api,
    celebrating ? CHECKOUT_CELEBRATION_POLL_MS : false,
  )
  const billing = useQuery(billingOptions)
  const history = useInfiniteQuery(duetQueryOptions.user.billingHistory(api))
  useEffect(() => {
    if (searchParams.get('billing') !== 'success') return
    // Announce before stripping: the gate waiting in the workspace tab has no
    // other way to learn that this one came back from a paid checkout.
    announceCheckoutSuccess(identity.user.id)
    const remaining = new URLSearchParams(searchParams)
    remaining.delete('billing')
    setSearchParams(remaining, { replace: true })
    invalidateAfterCheckoutReturn(queryClient)
  }, [identity.user.id, queryClient, searchParams, setSearchParams])
  const [autoTopup, setAutoTopup] = useState<AutoTopupForm>(EMPTY_AUTO_TOPUP_FORM)
  // The server's copy of the form, serialized so the sync effect keys on the
  // values themselves: a background refetch that changes nothing must not
  // wipe an edit in progress, while a save (or a change made elsewhere) must.
  const savedAutoTopup = billing.data
    ? JSON.stringify(autoTopupFormFromOverview(billing.data))
    : undefined
  useEffect(() => {
    if (savedAutoTopup !== undefined) setAutoTopup(JSON.parse(savedAutoTopup) as AutoTopupForm)
  }, [savedAutoTopup])
  const autoTopupValid =
    validAutoTopupThreshold(autoTopup.threshold) &&
    atLeastMicroUsd(autoTopup.amount, MIN_AUTO_TOPUP_AMOUNT_MICRO_USD)
  const update = useMutation({
    mutationFn: (form: AutoTopupForm) => {
      const workspaceSlug = billing.data?.workspaces[0]?.slug
      if (!workspaceSlug) throw new Error('payer_required')
      return api.updateUserBilling({
        workspaceSlug,
        autoTopupEnabled: form.enabled,
        autoTopupAmountMicroUsd: dollarsToMicroUsd(form.amount),
        autoTopupThresholdMicroUsd: dollarsToMicroUsd(form.threshold),
        // Never `dollarsToMicroUsd`: it normalizes a typo to 0, and a 0 cap
        // blocks every request rather than meaning "no cap".
        maxMonthlySpendMicroUsd: optionalCapToMicroUsd(form.cap),
      })
    },
    onSuccess: data => queryClient.setQueryData(billingOptions.queryKey, data),
  })
  // An edit after a save is unsaved again, so the confirmation must not
  // outlive it.
  const editAutoTopup = (patch: Partial<AutoTopupForm>) => {
    update.reset()
    setAutoTopup(form => ({ ...form, ...patch }))
  }
  const [topupAmount, setTopupAmount] = useState(
    String(microUsdToDollars(DEFAULT_AUTO_TOPUP_AMOUNT_MICRO_USD)),
  )
  const topupAmountValid = atLeastMicroUsd(topupAmount, MIN_AUTO_TOPUP_AMOUNT_MICRO_USD)
  const portal = useMutation({
    mutationFn: async () => {
      const workspaceSlug = billing.data?.workspaces[0]?.slug
      if (!workspaceSlug) throw new Error('payer_required')
      return await api.createBillingPortal(workspaceSlug)
    },
    onSuccess: result => window.location.assign(result.url),
  })
  const topup = useMutation({
    mutationFn: async () => {
      const workspaceSlug = billing.data?.workspaces[0]?.slug
      if (!workspaceSlug) throw new Error('payer_required')
      return await api.createBillingCheckout({
        workspaceSlug,
        amountMicroUsd: dollarsToMicroUsd(topupAmount),
      })
    },
    onSuccess: result => window.location.assign(result.url),
  })
  const subscribe = useMutation({
    mutationFn: async (plan: SubscriptionPlanId) => {
      const workspaceSlug = billing.data?.workspaces[0]?.slug
      if (!workspaceSlug) throw new Error('payer_required')
      return await api.createSubscriptionCheckout({ workspaceSlug, plan })
    },
    onSuccess: result => window.location.assign(result.url),
  })
  const planChange = useMutation({
    mutationFn: async (
      change: { plan: SubscriptionPlanId } | { cancel: true } | { resume: true },
    ) => {
      const workspaceSlug = billing.data?.workspaces[0]?.slug
      if (!workspaceSlug) throw new Error('payer_required')
      return await api.changeSubscriptionPlan({ workspaceSlug, ...change })
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: duetQueryKeys.user.billing.overview }),
  })
  if (billing.isPending) {
    return (
      <SettingsPage group="user" surface="billing">
        <SettingsState title={t('loading')} body={t('user.billing.loading')} busy />
      </SettingsPage>
    )
  }
  if (billing.isError) {
    return (
      <SettingsPage group="user" surface="billing">
        <SettingsState title={t('loadError')} body={t('user.billing.error')} />
      </SettingsPage>
    )
  }
  if (billing.data === null || billing.data.workspaces.length === 0) {
    return (
      <SettingsPage group="user" surface="billing">
        <SettingsState title={t('user.billing.notPayer')} body={t('user.billing.notPayerBody')} />
      </SettingsPage>
    )
  }
  const subscription = billing.data.subscription
  const active = subscription?.isActive === true
  const lapsed =
    (subscription !== null && !subscription.isActive) ||
    (subscription === null && billing.data.trial.status !== 'available')
  const formatDate = (at: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at)
  const periodEnd = subscription ? formatDate(subscription.currentPeriodEnd) : ''
  const planName = (plan: SubscriptionPlanId) => t(`user.billing.${plan}`)
  const allotment = subscription
    ? SUBSCRIPTION_PLANS[subscription.plan].monthlyCreditsMicroUsd
    : undefined
  const monthlyUsedPercent = allotment
    ? Math.min(
        100,
        Math.max(
          0,
          Math.round(((allotment - billing.data.monthlyCreditBalanceMicroUsd) / allotment) * 100),
        ),
      )
    : 0
  return (
    <SettingsPage group="user" surface="billing">
      <div className="space-y-5">
        <CheckoutCelebrationOverlay />
        {celebrating ? (
          <div
            role="status"
            data-checkout-celebration
            className="rounded-xl border border-emerald-300/60 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 dark:border-emerald-300/20 dark:bg-emerald-400/10 dark:text-emerald-100"
          >
            {t('user.billing.paymentReceived')}
          </div>
        ) : null}
        <SettingsCard>
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">
                {t('user.billing.plan')}
              </p>
              <h3 className="mt-2 text-2xl font-semibold tracking-tight">
                {lapsed
                  ? t('user.billing.lapsedPlan')
                  : subscription
                    ? planName(subscription.plan)
                    : t('user.billing.trialPlan')}
              </h3>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                {lapsed
                  ? t('user.billing.lapsedBody')
                  : subscription
                    ? subscription.cancelAtPeriodEnd
                      ? t('user.billing.activeUntil', { date: periodEnd })
                      : t('user.billing.renewsOn', { date: periodEnd })
                    : t('user.billing.trialBody')}
              </p>
            </div>
            <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap">
              {lapsed ? (
                <a href="#billing-plan-picker" className={buttonVariants()}>
                  {t('user.billing.resubscribe')}
                </a>
              ) : null}
              {(subscription || billing.data.hasPaymentMethod) && !billing.data.lastTopupError ? (
                <button
                  disabled={portal.isPending}
                  onClick={() => portal.mutate()}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('user.billing.paymentInvoices')}
                </button>
              ) : null}
            </div>
          </div>
          {billing.data.lastTopupError ? (
            <div
              role="alert"
              className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 p-4"
            >
              <p className="text-sm font-semibold text-destructive">
                {t('user.billing.topupFailed')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {billing.data.lastTopupError.message}
              </p>
              <button
                disabled={portal.isPending}
                onClick={() => portal.mutate()}
                className={cn(buttonVariants({ variant: 'outline' }), 'mt-3')}
              >
                {t('user.billing.paymentInvoices')}
              </button>
            </div>
          ) : null}
          {lapsed ? (
            <div
              role="alert"
              className="mt-5 rounded-lg border border-amber-400/40 bg-amber-400/10 p-4"
            >
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                {t('user.billing.workspacesPaused')}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {t('user.billing.paidRetained')}
              </p>
            </div>
          ) : null}
          {subscription?.pendingPlan ? (
            <div className="mt-5 rounded-lg border border-primary/25 bg-primary/5 p-4">
              <p className="text-sm font-semibold text-primary">
                {t('user.billing.pendingPlan', {
                  plan: planName(subscription.pendingPlan),
                  date: periodEnd,
                })}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('user.billing.pendingPlanBody')}
              </p>
            </div>
          ) : null}
          {subscription?.cancelAtPeriodEnd ? (
            <div className="mt-5 rounded-lg border border-amber-400/40 bg-amber-400/10 p-4 sm:flex sm:items-center sm:justify-between sm:gap-4">
              <p className="text-sm text-muted-foreground">{t('user.billing.cancelNotice')}</p>
              <button
                disabled={planChange.isPending}
                onClick={() => planChange.mutate({ resume: true })}
                className={cn(buttonVariants(), 'mt-3 shrink-0 sm:mt-0')}
              >
                {t('user.billing.keepPlan')}
              </button>
            </div>
          ) : null}
          <StorageMeters workspaces={billing.data.workspaces} />
          <div className={`mt-5 grid gap-3 ${active ? 'sm:grid-cols-2' : ''}`}>
            {active ? (
              <BillingMetric
                label={t('user.billing.monthlyCredits')}
                value={t('user.billing.monthlyUsed', { percent: monthlyUsedPercent })}
                detail={t('user.billing.monthlyRemaining', {
                  percent: 100 - monthlyUsedPercent,
                })}
                tone={monthlyUsedPercent === 100 ? 'warning' : 'neutral'}
              />
            ) : null}
            <BillingMetric
              label={t('user.billing.paidReserve')}
              value={formatMicroUsd(billing.data.paidCreditBalanceMicroUsd)}
              detail={lapsed ? undefined : t('user.billing.paidReserveHelp')}
            />
          </div>
          {active && monthlyUsedPercent === 100 ? (
            <p className="mt-3 text-sm font-medium text-amber-800 dark:text-amber-200">
              {t('user.billing.usingReserve')}
            </p>
          ) : null}
          {active ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {t('user.billing.creditsResetOn', { date: periodEnd })}
            </p>
          ) : null}
          <SettingsMutationStatus mutation={portal} />
        </SettingsCard>
        <div id="billing-plan-picker" className="scroll-mt-4">
          <PlanPicker
            overview={billing.data}
            periodEnd={periodEnd}
            subscribe={subscribe}
            planChange={planChange}
          />
        </div>
        {active ? (
          <SettingsCard
            title={t('user.billing.overage')}
            description={t('user.billing.overageHelp')}
          >
            <div className="grid gap-4 sm:grid-cols-3">
              {/* Locked while a save is in flight: an edit typed now would be
                  overwritten when the older save's response lands. */}
              <MoneyField
                label={t('user.billing.amount')}
                value={autoTopup.amount}
                onChange={amount => editAutoTopup({ amount })}
                minimum={microUsdToDollars(MIN_AUTO_TOPUP_AMOUNT_MICRO_USD)}
                disabled={update.isPending}
              />
              <MoneyField
                label={t('user.billing.threshold')}
                value={autoTopup.threshold}
                onChange={threshold => editAutoTopup({ threshold })}
                minimum={microUsdToDollars(MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD)}
                disabled={update.isPending}
              />
              <MoneyField
                label={t('user.billing.cap')}
                value={autoTopup.cap}
                onChange={cap => editAutoTopup({ cap })}
                optional
                disabled={update.isPending}
              />
            </div>
            <div className="mt-5 flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
              <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={autoTopup.enabled}
                  disabled={!billing.data.hasPaymentMethod || update.isPending}
                  onChange={event => editAutoTopup({ enabled: event.target.checked })}
                  className="size-5 accent-primary disabled:opacity-50"
                />
                {t('user.billing.enableAuto')}
              </label>
              <button
                disabled={!autoTopupValid || update.isPending}
                onClick={() => update.mutate(autoTopup)}
                className={buttonVariants()}
              >
                {update.isPending ? t('saving') : t('save')}
              </button>
            </div>
            <SettingsMutationStatus mutation={update} />
          </SettingsCard>
        ) : null}
        {active ? (
          <SettingsCard
            title={t('user.billing.oneTime')}
            description={t('user.billing.oneTimeHelp')}
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <MoneyField
                label={t('user.billing.oneTimeAmount')}
                value={topupAmount}
                onChange={setTopupAmount}
                minimum={microUsdToDollars(MIN_AUTO_TOPUP_AMOUNT_MICRO_USD)}
              />
            </div>
            <div className="mt-5 flex border-t pt-5 sm:justify-end">
              <button
                disabled={!billing.data.hasPaymentMethod || !topupAmountValid || topup.isPending}
                onClick={() => topup.mutate()}
                className={cn(buttonVariants(), 'w-full sm:w-auto')}
              >
                {t('user.billing.topupNow')}
              </button>
            </div>
            <SettingsMutationStatus mutation={topup} />
          </SettingsCard>
        ) : null}
        <BillingHistory
          overview={billing.data}
          history={history.data?.items ?? []}
          initialLoading={history.isPending}
          initialError={history.data === undefined && isInitialCollectionError(history)}
          hasMore={history.hasNextPage || history.isFetchNextPageError}
          loadingMore={history.isFetchingNextPage}
          moreFailed={history.isFetchNextPageError}
          onRetryInitial={() => void history.refetch()}
          onLoadMore={() => void history.fetchNextPage()}
        />
      </div>
    </SettingsPage>
  )
}

function PlanPicker({
  overview,
  periodEnd,
  subscribe,
  planChange,
}: {
  overview: UserBillingOverview
  periodEnd: string
  subscribe: {
    isPending: boolean
    isError: boolean
    isSuccess: boolean
    mutate(plan: SubscriptionPlanId): void
  }
  planChange: {
    isPending: boolean
    isError: boolean
    isSuccess: boolean
    mutate(change: { plan: SubscriptionPlanId } | { cancel: true }): void
  }
}) {
  const t = useTranslations('duetSettings')
  const subscription = overview.subscription
  const active = subscription?.isActive === true
  const hasMutableSubscription =
    subscription !== null &&
    subscription.status !== 'canceled' &&
    subscription.status !== 'incomplete_expired'
  const planName = (plan: SubscriptionPlanId) => t(`user.billing.${plan}`)
  return (
    <SettingsCard
      title={t('user.billing.choosePlan')}
      description={t('user.billing.choosePlanHelp')}
    >
      <div className="grid gap-3 md:grid-cols-3">
        {(Object.keys(SUBSCRIPTION_PLANS) as SubscriptionPlanId[]).map(plan => {
          const catalogPlan = SUBSCRIPTION_PLANS[plan]
          const current = hasMutableSubscription && subscription.plan === plan
          const pending = subscription?.pendingPlan === plan
          const upgrading =
            hasMutableSubscription &&
            catalogPlan.monthlyPriceMicroUsd >
              SUBSCRIPTION_PLANS[subscription.plan].monthlyPriceMicroUsd
          const bonus = bonusPercentForPlan(plan)
          // Pro is only worth promoting while it would be an upgrade; for a
          // subscriber already at Pro or above it reads like any other tier.
          const promotePro = plan === 'pro' && (!hasMutableSubscription || upgrading)
          return (
            <article
              key={plan}
              className={`flex flex-col rounded-xl border p-4 ${promotePro ? 'border-primary bg-primary/5 shadow-sm' : 'bg-card'}`}
            >
              <div className="flex min-h-6 items-start justify-between gap-2">
                <h4 className="text-lg font-semibold">{planName(plan)}</h4>
                {promotePro ? (
                  <span className="rounded-full bg-primary px-2 py-1 text-[0.65rem] font-bold uppercase tracking-wide text-primary-foreground">
                    {t('user.billing.recommended')}
                  </span>
                ) : null}
              </div>
              <p className="mt-3 text-2xl font-semibold tabular-nums">
                {formatMicroUsd(catalogPlan.monthlyPriceMicroUsd)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {t('user.billing.perMonth')}
                </span>
              </p>
              <p className="mt-3 min-h-10 text-sm leading-5 text-muted-foreground">
                {bonus > 0
                  ? t('user.billing.bonusCredits', { percent: bonus })
                  : t('user.billing.monthlyCreditsIncluded')}
              </p>
              {hasMutableSubscription && !current ? (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {upgrading
                    ? t('user.billing.upgradeHelp')
                    : t('user.billing.downgradeHelp', { date: periodEnd })}
                </p>
              ) : null}
              <button
                disabled={current || pending || subscribe.isPending || planChange.isPending}
                onClick={() =>
                  hasMutableSubscription ? planChange.mutate({ plan }) : subscribe.mutate(plan)
                }
                className={cn(
                  buttonVariants({
                    variant: promotePro ? 'default' : 'outline',
                  }),
                  'mt-auto',
                )}
              >
                {current
                  ? t('user.billing.currentPlan')
                  : pending
                    ? t('user.billing.switchLater', { plan: planName(plan), date: periodEnd })
                    : hasMutableSubscription
                      ? upgrading
                        ? t('user.billing.upgradeNow', { plan: planName(plan) })
                        : t('user.billing.switchLater', { plan: planName(plan), date: periodEnd })
                      : t('user.billing.subscribeTo', { plan: planName(plan) })}
              </button>
            </article>
          )
        })}
      </div>
      {active && !subscription.cancelAtPeriodEnd ? (
        <button
          disabled={planChange.isPending}
          onClick={() => planChange.mutate({ cancel: true })}
          className={cn(buttonVariants({ variant: 'link' }), 'mt-4 text-muted-foreground')}
        >
          {t('user.billing.cancelPlan', { date: periodEnd })}
        </button>
      ) : null}
      <SettingsMutationStatus mutation={subscribe} />
      <SettingsMutationStatus mutation={planChange} />
    </SettingsCard>
  )
}

/**
 * The one owner of "which words describe this billing history row".
 *
 * A lookup keyed by `type` plus an inline branch for `usageKind` are two places
 * that can disagree about the same row, so there is one exhaustive switch
 * instead -- adding a transaction type is then a type error here rather than a
 * row that silently renders blank.
 */
export function billingHistoryLabel(
  item: Pick<BillingHistoryResponse['items'][number], 'type' | 'usageKind'>,
  t: (key: string) => string,
): string {
  switch (item.type) {
    case 'grant':
      return t('user.billing.transactionGrant')
    case 'topup':
      return t('user.billing.transactionTopup')
    case 'usage':
      return item.usageKind === 'vm_compute'
        ? t('user.billing.transactionVmCompute')
        : t('user.billing.transactionUsage')
    case 'adjustment':
      return t('user.billing.transactionAdjustment')
    case 'reservation':
      return t('user.billing.transactionReservation')
    case 'subscription_grant':
      return t('user.billing.transactionSubscriptionGrant')
    case 'subscription_expiry':
      return t('user.billing.transactionSubscriptionExpiry')
  }
}

function BillingHistory({
  overview,
  history,
  initialLoading,
  initialError,
  hasMore,
  loadingMore,
  moreFailed,
  onRetryInitial,
  onLoadMore,
}: {
  overview: UserBillingOverview
  history: BillingHistoryResponse['items']
  initialLoading: boolean
  initialError: boolean
  hasMore: boolean
  loadingMore: boolean
  moreFailed: boolean
  onRetryInitial: () => void
  onLoadMore: () => void
}) {
  const t = useTranslations('duetSettings')
  const locale = useLocale()
  return (
    <SettingsCard title={t('user.billing.history')} description={t('user.billing.historyHelp')}>
      {initialLoading ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : initialError ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive">{t('loadError')}</p>
          <button
            type="button"
            onClick={onRetryInitial}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('retry')}
          </button>
        </div>
      ) : history.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('user.billing.historyEmpty')}</p>
      ) : (
        <div className="divide-y">
          {history.map(item => (
            <div key={item.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
              <span className="grid size-9 place-items-center rounded-full bg-muted">
                <Lightning size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{billingHistoryLabel(item, t)}</p>
                <p className="text-xs text-muted-foreground">
                  {item.scope === 'workspace' ? item.workspaceName : t('user.billing.account')} ·{' '}
                  {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(item.createdAt)}
                </p>
              </div>
              {item.type === 'subscription_grant' || item.type === 'subscription_expiry' ? (
                <span className="text-xs font-semibold text-muted-foreground">
                  {t('user.billing.monthlyCreditActivity')}
                </span>
              ) : (
                <span className="text-sm font-semibold tabular-nums">
                  {formatMicroUsd(item.amountMicroUsd)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {hasMore ? (
        <CollectionLoadMore
          loading={loadingMore}
          failed={moreFailed}
          labels={{
            load: t('loadMore'),
            loading: t('loadingMore'),
            retry: t('retryLoadMore'),
          }}
          onLoad={onLoadMore}
        />
      ) : null}
      <p className="mt-4 text-xs text-muted-foreground">
        {t('user.billing.payerFor', { count: overview.workspaces.length })}
      </p>
    </SettingsCard>
  )
}

function ApiKeysSettings() {
  const t = useTranslations('duetSettings')
  const { api } = useSpa()
  const queryClient = useQueryClient()
  const keys = useInfiniteQuery(duetQueryOptions.user.apiKeys(api))
  const [name, setName] = useState('')
  const [secret, setSecret] = useState<string>()
  const issue = useMutation({
    mutationFn: () => api.issueUserApiKey({ name }),
    onSuccess: result => {
      setSecret(result.key)
      setName('')
      window.scrollTo({ top: 0 })
      void queryClient.invalidateQueries({ queryKey: duetQueryKeys.user.apiKeys })
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeUserApiKey(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: duetQueryKeys.user.apiKeys }),
  })
  return (
    <SettingsPage group="user" surface="apiKeys">
      <div className="space-y-5">
        {secret ? (
          <SettingsCard
            title={t('user.apiKeys.secretTitle')}
            description={t('user.apiKeys.secretHelp')}
          >
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-xl bg-slate-950 p-4 text-xs text-emerald-300">
                {secret}
              </code>
              <button
                onClick={() => void navigator.clipboard.writeText(secret)}
                className={buttonVariants({ variant: 'outline' })}
              >
                <Copy size={17} /> {t('copy')}
              </button>
            </div>
          </SettingsCard>
        ) : null}
        <SettingsCard title={t('user.apiKeys.new')} description={t('user.apiKeys.help')}>
          <form
            className="space-y-4"
            onSubmit={event => {
              event.preventDefault()
              issue.mutate()
            }}
          >
            <TextField label={t('user.apiKeys.name')} value={name} onChange={setName} />
            <div className="flex justify-end border-t pt-5">
              <button disabled={issue.isPending || !name.trim()} className={buttonVariants()}>
                <Key size={17} /> {issue.isPending ? t('creating') : t('user.apiKeys.create')}
              </button>
            </div>
            <SettingsMutationStatus mutation={issue} />
          </form>
        </SettingsCard>
        <SettingsCard title={t('user.apiKeys.active')}>
          {keys.isPending ? (
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
          ) : keys.data === undefined || isInitialCollectionError(keys) ? (
            <p className="text-sm text-destructive">{t('loadError')}</p>
          ) : keys.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('user.apiKeys.empty')}</p>
          ) : (
            <>
              <div className="divide-y">
                {keys.data.items.map(item => (
                  <div key={item.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <span className="grid size-10 place-items-center rounded-lg bg-muted">
                      <Key size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{item.name ?? item.prefix}</p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        <code>{item.prefix}…</code>
                      </p>
                    </div>
                    {item.revokedAt ? (
                      <span className="text-xs font-semibold text-muted-foreground">
                        {t('revoked')}
                      </span>
                    ) : (
                      <button
                        onClick={() => revoke.mutate(item.id)}
                        aria-label={t('user.apiKeys.revoke', { prefix: item.prefix })}
                        className={cn(
                          buttonVariants({ variant: 'outline', size: 'icon' }),
                          'text-muted-foreground hover:text-destructive',
                        )}
                      >
                        <Trash size={17} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {keys.hasNextPage || keys.isFetchNextPageError ? (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    disabled={keys.isFetchingNextPage}
                    onClick={() => void keys.fetchNextPage()}
                    className={buttonVariants({ variant: 'outline' })}
                  >
                    {keys.isFetchingNextPage
                      ? t('loadingMore')
                      : keys.isFetchNextPageError
                        ? t('retryLoadMore')
                        : t('loadMore')}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </SettingsCard>
        <ConnectedAppsCard />
        <SyncMachinesCard />
      </div>
    </SettingsPage>
  )
}

function ConnectedAppsCard() {
  const t = useTranslations('duetSettings')
  const locale = useLocale()
  const { api } = useSpa()
  const queryClient = useQueryClient()
  const grants = useInfiniteQuery(duetQueryOptions.user.oauthGrants(api))
  const grantsKey = duetQueryKeys.user.oauthGrants
  const revoke = useMutation({
    mutationFn: (grantId: string) => api.revokeOAuthGrant(grantId),
    onSuccess: result => {
      queryClient.setQueryData<InfiniteData<CollectionPage<OAuthGrant>, string | undefined>>(
        grantsKey,
        current =>
          mapCollectionItems(current, items =>
            items.map(grant =>
              grant.id === result.grantId ? { ...grant, revokedAt: result.revokedAt } : grant,
            ),
          ),
      )
    },
  })
  const formatDate = (at: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at)

  return (
    <div data-fixture-id="oauth-grants-settings">
      <SettingsCard
        title={t('user.apiKeys.connectedApps')}
        description={t('user.apiKeys.connectedAppsHelp')}
      >
        {grants.isPending ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : grants.data === undefined || isInitialCollectionError(grants) ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{t('loadError')}</p>
            <button
              type="button"
              onClick={() => void grants.refetch()}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('retry')}
            </button>
          </div>
        ) : grants.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('user.apiKeys.connectedAppsEmpty')}</p>
        ) : (
          <>
            <div className="divide-y">
              {grants.data.items.map(grant => (
                <div
                  key={grant.id}
                  data-fixture-id={`connected-app-${grant.id}`}
                  className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted">
                    <PlugsConnectedIcon size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-semibold" title={grant.clientName}>
                      {grant.clientName}
                    </p>
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      {grant.redirectHost || grant.clientId} · {grant.workspace.name}
                    </p>
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      {grant.scopes.join(', ')} ·{' '}
                      {grant.lastUsedAt === undefined
                        ? t('user.apiKeys.connectedAppAdded', { date: formatDate(grant.createdAt) })
                        : t('user.apiKeys.connectedAppLastUsed', {
                            date: formatDate(grant.lastUsedAt),
                          })}
                    </p>
                  </div>
                  {grant.revokedAt ? (
                    <span className="shrink-0 rounded-full border bg-muted px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('revoked')}
                    </span>
                  ) : (
                    <button
                      onClick={() => revoke.mutate(grant.id)}
                      aria-label={t('user.apiKeys.connectedAppRevoke', {
                        name: grant.clientName,
                      })}
                      className={cn(
                        buttonVariants({ variant: 'outline', size: 'icon' }),
                        'shrink-0 text-muted-foreground hover:text-destructive',
                      )}
                    >
                      <Trash size={17} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {grants.hasNextPage || grants.isFetchNextPageError ? (
              <CollectionLoadMore
                loading={grants.isFetchingNextPage}
                failed={grants.isFetchNextPageError}
                labels={{
                  load: t('loadMore'),
                  loading: t('loadingMore'),
                  retry: t('retryLoadMore'),
                }}
                onLoad={() => void grants.fetchNextPage()}
              />
            ) : null}
          </>
        )}
        <SettingsMutationStatus mutation={revoke} />
      </SettingsCard>
    </div>
  )
}

function SyncMachinesCard() {
  const t = useTranslations('duetSettings')
  const locale = useLocale()
  const { api } = useSpa()
  const queryClient = useQueryClient()
  const machines = useInfiniteQuery(duetQueryOptions.user.syncMachines(api))
  const machinesKey = duetQueryKeys.user.syncMachines
  const remove = useMutation({
    mutationFn: (machineId: string) => api.removeSyncMachine(machineId),
    onSuccess: (result, machineId) => {
      queryClient.setQueryData<InfiniteData<CollectionPage<SyncMachine>, string | undefined>>(
        machinesKey,
        current =>
          mapCollectionItems(current, items =>
            items.map(machine =>
              machine.machineId === machineId
                ? { ...machine, removedAt: result.removedAt }
                : machine,
            ),
          ),
      )
    },
  })
  const formatDate = (at: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
  return (
    <SettingsCard
      title={t('user.apiKeys.syncMachines')}
      description={t('user.apiKeys.syncMachinesHelp')}
    >
      {machines.isPending ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : machines.data === undefined || isInitialCollectionError(machines) ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive">{t('loadError')}</p>
          <button
            type="button"
            onClick={() => void machines.refetch()}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('retry')}
          </button>
        </div>
      ) : machines.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('user.apiKeys.syncMachinesEmpty')}</p>
      ) : (
        <>
          <div className="divide-y">
            {machines.data.items.map(machine => (
              <div
                key={machine.machineId}
                data-sync-machine-id={machine.machineId}
                className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <span className="grid size-10 place-items-center rounded-lg bg-muted">
                  <Devices size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{machine.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span className="block sm:inline">
                      {t('user.apiKeys.syncMachineCreated', {
                        date: formatDate(machine.createdAt),
                      })}
                    </span>
                    <span className="hidden sm:inline"> · </span>
                    <span className="block sm:inline">
                      {t('user.apiKeys.syncMachineLastUsed', {
                        date: formatDate(machine.lastUsedAt),
                      })}
                    </span>
                  </p>
                </div>
                {machine.removedAt ? (
                  <span className="text-xs font-semibold text-muted-foreground">
                    {t('user.apiKeys.syncMachineRemoved')}
                  </span>
                ) : (
                  <button
                    onClick={() => remove.mutate(machine.machineId)}
                    aria-label={t('user.apiKeys.syncMachineRemove', { name: machine.name })}
                    className={cn(
                      buttonVariants({ variant: 'outline', size: 'icon' }),
                      'text-muted-foreground hover:text-destructive',
                    )}
                  >
                    <Trash size={17} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {machines.hasNextPage || machines.isFetchNextPageError ? (
            <CollectionLoadMore
              loading={machines.isFetchingNextPage}
              failed={machines.isFetchNextPageError}
              labels={{
                load: t('loadMore'),
                loading: t('loadingMore'),
                retry: t('retryLoadMore'),
              }}
              onLoad={() => void machines.fetchNextPage()}
            />
          ) : null}
        </>
      )}
      <SettingsMutationStatus mutation={remove} />
    </SettingsCard>
  )
}

function PreferencesSettings() {
  const t = useTranslations('duetSettings')
  const locale = useLocale()
  const { onLocaleChange } = useSpa()
  const change = (next: 'en' | 'es-419') => {
    persistDuetLocale(next)
    if (onLocaleChange) onLocaleChange(next)
    else window.location.reload()
  }
  return (
    <SettingsPage group="user" surface="preferences">
      <div className="space-y-5">
        <SettingsCard
          title={t('user.preferences.language')}
          description={t('user.preferences.languageHelp')}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ['en', 'English'],
                ['es-419', 'Español (Latinoamérica)'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => change(value)}
                className={`flex min-h-14 items-center justify-between rounded-lg border p-4 text-left text-sm font-semibold ${locale === value ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'}`}
              >
                {label}
                {locale === value ? <Check className="text-primary" weight="bold" /> : null}
              </button>
            ))}
          </div>
        </SettingsCard>
        <SettingsCard
          title={t('user.preferences.product')}
          description={t('user.preferences.productHelp')}
        >
          <div className="flex items-start gap-3 rounded-xl bg-muted/50 p-4">
            <UserCircle className="mt-0.5 shrink-0 text-primary" size={21} />
            <p className="text-sm leading-6 text-muted-foreground">{t('user.preferences.body')}</p>
          </div>
        </SettingsCard>
        <FeedbackCard />
      </div>
    </SettingsPage>
  )
}

function FeedbackCard() {
  const t = useTranslations('duetSettings')
  const { api } = useSpa()
  const [content, setContent] = useState('')
  const mutation = useMutation({
    mutationFn: () => api.sendFeedback(content.trim()),
    onSuccess: () => setContent(''),
  })
  return (
    <SettingsCard
      title={t('user.preferences.feedback')}
      description={t('user.preferences.feedbackHelp')}
    >
      <textarea
        value={content}
        onChange={event => setContent(event.target.value)}
        placeholder={t('user.preferences.feedbackPlaceholder')}
        rows={4}
        aria-label={t('user.preferences.feedback')}
        className="w-full resize-y rounded-md border bg-background p-3 text-sm"
      />
      <div className="mt-3">
        <button
          onClick={() => mutation.mutate()}
          disabled={content.trim().length === 0 || mutation.isPending}
          className={buttonVariants()}
        >
          {t('user.preferences.feedbackSend')}
        </button>
      </div>
      <SettingsMutationStatus mutation={mutation} />
    </SettingsCard>
  )
}

function TextField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: string
  onChange?(value: string): void
  disabled?: boolean
}) {
  return (
    <label className="space-y-2">
      <span className="block text-sm font-medium">{label}</span>
      <input
        value={value}
        onChange={event => onChange?.(event.target.value)}
        disabled={disabled}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm disabled:bg-muted disabled:text-muted-foreground"
      />
    </label>
  )
}

function MoneyField({
  label,
  value,
  onChange,
  optional,
  minimum = 0,
  disabled,
}: {
  label: string
  value: string
  onChange(value: string): void
  optional?: boolean
  minimum?: number
  disabled?: boolean
}) {
  const t = useTranslations('duetSettings')
  return (
    <label className="space-y-2">
      <span className="block text-sm font-medium">
        {label}{' '}
        {optional ? (
          <span className="font-normal text-muted-foreground">({t('optional')})</span>
        ) : null}
      </span>
      <span className="flex min-h-9 items-center rounded-md border bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
        <span className="text-sm text-muted-foreground">$</span>
        <input
          type="number"
          min={minimum}
          step="1"
          value={value}
          disabled={disabled}
          onChange={event => onChange(event.target.value)}
          className="min-w-0 flex-1 bg-transparent px-2 text-sm outline-none disabled:opacity-50"
        />
      </span>
    </label>
  )
}

export function validAutoTopupThreshold(value: string): boolean {
  return atLeastMicroUsd(value, MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD)
}

function atLeastMicroUsd(value: string, minimumMicroUsd: number): boolean {
  const dollars = Number(value)
  return Number.isFinite(dollars) && dollarsToMicroUsd(dollars) >= minimumMicroUsd
}

// The automatic top-up card as the user edits it: dollar strings straight from
// the inputs, so a half-typed value round-trips untouched until Save.
interface AutoTopupForm {
  enabled: boolean
  amount: string
  threshold: string
  cap: string
}

const EMPTY_AUTO_TOPUP_FORM: AutoTopupForm = { enabled: false, amount: '', threshold: '', cap: '' }

function autoTopupFormFromOverview(overview: UserBillingOverview): AutoTopupForm {
  return {
    enabled: overview.autoTopupEnabled ?? false,
    amount: String(microUsdToDollars(overview.autoTopupAmountMicroUsd ?? 0)),
    threshold: String(microUsdToDollars(overview.autoTopupThresholdMicroUsd ?? 0)),
    cap:
      overview.maxMonthlySpendMicroUsd === undefined
        ? ''
        : String(microUsdToDollars(overview.maxMonthlySpendMicroUsd)),
  }
}

function BillingMetric({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: string
  detail?: string
  tone?: 'neutral' | 'warning'
}) {
  return (
    <div
      className={`rounded-xl border p-4 shadow-sm ${tone === 'warning' ? 'border-amber-400/50 bg-amber-400/10' : 'bg-card'}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {detail ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p> : null}
    </div>
  )
}
