'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useState } from 'react'

import appEn from '../../messages/en/app.json'
import { OnboardingChainTransition } from '../../spa/onboarding/onboarding-chain-transition'

export function OnboardingChainPlayground() {
  const [phase, setPhase] = useState<'installing' | 'handoff'>('installing')
  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <OnboardingChainTransition
        phase={phase}
        slug={phase === 'installing' ? 'research-assistant' : 'writing-editor'}
        current={phase === 'installing' ? 1 : 2}
        total={2}
      />
      <div className="fixed bottom-4 left-1/2 z-[110] flex -translate-x-1/2 gap-2 rounded-xl border bg-background/95 p-1 shadow-lg">
        <button
          type="button"
          onClick={() => setPhase('installing')}
          className="rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          State: setting up
        </button>
        <button
          type="button"
          onClick={() => setPhase('handoff')}
          className="rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          State: mid-chain hand-off
        </button>
      </div>
    </NextIntlClientProvider>
  )
}
