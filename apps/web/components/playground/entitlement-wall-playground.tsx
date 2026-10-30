'use client'

import { NextIntlClientProvider } from 'next-intl'

import {
  SERVICING_ARCHIVE_AFTER_MS,
  TRIAL_WINDOW_MS,
  type UserBillingOverview,
  type WorkspaceSummary,
} from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { SubscribeWall, type WorkspaceWallState } from '../../spa/entitlements/subscribe-wall'

const SIGNUP = Date.UTC(2026, 6, 11, 9)
/* Signup + the trial: the trial ends, the workspace stops serving. This is the
   instant the wall first appears, and the instant the delete clock starts. */
const TRIAL_ENDED = SIGNUP + TRIAL_WINDOW_MS

const WORKSPACE = {
  id: 'workspace_studio',
  slug: 'northstar',
  name: 'Northstar Studio',
  status: 'active',
  servicingStatus: 'paused',
  servicingStatusChangedAt: TRIAL_ENDED,
  role: 'owner',
  billingUserId: 'user_owner',
  funding: { plan: null, active: false },
  creditRecovery: null,
  defaultTier: { effective: 'balanced' },
} satisfies WorkspaceSummary

const BILLING = {
  autoTopupEnabled: false,
  autoTopupThresholdMicroUsd: 5_000_000,
  monthlySpendMicroUsd: 59_000_000,
  monthlySpendPeriodKey: '2026-07',
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
      id: WORKSPACE.id,
      slug: WORKSPACE.slug,
      name: WORKSPACE.name,
      storage: {
        usableGb: 50,
        plan: 'pro',
        nextPlan: 'max',
        nextUsableGb: 100,
      },
    },
  ],
} satisfies UserBillingOverview

export function EntitlementWallPlayground({
  variant,
  stage = 'warned',
}: {
  variant: 'trial-exhausted' | 'trial-timed-out' | 'lapsed' | 'billing-issue' | 'member'
  /**
   * Where in the warning window this shot stands, and what the workspace's own
   * status is by then. `warned` is minutes after the trial ended: the wall
   * appears with the whole window ahead of it. `decommissioned` is minutes past
   * the window's end, after the sweep — the workspace is gone, and the wall has
   * to say that instead of counting down to it. Both are derived from
   * `SERVICING_ARCHIVE_AFTER_MS` so a policy change moves the shots with it.
   */
  stage?: 'warned' | 'decommissioned'
}) {
  const state: WorkspaceWallState =
    variant === 'member'
      ? { kind: 'member', workspace: { ...WORKSPACE, role: 'editor' } }
      : variant === 'lapsed'
        ? { kind: 'lapsed', workspace: WORKSPACE, billing: BILLING }
        : variant === 'billing-issue'
          ? {
              kind: 'billing-issue',
              workspace: WORKSPACE,
              billing: {
                ...BILLING,
                subscription: { ...BILLING.subscription, status: 'active', isActive: true },
              },
            }
          : {
              kind: variant,
              workspace: WORKSPACE,
              billing: {
                ...BILLING,
                paidCreditBalanceMicroUsd: 0,
                balanceMicroUsd: 0,
                subscription: null,
                trial: { status: variant === 'trial-exhausted' ? 'exhausted' : 'ended' },
              },
            }
  const staged: WorkspaceWallState =
    stage === 'decommissioned' && 'billing' in state
      ? { ...state, workspace: { ...state.workspace, status: 'archived' } }
      : state
  // Ten minutes into the window, and ten minutes past its end.
  const now =
    stage === 'decommissioned'
      ? TRIAL_ENDED + SERVICING_ARCHIVE_AFTER_MS + 600_000
      : TRIAL_ENDED + 600_000

  return (
    <NextIntlClientProvider
      locale="en"
      messages={appEn}
      timeZone="UTC"
      now={new Date(Date.UTC(2026, 6, 18, 12))}
    >
      <div className="relative h-[100dvh] overflow-hidden bg-[#eef0f4] text-slate-900">
        <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-slate-950 px-5 text-white">
          <span className="font-semibold">Northstar Studio</span>
          <span className="text-xs text-slate-400">Duet’s Computer</span>
        </header>
        <div className="grid h-[calc(100dvh-3.5rem)] grid-cols-[220px_1fr]">
          <aside className="border-r border-slate-200 bg-white p-5 text-sm leading-10 text-slate-500">
            Sessions
            <br />
            Apps
            <br />
            Drive
            <br />
            Jobs
            <br />
            Integrations
          </aside>
          <main className="p-8">
            <div className="mb-6 h-8 w-64 rounded-lg bg-white shadow-sm" />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {['q3-outreach', 'lead-triage', 'call-transcripts', 'summer-campaign'].map(item => (
                <div
                  key={item}
                  className="h-28 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="font-medium">{item}</div>
                  <div className="mt-3 h-2 w-2/3 rounded bg-slate-100" />
                </div>
              ))}
            </div>
          </main>
        </div>
        <SubscribeWall
          onLogout={() => {}}
          billingPortal={{ onOpen: () => {}, pending: false, failed: false }}
          state={staged}
          now={now}
          momentum={{
            generations: 212,
            publishedApps: 3,
            publishedAppsAtLeast: true,
            organizedFiles: 1847,
          }}
        />
      </div>
    </NextIntlClientProvider>
  )
}
