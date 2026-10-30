'use client'

import { CircleNotch } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'

export function OnboardingChainTransition({
  phase,
  slug,
  current,
  total,
}: {
  phase: 'installing' | 'handoff'
  slug: string
  current: number
  total: number
}) {
  const t = useTranslations('duetOnboarding')
  const name = displayAgentSlug(slug)
  return (
    <main className="absolute inset-0 z-[100] grid place-items-center bg-background px-6 text-foreground">
      <section className="flex max-w-md flex-col items-center text-center">
        <CircleNotch className="mb-6 size-9 animate-spin text-brand" aria-hidden />
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {t('chainProgress', { current, total })}
        </p>
        <h1 className="text-balance text-3xl font-semibold tracking-tight">
          {phase === 'installing'
            ? t('chainInstallingTitle', { agent: name })
            : t('chainHandoffTitle', { agent: name })}
        </h1>
        <p className="mt-3 text-pretty text-sm leading-6 text-muted-foreground">
          {phase === 'installing' ? t('chainInstallingBody') : t('chainHandoffBody')}
        </p>
      </section>
    </main>
  )
}

function displayAgentSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}
