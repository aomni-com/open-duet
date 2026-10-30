'use client'

import { NextIntlClientProvider, useFormatter, useTranslations } from 'next-intl'

import type { BillingWorkspace, UserBillingOverview, WorkspaceSummary } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import {
  StorageMeters,
  storageFullToast,
  storageWarningToast,
} from '../../spa/entitlements/storage-surfaces'
import { SubscribeWall } from '../../spa/entitlements/subscribe-wall'
import { ToastCard } from '../../spa/shell/toast'

type StorageFixtureState =
  | 'empty-measuring'
  | 'empty-sampled-zero'
  | 'ordinary'
  | '89-percent'
  | '90-percent-starter'
  | '90-percent-pro'
  | 'near-full-max'
  | 'full-hard-stop'
  | 'downgraded-kept-58'
  | 'multi-workspace'
  | 'seven-day-wall'

const BASE_WORKSPACE = {
  id: 'workspace_studio',
  slug: 'northstar',
  name: 'Northstar Studio',
  storage: {
    usableGb: 20,
    plan: 'starter',
    nextPlan: 'pro',
    nextUsableGb: 50,
  },
} satisfies BillingWorkspace

const WALL_WORKSPACE = {
  id: BASE_WORKSPACE.id,
  slug: BASE_WORKSPACE.slug,
  name: BASE_WORKSPACE.name,
  status: 'active',
  servicingStatus: 'paused',
  role: 'owner',
  billingUserId: 'user_owner',
  funding: { plan: null, active: false },
  creditRecovery: null,
  defaultTier: { effective: 'balanced' },
} satisfies WorkspaceSummary

const MESSAGES_BY_LOCALE = { en: appEn, 'es-419': appEs } as const

export function StorageSurfacesPlayground({
  state,
  locale,
}: {
  state: StorageFixtureState
  locale: 'en' | 'es-419'
}) {
  return (
    <NextIntlClientProvider locale={locale} messages={MESSAGES_BY_LOCALE[locale]} timeZone="UTC">
      {state === 'seven-day-wall' ? <WallFixture /> : <StorageCardFixture state={state} />}
    </NextIntlClientProvider>
  )
}

function StorageCardFixture({ state }: { state: Exclude<StorageFixtureState, 'seven-day-wall'> }) {
  const t = useTranslations('duetStorage')
  const format = useFormatter()
  const formatNumber = (value: number) =>
    format.number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const workspaces = fixtureWorkspaces(state)
  const warning = state.includes('90-percent') || state === 'near-full-max'
  const full = state === 'full-hard-stop'
  const focus = workspaces[0]!
  return (
    <main className="min-h-[100dvh] bg-background px-4 py-10 text-foreground sm:px-8">
      <section className="mx-auto max-w-[560px]">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {t('fixtureEyebrow')}
        </p>
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-base font-semibold">
              {t(`fixture${planKey(focus.storage.plan)}`)}
            </h1>
            <span className="text-sm text-muted-foreground">{t('fixtureMonthlyBilling')}</span>
          </div>
          <div className="mt-4 flex items-baseline justify-between text-xs text-muted-foreground">
            <span>{t('fixtureMonthlyCredits')}</span>
            <span>{t('fixtureCreditsUsed', { percent: 41 })}</span>
          </div>
          <StorageMeters workspaces={workspaces} />
        </div>
        {warning || full ? (
          <div className="mt-7">
            <ToastCard
              toast={
                full ? storageFullToast(focus, t) : storageWarningToast(focus, t, formatNumber)
              }
              onDismiss={() => {}}
            />
          </div>
        ) : null}
      </section>
    </main>
  )
}

