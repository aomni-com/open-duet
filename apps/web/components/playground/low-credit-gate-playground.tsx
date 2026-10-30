'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useState } from 'react'

import type { WorkspaceSummary } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { LowCreditGate } from '../../spa/entitlements/low-credit-gate'

const WORKSPACE = {
  id: 'workspace_studio',
  slug: 'northstar',
  name: 'Northstar Studio',
  status: 'active',
  servicingStatus: 'active',
  role: 'owner',
  billingUserId: 'user_owner',
  funding: { plan: null, active: true },
  creditRecovery: 'subscribe',
  defaultTier: { effective: 'balanced' },
} satisfies WorkspaceSummary

const SCENARIOS = [
  'subscribe',
  'topup',
  'member',
  'subscribe-pending',
  'topup-pending',
  'error',
] as const
type Scenario = (typeof SCENARIOS)[number]

export function LowCreditGatePlayground() {
  const [scenario, setScenario] = useState<Scenario>('subscribe')
  const [lastAction, setLastAction] = useState('none')
  const kind =
    scenario.startsWith('subscribe') || scenario === 'error'
      ? 'subscribe'
      : scenario.startsWith('topup')
        ? 'topup'
        : 'member'
  const pending = scenario.endsWith('pending')
  const error = scenario === 'error' ? 'Checkout could not open. Try again.' : undefined

  const gate =
    kind === 'subscribe' ? (
      <LowCreditGate
        key={scenario}
        state={{ kind, workspace: { ...WORKSPACE, creditRecovery: 'topup' } }}
        pending={pending}
        error={error}
        onSubscribe={plan => setLastAction(`subscribe:${plan}`)}
      />
    ) : kind === 'topup' ? (
      <LowCreditGate
        key={scenario}
        state={{ kind, workspace: WORKSPACE }}
        pending={pending}
        onTopup={amount => setLastAction(`topup:${amount}`)}
      />
    ) : (
      <LowCreditGate key={scenario} state={{ kind, workspace: { ...WORKSPACE, role: 'editor' } }} />
    )

  return (
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <div className="relative h-[100dvh] overflow-hidden bg-slate-100 text-slate-900">
        <header className="flex h-14 items-center justify-between border-b border-slate-800 bg-slate-950 px-4 text-white sm:px-6">
          <span className="font-semibold">Northstar Studio</span>
          <span className="text-xs text-slate-400">Duet’s Computer</span>
        </header>
        <div className="grid h-[calc(100dvh-3.5rem)] grid-cols-1 sm:grid-cols-[220px_1fr]">
          <aside className="hidden border-r border-slate-200 bg-white p-5 text-sm leading-10 text-slate-500 sm:block">
            Home
            <br />
            Agents
            <br />
            Drive
            <br />
            Train
          </aside>
          <main className="flex min-h-0 flex-col p-4 sm:p-8">
            <div className="mb-4 flex items-center gap-3">
              <div className="size-9 rounded-xl bg-violet-200" />
              <div>
                <div className="h-3 w-32 rounded bg-slate-300" />
                <div className="mt-2 h-2 w-20 rounded bg-slate-200" />
              </div>
            </div>
            <div className="min-h-0 flex-1 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="space-y-4">
                <div className="h-16 w-4/5 rounded-2xl bg-slate-100" />
                <div className="ml-auto h-12 w-2/3 rounded-2xl bg-violet-100" />
                <div className="h-20 w-3/4 rounded-2xl bg-slate-100" />
              </div>
              <div className="absolute bottom-8 left-4 right-4 h-20 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 shadow-md sm:left-[252px] sm:right-8">
                Draft: prepare the launch handoff and keep this session open…
              </div>
            </div>
          </main>
        </div>

        <div className="sr-only" aria-hidden="true" inert>
          {SCENARIOS.map(value => (
            <button key={value} data-low-credit-scenario={value} onClick={() => setScenario(value)}>
              Scenario: {value}
            </button>
          ))}
          <output data-low-credit-action>{lastAction}</output>
        </div>
        {gate}
      </div>
    </NextIntlClientProvider>
  )
}