function WallFixture() {
  const billing = {
    autoTopupEnabled: false,
    autoTopupThresholdMicroUsd: 5_000_000,
    monthlySpendMicroUsd: 40_000_000,
    balanceMicroUsd: 8_500_000,
    paidCreditBalanceMicroUsd: 8_500_000,
    monthlyCreditBalanceMicroUsd: 0,
    consecutiveTopupFailures: 0,
    subscription: {
      plan: 'pro',
      status: 'canceled',
      isActive: false,
      currentPeriodStart: Date.UTC(2026, 5, 18),
      currentPeriodEnd: Date.UTC(2026, 6, 18),
      creditsExpireAt: Date.UTC(2026, 6, 18),
      cancelAtPeriodEnd: false,
    },
    trial: { status: 'ended' },
    hasPaymentMethod: true,
    workspaces: [
      {
        ...BASE_WORKSPACE,
        storage: {
          ...BASE_WORKSPACE.storage,
          usableGb: 50,
          plan: 'pro',
          nextPlan: 'max',
          nextUsableGb: 100,
        },
      },
    ],
  } satisfies UserBillingOverview
  return (
    <div className="relative min-h-[100dvh] bg-muted p-8">
      <div className="mx-auto grid max-w-4xl grid-cols-2 gap-4 opacity-60">
        <div className="h-32 rounded-2xl bg-card" />
        <div className="h-32 rounded-2xl bg-card" />
      </div>
      <SubscribeWall
        onLogout={() => {}}
        billingPortal={{ onOpen: () => {}, pending: false, failed: false }}
        state={{ kind: 'lapsed', workspace: WALL_WORKSPACE, billing }}
        momentum={{ generations: 212, publishedApps: 3, organizedFiles: 1847 }}
      />
    </div>
  )
}

function fixtureWorkspaces(
  state: Exclude<StorageFixtureState, 'seven-day-wall'>,
): BillingWorkspace[] {
  if (state === 'multi-workspace') {
    return [
      { ...BASE_WORKSPACE, storage: { ...BASE_WORKSPACE.storage, usedBytes: 12_400_000_000 } },
      {
        ...BASE_WORKSPACE,
        id: 'workspace_archive',
        slug: 'archive',
        name: 'Archive Room',
        storage: {
          usableGb: 50,
          usedBytes: 29_000_000_000,
          sampledAt: 1,
          plan: 'pro',
          nextPlan: 'max',
          nextUsableGb: 100,
        },
      },
    ]
  }
  const storage: BillingWorkspace['storage'] =
    state === 'empty-measuring'
      ? BASE_WORKSPACE.storage
      : state === 'empty-sampled-zero'
        ? { ...BASE_WORKSPACE.storage, usedBytes: 0, sampledAt: 1 }
        : state === 'ordinary'
          ? { ...BASE_WORKSPACE.storage, usedBytes: 12_400_000_000, sampledAt: 1 }
          : state === '89-percent'
            ? { ...BASE_WORKSPACE.storage, usedBytes: 17_800_000_000, sampledAt: 1 }
            : state === '90-percent-starter'
              ? { ...BASE_WORKSPACE.storage, usedBytes: 18_000_000_000, sampledAt: 1 }
              : state === '90-percent-pro'
                ? {
                    usableGb: 50,
                    usedBytes: 45_000_000_000,
                    sampledAt: 1,
                    plan: 'pro',
                    nextPlan: 'max',
                    nextUsableGb: 100,
                  }
                : state === 'near-full-max'
                  ? { usableGb: 100, usedBytes: 98_600_000_000, sampledAt: 1, plan: 'max' }
                  : state === 'full-hard-stop'
                    ? { ...BASE_WORKSPACE.storage, usedBytes: 20_000_000_000, sampledAt: 1 }
                    : // A Starter payer retaining a 58GB disk: the server
                      // suppresses the upgrade step because pro's 50GB would
                      // grow nothing (whole-spec review fix).
                      {
                        usableGb: 50,
                        usedBytes: 44_200_000_000,
                        sampledAt: 1,
                        plan: 'starter',
                      }
  return [{ ...BASE_WORKSPACE, storage }]
}

function planKey(plan: BillingWorkspace['storage']['plan']): 'Starter' | 'Pro' | 'Max' {
  if (plan === 'starter') return 'Starter'
  if (plan === 'pro') return 'Pro'
  return 'Max'
}
